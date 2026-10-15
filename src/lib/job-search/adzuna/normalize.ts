/**
 * Adzuna response normalization (Prompt 27) — pure and deterministic.
 *
 * Turns a RAW Adzuna job-search payload into the strict normalized page defined
 * in `../schemas.ts`. Derived from the official documentation read on
 * 2026-10-14 (docs/adzuna-integration.md lists the sources):
 *
 * - top level: `results` (array — the only required property), `count` (total
 *   adverts found), `mean`, `__CLASS__`;
 * - per job, REQUIRED: `id`, `title`, `description`, `created`. Everything else
 *   (`redirect_url`, `company`, `location`, `salary_min`, `salary_max`,
 *   `salary_is_predicted`, `contract_time`, `contract_type`, `category`,
 *   `adref`, `latitude`, `longitude`) is documented but not guaranteed;
 * - `description` is "truncated to 500 characters" — the docs call it a snippet;
 * - `created` is "the date the advertisement was placed, as an ISO 8601 date
 *   time string";
 * - salary amounts are "given in the local currency" and `salary_is_predicted`
 *   marks a Jobsworth ESTIMATE rather than an advertised figure.
 *
 * Rules honored:
 * - NEVER FABRICATE. A missing optional field stays ABSENT; a malformed one is
 *   dropped, not repaired. No placeholder text, no zero salary, no invented
 *   currency, no capture-time date substitute.
 * - NEVER LOSE A JOB QUIETLY. A record that cannot be used is counted in
 *   `skipped` with a FIXED reason literal; job content never appears in a reason.
 * - A JOB WITHOUT A USABLE LINK IS SKIPPED (`no-usable-listing-url`): every
 *   displayed Adzuna listing must link to the advertiser through `redirect_url`
 *   — Adzuna's own specification says using it is necessary to comply with their
 *   terms — and that link is also the save/apply target.
 * - RAW PROVIDER KEYS NEVER SURVIVE: `__CLASS__`, `adref` and the coordinates
 *   are not copied anywhere; strict parsing of the final page would reject them.
 *
 * Pure module: no DOM, no browser API, no storage, no network, no AI. The one
 * timestamp it records (`searchedAt`) comes from an INJECTED clock.
 */
import { z } from 'zod';
import { extractIsoCalendarDate } from '../../job-dates';
import {
  MAX_EXTERNAL_ID_CHARS,
  MAX_TEXT_FIELD_CHARS,
  MAX_TITLE_CHARS,
  postingUrlSchema,
} from '../../job-posting';
import {
  JOB_SEARCH_SCHEMA_VERSION,
  MAX_DESCRIPTION_SNIPPET_CHARS,
  MAX_SALARY_AMOUNT,
  MAX_SEARCH_RESULTS,
  MAX_SKIP_REASON_CHARS,
  normalizedSearchResultsSchema,
  type NormalizedJobResult,
  type NormalizedSearchResults,
  type SearchValidation,
} from '../schemas';
import { ADZUNA_ATTRIBUTION, ADZUNA_PROVIDER_ID, type AdzunaSearchRequest } from './schemas';

/* ------------------------------------------------------------------ */
/* Fixed skip reasons (never carry job or payload content)             */
/* ------------------------------------------------------------------ */

export const ADZUNA_SKIP_REASONS = {
  /** The array entry was not an object at all. */
  notARecord: 'record was not an object',
  /** Required `id` missing, blank or not a string. */
  missingId: 'record had no usable id',
  /** Required `title` missing, blank or not a string. */
  missingTitle: 'record had no usable title',
  /** No usable http(s) `redirect_url` — cannot be displayed or linked. */
  missingUrl: 'record had no usable listing URL',
  /** Valid record beyond this extension's per-page cap. */
  pageLimit: 'record was beyond this page limit',
} as const;

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

/**
 * The smallest shape we require of the provider payload. `results` must be an
 * array; `count` is read only when it is a non-negative integer. Unknown
 * top-level keys (including `__CLASS__` and `mean`) are stripped here and never
 * reach a result.
 */
const envelopeSchema = z.object({
  results: z.array(z.unknown()),
  count: z.number().int().min(0).optional(),
});

/* ------------------------------------------------------------------ */
/* Per-field readers (one bad field must not discard the whole job)    */
/* ------------------------------------------------------------------ */

/** A trimmed, non-empty, length-capped string, or `undefined`. */
function readText(value: unknown, max: number): string | undefined {
  const parsed = z.string().trim().min(1).max(max).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A finite, in-range, non-negative money amount, or `undefined`. */
function readAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_SALARY_AMOUNT) return undefined;
  return value;
}

/**
 * `salary_is_predicted` → boolean. The documented values are `0`/`1`; Adzuna
 * transmits this field as either a number or the string `"0"`/`"1"` depending
 * on the endpoint, so both spellings (and a boolean) are read. Anything else
 * yields `null`, meaning "the provider did not state it" — never `false`,
 * because that would assert the salary was advertised rather than predicted.
 */
function readPredicted(value: unknown): boolean | null {
  if (value === 0 || value === false || value === '0') return false;
  if (value === 1 || value === true || value === '1') return true;
  return null;
}

/** Adzuna `location.display_name`, else its `location.area` joined readably. */
function readLocation(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const location = value as Record<string, unknown>;
  const display = readText(location['display_name'], MAX_TEXT_FIELD_CHARS);
  if (display !== undefined) return display;
  const area = z
    .array(z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS))
    .safeParse(location['area']);
  if (!area.success || area.data.length === 0) return undefined;
  // `area` is documented outermost → innermost, so joining preserves its order.
  return readText(area.data.join(', '), MAX_TEXT_FIELD_CHARS);
}

/** `company.display_name` (the advertiser's own form), never `canonical_name`. */
function readCompany(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return readText((value as Record<string, unknown>)['display_name'], MAX_TEXT_FIELD_CHARS);
}

/**
 * The description snippet. The API already truncates to 500 characters; a
 * longer value is trimmed to the same cap rather than dropped — it is provider
 * text, never composed by us — so the preview cap and the stored cap agree.
 */
function readDescription(value: unknown): string | undefined {
  const raw = readText(value, MAX_DESCRIPTION_SNIPPET_CHARS * 100);
  if (raw === undefined) return undefined;
  const capped = raw.slice(0, MAX_DESCRIPTION_SNIPPET_CHARS).trim();
  return capped.length > 0 ? capped : undefined;
}

/** Salary range, present only when the provider stated at least one bound. */
function readSalary(record: Record<string, unknown>): NormalizedJobResult['salary'] {
  const min = readAmount(record['salary_min']);
  const max = readAmount(record['salary_max']);
  if (min === undefined && max === undefined) return undefined;
  // Normalize the pair so a swapped min/max cannot produce an invalid range.
  const low = min !== undefined && max !== undefined ? Math.min(min, max) : min;
  const high = min !== undefined && max !== undefined ? Math.max(min, max) : max;
  return {
    ...(low !== undefined ? { min: low } : {}),
    ...(high !== undefined ? { max: high } : {}),
    predicted: readPredicted(record['salary_is_predicted']),
  };
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

type RecordOutcome =
  | { kind: 'job'; job: NormalizedJobResult }
  | { kind: 'skipped'; reason: string };

/** One provider record → one normalized job, or a fixed skip reason. */
export function normalizeAdzunaJob(
  raw: unknown,
  country: AdzunaSearchRequest['country'],
): RecordOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'skipped', reason: ADZUNA_SKIP_REASONS.notARecord };
  }
  const record = raw as Record<string, unknown>;

  const externalId = readText(record['id'], MAX_EXTERNAL_ID_CHARS);
  if (externalId === undefined) return { kind: 'skipped', reason: ADZUNA_SKIP_REASONS.missingId };

  const title = readText(record['title'], MAX_TITLE_CHARS);
  if (title === undefined) return { kind: 'skipped', reason: ADZUNA_SKIP_REASONS.missingTitle };

  // The listing URL must be a real http(s) URL; otherwise the advert cannot be
  // shown, linked or saved, so it is skipped rather than shown without a link.
  const urlCheck = postingUrlSchema.safeParse(readText(record['redirect_url'], 2048));
  if (!urlCheck.success) return { kind: 'skipped', reason: ADZUNA_SKIP_REASONS.missingUrl };

  const company = readCompany(record['company']);
  const location = readLocation(record['location']);
  const description = readDescription(record['description']);
  const salary = readSalary(record);
  const postedDate = extractIsoCalendarDate(record['created']);

  return {
    kind: 'job',
    job: {
      provider: ADZUNA_PROVIDER_ID,
      externalId,
      title,
      ...(company !== undefined ? { company } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(postedDate !== undefined ? { postedDate } : {}),
      url: urlCheck.data,
      ...(description !== undefined ? { description } : {}),
      ...(salary !== undefined ? { salary } : {}),
      country,
    },
  };
}

export interface NormalizeAdzunaOptions {
  /** The validated request these results belong to (country + page). */
  request: AdzunaSearchRequest;
  /** Injected clock; the default is the real one, so tests can inject a fixed value. */
  now?: () => string;
}

/**
 * Raw Adzuna payload → strict normalized page.
 *
 * An unusable ENVELOPE is an error, never an empty page: the caller must be able
 * to tell "the provider returned something we cannot read" apart from "this
 * search genuinely matched nothing". A `results: []` payload is a real empty
 * result and normalizes successfully.
 */
export function normalizeAdzunaSearchResponse(
  raw: unknown,
  options: NormalizeAdzunaOptions,
): SearchValidation<NormalizedSearchResults> {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return {
      ok: false,
      issues: ['(root): response did not contain a results array'],
    };
  }

  const jobs: NormalizedJobResult[] = [];
  const reasons = new Set<string>();
  let skipped = 0;

  for (const entry of envelope.data.results) {
    const outcome = normalizeAdzunaJob(entry, options.request.country);
    if (outcome.kind === 'skipped') {
      skipped += 1;
      reasons.add(outcome.reason);
      continue;
    }
    if (jobs.length >= MAX_SEARCH_RESULTS) {
      // Valid, but past our own page cap: counted and reported, never merged.
      skipped += 1;
      reasons.add(ADZUNA_SKIP_REASONS.pageLimit);
      continue;
    }
    jobs.push(outcome.job);
  }

  const now = options.now ?? (() => new Date().toISOString());
  const candidate = {
    schemaVersion: JOB_SEARCH_SCHEMA_VERSION,
    provider: ADZUNA_PROVIDER_ID,
    page: options.request.page,
    ...(envelope.data.count !== undefined ? { totalCount: envelope.data.count } : {}),
    results: jobs,
    skipped,
    skippedReasons: [...reasons]
      .slice(0, 8)
      .map((reason) => reason.slice(0, MAX_SKIP_REASON_CHARS)),
    attribution: ADZUNA_ATTRIBUTION,
    searchedAt: now(),
  };

  const parsed = normalizedSearchResultsSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Only reachable if the clock supplied a non-ISO value: reported, never guessed.
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.code}`,
    ),
  };
}
