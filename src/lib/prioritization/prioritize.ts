/**
 * Freshness-aware job prioritization (Prompt 24) — pure, deterministic, local.
 *
 * `prioritizeJobs({ jobs, matches, applications, today, minMatchThreshold })`
 * turns ALREADY-COMPUTED inputs into a review order. It:
 * - validates the saved jobs, the application-log records and every match
 *   result with the EXISTING strict schemas (nothing is re-scored, and the
 *   matching module is not duplicated);
 * - accepts an EXPLICIT `today` (`YYYY-MM-DD`) and a threshold taken from the
 *   already-loaded settings (`null` = settings unreadable);
 * - never reads storage, never touches the clock, never mutates its input,
 *   never calls the network or an AI provider, and never writes anything back;
 * - fails CLOSED: unusable match data, an unreadable application log or an
 *   unreadable settings record becomes `needs-review`, never a good match;
 * - keeps the match estimate and the freshness signal as separate blocks —
 *   there is no combined numeric score and no probability of success.
 *
 * Prioritization is a REVIEW ORDER over data the user already saved. It makes
 * no claim that a posting is still open, how many people applied, or what the
 * user's chances are.
 */
import {
  applicationSchema,
  APPLICATION_STATUS_LABELS,
  type Application,
  type ApplicationStatus,
} from '../applications/schemas';
import { calendarDaysBetween, postingDateSchema } from '../job-dates';
import { jobPostingSchema, postingUrlSchema, type JobPosting } from '../job-posting';
import { validateMatchResult, type JobMatchResult } from '../matching/schemas';
import {
  FRESHNESS_WINDOW_DAYS,
  PRIORITY_CATEGORIES,
  PRIORITY_CATEGORY_META,
  prioritizationResultSchema,
  PRIORITY_SCHEMA_VERSION,
  type PriorityApplicationInfo,
  type PriorityCategory,
  type PriorityEntry,
  type PriorityFreshness,
  type PriorityGroup,
  type PriorityMatchInfo,
  type PrioritizationOutcome,
} from './schemas';

export { FRESHNESS_WINDOW_DAYS };

/** One already-computed match result. The wrapper outcome is accepted as-is. */
export interface PrioritizationMatchInput {
  jobId: string;
  /** `JobMatchOutcome` or `JobMatchResult` — validated here, never trusted. */
  result: unknown;
}

export interface PrioritizationInput {
  /** Saved posting records (unvalidated; invalid records are skipped). */
  jobs: readonly unknown[];
  /** Already-computed match results keyed by job id (optional). */
  matches?: readonly PrioritizationMatchInput[];
  /**
   * Application-log records. `null`/`undefined` means the log could NOT be
   * read — application status is then unknown (never "not applied").
   */
  applications?: readonly unknown[] | null;
  /** Explicit current calendar date (`YYYY-MM-DD`). */
  today: string;
  /** `settings.minMatchThreshold`; `null` when settings could not be read. */
  minMatchThreshold?: number | null;
}

/* ------------------------------------------------------------------ */
/* Fixed literals (fail-closed notes + reason templates)               */
/* ------------------------------------------------------------------ */

const NOTE_SETTINGS_UNAVAILABLE =
  'Settings could not be read, so no match minimum is available and match estimates cannot be used — every job needs manual review.';
const NOTE_APPLICATION_LOG_UNREADABLE =
  'The application log could not be read, so application status is unknown; no job is marked as already applied.';
const NOTE_APPLICATION_LOG_INVALID =
  'Some application records could not be read, so application status is treated as unknown for every job.';
const NOTE_SKIPPED_JOBS =
  'Some saved jobs failed validation and are excluded from this view.';
const NOTE_INVALID_MATCH =
  'Some saved match results were invalid or missing, so those jobs show no score.';
const NOTE_THRESHOLD_OFF =
  'No match minimum is configured (minimum 0 disables threshold filtering), so any usable estimate counts as meeting it.';

const REASON_NO_APPLICATION = 'No application is recorded for this saved job.';
const REASON_APPLICATION_UNAVAILABLE =
  'Application status is unknown because the application log could not be read — check it before applying.';

/** Statuses meaning a submission happened and is still in progress. */
const IN_PROGRESS_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'applied',
  'assessment',
  'interview',
  'offer',
]);
/** Statuses where a submission happened and the record is now closed. */
const COMPLETED_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'rejected',
  'withdrawn',
]);

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

function formatIssues(prefix: string, issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>): string[] {
  // Path + zod issue CODE only — never the offending value.
  return issues.map((i) => `${prefix}.${i.path.map(String).join('.') || '(root)'}: ${i.code}`);
}

/* ------------------------------------------------------------------ */
/* Signal builders                                                     */
/* ------------------------------------------------------------------ */

/** Match information derived ONLY from the already-computed result. */
function buildMatchInfo(
  result: JobMatchResult | 'invalid' | undefined,
  settingsUsable: boolean,
): PriorityMatchInfo {
  if (!settingsUsable) {
    return {
      state: 'unavailable',
      score: null,
      threshold: null,
      filtering: false,
      meetsThreshold: null,
      confidenceLevel: null,
      label: 'Match unavailable — settings could not be read',
    };
  }
  if (result === 'invalid') {
    return {
      state: 'invalid',
      score: null,
      threshold: null,
      filtering: false,
      meetsThreshold: null,
      confidenceLevel: null,
      label: 'Match result invalid — no score shown',
    };
  }
  if (result === undefined) {
    return {
      state: 'unavailable',
      score: null,
      threshold: null,
      filtering: false,
      meetsThreshold: null,
      confidenceLevel: null,
      label: 'No match estimate available',
    };
  }

  const threshold = result.threshold.configured;
  if (result.estimate.outcome !== 'score') {
    return {
      state: 'insufficient-data',
      score: null,
      threshold,
      filtering: result.threshold.filtering,
      // A threshold can never be "met" without a usable score.
      meetsThreshold: false,
      confidenceLevel: result.confidence.level,
      label: 'Insufficient data — no score',
    };
  }
  const score = result.estimate.score;
  // Reuse the matcher's OWN decision; `disabled` (minimum 0) means the user
  // configured no minimum, so any usable estimate qualifies (documented).
  const meets =
    result.threshold.decision === 'pass' || result.threshold.decision === 'disabled';
  return {
    state: 'score',
    score,
    threshold,
    filtering: result.threshold.filtering,
    meetsThreshold: meets,
    confidenceLevel: result.confidence.level,
    label: `${score} / 100 estimate`,
  };
}

/** Freshness from the stored posting date + the explicit `today`. */
function buildFreshness(postedDate: string | undefined, today: string): PriorityFreshness {
  if (postedDate === undefined) {
    return {
      postedDate: null,
      ageDays: null,
      future: false,
      withinWindow: false,
      windowDays: FRESHNESS_WINDOW_DAYS,
      label: 'Posting date unknown',
    };
  }
  const days = calendarDaysBetween(postedDate, today) ?? 0;
  if (days < 0) {
    return {
      postedDate,
      ageDays: null,
      future: true,
      withinWindow: false,
      windowDays: FRESHNESS_WINDOW_DAYS,
      label: `Future posting date — verify (${postedDate})`,
    };
  }
  return {
    postedDate,
    ageDays: days,
    future: false,
    withinWindow: days <= FRESHNESS_WINDOW_DAYS,
    windowDays: FRESHNESS_WINDOW_DAYS,
    label:
      days === 0
        ? `Posted today (${postedDate})`
        : `Posted ${days} day${days === 1 ? '' : 's'} ago (${postedDate})`,
  };
}

function applicationStateFor(status: ApplicationStatus): PriorityApplicationInfo['state'] {
  if (IN_PROGRESS_STATUSES.has(status)) return 'in-progress';
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  return 'planned';
}

/**
 * Application status for ONE job: only records whose `jobId` EQUALS the saved
 * job id are used (never inferred from title/company). When several records
 * reference the same job, the submitted/closed one wins; ties break on the
 * newest `updatedAt`, then id — deterministic and documented.
 */
function buildApplicationInfo(
  jobId: string,
  applications: readonly Application[] | null,
): PriorityApplicationInfo {
  const none = (state: PriorityApplicationInfo['state'], label: string): PriorityApplicationInfo => ({
    state,
    status: null,
    statusLabel: null,
    applicationDate: null,
    linkedCount: 0,
    label,
  });

  if (applications === null) return none('unavailable', 'Application status unknown');

  const linked = applications.filter((a) => a.jobId === jobId);
  if (linked.length === 0) return none('none', 'No application recorded');

  const sorted = [...linked].sort((a, b) => {
    const rank = (x: Application): number => (applicationStateFor(x.status) === 'planned' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(b) - rank(a); // submitted/closed first
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  const record = sorted[0] as Application;
  const state = applicationStateFor(record.status);
  const statusLabel = APPLICATION_STATUS_LABELS[record.status];
  const label =
    state === 'planned'
      ? `${statusLabel} (not submitted)`
      : state === 'in-progress'
        ? statusLabel
        : `${statusLabel} (closed)`;
  return {
    state,
    status: record.status,
    statusLabel,
    applicationDate: record.applicationDate ?? null,
    linkedCount: linked.length,
    label,
  };
}

/* ------------------------------------------------------------------ */
/* Reasons (human-readable, privacy-safe, derived from our own values) */
/* ------------------------------------------------------------------ */

function matchReason(match: PriorityMatchInfo): string {
  if (match.state === 'unavailable') {
    return 'No usable match estimate is available for this saved job — review it manually.';
  }
  if (match.state === 'invalid') {
    return 'The saved match result for this job is invalid, so no score is shown — review it manually.';
  }
  if (match.state === 'insufficient-data') {
    return 'No numeric match estimate could be computed from the posting and profile data (insufficient comparable data).';
  }
  const score = match.score ?? 0;
  const threshold = match.threshold ?? 0;
  if (match.threshold === null) return `Match estimate ${score}/100; no minimum is configured.`;
  if (!match.filtering) {
    return `Match estimate ${score}/100 (minimum ${threshold} disables filtering, so any usable estimate qualifies).`;
  }
  return match.meetsThreshold === true
    ? `Match estimate ${score}/100 meets your minimum of ${threshold}.`
    : `Match estimate ${score}/100 is below your minimum of ${threshold}.`;
}

function freshnessReason(freshness: PriorityFreshness): string {
  if (freshness.postedDate === null) {
    return 'Posting date unknown, so freshness cannot be confirmed and this job is never treated as recent.';
  }
  if (freshness.future) {
    return `Posting date ${freshness.postedDate} is in the future — verify it before acting on this job; a future date is never treated as fresh.`;
  }
  const age = freshness.ageDays ?? 0;
  return freshness.withinWindow
    ? `Posted ${age} day${age === 1 ? '' : 's'} ago, inside the ${freshness.windowDays}-day freshness window.`
    : `Posted ${age} day${age === 1 ? '' : 's'} ago, outside the ${freshness.windowDays}-day freshness window.`;
}

function applicationReason(application: PriorityApplicationInfo): string {
  if (application.state === 'unavailable') return REASON_APPLICATION_UNAVAILABLE;
  if (application.state === 'none') return REASON_NO_APPLICATION;
  const status = application.statusLabel ?? 'recorded';
  const date = application.applicationDate !== null ? ` (application date ${application.applicationDate})` : '';
  if (application.state === 'planned') {
    return `An application is recorded as ${status}, but nothing has been submitted yet${date}.`;
  }
  if (application.state === 'in-progress') {
    return `An application is recorded as ${status} — already applied or in progress${date}.`;
  }
  return `An application is recorded as ${status} — a submission happened and this record is closed${date}.`;
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

function classify(
  match: PriorityMatchInfo,
  freshness: PriorityFreshness,
  application: PriorityApplicationInfo,
): { category: PriorityCategory; reasons: string[] } {
  // 1. Already applied — high precedence: an existing submission/closed record
  //    is never presented as something to apply to first.
  if (application.state === 'in-progress' || application.state === 'completed') {
    return {
      category: 'already-applied',
      reasons: [applicationReason(application), matchReason(match), freshnessReason(freshness)],
    };
  }

  // 2. Fail closed: with an unreadable application log the "no application is
  //    already in progress" condition cannot be confirmed. A `planned` record
  //    is NOT a submission and does not block prioritization.
  if (application.state === 'unavailable') {
    return {
      category: 'needs-review',
      reasons: [applicationReason(application), matchReason(match), freshnessReason(freshness)],
    };
  }

  // 3. Unusable match data, or a match below the configured minimum, always
  //    wins over freshness — a poor match is never rescued by a recent date.
  if (match.state !== 'score' || match.meetsThreshold !== true) {
    return {
      category: 'needs-review',
      reasons: [matchReason(match), freshnessReason(freshness), applicationReason(application)],
    };
  }

  // 4. A future posting date is a data anomaly to verify, never "fresh".
  if (freshness.future) {
    return {
      category: 'needs-review',
      reasons: [freshnessReason(freshness), matchReason(match), applicationReason(application)],
    };
  }

  // 5. Every condition met: valid match, known non-future recent date, no
  //    submitted application.
  if (freshness.withinWindow) {
    return {
      category: 'apply-first',
      reasons: [matchReason(match), freshnessReason(freshness), applicationReason(application)],
    };
  }

  // 6. Matching but not fresh enough (unknown or older posting date).
  return {
    category: 'good-match',
    reasons: [freshnessReason(freshness), matchReason(match), applicationReason(application)],
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic ordering (within one category)                        */
/* ------------------------------------------------------------------ */

/**
 * 1. Known posting date, newest first (unknown dates never outrank known ones).
 * 2. Match score, highest first, when BOTH jobs have a valid numeric score.
 * 3. Job id ascending as the stable final tie-break.
 */
export function comparePriorityEntries(a: PriorityEntry, b: PriorityEntry): number {
  const ad = a.freshness.postedDate;
  const bd = b.freshness.postedDate;
  if (ad !== null && bd === null) return -1;
  if (ad === null && bd !== null) return 1;
  if (ad !== null && bd !== null && ad !== bd) return ad < bd ? 1 : -1;
  const as = a.match.score;
  const bs = b.match.score;
  if (as !== null && bs !== null && as !== bs) return bs - as;
  if (a.jobId === b.jobId) return 0;
  return a.jobId < b.jobId ? -1 : 1;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Deterministic prioritization. Identical validated inputs always produce
 * identical output; inputs are never mutated. Invalid input returns a typed
 * `invalid` outcome with path+code issues (never a value).
 */
export function prioritizeJobs(input: PrioritizationInput): PrioritizationOutcome {
  const todayCheck = postingDateSchema.safeParse(input.today);
  if (!todayCheck.success) {
    return { kind: 'invalid', issues: formatIssues('today', todayCheck.error.issues) };
  }
  const today = todayCheck.data;

  const thresholdInput = input.minMatchThreshold ?? null;
  const settingsUsable = thresholdInput !== null;
  if (settingsUsable && (!Number.isInteger(thresholdInput) || thresholdInput < 0 || thresholdInput > 100)) {
    return { kind: 'invalid', issues: ['minMatchThreshold: invalid_type'] };
  }

  const notes: string[] = [];
  if (!settingsUsable) notes.push(NOTE_SETTINGS_UNAVAILABLE);
  else if (thresholdInput === 0) notes.push(NOTE_THRESHOLD_OFF);

  /* --- jobs (invalid records are skipped, never classified) --- */
  const jobs: JobPosting[] = [];
  let skippedJobs = 0;
  for (const raw of input.jobs) {
    const parsed = jobPostingSchema.safeParse(raw);
    if (parsed.success) jobs.push(parsed.data);
    else skippedJobs += 1;
  }
  if (skippedJobs > 0) notes.push(NOTE_SKIPPED_JOBS);

  /* --- already-computed match results (validated, never recomputed) --- */
  const matches = new Map<string, JobMatchResult | 'invalid'>();
  let invalidMatchCount = 0;
  for (const entry of input.matches ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const jobId = (entry as { jobId?: unknown }).jobId;
    if (typeof jobId !== 'string' || jobId.length === 0) continue;
    const payload = (entry as { result?: unknown }).result;
    if (payload === undefined || payload === null) continue;
    const validated =
      typeof payload === 'object' && payload !== null && (payload as { kind?: unknown }).kind === 'valid'
        ? validateMatchResult((payload as { result?: unknown }).result)
        : validateMatchResult(payload);
    if (validated.ok) matches.set(jobId, validated.result);
    else {
      matches.set(jobId, 'invalid');
      invalidMatchCount += 1;
    }
  }
  if (invalidMatchCount > 0) notes.push(NOTE_INVALID_MATCH);

  /* --- application log (fail closed when unreadable) --- */
  let applications: Application[] | null = null;
  if (input.applications !== null && input.applications !== undefined) {
    applications = [];
    for (const raw of input.applications) {
      const parsed = applicationSchema.safeParse(raw);
      if (!parsed.success) {
        applications = null; // one unreadable record is enough to fail closed
        notes.push(NOTE_APPLICATION_LOG_INVALID);
        break;
      }
      applications.push(parsed.data);
    }
  } else {
    notes.push(NOTE_APPLICATION_LOG_UNREADABLE);
  }

  /* --- classify every valid job --- */
  const entries: PriorityEntry[] = jobs.map((job) => {
    const match = buildMatchInfo(matches.get(job.id), settingsUsable);
    const freshness = buildFreshness(job.postedDate, today);
    const application = buildApplicationInfo(job.id, applications);
    const { category, reasons } = classify(match, freshness, application);
    const url = job.originalUrl !== undefined ? postingUrlSchema.safeParse(job.originalUrl) : null;
    return {
      jobId: job.id,
      category,
      title: job.title,
      company: job.company ?? null,
      originalUrl: url !== null && url.success ? url.data : null,
      match,
      freshness,
      application,
      reasons,
    };
  });

  const groups: PriorityGroup[] = PRIORITY_CATEGORIES.map((category) => {
    const groupJobs = entries.filter((e) => e.category === category).sort(comparePriorityEntries);
    return {
      category,
      label: PRIORITY_CATEGORY_META[category].label,
      description: PRIORITY_CATEGORY_META[category].description,
      count: groupJobs.length,
      jobs: groupJobs,
    };
  });

  // Invariant: our own construction must satisfy the strict result schema.
  const result = prioritizationResultSchema.parse({
    schemaVersion: PRIORITY_SCHEMA_VERSION,
    today,
    freshnessWindowDays: FRESHNESS_WINDOW_DAYS,
    threshold: { configured: thresholdInput, filtering: settingsUsable && thresholdInput > 0 },
    groups,
    totalJobs: entries.length,
    skippedJobs,
    notes: [...new Set(notes)].slice(0, 6),
  });
  return { kind: 'valid', result };
}
