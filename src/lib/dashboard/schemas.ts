/**
 * Result contract for the local dashboard overview (Prompt 30).
 *
 * The dashboard is a READ-ONLY projection of data the extension already stores
 * locally: saved job postings, the application log, the existing deterministic
 * match estimates and the pure prioritization result. It computes NO new score,
 * makes NO network/AI call, reads NO page content and persists nothing.
 *
 * Every object is `.strict()` and every human-facing string is bounded, so a
 * snapshot can never smuggle page text, notes, profile details or personal data
 * through a loose field. Labels come from OUR OWN values (counts, fixed
 * status/category/confidence labels, validated dates), never from a saved
 * description.
 *
 * MISSING DATA IS NEVER ZERO: a metric is either an explicit integer `value` or
 * `unavailable` with a fixed reason. A failed or malformed storage read can
 * therefore never render as a believable "0 applications".
 *
 * Dates and URLs REUSE the existing domain schemas (`postingDateSchema`,
 * `postingUrlSchema`), so a snapshot cannot carry an impossible calendar date or
 * a non-http(s) link.
 *
 * Pure module: no DOM, no network, no storage, no clock, no AI.
 */
import { z } from 'zod';
import { postingDateSchema } from '../job-dates';
import { postingUrlSchema } from '../job-posting';
import { SAVED_DUPLICATE_STATUSES } from '../job-duplicates/schemas';
import { PRIORITY_CATEGORIES, PRIORITY_CATEGORY_META } from '../prioritization/schemas';

/**
 * Bumped only when this in-memory contract changes shape. Nothing is persisted,
 * so there is no migration: the snapshot is produced and rendered in one pass.
 */
export const DASHBOARD_SCHEMA_VERSION = '1';

/**
 * Documented cap on the dashboard shortlist. The full, uncapped review order
 * stays available in Options → Jobs → Priority shortlist; the dashboard shows
 * the first N actionable jobs of the SAME deterministic order and states how
 * many more there are.
 */
export const DASHBOARD_SHORTLIST_LIMIT = 12;

/** Fixed metric keys, in display order. */
export const DASHBOARD_METRIC_KEYS = [
  'savedJobs',
  'reviewJobs',
  'applyFirst',
  'goodMatch',
  'submitted',
  'interviews',
  'offers',
  'upcomingFollowUps',
] as const;
export type DashboardMetricKey = (typeof DASHBOARD_METRIC_KEYS)[number];

export interface DashboardMetricMeta {
  label: string;
  /** Short, honest definition shown with the metric (no hidden math). */
  definition: string;
}

/**
 * Metric labels + definitions. Semantics are deliberately narrow and are
 * documented in PROGRESS.md/README.md:
 * - saved jobs = saved postings that validated.
 * - review/apply-first/good-match = the prioritization categories (already
 *   applied jobs are counted separately and are NOT in the shortlist).
 * - submitted = application records whose status is anything but `planned`.
 * - interviews/offers = CURRENT status of an application record (a progression
 *   through statuses is not history-tracked, so this is a snapshot, not a count
 *   of every interview ever held).
 * - upcoming follow-ups = application records with a follow-up date on or after
 *   today whose status is not rejected/withdrawn.
 */
export const DASHBOARD_METRIC_META: Readonly<Record<DashboardMetricKey, DashboardMetricMeta>> = {
  savedJobs: {
    label: 'Saved jobs',
    definition: 'Saved job postings that passed validation.',
  },
  reviewJobs: {
    label: 'Needs review',
    definition: 'Jobs without a usable match estimate, below your minimum, or with a data problem.',
  },
  applyFirst: {
    label: 'Apply first',
    definition: 'Match meets your minimum, posting date is known and recent, and no submitted application exists.',
  },
  goodMatch: {
    label: 'Good match',
    definition: 'Match meets your minimum, but the posting date is unknown or older than the freshness window.',
  },
  submitted: {
    label: 'Applications submitted',
    definition: 'Application records with a status other than Planned.',
  },
  interviews: {
    label: 'Interviews',
    definition: 'Applications whose current status is Interview.',
  },
  offers: {
    label: 'Offers',
    definition: 'Applications whose current status is Offer.',
  },
  upcomingFollowUps: {
    label: 'Upcoming follow-ups',
    definition: 'Applications with a follow-up date today or later, excluding rejected and withdrawn records.',
  },
};

/** Fixed reasons a metric/shortlist can be unavailable (never shown as 0). */
export const DASHBOARD_UNAVAILABLE_REASONS = [
  'jobs-unreadable',
  'applications-unreadable',
  'prioritization-unavailable',
] as const;
export type DashboardUnavailableReason = (typeof DASHBOARD_UNAVAILABLE_REASONS)[number];

/** Fixed, user-facing explanations for an unavailable metric. */
export const DASHBOARD_UNAVAILABLE_MESSAGES: Readonly<Record<DashboardUnavailableReason, string>> = {
  'jobs-unreadable':
    'Unavailable — saved jobs could not be read. Nothing was changed; open Jobs to inspect the stored data.',
  'applications-unreadable':
    'Unavailable — the application log could not be read. Nothing was changed; open Applications to inspect it.',
  'prioritization-unavailable':
    'Unavailable — prioritization could not be computed from the current data.',
};

/** One metric: an explicit integer, or an explicit unavailability (never 0). */
export const dashboardMetricSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.number().int().min(0) }).strict(),
  z
    .object({ kind: z.literal('unavailable'), reason: z.enum(DASHBOARD_UNAVAILABLE_REASONS) })
    .strict(),
]);
export type DashboardMetric = z.infer<typeof dashboardMetricSchema>;

export const dashboardMetricsSchema = z
  .object({
    savedJobs: dashboardMetricSchema,
    reviewJobs: dashboardMetricSchema,
    applyFirst: dashboardMetricSchema,
    goodMatch: dashboardMetricSchema,
    submitted: dashboardMetricSchema,
    interviews: dashboardMetricSchema,
    offers: dashboardMetricSchema,
    upcomingFollowUps: dashboardMetricSchema,
  })
  .strict();
export type DashboardMetrics = z.infer<typeof dashboardMetricsSchema>;

/**
 * One shortlist row. It carries only what the dashboard must DISPLAY, projected
 * from the prioritization entry (+ the saved posting's own location), so the
 * component never re-derives a classification or a score.
 */
export const dashboardShortlistRowSchema = z
  .object({
    jobId: z.string().min(1).max(200),
    category: z.enum(PRIORITY_CATEGORIES),
    categoryLabel: z.string().min(1).max(60),
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200).nullable(),
    location: z.string().min(1).max(200).nullable(),
    /** The stored posting date, or null when unknown (never the import time). */
    postedDate: postingDateSchema.nullable(),
    freshnessLabel: z.string().min(1).max(200),
    matchLabel: z.string().min(1).max(200),
    matchState: z.enum([
      'score',
      'insufficient-data',
      'unavailable',
      'invalid',
      'threshold-mismatch',
      'duplicate-input',
    ]),
    /** Fixed confidence label, or null when no estimate is assessable. */
    confidenceLabel: z.enum(['Low', 'Medium', 'High']).nullable(),
    applicationLabel: z.string().min(1).max(200),
    /** Fixed, privacy-safe reasons (same text the priority shortlist shows). */
    reasons: z.array(z.string().min(1).max(300)).min(1).max(6),
    /** Re-validated http(s) URL, or null. */
    originalUrl: postingUrlSchema.nullable(),
    /** Null when no equivalent saved posting was detected. */
    duplicateLabel: z.string().min(1).max(200).nullable(),
    duplicateStatus: z.enum(SAVED_DUPLICATE_STATUSES),
  })
  .strict();
export type DashboardShortlistRow = z.infer<typeof dashboardShortlistRowSchema>;

/**
 * The prioritized shortlist block. `available: false` means the jobs could not
 * be read or prioritized — it is never an empty list that looks like "nothing
 * to do".
 */
export const dashboardShortlistSchema = z
  .object({
    available: z.boolean(),
    reason: z.enum(DASHBOARD_UNAVAILABLE_REASONS).nullable(),
    rows: z.array(dashboardShortlistRowSchema).max(DASHBOARD_SHORTLIST_LIMIT),
    /** Actionable jobs in total (apply first + good match + needs review). */
    actionableCount: z.number().int().min(0),
    /** Already-applied jobs, deliberately kept OUT of the actionable shortlist. */
    alreadyAppliedCount: z.number().int().min(0),
    /** True when the deterministic order continues beyond `rows`. */
    truncated: z.boolean(),
  })
  .strict();
export type DashboardShortlist = z.infer<typeof dashboardShortlistSchema>;

export const dashboardSnapshotSchema = z
  .object({
    schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION),
    /** The explicit calendar date the snapshot was computed for (never a clock read). */
    today: postingDateSchema,
    metrics: dashboardMetricsSchema,
    shortlist: dashboardShortlistSchema,
    /** Fail-closed explanations (fixed literals; no job, page or profile content). */
    notes: z.array(z.string().min(1).max(300)).max(12),
  })
  .strict();
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;

/** Every category label used by a row comes from the ONE shared source. */
export function categoryLabelFor(category: (typeof PRIORITY_CATEGORIES)[number]): string {
  return PRIORITY_CATEGORY_META[category].label;
}
