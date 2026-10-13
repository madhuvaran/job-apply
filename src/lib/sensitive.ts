/**
 * Sensitive profile, schema version 2 (stored SEPARATELY from the AI-safe profile).
 *
 * Nothing in this file may ever be projected into an LLM prompt:
 * contact details, legal/EEO answers, sponsorship needs, documents.
 * Knowledge.md: "Never send phone, email, address, compensation or voluntary
 * disclosures to any LLM" and "Legal/EEO answers come from the saved profile
 * only, never from an LLM."
 *
 * Everything is optional — legal/EEO questions are only ever filled if the
 * candidate explicitly saved an answer; otherwise they are left blank and
 * flagged for review.
 *
 * Storage key: job-profile.sensitive.v2 (see src/lib/storage.ts).
 */
import { z } from 'zod';

export const SENSITIVE_SCHEMA_VERSION = '2';

const urlSchema = z.url().max(2048);

const ContactSchema = z
  .object({
    /** Legal/first name as it should appear on official forms. */
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.email().max(254),
    phone: z.string().min(3).max(32),
    /** Free text, never parsed into components. */
    address: z.string().min(1).max(400).optional(),
    /** City/country label for location-relevant matching. Still never sent to LLM. */
    cityLabel: z.string().min(1).max(100).optional(),
  })
  .strict();

/** Work authorization / sponsorship needs (US-centric naming, extendable). */
const LegalSchema = z
  .object({
    workAuthorization: z.enum([
      'citizen',
      'permanent_resident',
      'authorized_needs_sponsorship',
      'authorized_no_sponsorship',
      'other',
      'undisclosed',
    ]),
    sponsorshipNeeded: z.boolean(),
    /** Free text only if the candidate chose "other" and typed something. */
    otherWorkAuthorizationNote: z.string().min(1).max(500).optional(),
  })
  .strict();

/** Voluntary demographic / EEO answers. Only ever filled from storage, never from an LLM. */
const VoluntarySchema = z
  .object({
    gender: z.enum(['female', 'male', 'non_binary', 'self_describe', 'undisclosed']),
    genderSelfDescribe: z.string().min(1).max(100).optional(),
    raceEthnicity: z.array(
      z.enum([
        'american_indian_or_alaska_native',
        'asian',
        'black_or_african_american',
        'hispanic_or_latino',
        'native_hawaiian_or_other_pacific_islander',
        'white',
        'two_or_more',
        'undisclosed',
      ]),
    ),
    veteranStatus: z.enum([
      'no',
      'disabled_veteran',
      'recently_separated',
      'active_duty',
      'other_veteran',
      'undisclosed',
    ]),
    disabilityStatus: z.enum(['yes', 'no', 'prefer_not_say', 'undisclosed']),
  })
  .strict();

/** Documents the candidate explicitly allowed the extension to use. */
const DocumentsSchema = z
  .object({
    /** Compensation expectations. Never sent to any LLM. */
    compensationExpectation: z.string().min(1).max(100).optional(),
    /** Government identifiers. Only stored locally, never sent anywhere, never displayed by default. */
    governmentIdMasked: z.string().max(32).optional(),
    notesAboutMe: z.string().max(2000).optional(),
  })
  .strict();

export const sensitiveProfileSchema = z
  .object({
    schemaVersion: z.literal(SENSITIVE_SCHEMA_VERSION).default(SENSITIVE_SCHEMA_VERSION),
    contact: ContactSchema,
    legal: LegalSchema,
    voluntary: VoluntarySchema,
    documents: DocumentsSchema.prefault({
      compensationExpectation: undefined,
      governmentIdMasked: undefined,
      notesAboutMe: undefined,
    }),
  })
  .strict();

export type SensitiveProfile = z.infer<typeof sensitiveProfileSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Legal = z.infer<typeof LegalSchema>;
export type Voluntary = z.infer<typeof VoluntarySchema>;
export type Documents = z.infer<typeof DocumentsSchema>;
