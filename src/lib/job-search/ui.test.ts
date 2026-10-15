/**
 * Job-search UI logic tests (Prompt 28).
 *
 * Pure module, pure tests: no React, no DOM, no storage, no network. The
 * "configured provider" cases use an INJECTED fake transport, so no live request
 * and no API quota is ever involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdzunaAdapter } from './adzuna/adapter';
import { ADZUNA_COUNTRY_CODES, ADZUNA_SORT_BY, adzunaSearchRequestSchema } from './adzuna/schemas';
import { JOB_SEARCH_ERROR_MESSAGES } from './errors';
import type { JobSearchProvider, JobSearchProviderOutcome } from './provider';
import type { AdzunaSearchRequest } from './adzuna/schemas';
import {
  ADZUNA_COUNTRY_LABELS,
  buildJobSearchRequest,
  createUnconfiguredSearchProvider,
  EMPTY_JOB_SEARCH_FORM,
  EXTENSION_JOB_SEARCH_CONFIG,
  executeJobSearch,
  initialJobSearchState,
  isSupportedCountry,
  JOB_SEARCH_COUNTRY_OPTIONS,
  JOB_SEARCH_SORT_OPTIONS,
  resetJobSearchForm,
  searchStateFromRunResult,
  validateJobSearchForm,
  type JobSearchForm,
} from './ui';

const FIXED_NOW = '2026-10-15T09:00:00.000Z';
const CONFIGURED = { enabled: true, endpoint: 'https://search.example.com/api' };

function form(patch: Partial<JobSearchForm> = {}): JobSearchForm {
  return { ...resetJobSearchForm(), keywords: 'data engineer', country: 'in', ...patch };
}

/** A documented-shaped Adzuna payload (values invented). */
function payload(results: unknown[] = [job()], count = 1) {
  return { results, count };
}

function job(patch: Record<string, unknown> = {}) {
  return {
    id: '1',
    title: 'Data Engineer',
    description: 'Pipelines.',
    created: '2026-10-02T08:00:00Z',
    redirect_url: 'https://www.adzuna.in/details/1',
    ...patch,
  };
}

function fakeProvider(outcome: () => JobSearchProviderOutcome | Promise<JobSearchProviderOutcome>) {
  // Declared parameters so `mock.calls` is typed (the request is asserted).
  const send = vi.fn(async (_request: AdzunaSearchRequest, _context: unknown) => outcome());
  const provider: JobSearchProvider<AdzunaSearchRequest> = { id: 'adzuna', send };
  return { provider, send };
}

function responses(raw: unknown) {
  return fakeProvider(() => ({ kind: 'response', raw }));
}

function failures(failure: { kind: string } & Record<string, unknown>) {
  return fakeProvider(() => ({ kind: 'failure', failure } as unknown as JobSearchProviderOutcome));
}

/* ------------------------------------------------------------------ */
/* Options come from the verified enum                                  */
/* ------------------------------------------------------------------ */

describe('country and sort options reflect the verified provider contract', () => {
  it('lists exactly the documented countries, India included', () => {
    expect(JOB_SEARCH_COUNTRY_OPTIONS.map((o) => o.code)).toEqual([...ADZUNA_COUNTRY_CODES]);
    expect(JOB_SEARCH_COUNTRY_OPTIONS.map((o) => o.code)).toContain('in');
  });

  it('labels every supported country (no silent gaps)', () => {
    for (const code of ADZUNA_COUNTRY_CODES) {
      expect(ADZUNA_COUNTRY_LABELS[code]).toBeTruthy();
      expect(JOB_SEARCH_COUNTRY_OPTIONS.find((o) => o.code === code)?.label).toBe(
        ADZUNA_COUNTRY_LABELS[code],
      );
    }
  });

  it('offers only documented sort values (plus "let the provider choose")', () => {
    const values = JOB_SEARCH_SORT_OPTIONS.map((o) => o.value);
    expect(values).toContain('');
    for (const value of values) {
      if (value !== '') expect(ADZUNA_SORT_BY).toContain(value);
    }
  });

  it('recognises supported values and rejects others', () => {
    expect(isSupportedCountry('in')).toBe(true);
    expect(isSupportedCountry('xx')).toBe(false);
    expect(isSupportedCountry('IN')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Form validation                                                      */
/* ------------------------------------------------------------------ */

describe('form validation reports precise, value-free issues', () => {
  it('accepts a complete minimal form', () => {
    expect(validateJobSearchForm(form())).toEqual([]);
  });

  const fieldOf = (f: JobSearchForm, field: string) =>
    validateJobSearchForm(f).filter((i) => i.field === field);

  it('requires keywords and a country', () => {
    expect(fieldOf(form({ keywords: '   ' }), 'keywords')).toHaveLength(1);
    expect(fieldOf(form({ country: '' }), 'country')).toHaveLength(1);
  });

  it('rejects an unsupported country', () => {
    expect(fieldOf(form({ country: 'zz' }), 'country')).toHaveLength(1);
    expect(fieldOf(form({ country: 'IN' }), 'country')).toHaveLength(1);
    expect(fieldOf(form({ country: 'de' }), 'country')).toHaveLength(0);
  });

  it('enforces the same bounds as the provider schema', () => {
    expect(fieldOf(form({ keywords: 'x'.repeat(201) }), 'keywords')).toHaveLength(1);
    expect(fieldOf(form({ where: 'x'.repeat(121) }), 'where')).toHaveLength(1);
    expect(fieldOf(form({ where: 'Berlin', distanceKm: '0' }), 'distanceKm')).toHaveLength(1);
    expect(fieldOf(form({ where: 'Berlin', distanceKm: '501' }), 'distanceKm')).toHaveLength(1);
    expect(fieldOf(form({ where: 'Berlin', distanceKm: 'abc' }), 'distanceKm')).toHaveLength(1);
    expect(fieldOf(form({ maxDaysOld: '0' }), 'maxDaysOld')).toHaveLength(1);
    expect(fieldOf(form({ maxDaysOld: '366' }), 'maxDaysOld')).toHaveLength(1);
    expect(fieldOf(form({ maxDaysOld: '1.5' }), 'maxDaysOld')).toHaveLength(1);
    expect(fieldOf(form({ sortBy: 'newest' }), 'sortBy')).toHaveLength(1);
  });

  it('ignores a search radius without a location instead of refusing it', () => {
    expect(validateJobSearchForm(form({ distanceKm: '999' }))).toEqual([]);
  });

  it('never echoes the offending value back in a message', () => {
    const secretLooking = 'sk-live-abcdefghijklmnop';
    const issues = validateJobSearchForm(form({ keywords: secretLooking.repeat(10) }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.message).join(' | ')).not.toContain(secretLooking);
  });
});

/* ------------------------------------------------------------------ */
/* Form → request                                                       */
/* ------------------------------------------------------------------ */

describe('buildJobSearchRequest produces a validated provider request', () => {
  it('sends only what the user provided and lets the provider default the rest', () => {
    const built = buildJobSearchRequest(form());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // `page` and `resultsPerPage` come from the provider schema's own defaults.
    expect(built.request).toEqual({
      country: 'in',
      keywords: 'data engineer',
      page: 1,
      resultsPerPage: 20,
    });
    expect(adzunaSearchRequestSchema.safeParse(built.request).success).toBe(true);
  });

  it('includes every supported optional filter when set', () => {
    const built = buildJobSearchRequest(
      form({ where: 'Bengaluru', distanceKm: '25', maxDaysOld: '7', sortBy: 'date' }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request).toEqual({
      country: 'in',
      keywords: 'data engineer',
      where: 'Bengaluru',
      distanceKm: 25,
      maxDaysOld: 7,
      sortBy: 'date',
      page: 1,
      resultsPerPage: 20,
    });
  });

  it('drops a radius when there is no location', () => {
    const built = buildJobSearchRequest(form({ distanceKm: '25' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect('distanceKm' in built.request).toBe(false);
  });

  it('refuses an invalid form with typed issues and no request', () => {
    const built = buildJobSearchRequest(form({ keywords: '', country: '' }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.map((i) => i.field).sort()).toEqual(['country', 'keywords']);
  });

  it('can never carry a credential or profile field', () => {
    const built = buildJobSearchRequest(
      form({ where: 'Pune', distanceKm: '10', maxDaysOld: '3', sortBy: 'salary' }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const keys = Object.keys(built.request);
    expect(keys.sort()).toEqual([
      'country',
      'distanceKm',
      'keywords',
      'maxDaysOld',
      'page',
      'resultsPerPage',
      'sortBy',
      'where',
    ]);
    for (const forbidden of ['app_id', 'app_key', 'apiKey', 'token', 'profile', 'email', 'resume']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Availability and the unconfigured transport                          */
/* ------------------------------------------------------------------ */

describe('search is unavailable until a secure endpoint is configured', () => {
  it('reports the accurate reason for this build', () => {
    const state = initialJobSearchState();
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') return;
    expect(state.reason).toBe('not-configured');
    expect(state.message).toContain('Live job search is not available in this build');
  });

  it('is initial (not unavailable) once a configured endpoint exists', () => {
    expect(initialJobSearchState(CONFIGURED).kind).toBe('initial');
  });

  it('ships a transport that refuses to run rather than returning fake jobs', () => {
    const provider = createUnconfiguredSearchProvider();
    expect(() => provider.send({} as AdzunaSearchRequest, {} as never)).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Execution: unavailable / invalid — never a request                   */
/* ------------------------------------------------------------------ */

describe('executeJobSearch never touches the transport when it cannot run', () => {
  it('returns unavailable and makes zero provider calls (unconfigured build)', async () => {
    const { provider, send } = responses(payload());
    const state = await executeJobSearch({ form: form(), provider });
    expect(state.kind).toBe('unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports invalid form without calling the provider', async () => {
    const { provider, send } = responses(payload());
    const state = await executeJobSearch({
      form: form({ keywords: '' }),
      config: CONFIGURED,
      provider,
    });
    expect(state.kind).toBe('invalid');
    if (state.kind !== 'invalid') return;
    expect(state.issues.map((i) => i.field)).toContain('keywords');
    expect(send).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Execution: results                                                   */
/* ------------------------------------------------------------------ */

describe('a successful search yields normalized results', () => {
  it('returns results for a valid provider page', async () => {
    const { provider, send } = responses(payload());
    const state = await executeJobSearch({
      form: form(),
      config: CONFIGURED,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(state.kind).toBe('results');
    if (state.kind !== 'results') return;
    expect(state.page.results).toHaveLength(1);
    expect(state.page.results[0]!.title).toBe('Data Engineer');
    expect(state.page.attribution.text).toBe('Adzuna');
    expect(state.page.searchedAt).toBe(FIXED_NOW);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns results with an EMPTY list for a genuinely empty search', async () => {
    const { provider } = responses({ results: [], count: 0 });
    const state = await executeJobSearch({
      form: form(),
      config: CONFIGURED,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(state.kind).toBe('results');
    if (state.kind !== 'results') return;
    expect(state.page.results).toEqual([]);
  });

  it('sends the validated request the form produced', async () => {
    const { provider, send } = responses(payload());
    await executeJobSearch({
      form: form({ where: 'Pune', maxDaysOld: '14' }),
      config: CONFIGURED,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(send.mock.calls[0]![0]).toEqual({
      country: 'in',
      keywords: 'data engineer',
      where: 'Pune',
      maxDaysOld: 14,
      page: 1,
      resultsPerPage: 20,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Execution: failures are never empty successes                        */
/* ------------------------------------------------------------------ */

describe('every failure is a distinct error state, never an empty result', () => {
  const cases: Array<[string, { kind: string } & Record<string, unknown>, string]> = [
    ['unauthenticated', { kind: 'unauthenticated', status: 410 }, 'unauthenticated'],
    ['rate-limited', { kind: 'rate-limited' }, 'rate-limited'],
    ['network', { kind: 'network' }, 'network'],
    ['server', { kind: 'server', status: 503 }, 'server'],
    ['provider-rejected', { kind: 'provider-rejected', status: 400 }, 'provider-rejected'],
    ['malformed', { kind: 'malformed' }, 'invalid-response'],
  ];

  it.each(cases)('maps a %s failure to an error state', async (_name, failure, expectedKind) => {
    const { provider } = failures(failure);
    const state = await executeJobSearch({
      form: form(),
      config: CONFIGURED,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.kind).toBe(expectedKind);
    expect(state.message).toBe(
      JOB_SEARCH_ERROR_MESSAGES[expectedKind as keyof typeof JOB_SEARCH_ERROR_MESSAGES],
    );
  });

  it('maps an unreadable 200 payload to invalid-response', async () => {
    const { provider } = responses({ error: 'nope' });
    const state = await executeJobSearch({
      form: form(),
      config: CONFIGURED,
      provider,
      adapter: createAdzunaAdapter({ now: () => FIXED_NOW }),
    });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.kind).toBe('invalid-response');
  });

  it('maps a thrown provider to provider-fault', async () => {
    const provider: JobSearchProvider<AdzunaSearchRequest> = {
      id: 'adzuna',
      send: () => {
        throw new TypeError('boom');
      },
    };
    const state = await executeJobSearch({ form: form(), config: CONFIGURED, provider });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.kind).toBe('provider-fault');
  });

  it('reports not-configured as unavailable, not as an error or empty result', () => {
    expect(
      searchStateFromRunResult({
        kind: 'error',
        error: { kind: 'not-configured', reason: 'disabled', message: 'off' },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'disabled', message: 'off' });
  });
});

/* ------------------------------------------------------------------ */
/* The default form                                                    */
/* ------------------------------------------------------------------ */

describe('the empty form is blank (nothing preselected or assumed)', () => {
  it('is blank and independent of the shared constant', () => {
    expect(EMPTY_JOB_SEARCH_FORM).toEqual({
      keywords: '',
      where: '',
      country: '',
      distanceKm: '',
      maxDaysOld: '',
      sortBy: '',
    });
    const copy = resetJobSearchForm();
    copy.keywords = 'changed';
    expect(EMPTY_JOB_SEARCH_FORM.keywords).toBe('');
  });
});
