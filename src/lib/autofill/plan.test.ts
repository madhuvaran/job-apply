/**
 * Planner tests (Prompt 14). Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { profileSchema } from '../profile';
import { sensitiveProfileSchema } from '../sensitive';
import { buildFillPlan } from './plan';
import { fillPlanSchema, type FieldDescriptor } from './schemas';

function d(fieldId: string, partial: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { fieldId, kind: 'text', ...partial };
}

const profile = profileSchema.parse({
  displayName: 'Ada Example',
  summary: 'Pioneer of computing.',
  skills: [
    { id: 's1', name: 'TypeScript' },
    { id: 's2', name: 'Rust' },
  ],
  linkedin: 'https://www.linkedin.com/in/ada',
  portfolio: 'https://ada.example.invalid',
});

const sensitive = sensitiveProfileSchema.parse({
  contact: {
    firstName: 'Ada',
    lastName: 'Example',
    email: 'ada@example.invalid',
    phone: '+1 555 0100',
    cityLabel: 'London',
  },
  legal: { workAuthorization: 'authorized_no_sponsorship', sponsorshipNeeded: false },
  voluntary: {
    gender: 'undisclosed',
    raceEthnicity: ['undisclosed'],
    veteranStatus: 'undisclosed',
    disabilityStatus: 'undisclosed',
  },
});

describe('buildFillPlan — happy path', () => {
  it('plans supported fields in descriptor order with the right sources', () => {
    const built = buildFillPlan({
      descriptors: [
        d('a', { labelText: 'First name' }),
        d('b', { labelText: 'Email' }),
        d('c', { labelText: 'LinkedIn profile' }),
        d('d', { kind: 'textarea', labelText: 'Key skills' }),
        d('e', { kind: 'textarea', labelText: 'Professional summary' }),
      ],
      profile,
      sensitive,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.plan.instructions.map((i) => i.fieldId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(built.plan.instructions.map((i) => i.category)).toEqual([
      'firstName',
      'email',
      'linkedin',
      'skills',
      'summary',
    ]);
    expect(built.plan.instructions[0]).toMatchObject({ value: 'Ada', source: 'sensitive', requiresConfirmation: true });
    expect(built.plan.instructions[2]).toMatchObject({ value: 'https://www.linkedin.com/in/ada', source: 'profile' });
    expect(built.plan.instructions[3]?.value).toBe('TypeScript, Rust');
    expect(fillPlanSchema.safeParse(built.plan).success).toBe(true);
  });

  it('plans work-authorization/sponsorship only for choice controls', () => {
    const built = buildFillPlan({
      descriptors: [
        d('wa-select', { kind: 'select', labelText: 'Are you authorized to work?' }),
        d('sp-select', { kind: 'select', labelText: 'Will you require sponsorship?' }),
        d('wa-text', { labelText: 'Work authorization details' }),
      ],
      profile,
      sensitive,
    });
    if (!built.ok) throw new Error('expected ok');
    const byId = new Map(built.plan.instructions.map((i) => [i.fieldId, i]));
    expect(byId.get('wa-select')?.value).toBe('Authorized to work — no sponsorship required');
    expect(byId.get('sp-select')?.value).toBe('No');
    expect(byId.has('wa-text')).toBe(false);
    const review = built.review.find((r) => r.fieldId === 'wa-text');
    expect(review?.decision).toBe('manual');
    expect(review?.reason).toMatch(/choice fields/i);
  });
});

describe('buildFillPlan — missing answers are never guessed', () => {
  it('omits fields with no saved answer and gives a typed reason', () => {
    const built = buildFillPlan({
      descriptors: [
        d('a', { labelText: 'First name' }),
        d('c', { labelText: 'Country' }),
        d('s', { labelText: 'State / Province' }),
      ],
      profile: null,
      sensitive: null,
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    for (const id of ['a', 'c', 's']) {
      const review = built.review.find((r) => r.fieldId === id);
      expect(review?.decision).toBe('manual');
      expect(review?.reason).toMatch(/No saved answer/);
      expect(review?.proposedValue).toBeUndefined();
    }
  });

  it('treats an undisclosed work-authorization answer as missing', () => {
    const undisclosed = sensitiveProfileSchema.parse({
      ...sensitive,
      legal: { workAuthorization: 'undisclosed', sponsorshipNeeded: false },
    });
    const built = buildFillPlan({
      descriptors: [d('wa', { kind: 'select', labelText: 'Work authorization' })],
      profile,
      sensitive: undisclosed,
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    expect(built.review[0]?.decision).toBe('manual');
  });

  it('excludes sensitive/voluntary/compensation fields from the plan', () => {
    const built = buildFillPlan({
      descriptors: [
        d('pw', { inputType: 'password', labelText: 'Password' }),
        d('eeo', { kind: 'select', labelText: 'Gender' }),
        d('sal', { labelText: 'Expected salary' }),
        d('legal', { kind: 'checkbox', labelText: 'I agree to the terms' }),
      ],
      profile,
      sensitive,
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    for (const r of built.review) expect(r.classification).toBe('excluded');
  });
});

describe('buildFillPlan — isolation & determinism', () => {
  it('keeps sensitive answers tagged as sensitive and out of profile-sourced entries', () => {
    const built = buildFillPlan({
      descriptors: [
        d('a', { labelText: 'First name' }),
        d('c', { labelText: 'Key skills' }),
      ],
      profile,
      sensitive,
    });
    if (!built.ok) throw new Error('expected ok');
    const json = JSON.stringify(built.plan);
    expect(json).toContain('"source":"sensitive"');
    expect(json).not.toContain('undisclosed');
    expect(json).not.toContain('gender');
    expect(json).not.toContain('compensation');
  });

  it('is deterministic and does not mutate its inputs', () => {
    const descriptors = [d('a', { labelText: 'First name' }), d('b', { labelText: 'Email' })];
    const snapshot = JSON.stringify({ descriptors, profile, sensitive });
    const first = buildFillPlan({ descriptors, profile, sensitive });
    const second = buildFillPlan({ descriptors, profile, sensitive });
    expect(second).toEqual(first);
    expect(JSON.stringify({ descriptors, profile, sensitive })).toBe(snapshot);
  });

  it('rejects invalid input with path+message issues (no values)', () => {
    const badDescriptors = buildFillPlan({
      descriptors: [{ fieldId: 'x', kind: 'text', value: 'SECRET' }],
      profile,
      sensitive,
    });
    expect(badDescriptors.ok).toBe(false);
    if (!badDescriptors.ok) {
      expect(badDescriptors.reason).toBe('invalid-input');
      expect(badDescriptors.issues.join(' ')).not.toContain('SECRET');
    }

    const badProfile = buildFillPlan({
      descriptors: [d('a', { labelText: 'First name' })],
      profile: { schemaVersion: '9' },
      sensitive,
    });
    expect(badProfile.ok).toBe(false);
    if (!badProfile.ok) expect(badProfile.issues.some((i) => i.startsWith('profile.'))).toBe(true);
  });
});
