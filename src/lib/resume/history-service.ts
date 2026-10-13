/**
 * Resume version history service (Prompt 19).
 *
 * Thin, deterministic layer over the established storage abstraction
 * (`src/lib/storage.ts`, key `job-resume-history.v1`) that owns the domain
 * rules the UI must not: snapshot validation, job-label provenance, the
 * documented cap, and typed outcomes.
 *
 * Conventions (matches the storage / application-log services):
 * - Every operation returns a discriminated result `{ ok: true, data }` or
 *   `{ ok:false, reason, message }` (plus `issues` for `invalid` and `raw`
 *   for `malformed`). Expected user-data failures NEVER throw.
 * - Messages are fixed and contain NO resume, profile or job content — only
 *   key names / fixed phrases / counts.
 * - Malformed history is NEVER overwritten: every mutation loads first and
 *   aborts (the explicit `resetResumeHistory()` is the only replacement).
 * - Nothing is ever trimmed: at `MAX_RESUME_HISTORY_VERSIONS` a save is
 *   refused (`limit-reached`) instead of silently deleting an older version.
 *   Deletion only happens for the one explicitly selected id.
 * - The saved snapshot is self-contained: reading, exporting and deleting
 *   never re-tailor, so editing the master profile or the job posting later
 *   cannot change a stored version.
 *
 * Offline: no AI provider, no network, no sensitive profile, no telemetry.
 */
import { ZodError } from 'zod';
import type { JobPosting } from '../job-posting';
import { loadResumeHistory, saveResumeHistory, type StorageFailure } from '../storage';
import { tailoredResumeSchema, type TailoredResume } from './schemas';
import {
  createResumeHistoryEntry,
  emptyResumeHistoryRecord,
  findResumeHistoryEntry,
  formatResumeHistoryIssues,
  isResumeHistoryFull,
  MAX_RESUME_HISTORY_VERSIONS,
  removeResumeHistoryEntry,
  upsertResumeHistoryEntry,
  type ResumeHistoryDeps,
  type ResumeHistoryEntry,
  type ResumeHistoryRecord,
} from './history';

/** Storage reasons plus resume-history-domain reasons. */
export type ResumeHistoryErrorReason =
  | 'absent'
  | 'malformed'
  | 'unavailable'
  | 'quota'
  | 'invalid'
  | 'not-found'
  | 'limit-reached';

export type ResumeHistoryOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: ResumeHistoryErrorReason;
      message: string;
      /** Path+code validation issues (reason 'invalid') — never content. */
      issues?: string[];
      /** Raw stored value, present ONLY for reason 'malformed' (recoverable). */
      raw?: unknown;
    };

const NOT_FOUND_MESSAGE = 'That saved resume version no longer exists.';

/** Map a storage failure onto a history outcome (message is already safe). */
function fromStorageFailure<T>(failure: StorageFailure): ResumeHistoryOutcome<T> {
  return {
    ok: false,
    reason: failure.reason,
    message: failure.message,
    ...(failure.reason === 'malformed' && failure.raw !== undefined ? { raw: failure.raw } : {}),
  };
}

function invalid(message: string, issues: string[]): ResumeHistoryOutcome<never> {
  return { ok: false, reason: 'invalid', message, issues };
}

type RecordLoad =
  | { ok: true; record: ResumeHistoryRecord }
  | { ok: false; outcome: ResumeHistoryOutcome<never> };

/**
 * Load the record for a mutation. `absent` becomes an empty record (first
 * write); `malformed`/`unavailable` abort the mutation (never overwrite).
 */
async function loadRecordForWrite(): Promise<RecordLoad> {
  const res = await loadResumeHistory();
  if (res.ok) return { ok: true, record: res.data };
  if (res.reason === 'absent') return { ok: true, record: emptyResumeHistoryRecord() };
  return { ok: false, outcome: fromStorageFailure(res) };
}

/**
 * Every saved version, newest first (empty when nothing is stored).
 * Absent storage is NOT an error — an empty history is a normal state.
 */
export async function listResumeVersions(): Promise<ResumeHistoryOutcome<ResumeHistoryEntry[]>> {
  const res = await loadResumeHistory();
  if (res.ok) return { ok: true, data: res.data.versions };
  if (res.reason === 'absent') return { ok: true, data: [] };
  return fromStorageFailure(res);
}

/** One saved version by id; typed `not-found` when it does not exist. */
export async function getResumeVersion(
  id: string,
): Promise<ResumeHistoryOutcome<ResumeHistoryEntry>> {
  const res = await loadResumeHistory();
  if (!res.ok) {
    if (res.reason === 'absent') return { ok: false, reason: 'not-found', message: NOT_FOUND_MESSAGE };
    return fromStorageFailure(res);
  }
  const entry = findResumeHistoryEntry(res.data, id);
  if (entry === undefined) return { ok: false, reason: 'not-found', message: NOT_FOUND_MESSAGE };
  return { ok: true, data: entry };
}

export interface SaveResumeVersionInput {
  /** The tailored resume to preserve (strictly validated before any write). */
  resume: TailoredResume;
  /**
   * The saved job the resume was generated for. Labels are COPIED from it —
   * company only when the posting has one; nothing is invented when absent.
   */
  job?: Pick<JobPosting, 'id' | 'title' | 'company'>;
}

/**
 * Persist one explicitly requested version. Appends (newest first) and never
 * deletes or rewrites an existing version; at the documented cap the save is
 * refused with `limit-reached` so the user removes a version themselves.
 * Nothing about an application or its status is read or changed here.
 */
export async function saveResumeVersion(
  input: SaveResumeVersionInput,
  deps: ResumeHistoryDeps = {},
): Promise<ResumeHistoryOutcome<ResumeHistoryEntry>> {
  const snapshotCheck = tailoredResumeSchema.safeParse(input.resume);
  if (!snapshotCheck.success) {
    return invalid(
      'The tailored resume could not be validated, so no version was saved.',
      formatResumeHistoryIssues(snapshotCheck.error),
    );
  }
  const resume = snapshotCheck.data;

  if (input.job !== undefined && input.job.id !== resume.source.jobId) {
    return invalid('The selected saved job does not match this resume, so nothing was saved.', []);
  }

  const loaded = await loadRecordForWrite();
  if (!loaded.ok) return loaded.outcome;

  if (isResumeHistoryFull(loaded.record)) {
    return {
      ok: false,
      reason: 'limit-reached',
      message: `Resume history already holds its maximum of ${MAX_RESUME_HISTORY_VERSIONS} saved versions. Nothing was deleted — remove a version you no longer need, then save again.`,
    };
  }

  let entry: ResumeHistoryEntry;
  try {
    entry = createResumeHistoryEntry(resume, input.job, deps);
  } catch (err) {
    // Only an over-long job label (crafted input) can land here — typed,
    // content-free result instead of a throw.
    return {
      ok: false,
      reason: 'invalid',
      message: 'The version details are invalid and were not saved.',
      ...(err instanceof ZodError ? { issues: formatResumeHistoryIssues(err) } : {}),
    };
  }

  const write = await saveResumeHistory(upsertResumeHistoryEntry(loaded.record, entry));
  if (write !== null && !write.ok) return fromStorageFailure(write);
  return { ok: true, data: entry };
}

/**
 * Delete exactly the explicitly selected version and return what remains.
 * Never touches jobs, profiles, applications or any other storage key.
 */
export async function deleteResumeVersion(
  id: string,
): Promise<ResumeHistoryOutcome<ResumeHistoryEntry[]>> {
  const loaded = await loadRecordForWrite();
  if (!loaded.ok) return loaded.outcome;

  if (findResumeHistoryEntry(loaded.record, id) === undefined) {
    return { ok: false, reason: 'not-found', message: NOT_FOUND_MESSAGE };
  }

  const remaining = removeResumeHistoryEntry(loaded.record, id);
  const write = await saveResumeHistory(remaining);
  if (write !== null && !write.ok) return fromStorageFailure(write);
  return { ok: true, data: remaining.versions };
}
