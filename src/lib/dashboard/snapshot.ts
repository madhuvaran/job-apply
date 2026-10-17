/**
 * Local dashboard snapshot (Prompt 30) — pure, deterministic, no side effects.
 *
 * `buildDashboardSnapshot()` projects data the extension ALREADY stores into the
 * fixed dashboard contract:
 * - saved postings (validated with the existing `jobPostingSchema`),
 * - the application log (validated with the existing `applicationSchema`),
 * - already-computed match estimates handed in by the caller (this module never
 *   scores anything and never imports the matching estimator),
 * - the existing pure prioritization result, reused for the category counts and
 *   the deterministic shortlist order.
 *
 * Boundaries (deliberate):
 * - It reads NO storage, touches NO clock (`today` is passed in), makes NO
 *   network/AI call, uses no random value and never mutates its input.
 * - Nothing is persisted: the snapshot exists in memory for one render.
 * - MISSING DATA IS NEVER ZERO. A jobs record or application log that could not
 *   be read (or validated) makes the affected metrics explicitly `unavailable`;
 *   the rest of the snapshot still renders (partial data availability).
 * - Unreadable records fail CLOSED exactly like the prioritization module: one
 *   invalid application record makes application status unknown everywhere.
 * - The shortlist contains only ACTIONABLE jobs (apply first, good match, needs
 *   review), capped at `DASHBOARD_SHORTLIST_LIMIT`; already-applied jobs are
 *   counted separately and remain available in Options → Jobs. Nothing is
 *   hidden from storage and nothing is deleted.
 */
import { applicationSchema, type Application } from '../applications/schemas';
import { postingDateSchema } from '../job-dates';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { prioritizeJobs, type PrioritizationMatchInput } from '../prioritization';
import {
  categoryLabelFor,
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_SHORTLIST_LIMIT,
  dashboardSnapshotSchema,
  type DashboardMetric,
  type DashboardShortlist,
  type DashboardShortlistRow,
  type DashboardSnapshot,
  type DashboardUnavailableReason,
} from './schemas';

export interface DashboardInput {
  /**
   * Saved posting records, or `null` when the stored list could not be read or
   * validated. Invalid individual records are skipped (counted in the notes).
   */
  jobs: readonly unknown[] | null;
  /** Application-log records, or `null` when the log could not be read. */
  applications: readonly unknown[] | null;
  /** Already-computed match results (empty when none can be computed). */
  matches: readonly PrioritizationMatchInput[];
  /** `settings.minMatchThreshold`; `null` when settings could not be read. */
  minMatchThreshold: number | null;
  /** False when no usable master profile is loaded (no estimate exists). */
  profileAvailable: boolean;
  /** Explicit current local calendar date (`YYYY-MM-DD`). */
  today: string;
}

export type DashboardOutcome =
  | { kind: 'valid'; snapshot: DashboardSnapshot }
  | { kind: 'invalid'; issues: string[] };

/** Categories that make up the actionable shortlist, in documented order. */
const ACTIONABLE_CATEGORIES = ['apply-first', 'good-match', 'needs-review'] as const;

const NOTE_PRIORITIZATION_UNAVAILABLE =
  'Prioritization could not be computed, so no priority counts are shown. Nothing was changed.';
const NOTE_NO_PROFILE =
  'No usable master profile is loaded, so no match estimate exists — every saved job needs review. Add or repair your profile on the Profile tab.';

const CONFIDENCE_LABELS = { low: 'Low', medium: 'Medium', high: 'High' } as const;

function available(value: number): DashboardMetric {
  return { kind: 'value', value };
}

function unavailable(reason: DashboardUnavailableReason): DashboardMetric {
  return { kind: 'unavailable', reason };
}

/** Validate saved postings; `null` stays `null` (never an empty list). */
function readJobs(raw: readonly unknown[] | null): {
  jobs: JobPosting[] | null;
  skipped: number;
} {
  if (raw === null) return { jobs: null, skipped: 0 };
  const jobs: JobPosting[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const parsed = jobPostingSchema.safeParse(entry);
    if (parsed.success) jobs.push(parsed.data);
    else skipped += 1;
  }
  return { jobs, skipped };
}

/**
 * Validate application records; one invalid record makes the WHOLE log unknown
 * (`null`) — the same fail-closed rule the prioritization module applies.
 */
function readApplications(raw: readonly unknown[] | null): Application[] | null {
  if (raw === null) return null;
  const applications: Application[] = [];
  for (const entry of raw) {
    const parsed = applicationSchema.safeParse(entry);
    if (!parsed.success) return null;
    applications.push(parsed.data);
  }
  return applications;
}

function toRow(entry: {
  jobId: string;
  category: DashboardShortlistRow['category'];
  title: string;
  company: string | null;
  originalUrl: string | null;
  match: { state: DashboardShortlistRow['matchState']; label: string; confidenceLevel: 'low' | 'medium' | 'high' | null };
  freshness: { postedDate: string | null; label: string };
  application: { label: string };
  duplicate: { status: DashboardShortlistRow['duplicateStatus']; label: string };
  reasons: string[];
}, locationById: ReadonlyMap<string, string>): DashboardShortlistRow {
  return {
    jobId: entry.jobId,
    category: entry.category,
    categoryLabel: categoryLabelFor(entry.category),
    title: entry.title,
    company: entry.company,
    location: locationById.get(entry.jobId) ?? null,
    postedDate: entry.freshness.postedDate === null ? null : entry.freshness.postedDate,
    freshnessLabel: entry.freshness.label,
    matchLabel: entry.match.label,
    matchState: entry.match.state,
    confidenceLabel:
      entry.match.confidenceLevel === null ? null : CONFIDENCE_LABELS[entry.match.confidenceLevel],
    applicationLabel: entry.application.label,
    reasons: entry.reasons,
    originalUrl: entry.originalUrl,
    duplicateLabel: entry.duplicate.status === 'none' ? null : entry.duplicate.label,
    duplicateStatus: entry.duplicate.status,
  };
}

/**
 * Deterministic dashboard snapshot. Identical inputs always produce identical
 * output; inputs are never mutated. An invalid `today` returns a typed
 * `invalid` outcome (path + code only, never a value).
 */
export function buildDashboardSnapshot(input: DashboardInput): DashboardOutcome {
  const todayCheck = postingDateSchema.safeParse(input.today);
  if (!todayCheck.success) {
    return {
      kind: 'invalid',
      issues: todayCheck.error.issues.map((iss) => `today: ${iss.code}`),
    };
  }
  const today = todayCheck.data;

  const { jobs, skipped } = readJobs(input.jobs);
  const applications = readApplications(input.applications);
  const notes: string[] = [];
  if (skipped > 0) {
    notes.push('Some saved jobs failed validation and are excluded from these counts.');
  }

  /* ---------------- priority metrics + shortlist ---------------- */
  let reviewJobs: DashboardMetric;
  let applyFirst: DashboardMetric;
  let goodMatch: DashboardMetric;
  let shortlist: DashboardShortlist;

  if (jobs === null) {
    reviewJobs = unavailable('jobs-unreadable');
    applyFirst = unavailable('jobs-unreadable');
    goodMatch = unavailable('jobs-unreadable');
    shortlist = {
      available: false,
      reason: 'jobs-unreadable',
      rows: [],
      actionableCount: 0,
      alreadyAppliedCount: 0,
      truncated: false,
    };
  } else {
    const outcome = prioritizeJobs({
      jobs,
      matches: input.matches,
      applications,
      today,
      minMatchThreshold: input.minMatchThreshold,
    });
    if (outcome.kind === 'invalid') {
      reviewJobs = unavailable('prioritization-unavailable');
      applyFirst = unavailable('prioritization-unavailable');
      goodMatch = unavailable('prioritization-unavailable');
      shortlist = {
        available: false,
        reason: 'prioritization-unavailable',
        rows: [],
        actionableCount: 0,
        alreadyAppliedCount: 0,
        truncated: false,
      };
      notes.push(NOTE_PRIORITIZATION_UNAVAILABLE);
    } else {
      const result = outcome.result;
      notes.push(...result.notes);
      if (!input.profileAvailable) notes.push(NOTE_NO_PROFILE);

      const countOf = (category: (typeof ACTIONABLE_CATEGORIES)[number]): number =>
        result.groups.find((group) => group.category === category)?.count ?? 0;
      reviewJobs = available(countOf('needs-review'));
      applyFirst = available(countOf('apply-first'));
      goodMatch = available(countOf('good-match'));

      const locationById = new Map<string, string>();
      for (const job of jobs) if (job.location !== undefined) locationById.set(job.id, job.location);

      // Same deterministic order the priority shortlist uses: actionable groups
      // in category order, each already sorted by the pure module.
      const orderedRows = ACTIONABLE_CATEGORIES.flatMap(
        (category) => result.groups.find((group) => group.category === category)?.jobs ?? [],
      ).map((entry) => toRow(entry, locationById));

      const actionableCount = ACTIONABLE_CATEGORIES.reduce(
        (total, category) => total + countOf(category),
        0,
      );
      const alreadyAppliedCount =
        result.groups.find((group) => group.category === 'already-applied')?.count ?? 0;
      shortlist = {
        available: true,
        reason: null,
        rows: orderedRows.slice(0, DASHBOARD_SHORTLIST_LIMIT),
        actionableCount,
        alreadyAppliedCount,
        truncated: orderedRows.length > DASHBOARD_SHORTLIST_LIMIT,
      };
    }
  }

  /* ---------------- application metrics ---------------- */
  let submitted: DashboardMetric;
  let interviews: DashboardMetric;
  let offers: DashboardMetric;
  let upcomingFollowUps: DashboardMetric;
  if (applications === null) {
    submitted = unavailable('applications-unreadable');
    interviews = unavailable('applications-unreadable');
    offers = unavailable('applications-unreadable');
    upcomingFollowUps = unavailable('applications-unreadable');
  } else {
    // A `planned` record is NOT a submission (documented application-status
    // semantics); `rejected`/`withdrawn` records still count as submitted.
    submitted = available(applications.filter((a) => a.status !== 'planned').length);
    interviews = available(applications.filter((a) => a.status === 'interview').length);
    offers = available(applications.filter((a) => a.status === 'offer').length);
    upcomingFollowUps = available(
      applications.filter(
        (a) =>
          a.followUpDate !== undefined &&
          a.followUpDate >= today &&
          a.status !== 'rejected' &&
          a.status !== 'withdrawn',
      ).length,
    );
  }

  const snapshot = dashboardSnapshotSchema.parse({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    today,
    metrics: {
      savedJobs: jobs === null ? unavailable('jobs-unreadable') : available(jobs.length),
      reviewJobs,
      applyFirst,
      goodMatch,
      submitted,
      interviews,
      offers,
      upcomingFollowUps,
    },
    shortlist,
    notes: [...new Set(notes)].slice(0, 12),
  });
  return { kind: 'valid', snapshot };
}
