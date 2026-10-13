/**
 * Tests for the settings model (src/lib/settings.ts) — Prompt 05 acceptance:
 * defaults (conservative), invalid values (range/enum/strictness), the
 * profile->settings seeding mapper, and the privacy projection/notice.
 *
 * Pure tests only: no browser API is touched here (storage behavior is
 * covered in storage.test.ts with the mocked storage backend).
 */
import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  EMPLOYMENT_TYPES,
  hasSeedablePreferences,
  normalizeSettings,
  PRIVACY_NOTICE,
  RESUME_FORMATS,
  seedSettingsFromPreferences,
  settingsForProvider,
  settingsSchema,
  validateSettings,
  WORK_MODES,
  type Settings,
} from './settings';
import type { Preferences } from './profile';

const prefs = (patch: Partial<Preferences> = {}): Preferences => ({
  targetTitles: [],
  willingToRelocate: false,
  workModes: [],
  targetLocations: [],
  applicationAnswers: [],
  ...patch,
});

const withErrors = (patch: Partial<Settings>): string[] =>
  validateSettings({ ...defaultSettings(), ...patch });

describe('conservative defaults', () => {
  it('defaults: AI off, no filtering, no targeting, no invented ranges', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe('1');
    expect(d.aiEnabled).toBe(false); // nothing leaves the device by default
    expect(d.minMatchThreshold).toBe(0); // 0 = filtering disabled
    expect(d.resumeFormat).toBe('pdf');
    expect(d.targetTitles).toEqual([]);
    expect(d.targetLocations).toEqual([]);
    expect(d.workModes).toEqual([]);
    expect(d.employmentTypes).toEqual([]);
    expect(d.excludedEmployers).toEqual([]);
    expect(d.experienceRange).toBeUndefined(); // never assumed
    expect(d.salary).toBeUndefined(); // only stored if provided
    expect(d.updatedAt).toBeUndefined();
  });

  it('parse({}) yields exactly the defaults and is valid', () => {
    expect(settingsSchema.parse({})).toEqual(defaultSettings());
    expect(validateSettings(defaultSettings())).toEqual([]);
  });

  it('defaults are stable (JSON round-trip)', () => {
    expect(settingsSchema.parse(JSON.parse(JSON.stringify(defaultSettings())))).toEqual(
      defaultSettings(),
    );
  });

  it('carries no legal-eligibility / sensitive fields — injected keys are rejected (strict)', () => {
    const injected = {
      ...defaultSettings(),
      workAuthorization: 'authorized',
      sponsorshipNeeded: false,
      raceEthnicity: ['white'],
      criminalHistory: 'no',
    } as unknown as Settings;
    expect(validateSettings(injected).length).toBeGreaterThan(0);
    // And the default object itself exposes none of them.
    expect(Object.keys(defaultSettings())).not.toContain('workAuthorization');
    expect(Object.keys(defaultSettings())).not.toContain('criminalHistory');
  });

  it('enum option lists are exported and non-empty for the UI', () => {
    expect([...WORK_MODES]).toEqual(['onsite', 'hybrid', 'remote']);
    expect(EMPLOYMENT_TYPES).toContain('full-time');
    expect(RESUME_FORMATS).toEqual(['pdf', 'docx']);
  });
});

describe('invalid values are rejected', () => {
  it('match threshold: below 0, above 100, non-integer', () => {
    expect(withErrors({ minMatchThreshold: -1 }).join(' ')).toMatch(/minMatchThreshold/);
    expect(withErrors({ minMatchThreshold: 101 }).join(' ')).toMatch(/minMatchThreshold/);
    expect(withErrors({ minMatchThreshold: 75.5 }).join(' ')).toMatch(/minMatchThreshold/);
  });

  it('unknown work mode / employment type / resume format', () => {
    expect(withErrors({ workModes: ['wfh' as never] }).join(' ')).toMatch(/workModes/);
    expect(withErrors({ employmentTypes: ['gig' as never] }).join(' ')).toMatch(/employmentTypes/);
    expect(withErrors({ resumeFormat: 'rtf' as never }).join(' ')).toMatch(/resumeFormat/);
  });

  it('empty / whitespace-only targeting entries and too many entries', () => {
    expect(withErrors({ targetTitles: [''] }).join(' ')).toMatch(/targetTitles/);
    expect(withErrors({ targetTitles: ['   '] }).join(' ')).toMatch(/targetTitles/);
    const many = Array.from({ length: 26 }, (_, i) => `Title ${i}`);
    expect(withErrors({ targetTitles: many }).join(' ')).toMatch(/targetTitles/);
    const manyEmployers = Array.from({ length: 51 }, (_, i) => `Employer ${i}`);
    expect(withErrors({ excludedEmployers: manyEmployers }).join(' ')).toMatch(
      /excludedEmployers/,
    );
  });

  it('experience range: min > max, negative, > 50, non-integer, empty object', () => {
    expect(withErrors({ experienceRange: { minYears: 8, maxYears: 3 } }).join(' ')).toMatch(
      /minYears must be <= maxYears/,
    );
    expect(withErrors({ experienceRange: { minYears: -1 } }).join(' ')).toMatch(/experienceRange/);
    expect(withErrors({ experienceRange: { maxYears: 51 } }).join(' ')).toMatch(/experienceRange/);
    expect(withErrors({ experienceRange: { minYears: 3.5 } }).join(' ')).toMatch(/experienceRange/);
    expect(withErrors({ experienceRange: {} }).join(' ')).toMatch(/at least one/);
  });

  it('valid experience range is accepted (one-sided and two-sided)', () => {
    expect(withErrors({ experienceRange: { minYears: 3 } })).toEqual([]);
    expect(withErrors({ experienceRange: { maxYears: 10 } })).toEqual([]);
    expect(withErrors({ experienceRange: { minYears: 3, maxYears: 10 } })).toEqual([]);
  });

  it('salary: only stored when provided; bad currency, inverted range, empty object rejected', () => {
    expect(
      withErrors({ salary: { currency: 'usd', minAnnual: 50_000 } }).join(' '),
    ).toMatch(/currency/);
    expect(
      withErrors({ salary: { currency: 'DOLLARS', minAnnual: 50_000 } }).join(' '),
    ).toMatch(/currency/);
    expect(
      withErrors({ salary: { currency: 'EUR', minAnnual: 200_000, maxAnnual: 100_000 } }).join(' '),
    ).toMatch(/minAnnual must be <= maxAnnual/);
    expect(withErrors({ salary: { currency: 'USD' } }).join(' ')).toMatch(/min and\/or max/);
    expect(withErrors({ salary: { currency: 'USD', minAnnual: -5 } }).join(' ')).toMatch(/salary/);
    expect(withErrors({ salary: { currency: 'USD', minAnnual: 60_000 } })).toEqual([]);
  });

  it('wrong types, wrong schema version, unknown keys', () => {
    expect(withErrors({ aiEnabled: 'yes' as never }).join(' ')).toMatch(/aiEnabled/);
    const wrongVersion = { ...defaultSettings(), schemaVersion: '2' } as unknown as Settings;
    expect(validateSettings(wrongVersion).join(' ')).toMatch(/schemaVersion/);
    const unknownKey = { ...defaultSettings(), someFutureFlag: true } as unknown as Settings;
    expect(validateSettings(unknownKey).length).toBeGreaterThan(0);
  });

  it('validateSettings reports field paths, not stored values (non-PII messages)', () => {
    const errs = withErrors({ targetTitles: ['secret employer name that is empty?'] , minMatchThreshold: 200 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/minMatchThreshold/);
  });
});

describe('normalizeSettings (UI line-list artifacts)', () => {
  it('drops empty/whitespace-only lines and trims the rest, without mutating input', () => {
    const raw: Settings = {
      ...defaultSettings(),
      targetTitles: ['  React Engineer  ', '', '   ', 'Backend'],
      excludedEmployers: [' Acme ', ''],
    };
    const norm = normalizeSettings(raw);
    expect(norm.targetTitles).toEqual(['React Engineer', 'Backend']);
    expect(norm.excludedEmployers).toEqual(['Acme']);
    // input untouched
    expect(raw.targetTitles).toHaveLength(4);
    // normalization makes a "typing" draft valid again
    expect(validateSettings(norm)).toEqual([]);
  });

  it('a trailing newline while typing does not make the draft invalid after normalize', () => {
    const raw: Settings = { ...defaultSettings(), targetTitles: ['Engineer', ''] };
    expect(validateSettings(raw).length).toBeGreaterThan(0); // raw IS invalid...
    expect(validateSettings(normalizeSettings(raw))).toEqual([]); // ...but normalizes clean
  });

  it('leaves non-list fields untouched', () => {
    const raw: Settings = { ...defaultSettings(), minMatchThreshold: 72, aiEnabled: true };
    expect(normalizeSettings(raw)).toEqual(raw);
  });
});

describe('profile -> settings seeding (migration mapper)', () => {
  it('copies targeting verbatim and keeps everything else at conservative defaults', () => {
    const seed = seedSettingsFromPreferences(
      prefs({
        targetTitles: ['Fake Title A', 'Fake Title B'],
        targetLocations: ['Fake City, FC'],
        workModes: ['remote'],
      }),
    );
    expect(seed.targetTitles).toEqual(['Fake Title A', 'Fake Title B']);
    expect(seed.targetLocations).toEqual(['Fake City, FC']);
    expect(seed.workModes).toEqual(['remote']);
    expect(seed.aiEnabled).toBe(false);
    expect(seed.minMatchThreshold).toBe(0);
    expect(seed.experienceRange).toBeUndefined();
    expect(seed.salary).toBeUndefined();
    expect(validateSettings(seed)).toEqual([]);
  });

  it('never mutates the source preferences and invents nothing', () => {
    const source = prefs({ targetTitles: ['Only Title'] });
    const before = JSON.parse(JSON.stringify(source));
    const seed = seedSettingsFromPreferences(source);
    expect(JSON.parse(JSON.stringify(source))).toEqual(before);
    expect(seed.targetLocations).toEqual([]); // absent stays absent, not guessed
    expect(seed.workModes).toEqual([]);
  });

  it('hasSeedablePreferences detects whether an import is worth offering', () => {
    expect(hasSeedablePreferences(prefs())).toBe(false);
    expect(hasSeedablePreferences(prefs({ targetTitles: ['T'] }))).toBe(true);
    expect(hasSeedablePreferences(prefs({ targetLocations: ['L'] }))).toBe(true);
    expect(hasSeedablePreferences(prefs({ workModes: ['hybrid'] }))).toBe(true);
  });
});

describe('privacy model', () => {
  it('settingsForProvider strips salary (compensation never goes to an LLM)', () => {
    const s: Settings = {
      ...defaultSettings(),
      targetTitles: ['Engineer'],
      salary: { currency: 'EUR', minAnnual: 80_000 },
    };
    const safe = settingsForProvider(s);
    expect('salary' in safe).toBe(false);
    expect(JSON.stringify(safe)).not.toContain('80000');
    // everything else survives
    expect(safe.targetTitles).toEqual(['Engineer']);
    expect(safe.aiEnabled).toBe(false);
    // original untouched
    expect(s.salary).toEqual({ currency: 'EUR', minAnnual: 80_000 });
  });

  it('works when no salary was ever provided', () => {
    const safe = settingsForProvider(defaultSettings());
    expect('salary' in safe).toBe(false);
    // toEqual ignores undefined-valued keys, so this holds whether or not the
    // parser materialized an explicit `salary: undefined`.
    expect(safe).toEqual(defaultSettings());
  });

  it('notice explains what stays local (chrome.storage.local) and that AI off = no sends', () => {
    const local = PRIVACY_NOTICE.staysLocal.join(' ');
    expect(local).toMatch(/chrome\.storage\.local/);
    expect(local).toMatch(/on this device/);
    expect(local).toMatch(/no network requests/);
  });

  it('notice explains what may be sent: only with AI enabled AND a configured provider', () => {
    const may = PRIVACY_NOTICE.mayBeSent.join(' ');
    expect(may).toMatch(/enable AI/);
    expect(may).toMatch(/provider/);
    expect(may).toMatch(/AI-safe/);
  });

  it('notice lists compensation and legal/eligibility answers as never sent', () => {
    const never = PRIVACY_NOTICE.neverSent.join(' ');
    expect(never).toMatch(/Compensation/);
    expect(never).toMatch(/Legal eligibility/);
    expect(never).toMatch(/voluntary-disclosure/);
    expect(never).toMatch(/never guesses/);
  });
});
