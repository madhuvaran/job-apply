/**
 * Imported-job candidates (Prompt 29) — the narrow bridge between the Job Search
 * interface and the EXISTING job-posting model.
 *
 * A candidate is the validated draft the user reviews before anything is
 * written. It is intentionally built FROM the job-posting model's own
 * primitives (same URL validator, same posting-date validator, same length caps,
 * same `createJobPosting()` on the way out) rather than being a second job
 * schema: `toJobPosting()` always re-validates through `jobPostingSchema`, which
 * stays the authority.
 *
 * Two producers:
 * - `buildManualImportCandidate(form)` — what the user typed into the import
 *   form. Source is always `manual`, and a description is REQUIRED so a record
 *   can never exist with no text at all.
 * - `candidateFromNormalizedJob(result)` — a normalized PROVIDER result. Source
 *   is `provider-search`, `provider`/`externalId` are preserved exactly, and the
 *   description is ALWAYS marked `snippet`: a 500-character provider excerpt
 *   must never present itself as a complete posting.
 *
 * Rules honored (knowledge.md):
 * - MISSING STAYS MISSING — every optional field is only present when the input
 *   actually supplied it. Nothing is back-filled, guessed or defaulted into
 *   existence.
 * - NO FABRICATION — a provider result without a description cannot be turned
 *   into a posting (typed failure instead), and a salary is written as the
 *   provider's own numbers with an explicit note that no currency was stated.
 * - NO NETWORK — this module is pure: no DOM, no storage, no fetch, no AI, no
 *   clock (the posting's timestamp is injected).
 */
import { z } from 'zod';
import { postingDateSchema } from '../job-dates';
import {
  createJobPosting,
  JOB_DESCRIPTION_KINDS,
  JOB_SOURCES,
  MAX_EXTERNAL_ID_CHARS,
  MAX_PROVIDER_CHARS,
  MAX_RAW_DESCRIPTION_CHARS,
  MAX_TEXT_FIELD_CHARS,
  MAX_TITLE_CHARS,
  postingUrlSchema,
  type JobDescriptionKind,
  type JobPosting,
  type JobSource,
} from '../job-posting';
import type { NormalizedJobResult, SalaryRange } from './schemas';

/* ------------------------------------------------------------------ */
/* The candidate schema                                                */
/* ------------------------------------------------------------------ */

/**
 * The strict draft a user reviews before saving.
 *
 * Same shape as the job-posting fields it feeds, so `createJobPosting()` accepts
 * it verbatim and a candidate can never carry a key the posting model rejects.
 */
export const importCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
    company: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    location: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    originalUrl: postingUrlSchema.optional(),
    /** Kept VERBATIM — never trimmed, normalized or summarized. */
    rawDescription: z
      .string()
      .max(MAX_RAW_DESCRIPTION_CHARS)
      .refine((s) => s.trim().length > 0, { message: 'description must not be empty' }),
    descriptionKind: z.enum(JOB_DESCRIPTION_KINDS).default('full'),
    postedDate: postingDateSchema.optional(),
    compensation: z.string().trim().min(1).max(300).optional(),
    source: z.enum(JOB_SOURCES).default('manual'),
    provider: z.string().trim().min(1).max(MAX_PROVIDER_CHARS).optional(),
    externalId: z.string().trim().min(1).max(MAX_EXTERNAL_ID_CHARS).optional(),
  })
  .strict();

export type JobImportCandidate = z.infer<typeof importCandidateSchema>;

/* ------------------------------------------------------------------ */
/* Issues                                                              */
/* ------------------------------------------------------------------ */

export type JobImportField =
  | 'title'
  | 'company'
  | 'location'
  | 'originalUrl'
  | 'rawDescription'
  | 'descriptionKind'
  | 'unknown';

export interface JobImportIssue {
  field: JobImportField;
  /** Fixed, user-facing message. Never quotes the offending value. */
  message: string;
}

const ISSUE_FIELD_BY_PATH: Readonly<Record<string, JobImportField>> = {
  title: 'title',
  company: 'company',
  location: 'location',
  originalUrl: 'originalUrl',
  rawDescription: 'rawDescription',
  descriptionKind: 'descriptionKind',
};

function issueFor(path: string, fallback: JobImportField): JobImportIssue {
  const field = ISSUE_FIELD_BY_PATH[path] ?? fallback;
  const message = FIX_MESSAGES[field] ?? 'That value is not supported.';
  return { field, message };
}

/** Fixed messages per field — one literal, never interpolated with input. */
const FIX_MESSAGES: Readonly<Record<JobImportField, string>> = {
  title: 'Enter the job title.',
  company: 'Company name is too long.',
  location: 'Location is too long.',
  originalUrl:
    'Enter a valid listing URL beginning with http:// or https:// — other link types are not accepted.',
  rawDescription: 'Paste the job description or an excerpt so the job can be identified.',
  descriptionKind: 'Say whether the text you pasted is the full description or an excerpt.',
  unknown: 'That value is not supported.',
};

export type JobImportBuildResult =
  | { ok: true; candidate: JobImportCandidate }
  | { ok: false; issues: JobImportIssue[] };

/** A user-facing message per build failure (fixed literals only). */
export function messageForImportIssues(issues: readonly JobImportIssue[]): string {
  return issues.map((i) => i.message).join(' ');
}

/* ------------------------------------------------------------------ */
/* Manual import                                                       */
/* ------------------------------------------------------------------ */

/** Raw form values, exactly as the inputs hold them. */
export interface JobImportForm {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  /** `''` until the user states whether the pasted text is complete or partial. */
  descriptionKind: '' | JobDescriptionKind;
}

export const EMPTY_JOB_IMPORT_FORM: JobImportForm = {
  title: '',
  company: '',
  location: '',
  url: '',
  description: '',
  descriptionKind: '',
};

export function resetJobImportForm(): JobImportForm {
  return { ...EMPTY_JOB_IMPORT_FORM };
}

const MAX_URL_CHARS_IMPORT = 2048;

/** Friendly, per-field validation for the manual import form. */
export function validateJobImportForm(form: JobImportForm): JobImportIssue[] {
  const issues: JobImportIssue[] = [];

  const title = form.title.trim();
  if (title.length === 0) issues.push({ field: 'title', message: FIX_MESSAGES.title });
  else if (title.length > MAX_TITLE_CHARS) issues.push({ field: 'title', message: FIX_MESSAGES.title });

  const description = form.description;
  if (description.trim().length === 0) {
    issues.push({ field: 'rawDescription', message: FIX_MESSAGES.rawDescription });
  } else if (description.length > MAX_RAW_DESCRIPTION_CHARS) {
    issues.push({ field: 'rawDescription', message: FIX_MESSAGES.rawDescription });
  }

  if (form.descriptionKind === '') {
    issues.push({ field: 'descriptionKind', message: FIX_MESSAGES.descriptionKind });
  }

  const url = form.url.trim();
  if (url.length > 0) {
    // The SAME validator the job-posting model uses: http/https only, so
    // javascript:/data:/file: links are rejected here, never fetched.
    if (!postingUrlSchema.safeParse(url).success || url.length > MAX_URL_CHARS_IMPORT) {
      issues.push({ field: 'originalUrl', message: FIX_MESSAGES.originalUrl });
    }
  }

  if (form.company.trim().length > MAX_TEXT_FIELD_CHARS) {
    issues.push({ field: 'company', message: FIX_MESSAGES.company });
  }
  if (form.location.trim().length > MAX_TEXT_FIELD_CHARS) {
    issues.push({ field: 'location', message: FIX_MESSAGES.location });
  }

  return issues;
}

/** Form → strict candidate (the schema is the authority once checks pass). */
export function buildImportCandidate(form: JobImportForm): JobImportBuildResult {
  const friendly = validateJobImportForm(form);
  if (friendly.length > 0) return { ok: false, issues: friendly };

  const company = form.company.trim();
  const location = form.location.trim();
  const url = form.url.trim();

  const input: Record<string, unknown> = {
    title: form.title.trim(),
    // Description is passed VERBATIM (the raw-preservation rule).
    rawDescription: form.description,
    descriptionKind: form.descriptionKind,
    source: 'manual',
  };
  if (company !== '') input['company'] = company;
  if (location !== '') input['location'] = location;
  if (url !== '') input['originalUrl'] = url;

  const parsed = importCandidateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((iss) =>
        issueFor(iss.path.map(String).join('.'), 'unknown'),
      ),
    };
  }
  return { ok: true, candidate: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Provider result → candidate                                         */
/* ------------------------------------------------------------------ */

/**
 * The salary line as it will appear in the posting's verbatim compensation
 * field. The provider's own numbers are kept and the currency gap is stated
 * outright — a symbol is never chosen on the provider's behalf.
 */
export function providerSalaryText(salary: SalaryRange): string | undefined {
  const { min, max, predicted } = salary;
  if (min === undefined && max === undefined) return undefined;
  let text: string;
  if (min !== undefined && max !== undefined) text = `${min} - ${max}`;
  else if (min !== undefined) text = `${min} or more`;
  else text = `up to ${max ?? 0}`;
  text += ' (currency not stated by the search provider)';
  if (predicted === true) text += '; estimated by the provider, not advertised';
  return text;
}

export type ProviderCandidateResult =
  | { ok: true; candidate: JobImportCandidate }
  | { ok: false; issues: JobImportIssue[] };

/**
 * Deterministic mapping from a VALIDATED normalized provider result to a
 * reviewable candidate.
 *
 * Preserves `provider` and `externalId` exactly (they are the source's own
 * identifiers), keeps the listing URL it validated for us, marks the description
 * `snippet`, and never invents a missing company, location, date or salary. A
 * result with no description is refused rather than padded — the posting model
 * requires text, and a made-up sentence is not an option.
 */
export function candidateFromNormalizedJob(job: NormalizedJobResult): ProviderCandidateResult {
  if (job.description === undefined) {
    return {
      ok: false,
      issues: [
        {
          field: 'rawDescription',
          message:
            'This search result carries no description excerpt, so it cannot be saved as a job.',
        },
      ],
    };
  }

  const input: Record<string, unknown> = {
    title: job.title,
    rawDescription: job.description,
    descriptionKind: 'snippet',
    source: 'provider-search',
    provider: job.provider,
    externalId: job.externalId,
  };
  if (job.company !== undefined) input['company'] = job.company;
  if (job.location !== undefined) input['location'] = job.location;
  if (job.postedDate !== undefined) input['postedDate'] = job.postedDate;
  input['originalUrl'] = job.url;
  if (job.salary !== undefined) {
    const compensation = providerSalaryText(job.salary);
    if (compensation !== undefined) input['compensation'] = compensation;
  }

  const parsed = importCandidateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((iss) =>
        issueFor(iss.path.map(String).join('.'), 'unknown'),
      ),
    };
  }
  return { ok: true, candidate: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Identity + posting                                                  */
/* ------------------------------------------------------------------ */

/**
 * The ONLY fields the duplicate detector is given: it takes a `.strict()` object
 * (title/company/originalUrl/externalId), so handing it the whole candidate
 * would be rejected. Nothing else about the job influences the check.
 */
export interface JobImportIdentity {
  title: string;
  company?: string;
  originalUrl?: string;
  externalId?: string;
}

export function identityForDuplicateCheck(candidate: JobImportCandidate): JobImportIdentity {
  return {
    title: candidate.title,
    ...(candidate.company !== undefined ? { company: candidate.company } : {}),
    ...(candidate.originalUrl !== undefined ? { originalUrl: candidate.originalUrl } : {}),
    ...(candidate.externalId !== undefined ? { externalId: candidate.externalId } : {}),
  };
}

/**
 * Candidate → stored posting, re-validated by the job-posting schema itself.
 * `id`/`capturedAt` are minted by `createJobPosting()` (injected clock), never
 * carried in a candidate.
 */
export function toJobPosting(
  candidate: JobImportCandidate,
  now?: () => string,
  id?: () => string,
): JobPosting {
  // Passing `undefined` lets `createJobPosting` apply its own defaults — the id
  // and timestamp still come from there, never from a candidate.
  return createJobPosting(candidate, now, id);
}
