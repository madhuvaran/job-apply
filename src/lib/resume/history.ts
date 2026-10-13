/**
 * Tailored resume version history (Prompt 19) — schema + pure record helpers.
 *
 * Scope: identify and reproduce previously generated tailored resumes. Each
 * saved version carries ONLY:
 * - a stable generated `id`,
 * - the history schema version,
 * - the associated saved `jobId` (stored when the snapshot's provenance has
 *   one — never guessed),
 * - `jobTitle` / `company` labels copied from the saved job when available
 *   (absent stays absent — nothing is invented),
 * - the creation timestamp (injected clock),
 * - a small fixed `status` for the UI,
 * - a strictly validated `snapshot` that REUSES the existing strict
 *   `tailoredResumeSchema` (Prompt 11) — no competing resume-content schema.
 *
 * Rules honored:
 * - STRICT: every schema is `.strict()`; unknown keys are rejected, so an API
 *   key, credential, token, page content, HTML/script/selector or sensitive
 *   profile field cannot be smuggled into a history record.
 * - NO SENSITIVE DATA: contact details, legal/EEO/voluntary answers,
 *   compensation, government IDs and documents live in the separate sensitive
 *   profile and have no field here. This module never imports `sensitive.ts`.
 * - NO INVENTION: labels are copied from the saved job and/or the snapshot's
 *   own provenance; timestamps and ids come from the injected `now`/`id`.
 * - IMMUTABLE SNAPSHOT: `createResumeHistoryEntry` re-validates and copies the
 *   payload through the strict schema, so later edits to the master profile or
 *   the job posting never change a saved version.
 * - CAP, NEVER SILENT TRIM: `MAX_RESUME_HISTORY_VERSIONS` bounds one stored
 *   record; the service refuses new saves at the cap instead of deleting
 *   older versions (deletion only ever happens through an explicit user
 *   action).
 *
 * Pure module: no DOM, no network, no storage, no AI, no clock of its own.
 * Persistence lives in `src/lib/storage.ts` (key `job-resume-history.v1`);
 * domain rules live in `./history-service.ts`.
 */
import { z } from 'zod';
import { MAX_TEXT_FIELD_CHARS, MAX_TITLE_CHARS, type JobPosting } from '../job-posting';
import { tailoredResumeSchema, type TailoredResume } from './schemas';

export const RESUME_HISTORY_SCHEMA_VERSION = '1';

/**
 * Documented cap for one stored history record. Reaching it does NOT delete
 * anything: saving is refused with a typed `limit-reached` result until the
 * user explicitly removes a version.
 */
export const MAX_RESUME_HISTORY_VERSIONS = 200;

/** Fixed, documented status set (no custom/unknown statuses). */
export const RESUME_HISTORY_STATUSES = ['saved'] as const;
export type ResumeHistoryStatus = (typeof RESUME_HISTORY_STATUSES)[number];

/** Human label for the fixed status set (display only). */
export const RESUME_HISTORY_STATUS_LABELS: Record<ResumeHistoryStatus, string> = {
  saved: 'Saved',
};

/**
 * One saved resume version. Strict: unknown keys (credentials, sensitive
 * fields, page content, selectors, …) are rejected at read AND write time.
 */
export const resumeHistoryEntrySchema = z
  .object({
    /** Stable, generated version id — never derived from job/user content. */
    id: z.string().min(1).max(80),
    schemaVersion: z.literal(RESUME_HISTORY_SCHEMA_VERSION).default(RESUME_HISTORY_SCHEMA_VERSION),

    /** Associated saved job id, when available (may dangle if the job is later deleted). */
    jobId: z.string().min(1).max(80).optional(),

    /** Job title label — copied from the saved job / snapshot provenance, never invented. */
    jobTitle: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    /** Company label — only present when the saved job provided one. */
    company: z.string().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),

    /** When this version was saved (ISO 8601, injected clock). */
    createdAt: z.iso.datetime(),
    /** Small UI status. */
    status: z.enum(RESUME_HISTORY_STATUSES).default('saved'),

    /** The tailored resume exactly as generated — the existing strict schema. */
    snapshot: tailoredResumeSchema,
  })
  .strict();

export type ResumeHistoryEntry = z.infer<typeof resumeHistoryEntrySchema>;

/**
 * The stored record (one key). Strict; the array is capped at
 * `MAX_RESUME_HISTORY_VERSIONS` so a runaway writer cannot fill storage.
 */
export const resumeHistoryRecordSchema = z
  .object({
    schemaVersion: z.literal(RESUME_HISTORY_SCHEMA_VERSION).default(RESUME_HISTORY_SCHEMA_VERSION),
    versions: z.array(resumeHistoryEntrySchema).max(MAX_RESUME_HISTORY_VERSIONS).default([]),
  })
  .strict();

export type ResumeHistoryRecord = z.infer<typeof resumeHistoryRecordSchema>;

export function emptyResumeHistoryRecord(): ResumeHistoryRecord {
  return resumeHistoryRecordSchema.parse({});
}

/** Stable, value-free issue strings (path + code only — never stored content). */
export function formatResumeHistoryIssues(error: z.ZodError): string[] {
  return error.issues.map((iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.code}`);
}

/** Validate an untrusted object against the strict history-entry schema. */
export function validateResumeHistoryEntry(
  payload: unknown,
): { ok: true; entry: ResumeHistoryEntry } | { ok: false; issues: string[] } {
  const parsed = resumeHistoryEntrySchema.safeParse(payload);
  if (parsed.success) return { ok: true, entry: parsed.data };
  return { ok: false, issues: formatResumeHistoryIssues(parsed.error) };
}

/* ------------------------------------------------------------------ */
/* Ids / clock (injectable for deterministic tests)                    */
/* ------------------------------------------------------------------ */

export function defaultResumeVersionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `rv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultHistoryNow(): string {
  return new Date().toISOString();
}

export interface ResumeHistoryDeps {
  now?: () => string;
  id?: () => string;
}

/* ------------------------------------------------------------------ */
/* Construction / record helpers (pure)                                */
/* ------------------------------------------------------------------ */

/**
 * Build one validated history entry from a tailored resume + the saved job it
 * was generated for. Labels are COPIED (title from the saved job when given,
 * otherwise the snapshot's own provenance; company only when the job has
 * one) — nothing is invented, and the snapshot is copied through the strict
 * schema so later profile/job edits cannot reach it.
 *
 * Throws only on programmer error (an invalid resume/job) — callers that
 * accept untrusted input must pre-validate with `validateResumeHistoryEntry`
 * or the service, which returns typed results instead of throwing.
 */
export function createResumeHistoryEntry(
  resume: TailoredResume,
  job: Pick<JobPosting, 'id' | 'title' | 'company'> | null | undefined,
  deps: ResumeHistoryDeps = {},
): ResumeHistoryEntry {
  const now = deps.now ?? defaultHistoryNow;
  const id = deps.id ?? defaultResumeVersionId;
  const company = job?.company?.trim();
  const jobTitle = job?.title.trim();
  return resumeHistoryEntrySchema.parse({
    id: id(),
    schemaVersion: RESUME_HISTORY_SCHEMA_VERSION,
    // Provenance recorded by the tailoring engine — never guessed here.
    jobId: resume.source.jobId,
    jobTitle: jobTitle !== undefined && jobTitle.length > 0 ? jobTitle : resume.source.jobTitle,
    ...(company !== undefined && company.length > 0 ? { company } : {}),
    createdAt: now(),
    status: 'saved',
    snapshot: resume,
  });
}

/** Insert or replace by id, NEWEST FIRST (stable order; nothing is dropped). */
export function upsertResumeHistoryEntry(
  record: ResumeHistoryRecord,
  entry: ResumeHistoryEntry,
): ResumeHistoryRecord {
  const idx = record.versions.findIndex((v) => v.id === entry.id);
  if (idx === -1) {
    return { schemaVersion: RESUME_HISTORY_SCHEMA_VERSION, versions: [entry, ...record.versions] };
  }
  const versions = [...record.versions];
  versions[idx] = entry;
  return { schemaVersion: RESUME_HISTORY_SCHEMA_VERSION, versions };
}

/** Remove exactly the version with `id`; other versions are untouched. */
export function removeResumeHistoryEntry(
  record: ResumeHistoryRecord,
  id: string,
): ResumeHistoryRecord {
  return {
    schemaVersion: RESUME_HISTORY_SCHEMA_VERSION,
    versions: record.versions.filter((v) => v.id !== id),
  };
}

export function findResumeHistoryEntry(
  record: ResumeHistoryRecord,
  id: string,
): ResumeHistoryEntry | undefined {
  return record.versions.find((v) => v.id === id);
}

/** True when the record is at its documented cap (saves must be refused, not trimmed). */
export function isResumeHistoryFull(record: ResumeHistoryRecord): boolean {
  return record.versions.length >= MAX_RESUME_HISTORY_VERSIONS;
}
