/**
 * Tests for the v2 Profile schema (src/lib/profile.ts).
 *
 * Covers: valid data, optional-field friendliness, strict typing, date/range
 * errors, enum validation, non-invention defaults, and schema versioning.
 */
import { describe, expect, it } from 'vitest';
import {
  profileSchema,
  PROFILE_SCHEMA_VERSION,
  type Profile,
} from './profile';
import { sampleProfile } from './sample-profile';

/** Minimal valid profile — only the fields that have no default at all. */
const minimal: Record<string, unknown> = {
  schemaVersion: '2',
};

describe('profileSchema (v2)', () => {
  it('accepts a minimal profile (all optional-field-friendly)', () => {
    const parsed = profileSchema.parse(minimal);
    expect(parsed.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    // Defaults are EMPTY containers, never invented candidate details.
    expect(parsed.skills).toEqual([]);
    expect(parsed.experience).toEqual([]);
    expect(parsed.education).toEqual([]);
    expect(parsed.certifications).toEqual([]);
    expect(parsed.projects).toEqual([]);
    expect(parsed.languages).toEqual([]);
    expect(parsed.preferences.targetTitles).toEqual([]);
    expect(parsed.preferences.applicationAnswers).toEqual([]);
    expect(parsed.headline).toBeUndefined();
    expect(parsed.summary).toBeUndefined();
    expect(parsed.portfolio).toBeUndefined();
  });

  it('accepts the fake sample profile and round-trips it unchanged', () => {
    const parsed = profileSchema.parse(sampleProfile);
    expect(parsed).toEqual(sampleProfile);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const bad = { ...minimal, inventedField: 'nope' };
    expect(() => profileSchema.parse(bad)).toThrow();
  });

  it('rejects a wrong schema version', () => {
    expect(() => profileSchema.parse({ ...minimal, schemaVersion: '999' })).toThrow();
  });

  /* ---------------- dates / ranges ---------------- */

  it('rejects a malformed month in experience dates', () => {
    const bad = {
      ...minimal,
      experience: [
        {
          id: 'e1',
          company: 'Co',
          title: 'T',
          dates: { start: '2020-13', end: null },
          bullets: ['b'],
        },
      ],
    };
    expect(() => profileSchema.parse(bad)).toThrow(/YYYY-MM/);
  });

  it('rejects end < start in a date range', () => {
    const bad = {
      ...minimal,
      experience: [
        {
          id: 'e1',
          company: 'Co',
          title: 'T',
          dates: { start: '2021-01', end: '2020-12' },
          bullets: ['b'],
        },
      ],
    };
    expect(() => profileSchema.parse(bad)).toThrow(/end must be >= start/);
  });

  it('accepts end = null (ongoing) and full-precision certification dates', () => {
    const good = {
      ...minimal,
      certifications: [
        {
          id: 'c1',
          name: 'Cert',
          issued: '2022-06-15',
          expires: '2025-06-15',
        },
      ],
      experience: [
        {
          id: 'e1',
          company: 'Co',
          title: 'T',
          dates: { start: '2020-01', end: null },
          bullets: ['b'],
        },
      ],
    };
    const parsed = profileSchema.parse(good);
    const exp = parsed.experience[0];
    const cert = parsed.certifications[0];
    if (!exp || !cert) throw new Error('expected parsed items to exist');
    expect(exp.dates.end).toBeNull();
    expect(cert.issued).toBe('2022-06-15');
  });

  it('rejects a malformed full date in certifications (day 32)', () => {
    const bad = {
      ...minimal,
      certifications: [{ id: 'c1', name: 'Cert', issued: '2022-06-32' }],
    };
    expect(() => profileSchema.parse(bad)).toThrow(/YYYY-MM-DD/);
  });

  it('rejects a malformed certification URL', () => {
    const bad = {
      ...minimal,
      certifications: [{ id: 'c1', name: 'Cert', credentialUrl: 'not-a-url' }],
    };
    expect(() => profileSchema.parse(bad)).toThrow();
  });

  /* ---------------- enums ---------------- */

  it('rejects an invalid language level', () => {
    const bad = {
      ...minimal,
      languages: [{ language: 'English', level: 'fluent++' }],
    };
    expect(() => profileSchema.parse(bad)).toThrow();
  });

  it('rejects an invalid seniority enum', () => {
    const bad = {
      ...minimal,
      experience: [
        {
          id: 'e1',
          company: 'Co',
          title: 'T',
          dates: { start: '2020-01', end: null },
          bullets: ['b'],
          seniority: 'wizard',
        },
      ],
    };
    expect(() => profileSchema.parse(bad)).toThrow();
  });

  it('rejects an invalid evidence kind', () => {
    const bad = {
      ...minimal,
      skills: [
        { id: 's1', name: 'S', status: 'verified', evidenceRef: { kind: 'guess', id: 'x' } },
      ],
    };
    expect(() => profileSchema.parse(bad)).toThrow();
  });

  it('rejects empty experience bullets and empty ids', () => {
    const noBullets = {
      ...minimal,
      experience: [
        { id: 'e1', company: 'Co', title: 'T', dates: { start: '2020-01', end: null }, bullets: [] },
      ],
    };
    expect(() => profileSchema.parse(noBullets)).toThrow();

    const noId = {
      ...minimal,
      experience: [
        { id: '', company: 'Co', title: 'T', dates: { start: '2020-01', end: null }, bullets: ['b'] },
      ],
    };
    expect(() => profileSchema.parse(noId)).toThrow();
  });

  /* ---------------- optional-field friendliness ---------------- */

  it('accepts an experience item without optional location/seniority', () => {
    const good = {
      ...minimal,
      experience: [
        {
          id: 'e1',
          company: 'Co',
          title: 'T',
          dates: { start: '2020-01', end: '2021-01' },
          bullets: ['b'],
        },
      ],
    };
    const parsed = profileSchema.parse(good);
    const exp = parsed.experience[0];
    if (!exp) throw new Error('expected parsed item to exist');
    expect(exp.location).toBeUndefined();
    expect(exp.seniority).toBeUndefined();
  });

  it('accepts an education item without credential/grade (inProgress defaults false)', () => {
    const good = {
      ...minimal,
      education: [
        { id: 'ed1', institution: 'Fake U', dates: { start: '2016-09', end: '2020-05' } },
      ],
    };
    const parsed = profileSchema.parse(good);
    const edu = parsed.education[0];
    if (!edu) throw new Error('expected parsed item to exist');
    expect(edu.credential).toBeUndefined();
    expect(edu.inProgress).toBe(false);
  });

  it('accepts a certification with neither issued nor credentialUrl', () => {
    const good = {
      ...minimal,
      certifications: [{ id: 'c1', name: 'Some Cert' }],
    };
    const parsed = profileSchema.parse(good);
    const cert = parsed.certifications[0];
    if (!cert) throw new Error('expected parsed item to exist');
    expect(cert.issued).toBeUndefined();
    expect(cert.credentialUrl).toBeUndefined();
  });

  it('defaults skills to claimed when status omitted', () => {
    const good = { ...minimal, skills: [{ id: 's1', name: 'TypeScript' }] };
    const parsed = profileSchema.parse(good);
    const first = parsed.skills[0];
    if (!first) throw new Error('expected parsed item to exist');
    expect(first.status).toBe('claimed');
  });

  /* ---------------- sensitive-data separation ---------------- */

  it('does NOT contain contact/sensitive fields at all (separation is structural)', () => {
    // These must live in src/lib/sensitive.ts, never in the AI-safe profile.
    const forbidden = [
      'email',
      'phone',
      'address',
      'compensation',
      'legal',
      'voluntary',
      'documents',
      'workAuthorization',
      'gender',
      'veteranStatus',
    ];
    const keys = Object.keys(
      (profileSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    for (const f of forbidden) {
      expect(keys).not.toContain(f);
    }
  });
});

describe('Profile type inference (compile-time + runtime parity)', () => {
  it('produce a Profile object that round-trips through the schema unchanged', () => {
    const p: Profile = sampleProfile;
    expect(profileSchema.parse(p)).toEqual(p);
  });
});
