/**
 * Application record model (schema v1) — local, validated application tracking.
 *
 * Scope: WHICH saved job an application belongs to, its status, optional
 * application/follow-up dates, a creation + last-updated timestamp, and
 * optional user-written notes. Nothing else.
 *
 * Rules honored:
 * - STRICT: every schema is `.strict()`; unknown keys are rejected, so a
 *   salary, contact detail, credential or token field cannot be smuggled into
 *   an application record.
 * - NO SENSITIVE FIELDS: no compensation, contact details, credentials or
 *   legal/voluntary answers exist in the model (they live in the separate
 *   sensitive profile and never enter this module).
 * - STABLE IDENTITY: records are identified by generated `id` only — never by
 *   employer or job title (multiple applications can share those).
 * - DATE VALIDATION: `applicationDate`/`followUpDate` are real calendar dates
 *   (`YYYY-MM-DD`, impossible dates like 2026-02-31 rejected); timestamps are
 *   ISO 8601 datetimes. Empty notes are omitted (never stored as "").
 * - DETERMINISTIC: ids/timestamps are injected (`now`/`id`), so identical
 *   inputs + injected clock always produce identical output.
 *
 * Pure module: no DOM, no network, no storage, no AI.
 */
import { z } from 'zod';

export const APPLICATION_SCHEMA_VERSION = '1';

/** Cap for one stored application list collection. */
export const MAX_APPLICATIONS = 1000;
/** Notes are user-written free text, length-capped (not logged anywhere). */
export const MAX_NOTES_CHARS = 4000;

/** Fixed, documented status set (no custom/unknown statuses). */
export const APPLICATION_STATUSES = [
  'planned',
  'applied',
  'assessment',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Human labels for the fixed status set (display only). */
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  planned: 'Planned',
  applied: 'Applied',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/* ------------------------------------------------------------------ */
/* Date primitives                                                     */
/* ------------------------------------------------------------------ */

/** True only for a real calendar date (rejects 2026-02-31, month 13, …). */
export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A real `YYYY-MM-DD` calendar date. */
export const applicationDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealCalendarDate, { message: 'not a real calendar date' });

const notesSchema = z.string().trim().min(1).max(MAX_NOTES_CHARS);

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

export const applicationSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(APPLICATION_SCHEMA_VERSION).default(APPLICATION_SCHEMA_VERSION),

    /** Reference to a saved `JobPosting.id`. May dangle if the job is later deleted. */
    jobId: z.string().min(1),

    status: z.enum(APPLICATION_STATUSES),

    /** The date the user applied (optional). */
    applicationDate: applicationDateSchema.optional(),
    /** Optional follow-up date the user tracks themselves. */
    followUpDate: applicationDateSchema.optional(),

    /** User-written notes (optional; empty is normalized to absent). */
    notes: notesSchema.optional(),

    /** When the record was created (managed by the service). */
    createdAt: z.iso.datetime(),
    /** Last update (managed by the service). */
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type Application = z.infer<typeof applicationSchema>;

/** Per-issue messages for an unvalidated application draft ([] = valid). */
export function validateApplicationInput(value: unknown): string[] {
  const check = applicationSchema.safeParse(value);
  if (check.success) return [];
  return check.error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`);
}

/** Stable, value-free issue strings (path + message; never the stored content). */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`);
}

/**
 * User-supplied fields accepted when creating an application (strict).
 * `notes` may be blank here (normalized to absent by `createApplication`).
 */
export const applicationFieldsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(200),
    status: z.enum(APPLICATION_STATUSES).optional(),
    applicationDate: applicationDateSchema.optional(),
    followUpDate: applicationDateSchema.optional(),
    notes: z.string().max(MAX_NOTES_CHARS).optional(),
  })
  .strict();

export type ApplicationFieldsInput = z.infer<typeof applicationFieldsSchema>;

/**
 * Fields a user may change after creation (strict). `null` clears an optional
 * field; a blank `notes` string also clears it. Identity fields (id/jobId/
 * createdAt) are intentionally NOT patchable.
 */
export const applicationPatchSchema = z
  .object({
    status: z.enum(APPLICATION_STATUSES).optional(),
    applicationDate: applicationDateSchema.nullable().optional(),
    followUpDate: applicationDateSchema.nullable().optional(),
    notes: z.string().max(MAX_NOTES_CHARS).nullable().optional(),
  })
  .strict();

export type ApplicationPatchInput = z.infer<typeof applicationPatchSchema>;

/* ------------------------------------------------------------------ */
/* Storage record                                                      */
/* ------------------------------------------------------------------ */

export const applicationsRecordSchema = z
  .object({
    schemaVersion: z.literal(APPLICATION_SCHEMA_VERSION).default(APPLICATION_SCHEMA_VERSION),
    applications: z.array(applicationSchema).max(MAX_APPLICATIONS).default([]),
  })
  .strict();

export type ApplicationsRecord = z.infer<typeof applicationsRecordSchema>;

export function emptyApplicationsRecord(): ApplicationsRecord {
  return applicationsRecordSchema.parse({});
}

/* ------------------------------------------------------------------ */
/* Ids / clock (injectable for deterministic tests)                    */
/* ------------------------------------------------------------------ */

export function defaultApplicationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultNow(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* Construction / mutation (pure)                                      */
/* ------------------------------------------------------------------ */

/** Fields a user may set when creating an application. */
export interface ApplicationFields {
  jobId: string;
  status?: ApplicationStatus;
  applicationDate?: string;
  followUpDate?: string;
  notes?: string;
}

export interface ApplicationDeps {
  now?: () => string;
  id?: () => string;
}

/** Drop blank notes so an empty textarea never persists `""`. */
function normalizedNotes(notes: string | undefined): string | undefined {
  if (notes === undefined || notes.trim().length === 0) return undefined;
  return notes;
}

/**
 * Build a fully validated application with generated id + timestamps.
 * Throws only on programmer error with invalid fields — callers that accept
 * user input must pre-validate with `applicationSchema.safeParse`.
 */
export function createApplication(fields: ApplicationFields, deps: ApplicationDeps = {}): Application {
  const now = deps.now ?? defaultNow;
  const id = deps.id ?? defaultApplicationId;
  const timestamp = now();
  const notes = normalizedNotes(fields.notes);
  return applicationSchema.parse({
    id: id(),
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    jobId: fields.jobId,
    status: fields.status ?? 'planned',
    ...(fields.applicationDate !== undefined ? { applicationDate: fields.applicationDate } : {}),
    ...(fields.followUpDate !== undefined ? { followUpDate: fields.followUpDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** Fields a user may change after creation (identity fields are preserved). */
export interface ApplicationPatch {
  status?: ApplicationStatus;
  applicationDate?: string | null;
  followUpDate?: string | null;
  notes?: string | null;
}

/**
 * Apply a patch to an application, preserving `id`/`jobId`/`createdAt` and
 * bumping `updatedAt`. `null` clears an optional field; `undefined` leaves it.
 * Throws only on programmer error (invalid patch values).
 */
export function applyApplicationPatch(
  application: Application,
  patch: ApplicationPatch,
  now: () => string = defaultNow,
): Application {
  const next: Record<string, unknown> = {
    id: application.id,
    schemaVersion: application.schemaVersion,
    jobId: application.jobId,
    status: patch.status ?? application.status,
    createdAt: application.createdAt,
    updatedAt: now(),
  };
  const setOptional = (key: 'applicationDate' | 'followUpDate', value: string | null | undefined): void => {
    if (value === undefined) {
      if (application[key] !== undefined) next[key] = application[key];
      return;
    }
    if (value !== null && value.trim().length > 0) next[key] = value;
    // null / blank clears the field (omitted from the object).
  };
  setOptional('applicationDate', patch.applicationDate);
  setOptional('followUpDate', patch.followUpDate);
  const notes = patch.notes === undefined ? application.notes : normalizedNotes(patch.notes ?? undefined);
  if (notes !== undefined) next.notes = notes;
  return applicationSchema.parse(next);
}

/* ------------------------------------------------------------------ */
/* List helpers (pure, deterministic)                                  */
/* ------------------------------------------------------------------ */

/** Insert or replace by id, keeping the newest first (stable order). */
export function upsertApplicationInList(list: Application[], application: Application): Application[] {
  const idx = list.findIndex((a) => a.id === application.id);
  if (idx === -1) return [application, ...list];
  const next = [...list];
  next[idx] = application;
  return next;
}

/** Remove by id; a no-op (returning a copy) when the id is absent. */
export function removeApplicationFromList(list: Application[], id: string): Application[] {
  return list.filter((a) => a.id !== id);
}

/** The (first) application already tracking `jobId`, if any. */
export function findApplicationForJob(list: Application[], jobId: string): Application | undefined {
  return list.find((a) => a.jobId === jobId);
}
