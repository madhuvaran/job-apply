/**
 * Adzuna search request contract (Prompt 27).
 *
 * EVERYTHING here is derived from Adzuna's official documentation, read on
 * 2026-10-14 (see docs/adzuna-integration.md for the source list and the
 * verified-vs-uncertain table):
 * - endpoint  `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`
 *   (official OpenAPI spec `servers.url` = `https://api.adzuna.com/v1/api`);
 * - `country` is a path parameter with a documented enum of 19 codes, and
 *   `in` (India) IS in that enum;
 * - `page` is an integer with documented minimum 1 and no documented maximum;
 * - `results_per_page` is an integer with documented minimum 1 and NO
 *   documented maximum — the cap used here is OUR policy bound;
 * - `what`, `where`, `distance` (documented default 5 km), `max_days_old` and
 *   `sort_by` (`default` | `hybrid` | `date` | `salary` | `relevance`) are all
 *   documented query parameters;
 * - the API documents exactly two authentication parameters, `app_id` and
 *   `app_key`, and they are QUERY parameters.
 *
 * CREDENTIALS ARE STRUCTURALLY ABSENT. This schema is `.strict()`, so an
 * `app_id`/`app_key` (or any other extra key) fails validation rather than
 * being carried along; `buildAdzunaSearchQuery()` produces the provider query
 * WITHOUT credentials by construction. A future server-side proxy attaches
 * them; the extension cannot build an authenticated Adzuna call at all.
 *
 * Deliberately OUT OF SCOPE (deferred, documented): salary filters, the
 * `what_*` variants, `title_only`, `company`, `category`, `location0..7`,
 * contract-type filters and `salary_include_unknown`.
 *
 * Pure module: no DOM, no browser API, no storage, no network, no clock.
 */
import { z } from 'zod';
import {
  DEFAULT_RESULTS_PER_PAGE,
  formatSearchIssues,
  MAX_AGE_DAYS,
  MAX_DISTANCE_KM,
  MAX_KEYWORDS_CHARS,
  MAX_LOCATION_CHARS,
  MAX_SEARCH_PAGES,
  MAX_SEARCH_RESULTS,
  MIN_AGE_DAYS,
  MIN_DISTANCE_KM,
  type JobSearchProviderId,
  type SearchValidation,
} from '../schemas';

/**
 * The exact `country` enum from Adzuna's official search-endpoint
 * specification (order preserved). `'in'` is India.
 *
 * Verified 2026-10-14 from the OpenAPI specification; the same enum is used by
 * Adzuna's other `/jobs/{country}/…` endpoints.
 */
export const ADZUNA_COUNTRY_CODES = [
  'gb',
  'us',
  'at',
  'au',
  'be',
  'br',
  'ca',
  'ch',
  'de',
  'es',
  'fr',
  'in',
  'it',
  'mx',
  'nl',
  'nz',
  'pl',
  'sg',
  'za',
] as const;
export type AdzunaCountryCode = (typeof ADZUNA_COUNTRY_CODES)[number];

/** True when India job search is supported by the documented country enum. */
export const ADZUNA_INDIA_SUPPORTED: boolean = ADZUNA_COUNTRY_CODES.includes('in');

/** Documented `sort_by` values. */
export const ADZUNA_SORT_BY = ['default', 'hybrid', 'date', 'salary', 'relevance'] as const;
export type AdzunaSortBy = (typeof ADZUNA_SORT_BY)[number];

/** The API root documented by Adzuna ("https://api.adzuna.com/v1/api"). */
export const ADZUNA_API_ROOT = 'https://api.adzuna.com/v1/api';
/** Verified Adzuna API host — used only to recognise/validate our own requests. */
export const ADZUNA_API_HOST = 'api.adzuna.com';

/**
 * A validated Adzuna job-search request.
 *
 * `keywords` is REQUIRED: this extension only ever asks a well-scoped question,
 * never issues an open-ended crawl. `page`/`resultsPerPage` default to a normal
 * first page and are bounded above by our own policy caps.
 */
export const adzunaSearchRequestSchema = z
  .object({
    country: z.enum(ADZUNA_COUNTRY_CODES),
    /** Free-text keywords (Adzuna `what`). Trimmed; never empty. */
    keywords: z.string().trim().min(1).max(MAX_KEYWORDS_CHARS),
    /** Free-text location (Adzuna `where`), optional. */
    where: z.string().trim().min(1).max(MAX_LOCATION_CHARS).optional(),
    /** Radius in km around `where` (Adzuna `distance`). */
    distanceKm: z.number().int().min(MIN_DISTANCE_KM).max(MAX_DISTANCE_KM).optional(),
    /** 1-based page (Adzuna path parameter). */
    page: z.number().int().min(1).max(MAX_SEARCH_PAGES).default(1),
    /** Requested page size (Adzuna `results_per_page`). */
    resultsPerPage: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(DEFAULT_RESULTS_PER_PAGE),
    /** Oldest advert age in days (Adzuna `max_days_old`). */
    maxDaysOld: z.number().int().min(MIN_AGE_DAYS).max(MAX_AGE_DAYS).optional(),
    /** Result ordering (Adzuna `sort_by`). */
    sortBy: z.enum(ADZUNA_SORT_BY).optional(),
  })
  .strict();
export type AdzunaSearchRequest = z.infer<typeof adzunaSearchRequestSchema>;

/** Validate an untrusted search request (issues = field path + fixed message). */
export function validateAdzunaSearchRequest(
  payload: unknown,
): SearchValidation<AdzunaSearchRequest> {
  const parsed = adzunaSearchRequestSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: formatSearchIssues(parsed.error.issues) };
}

/**
 * The request's path on the Adzuna API, e.g. `/jobs/in/search/1`.
 * Path building is total: `country` comes from the validated enum and `page`
 * from the validated integer, so nothing user-supplied is interpolated raw.
 */
export function adzunaSearchPath(request: AdzunaSearchRequest): string {
  return `/jobs/${request.country}/search/${request.page}`;
}

/**
 * The provider query parameters for a validated request.
 *
 * NO CREDENTIALS, EVER: `app_id`/`app_key` are absent by construction and there
 * is no parameter that could introduce them. The function is pure and returns
 * strings only — no objects that could be mutated into carrying a secret.
 *
 * `page` is a path segment (see `adzunaSearchPath`), not a query parameter.
 */
export function buildAdzunaSearchQuery(request: AdzunaSearchRequest): Record<string, string> {
  const query: Record<string, string> = {
    what: request.keywords,
    results_per_page: String(request.resultsPerPage),
  };
  if (request.where !== undefined) query['where'] = request.where;
  if (request.distanceKm !== undefined) query['distance'] = String(request.distanceKm);
  if (request.maxDaysOld !== undefined) query['max_days_old'] = String(request.maxDaysOld);
  if (request.sortBy !== undefined) query['sort_by'] = request.sortBy;
  return query;
}

/**
 * Keys that must never appear in a query we build. Exported so tests and a
 * future proxy contract can assert the invariant instead of restating it.
 */
export const ADZUNA_CREDENTIAL_PARAMS = ['app_id', 'app_key'] as const;

/* ------------------------------------------------------------------ */
/* Provider identity + attribution                                     */
/* ------------------------------------------------------------------ */

/** This provider's identifier in `JOB_SEARCH_PROVIDERS`. */
export const ADZUNA_PROVIDER_ID = 'adzuna' as const satisfies JobSearchProviderId;

/**
 * Adzuna's attribution requirement, taken from the official API Terms of
 * Service read on 2026-10-14:
 *
 *   "An API user shall label each displayed advert with the phrase \"Adzuna\" at
 *    least 116 X 23 pixels in size, wherein the word \"Adzuna\" shall be
 *    hyperlinked to http://www.adzuna.co.uk or the relevant local domain"
 *
 * Carried inside every normalized page so a future search UI cannot render
 * listings without the mandatory credit. This is a compliance requirement, not
 * a preference — the values below are the documented minimum.
 */
export const ADZUNA_ATTRIBUTION = {
  text: 'Adzuna',
  url: 'https://www.adzuna.co.uk/',
  minWidthPx: 116,
  minHeightPx: 23,
  notice:
    'Listings are provided by the Adzuna API. Each displayed listing must show the Adzuna credit at least 116x23 pixels, linked to Adzuna, and must link out through the provided listing URL.',
} as const;
