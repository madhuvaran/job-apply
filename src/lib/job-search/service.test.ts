/**
 * Job-search orchestration tests (Prompt 27).
 *
 * These cover the HONESTY GATE and the failure mapping: with no secure,
 * configured endpoint the orchestrator must never touch the transport (zero
 * network requests), must report an explicit `not-configured` state, and must
 * never turn a failed request into a successful empty result page.
 *
 * The transport and the adapter are injected fakes — no live request happens.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdzunaAdapter } from './adzuna/adapter';
import type { JobSearchProvider, JobSearchProviderFailure } from './provider';
import type { JobSearchError } from './errors';
import { normalizedSearchResultsSchema, type NormalizedSearchResults } from './schemas';
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  describeJobSearchAvailability,
  JOB_SEARCH_UNAVAILABLE_MESSAGES,
  parseJobSearchConfig,
  runJobSearch,
  type JobSearchAdapter,
} from './service';
import type { AdzunaSearchRequest } from './adzuna/schemas';

const ENDPOINT = 'https://search.example.com/api';
const FIXED_NOW = '2026-10-15T09:00:00.000Z';

const rawPayload = {
  results: [
    {
      id: '1',
      title: 'Data Engineer',
      description: 'Pipelines.',
      created: '2026-10-02T08:00:00Z',
      redirect_url: 'https://www.adzuna.in/details/1',
    },
  ],
  count: 7,
};

/** A provider that records whether it was called. */
function spyProvider(outcome: () => Promise<unknown> | unknown) {
  const send = vi.fn(async (_req: AdzunaSearchRequest) => {
    const value = await outcome();
    return { kind: 'response' as const, raw: value };
  });
  const provider: JobSearchProvider<AdzunaSearchRequest> = { id: 'adzuna', send };
  return { provider, send };
}

const validRequest = { country: 'in', keywords: 'data engineer' } as const;

/* ------------------------------------------------------------------ */
/* Configuration: no credential field exists                           */
/* ------------------------------------------------------------------ */

describe('the search configuration has no credential field', () => {
  it('rejects every credential-shaped key (strict object)', () => {
    for (const payload of [
      { enabled: true, endpoint: ENDPOINT, appId: '12345678' },
      { enabled: true, endpoint: ENDPOINT, appKey: 'deadbeef' },
      { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-live' },
      { enabled: true, endpoint: ENDPOINT, token: 'x' },
    ]) {
      expect(parseJobSearchConfig(payload).ok).toBe(false);
    }
  });

  it('requires https for the search endpoint', () => {
    expect(parseJobSearchConfig({ enabled: true, endpoint: 'http://search.example.com' }).ok).toBe(
      false,
    );
  });

  it('defaults to disabled', () => {
    const parsed = parseJobSearchConfig({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.enabled).toBe(false);
    expect(parsed.value.endpoint).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Availability — the honesty gate                                     */
/* ------------------------------------------------------------------ */

describe('describeJobSearchAvailability reports the true state', () => {
  it('is disabled by default and says so', () => {
    const availability = describeJobSearchAvailability({});
    expect(availability.available).toBe(false);
    if (availability.available) return;
    expect(availability.reason).toBe('disabled');
    expect(availability.message).toBe(JOB_SEARCH_UNAVAILABLE_MESSAGES.disabled);
  });

  it('reports not-configured when enabled without an endpoint', () => {
    const availability = describeJobSearchAvailability({ enabled: true });
    expect(availability.available).toBe(false);
    if (availability.available) return;
    expect(availability.reason).toBe('not-configured');
    expect(availability.message).toContain('Live job search is not available in this build');
  });

  it('reports invalid for a malformed configuration', () => {
    const availability = describeJobSearchAvailability({ enabled: 'yes' });
    expect(availability.available).toBe(false);
    if (availability.available) return;
    expect(availability.reason).toBe('invalid');
  });

  it('is available only with an enabled https endpoint', () => {
    expect(describeJobSearchAvailability({ enabled: true, endpoint: ENDPOINT })).toEqual({
      available: true,
      endpoint: ENDPOINT,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Unavailable / unconfigured = NO network call, NO fake results       */
/* ------------------------------------------------------------------ */

describe('when search is unavailable the transport is never touched', () => {
  const adapter = createAdzunaAdapter({ now: () => FIXED_NOW });

  it('returns not-configured (disabled) and makes zero provider calls', async () => {
    const { provider, send } = spyProvider(() => rawPayload);
    const result = await runJobSearch({
      config: { enabled: false },
      request: validRequest,
      provider,
      adapter,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('not-configured');
    if (result.error.kind !== 'not-configured') return;
    expect(result.error.reason).toBe('disabled');
    expect(result.attempts).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns not-configured (no endpoint) and makes zero provider calls', async () => {
    const { provider, send } = spyProvider(() => rawPayload);
    const result = await runJobSearch({
      config: { enabled: true },
      request: validRequest,
      provider,
      adapter,
    });
    expect(result.kind === 'error' && result.error.kind).toBe('not-configured');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports invalid settings without calling the provider', async () => {
    const { provider, send } = spyProvider(() => rawPayload);
    const result = await runJobSearch({
      config: { enabled: true, endpoint: ENDPOINT, appKey: 'deadbeef' },
      request: validRequest,
      provider,
      adapter,
    });
    expect(result.kind === 'error' && result.error.kind).toBe('invalid-request');
    expect(send).not.toHaveBeenCalled();
  });

  it('never returns a successful empty page in place of a failure', async () => {
    const { provider } = spyProvider(() => rawPayload);
    const result = await runJobSearch({
      config: { enabled: true },
      request: validRequest,
      provider,
      adapter,
    });
    expect(result.kind).not.toBe('ok');
  });
});

/* ------------------------------------------------------------------ */
/* Request validation happens BEFORE any call                          */
/* ------------------------------------------------------------------ */

describe('an invalid request is rejected before the transport runs', () => {
  it('returns typed issues and makes zero provider calls', async () => {
    const { provider, send } = spyProvider(() => rawPayload);
    const result = await runJobSearch({
      config: { enabled: true, endpoint: ENDPOINT },
      request: { country: 'zz', keywords: '' },
      provider,
      adapter: createAdzunaAdapter(),
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('invalid-request');
    if (result.error.kind !== 'invalid-request') return;
    expect(result.error.issues.join(' | ')).toContain('country');
    expect(result.attempts).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Happy path — normalized, validated results                          */
/* ------------------------------------------------------------------ */

describe('a successful search returns a strict normalized page', () => {
  it('normalizes the payload through the adapter', async () => {
    const { provider } = spyProvider(() => rawPayload);
    const result = await runJobSearch({
      config: { enabled: true, endpoint: ENDPOINT },
      request: validRequest,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(1);
    expect(result.results.searchedAt).toBe(FIXED_NOW);
    expect(result.results.totalCount).toBe(7);
    expect(result.results.results[0]!.title).toBe('Data Engineer');
    expect(normalizedSearchResultsSchema.safeParse(result.results).success).toBe(true);
  });

  it('sends exactly the validated request to the provider', async () => {
    const { provider, send } = spyProvider(() => rawPayload);
    await runJobSearch({
      config: { enabled: true, endpoint: ENDPOINT },
      request: { country: 'gb', keywords: 'qa', page: 4 },
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(send).toHaveBeenCalledTimes(1);
    // Defaults are applied by the adapter's schema, not by the transport.
    expect(send.mock.calls[0]![0]).toEqual({
      country: 'gb',
      keywords: 'qa',
      page: 4,
      resultsPerPage: 20,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Failure mapping                                                     */
/* ------------------------------------------------------------------ */

describe('provider failures become typed errors, never empty results', () => {
  const adapter = createAdzunaAdapter({ now: () => FIXED_NOW });
  const config = { enabled: true, endpoint: ENDPOINT };

  it('maps an unauthenticated failure', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: async () => ({ kind: 'failure', failure: { kind: 'unauthenticated', status: 410 } }),
    };
    const result = await runJobSearch({ config, request: validRequest, provider, adapter });
    expect(result).toEqual({
      kind: 'error',
      error: { kind: 'unauthenticated', status: 410 },
      attempts: 1,
    });
  });

  it('maps a rate-limit failure with its Retry-After', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: async () => ({
        kind: 'failure',
        failure: { kind: 'rate-limited', retryAfterMs: 5000 },
      }),
    };
    const result = await runJobSearch({ config, request: validRequest, provider, adapter });
    expect(result.kind === 'error' && result.error).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 5000,
    });
  });

  it('maps server, network and provider-rejected failures', async () => {
    const cases: Array<[JobSearchProviderFailure, JobSearchError]> = [
      [{ kind: 'server', status: 503 }, { kind: 'server', status: 503 }],
      [{ kind: 'network' }, { kind: 'network' }],
      [{ kind: 'provider-rejected', status: 404 }, { kind: 'provider-rejected', status: 404 }],
    ];
    for (const [failure, expected] of cases) {
      const provider: JobSearchProvider<AdzunaSearchRequest> = {
        id: 'adzuna',
        send: async () => ({ kind: 'failure', failure }),
      };
      const result = await runJobSearch({ config, request: validRequest, provider, adapter });
      expect(result.kind === 'error' && result.error).toEqual(expected);
    }
  });

  it('maps a non-JSON body to invalid-response, not an empty page', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: async () => ({ kind: 'failure', failure: { kind: 'malformed' } }),
    };
    const result = await runJobSearch({ config, request: validRequest, provider, adapter });
    expect(result.kind === 'error' && result.error.kind).toBe('invalid-response');
  });

  it('maps an unreadable payload to invalid-response', async () => {
    const { provider } = spyProvider(() => ({ error: 'nope' }));
    const result = await runJobSearch({ config, request: validRequest, provider, adapter });
    expect(result.kind === 'error' && result.error.kind).toBe('invalid-response');
  });

  it('maps a thrown provider exception to provider-fault (name only)', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: () => {
        throw new TypeError('boom');
      },
    };
    const result = await runJobSearch({ config, request: validRequest, provider, adapter });
    expect(result).toEqual({
      kind: 'error',
      error: { kind: 'provider-fault', errorName: 'TypeError' },
      attempts: 1,
    });
  });

  it('reports a timeout when the provider never settles', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: () => new Promise(() => {}),
    };
    const result = await runJobSearch({
      config,
      request: validRequest,
      provider,
      adapter,
      timeoutMs: 20,
    });
    expect(result).toEqual({ kind: 'error', error: { kind: 'timeout' }, attempts: 1 });
  });

  it('reports a timeout when the provider aborts on the forwarded signal', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: (_req, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    };
    const result = await runJobSearch({
      config,
      request: validRequest,
      provider,
      adapter,
      timeoutMs: 20,
    });
    expect(result).toEqual({ kind: 'error', error: { kind: 'timeout' }, attempts: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Adapter wiring                                                      */
/* ------------------------------------------------------------------ */

describe('the orchestrator is provider-agnostic but wires correctly', () => {
  it('uses a default 15s timeout', () => {
    expect(DEFAULT_SEARCH_TIMEOUT_MS).toBe(15000);
  });

  it('exposes an adapter whose providerId matches the adzuna provider id', () => {
    const adapter = createAdzunaAdapter();
    expect(adapter.providerId).toBe('adzuna');
  });

  it('runs with an arbitrary fake adapter (no Adzuna coupling)', async () => {
    const page: NormalizedSearchResults = {
      schemaVersion: '1',
      provider: 'adzuna',
      page: 1,
      results: [],
      skipped: 0,
      skippedReasons: [],
      attribution: {
        text: 'Adzuna',
        url: 'https://www.adzuna.co.uk/',
        notice: 'Example notice.',
      },
      searchedAt: FIXED_NOW,
    };
    const fakeAdapter: JobSearchAdapter<{ q: string }> = {
      providerId: 'adzuna',
      validateRequest: (payload) =>
        typeof (payload as { q?: unknown }).q === 'string'
          ? { ok: true, value: payload as { q: string } }
          : { ok: false, issues: ['q: required'] },
      interpret: () => ({ ok: true, value: page }),
    };
    const provider: JobSearchProvider<{ q: string }> = {
      id: 'adzuna',
      send: async () => ({ kind: 'response', raw: {} }),
    };
    const result = await runJobSearch({
      config: { enabled: true, endpoint: ENDPOINT },
      request: { q: 'anything' },
      provider,
      adapter: fakeAdapter,
    });
    expect(result.kind).toBe('ok');
  });
});

/* ------------------------------------------------------------------ */
/* No timer-driven polling                                             */
/* ------------------------------------------------------------------ */

describe('nothing runs on its own', () => {
  it('does not schedule any work when the module is imported (no polling)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { provider } = spyProvider(() => rawPayload);
    await runJobSearch({
      config: {},
      request: validRequest,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    // The unavailable path returns before any timer is created.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
