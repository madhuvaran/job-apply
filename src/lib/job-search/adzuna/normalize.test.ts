/**
 * Adzuna response normalization tests (Prompt 27).
 *
 * Every fixture below is a hand-written, INVENTED payload shaped like Adzuna's
 * documented response. No real credential, no real advert and no live request
 * is involved anywhere — the normalizer is a pure function over the payload.
 *
 * The documented facts these tests hold the code to (id/title/created/
 * description required, everything else optional, `description` truncated to
 * 500 chars, `created` ISO 8601, `count` as the total, salary in local
 * currency, `salary_is_predicted` = Jobsworth estimate) come from the sources
 * listed in docs/adzuna-integration.md (read 2026-10-14).
 */
import { describe, expect, it } from 'vitest';
import {
  ADZUNA_SKIP_REASONS,
  normalizeAdzunaJob,
  normalizeAdzunaSearchResponse,
} from './normalize';
import { adzunaSearchRequestSchema } from './schemas';
import {
  JOB_SEARCH_SCHEMA_VERSION,
  MAX_DESCRIPTION_SNIPPET_CHARS,
  MAX_SEARCH_RESULTS,
  normalizedJobResultSchema,
  normalizedSearchResultsSchema,
} from '../schemas';

const FIXED_NOW = '2026-10-15T09:00:00.000Z';

function request(overrides: Record<string, unknown> = {}) {
  return adzunaSearchRequestSchema.parse({
    country: 'in',
    keywords: 'data engineer',
    page: 1,
    ...overrides,
  });
}

/** A complete, well-formed Adzuna record (values invented). */
const fullRecord = {
  id: '1234567890',
  title: 'Data Engineer',
  description: 'Build and maintain data pipelines for the analytics team.',
  created: '2026-10-01T08:30:00Z',
  redirect_url: 'https://www.adzuna.in/details/1234567890',
  company: { display_name: 'Example Analytics Ltd', canonical_name: 'example analytics' },
  location: { display_name: 'Bengaluru, Karnataka', area: ['Karnataka', 'Bengaluru'] },
  salary_min: 900000,
  salary_max: 1400000,
  salary_is_predicted: '0',
  contract_time: 'full_time',
  contract_type: 'permanent',
  category: 'IT Jobs',
  adref: 'opaque-tracking-token',
  latitude: 12.9716,
  longitude: 77.5946,
  __CLASS__: 'Adzuna::API::Response::Job',
};

function envelope(results: unknown[], count?: number) {
  return {
    results,
    ...(count !== undefined ? { count } : {}),
    mean: 1250000,
    __CLASS__: 'Adzuna::API::Response::JobSearchResults',
  };
}

function normalize(results: unknown[], count?: number, req = request()) {
  return normalizeAdzunaSearchResponse(envelope(results, count), {
    request: req,
    now: () => FIXED_NOW,
  });
}

/* ------------------------------------------------------------------ */
/* Valid normalized response                                           */
/* ------------------------------------------------------------------ */

describe('a well-formed payload normalizes to the strict page', () => {
  it('maps every documented field and injects the clock/labels', () => {
    const result = normalize([fullRecord], 4321);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const page = result.value;
    expect(page.schemaVersion).toBe(JOB_SEARCH_SCHEMA_VERSION);
    expect(page.provider).toBe('adzuna');
    expect(page.page).toBe(1);
    expect(page.totalCount).toBe(4321);
    expect(page.skipped).toBe(0);
    expect(page.skippedReasons).toEqual([]);
    expect(page.searchedAt).toBe(FIXED_NOW);
    // Mandatory attribution travels WITH the results, so a future UI cannot
    // render listings without the required credit.
    expect(page.attribution.text).toBe('Adzuna');
    expect(page.attribution.minWidthPx).toBe(116);
    expect(page.attribution.minHeightPx).toBe(23);

    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toEqual({
      provider: 'adzuna',
      externalId: '1234567890',
      title: 'Data Engineer',
      company: 'Example Analytics Ltd',
      location: 'Bengaluru, Karnataka',
      postedDate: '2026-10-01',
      url: 'https://www.adzuna.in/details/1234567890',
      description: 'Build and maintain data pipelines for the analytics team.',
      salary: { min: 900000, max: 1400000, predicted: false },
      country: 'in',
    });
    // The whole page is re-validated by the strict schema (belt and braces).
    expect(normalizedSearchResultsSchema.safeParse(page).success).toBe(true);
  });

  it('never copies a raw provider key into the result (no __CLASS__, adref or coordinates)', () => {
    const result = normalize([fullRecord]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const job = result.value.results[0]!;
    expect(Object.keys(job).sort()).toEqual([
      'company',
      'country',
      'description',
      'externalId',
      'location',
      'postedDate',
      'provider',
      'salary',
      'title',
      'url',
    ]);
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain('__CLASS__');
    expect(serialized).not.toContain('adref');
    expect(serialized).not.toContain('canonical_name');
    expect(serialized).not.toContain('latitude');
  });

  it('is deterministic for identical inputs (same injected clock)', () => {
    expect(JSON.stringify(normalize([fullRecord], 10))).toBe(
      JSON.stringify(normalize([fullRecord], 10)),
    );
  });

  it('treats an empty results array as a REAL empty result, not an error', () => {
    const result = normalize([], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toEqual([]);
    expect(result.value.totalCount).toBe(0);
    expect(result.value.skipped).toBe(0);
  });

  it('omits a missing total count instead of inventing one', () => {
    const result = normalize([fullRecord]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('totalCount' in result.value).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Optional and missing provider fields                                */
/* ------------------------------------------------------------------ */

describe('optional and missing provider fields stay ABSENT (never fabricated)', () => {
  it('normalizes a record with only the required fields', () => {
    const result = normalize([
      {
        id: 'abc',
        title: 'QA Engineer',
        description: 'Manual and automated testing.',
        created: '2026-09-30T10:00:00Z',
        redirect_url: 'https://www.adzuna.co.uk/details/abc',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results[0]).toEqual({
      provider: 'adzuna',
      externalId: 'abc',
      title: 'QA Engineer',
      url: 'https://www.adzuna.co.uk/details/abc',
      description: 'Manual and automated testing.',
      postedDate: '2026-09-30',
      country: 'in',
    });
    // Optional keys are genuinely absent, not empty strings / zero salaries.
    expect('company' in result.value.results[0]!).toBe(false);
    expect('location' in result.value.results[0]!).toBe(false);
    expect('salary' in result.value.results[0]!).toBe(false);
  });

  it('drops malformed optional values instead of repairing them', () => {
    const outcome = normalizeAdzunaJob(
      {
        ...fullRecord,
        company: { display_name: '   ' },
        location: { display_name: 42 },
        salary_min: 'lots',
        salary_max: -5,
        created: '3 days ago',
        description: 12345,
      },
      'in',
    );
    expect(outcome.kind).toBe('job');
    if (outcome.kind !== 'job') return;
    const job = outcome.job;
    expect('company' in job).toBe(false);
    expect('location' in job).toBe(false);
    expect('salary' in job).toBe(false);
    expect('postedDate' in job).toBe(false);
    expect('description' in job).toBe(false);
    expect(normalizedJobResultSchema.safeParse(job).success).toBe(true);
  });

  it('falls back to location.area (outermost first) when display_name is absent', () => {
    const outcome = normalizeAdzunaJob(
      { ...fullRecord, location: { area: ['Karnataka', 'Bengaluru'] } },
      'in',
    );
    expect(outcome.kind).toBe('job');
    if (outcome.kind !== 'job') return;
    expect(outcome.job.location).toBe('Karnataka, Bengaluru');
  });

  it('never substitutes the search time for a missing posting date', () => {
    const outcome = normalizeAdzunaJob({ ...fullRecord, created: undefined }, 'in');
    expect(outcome.kind).toBe('job');
    if (outcome.kind !== 'job') return;
    expect('postedDate' in outcome.job).toBe(false);
    expect(outcome.job.postedDate).not.toBe('2026-10-15');
  });
});

/* ------------------------------------------------------------------ */
/* Description cap and salary semantics                                */
/* ------------------------------------------------------------------ */

describe('description and salary follow the documented semantics', () => {
  it('caps the snippet at the documented 500 characters', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_SNIPPET_CHARS + 200);
    const outcome = normalizeAdzunaJob({ ...fullRecord, description: long }, 'in');
    expect(outcome.kind).toBe('job');
    if (outcome.kind !== 'job') return;
    expect(outcome.job.description).toHaveLength(MAX_DESCRIPTION_SNIPPET_CHARS);
  });

  it('marks a Jobsworth estimate as predicted=true and an advertised figure false', () => {
    const predicted = normalizeAdzunaJob({ ...fullRecord, salary_is_predicted: '1' }, 'in');
    const advertised = normalizeAdzunaJob({ ...fullRecord, salary_is_predicted: 0 }, 'in');
    expect(predicted.kind === 'job' && predicted.job.salary?.predicted).toBe(true);
    expect(advertised.kind === 'job' && advertised.job.salary?.predicted).toBe(false);
  });

  it('reports predicted=null when the provider does not state it', () => {
    const outcome = normalizeAdzunaJob({ ...fullRecord, salary_is_predicted: 'maybe' }, 'in');
    expect(outcome.kind).toBe('job');
    if (outcome.kind !== 'job') return;
    expect(outcome.job.salary?.predicted).toBeNull();
  });

  it('keeps a single-sided salary and normalizes a swapped pair', () => {
    const oneSided = normalizeAdzunaJob(
      { ...fullRecord, salary_min: undefined, salary_max: 500000 },
      'in',
    );
    expect(oneSided.kind === 'job' && oneSided.job.salary).toEqual({
      max: 500000,
      predicted: false,
    });
    const swapped = normalizeAdzunaJob(
      { ...fullRecord, salary_min: 2000000, salary_max: 1000000 },
      'in',
    );
    expect(swapped.kind === 'job' && swapped.job.salary).toEqual({
      min: 1000000,
      max: 2000000,
      predicted: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Malformed response rejection                                        */
/* ------------------------------------------------------------------ */

describe('a malformed envelope is an error, never an empty page', () => {
  const bad = (payload: unknown) =>
    normalizeAdzunaSearchResponse(payload, { request: request(), now: () => FIXED_NOW });

  it('rejects a payload with no results array', () => {
    for (const payload of [null, undefined, 42, 'oops', {}, { results: 'nope' }, { results: {} }]) {
      const result = bad(payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.join(' | ')).toContain('results array');
    }
  });

  it('rejects an error body that the proxy echoed with HTTP 200', () => {
    const result = bad({ error: { message: 'unauthorized' }, results: null });
    expect(result.ok).toBe(false);
  });

  it('reports unreadable data, never an empty successful page', () => {
    const result = bad({ results: null });
    expect(result.ok).toBe(false);
    // The distinction matters: "we could not read it" != "nothing matched".
    expect(result).not.toHaveProperty('value');
  });
});

/* ------------------------------------------------------------------ */
/* Skipping is explicit and content-free                               */
/* ------------------------------------------------------------------ */

describe('unusable records are counted with fixed reasons', () => {
  it('skips non-objects, missing id/title and unusable URLs', () => {
    const result = normalize([
      'not-an-object',
      { title: 'No id', redirect_url: 'https://example.invalid/1' },
      { id: 'no-title', redirect_url: 'https://example.invalid/2' },
      { id: 'no-url', title: 'No URL' },
      { id: 'bad-url', title: 'Bad URL', redirect_url: 'javascript:alert(1)' },
      fullRecord,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.skipped).toBe(5);
    expect([...result.value.skippedReasons].sort()).toEqual(
      [
        ADZUNA_SKIP_REASONS.notARecord,
        ADZUNA_SKIP_REASONS.missingId,
        ADZUNA_SKIP_REASONS.missingTitle,
        ADZUNA_SKIP_REASONS.missingUrl,
      ].sort(),
    );
    // Reasons are fixed literals — no job content leaks into them.
    for (const reason of result.value.skippedReasons) {
      expect(reason).not.toContain('No URL');
      expect(reason).not.toContain('example.invalid');
    }
  });

  it('counts valid records past our page cap instead of merging them', () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 3 }, (_, i) => ({
      ...fullRecord,
      id: `id-${i}`,
    }));
    const result = normalize(many);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(result.value.skipped).toBe(3);
    expect(result.value.skippedReasons).toContain(ADZUNA_SKIP_REASONS.pageLimit);
  });

  it('scopes the country code to the validated request', () => {
    const uk = normalize([fullRecord], undefined, request({ country: 'gb', page: 3 }));
    expect(uk.ok).toBe(true);
    if (!uk.ok) return;
    expect(uk.value.page).toBe(3);
    expect(uk.value.results[0]!.country).toBe('gb');
  });
});
