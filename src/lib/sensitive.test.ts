/**
 * Tests for the sensitive profile schema (src/lib/sensitive.ts) and the
 * structural sensitive-data separation between the two schemas.
 */
import { describe, expect, it } from 'vitest';
import { profileSchema } from './profile';
import {
  sensitiveProfileSchema,
  SENSITIVE_SCHEMA_VERSION,
} from './sensitive';
import { sampleSensitiveProfile } from './sample-profile';

const validContact = {
  firstName: 'Test',
  lastName: 'User',
  email: 'test@example.com',
  phone: '555-0100',
};

describe('sensitiveProfileSchema', () => {
  it('accepts the fake sensitive sample and round-trips it', () => {
    expect(sensitiveProfileSchema.parse(sampleSensitiveProfile)).toEqual(
      sampleSensitiveProfile,
    );
  });

  it('accepts voluntary "undisclosed" everywhere (nothing guessed)', () => {
    const parsed = sensitiveProfileSchema.parse({
      schemaVersion: SENSITIVE_SCHEMA_VERSION,
      contact: validContact,
      legal: { workAuthorization: 'undisclosed', sponsorshipNeeded: false },
      voluntary: {
        gender: 'undisclosed',
        raceEthnicity: ['undisclosed'],
        veteranStatus: 'undisclosed',
        disabilityStatus: 'undisclosed',
      },
      documents: {},
    });
    expect(parsed.voluntary.gender).toBe('undisclosed');
    expect(parsed.voluntary.veteranStatus).toBe('undisclosed');
  });

  it('rejects an invalid email', () => {
    const bad = {
      schemaVersion: SENSITIVE_SCHEMA_VERSION,
      contact: { ...validContact, email: 'not-an-email' },
      legal: { workAuthorization: 'citizen', sponsorshipNeeded: false },
      voluntary: {
        gender: 'undisclosed',
        raceEthnicity: ['undisclosed'],
        veteranStatus: 'undisclosed',
        disabilityStatus: 'undisclosed',
      },
      documents: {},
    };
    expect(() => sensitiveProfileSchema.parse(bad)).toThrow();
  });

  it('rejects an unknown workAuthorization enum value and unknown keys', () => {
    const base = {
      schemaVersion: SENSITIVE_SCHEMA_VERSION,
      contact: validContact,
      voluntary: {
        gender: 'undisclosed',
        raceEthnicity: ['undisclosed'],
        veteranStatus: 'undisclosed',
        disabilityStatus: 'undisclosed',
      },
      documents: {},
    };
    expect(() =>
      sensitiveProfileSchema.parse({ ...base, legal: { workAuthorization: 'wizard', sponsorshipNeeded: false } }),
    ).toThrow();
    expect(() =>
      sensitiveProfileSchema.parse({ ...base, legal: { workAuthorization: 'citizen', sponsorshipNeeded: false, extra: 1 } }),
    ).toThrow();
  });

  it('rejects a wrong schema version', () => {
    expect(() =>
      sensitiveProfileSchema.parse({ ...sampleSensitiveProfile, schemaVersion: '9' }),
    ).toThrow();
  });
});

describe('sensitive-data separation (structural)', () => {
  const aiSafeKeys = Object.keys(
    (profileSchema as unknown as { shape: Record<string, unknown> }).shape,
  );
  const sensitiveKeys = Object.keys(
    (sensitiveProfileSchema as unknown as { shape: Record<string, unknown> }).shape,
  );

  it('AI-safe profile has no sensitive fields', () => {
    const forbidden = ['contact', 'legal', 'voluntary', 'documents', 'email', 'phone', 'address'];
    for (const f of forbidden) expect(aiSafeKeys).not.toContain(f);
  });

  it('sensitive profile shares no DATA keys with the AI-safe profile (schemaVersion is expected metadata)', () => {
    for (const k of aiSafeKeys) {
      if (k === 'schemaVersion') continue; // metadata key, intentionally present on both
      expect(sensitiveKeys).not.toContain(k);
    }
  });

  it('AI-safe profile rejects a top-level "contact" key (strict parsing)', () => {
    expect(() =>
      profileSchema.parse({ contact: { email: 'x@y.z' } }),
    ).toThrow();
  });
});
