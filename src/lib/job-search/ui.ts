/**
 * Job-search UI logic (Prompt 28) — PURE and provider-agnostic.
 *
 * Everything here is testable without React, a DOM, storage or a network: the
 * form→request mapping, the validation messages and the view-state machine that
 * the Options → Job search panel renders.
 *
 * Guarantees:
 * - VALIDATION IS NOT REIMPLEMENTED. The form is only ever turned into a request
 *   candidate and then checked by Prompt 27's own `validateAdzunaSearchRequest`
 *   schema, so the search UI can never accept something the provider layer would
 *   reject (or vice versa). The friendly per-field messages here exist so the
 *   user sees something readable; the schema remains the authority.
 * - NO FABRICATION. Every state is derived from what actually happened: an
 *   unconfigured provider yields `unavailable`, a failed request yields `error`
 *   and only a validated, normalized provider page yields `results`. A failure
 *   is never rendered as an empty successful search.
 * - NO NETWORK WITHOUT CONFIGURATION. `executeJobSearch()` checks availability
 *   BEFORE anything else and returns without touching the transport, so the
 *   unconfigured build performs zero requests (asserted by tests).
 * - NO CREDENTIALS, NO ARBITRARY ENDPOINTS. The only configuration is the
 *   constant below; there is no user-editable URL and no key field, matching the
 *   integration boundary documented in docs/adzuna-integration.md.
 *
 * Pure module: no DOM, no browser API, no storage, no AI, no clock.
 */
import { createAdzunaAdapter } from './adzuna/adapter';
import {
  ADZUNA_COUNTRY_CODES,
  ADZUNA_SORT_BY,
  validateAdzunaSearchRequest,
  type AdzunaCountryCode,
  type AdzunaSearchRequest,
  type AdzunaSortBy,
} from './adzuna/schemas';
import { messageForSearchError, type JobSearchError } from './errors';
import type { JobSearchProvider } from './provider';
import {
  MAX_AGE_DAYS,
  MAX_DISTANCE_KM,
  MAX_KEYWORDS_CHARS,
  MAX_LOCATION_CHARS,
  MIN_AGE_DAYS,
  MIN_DISTANCE_KM,
  type NormalizedSearchResults,
  type SearchValidation,
} from './schemas';
import {
  describeJobSearchAvailability,
  runJobSearch,
  type JobSearchAdapter,
  type JobSearchConfig,
  type JobSearchUnavailableReason,
} from './service';

/* ------------------------------------------------------------------ */
/* Configuration (there is deliberately no user-editable one)          */
/* ------------------------------------------------------------------ */

/**
 * The extension's job-search configuration.
 *
 * `enabled` is true but NO endpoint is set, so availability reports
 * `not-configured` — the accurate reason ("no secure endpoint is configured"),
 * rather than `disabled`, which would wrongly claim a setting the app does not
 * have turned search off. There is deliberately no user-editable endpoint: no
 * secure server-side proxy is deployed, and Prompt 27 forbids accepting an
 * arbitrary endpoint URL (an insecure configuration is exactly what the
 * integration boundary exists to prevent). `runJobSearch()` therefore returns
 * `not-configured` before it touches the transport, and the panel shows an
 * honest "live search is not available" state.
 *
 * When a verified proxy exists, replace this constant with a read of validated
 * app settings (`JobSearchConfig` already validates the shape).
 */
export const EXTENSION_JOB_SEARCH_CONFIG: JobSearchConfig = { enabled: true };

/**
 * The transport handed to `runJobSearch()` in this build.
 *
 * It can never legitimately be called: the configuration above is disabled, so
 * the orchestrator returns `not-configured` first. It throws (instead of
 * returning a fake result) so that a future change which enables search without
 * wiring a real, secure provider fails loudly as a typed `provider-fault`
 * rather than silently appearing to work.
 */
export function createUnconfiguredSearchProvider(): JobSearchProvider<AdzunaSearchRequest> {
  return {
    id: 'adzuna',
    send(): Promise<never> {
      throw new Error('the job search provider is not configured');
    },
  };
}

/* ------------------------------------------------------------------ */
/* Country + sort options (from the VERIFIED Adzuna enum)              */
/* ------------------------------------------------------------------ */

/**
 * Display names for the verified country enum. Typed as a complete record, so
 * adding a country to `ADZUNA_COUNTRY_CODES` is a compile error until it is
 * labelled here — the dropdown can never silently omit a supported country.
 */
export const ADZUNA_COUNTRY_LABELS: Readonly<Record<AdzunaCountryCode, string>> = {
  gb: 'United Kingdom',
  us: 'United States',
  at: 'Austria',
  au: 'Australia',
  be: 'Belgium',
  br: 'Brazil',
  ca: 'Canada',
  ch: 'Switzerland',
  de: 'Germany',
  es: 'Spain',
  fr: 'France',
  in: 'India',
  it: 'Italy',
  mx: 'Mexico',
  nl: 'Netherlands',
  nz: 'New Zealand',
  pl: 'Poland',
  sg: 'Singapore',
  za: 'South Africa',
};

export interface JobSearchCountryOption {
  code: AdzunaCountryCode;
  label: string;
}

/** Exactly the countries the verified provider contract supports, in order. */
export const JOB_SEARCH_COUNTRY_OPTIONS: readonly JobSearchCountryOption[] =
  ADZUNA_COUNTRY_CODES.map((code) => ({ code, label: ADZUNA_COUNTRY_LABELS[code] }));

export interface JobSearchSortOption {
  /** `''` means "let the provider choose" (the parameter is not sent). */
  value: '' | AdzunaSortBy;
  label: string;
}

/** Only the documented `sort_by` values; no invented orderings. */
export const JOB_SEARCH_SORT_OPTIONS: readonly JobSearchSortOption[] = [
  { value: '', label: 'Provider default' },
  { value: 'relevance', label: 'Most relevant' },
  { value: 'date', label: 'Newest first' },
  { value: 'salary', label: 'Highest salary first' },
];

export const SEARCH_SORT_LABELS: Readonly<Record<AdzunaSortBy, string>> = {
  default: 'Adzuna default',
  hybrid: 'Adzuna hybrid',
  date: 'Newest first',
  salary: 'Highest salary first',
  relevance: 'Most relevant',
};

export function isSupportedCountry(value: string): value is AdzunaCountryCode {
  return (ADZUNA_COUNTRY_CODES as readonly string[]).includes(value);
}

export function isSupportedSort(value: string): value is AdzunaSortBy {
  return (ADZUNA_SORT_BY as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

/**
 * The raw form values, exactly as the inputs hold them (strings). Numbers are
 * validated on the way out, so a half-typed value never throws.
 */
export interface JobSearchForm {
  keywords: string;
  where: string;
  country: string;
  distanceKm: string;
  maxDaysOld: string;
  sortBy: string;
}

export const EMPTY_JOB_SEARCH_FORM: JobSearchForm = {
  keywords: '',
  where: '',
  country: '',
  distanceKm: '',
  maxDaysOld: '',
  sortBy: '',
};

/** A fresh form (used by the Clear/reset action). */
export function resetJobSearchForm(): JobSearchForm {
  return { ...EMPTY_JOB_SEARCH_FORM };
}

export type JobSearchField =
  | 'keywords'
  | 'where'
  | 'country'
  | 'distanceKm'
  | 'maxDaysOld'
  | 'sortBy';

export interface JobSearchIssue {
  field: JobSearchField;
  /** Fixed, user-facing message. No value is ever echoed back. */
  message: string;
}

const ISSUE_FIELD_BY_PATH: Readonly<Record<string, JobSearchField>> = {
  country: 'country',
  keywords: 'keywords',
  where: 'where',
  distanceKm: 'distanceKm',
  maxDaysOld: 'maxDaysOld',
  sortBy: 'sortBy',
};

/** A blank string means "not provided"; otherwise a whole, non-negative number. */
function readWholeNumber(raw: string): { ok: true; value: number | undefined } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  return { ok: true, value: Number(trimmed) };
}

/**
 * Friendly per-field validation, mirroring the Prompt 27 schema's bounds so the
 * two can never disagree (the schema is still run afterwards as the authority).
 * Only fields that would change the request are checked; a search radius without
 * a location is ignored rather than refused (it has no meaning without `where`).
 */
export function validateJobSearchForm(form: JobSearchForm): JobSearchIssue[] {
  const issues: JobSearchIssue[] = [];

  const keywords = form.keywords.trim();
  if (keywords.length === 0) {
    issues.push({ field: 'keywords', message: 'Enter a keyword or job title.' });
  } else if (keywords.length > MAX_KEYWORDS_CHARS) {
    issues.push({
      field: 'keywords',
      message: `Keywords must be ${MAX_KEYWORDS_CHARS} characters or fewer.`,
    });
  }

  const where = form.where.trim();
  if (where.length > MAX_LOCATION_CHARS) {
    issues.push({
      field: 'where',
      message: `Location must be ${MAX_LOCATION_CHARS} characters or fewer.`,
    });
  }

  const country = form.country.trim();
  if (country.length === 0) {
    issues.push({ field: 'country', message: 'Choose a country to search.' });
  } else if (!isSupportedCountry(country)) {
    issues.push({
      field: 'country',
      message: 'That country is not supported by the job search service.',
    });
  }

  if (where.length > 0) {
    const distance = readWholeNumber(form.distanceKm);
    if (!distance.ok) {
      issues.push({
        field: 'distanceKm',
        message: 'Search radius must be a whole number of kilometres.',
      });
    } else if (
      distance.value !== undefined &&
      (distance.value < MIN_DISTANCE_KM || distance.value > MAX_DISTANCE_KM)
    ) {
      issues.push({
        field: 'distanceKm',
        message: `Search radius must be between ${MIN_DISTANCE_KM} and ${MAX_DISTANCE_KM} km.`,
      });
    }
  }

  const maxDays = readWholeNumber(form.maxDaysOld);
  if (!maxDays.ok) {
    issues.push({
      field: 'maxDaysOld',
      message: 'Posted within must be a whole number of days.',
    });
  } else if (
    maxDays.value !== undefined &&
    (maxDays.value < MIN_AGE_DAYS || maxDays.value > MAX_AGE_DAYS)
  ) {
    issues.push({
      field: 'maxDaysOld',
      message: `Posted within must be between ${MIN_AGE_DAYS} and ${MAX_AGE_DAYS} days.`,
    });
  }

  const sortBy = form.sortBy.trim();
  if (sortBy.length > 0 && !isSupportedSort(sortBy)) {
    issues.push({ field: 'sortBy', message: 'That sort order is not supported.' });
  }

  return issues;
}

export type JobSearchBuildResult =
  | { ok: true; request: AdzunaSearchRequest }
  | { ok: false; issues: JobSearchIssue[] };

/**
 * Form → validated provider request.
 *
 * `page` is always 1 (a first page of discovery results); pagination is not
 * exposed in this prompt. Fields the user left blank are ABSENT from the request
 * rather than sent empty, so the provider applies its own documented defaults.
 */
export function buildJobSearchRequest(form: JobSearchForm): JobSearchBuildResult {
  const issues = validateJobSearchForm(form);
  if (issues.length > 0) return { ok: false, issues };

  const where = form.where.trim();
  const candidate: Record<string, unknown> = {
    country: form.country.trim(),
    keywords: form.keywords.trim(),
  };

  if (where.length > 0) {
    candidate['where'] = where;
    const distance = readWholeNumber(form.distanceKm);
    // Only meaningful relative to `where`; ignored when there is no location.
    if (distance.ok && distance.value !== undefined) candidate['distanceKm'] = distance.value;
  }

  const maxDays = readWholeNumber(form.maxDaysOld);
  if (maxDays.ok && maxDays.value !== undefined) candidate['maxDaysOld'] = maxDays.value;

  const sortBy = form.sortBy.trim();
  if (sortBy.length > 0) candidate['sortBy'] = sortBy;

  // The authority: Prompt 27's strict schema. Should a friendly check above ever
  // drift from the schema, the schema still refuses the request.
  const parsed: SearchValidation<AdzunaSearchRequest> = validateAdzunaSearchRequest(candidate);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => {
        const path = issue.split(':')[0] ?? '';
        return {
          field: ISSUE_FIELD_BY_PATH[path] ?? 'keywords',
          message: 'That search value is not supported.',
        };
      }),
    };
  }
  return { ok: true, request: parsed.value };
}

/* ------------------------------------------------------------------ */
/* View state                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every state the results area can be in.
 *
 * `unavailable` (no configured provider) and `error` (a request that failed) are
 * DELIBERATELY distinct from `results` with an empty page: only a validated
 * provider response can produce `results`, so a failure can never be rendered as
 * "no jobs found".
 */
export type JobSearchViewState =
  /** Nothing searched yet. */
  | { kind: 'initial' }
  /** No secure provider is configured/enabled — no request was made. */
  | { kind: 'unavailable'; reason: JobSearchUnavailableReason; message: string }
  /** The form did not validate; no request was made. */
  | { kind: 'invalid'; issues: JobSearchIssue[] }
  /** A request is in flight (only reachable with a configured provider). */
  | { kind: 'loading' }
  /** A validated, normalized page — `results.page.results` may be empty. */
  | { kind: 'results'; page: NormalizedSearchResults }
  /** A typed failure. Never a successful empty page. */
  | { kind: 'error'; error: JobSearchError; message: string };

/**
 * The state shown before anything is searched: `unavailable` while no provider
 * can run, otherwise the plain initial state.
 */
export function initialJobSearchState(config: unknown = EXTENSION_JOB_SEARCH_CONFIG): JobSearchViewState {
  const availability = describeJobSearchAvailability(config);
  if (!availability.available) {
    return { kind: 'unavailable', reason: availability.reason, message: availability.message };
  }
  return { kind: 'initial' };
}

/** Map a completed orchestration result onto a view state. */
export function searchStateFromRunResult(result: {
  kind: 'ok' | 'error';
  error?: JobSearchError;
  results?: NormalizedSearchResults;
}): JobSearchViewState {
  if (result.kind === 'ok' && result.results !== undefined) {
    return { kind: 'results', page: result.results };
  }
  const error = result.error ?? { kind: 'network' as const };
  if (error.kind === 'not-configured') {
    return { kind: 'unavailable', reason: error.reason, message: error.message };
  }
  return { kind: 'error', error, message: messageForSearchError(error) };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ExecuteJobSearchInput {
  form: JobSearchForm;
  /** Untrusted configuration (validated by the service). Defaults to our constant. */
  config?: unknown;
  /** The transport. NEVER called while search is unavailable. */
  provider: JobSearchProvider<AdzunaSearchRequest>;
  /** The provider's validation/normalization adapter. Defaults to Adzuna's. */
  adapter?: JobSearchAdapter<AdzunaSearchRequest>;
  timeoutMs?: number;
}

/**
 * Run one search from the form.
 *
 * Order matters: availability is checked FIRST, so with no configured provider
 * this returns `unavailable` and the transport is never invoked (zero network
 * requests). Only then is the form validated, then executed through Prompt 27's
 * `runJobSearch()`.
 */
export async function executeJobSearch(input: ExecuteJobSearchInput): Promise<JobSearchViewState> {
  const config = input.config ?? EXTENSION_JOB_SEARCH_CONFIG;
  const availability = describeJobSearchAvailability(config);
  if (!availability.available) {
    return { kind: 'unavailable', reason: availability.reason, message: availability.message };
  }

  const built = buildJobSearchRequest(input.form);
  if (!built.ok) return { kind: 'invalid', issues: built.issues };

  const result = await runJobSearch({
    config,
    request: built.request,
    provider: input.provider,
    adapter: input.adapter ?? createAdzunaAdapter(),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });

  return result.kind === 'ok'
    ? { kind: 'results', page: result.results }
    : searchStateFromRunResult({ kind: 'error', error: result.error });
}
