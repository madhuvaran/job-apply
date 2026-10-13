/**
 * Typed storage service for the split profile model (schema v2).
 *
 * Keys (all validated with zod on read AND write):
 *   job-profile.v2            -> AI-safe Profile        (src/lib/profile.ts)
 *   job-profile.sensitive.v2  -> SensitiveProfile       (src/lib/sensitive.ts)
 *   job-settings.v1           -> Settings               (src/lib/settings.ts)
 *   job-profile               -> legacy starter profile (schema v1, kept for migration)
 *
 * Every load returns a discriminated `StorageResult` so callers can handle
 * absent / malformed / unavailable storage distinctly instead of guessing:
 *   { ok: true, data }                              present and valid
 *   { ok: false, reason: 'absent', ... }            key exists in no storage
 *   { ok: false, reason: 'malformed', ... }         data present but invalid
 *   { ok: false, reason: 'unavailable', ... }       storage API threw (browser
 *                                                   restrictions, corrupted
 *                                                   backend, revoked permission)
 *   { ok: false, reason: 'quota', ... }             write rejected for size
 *
 * Corrupt data is NEVER silently overwritten. `malformed` results carry the
 * raw stored value on a recoverable `raw` field so a review/reset flow can
 * inspect or salvage it explicitly.
 *
 * Error messages contain KEY NAMES and error-type strings only — never stored
 * values (rule: do not log personal information; profiles contain personal data).
 *
 * Secrets: nothing here stores or accepts credentials — profile payloads are
 * profile-schema data only (no passwords/tokens/cookie fields exist in the
 * schemas, and strict parsing rejects any such extra keys).
 *
 * Migrations are non-destructive: the legacy key is never deleted or modified.
 */
import { browser } from 'wxt/browser';
import {
  profileSchema,
  PROFILE_SCHEMA_VERSION,
  type Profile,
} from './profile';
import {
  SENSITIVE_SCHEMA_VERSION,
  sensitiveProfileSchema,
  type SensitiveProfile,
} from './sensitive';
import type { LegacyProfileV1 } from './legacy';
import {
  defaultSettings,
  hasSeedablePreferences,
  seedSettingsFromPreferences,
  settingsSchema,
  type Settings,
} from './settings';
import {
  emptyJobPostingsRecord,
  jobPostingsRecordSchema,
  upsertPostingInList,
  type JobPosting,
  type JobPostingsRecord,
} from './job-posting';
import {
  applicationsRecordSchema,
  emptyApplicationsRecord,
  type ApplicationsRecord,
} from './applications/schemas';
import { z } from 'zod';

const KEY_V2 = 'job-profile.v2';
const KEY_SENSITIVE_V2 = 'job-profile.sensitive.v2';
/** Legacy starter schema key, still present in some installs. Kept for migration reads only. */
export const KEY_LEGACY = 'job-profile';
/** Job-search settings (targeting, thresholds, AI switch) — schema v1 in src/lib/settings.ts. */
const KEY_SETTINGS = 'job-settings.v1';
/** Saved job postings (manual intake + capture) — schema v1 in src/lib/job-posting.ts. */
const KEY_JOB_POSTINGS = 'job-postings.v1';
/** Local application log — schema v1 in src/lib/applications/schemas.ts. Local-only, never synced. */
const KEY_APPLICATIONS = 'job-applications.v1';

export const STORAGE_KEYS = {
  profile: KEY_V2,
  sensitive: KEY_SENSITIVE_V2,
  legacy: KEY_LEGACY,
  settings: KEY_SETTINGS,
  jobPostings: KEY_JOB_POSTINGS,
  applications: KEY_APPLICATIONS,
} as const;

/* ------------------------------------------------------------------ */
/* Result types                                                         */
/* ------------------------------------------------------------------ */

export type StorageErrorReason = 'absent' | 'malformed' | 'unavailable' | 'quota';

export interface StorageFailure {
  ok: false;
  reason: StorageErrorReason;
  /** Stable, non-PII message: error type names + storage key + counts only. */
  message: string;
  /** Present ONLY for `malformed`: the raw stored value, recoverable for review/salvage. Never auto-overwritten. */
  raw?: unknown;
}

export type StorageResult<T> =
  | { ok: true; data: T }
  | StorageFailure;

export function absent<T>(): StorageResult<T> {
  return { ok: false, reason: 'absent', message: 'no value stored for key' };
}

function malformed<T>(key: string, zodError: z.ZodError, raw: unknown): StorageResult<T> {
  return {
    ok: false,
    reason: 'malformed',
    // Non-PII: key name + issue count. Zod issues may quote values, so we do
    // not embed them; callers can inspect `raw` explicitly if the user asks.
    message: `stored value for "${key}" failed schema validation (${zodError.issues.length} issue(s))`,
    raw,
  };
}

function unavailable<T>(err: unknown, key: string): StorageResult<T> {
  // Non-PII: keep only the error type name, never message content (may quote data).
  const errType = err instanceof Error ? err.name : typeof err;
  return {
    ok: false,
    reason: 'unavailable',
    message: `storage API error (${errType}) while accessing "${key}"`,
  };
}

/* ------------------------------------------------------------------ */
/* Core read/write                                                      */
/* ------------------------------------------------------------------ */

async function loadValidated<T>(
  key: string,
  schema: z.ZodType<T>,
): Promise<StorageResult<T>> {
  let stored: Record<string, unknown>;
  try {
    stored = (await browser.storage.local.get(key)) as Record<string, unknown>;
  } catch (err) {
    return unavailable<T>(err, key);
  }
  if (!(key in stored) || stored[key] === undefined) return absent<T>();
  const result = schema.safeParse(stored[key]);
  return result.success
    ? { ok: true, data: result.data }
    : malformed<T>(key, result.error, stored[key]);
}

async function writeValidated<T>(
  key: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<StorageResult<T> | null> {
  // Validate before writing; reject corrupt payloads up front.
  const check = schema.safeParse(value);
  if (!check.success) return malformed<T>(key, check.error, value);
  try {
    await browser.storage.local.set({ [key]: value });
  } catch (err) {
    // Persisted writes that exceed quota throw in Chrome; surface as 'quota'
    // when detectable, otherwise 'unavailable'.
    const name = err instanceof Error ? err.name : '';
    if (name === 'QuotaExceededError' || /quota/i.test(String(name))) {
      return {
        ok: false,
        reason: 'quota',
        message: `storage quota exceeded while writing "${key}"`,
      };
    }
    return unavailable<T>(err, key);
  }
  return null; // success
}

/* ------------------------------------------------------------------ */
/* AI-safe profile (v2)                                                 */
/* ------------------------------------------------------------------ */

export async function loadProfile(): Promise<StorageResult<Profile>> {
  return loadValidated(STORAGE_KEYS.profile, profileSchema);
}

export async function saveProfile(profile: Profile): Promise<StorageResult<Profile> | null> {
  return writeValidated(STORAGE_KEYS.profile, profileSchema, profile);
}

/**
 * Reset the AI-safe profile to an empty valid profile. NOT destructive to the
 * sensitive profile or the legacy key. Corrupt data is replaceable only by
 * this explicit, deliberate call (never implicitly).
 */
export async function resetProfile(): Promise<StorageResult<Profile> | null> {
  const empty: Profile = profileSchema.parse({});
  return saveProfile(empty);
}

/* ------------------------------------------------------------------ */
/* Sensitive profile (v2)                                               */
/* ------------------------------------------------------------------ */

export async function loadSensitiveProfile(): Promise<StorageResult<SensitiveProfile>> {
  return loadValidated(STORAGE_KEYS.sensitive, sensitiveProfileSchema);
}

export async function saveSensitiveProfile(
  profile: SensitiveProfile,
): Promise<StorageResult<SensitiveProfile> | null> {
  return writeValidated(STORAGE_KEYS.sensitive, sensitiveProfileSchema, profile);
}

/**
 * Reset the SENSITIVE profile (contact/legal/documents) to an empty valid one.
 * Explicit-only, like resetProfile. Does not touch the AI-safe profile.
 */
export async function resetSensitiveProfile(): Promise<StorageResult<SensitiveProfile> | null> {
  // The sensitive schema requires non-empty name/email/phone, so the reset
  // state uses explicit "undisclosed" sentinels rather than fake personal
  // data (no invented details, per the no-invention rules).
  const empty = sensitiveProfileSchema.parse({
    contact: {
      firstName: 'undisclosed',
      lastName: 'undisclosed',
      // Schema-valid but obviously-not-real placeholder (RFC 2606 .invalid TLD).
      email: 'undisclosed@example.invalid',
      phone: 'undisclosed',
    },
    legal: { workAuthorization: 'undisclosed', sponsorshipNeeded: false },
    voluntary: {
      gender: 'undisclosed',
      raceEthnicity: ['undisclosed'],
      veteranStatus: 'undisclosed',
      disabilityStatus: 'undisclosed',
    },
    documents: {},
  });
  return saveSensitiveProfile(empty);
}

/* ------------------------------------------------------------------ */
/* Settings (v1)                                                       */
/* ------------------------------------------------------------------ */

export async function loadSettings(): Promise<StorageResult<Settings>> {
  return loadValidated(STORAGE_KEYS.settings, settingsSchema);
}

export async function saveSettings(settings: Settings): Promise<StorageResult<Settings> | null> {
  return writeValidated(STORAGE_KEYS.settings, settingsSchema, settings);
}

/**
 * Reset settings to the conservative defaults (AI off, no filtering, empty
 * targeting). Explicit-only, like the profile resets; never touches profile
 * or sensitive keys.
 */
export async function resetSettings(): Promise<StorageResult<Settings> | null> {
  return saveSettings(defaultSettings());
}

/* ------------------------------------------------------------------ */
/* Settings migration (seed from profile.preferences, non-destructive)  */
/* ------------------------------------------------------------------ */

export interface SettingsMigrationResult {
  migrated:
    | 'seeded' // settings created from profile targeting (profile untouched)
    | 'already_present' // settings exist — never overwritten here
    | 'blocked_corrupt_target' // settings key malformed — raw preserved, explicit reset first
    | 'no_source' // no profile, or profile has no targeting to import
    | 'source_malformed' // profile unusable — nothing written
    | 'storage_unavailable' // storage API failed — nothing written
    | 'write_failed'; // validated seed could not be persisted
  /** Keys that were written. No profile key is ever written or deleted here. */
  writtenKeys: string[];
  /** Non-PII warnings only (key names, field names, counts). */
  warnings: string[];
}

/**
 * One-time, non-destructive seeding of job-search targeting:
 * `profile.preferences.targetTitles / targetLocations / workModes` -> the new
 * settings record. Existing settings are NEVER overwritten, corrupt settings
 * are NEVER replaced (explicit reset required first), and the profile record
 * is only read — never modified, deleted or validated away (rule 17).
 *
 * The pure mapper lives in settings.ts (`seedSettingsFromPreferences`).
 */
export async function migrateSettingsFromProfile(): Promise<SettingsMigrationResult> {
  const result: SettingsMigrationResult = { migrated: 'no_source', writtenKeys: [], warnings: [] };

  const existing = await loadSettings();
  if (existing.ok) {
    result.migrated = 'already_present';
    result.warnings.push('settings already exist; profile data NOT copied over them');
    return result;
  }
  if (existing.reason === 'malformed') {
    result.migrated = 'blocked_corrupt_target';
    result.warnings.push(
      'settings data is malformed; run resetSettings() explicitly to recover, then import',
    );
    return result;
  }
  if (existing.reason !== 'absent') {
    // 'unavailable' | 'quota'
    result.migrated = 'storage_unavailable';
    result.warnings.push(`settings read failed (${existing.reason}); nothing written`);
    return result;
  }

  const profile = await loadProfile();
  if (!profile.ok) {
    if (profile.reason === 'malformed') {
      result.migrated = 'source_malformed';
      result.warnings.push('profile data is malformed; nothing imported');
    } else {
      result.migrated = 'no_source';
      result.warnings.push(`profile read failed (${profile.reason}); nothing imported`);
    }
    return result;
  }
  if (!hasSeedablePreferences(profile.data.preferences)) {
    result.migrated = 'no_source';
    result.warnings.push('profile has no target titles/locations/work modes to import');
    return result;
  }

  const seed = seedSettingsFromPreferences(profile.data.preferences);
  const write = await saveSettings(seed);
  if (write !== null && !write.ok) {
    // write is narrowed to StorageFailure here
    result.migrated = 'write_failed';
    result.warnings.push(`settings write failed (${write.reason}); nothing migrated`);
    return result;
  }
  result.migrated = 'seeded';
  result.writtenKeys.push(KEY_SETTINGS);
  result.warnings.push('profile record unchanged (import is a read-only copy)');
  return result;
}

/* ------------------------------------------------------------------ */
/* Job postings (v1)                                                   */
/* ------------------------------------------------------------------ */

export async function loadJobPostings(): Promise<StorageResult<JobPostingsRecord>> {
  return loadValidated(STORAGE_KEYS.jobPostings, jobPostingsRecordSchema);
}

export async function saveJobPostings(
  record: JobPostingsRecord,
): Promise<StorageResult<JobPostingsRecord> | null> {
  return writeValidated(STORAGE_KEYS.jobPostings, jobPostingsRecordSchema, record);
}

/**
 * Insert or replace one posting (by id) and persist the list. Returns null on
 * success, a StorageResult on failure (malformed payload / quota /
 * unavailable). Never touches other storage keys.
 */
export async function upsertJobPosting(
  posting: JobPosting,
): Promise<StorageResult<JobPostingsRecord> | null> {
  const current = await loadJobPostings();
  if (!current.ok && current.reason !== 'absent') return current;
  const list = current.ok ? current.data.postings : [];
  const record: JobPostingsRecord = {
    schemaVersion: '1',
    postings: upsertPostingInList(list, posting),
  };
  return saveJobPostings(record);
}

/** Explicit-only reset: replace the postings list with an empty valid record. */
export async function resetJobPostings(): Promise<StorageResult<JobPostingsRecord> | null> {
  return saveJobPostings(emptyJobPostingsRecord());
}

/* ------------------------------------------------------------------ */
/* Application log (v1) — local-only                                    */
/* ------------------------------------------------------------------ */

export async function loadApplications(): Promise<StorageResult<ApplicationsRecord>> {
  return loadValidated(STORAGE_KEYS.applications, applicationsRecordSchema);
}

export async function saveApplications(
  record: ApplicationsRecord,
): Promise<StorageResult<ApplicationsRecord> | null> {
  return writeValidated(STORAGE_KEYS.applications, applicationsRecordSchema, record);
}

/** Explicit-only reset: replace the application log with an empty valid record. */
export async function resetApplications(): Promise<StorageResult<ApplicationsRecord> | null> {
  return saveApplications(emptyApplicationsRecord());
}

/* ------------------------------------------------------------------ */
/* Legacy (starter schema)                                              */
/* ------------------------------------------------------------------ */

/** Read the old starter profile (if present) without modifying or deleting it. */
export async function getLegacyProfile(): Promise<StorageResult<LegacyProfileV1>> {
  let stored: Record<string, unknown>;
  try {
    stored = (await browser.storage.local.get(KEY_LEGACY)) as Record<string, unknown>;
  } catch (err) {
    return unavailable<LegacyProfileV1>(err, KEY_LEGACY);
  }
  if (!(KEY_LEGACY in stored) || stored[KEY_LEGACY] === undefined) return absent<LegacyProfileV1>();
  const loose = legacyProfileV1Schema.safeParse(stored[KEY_LEGACY]);
  return loose.success
    ? { ok: true, data: loose.data }
    : malformed<LegacyProfileV1>(KEY_LEGACY, loose.error, stored[KEY_LEGACY]);
}

const legacyProfileV1Schema = z.object({
  basics: z.looseObject({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string(),
  }),
  summary: z.string(),
  skills: z.array(z.string()),
  experience: z.array(
    z.looseObject({
      company: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string().nullable(),
      bullets: z.array(z.string()),
    }),
  ),
});

/* ------------------------------------------------------------------ */
/* Migration (non-destructive)                                          */
/* ------------------------------------------------------------------ */

export interface MigrationResult {
  migrated: 'none' | 'legacy_profile' | 'blocked_existing' | 'blocked_corrupt_target';
  /** Keys that were written. No legacy key is ever deleted. */
  writtenKeys: string[];
  /** Non-PII warnings only: key names, structure issues, date-format problems are structure values (months are not PII). */
  warnings: string[];
}

/**
 * Copy legacy starter profile data into the v2 storage WITHOUT deleting or
 * modifying the legacy key (rule 17).
 *
 * Outcome distinctions:
 *   'legacy_profile'            copy succeeded
 *   'blocked_existing'          a valid v2 profile already exists (never overwritten here)
 *   'blocked_corrupt_target'    the v2 key holds MALFORMED data — migration
 *                               stops; the user must explicitly reset/recover
 *                               first (corrupt data is never silently replaced)
 *
 * Truthful carry-over only: skills -> claimed status; experience dates that
 * don't parse as YYYY-MM are skipped with a warning (never guessed); email/
 * phone are NOT copied (they belong to the sensitive profile).
 */
export async function migrateLegacyProfile(): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: 'none', writtenKeys: [], warnings: [] };

  const legacyRes = await getLegacyProfile();
  if (!legacyRes.ok) {
    result.warnings.push(`legacy read failed (${legacyRes.reason}); nothing migrated`);
    return result;
  }
  const legacy = legacyRes.data;

  const existing = await loadProfile();
  if (existing.ok) {
    result.migrated = 'blocked_existing';
    result.warnings.push('v2 profile already exists; legacy data NOT copied over it');
    return result;
  }
  if (existing.reason !== 'absent') {
    // existing is narrowed to StorageFailure here
    result.migrated = 'blocked_corrupt_target';
    result.warnings.push(
      existing.reason === 'malformed'
        ? 'v2 profile data is malformed; run resetProfile() explicitly to recover, then migrate'
        : 'storage unavailable; cannot migrate now',
    );
    return result;
  }

  const mapped = mapLegacyToProfile(legacy, result.warnings);
  const write = await saveProfile(mapped);
  if (write !== null && !write.ok) {
    // write is narrowed to StorageFailure here
    result.migrated = 'blocked_corrupt_target';
    result.warnings.push(`write failed (${write.reason}); nothing migrated`);
    return result;
  }
  result.migrated = 'legacy_profile';
  result.writtenKeys.push(KEY_V2);
  result.warnings.push('email/phone NOT migrated (they belong to the sensitive profile)');
  return result;
}

/** Pure mapping legacy v1 -> Profile v2. Exported for direct testing. */
export function mapLegacyToProfile(legacy: LegacyProfileV1, warnings: string[]): Profile {
  const experience = legacy.experience.flatMap((e) => {
    const startOk = monthPattern.test(e.start) ? e.start : null;
    let endOk: string | null = null;
    if (e.end !== null) {
      if (monthPattern.test(e.end)) endOk = e.end;
      else warnings.push(`experience at "${e.company}": end date not YYYY-MM, set to null`);
    }
    if (startOk === null) {
      warnings.push(`experience at "${e.company}": start date not YYYY-MM, item skipped`);
      return [];
    }
    return [
      {
        id: crypto.randomUUID(),
        company: e.company,
        title: e.title,
        dates: { start: startOk, end: endOk },
        bullets: e.bullets,
      },
    ];
  });

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    displayName: `${legacy.basics.firstName} ${legacy.basics.lastName}`.trim() || undefined,
    summary: legacy.summary,
    skills: legacy.skills.map((name) => ({ id: crypto.randomUUID(), name, status: 'claimed' as const })),
    experience,
    education: [],
    certifications: [],
    projects: [],
    languages: [],
    preferences: {
      targetTitles: [],
      willingToRelocate: false,
      workModes: [],
      targetLocations: [],
      applicationAnswers: [],
    },
  };
}

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
