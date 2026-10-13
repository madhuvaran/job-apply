/**
 * Tests for the backend-proxy provider (src/lib/ai/proxy.ts) — Prompt 06:
 * the ONLY production transport. Covers: strict options (no credential field
 * exists), the JSON POST body being exactly the validated request, HTTP →
 * typed-failure mapping (429/Retry-After, 5xx retryable, 4xx not), network/
 * abort/malformed-body handling, and an end-to-end rate-limit retry through
 * runAiRequest. Offline: fetch is always a fake.
 */
import { describe, expect, it } from 'vitest';
import { createProxyProvider, parseRetryAfterMs, proxyProviderOptionsSchema } from './proxy';
import { runAiRequest, buildAiRequest, type AiRequestInput } from './run';
import { defaultSettings, settingsSchema } from '../settings';
import { sampleProfile } from '../sample-profile';
import type { AiRequest, AiResponse } from './schemas';
import type { AiProviderCallContext, AiProviderFailure } from './provider';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ENDPOINT = 'https://backend.example.test/api/ai';

const job = {
  title: 'Fake Staff Engineer',
  company: 'Fake Co',
  description: 'Build fake things.',
};

const enabledInput = (): AiRequestInput => ({
  task: 'tailor-resume',
  job,
  profile: sampleProfile,
  settings: settingsSchema.parse({ ...defaultSettings(), aiEnabled: true }),
});

const validRequest = (): AiRequest => {
  const built = buildAiRequest(enabledInput());
  if (built.kind !== 'ok') throw new Error('fixture request invalid');
  return built.request;
};

const ctx = (): AiProviderCallContext => ({
  signal: new AbortController().signal,
  attempt: 1,
  timeoutMs: 1000,
});

const okBody = (patch: Partial<AiResponse> = {}): Record<string, unknown> => ({
  schemaVersion: '1',
  task: 'tailor-resume',
  content: 'backend draft',
  provider: 'backend',
  model: 'backend-model',
  ...patch,
});

type FetchCall = { url: string; init: RequestInit };

const fakeFetch = (
  responder: (call: FetchCall, index: number) => Response | Promise<Response>,
): { impl: (url: string, init: RequestInit) => Promise<Response>; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const call = { url, init };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { impl, calls };
};

const json = (body: unknown, init: ResponseInit = { status: 200 }): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

const failureOf = async (
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<AiProviderFailure> => {
  const provider = createProxyProvider({ endpoint: ENDPOINT, fetchImpl });
  const outcome = await provider.send(validRequest(), ctx());
  if (outcome.kind !== 'failure') throw new Error('expected a failure outcome');
  return outcome.failure;
};

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

describe('proxy provider options (no API keys, ever)', () => {
  it('has no credential field — passing an apiKey fails at construction', () => {
    expect(() =>
      createProxyProvider({ endpoint: ENDPOINT, apiKey: 'sk-secret' } as never),
    ).toThrow(/apiKey/);
    expect(Object.keys(proxyProviderOptionsSchema.shape)).toEqual(['endpoint', 'fetchImpl']);
  });

  it('rejects non-http(s) and malformed endpoints', () => {
    expect(() => createProxyProvider({ endpoint: 'ftp://x.example/ai' } as never)).toThrow();
    expect(() => createProxyProvider({ endpoint: 'not a url' } as never)).toThrow();
    expect(() => createProxyProvider({} as never)).toThrow();
  });

  it('accepts a plain endpoint with no other wiring', () => {
    expect(() => createProxyProvider({ endpoint: ENDPOINT })).not.toThrow();
  });

  it('sends NO auth headers — the request init carries only content negotiation', async () => {
    const { impl, calls } = fakeFetch(() => json(okBody()));
    const provider = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    await provider.send(validRequest(), ctx());
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual([
      'content-type',
      'accept',
    ]);
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('authorization');
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('key');
  });
});

/* ------------------------------------------------------------------ */
/* Wire behavior                                                       */
/* ------------------------------------------------------------------ */

describe('proxy provider wire behavior', () => {
  it('POSTs the validated request as JSON to the configured endpoint', async () => {
    const { impl, calls } = fakeFetch(() => json(okBody()));
    const provider = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    const request = validRequest();
    const outcome = await provider.send(request, ctx());
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(request);
    expect(outcome).toEqual({ kind: 'response', raw: okBody() });
  });

  it('passes the orchestrator signal through so timeouts abort the fetch', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { impl } = fakeFetch(async (_call) => {
      seen = (_call.init.signal as AbortSignal) ?? undefined;
      return json(okBody());
    });
    const provider = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    await provider.send(validRequest(), { signal: controller.signal, attempt: 1, timeoutMs: 5 });
    expect(seen).toBe(controller.signal);
  });

  it('429 → rate-limited with Retry-After (delta-seconds)', async () => {
    const { impl } = fakeFetch(() =>
      json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } }),
    );
    const failure = await failureOf(impl);
    expect(failure).toEqual({ kind: 'rate-limited', retryAfterMs: 2000 });
  });

  it('429 with an HTTP-date Retry-After is converted to milliseconds', async () => {
    const target = Date.now() + 30_000;
    const { impl } = fakeFetch(() =>
      json({}, { status: 429, headers: { 'retry-after': new Date(target).toUTCString() } }),
    );
    const failure = await failureOf(impl);
    expect(failure.kind).toBe('rate-limited');
    if (failure.kind !== 'rate-limited') return;
    expect(failure.retryAfterMs).toBeGreaterThanOrEqual(25_000);
    expect(failure.retryAfterMs).toBeLessThanOrEqual(31_000);
  });

  it('429 without Retry-After has no retryAfterMs (backoff applies upstream)', async () => {
    const { impl } = fakeFetch(() => json({}, { status: 429 }));
    const failure = await failureOf(impl);
    expect(failure).toEqual({ kind: 'rate-limited' });
    expect('retryAfterMs' in failure).toBe(false);
  });

  it('5xx is retryable, other 4xx is not', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { impl } = fakeFetch(() => json({}, { status }));
      expect(await failureOf(impl)).toEqual({ kind: 'http', status, retryable: true });
    }
    for (const status of [400, 401, 403, 404, 422]) {
      const { impl } = fakeFetch(() => json({}, { status }));
      expect(await failureOf(impl)).toEqual({ kind: 'http', status, retryable: false });
    }
  });

  it('a connection failure (TypeError) maps to network', async () => {
    const impl = () => Promise.reject(new TypeError('fetch failed'));
    const failure = await failureOf(impl);
    expect(failure).toEqual({ kind: 'network' });
  });

  it('an abort maps to timeout', async () => {
    const impl = () => Promise.reject(new DOMException('aborted', 'AbortError'));
    const failure = await failureOf(impl);
    expect(failure).toEqual({ kind: 'timeout' });
  });

  it('a 200 with a non-JSON body maps to malformed (→ invalid-response upstream)', async () => {
    const { impl } = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    expect(await failureOf(impl)).toEqual({ kind: 'malformed' });
  });

  it('a 200 with a JSON body that fails response validation is surfaced raw for the orchestrator', async () => {
    const { impl } = fakeFetch(() => json({ unexpected: 'shape' }));
    const provider = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    const outcome = await provider.send(validRequest(), ctx());
    expect(outcome).toEqual({ kind: 'response', raw: { unexpected: 'shape' } });
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end through runAiRequest                                     */
/* ------------------------------------------------------------------ */

describe('proxy provider through runAiRequest', () => {
  it('completes a request end-to-end (fetch → validated response)', async () => {
    const { impl } = fakeFetch(() => json(okBody({ content: 'tailored by backend' })));
    const proxy = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    const result = await runAiRequest(proxy, enabledInput(), { maxAttempts: 1 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.response.content).toBe('tailored by backend');
    expect(result.response.provider).toBe('backend');
    expect(result.attempts).toBe(1);
  });

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    const { impl, calls } = fakeFetch((_call, index) =>
      index === 0
        ? json({}, { status: 429, headers: { 'retry-after': '1' } })
        : json(okBody()),
    );
    const proxy = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    const delays: number[] = [];
    const result = await runAiRequest(proxy, enabledInput(), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(2);
    expect(calls.length).toBe(2);
    expect(delays).toEqual([1000]);
  });

  it('a backend response with extra keys is rejected as invalid-response', async () => {
    const { impl } = fakeFetch(() => json({ ...okBody(), apiKey: 'leaked' }));
    const proxy = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    const result = await runAiRequest(proxy, enabledInput(), { maxAttempts: 3, sleep: async () => {} });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('invalid-response');
    expect(result.attempts).toBe(1);
  });

  it('ZERO requests when aiEnabled is false, even with a working endpoint wired', async () => {
    const { impl, calls } = fakeFetch(() => json(okBody()));
    const proxy = createProxyProvider({ endpoint: ENDPOINT, fetchImpl: impl });
    const result = await runAiRequest(proxy, {
      task: 'tailor-resume',
      job,
      profile: sampleProfile,
      settings: defaultSettings(), // aiEnabled: false by default
    });
    expect(result.kind).toBe('fallback');
    expect(calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Retry-After parser (pure)                                           */
/* ------------------------------------------------------------------ */

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs(' 120 ', now)).toBe(120_000);
  });

  it('parses an HTTP-date relative to now (never negative)', () => {
    expect(parseRetryAfterMs(new Date(now + 10_000).toUTCString(), now)).toBe(
      Math.max(0, Date.parse(new Date(now + 10_000).toUTCString()) - now),
    );
    expect(parseRetryAfterMs(new Date(now - 10_000).toUTCString(), now)).toBe(0);
  });

  it('returns undefined for missing/garbage values', () => {
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs('', now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
  });
});
