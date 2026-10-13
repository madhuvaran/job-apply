/**
 * Normalized JobPosting model (schema v1).
 *
 * Scope (Prompt 07 + capture intake of Prompt 08): job title, company,
 * location, original URL, the RAW pasted/visible job description, extracted
 * responsibilities / required+preferred qualifications / skills, experience
 * range, work arrangement, employment type, compensation exactly as posted,
 * source, and capture timestamp.
 *
 * Rules honored:
 * - RAW PRESERVED: `rawDescription` is stored verbatim — never trimmed,
 *   normalized or summarized (only a length cap; empty/whitespace-only is
 *   rejected). Everything else is derived data the user can correct.
 * - UNKNOWN VALUES PRESERVED / NEVER INVENTED: company, location, URL, work
 *   arrangement, employment type, experience range and compensation are all
 *   OPTIONAL. When the posting does not state them (or states something
 *   outside our enums) they stay absent instead of being guessed; the raw
 *   text keeps whatever the poster wrote. Enum values are NOT coerced.
 * - Size limits: raw description <= 100k chars; URL <= 2048 chars and
 *   http/https only; every list is capped (input size guard for storage
 *   quota and UI sanity).
 * - No scraping here: this module is pure (no DOM, no network). Page capture
 *   lives in src/lib/capture.ts; manual intake in entrypoints/options.
 *
 * Storage: `job-postings.v1` record handled by src/lib/storage.ts.
 * The experience-range sub-schema is shared with settings (single source of
 * truth for min/max-years validation, exported from src/lib/settings.ts).
 */
import { z } from 'zod';
import {
  EMPLOYMENT_TYPES,
  ExperienceRangeSchema,
  WORK_MODES,
} from './settings';

export const JOB_POSTING_SCHEMA_VERSION = '1';

export const MAX_RAW_DESCRIPTION_CHARS = 100_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_TEXT_FIELD_CHARS = 200;
export const MAX_URL_CHARS = 2048;
export const MAX_LIST_ITEMS = 60;
export const MAX_LIST_ITEM_CHARS = 1000;
/** Cap for one stored posting list collection. */
export const MAX_POSTINGS = 500;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Original URL: valid URL, http/https only, length-capped. */
export const postingUrlSchema = z
  .url()
  .max(MAX_URL_CHARS)
  .refine((u) => /^https?:\/\//i.test(u), {
    message: 'only http:// or https:// URLs are supported',
  });

const trimmedText = (max: number) => z.string().trim().min(1).max(max);

const TextListSchema = z
  .array(z.string().trim().min(1).max(MAX_LIST_ITEM_CHARS))
  .max(MAX_LIST_ITEMS)
  .default([]);

/* ------------------------------------------------------------------ */
/* JobPosting                                                          */
/* ------------------------------------------------------------------ */

export const jobPostingSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(JOB_POSTING_SCHEMA_VERSION).default(JOB_POSTING_SCHEMA_VERSION),

    title: trimmedText(MAX_TITLE_CHARS),
    company: trimmedText(MAX_TEXT_FIELD_CHARS).optional(),
    location: trimmedText(MAX_TEXT_FIELD_CHARS).optional(),
    originalUrl: postingUrlSchema.optional(),

    /** Verbatim description text as posted/pasted. Never normalized. */
    rawDescription: z
      .string()
      .max(MAX_RAW_DESCRIPTION_CHARS)
      .refine((s) => s.trim().length > 0, { message: 'description must not be empty' }),

    /* --- deterministic extraction (editable, may all be empty) --- */
    responsibilities: TextListSchema,
    requiredQualifications: TextListSchema,
    preferredQualifications: TextListSchema,
    skills: TextListSchema,

    /* --- structured facts, only when explicitly stated --- */
    experienceRange: ExperienceRangeSchema.optional(),
    workArrangement: z.enum(WORK_MODES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    /** Verbatim compensation as the posting states it; absent when not stated. */
    compensation: trimmedText(300).optional(),

    /* --- provenance --- */
    /** 'manual' = typed into the options page; 'page-capture' = popup capture. */
    source: z.enum(['manual', 'page-capture']).default('manual'),
    /** When the posting was captured/saved (ISO 8601). */
    capturedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime().optional(),
  })
  .strict();

export type JobPosting = z.infer<typeof jobPostingSchema>;

/** Per-issue messages for an unvalidated posting draft (empty array = valid). */
export function validateJobPostingInput(value: unknown): string[] {
  const check = jobPostingSchema.safeParse(value);
  if (check.success) return [];
  return check.error.issues.map(
    (iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`,
  );
}

/* ------------------------------------------------------------------ */
/* Storage record (list of postings under one key)                     */
/* ------------------------------------------------------------------ */

export const jobPostingsRecordSchema = z
  .object({
    schemaVersion: z.literal(JOB_POSTING_SCHEMA_VERSION).default(JOB_POSTING_SCHEMA_VERSION),
    postings: z.array(jobPostingSchema).max(MAX_POSTINGS).default([]),
  })
  .strict();

export type JobPostingsRecord = z.infer<typeof jobPostingsRecordSchema>;

export function emptyJobPostingsRecord(): JobPostingsRecord {
  return jobPostingsRecordSchema.parse({});
}

/** Create a posting with generated id + capture timestamp (no invented content). */
export function createJobPosting(
  fields: Omit<z.input<typeof jobPostingSchema>, 'id' | 'schemaVersion' | 'capturedAt' | 'updatedAt'> &
    Partial<Pick<z.input<typeof jobPostingSchema>, 'id' | 'capturedAt' | 'updatedAt'>>,
  now: () => string = () => new Date().toISOString(),
  id: () => string = defaultId,
): JobPosting {
  return jobPostingSchema.parse({
    ...fields,
    id: fields.id ?? id(),
    capturedAt: fields.capturedAt ?? now(),
  });
}

function defaultId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* List helpers (pure)                                                 */
/* ------------------------------------------------------------------ */

/** Insert or replace by id (replace keeps the original capture timestamp). */
export function upsertPostingInList(list: JobPosting[], posting: JobPosting): JobPosting[] {
  const idx = list.findIndex((p) => p.id === posting.id);
  if (idx === -1) return [posting, ...list];
  const next = [...list];
  next[idx] = posting;
  return next;
}

/* ------------------------------------------------------------------ */
/* Deterministic section extraction from description text              */
/* ------------------------------------------------------------------ */

export interface ExtractedSections {
  responsibilities: string[];
  requiredQualifications: string[];
  preferredQualifications: string[];
  skills: string[];
}

const RESPONSIBILITY_HEADINGS = new Set([
  'responsibilities',
  'responsibility',
  'duties',
  'duty',
  "what you'll do",
  'what you will do',
  'the role',
  'role responsibilities',
  'role overview',
  'key responsibilities',
  'about the role',
  'role description',
]);
const REQUIRED_HEADINGS = new Set([
  'requirements',
  'qualification',
  'qualifications',
  'required qualifications',
  'required skills',
  'required experience',
  'minimum qualifications',
  'must-have',
  'must have',
  'what you need',
  'skills and experience',
  'skills & experience',
  'about you',
  'candidate requirements',
  'candidate profile',
  'basic qualifications',
]);
const PREFERRED_HEADINGS = new Set([
  'preferred',
  'preferred qualifications',
  'nice to have',
  'desirable',
  'bonus',
  'bonus points',
  'plus',
  "it's a plus",
  'optional',
  'optional qualifications',
]);
const SKILLS_HEADINGS = new Set([
  'skills',
  'technologies',
  'technology',
  'tech stack',
  'tools',
  'core skills',
  'required technologies',
]);

type SectionName = keyof ExtractedSections;

function normalizeHeading(line: string): string {
  return stripBullet(line)
    .replace(/[’]/g, "'")
    .replace(/[:：]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A heading matches only when the WHOLE line (minus bullet/colon) is a known
 * heading phrase — conservative: "Skills we value: React" is NOT treated as a
 * skills heading (it stops the previous section instead; content stays raw).
 */
function classifyHeading(line: string): SectionName | null {
  const t = normalizeHeading(line);
  if (!t || t.length > 60) return null;
  if (SKILLS_HEADINGS.has(t)) return 'skills';
  if (RESPONSIBILITY_HEADINGS.has(t)) return 'responsibilities';
  if (PREFERRED_HEADINGS.has(t)) return 'preferredQualifications';
  if (REQUIRED_HEADINGS.has(t)) return 'requiredQualifications';
  return null;
}

/** Short "Label: …" / "Label:" line that is NOT a known heading. */
function looksLikeUnknownHeading(line: string): boolean {
  if (line.length > 60) return false;
  const t = stripBullet(line);
  const colon = t.indexOf(':');
  return colon > 0 && colon <= 50;
}

function stripBullet(line: string): string {
  return line.replace(/^[\s]*([-–—•*▪◦→+]|\d+[.)])\s+/, '').trim();
}

/**
 * Deterministic, heading-based extraction of list sections from a pasted job
 * description. CONSERVATIVE by design:
 * - A line is assigned only when it appears under a recognized heading
 *   (responsibilities / requirements / preferred / skills); anything else is
 *   left untouched in the raw description (unknown content is never dropped
 *   from raw, never guessed into a bucket).
 * - Skills lines are additionally split on commas/plus signs for convenience.
 * - Long noisy lines (> MAX_LIST_ITEM_CHARS) are skipped (they remain in raw).
 * Pure: input string in, new arrays out; no mutation.
 */
export function extractJobSections(text: string): ExtractedSections {
  const out: ExtractedSections = {
    responsibilities: [],
    requiredQualifications: [],
    preferredQualifications: [],
    skills: [],
  };
  if (!text) return out;

  const lines = text.split(/\r?\n/);
  let current: SectionName | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const heading = classifyHeading(line);
    if (heading) {
      current = heading;
      continue;
    }
    // An unknown short "Label: …" line is treated as a heading we do NOT
    // recognize: it stops the current section instead of being mis-filed.
    // The line itself stays only in the raw description.
    if (looksLikeUnknownHeading(line)) {
      current = null;
      continue;
    }
    if (current === null) continue;

    const item = stripBullet(line);
    if (item.length === 0 || item.length > MAX_LIST_ITEM_CHARS) continue;

    if (current === 'skills') {
      for (const token of item.split(/\s*[,+·/]\s*/)) {
        const t = token.trim();
        if (t.length > 0 && t.length <= MAX_LIST_ITEM_CHARS && out.skills.length < MAX_LIST_ITEMS) {
          out.skills.push(t);
        }
      }
    } else if (out[current].length < MAX_LIST_ITEMS) {
      out[current].push(item);
    }
  }
  return out;
}
