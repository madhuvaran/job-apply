/**
 * Application-log service (Prompt 13).
 *
 * Thin, deterministic layer over the established storage abstraction
 * (`src/lib/storage.ts`) that adds the domain rules the UI must not own:
 * job-reference validation, duplicate policy, and typed outcomes.
 *
 * Conventions (matches the storage service):
 * - Every operation returns a discriminated result `{ ok: true, data }` or
 *   `{ ok:false, reason, message }`. Expected user-data failures NEVER throw.
 * - Messages are stable and contain NO application content (no notes, no job
 *   title) — only key names / fixed phrases.
 * - Malformed application storage is NEVER overwritten: every mutation loads
 *   first and aborts (unless the explicit reset helper is used).
 * - Duplicate policy: the one-click "track this job" flow REUSES an existing
 *   application for the same job (`alreadyTracked: true`) instead of silently
 *   creating a second record; the explicit create flow allows a deliberate
 *   repeat application for the same job.
 * - A saved job may be deleted later: application records are untouched (the
 *   UI shows an "orphaned" state) — history is never silently deleted.
 *
 * Offline: no AI provider, no network, no sensitive profile, no telemetry.
 */
import {
  formatZodIssues,
  applyApplicationPatch,
  applicationFieldsSchema,
  applicationPatchSchema,
  createApplication,
  emptyApplicationsRecord,
  findApplicationForJob,
  removeApplicationFromList,
  upsertApplicationInList,
  type Application,
  type ApplicationDeps,
  type ApplicationFields,
  type ApplicationPatch,
  type ApplicationsRecord,
} from './schemas';
import {
  loadApplications,
  loadJobPostings,
  saveApplications,
  type StorageFailure,
} from '../storage';

/** Storage reasons plus application-domain reasons. */
export type ApplicationErrorReason =
  | 'absent'
  | 'malformed'
  | 'unavailable'
  | 'quota'
  | 'job-missing'
  | 'not-found'
  | 'invalid';

export type ApplicationOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: ApplicationErrorReason;
      message: string;
      /** Path+message validation issues (reason 'invalid') — never content. */
      issues?: string[];
      /** Raw stored value, present ONLY for reason 'malformed' (recoverable). */
      raw?: unknown;
    };

/** Map a storage failure onto an application outcome (message is already safe). */
function fromStorageFailure<T>(failure: StorageFailure): ApplicationOutcome<T> {
  return {
    ok: false,
    reason: failure.reason,
    message: failure.message,
    ...(failure.reason === 'malformed' && failure.raw !== undefined ? { raw: failure.raw } : {}),
  };
}

type RecordLoad =
  | { ok: true; record: ApplicationsRecord }
  | { ok: false; outcome: ApplicationOutcome<never> };

/**
 * Load the record for a mutation. `absent` becomes an empty record (first
 * write); `malformed`/`unavailable` abort the mutation (never overwrite).
 */
async function loadRecordForWrite(): Promise<RecordLoad> {
  const res = await loadApplications();
  if (res.ok) return { ok: true, record: res.data };
  if (res.reason === 'absent') return { ok: true, record: emptyApplicationsRecord() };
  return { ok: false, outcome: fromStorageFailure(res) };
}

function recordWith(applications: Application[]): ApplicationsRecord {
  return { schemaVersion: '1', applications };
}

/** Verify the referenced saved job exists before creating a record. */
async function jobReferenceProblem(jobId: string): Promise<ApplicationOutcome<never> | null> {
  const jobs = await loadJobPostings();
  if (jobs.ok) {
    if (jobs.data.postings.some((p) => p.id === jobId)) return null;
    return {
      ok: false,
      reason: 'job-missing',
      message: 'The referenced saved job no longer exists; save the job before tracking an application.',
    };
  }
  if (jobs.reason === 'absent') {
    return {
      ok: false,
      reason: 'job-missing',
      message: 'No saved job matches this reference; save the job before tracking an application.',
    };
  }
  // malformed / unavailable: cannot confirm the reference — do not write.
  return fromStorageFailure(jobs);
}

/** The application log as a plain list (empty when nothing is stored). */
export async function listApplications(): Promise<ApplicationOutcome<Application[]>> {
  const res = await loadApplications();
  if (res.ok) return { ok: true, data: res.data.applications };
  if (res.reason === 'absent') return { ok: true, data: [] };
  return fromStorageFailure(res);
}

/** Explicitly create an application for a saved job (allows repeat applications). */
export async function createApplicationForJob(
  input: ApplicationFields,
  deps: ApplicationDeps = {},
): Promise<ApplicationOutcome<Application>> {
  const loaded = await loadRecordForWrite();
  if (!loaded.ok) return loaded.outcome;

  const fields = applicationFieldsSchema.safeParse(input);
  if (!fields.success) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'The application details are invalid and were not saved.',
      issues: formatZodIssues(fields.error),
    };
  }

  const jobProblem = await jobReferenceProblem(fields.data.jobId);
  if (jobProblem !== null) return jobProblem;

  const application = createApplication(fields.data, deps);
  const write = await saveApplications(
    recordWith(upsertApplicationInList(loaded.record.applications, application)),
  );
  if (write !== null && !write.ok) return fromStorageFailure(write);
  return { ok: true, data: application };
}

export interface StartTrackingResult {
  application: Application;
  /** True when an application for this job already existed (nothing written). */
  alreadyTracked: boolean;
}

/**
 * One-click "track this job" (Jobs panel): reuses an existing application for
 * the same job instead of creating a duplicate. Explicit creation in the log
 * still allows deliberate repeat applications.
 */
export async function startTrackingApplication(
  jobId: string,
  deps: ApplicationDeps = {},
): Promise<ApplicationOutcome<StartTrackingResult>> {
  const loaded = await loadRecordForWrite();
  if (!loaded.ok) return loaded.outcome;

  const existing = findApplicationForJob(loaded.record.applications, jobId);
  if (existing !== undefined) {
    return { ok: true, data: { application: existing, alreadyTracked: true } };
  }

  const created = await createApplicationForJob({ jobId, status: 'planned' }, deps);
  if (!created.ok) return created;
  return { ok: true, data: { application: created.data, alreadyTracked: false } };
}

/** Update status / dates / notes of one application (identity preserved). */
export async function updateApplication(
  id: string,
  patch: ApplicationPatch,
  deps: ApplicationDeps = {},
): Promise<ApplicationOutcome<Application>> {
  const loaded = await loadRecordForWrite();
  if (!loaded.ok) return loaded.outcome;

  const current = loaded.record.applications.find((a) => a.id === id);
  if (current === undefined) {
    return { ok: false, reason: 'not-found', message: 'That application no longer exists.' };
  }

  const parsed = applicationPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'The changes are invalid and were not saved.',
      issues: formatZodIssues(parsed.error),
    };
  }

  const next = applyApplicationPatch(current, parsed.data, deps.now);
  const write = await saveApplications(
    recordWith(upsertApplicationInList(loaded.record.applications, next)),
  );
  if (write !== null && !write.ok) return fromStorageFailure(write);
  return { ok: true, data: next };
}

/** Delete one application; returns the remaining list. Never touches jobs. */
export async function deleteApplication(
  id: string,
): Promise<ApplicationOutcome<Application[]>> {
  const loaded = await loadRecordForWrite();
  if (!loaded.ok) return loaded.outcome;

  if (!loaded.record.applications.some((a) => a.id === id)) {
    return { ok: false, reason: 'not-found', message: 'That application no longer exists.' };
  }

  const remaining = removeApplicationFromList(loaded.record.applications, id);
  const write = await saveApplications(recordWith(remaining));
  if (write !== null && !write.ok) return fromStorageFailure(write);
  return { ok: true, data: remaining };
}
