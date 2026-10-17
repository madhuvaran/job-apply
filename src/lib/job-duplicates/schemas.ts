/**
 * Result contract for deterministic duplicate-job detection (Prompt 26).
 *
 * Every object is `.strict()` and every human-facing string is bounded, so a
 * result can never smuggle page text, captured field values, personal data or a
 * raw exception through a loose field. Explanations are FIXED literals chosen by
 * the reason code — the only job data they may carry is the saved job's own id,
 * title, company and validated URL (never the candidate's page content).
 *
 * URLs reuse the existing `postingUrlSchema`, so a link in a result is always an
 * http(s) URL that already passed the domain validator — no URL parsing is
 * duplicated here.
 *
 * Pure module: no DOM, no browser API, no storage, no network, no AI, no clock.
 */
import { z } from 'zod';
import { postingUrlSchema } from '../job-posting';

export const DUPLICATE_SCHEMA_VERSION = '1';

/** How many matching saved records one result may list (bounded). */
export const MAX_DUPLICATE_MATCHES = 20;
/** Longest accepted identity string (title/company/identifier) in inputs. */
export const MAX_IDENTITY_CHARS = 200;
/**
 * Shortest NORMALIZED identity accepted for the weak company+title rule.
 * Shorter values (e.g. "a") are never used as evidence of a duplicate.
 */
export const MIN_IDENTITY_CHARS = 2;

/**
 * Match methods, in the order the detector applies them (first hit wins):
 * canonical URL → explicit external identifier (same source domain) →
 * normalized company + title (weak, review-only).
 */
export const DUPLICATE_METHODS = ['canonical-url', 'external-id', 'company-title'] as const;
export type DuplicateMethod = (typeof DUPLICATE_METHODS)[number];

export const DUPLICATE_STATUSES = [
  /** No rule matched (or there was nothing to compare). */
  'none',
  /** A trustworthy identity (URL or external id) matched exactly one saved job. */
  'confirmed',
  /** Only the weak company+title rule matched — the user must review it. */
  'possible',
  /** Several saved jobs matched a trustworthy identity; no winner is chosen. */
  'ambiguous',
] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

export const DUPLICATE_REASON_CODES = [
  'same-canonical-url',
  'same-external-id',
  'same-company-and-title',
  'multiple-url-matches',
  'multiple-external-id-matches',
  'no-usable-identity',
  'no-reliable-match',
] as const;
export type DuplicateReasonCode = (typeof DUPLICATE_REASON_CODES)[number];

/**
 * Fixed, privacy-safe explanations. They never quote page content, never quote
 * a captured field value and never embed a raw error.
 */
export const DUPLICATE_REASON_EXPLANATIONS: Readonly<Record<DuplicateReasonCode, string>> = {
  'same-canonical-url':
    'This posting has the same canonical URL as a job you already saved, so it is the same vacancy.',
  'same-external-id':
    'The same job identifier was already saved from this site, so it is the same vacancy.',
  'same-company-and-title':
    'A saved job has the same company and title. It may be the same vacancy posted separately — review it before saving.',
  'multiple-url-matches':
    'Several saved jobs share this canonical URL, so the app cannot tell which one this is. Review them before saving.',
  'multiple-external-id-matches':
    'Several saved jobs share this job identifier from the same site, so the app cannot tell which one this is. Review them before saving.',
  'no-usable-identity':
    'This posting has no URL, no source job identifier and no company with a title, so it cannot be compared with saved jobs.',
  'no-reliable-match':
    'No saved job matched by URL, by source job identifier, or by company and title.',
};

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/**
 * The not-yet-saved posting being checked. Strict: only these bounded identity
 * fields are accepted. `externalId`/`originalUrl` are optional and are never
 * invented by this module (no visible producer supplies an external identifier
 * yet — see README/PROGRESS).
 */
export const duplicateCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_IDENTITY_CHARS),
    company: z.string().trim().min(1).max(MAX_IDENTITY_CHARS).optional(),
    originalUrl: postingUrlSchema.optional(),
    /** A job identifier the SOURCE itself published (never derived/guessed). */
    externalId: z.string().trim().min(1).max(MAX_IDENTITY_CHARS).optional(),
  })
  .strict();
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;

/**
 * A trusted external identifier already known for a SAVED job, together with
 * the source domain it came from. Identifiers are only ever compared inside one
 * domain, so the same id on two different sites can never merge two jobs.
 */
export const savedExternalIdSchema = z
  .object({
    jobId: z.string().min(1).max(MAX_IDENTITY_CHARS),
    /** Host of the source (e.g. `boards.greenhouse.io`), lowercase-normalized. */
    domain: z.string().trim().min(1).max(MAX_IDENTITY_CHARS),
    externalId: z.string().trim().min(1).max(MAX_IDENTITY_CHARS),
  })
  .strict();
export type SavedExternalId = z.infer<typeof savedExternalIdSchema>;

/* ------------------------------------------------------------------ */
/* Lookup options                                                      */
/* ------------------------------------------------------------------ */

/** How many saved job ids one lookup may exclude (bounded). */
export const MAX_EXCLUDED_JOBS = 20;

/**
 * Narrowly scoped options for a lookup. `excludeJobIds` exists so the record
 * being EDITED can be left out of its own duplicate check — nothing else.
 * Strict and bounded like every other input in this module.
 */
export const duplicateLookupOptionsSchema = z
  .object({
    excludeJobIds: z
      .array(z.string().min(1).max(MAX_IDENTITY_CHARS))
      .max(MAX_EXCLUDED_JOBS)
      .optional(),
  })
  .strict();
export type DuplicateLookupOptions = z.infer<typeof duplicateLookupOptionsSchema>;

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

/** One saved job this candidate matched (saved data only — never page text). */
export const duplicateMatchSchema = z
  .object({
    jobId: z.string().min(1).max(MAX_IDENTITY_CHARS),
    title: z.string().min(1).max(MAX_IDENTITY_CHARS),
    company: z.string().min(1).max(MAX_IDENTITY_CHARS).nullable(),
    /** The saved job's re-validated http(s) URL, or null. */
    originalUrl: postingUrlSchema.nullable(),
    method: z.enum(DUPLICATE_METHODS),
  })
  .strict();
export type DuplicateMatch = z.infer<typeof duplicateMatchSchema>;

export const duplicateCheckSchema = z
  .object({
    schemaVersion: z.literal(DUPLICATE_SCHEMA_VERSION),
    /** True for `confirmed`, `possible` and `ambiguous`. */
    duplicate: z.boolean(),
    status: z.enum(DUPLICATE_STATUSES),
    /** The rule that hit, or null when nothing matched. */
    method: z.enum(DUPLICATE_METHODS).nullable(),
    /** Set ONLY for a single confidently identified saved job; else null. */
    jobId: z.string().min(1).max(MAX_IDENTITY_CHARS).nullable(),
    /** True when several saved jobs matched (no winner is chosen). */
    ambiguous: z.boolean(),
    matches: z.array(duplicateMatchSchema).max(MAX_DUPLICATE_MATCHES),
    reasonCode: z.enum(DUPLICATE_REASON_CODES),
    explanation: z.string().min(1).max(300),
    /** How many saved records were compared / could not be used. */
    inspectedJobs: z.number().int().min(0),
    skippedJobs: z.number().int().min(0),
    /** Fail-closed notes (fixed literals; no job or page content). */
    notes: z.array(z.string().min(1).max(300)).max(4),
  })
  .strict();
export type DuplicateCheckResult = z.infer<typeof duplicateCheckSchema>;

export type DuplicateCheckOutcome =
  | { kind: 'valid'; result: DuplicateCheckResult }
  | { kind: 'invalid'; issues: string[] };

export type DuplicateValidation =
  | { ok: true; result: DuplicateCheckResult }
  | { ok: false; issues: string[] };

/* ------------------------------------------------------------------ */
/* Saved job <-> saved job relationship (Prompt 30)                    */
/* ------------------------------------------------------------------ */

/**
 * Relationship between one SAVED job and the OTHER saved jobs, derived from the
 * same three documented rules `findDuplicateJob()` uses (canonical URL →
 * external identifier scoped to its source domain → normalized company +
 * title). It is a READ-ONLY indication: nothing is merged, rewritten or
 * deleted, and a saved record is never removed because it looks equivalent.
 *
 * - `none` — no rule matched another saved record.
 * - `confirmed` — an exact trustworthy identity (canonical URL or source
 *   identifier within the same domain) is shared with exactly one other record.
 * - `ambiguous` — several saved records share that trustworthy identity; no
 *   winner is chosen.
 * - `possible` — only the weak company+title rule matched; the user must verify.
 */
export const SAVED_DUPLICATE_STATUSES = ['none', 'confirmed', 'possible', 'ambiguous'] as const;
export type SavedDuplicateStatus = (typeof SAVED_DUPLICATE_STATUSES)[number];

/**
 * The saved-vs-saved indication carried by a priority entry / dashboard row.
 * `equivalentJobIds` lists the OTHER saved job ids only (sorted ascending,
 * bounded) — never titles, companies or text, so a result can never echo saved
 * page content.
 */
export const savedDuplicateIndicationSchema = z
  .object({
    status: z.enum(SAVED_DUPLICATE_STATUSES),
    /** The rule that produced the indication, or null for `none`. */
    method: z.enum(DUPLICATE_METHODS).nullable(),
    equivalentJobIds: z
      .array(z.string().min(1).max(MAX_IDENTITY_CHARS))
      .max(MAX_DUPLICATE_MATCHES),
  })
  .strict();
export type SavedDuplicateIndication = z.infer<typeof savedDuplicateIndicationSchema>;

/** Validate an untrusted object against the strict result schema. */
export function validateDuplicateCheck(payload: unknown): DuplicateValidation {
  const parsed = duplicateCheckSchema.safeParse(payload);
  if (parsed.success) return { ok: true, result: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.code}`,
    ),
  };
}
