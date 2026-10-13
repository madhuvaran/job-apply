/**
 * Tests for the storage service (src/lib/storage.ts).
 *
 * `browser.storage.local` is mocked with an in-memory map that can also be
 * forced to throw (unavailable storage) or refuse writes (quota). Covers:
 * success, absent, malformed (with recoverable raw), unavailable, quota,
 * migration (incl. blockers), and reset behavior (explicit-only, never
 * touching the legacy key).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLegacyProfile,
  loadApplications,
  loadJobPostings,
  loadProfile,
  loadSensitiveProfile,
  loadSettings,
  mapLegacyToProfile,
  migrateLegacyProfile,
  migrateSettingsFromProfile,
  resetApplications,
  resetJobPostings,
  resetProfile,
  resetSensitiveProfile,
  resetSettings,
  saveApplications,
  saveJobPostings,
  saveProfile,
  saveSensitiveProfile,
  saveSettings,
  STORAGE_KEYS,
  upsertJobPosting,
  type StorageResult,
} from './storage';
import { defaultSettings, type Settings } from './settings';
import { createJobPosting, type JobPosting } from './job-posting';
import { sampleProfile, sampleSensitiveProfile } from './sample-profile';
import type { LegacyProfileV1 } from './legacy';
import { emptyApplicationsRecord } from './applications/schemas';

type StorageApi = {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
};

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  const failure = {
    getType: 'none' as 'none' | 'get' | 'set' | 'setOnly',
    errorName: 'StorageUnavailableError',
  };
  const storageLocal = {
    get: async (keys: string | string[]) => {
      if (failure.getType === 'get') {
        const e = new Error('storage backend blew up');
        e.name = failure.errorName;
        throw e;
      }
      if (failure.getType === 'set') {
        // Simulate an API where even reads fail after a quota failure.
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) {
        if (backing.has(k)) out[k] = backing.get(k);
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      if (failure.getType === 'set' || failure.getType === 'setOnly') {
        const e = new Error('write too large');
        e.name = failure.errorName === 'StorageUnavailableError' ? 'StorageUnavailableError' : 'QuotaExceededError';
        throw e;
      }
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      for (const k of wanted) backing.delete(k);
    },
  };
  return { backing, failure, storageLocal };
});

vi.mock('wxt/browser', () => ({
  browser: { storage: { local: h.storageLocal } },
}));

beforeEach(() => {
  h.backing.clear();
  h.failure.getType = 'none';
  h.failure.errorName = 'StorageUnavailableError';
});

describe('loadProfile (v2)', () => {
  it('returns ok with saved data after saveProfile round-trip', async () => {
    const save = await saveProfile(sampleProfile);
    expect(save).toBeNull();
    const res: StorageResult<typeof sampleProfile> = await loadProfile();
    expect(res).toEqual({ ok: true, data: sampleProfile });
  });

  it('returns reason "absent" when nothing is stored (distinct from malformed)', async () => {
    const res = await loadProfile();
    expect(res).toMatchObject({ ok: false, reason: 'absent' });
    expect(res).not.toHaveProperty('raw');
  });

  it('returns reason "malformed" with recoverable raw value, never overwriting it', async () => {
    const corrupt = { nonsense: true, email: 'should@not.leak' };
    h.backing.set(STORAGE_KEYS.profile, corrupt);
    const res = await loadProfile();
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) expect(res.raw).toEqual(corrupt);
    // Nothing was silently overwritten.
    expect(h.backing.has(STORAGE_KEYS.profile)).toBe(true);
    expect(h.backing.get(STORAGE_KEYS.profile)).toEqual(corrupt);
  });

  it('returns reason "unavailable" when the storage API throws', async () => {
    h.failure.getType = 'get';
    const res = await loadProfile();
    expect(res).toMatchObject({ ok: false, reason: 'unavailable' });
    if (!res.ok) expect(res.message).toMatch(/StorageUnavailableError/);
  });

  it('error messages contain no stored values (no PII in messages)', async () => {
    h.backing.set(STORAGE_KEYS.profile, { nonsense: true, firstName: 'Secret', email: 'secret@example.com' });
    const res = await loadProfile();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).not.toMatch(/Secret|secret@example\.com/);
  });
});

describe('loadSensitiveProfile (v2)', () => {
  it('round-trips valid sensitive data', async () => {
    await saveSensitiveProfile(sampleSensitiveProfile);
    expect(await loadSensitiveProfile()).toEqual({ ok: true, data: sampleSensitiveProfile });
  });

  it('distinguishes absent vs malformed for sensitive data too', async () => {
    expect(await loadSensitiveProfile()).toMatchObject({ ok: false, reason: 'absent' });
    h.backing.set(STORAGE_KEYS.sensitive, 'garbage');
    const res = await loadSensitiveProfile();
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) expect(res.raw).toBe('garbage');
  });
});

describe('saveProfile validation + write failures', () => {
  it('rejects schema-invalid input with a malformed result and does not write', async () => {
    const bad = { ...sampleProfile, schemaVersion: 'bogus' } as unknown as typeof sampleProfile;
    const res = await saveProfile(bad);
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(h.backing.has(STORAGE_KEYS.profile)).toBe(false);
  });

  it('maps QuotaExceededError to the distinct "quota" reason', async () => {
    h.failure.getType = 'set';
    h.failure.errorName = 'QuotaExceededError';
    const res = await saveProfile(sampleProfile);
    expect(res).toMatchObject({ ok: false, reason: 'quota' });
    expect(h.backing.has(STORAGE_KEYS.profile)).toBe(false);
  });

  it('maps other write failures to "unavailable"', async () => {
    h.failure.getType = 'set';
    h.failure.errorName = 'StorageUnavailableError';
    const res = await saveProfile(sampleProfile);
    expect(res).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('resetProfile / resetSensitiveProfile', () => {
  it('replaces a corrupt profile only when explicitly called, then data loads as absent-then-valid', async () => {
    h.backing.set(STORAGE_KEYS.profile, { nonsense: true });
    expect((await loadProfile()).ok).toBe(false);
    const res = await resetProfile();
    expect(res).toBeNull();
    const after = await loadProfile();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.data.experience).toEqual([]);
      expect(after.data.skills).toEqual([]);
    }
  });

  it('resetSensitiveProfile yields an all-undisclosed sensitive profile without touching the AI-safe one', async () => {
    await saveProfile(sampleProfile);
    const res = await resetSensitiveProfile();
    expect(res).toBeNull();
    const sens = await loadSensitiveProfile();
    expect(sens.ok).toBe(true);
    if (sens.ok) {
      expect(sens.data.voluntary.gender).toBe('undisclosed');
      expect(sens.data.legal.workAuthorization).toBe('undisclosed');
    }
    // AI-safe data untouched.
    expect(await loadProfile()).toEqual({ ok: true, data: sampleProfile });
  });

  it('resets never touch the legacy key', async () => {
    h.backing.set(STORAGE_KEYS.legacy, { any: 'shape' });
    await resetProfile();
    await resetSensitiveProfile();
    expect(h.backing.has(STORAGE_KEYS.legacy)).toBe(true);
    expect(h.backing.get(STORAGE_KEYS.legacy)).toEqual({ any: 'shape' });
  });
});

describe('getLegacyProfile', () => {
  const legacy: LegacyProfileV1 = {
    basics: { firstName: 'Old', lastName: 'Data', email: 'old@example.com', phone: '555-0199' },
    summary: 'old summary',
    skills: ['Old Skill'],
    experience: [
      { company: 'Old Co', title: 'Old Title', start: '2019-01', end: null, bullets: ['old bullet'] },
    ],
  };

  it('reads raw legacy data with loose validation', async () => {
    h.backing.set(STORAGE_KEYS.legacy, { ...legacy, extraField: 1 });
    const res = await getLegacyProfile();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const first = res.data.experience[0];
      if (!first) throw new Error('expected legacy experience item');
      expect(first.company).toBe('Old Co');
    }
  });

  it('returns "absent" when no legacy profile', async () => {
    expect(await getLegacyProfile()).toMatchObject({ ok: false, reason: 'absent' });
  });

  it('returns "malformed" (with raw) for non-object legacy junk', async () => {
    h.backing.set(STORAGE_KEYS.legacy, 42);
    const res = await getLegacyProfile();
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) expect(res.raw).toBe(42);
  });
});

describe('mapLegacyToProfile (pure mapper)', () => {
  it('maps valid legacy data truthfully and marks skills as claimed', () => {
    const warnings: string[] = [];
    const p = mapLegacyToProfile(
      {
        basics: { firstName: 'Old', lastName: 'Data', email: 'x@y.z', phone: '5' },
        summary: 's',
        skills: ['A', 'B'],
        experience: [
          { company: 'Old Co', title: 'T', start: '2019-01', end: null, bullets: ['b'] },
        ],
      },
      warnings,
    );
    expect(p.displayName).toBe('Old Data');
    expect(p.skills.map((s) => ({ name: s.name, status: s.status }))).toEqual([
      { name: 'A', status: 'claimed' },
      { name: 'B', status: 'claimed' },
    ]);
    expect(p.experience[0]).toMatchObject({ company: 'Old Co', dates: { start: '2019-01', end: null } });
  });

  it('skips unparseable start dates with a warning (no invention, no guessing)', () => {
    const warnings: string[] = [];
    const p = mapLegacyToProfile(
      {
        basics: { firstName: 'O', lastName: 'D', email: 'x@y.z', phone: '5' },
        summary: 's',
        skills: [],
        experience: [
          { company: 'Good', title: 'T', start: '2019-01', end: null, bullets: ['b'] },
          { company: 'Bad', title: 'T', start: 'summer 2018', end: null, bullets: ['b'] },
        ],
      },
      warnings,
    );
    expect(p.experience).toHaveLength(1);
    expect(p.experience[0]!.company).toBe('Good');
    expect(warnings.join(' ')).toMatch(/start date not YYYY-MM, item skipped/);
  });

  it('coerces unparseable END dates to null with a warning (never invents present dates)', () => {
    const warnings: string[] = [];
    const p = mapLegacyToProfile(
      {
        basics: { firstName: 'O', lastName: 'D', email: 'x@y.z', phone: '5' },
        summary: 's',
        skills: [],
        experience: [{ company: 'C', title: 'T', start: '2019-01', end: 'a while', bullets: ['b'] }],
      },
      warnings,
    );
    expect(p.experience[0]!.dates.end).toBeNull();
    expect(warnings.join(' ')).toMatch(/end date not YYYY-MM/);
  });
});

describe('migrateLegacyProfile (non-destructive + blockers)', () => {
  const legacy: LegacyProfileV1 = {
    basics: { firstName: 'Old', lastName: 'Data', email: 'old@example.com', phone: '555-0199' },
    summary: 'old summary',
    skills: ['Old Skill A', 'Old Skill B'],
    experience: [
      { company: 'Old Co', title: 'Old Title', start: '2019-01', end: null, bullets: ['old bullet one'] },
      { company: 'Bad Dates Co', title: 'T', start: ' sometime 2018', end: null, bullets: ['x'] },
    ],
  };

  it('migrates to the v2 key, preserves legacy data, warns, keeps sensitive fields out', async () => {
    h.backing.set(STORAGE_KEYS.legacy, legacy);
    const result = await migrateLegacyProfile();
    expect(result.migrated).toBe('legacy_profile');
    expect(result.writtenKeys).toEqual([STORAGE_KEYS.profile]);
    expect(h.backing.has(STORAGE_KEYS.legacy)).toBe(true);
    const loaded = await loadProfile();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.summary).toBe('old summary');
      expect(loaded.data.skills.map((s) => s.name)).toEqual(['Old Skill A', 'Old Skill B']);
      expect(loaded.data.experience).toHaveLength(1);
      expect(loaded.data.displayName).toBe('Old Data');
      const json = JSON.stringify(loaded.data);
      expect(json).not.toContain('old@example.com');
      expect(json).not.toContain('555-0199');
    }
  });

  it('refuses to overwrite an existing valid v2 profile (blocked_existing)', async () => {
    h.backing.set(STORAGE_KEYS.legacy, legacy);
    await saveProfile(sampleProfile);
    const result = await migrateLegacyProfile();
    expect(result.migrated).toBe('blocked_existing');
    expect(await loadProfile()).toEqual({ ok: true, data: sampleProfile });
  });

  it('blocks on malformed v2 target and exposes recoverable raw (blocked_corrupt_target)', async () => {
    const corrupt = { nonsense: 1 };
    h.backing.set(STORAGE_KEYS.legacy, legacy);
    h.backing.set(STORAGE_KEYS.profile, corrupt);
    const result = await migrateLegacyProfile();
    expect(result.migrated).toBe('blocked_corrupt_target');
    // Corrupt target NOT replaced.
    expect(h.backing.get(STORAGE_KEYS.profile)).toEqual(corrupt);
  });

  it('is a no-op when there is no legacy profile', async () => {
    const result = await migrateLegacyProfile();
    expect(result.migrated).toBe('none');
    expect(result.writtenKeys).toEqual([]);
  });

  it('blocks with a warning when the legacy key itself is malformed', async () => {
    h.backing.set(STORAGE_KEYS.legacy, { veeery: 'broken' });
    const result = await migrateLegacyProfile();
    expect(result.migrated).toBe('none');
    expect(result.warnings.join(' ')).toMatch(/legacy read failed/);
  });

  it('blocks with a warning when storage is unavailable', async () => {
    h.failure.getType = 'get';
    const result = await migrateLegacyProfile();
    expect(result.migrated).toBe('none');
    expect(result.warnings.join(' ')).toMatch(/legacy read failed/);
  });
});

describe('settings persistence (v1)', () => {
  const custom = (): Settings => ({
    ...defaultSettings(),
    targetTitles: ['Backend Engineer', 'Platform Engineer'],
    targetLocations: ['Lisbon, PT'],
    workModes: ['hybrid'],
    employmentTypes: ['full-time', 'contract'],
    experienceRange: { minYears: 3, maxYears: 8 },
    salary: { currency: 'EUR', minAnnual: 60_000, maxAnnual: 90_000 },
    excludedEmployers: ['Fake Corp A'],
    minMatchThreshold: 70,
    resumeFormat: 'docx',
    aiEnabled: false, // stays conservative even in a custom fixture
  });

  it('round-trips a full settings object (save -> fresh load returns identical data)', async () => {
    const save = await saveSettings(custom());
    expect(save).toBeNull();
    const res = await loadSettings();
    expect(res).toEqual({ ok: true, data: custom() });
  });

  it('reports "absent" when nothing is stored, distinct from malformed', async () => {
    const res = await loadSettings();
    expect(res).toMatchObject({ ok: false, reason: 'absent' });
    expect(res).not.toHaveProperty('raw');
  });

  it('returns "malformed" with recoverable raw and never overwrites corrupt settings', async () => {
    const corrupt = { minMatchThreshold: 'very high', aiEnabled: 'yes' };
    h.backing.set(STORAGE_KEYS.settings, corrupt);
    const res = await loadSettings();
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) expect(res.raw).toEqual(corrupt);
    expect(h.backing.get(STORAGE_KEYS.settings)).toEqual(corrupt);
  });

  it('returns "unavailable" when the storage API throws on read', async () => {
    h.failure.getType = 'get';
    const res = await loadSettings();
    expect(res).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('rejects schema-invalid settings on write (out-of-range threshold) without writing', async () => {
    const bad = { ...defaultSettings(), minMatchThreshold: 250 } as Settings;
    const res = await saveSettings(bad);
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(h.backing.has(STORAGE_KEYS.settings)).toBe(false);
  });

  it('resetSettings restores conservative defaults (explicit call only)', async () => {
    await saveSettings(custom());
    expect((await loadSettings()).ok).toBe(true);
    const res = await resetSettings();
    expect(res).toBeNull();
    const after = await loadSettings();
    expect(after).toEqual({ ok: true, data: defaultSettings() });
    if (after.ok) {
      expect(after.data.aiEnabled).toBe(false);
      expect(after.data.minMatchThreshold).toBe(0);
      expect(after.data.salary).toBeUndefined();
    }
    // other records untouched
    expect(h.backing.has(STORAGE_KEYS.profile)).toBe(false);
    expect(h.backing.has(STORAGE_KEYS.legacy)).toBe(false);
  });

  it('settings storage never touches profile/sensitive keys on its own', async () => {
    await saveProfile(sampleProfile);
    await saveSettings(custom());
    expect(await loadProfile()).toEqual({ ok: true, data: sampleProfile });
    expect(await loadSensitiveProfile()).toMatchObject({ ok: false, reason: 'absent' });
  });
});

describe('job postings persistence (v1)', () => {
  const posting = (id: string, title: string): JobPosting =>
    createJobPosting(
      { title, rawDescription: `Description for ${title}.`, source: 'manual' },
      () => '2026-10-13T10:00:00.000Z',
      () => id,
    );

  it('round-trips a postings record (save -> fresh load returns identical list)', async () => {
    const record = { schemaVersion: '1' as const, postings: [posting('1', 'A'), posting('2', 'B')] };
    const save = await saveJobPostings(record);
    expect(save).toBeNull();
    expect(await loadJobPostings()).toEqual({ ok: true, data: record });
  });

  it('reports absent vs malformed distinctly; corrupt list never overwritten', async () => {
    expect(await loadJobPostings()).toMatchObject({ ok: false, reason: 'absent' });
    const corrupt = { postings: [{ junk: true }] };
    h.backing.set(STORAGE_KEYS.jobPostings, corrupt);
    const res = await loadJobPostings();
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) expect(res.raw).toEqual(corrupt);
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toEqual(corrupt);
  });

  it('upsertJobPosting inserts then updates by id, persisting across a fresh load', async () => {
    expect(await upsertJobPosting(posting('p1', 'Backend Engineer'))).toBeNull();
    expect(await upsertJobPosting(posting('p2', 'Data Engineer'))).toBeNull();
    let loaded = await loadJobPostings();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.data.postings.map((p) => p.id)).toEqual(['p2', 'p1']);

    expect(await upsertJobPosting(posting('p1', 'Backend Engineer II'))).toBeNull();
    loaded = await loadJobPostings(); // "reload"
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.postings).toHaveLength(2);
      const updated = loaded.data.postings.find((p) => p.id === 'p1');
      expect(updated?.title).toBe('Backend Engineer II');
      expect(updated?.capturedAt).toBe('2026-10-13T10:00:00.000Z'); // timestamp preserved
    }
  });

  it('upsert rejects a schema-invalid posting without writing', async () => {
    const bad = { ...posting('x', 'Valid'), originalUrl: 'not-a-url' } as JobPosting;
    const res = await upsertJobPosting(bad);
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(h.backing.has(STORAGE_KEYS.jobPostings)).toBe(false);
  });

  it('upsert fails cleanly (malformed) when the stored list is corrupt — raw preserved', async () => {
    const corrupt = { postings: 'nope' };
    h.backing.set(STORAGE_KEYS.jobPostings, corrupt);
    const res = await upsertJobPosting(posting('p1', 'A'));
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toEqual(corrupt);
  });

  it('resetJobPostings empties only the postings key (explicit call)', async () => {
    await saveProfile(sampleProfile);
    await upsertJobPosting(posting('p1', 'A'));
    expect(await resetJobPostings()).toBeNull();
    const res = await loadJobPostings();
    expect(res).toEqual({ ok: true, data: { schemaVersion: '1', postings: [] } });
    expect(await loadProfile()).toEqual({ ok: true, data: sampleProfile });
  });
});

describe('migrateSettingsFromProfile (seed, non-destructive)', () => {
  it('seeds targeting from profile.preferences and leaves the profile record byte-identical', async () => {
    await saveProfile(sampleProfile);
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('seeded');
    expect(result.writtenKeys).toEqual([STORAGE_KEYS.settings]);

    const settings = await loadSettings();
    expect(settings.ok).toBe(true);
    if (settings.ok) {
      expect(settings.data.targetTitles).toEqual(['Fake Title A', 'Fake Title B']);
      expect(settings.data.targetLocations).toEqual(['Fake City, FC']);
      expect(settings.data.workModes).toEqual(['remote']);
      // everything else stays conservative
      expect(settings.data.aiEnabled).toBe(false);
      expect(settings.data.minMatchThreshold).toBe(0);
      expect(settings.data.salary).toBeUndefined();
    }
    // Profile untouched (read-only copy).
    expect(await loadProfile()).toEqual({ ok: true, data: sampleProfile });
  });

  it('never overwrites existing settings (already_present)', async () => {
    await saveProfile(sampleProfile);
    const existing: Settings = { ...defaultSettings(), minMatchThreshold: 80 };
    await saveSettings(existing);
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('already_present');
    expect(result.writtenKeys).toEqual([]);
    expect(await loadSettings()).toEqual({ ok: true, data: existing });
  });

  it('blocks on corrupt settings: raw preserved, nothing written (blocked_corrupt_target)', async () => {
    await saveProfile(sampleProfile);
    const corrupt = { targetTitles: 42 };
    h.backing.set(STORAGE_KEYS.settings, corrupt);
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('blocked_corrupt_target');
    expect(h.backing.get(STORAGE_KEYS.settings)).toEqual(corrupt); // NOT replaced
    expect(await loadProfile()).toEqual({ ok: true, data: sampleProfile });
  });

  it('no_source when no profile exists (nothing written)', async () => {
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('no_source');
    expect(result.writtenKeys).toEqual([]);
    expect(h.backing.has(STORAGE_KEYS.settings)).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/profile read failed \(absent\)/);
  });

  it('no_source when the profile has no targeting to import', async () => {
    await saveProfile({
      ...sampleProfile,
      preferences: {
        targetTitles: [],
        willingToRelocate: false,
        workModes: [],
        targetLocations: [],
        applicationAnswers: [],
      },
    });
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('no_source');
    expect(h.backing.has(STORAGE_KEYS.settings)).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/no target titles/);
  });

  it('source_malformed when the profile is corrupt (nothing written, raw preserved)', async () => {
    const corruptProfile = { nonsense: 1 };
    h.backing.set(STORAGE_KEYS.profile, corruptProfile);
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('source_malformed');
    expect(h.backing.has(STORAGE_KEYS.settings)).toBe(false);
    expect(h.backing.get(STORAGE_KEYS.profile)).toEqual(corruptProfile);
  });

  it('storage_unavailable when reading settings fails (nothing written)', async () => {
    await saveProfile(sampleProfile);
    h.failure.getType = 'get';
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('storage_unavailable');
    expect(h.backing.has(STORAGE_KEYS.settings)).toBe(false);
  });

  it('write_failed when the seeded settings cannot be persisted', async () => {
    await saveProfile(sampleProfile);
    h.failure.getType = 'setOnly'; // reads work, writes throw
    h.failure.errorName = 'StorageUnavailableError';
    const result = await migrateSettingsFromProfile();
    expect(result.migrated).toBe('write_failed');
    expect(result.writtenKeys).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/settings write failed/);
    expect(h.backing.has(STORAGE_KEYS.settings)).toBe(false);
    // Profile still intact after the failed import.
    expect(h.backing.has(STORAGE_KEYS.profile)).toBe(true);
  });

  it('is idempotent: a second run reports already_present and changes nothing', async () => {
    await saveProfile(sampleProfile);
    expect((await migrateSettingsFromProfile()).migrated).toBe('seeded');
    const first = await loadSettings();
    expect((await migrateSettingsFromProfile()).migrated).toBe('already_present');
    expect(await loadSettings()).toEqual(first);
  });
});

describe('applications (v1) storage', () => {
  it('returns absent for the application key when nothing is stored', async () => {
    const res = await loadApplications();
    expect(res).toMatchObject({ ok: false, reason: 'absent' });
    expect(res).not.toHaveProperty('raw');
  });

  it('round-trips a valid application record (local key only)', async () => {
    const record = emptyApplicationsRecord();
    expect(await saveApplications(record)).toBeNull();
    expect(await loadApplications()).toEqual({ ok: true, data: record });
    expect(h.backing.has(STORAGE_KEYS.applications)).toBe(true);
    // Nothing is written to sync or any other key.
    expect([...h.backing.keys()]).toEqual([STORAGE_KEYS.applications]);
  });

  it('returns malformed with recoverable raw and never overwrites it', async () => {
    const corrupt = { schemaVersion: '1', applications: [{ id: 'x', notes: 'secret' }] };
    h.backing.set(STORAGE_KEYS.applications, corrupt);
    const res = await loadApplications();
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) {
      expect(res.raw).toEqual(corrupt);
      expect(res.message).not.toMatch(/secret/);
    }
    expect(h.backing.get(STORAGE_KEYS.applications)).toEqual(corrupt);
  });

  it('surfaces unavailable storage and quota write failures', async () => {
    h.failure.getType = 'get';
    expect(await loadApplications()).toMatchObject({ ok: false, reason: 'unavailable' });

    h.failure.getType = 'none';
    h.backing.set(STORAGE_KEYS.applications, emptyApplicationsRecord());
    h.failure.getType = 'setOnly';
    h.failure.errorName = 'QuotaExceededError';
    const write = await saveApplications(emptyApplicationsRecord());
    expect(write).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('resetApplications replaces the log with an empty valid record (explicit only)', async () => {
    const seeded = { schemaVersion: '1', applications: [] };
    h.backing.set(STORAGE_KEYS.applications, seeded);
    expect(await resetApplications()).toBeNull();
    expect(await loadApplications()).toEqual({ ok: true, data: emptyApplicationsRecord() });
  });
});
