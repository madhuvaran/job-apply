/**
 * Result contract for the freshness-aware job prioritization (Prompt 24).
 *
 * Every object is `.strict()` and every human-facing string is length-bounded,
 * so a result can never smuggle page content, notes or personal data through a
 * loose field. Labels and reasons are built from OUR OWN values (dates, scores,
 * thresholds, fixed status labels) — never from a job description or a note.
 *
 * The match estimate and the freshness signal are reported as SEPARATE blocks.
 * There is deliberately NO combined numeric score anywhere in this contract:
 * prioritization is a review order, not a probability of success.
 *
 * Dates and URLs REUSE the existing domain schemas (`postingDateSchema`,
 * `applicationDateSchema`, `postingUrlSchema`) instead of re-parsing them, so a
 * result can never carry an impossible calendar date or a non-http(s) link.
 *
 * Pure module: no DOM, no network, no storage, no clock, no AI.
 */
import { z } from 'zod';
import { APPLICATION_STATUSES, applicationDateSchema } from '../applications/schemas';
import { postingDateSchema } from '../job-dates';
import { postingUrlSchema } from '../job-posting';
import {
  DUPLICATE_METHODS,
  MAX_DUPLICATE_MATCHES,
  MAX_IDENTITY_CHARS,
  SAVED_DUPLICATE_STATUSES,
} from '../job-duplicates/schemas';

/**
 * Result contract version. Bumped to `2` by Prompt 30: every entry now carries
 * a required `duplicate` block (the saved-vs-saved indication). Nothing is
 * persisted, so no migration exists or is needed — a result is only ever
 * produced and consumed in memory by this module's current code.
 */
export const PRIORITY_SCHEMA_VERSION = '2';

/** Documented, conservative freshness window (calendar days). */
export const FRESHNESS_WINDOW_DAYS = 7;

/** Hard cap on the jobs one prioritization result may carry. */
export const MAX_PRIORITY_JOBS = 1000;

/**
 * The four prioritized categories. ORDER IS SIGNIFICANT: it is the precedence
 * used by the classifier (first match wins) and the display order in the UI.
 */
export const PRIORITY_CATEGORIES = [
  'apply-first',
  'good-match',
  'needs-review',
  'already-applied',
] as const;
export type PriorityCategory = (typeof PRIORITY_CATEGORIES)[number];

export interface PriorityCategoryMeta {
  label: string;
  description: string;
}

/** Fixed, user-facing labels + descriptions (no data, no promises). */
export const PRIORITY_CATEGORY_META: Readonly<Record<PriorityCategory, PriorityCategoryMeta>> = {
  'apply-first': {
    label: 'Apply first',
    description:
      'A valid match estimate meets your minimum, this posting has a known recent date, and no submitted application is recorded.',
  },
  'good-match': {
    label: 'Good match',
    description:
      'The match estimate meets your minimum, but a freshness condition is missing (unknown or older posting date).',
  },
  'needs-review': {
    label: 'Needs review',
    description:
      'Not enough usable information to prioritize: an unusable or below-minimum match estimate, a future posting date, or data that could not be read.',
  },
  'already-applied': {
    label: 'Already applied',
    description: 'An application record for this saved job shows a submission or a closed outcome.',
  },
};

export type PriorityMatchState =
  | 'score'
  | 'insufficient-data'
  | 'unavailable'
  | 'invalid'
  /** The supplied result contradicts the current threshold/settings (fail closed). */
  | 'threshold-mismatch'
  /** More than one match result was supplied for the same job id (fail closed). */
  | 'duplicate-input';

/** Explicit match information — never a manufactured score. */
export const priorityMatchInfoSchema = z
  .object({
    state: z.enum([
      'score',
      'insufficient-data',
      'unavailable',
      'invalid',
      'threshold-mismatch',
      'duplicate-input',
    ]),
    /** 0–100 only for `score`; null in every other state. */
    score: z.number().int().min(0).max(100).nullable(),
    /** The minimum the estimate was compared against; null when unavailable. */
    threshold: z.number().int().min(0).max(100).nullable(),
    /** False when the configured minimum is 0 (threshold filtering off). */
    filtering: z.boolean(),
    /** null when no comparison could be made (unavailable/invalid/disabled-less). */
    meetsThreshold: z.boolean().nullable(),
    confidenceLevel: z.enum(['low', 'medium', 'high']).nullable(),
    label: z.string().min(1).max(200),
  })
  .strict();
export type PriorityMatchInfo = z.infer<typeof priorityMatchInfoSchema>;

/** Posting-date/freshness information, kept separate from the match signal. */
export const priorityFreshnessSchema = z
  .object({
    /** Reuses the posting-date schema: a real `YYYY-MM-DD` date, or null. */
    postedDate: postingDateSchema.nullable(),
    /** Calendar-day age; null when the date is unknown OR in the future. */
    ageDays: z.number().int().min(0).nullable(),
    /** True when the stored date is after `today` (never treated as fresh). */
    future: z.boolean(),
    /** True only for a known, non-future date inside the freshness window. */
    withinWindow: z.boolean(),
    windowDays: z.number().int().min(0),
    label: z.string().min(1).max(200),
  })
  .strict();
export type PriorityFreshness = z.infer<typeof priorityFreshnessSchema>;

/**
 * Application status, only when RELIABLY linked (an application record whose
 * `jobId` equals the saved job id). `unavailable` means the application log
 * could not be read — never "not applied".
 */
export const priorityApplicationSchema = z
  .object({
    state: z.enum(['unavailable', 'none', 'planned', 'in-progress', 'completed']),
    status: z.enum(APPLICATION_STATUSES).nullable(),
    statusLabel: z.string().min(1).max(40).nullable(),
    /** Reuses the application-log date schema: a real calendar date, or null. */
    applicationDate: applicationDateSchema.nullable(),
    /** How many records reference this job (repeat applications are allowed). */
    linkedCount: z.number().int().min(0),
    label: z.string().min(1).max(200),
  })
  .strict();
export type PriorityApplicationInfo = z.infer<typeof priorityApplicationSchema>;

/**
 * Duplicate information for one saved job (Prompt 30). It reuses the
 * duplicate detector's OWN saved-vs-saved indication (same three documented
 * rules, same status vocabulary) and adds a fixed, human-readable label.
 *
 * This is an INDICATION only: the job remains its own record, keeps its
 * category and is never merged, hidden or deleted. `equivalentJobIds` carries
 * saved job ids only (never titles, companies or text).
 */
export const priorityDuplicateSchema = z
  .object({
    status: z.enum(SAVED_DUPLICATE_STATUSES),
    method: z.enum(DUPLICATE_METHODS).nullable(),
    equivalentJobIds: z
      .array(z.string().min(1).max(MAX_IDENTITY_CHARS))
      .max(MAX_DUPLICATE_MATCHES),
    /** Fixed label built from our own counts — never from page content. */
    label: z.string().min(1).max(200),
  })
  .strict();
export type PriorityDuplicateInfo = z.infer<typeof priorityDuplicateSchema>;

/** One prioritized saved job. */
export const priorityEntrySchema = z
  .object({
    jobId: z.string().min(1).max(200),
    category: z.enum(PRIORITY_CATEGORIES),
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200).nullable(),
    /** Re-validated http(s) URL (the existing posting URL schema), or null. */
    originalUrl: postingUrlSchema.nullable(),
    match: priorityMatchInfoSchema,
    freshness: priorityFreshnessSchema,
    application: priorityApplicationSchema,
    /** Saved-vs-saved equivalence indication (Prompt 30). */
    duplicate: priorityDuplicateSchema,
    /** Human-readable, privacy-safe reasons for this classification. */
    reasons: z.array(z.string().min(1).max(300)).min(1).max(6),
  })
  .strict();
export type PriorityEntry = z.infer<typeof priorityEntrySchema>;

/** One category with its deterministically ordered jobs. */
export const priorityGroupSchema = z
  .object({
    category: z.enum(PRIORITY_CATEGORIES),
    label: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    count: z.number().int().min(0),
    jobs: z.array(priorityEntrySchema).max(MAX_PRIORITY_JOBS),
  })
  .strict();
export type PriorityGroup = z.infer<typeof priorityGroupSchema>;

/** The full result. Always contains exactly the four categories, in order. */
export const prioritizationResultSchema = z
  .object({
    schemaVersion: z.literal(PRIORITY_SCHEMA_VERSION),
    /** The explicit calendar date the age calculation used (real `YYYY-MM-DD`). */
    today: postingDateSchema,
    freshnessWindowDays: z.number().int().min(0),
    threshold: z
      .object({
        /** null when settings were unavailable (no comparison possible). */
        configured: z.number().int().min(0).max(100).nullable(),
        filtering: z.boolean(),
      })
      .strict(),
    groups: z.array(priorityGroupSchema).length(PRIORITY_CATEGORIES.length),
    totalJobs: z.number().int().min(0),
    /** Records that failed validation and were therefore never classified. */
    skippedJobs: z.number().int().min(0),
    /** Fail-closed explanations (fixed literals; no job or page content). */
    notes: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
export type PrioritizationResult = z.infer<typeof prioritizationResultSchema>;

export type PrioritizationOutcome =
  | { kind: 'valid'; result: PrioritizationResult }
  | { kind: 'invalid'; issues: string[] };

export type PrioritizationValidation =
  | { ok: true; result: PrioritizationResult }
  | { ok: false; issues: string[] };

/** Validate an untrusted object against the strict result schema. */
export function validatePrioritizationResult(payload: unknown): PrioritizationValidation {
  const parsed = prioritizationResultSchema.safeParse(payload);
  if (parsed.success) return { ok: true, result: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.code}`),
  };
}
