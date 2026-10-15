/**
 * Adzuna provider transport tests (Prompt 27).
 *
 * The transport is exercised with an INJECTED `fetchImpl` — no live request, no
 * credential and no quota is ever touched. The status codes asserted here are
 * Adzuna's documented ones (400 incorrect parameters, 404 resource not found,
 * 410 authorisation failed, 500 internal server error) plus the conventional
 * 401/403/429 codes; see docs/adzuna-integration.md for what is verified and
 * what is not.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildAdzunaProxyUrl,
  createAdzunaProvider,
  parseRetryAfterMs,
  validateAdzunaProviderOptions,
} from './provider';
import { adzunaSearchRequestSchema, buildAdzunaSearchQuery } from './schemas';

const ENDPOINT = 'https://search.example.com/api';

const sampleRequest = adzunaSearchRequestSchema.parse({
  country: 'in',
  keywords: 'data engineer',
  where: 'Bengaluru',
  distanceKm: 25,
  page: 2,
  resultsPerPage: 25,
  maxDaysOld: 7,
  sortBy: 'date',
});

interface Call {
  url: string;
  init: RequestInit;
}

/** Build a provider whose transport is a scripted fake. */
function makeProvider(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const provider = createAdzunaProvider({
    endpoint: ENDPOINT,
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(handler({ url, init }));
    },
  });
  return { provider, calls };
}

const signal = () => new AbortController().signal;

/* ------------------------------------------------------------------ */
/* Options validation — credentials are structurally impossible        */
/* ------------------------------------------------------------------ */

describe('provider options reject credentials and insecure endpoints', () => {
  it('accepts an https endpoint', () => {
    const result = validateAdzunaProviderOptions({ endpoint: ENDPOINT });
    expect(result.ok).toBe(true);
  });

  it('rejects every credential-shaped extra key (strict object)', () => {
    for (const payload of [
      { endpoint: ENDPOINT, appId: '12345678' },
      { endpoint: ENDPOINT, appKey: 'deadbeefdeadbeef' },
      { endpoint: ENDPOINT, app_id: '12345678', app_key: 'deadbeef' },
      { endpoint: ENDPOINT, apiKey: 'sk-live-whatever' },
      { endpoint: ENDPOINT, token: 'whatever' },
      { endpoint: ENDPOINT, authorization: 'Bearer whatever' },
    ]) {
      expect(validateAdzunaProviderOptions(payload).ok).toBe(false);
    }
  });

  it('rejects a non-https endpoint and a non-URL', () => {
    expect(validateAdzunaProviderOptions({ endpoint: 'http://search.example.com' }).ok).toBe(false);
    expect(validateAdzunaProviderOptions({ endpoint: 'not-a-url' }).ok).toBe(false);
    expect(validateAdzunaProviderOptions({}).ok).toBe(false);
  });

  it('does not echo a rejected value back in the issue list', () => {
    const secretLooking = 'sk-live-abcdefghijklmnop';
    const result = validateAdzunaProviderOptions({ endpoint: ENDPOINT, apiKey: secretLooking });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' | ')).not.toContain(secretLooking);
  });

  it('throws on invalid options without quoting the value', () => {
    const secretLooking = 'sk-live-abcdefghijklmnop';
    expect(() =>
      createAdzunaProvider({ endpoint: ENDPOINT, apiKey: secretLooking } as never),
    ).toThrowError(/invalid adzuna provider options/);
    try {
      createAdzunaProvider({ endpoint: ENDPOINT, apiKey: secretLooking } as never);
    } catch (err) {
      expect((err as Error).message).not.toContain(secretLooking);
    }
  });
});

/* ------------------------------------------------------------------ */
/* URL building — never a credential                                   */
/* ------------------------------------------------------------------ */

describe('the proxy URL carries the documented request and NO credential', () => {
  it('builds path and query from the validated request', () => {
    const url = new URL(buildAdzunaProxyUrl(ENDPOINT, sampleRequest));
    expect(url.origin).toBe('https://search.example.com');
    expect(url.pathname).toBe('/api/jobs/in/search/2');
    expect(Object.fromEntries(url.searchParams)).toEqual(buildAdzunaSearchQuery(sampleRequest));
    expect(url.searchParams.get('what')).toBe('data engineer');
    expect(url.searchParams.get('where')).toBe('Bengaluru');
    expect(url.searchParams.get('results_per_page')).toBe('25');
  });

  it('never includes app_id or app_key', () => {
    const url = buildAdzunaProxyUrl(ENDPOINT, sampleRequest);
    expect(url).not.toContain('app_id');
    expect(url).not.toContain('app_key');
  });

  it('tolerates a trailing slash on the endpoint', () => {
    expect(buildAdzunaProxyUrl(`${ENDPOINT}/`, sampleRequest)).toContain('/api/jobs/in/search/2');
  });
});

/* ------------------------------------------------------------------ */
/* Sending — method, headers and credential-free request               */
/* ------------------------------------------------------------------ */

describe('the outgoing request is clean', () => {
  it('uses GET, an accept header and no credential header', async () => {
    const { provider, calls } = makeProvider(
      () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(init.method).toBe('GET');
    expect(url).not.toContain('app_id');
    expect(url).not.toContain('app_key');
    expect(url).not.toContain('api.adzuna.com');
    const headers = JSON.stringify(init.headers ?? {});
    expect(headers.toLowerCase()).not.toContain('authorization');
    expect(headers.toLowerCase()).not.toContain('app_key');
    // The caller's abort signal is forwarded so a timeout can cancel in flight.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the parsed JSON body as a response outcome', async () => {
    const payload = { results: [{ id: 'a', title: 'b', description: 'c', created: '2026-10-01T00:00:00Z', redirect_url: 'https://example.invalid/x' }] };
    const { provider } = makeProvider(
      () => new Response(JSON.stringify(payload), { status: 200 }),
    );
    const outcome = await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 });
    expect(outcome).toEqual({ kind: 'response', raw: payload });
  });

  it('identifies itself as the adzuna provider', () => {
    const { provider } = makeProvider(() => new Response('{}', { status: 200 }));
    expect(provider.id).toBe('adzuna');
  });
});

/* ------------------------------------------------------------------ */
/* HTTP status mapping                                                 */
/* ------------------------------------------------------------------ */

describe('documented HTTP statuses map to typed failures', () => {
  const failureFor = async (status: number, headers: Record<string, string> = {}) => {
    const { provider } = makeProvider(
      () => new Response('provider error body that must never surface', { status, headers }),
    );
    const outcome = await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 });
    expect(outcome.kind).toBe('failure');
    return outcome.kind === 'failure' ? outcome.failure : undefined;
  };

  it('maps 410 (documented "authorisation failed") to unauthenticated', async () => {
    expect(await failureFor(410)).toEqual({ kind: 'unauthenticated', status: 410 });
  });

  it('maps 401 and 403 to unauthenticated', async () => {
    expect(await failureFor(401)).toEqual({ kind: 'unauthenticated', status: 401 });
    expect(await failureFor(403)).toEqual({ kind: 'unauthenticated', status: 403 });
  });

  it('maps 400/404 (documented request errors) to provider-rejected', async () => {
    expect(await failureFor(400)).toEqual({ kind: 'provider-rejected', status: 400 });
    expect(await failureFor(404)).toEqual({ kind: 'provider-rejected', status: 404 });
  });

  it('maps 500+ to server, preserving the status', async () => {
    expect(await failureFor(500)).toEqual({ kind: 'server', status: 500 });
    expect(await failureFor(503)).toEqual({ kind: 'server', status: 503 });
  });

  it('preserves any other non-2xx status as http', async () => {
    expect(await failureFor(418)).toEqual({ kind: 'http', status: 418 });
    expect(await failureFor(302)).toEqual({ kind: 'http', status: 302 });
  });

  it('maps 429 to rate-limited and parses a delta-seconds Retry-After', async () => {
    expect(await failureFor(429, { 'retry-after': '120' })).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 120000,
    });
  });

  it('maps 429 without a usable Retry-After to a bare rate-limited', async () => {
    expect(await failureFor(429)).toEqual({ kind: 'rate-limited' });
    expect(await failureFor(429, { 'retry-after': 'not-a-date' })).toEqual({
      kind: 'rate-limited',
    });
  });

  it('never leaks the response body into a failure', async () => {
    const failure = await failureFor(500);
    expect(JSON.stringify(failure)).not.toContain('provider error body');
  });
});

/* ------------------------------------------------------------------ */
/* Network, timeout and unreadable bodies                              */
/* ------------------------------------------------------------------ */

describe('transport-level failures', () => {
  it('maps a thrown fetch error to network (no message carried)', async () => {
    const { provider } = makeProvider(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    });
    expect(await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 })).toEqual({
      kind: 'failure',
      failure: { kind: 'network' },
    });
  });

  it('maps an abort-shaped throw to timeout', async () => {
    const { provider } = makeProvider(() => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    expect(await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 })).toEqual({
      kind: 'failure',
      failure: { kind: 'timeout' },
    });
  });

  it('treats an already-aborted signal as timeout, not network', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider } = makeProvider(() => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    expect(
      await provider.send(sampleRequest, { signal: controller.signal, timeoutMs: 1000 }),
    ).toEqual({ kind: 'failure', failure: { kind: 'timeout' } });
  });

  it('maps a non-JSON 200 body to malformed (never an empty response)', async () => {
    const { provider } = makeProvider(() => new Response('<html>not json</html>', { status: 200 }));
    expect(await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 })).toEqual({
      kind: 'failure',
      failure: { kind: 'malformed' },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Retry-After parsing                                                 */
/* ------------------------------------------------------------------ */

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120000);
    expect(parseRetryAfterMs(' 5 ')).toBe(5000);
  });

  it('parses an HTTP-date against an injected clock', () => {
    const now = Date.parse('2026-10-15T09:00:00Z');
    expect(parseRetryAfterMs('Thu, 15 Oct 2026 09:00:30 GMT', now)).toBe(30000);
    // A date already in the past never yields a negative delay.
    expect(parseRetryAfterMs('Thu, 15 Oct 2026 08:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for absent or unusable values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* The transport is only ever our own proxy                            */
/* ------------------------------------------------------------------ */

describe('no direct Adzuna call is possible from the provider', () => {
  it('sends only to the configured proxy origin', async () => {
    const spy = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const provider = createAdzunaProvider({ endpoint: ENDPOINT, fetchImpl: spy });
    await provider.send(sampleRequest, { signal: signal(), timeoutMs: 1000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0]).startsWith('https://search.example.com/')).toBe(true);
  });
});
