/**
 * Adzuna request contract tests (Prompt 27).
 *
 * The country enum, the parameter names and the pagination minimums asserted
 * here come from Adzuna's official documentation read on 2026-10-14
 * (docs/adzuna-integration.md). Everything else (the upper bounds) is this
 * extension's OWN policy and is asserted as such.
 */
import { describe, expect, it } from 'vitest';
import {
  ADZUNA_ATTRIBUTION,
  ADZUNA_COUNTRY_CODES,
  ADZUNA_CREDENTIAL_PARAMS,
  ADZUNA_INDIA_SUPPORTED,
  ADZUNA_PROVIDER_ID,
  ADZUNA_SORT_BY,
  adzunaSearchPath,
  adzunaSearchRequestSchema,
  buildAdzunaSearchQuery,
  validateAdzunaSearchRequest,
} from './schemas';
import {
  DEFAULT_RESULTS_PER_PAGE,
  MAX_AGE_DAYS,
  MAX_DISTANCE_KM,
  MAX_KEYWORDS_CHARS,
  MAX_LOCATION_CHARS,
  MAX_SEARCH_PAGES,
  MAX_SEARCH_RESULTS,
  JOB_SEARCH_PROVIDERS,
} from '../schemas';

const base = { country: 'gb', keywords: 'javascript developer' } as const;

describe('documented Adzuna facts encoded as constants', () => {
  it('carries the exact country enum from the official search endpoint spec', () => {
    expect([...ADZUNA_COUNTRY_CODES]).toEqual([
      'gb', 'us', 'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es',
      'fr', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'za',
    ]);
  });

  it('reports India as supported by the documented enum', () => {
    expect(ADZUNA_INDIA_SUPPORTED).toBe(true);
    expect(ADZUNA_COUNTRY_CODES).toContain('in');
  });

  it('carries the documented sort_by values', () => {
    expect([...ADZUNA_SORT_BY]).toEqual(['default', 'hybrid', 'date', 'salary', 'relevance']);
  });

  it('names the provider id used by the shared provider enum', () => {
    expect(JOB_SEARCH_PROVIDERS).toContain(ADZUNA_PROVIDER_ID);
  });

  it('carries the documented attribution minimum size', () => {
    expect(ADZUNA_ATTRIBUTION.text).toBe('Adzuna');
    expect(ADZUNA_ATTRIBUTION.minWidthPx).toBe(116);
    expect(ADZUNA_ATTRIBUTION.minHeightPx).toBe(23);
    expect(ADZUNA_ATTRIBUTION.url).toMatch(/^https:\/\//);
  });
});

describe('valid requests', () => {
  it('accepts a minimal request and fills the documented defaults', () => {
    const parsed = adzunaSearchRequestSchema.parse(base);
    expect(parsed.page).toBe(1);
    expect(parsed.resultsPerPage).toBe(DEFAULT_RESULTS_PER_PAGE);
    expect(parsed.where).toBeUndefined();
    expect(parsed.sortBy).toBeUndefined();
  });

  it('accepts every documented optional parameter', () => {
    const parsed = adzunaSearchRequestSchema.parse({
      ...base,
      where: 'Bengaluru',
      distanceKm: 25,
      page: 3,
      resultsPerPage: 25,
      maxDaysOld: 14,
      sortBy: 'date',
    });
    expect(parsed).toEqual({
      country: 'gb',
      keywords: 'javascript developer',
      where: 'Bengaluru',
      distanceKm: 25,
      page: 3,
      resultsPerPage: 25,
      maxDaysOld: 14,
      sortBy: 'date',
    });
  });

  it('accepts every documented country code', () => {
    for (const country of ADZUNA_COUNTRY_CODES) {
      expect(validateAdzunaSearchRequest({ ...base, country }).ok).toBe(true);
    }
  });

  it('trims keyword and location whitespace', () => {
    const parsed = adzunaSearchRequestSchema.parse({
      country: 'in',
      keywords: '  data engineer  ',
      where: '  Pune  ',
    });
    expect(parsed.keywords).toBe('data engineer');
    expect(parsed.where).toBe('Pune');
  });
});

describe('invalid requests are rejected with typed issues', () => {
  const expectRejected = (payload: unknown, pathFragment: string): void => {
    const result = validateAdzunaSearchRequest(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' | ')).toContain(pathFragment);
  };

  it('rejects an unsupported country code', () => {
    expectRejected({ ...base, country: 'xx' }, 'country');
    expectRejected({ ...base, country: 'IN' }, 'country'); // enum is lowercase
  });

  it('rejects blank, over-long and missing keywords', () => {
    expectRejected({ country: 'gb' }, 'keywords');
    expectRejected({ country: 'gb', keywords: '   ' }, 'keywords');
    expectRejected({ country: 'gb', keywords: 'x'.repeat(MAX_KEYWORDS_CHARS + 1) }, 'keywords');
  });

  it('rejects an over-long location', () => {
    expectRejected({ ...base, where: 'x'.repeat(MAX_LOCATION_CHARS + 1) }, 'where');
  });

  it('enforces the documented page minimum and our page ceiling', () => {
    expectRejected({ ...base, page: 0 }, 'page');
    expectRejected({ ...base, page: -1 }, 'page');
    expectRejected({ ...base, page: MAX_SEARCH_PAGES + 1 }, 'page');
    expectRejected({ ...base, page: 1.5 }, 'page');
  });

  it('enforces the documented page-size minimum and our page-size ceiling', () => {
    expectRejected({ ...base, resultsPerPage: 0 }, 'resultsPerPage');
    expectRejected({ ...base, resultsPerPage: MAX_SEARCH_RESULTS + 1 }, 'resultsPerPage');
    expectRejected({ ...base, resultsPerPage: 20.5 }, 'resultsPerPage');
  });

  it('enforces the radius and age bounds', () => {
    expectRejected({ ...base, distanceKm: 0 }, 'distanceKm');
    expectRejected({ ...base, distanceKm: MAX_DISTANCE_KM + 1 }, 'distanceKm');
    expectRejected({ ...base, maxDaysOld: 0 }, 'maxDaysOld');
    expectRejected({ ...base, maxDaysOld: MAX_AGE_DAYS + 1 }, 'maxDaysOld');
  });

  it('rejects undocumented sort values', () => {
    expectRejected({ ...base, sortBy: 'newest' }, 'sortBy');
  });

  it('does not echo the offending value back in an issue message', () => {
    const secretLooking = 'a'.repeat(MAX_KEYWORDS_CHARS + 20);
    const result = validateAdzunaSearchRequest({ country: 'gb', keywords: secretLooking });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' | ')).not.toContain(secretLooking);
  });
});

describe('credentials cannot enter a request', () => {
  it('rejects every credential-shaped extra key (strict object)', () => {
    for (const payload of [
      { ...base, app_id: '12345678' },
      { ...base, app_key: 'deadbeefdeadbeef' },
      { ...base, appId: '12345678', appKey: 'deadbeef' },
      { ...base, apiKey: 'sk-whatever' },
      { ...base, token: 'whatever' },
      { ...base, authorization: 'Bearer whatever' },
    ]) {
      expect(validateAdzunaSearchRequest(payload).ok).toBe(false);
    }
  });

  it('rejects an arbitrary endpoint URL or provider override from input', () => {
    expect(validateAdzunaSearchRequest({ ...base, url: 'https://api.adzuna.com/v1/api/x' }).ok).toBe(false);
    expect(validateAdzunaSearchRequest({ ...base, endpoint: 'https://example.invalid' }).ok).toBe(false);
    expect(validateAdzunaSearchRequest({ ...base, provider: 'other' }).ok).toBe(false);
    expect(validateAdzunaSearchRequest({ ...base, start: 0 }).ok).toBe(false);
  });

  it('rejects profile, resume and contact fields', () => {
    for (const payload of [
      { ...base, profile: { name: 'x' } },
      { ...base, email: 'nobody@example.invalid' },
      { ...base, phone: '+10000000000' },
      { ...base, resumeText: 'x'.repeat(10) },
      { ...base, rawDescription: 'x'.repeat(10) },
    ]) {
      expect(validateAdzunaSearchRequest(payload).ok).toBe(false);
    }
  });

  it('builds a query that can never contain a credential', () => {
    const request = adzunaSearchRequestSchema.parse({
      ...base,
      where: 'Bengaluru',
      distanceKm: 25,
      page: 2,
      resultsPerPage: 25,
      maxDaysOld: 7,
      sortBy: 'date',
    });
    const query = buildAdzunaSearchQuery(request);
    expect(Object.keys(query).sort()).toEqual([
      'distance',
      'max_days_old',
      'results_per_page',
      'sort_by',
      'what',
      'where',
    ]);
    for (const credential of ADZUNA_CREDENTIAL_PARAMS) {
      expect(Object.keys(query)).not.toContain(credential);
    }
    // Values are provider strings only; `page` is a path segment, not a query key.
    expect(Object.values(query).every((value) => typeof value === 'string')).toBe(true);
    expect(Object.keys(query)).not.toContain('page');
  });

  it('omits optional parameters instead of sending empty values', () => {
    const query = buildAdzunaSearchQuery(adzunaSearchRequestSchema.parse(base));
    expect(query).toEqual({ what: 'javascript developer', results_per_page: '20' });
  });
});

describe('request path', () => {
  it('builds the documented path for India', () => {
    const request = adzunaSearchRequestSchema.parse({ country: 'in', keywords: 'qa', page: 2 });
    expect(adzunaSearchPath(request)).toBe('/jobs/in/search/2');
  });
});
