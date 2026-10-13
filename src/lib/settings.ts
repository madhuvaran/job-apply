/**
 * Settings model (schema v1) — job-search preferences + privacy switches.
 *
 * Scope (Prompt 05): target titles, target locations, remote/hybrid/on-site
 * preferences, employment types, experience range, salary preference (only if
 * the user provides it), excluded employers, minimum match threshold, resume
 * format, and AI enabled/disabled — plus the privacy explanation of what stays
 * local versus what may be sent to a configured AI provider.
 *
 * Design rules honored here:
 * - CONSERVATIVE DEFAULTS: no targeting is assumed (empty lists), nothing is
 *   filtered (threshold 0 = off), no experience/salary constraint is invented
 *   (absent = "not specified"), and AI is OFF by default so no data leaves
 *   the device until the user opts in.
 * - NO SENSITIVE/LEGAL INFERENCE: this schema contains no work-authorization,
 *   sponsorship, demographic, criminal-history or other legal-eligibility
 *   fields, and `.strict()` parsing rejects any attempt to store unknown keys
 *   (e.g. an injected `workAuthorization` field fails validation).
 * - COMPENSATION STAYS LOCAL: `salary` is stored in `chrome.storage.local`
 *   only. `settingsForProvider()` strips it so a future provider call cannot
 *   carry compensation to an LLM (rule: never send compensation to an LLM).
 * - SINGLE SOURCE OF TRUTH for job-search targeting: `targetTitles`,
 *   `targetLocations` and `workModes` moved here from `profile.preferences`.
 *   Existing profile values are copied ONCE, non-destructively, by
 *   `migrateSettingsFromProfile()` in storage.ts; the profile record itself is
 *   never modified or deleted by that migration.
 * - MATCH THRESHOLD HONESTY: `minMatchThreshold` applies to the extension's
 *   own transparent resume-to-job match estimate. It is NOT an employer's ATS
 *   score and no employer score is ever claimed or known (rule 6).
 *
 * Storage access lives in src/lib/storage.ts (key `job-settings.v1`); this
 * module is framework-free and fully unit-testable.
 */
import { z } from 'zod';
import type { Preferences } from './profile';

export const SETTINGS_SCHEMA_VERSION = '1';

/** Remote/hybrid/on-site. Mirrors the workModes enum in profile.ts PreferencesSchema. */
export const WORK_MODES = ['onsite', 'hybrid', 'remote'] as const;
export const EMPLOYMENT_TYPES = [
  'full-time',
  'part-time',
  'contract',
  'internship',
  'temporary',
] as const;
/** ATS-safe fixed PDF is the roadmap default; DOCX offered as the alternative. */
export const RESUME_FORMATS = ['pdf', 'docx'] as const;

export type WorkMode = (typeof WORK_MODES)[number];
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type ResumeFormat = (typeof RESUME_FORMATS)[number];

/* ------------------------------------------------------------------ */
/* Sub-schemas                                                         */
/* ------------------------------------------------------------------ */

/**
 * Years-of-experience filter. OPTIONAL: absent = "no experience constraint"
 * (the extension never assumes how senior the candidate is). When present at
 * least one bound must be set, bounds are whole years 0–50, and min <= max.
 */
export const ExperienceRangeSchema = z
  .object({
    minYears: z.number().int().min(0).max(50).optional(),
    maxYears: z.number().int().min(0).max(50).optional(),
  })
  .strict()
  .refine((r) => r.minYears !== undefined || r.maxYears !== undefined, {
    message: 'provide at least one of minYears / maxYears (or omit the range)',
  })
  .refine(
    (r) =>
      r.minYears === undefined || r.maxYears === undefined || r.minYears <= r.maxYears,
    { message: 'minYears must be <= maxYears' },
  );

/**
 * Salary preference — ONLY stored when the user provides one. Absent by
 * default (never inferred). Local-only: stripped before any provider call.
 * Range semantics: minAnnual/maxAnnual are gross annual amounts in `currency`;
 * at least one bound or a note must be present, min <= max when both set.
 */
const SalaryPreferenceSchema = z
  .object({
    /** ISO-4217-style alpha-3 code, uppercase (e.g. USD, EUR). */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'expected a 3-letter uppercase currency code, e.g. USD'),
    minAnnual: z.number().min(0).max(10_000_000).optional(),
    maxAnnual: z.number().min(0).max(10_000_000).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine(
    (s) => s.minAnnual !== undefined || s.maxAnnual !== undefined || s.note !== undefined,
    { message: 'provide a min and/or max annual amount (or a note)' },
  )
  .refine(
    (s) =>
      s.minAnnual === undefined || s.maxAnnual === undefined || s.minAnnual <= s.maxAnnual,
    { message: 'minAnnual must be <= maxAnnual' },
  );

/* ------------------------------------------------------------------ */
/* Settings schema                                                     */
/* ------------------------------------------------------------------ */

export const settingsSchema = z
  .object({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),

    /* --- targeting (seeded once from profile.preferences, then owned here) --- */
    targetTitles: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
    targetLocations: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
    workModes: z.array(z.enum(WORK_MODES)).max(3).default([]),
    employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(5).default([]),
    /** Absent = no experience filter (never assumed). */
    experienceRange: ExperienceRangeSchema.optional(),

    /* --- optional preferences --- */
    /** Absent = not provided. Local-only; never sent to an AI provider. */
    salary: SalaryPreferenceSchema.optional(),
    /** Employers the user asked us to skip when matching jobs. */
    excludedEmployers: z.array(z.string().trim().min(1).max(120)).max(50).default([]),

    /* --- thresholds & output --- */
    /**
     * Minimum resume-to-job match estimate (0–100) required before a job is
     * suggested. 0 (default) = no filtering. This is the extension's own
     * transparent estimate, never an employer's proprietary ATS score.
     */
    minMatchThreshold: z.number().int().min(0).max(100).default(0),
    resumeFormat: z.enum(RESUME_FORMATS).default('pdf'),

    /* --- privacy switch --- */
    /**
     * Master switch for AI features. FALSE by default: until the user turns it
     * on AND configures a provider, nothing is ever sent anywhere.
     */
    aiEnabled: z.boolean().default(false),

    /** Managed by save flow, not user-editable. */
    updatedAt: z.iso.datetime().optional(),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;
export type ExperienceRange = z.infer<typeof ExperienceRangeSchema>;
export type SalaryPreference = z.infer<typeof SalaryPreferenceSchema>;

/* ------------------------------------------------------------------ */
/* Defaults / validation / normalization (pure)                        */
/* ------------------------------------------------------------------ */

/**
 * Conservative defaults: `settingsSchema.parse({})` fills every default.
 * Nothing is targeted, nothing is filtered, no range/salary is assumed and AI
 * stays off.
 */
export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** Per-issue messages (empty array = valid). Non-PII: field paths + messages. */
export function validateSettings(value: Settings): string[] {
  const check = settingsSchema.safeParse(value);
  if (check.success) return [];
  return check.error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`);
}

/**
 * Normalize UI line-list artifacts BEFORE validation/save: trims entries and
 * drops whitespace-only lines (a trailing newline while typing must not block
 * saving). Non-list fields pass through untouched. Does not mutate input.
 */
export function normalizeSettings(value: Settings): Settings {
  const trimList = (items: string[]): string[] =>
    items.map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    ...value,
    targetTitles: trimList(value.targetTitles),
    targetLocations: trimList(value.targetLocations),
    excludedEmployers: trimList(value.excludedEmployers),
  };
}

/* ------------------------------------------------------------------ */
/* Migration source: profile.preferences (read-only)                   */
/* ------------------------------------------------------------------ */

/** True when a profile carries targeting worth importing into settings. */
export function hasSeedablePreferences(prefs: Preferences): boolean {
  return (
    prefs.targetTitles.length > 0 ||
    prefs.targetLocations.length > 0 ||
    prefs.workModes.length > 0
  );
}

/**
 * Pure mapper: profile.preferences -> Settings (targeting copied verbatim,
 * everything else left at conservative defaults). Never mutates the source
 * preferences; no values are invented — absent preferences stay empty.
 */
export function seedSettingsFromPreferences(prefs: Preferences): Settings {
  return {
    ...defaultSettings(),
    targetTitles: [...prefs.targetTitles],
    targetLocations: [...prefs.targetLocations],
    workModes: [...prefs.workModes],
  };
}

/* ------------------------------------------------------------------ */
/* Privacy model                                                       */
/* ------------------------------------------------------------------ */

/**
 * The exact privacy explanation rendered on the options page (and asserted by
 * tests, so UI copy and behavior cannot drift apart silently).
 */
export const PRIVACY_NOTICE = {
  staysLocal: [
    'Everything is stored on this device via chrome.storage.local: your master profile, your sensitive profile (contact, legal answers, documents), your settings, and your application log.',
    'The current build makes no network requests at all — no telemetry, no analytics, no update pings.',
    'Your salary preference, excluded employers, match threshold and resume format never leave this device.',
    'Turning AI off (the default) guarantees nothing is ever transmitted by this extension.',
  ],
  mayBeSent: [
    'Only when you enable AI below AND configure a provider (endpoint + credential), the AI-safe master profile and the job description you chose to work on may be sent to that provider to draft resume content.',
    'Requests go only to the provider you configured; you can turn AI off again at any time.',
    'Production credentials must live behind a backend proxy — never in this extension bundle, its code, or its storage.',
  ],
  neverSent: [
    'Compensation and salary information, government identifiers, passwords, cookies, authentication tokens, and free-text address/phone/email beyond what the resume itself shows.',
    'Legal eligibility, work authorization, sponsorship, demographic, criminal-history or other voluntary-disclosure answers — the extension never guesses these and never sends them to a model.',
    'Any of the above is also never logged to the network layer; sensitive data stays in the separate sensitive-profile record.',
  ],
} as const;

/**
 * Projection for provider-bound payloads: everything EXCEPT compensation
 * (rule: compensation never goes to an LLM). Future provider code must build
 * its request from this function, not from the raw settings object.
 */
export type ProviderSafeSettings = Omit<Settings, 'salary'>;

export function settingsForProvider(settings: Settings): ProviderSafeSettings {
  const { salary: _salary, ...safe } = settings;
  return safe;
}
