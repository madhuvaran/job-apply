/**
 * Profile + evidence model, schema version 2 (AI-safe professional profile).
 *
 * Design rules (knowledge.md):
 * - No invented data: every skill can carry an evidence reference back to
 *   profile content the candidate actually provided.
 * - Optional-friendly: almost everything is optional. An absent field is
 *   information ("candidate does not have / did not provide"), never guessed.
 * - Sensitive separation: contact details, sensitive answers and documents live
 *   in a SEPARATE schema (src/lib/sensitive.ts) and are never projected into the
 *   AI-safe profile below.
 *
 * Storage keys (migration-compatible, see src/lib/storage.ts):
 *   job-profile.v2            -> Profile (AI-safe professional profile)
 *   job-profile.sensitive.v2  -> SensitiveProfile (contact + legal + documents)
 *   job-profile               -> legacy starter profile, kept readable for migration
 *
 * No defaults for candidate details are hardcoded anywhere. All defaults are
 * empty containers or the schema-version marker itself.
 */
import { z } from 'zod';

export const PROFILE_SCHEMA_VERSION = '2';
export const SENSITIVE_PROFILE_SCHEMA_VERSION = '2';

/* ------------------------------------------------------------------ */
/* Shared primitives                                                    */
/* ------------------------------------------------------------------ */

/** Month precision. `${year}-${month 01-12}` — e.g. "2024-03". */
const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM (month 01-12), got: $value');

/** Full date of a verifiable achievement, e.g. certification issue date. */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'expected YYYY-MM-DD, got: $value');

const urlSchema = z.url().max(2048);

/**
 * Where an item's evidence comes from (used by skills and generated claims).
 * Exported (Prompt 11) so the resume-tailoring result can carry the SAME
 * reference shape instead of duplicating a competing schema.
 */
export const EvidenceRefSchema = z
  .object({
    /** e.g. "experience", "education", "certification", "project", "profile". */
    kind: z.enum(['experience', 'education', 'certification', 'project', 'profile', 'document', 'answer']),
    /** id of the matching item in this profile (experience item id, etc.). */
    id: z.string().min(1),
    /** Optional quote extracted from the referenced source. */
    quote: z.string().min(1).optional(),
  })
  .strict();

/** Verified skill. Identifiable so lists (editor UI, evidence links) can address items by id. */
const SkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Years the candidate says they have used it. Loose: "0", "3", "3.5" as number. */
    years: z.number().min(0).max(50).optional(),
    /** "verified" = candidate supplied an evidenceRef; "claimed" otherwise. */
    status: z.enum(['claimed', 'verified']).default('claimed'),
    evidenceRef: EvidenceRefSchema.optional(),
  })
  .strict();

/** Experience/education period. Ongoing positions use end = null, never a fake present date. */
const DateRangeSchema = z
  .object({ start: monthSchema, end: monthSchema.nullable() })
  .strict()
  .refine((r) => r.end === null || r.end >= r.start, {
    message: 'end must be >= start (or null)',
  });

/* ------------------------------------------------------------------ */
/* Profile sections                                                     */
/* ------------------------------------------------------------------ */

const ExperienceSchema = z
  .object({
    id: z.string().min(1),
    company: z.string().min(1),
    title: z.string().min(1),
    location: z.string().min(1).optional(),
    dates: DateRangeSchema,
    /** Verified accomplishments as the candidate wrote them. No invention allowed downstream. */
    bullets: z.array(z.string().min(1)).min(1),
    /** As the candidate declares it; never inferred. */
    seniority: z
      .enum(['intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'staff'])
      .optional(),
  })
  .strict();

const EducationSchema = z
  .object({
    id: z.string().min(1),
    institution: z.string().min(1),
    /** Free text: "B.Sc. Computer Science", "Bootcamp certificate". */
    credential: z.string().min(1).optional(),
    fieldOfStudy: z.string().min(1).optional(),
    grade: z.string().min(1).optional(),
    inProgress: z.boolean().default(false),
    dates: DateRangeSchema,
  })
  .strict();

const CertificationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    issuer: z.string().min(1).optional(),
    /** Optional: some candidates cannot recall the exact issue date. */
    issued: isoDateSchema.optional(),
    /** Optional: some certs have no public verification URL. */
    credentialUrl: urlSchema.optional(),
    expires: isoDateSchema.optional(),
  })
  .strict();

const ProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    url: urlSchema.optional(),
    /** Repo, case study, demo… */
    links: z.array(urlSchema).max(10).default([]),
    skills: z.array(SkillSchema).max(30).default([]),
    dates: DateRangeSchema.optional(),
  })
  .strict();

const LanguagesSchema = z
  .object({
    language: z.string().min(1),
    level: z.enum(['basic', 'intermediate', 'advanced', 'fluent', 'native']),
  })
  .strict();

const ApplicationAnswerSchema = z
  .object({
    id: z.string().min(1),
    /** The exact question text as the candidate typed/saved it. */
    question: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();

const PreferencesSchema = z
  .object({
    /** Titles the candidate wants. Never guessed. */
    targetTitles: z.array(z.string().min(1)).max(25).default([]),
    willingToRelocate: z.boolean().default(false),
    willingToTravelPercent: z.number().min(0).max(100).optional(),
    workModes: z.array(z.enum(['onsite', 'hybrid', 'remote'])).max(3).default([]),
    /** Locations the candidate is looking at, exactly as they stated them. */
    targetLocations: z.array(z.string().min(1)).max(25).default([]),
    /** Explicitly user-provided boilerplate answers ("Why do you want to work here?"). */
    applicationAnswers: z.array(ApplicationAnswerSchema).max(50).default([]),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Top-level AI-safe profile                                            */
/* ------------------------------------------------------------------ */

export const profileSchema = z
  .object({
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION).default(PROFILE_SCHEMA_VERSION),
    /** One-line headline the candidate wrote ("Senior Backend Engineer"). */
    headline: z.string().min(1).max(120).optional(),
    /** Candidate-written professional summary. */
    summary: z.string().min(1).max(2000).optional(),
    /** How the candidate wants to be listed on a resume ("First Last" or preferred form). */
    displayName: z.string().min(1).max(100).optional(),
    /** Free text the candidate wants shown, e.g. "Berlin, DE (Remote)". NOT parsed into city/country. */
    locationLabel: z.string().min(1).max(100).optional(),
    skills: z.array(SkillSchema).max(200).default([]),
    experience: z.array(ExperienceSchema).max(40).default([]),
    education: z.array(EducationSchema).max(20).default([]),
    certifications: z.array(CertificationSchema).max(30).default([]),
    projects: z.array(ProjectSchema).max(30).default([]),
    languages: z.array(LanguagesSchema).max(20).default([]),
    portfolio: urlSchema.optional(),
    github: urlSchema.optional(),
    linkedin: urlSchema.optional(),
    preferences: PreferencesSchema.prefault({
      targetTitles: [],
      willingToRelocate: false,
      workModes: [],
      targetLocations: [],
      applicationAnswers: [],
    }),
    updatedAt: z.iso.datetime().optional(),
  })
  .strict();

export type Profile = z.infer<typeof profileSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Experience = z.infer<typeof ExperienceSchema>;
export type Education = z.infer<typeof EducationSchema>;
export type Certification = z.infer<typeof CertificationSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Language = z.infer<typeof LanguagesSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type ApplicationAnswer = z.infer<typeof ApplicationAnswerSchema>;
export type DateRange = z.infer<typeof DateRangeSchema>;
