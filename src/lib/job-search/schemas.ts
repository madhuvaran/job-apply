/**
 * Provider-agnostic job-discovery contracts (Prompt 27).
 *
 * This module defines ONLY the normalized shapes a future search UI may render
 * and the limits every provider result is held to. It is deliberately
 * independent of any one job board: the Adzuna specifics live in
 * `src/lib/job-search/adzuna/`.
 *
 * Design rules (knowledge.md):
 * - OPTIONAL MEANS ABSENT, NEVER INVENTED. Every field a provider may omit is
 *   `.optional()`; a missing value is left out instead of being defaulted,
 *   guessed or back-filled from the capture time. There is no "unknown" string
 *   placeholder that could be mistaken for real data.
 * - NO RAW PROVIDER PAYLOAD IN THE RESULT. `__CLASS__`, coordinates, adref and
 *   every other provider-only key are dropped by strict parsing, so provider
 *   JSON can never reach the UI or persisted storage through this contract.
 * - REUSE, DO NOT DUPLICATE: the listing URL is validated with the existing
 *   `postingUrlSchema` and the posting date with the existing
 *   `postingDateSchema` (`YYYY-MM-DD` calendar date), so a result is directly
 *   compatible with the job-posting model and the duplicate detector.
 * - BOUNDED EVERYTHING: strings, arrays and numbers are capped, so one
 *   misbehaving provider cannot blow up storage quota or the render.
 *
 * Pure module: no DOM, no browser API, no storage, no network, no AI, and no
 * clock of its own (callers pass the timestamp in).
 */
import { z } from 'zod';
import { postingDateSchema } from '../job-dates';
import { MAX_TEXT_FIELD_CHARS, MAX_TITLE_CHARS, postingUrlSchema } from '../job-posting';

export const JOB_SEARCH_SCHEMA_VERSION = '1';

/* ------------------------------------------------------------------ */
/* Limits (ours, unless a provider limit is named)                     */
/* ------------------------------------------------------------------ */

/**
 * Most results one normalized page may carry. This is OUR policy cap for a
 * single request (bandwidth, quota and render sanity) — it is NOT a documented
 * Adzuna limit. Adzuna's specification sets a minimum of 1 with no published
 * maximum (see docs/adzuna-integration.md).
 */
export const MAX_SEARCH_RESULTS = 50;
/**
 * Results requested when the caller states none. Adzuna's specification states
 * no default `results_per_page`, so this is our own choice (the page size used
 * in Adzuna's documentation examples).
 */
export const DEFAULT_RESULTS_PER_PAGE = 20;
/** Highest page number we will request. Our pagination guard; Adzuna documents only ">= 1". */
export const MAX_SEARCH_PAGES = 100;
/** Longest accepted keyword string. */
export const MAX_KEYWORDS_CHARS = 200;
/** Longest accepted location string. */
export const MAX_LOCATION_CHARS = 120;
/** Longest accepted provider-side job identifier. */
export const MAX_EXTERNAL_ID_CHARS = 100;
/**
 * Longest accepted description snippet. Adzuna documents that the search
 * response carries a description "truncated to 500 characters" and the search
 * docs call it a snippet — we hold results to the same cap so nothing longer
 * silently becomes the stored "raw description".
 */
export const MAX_DESCRIPTION_SNIPPET_CHARS = 500;
/** Longest accepted value inside `skippedReasons` (fixed literal). */
export const MAX_SKIP_REASON_CHARS = 120;
/** Highest accepted age filter, in days (our policy bound). */
export const MAX_AGE_DAYS = 365;
/** Lowest accepted age filter, in days. */
export const MIN_AGE_DAYS = 1;
/** Highest accepted search radius, in kilometres (our policy bound; Adzuna default 5km). */
export const MAX_DISTANCE_KM = 500;
/** Lowest accepted search radius, in kilometres. */
export const MIN_DISTANCE_KM = 1;
/** Sanity bound for a salary amount. Providers return local-currency amounts. */
export const MAX_SALARY_AMOUNT = 100_000_000;

/* ------------------------------------------------------------------ */
/* Provider identity                                                   */
/* ------------------------------------------------------------------ */

/** Providers this build knows how to normalize. Growth is additive. */
export const JOB_SEARCH_PROVIDERS = ['adzuna'] as const;
export type JobSearchProviderId = (typeof JOB_SEARCH_PROVIDERS)[number];

/* ------------------------------------------------------------------ */
/* Normalized job result                                               */
/* ------------------------------------------------------------------ */

/**
 * A salary range as the provider stated it.
 *
 * `currency` is deliberately ABSENT: Adzuna returns amounts "given in the local
 * currency" of the country searched and never states which currency, and the
 * extension must not guess one. A future prompt may attach a currency once a
 * documented source exists.
 */
export const salaryRangeSchema = z
  .object({
    min: z.number().min(0).max(MAX_SALARY_AMOUNT).optional(),
    max: z.number().min(0).max(MAX_SALARY_AMOUNT).optional(),
    /**
     * True when the provider labelled the amount as PREDICTED rather than
     * advertised (Adzuna: "Jobsworth"). `null` when the provider did not state
     * it — never assumed, because a predicted figure must not be presented as
     * an advertised one.
     */
    predicted: z.boolean().nullable(),
  })
  .strict()
  .refine((s) => s.min !== undefined || s.max !== undefined, {
    message: 'a salary range needs at least one of min / max',
  })
  .refine((s) => s.min === undefined || s.max === undefined || s.min <= s.max, {
    message: 'min must be <= max',
  });
export type SalaryRange = z.infer<typeof salaryRangeSchema>;

/**
 * The single normalized job result shape future UI, duplicate detection,
 * match estimation and the job-posting model consume.
 *
 * Field-by-field compatibility (asserted by tests, no coupling added):
 * - `title` / `company` / `location` → `jobPostingSchema` text fields;
 * - `url` → `jobPostingSchema.originalUrl` (same `postingUrlSchema`);
 * - `postedDate` → `jobPostingSchema.postedDate` (same `postingDateSchema`);
 * - `title` / `company` / `url` / `externalId` → `duplicateCandidateSchema`
 *   (the source-published identifier the duplicate detector compares per host).
 *
 * `url` is REQUIRED and is always the provider's link to the advert on the
 * advertiser's site: every displayed listing must link out through it, and a
 * result without a usable link is dropped by the normalizer rather than shown
 * (see `adzuna/normalize.ts`).
 */
export const normalizedJobResultSchema = z
  .object({
    /** Which provider produced this result (never user input). */
    provider: z.enum(JOB_SEARCH_PROVIDERS),
    /** The identifier the PROVIDER published. Never derived or guessed. */
    externalId: z.string().trim().min(1).max(MAX_EXTERNAL_ID_CHARS),
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
    company: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    location: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    /** Published date as a real `YYYY-MM-DD` calendar date, when stated. */
    postedDate: postingDateSchema.optional(),
    /** Link to the advert on the advertiser's site (http/https). */
    url: postingUrlSchema,
    /** Provider snippet, capped; absent when the provider returned none. */
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_SNIPPET_CHARS).optional(),
    salary: salaryRangeSchema.optional(),
    /** Lowercase country code the search ran under (2 letters). */
    country: z.string().regex(/^[a-z]{2}$/, 'expected a 2-letter lowercase country code'),
  })
  .strict();
export type NormalizedJobResult = z.infer<typeof normalizedJobResultSchema>;

/* ------------------------------------------------------------------ */
/* Attribution                                                         */
/* ------------------------------------------------------------------ */

/**
 * The attribution a provider requires whenever its listings are displayed.
 * Carried INSIDE the normalized result so a future search UI cannot render
 * results without having the required credit to hand.
 */
export const attributionSchema = z
  .object({
    /** Text that must be shown (e.g. the provider wordmark text). */
    text: z.string().trim().min(1).max(80),
    /** Where the text must link. */
    url: postingUrlSchema,
    /** Minimum rendered width in CSS pixels, when the provider states one. */
    minWidthPx: z.number().int().min(1).max(1000).optional(),
    /** Minimum rendered height in CSS pixels, when the provider states one. */
    minHeightPx: z.number().int().min(1).max(1000).optional(),
    /** Fixed, human-readable statement of the requirement. No provider content. */
    notice: z.string().trim().min(1).max(300),
  })
  .strict();
export type Attribution = z.infer<typeof attributionSchema>;

/* ------------------------------------------------------------------ */
/* Normalized search page                                              */
/* ------------------------------------------------------------------ */

export const normalizedSearchResultsSchema = z
  .object({
    schemaVersion: z.literal(JOB_SEARCH_SCHEMA_VERSION),
    provider: z.enum(JOB_SEARCH_PROVIDERS),
    /** Page these results came from (1-based). */
    page: z.number().int().min(1).max(MAX_SEARCH_PAGES),
    /**
     * Total adverts the provider reported, when it reported one. This can be
     * far larger than `results.length`; it is never presented as a count of
     * fetched jobs.
     */
    totalCount: z.number().int().min(0).optional(),
    results: z.array(normalizedJobResultSchema).max(MAX_SEARCH_RESULTS),
    /** How many provider records were returned but could NOT be used. */
    skipped: z.number().int().min(0),
    /** Fixed, deduplicated reasons why records were skipped (never content). */
    skippedReasons: z
      .array(z.string().trim().min(1).max(MAX_SKIP_REASON_CHARS))
      .max(8),
    /** Mandatory provider credit for these listings. */
    attribution: attributionSchema,
    /** When the search ran (ISO 8601). Injected clock; never a fake constant. */
    searchedAt: z.iso.datetime(),
  })
  .strict();
export type NormalizedSearchResults = z.infer<typeof normalizedSearchResultsSchema>;

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * `path: message` issue strings. Paths and messages only — zod messages never
 * carry the offending VALUE here because every caller-supplied string in these
 * schemas is described by a fixed message, and unlike the storage service we do
 * not attach the raw input. Deliberately local (a copy of the AI module's
 * helper) so this module does not depend on the AI domain.
 */
export function formatSearchIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string[] {
  return issues.map((iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.message}`);
}

export type SearchValidation<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

/** Validate an untrusted object against the strict normalized-page schema. */
export function validateNormalizedSearchResults(payload: unknown): SearchValidation<NormalizedSearchResults> {
  const parsed = normalizedSearchResultsSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: formatSearchIssues(parsed.error.issues) };
}

/** Validate one untrusted normalized job result. */
export function validateNormalizedJobResult(payload: unknown): SearchValidation<NormalizedJobResult> {
  const parsed = normalizedJobResultSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: formatSearchIssues(parsed.error.issues) };
}
