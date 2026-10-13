/**
 * Output contract for the deterministic resume tailoring engine (Prompt 11).
 *
 * Every schema is `.strict()`: unknown keys cannot ride into a rendered
 * resume, and every field is either a VERBATIM projection of the AI-safe
 * profile (same values, same ids — see `tailorResume`) or a deterministic,
 * non-factual annotation (relevance tier / reason / selection notes) that
 * makes no claim about the candidate.
 *
 * Truthfulness rules encoded HERE (enforced by construction + tests):
 * - No field exists for invented metrics/achievements/employers/dates; the
 *   result can only carry profile-shaped content plus bounded annotations.
 * - `status` (claimed/verified) and `evidenceRef` are copied from the
 *   profile verbatim — a claimed skill can never be output as verified.
 * - Selection item ids equal the PROFILE item ids, so every selected item
 *   traces back to its source record (reviewer/UI can diff against
 *   `job-profile.v2`).
 * - No contact details, legal/voluntary answers, compensation, or job-
 *   description text beyond the posting's id/title/capture date (which the
 *   result is tailored FOR).
 *
 * Pure module: no DOM, no network, no storage, no clock, no sensitive data.
 */
import { z } from 'zod';
import { EvidenceRefSchema } from '../profile';
import { MAX_TITLE_CHARS } from '../job-posting';

export const TAILORED_RESUME_SCHEMA_VERSION = '1';

/** Hard caps (documented, deterministic; profile lists are larger). */
export const MAX_SELECTED_SKILLS = 24;
/** Neutral (non-job-matched) skill fill target — keeps tailoring focused. */
export const SKILL_FILL_TARGET = 12;
export const MAX_SELECTED_PROJECTS = 12;
export const MAX_SELECTION_NOTES = 12;

export const RESUME_RELEVANCE = ['required', 'preferred', 'neutral'] as const;
export type ResumeRelevance = (typeof RESUME_RELEVANCE)[number];

/** Why an experience/project entry was selected (annotation, not a claim). */
export const SELECTION_REASONS = ['relevant', 'fallback'] as const;
export type SelectionReason = (typeof SELECTION_REASONS)[number];

/* ------------------------------------------------------------------ */
/* Header / summary / links                                            */
/* ------------------------------------------------------------------ */

/** Resume header — resume-appropriate identity fields only (no contact data). */
export const resumeHeaderSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    headline: z.string().min(1).max(120).optional(),
    locationLabel: z.string().min(1).max(100).optional(),
  })
  .strict();
export type ResumeHeader = z.infer<typeof resumeHeaderSchema>;

/**
 * Professional summary. `basis` records WHICH profile fields were assembled
 * (deterministic selection, verbatim wording); `sourceIds` carries profile
 * ids when skills were used. Never generated prose about the candidate.
 */
export const tailoredSummarySchema = z
  .object({
    basis: z.enum(['profile-summary', 'profile-headline', 'profile-skills']),
    text: z.string().min(1).max(4000),
    sourceIds: z.array(z.string().min(1).max(80)).max(MAX_SELECTED_SKILLS).default([]),
  })
  .strict();
export type TailoredSummary = z.infer<typeof tailoredSummarySchema>;

export const resumeLinksSchema = z
  .object({
    portfolio: z.url().max(2048).optional(),
    github: z.url().max(2048).optional(),
    linkedin: z.url().max(2048).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** A selected profile skill — verbatim fields + a deterministic relevance tier. */
export const tailoredSkillSchema = z
  .object({
    /** Equals the profile skill id (traceable to `job-profile.v2`). */
    profileSkillId: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    /** Copied VERBATIM from the profile: 'claimed' stays 'claimed'. */
    status: z.enum(['claimed', 'verified']),
    years: z.number().min(0).max(50).optional(),
    evidenceRef: EvidenceRefSchema.optional(),
    /** Why it is on this resume: matched a posting requirement, or not. */
    relevance: z.enum(RESUME_RELEVANCE),
    /**
     * Canonical job-skill label this skill matched (e.g. 'Kubernetes' for a
     * profile skill 'k8s'). Present ONLY for required/preferred matches —
     * this documents the LINK, it never asserts possession of an
     * unlisted posting skill.
     */
    matchedJobSkill: z.string().min(1).max(120).optional(),
  })
  .strict();
export type TailoredSkill = z.infer<typeof tailoredSkillSchema>;

/** A selected experience entry — all factual fields copied verbatim. */
export const tailoredExperienceSchema = z
  .object({
    id: z.string().min(1),
    company: z.string().min(1),
    title: z.string().min(1),
    location: z.string().min(1).optional(),
    dates: z
      .object({ start: z.string(), end: z.string().nullable() })
      .strict(),
    seniority: z
      .enum(['intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'staff'])
      .optional(),
    /** The profile's existing bullets, verbatim and in source order. */
    bullets: z.array(z.string().min(1)),
    /** 'relevant' = overlap with the posting; 'fallback' = no overlap found. */
    relevance: z.enum(SELECTION_REASONS),
    /** Deterministic, non-factual annotation (<= 200 chars). */
    reason: z.string().min(1).max(200),
  })
  .strict();
export type TailoredExperience = z.infer<typeof tailoredExperienceSchema>;

export const tailoredProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    url: z.url().max(2048).optional(),
    links: z.array(z.url().max(2048)).max(10),
    /** Project skills projected verbatim (id/name/status only). */
    skills: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          status: z.enum(['claimed', 'verified']),
        })
        .strict(),
    ),
    dates: z
      .object({ start: z.string(), end: z.string().nullable() })
      .strict()
      .optional(),
    relevance: z.enum(SELECTION_REASONS),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type TailoredProject = z.infer<typeof tailoredProjectSchema>;

/** Education is copied verbatim and ALWAYS included when present (credentials
 *  are never dropped — omission could misrepresent the candidate). */
export const tailoredEducationSchema = z
  .object({
    id: z.string().min(1),
    institution: z.string().min(1),
    credential: z.string().min(1).optional(),
    fieldOfStudy: z.string().min(1).optional(),
    grade: z.string().min(1).optional(),
    inProgress: z.boolean(),
    dates: z.object({ start: z.string(), end: z.string().nullable() }).strict(),
  })
  .strict();
export type TailoredEducation = z.infer<typeof tailoredEducationSchema>;

export const tailoredCertificationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    issuer: z.string().min(1).optional(),
    issued: z.string().optional(),
    credentialUrl: z.url().max(2048).optional(),
    expires: z.string().optional(),
  })
  .strict();
export type TailoredCertification = z.infer<typeof tailoredCertificationSchema>;

export const tailoredLanguageSchema = z
  .object({
    language: z.string().min(1),
    level: z.enum(['basic', 'intermediate', 'advanced', 'fluent', 'native']),
  })
  .strict();
export type TailoredLanguage = z.infer<typeof tailoredLanguageSchema>;

/* ------------------------------------------------------------------ */
/* Top-level result                                                    */
/* ------------------------------------------------------------------ */

/** Provenance: which posting this content was tailored for. */
export const tailoredSourceSchema = z
  .object({
    jobId: z.string().min(1).max(80),
    jobTitle: z.string().min(1).max(MAX_TITLE_CHARS),
    jobCapturedAt: z.iso.datetime(),
  })
  .strict();

/**
 * The tailored resume content — a strictly validated, PDF-renderer-ready
 * data shape (rendering is a LATER task; no ATS pass is claimed).
 */
export const tailoredResumeSchema = z
  .object({
    schemaVersion: z.literal(TAILORED_RESUME_SCHEMA_VERSION),
    source: tailoredSourceSchema,
    /** Omitted when the profile provides no header fields. */
    header: resumeHeaderSchema.optional(),
    /** Omitted when no supported summary source exists (never fabricated). */
    summary: tailoredSummarySchema.optional(),
    skills: z.array(tailoredSkillSchema).max(MAX_SELECTED_SKILLS),
    experience: z.array(tailoredExperienceSchema).max(40),
    projects: z.array(tailoredProjectSchema).max(MAX_SELECTED_PROJECTS),
    education: z.array(tailoredEducationSchema).max(20),
    certifications: z.array(tailoredCertificationSchema).max(30),
    languages: z.array(tailoredLanguageSchema).max(20),
    /** Omitted when the profile has no links. */
    links: resumeLinksSchema.optional(),
    /** Deterministic, count-only selection notes (no profile text). */
    selectionNotes: z.array(z.string().min(1).max(200)).max(MAX_SELECTION_NOTES),
  })
  .strict();
export type TailoredResume = z.infer<typeof tailoredResumeSchema>;

export type TailoredResumeValidation =
  | { ok: true; resume: TailoredResume }
  | { ok: false; issues: string[] };

/** Validate an untrusted object against the strict resume schema. */
export function validateTailoredResume(payload: unknown): TailoredResumeValidation {
  const parsed = tailoredResumeSchema.safeParse(payload);
  if (parsed.success) return { ok: true, resume: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.code}`,
    ),
  };
}
