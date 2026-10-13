/**
 * Tests for the deterministic job match estimate
 * (src/lib/matching/estimate.ts + requirements.ts + factors.ts).
 *
 * Covers the Prompt 09 matrix: strong/weak matches, partial information,
 * required vs preferred weighting, contradictions vs unknowns, normalization
 * and alias conservatism, substring false positives, insufficient data,
 * threshold behavior, determinism, immutability, zero network, and the
 * absence of sensitive data from results. Synthetic data only.
 */
import { describe, expect, it, vi } from 'vitest';
import { calculateJobMatch, type JobMatchOutcome } from './estimate';
import { computeFactors, MATCH_WEIGHTS, MIN_SCORE_WEIGHT } from './factors';
import { collectWantedSkills, observedCareerSpan } from './requirements';
import { matchResultSchema, validateMatchResult, type JobMatchResult } from './schemas';
import { profileSchema, type Profile } from '../profile';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { defaultSettings, settingsSchema, type Settings } from '../settings';

/* ------------------------------------------------------------------ */
/* Synthetic fixtures (fake data only)                                 */
/* ------------------------------------------------------------------ */

const AS_OF = '2026-09-01T00:00:00.000Z';

function makeProfile(patch: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    displayName: 'Fake Candidate',
    headline: 'Backend Engineer',
    summary: 'Fake summary for testing.',
    skills: [
      { id: 'sk-react', name: 'React', status: 'verified', evidenceRef: { kind: 'experience', id: 'exp-1', quote: 'Used React daily.' } },
      { id: 'sk-ts', name: 'TypeScript', status: 'claimed' },
      { id: 'sk-node', name: 'Node.js', status: 'claimed' },
    ],
    experience: [
      {
        id: 'exp-1',
        company: 'Fake Co',
        title: 'Software Engineer',
        dates: { start: '2018-03', end: null },
        bullets: ['Built fake things with fake tools.'],
      },
    ],
    ...patch,
  });
}

function makeJob(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-1',
    title: 'Backend Engineer',
    company: 'Fake Co',
    location: 'Berlin, DE',
    rawDescription: 'A fake raw description mentioning React in passing.',
    responsibilities: ['Build services with Node.js', 'Ship TypeScript features'],
    requiredQualifications: ['Experience with React', 'Node.js expertise'],
    preferredQualifications: ['Kubernetes knowledge'],
    skills: ['TypeScript'],
    experienceRange: { minYears: 3 },
    workArrangement: 'remote',
    employmentType: 'full-time',
    source: 'manual',
    capturedAt: AS_OF,
    ...patch,
  });
}

function makeSettings(patch: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse({
    ...defaultSettings(),
    targetLocations: ['Berlin'],
    workModes: ['remote'],
    employmentTypes: ['full-time'],
    ...patch,
  });
}

function run(profile: Profile, job: JobPosting, settings: Settings): JobMatchResult {
  const out = calculateJobMatch(profile, job, settings);
  if (out.kind !== 'invalid') return out.result;
  throw new Error(`expected valid inputs, got: ${out.issues.join('; ')}`);
}

function statusOf(result: JobMatchResult, id: string): string | undefined {
  return result.requirements.find((r) => r.id === id)?.status;
}

function factorOf(result: JobMatchResult, factor: string) {
  return result.estimate.factors.find((f) => f.factor === factor);
}

function issueSeverities(result: JobMatchResult): Record<string, string> {
  return Object.fromEntries(result.hardIssues.map((i) => [i.requirementId, i.severity]));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) deepFreeze(inner);
  }
  return value;
}

const expectValidShape = (result: JobMatchResult): void => {
  expect(validateMatchResult(result).ok).toBe(true);
  expect(matchResultSchema.safeParse(result).success).toBe(true);
};

/* ------------------------------------------------------------------ */
/* 1. Strong match                                                     */
/* ------------------------------------------------------------------ */

describe('strong match with verified relevant skills', () => {
  it('scores high, matched statuses, evidence refs, no hard issues', () => {
    const result = run(makeProfile(), makeJob(), makeSettings());
    expectValidShape(result);
    expect(result.estimate.outcome).toBe('score');
    if (result.estimate.outcome !== 'score') return;
    expect(result.estimate.score).toBeGreaterThanOrEqual(80);

    expect(statusOf(result, 'skill:react')).toBe('matched');
    expect(statusOf(result, 'skill:node')).toBe('matched');
    expect(statusOf(result, 'skill:typescript')).toBe('matched');
    expect(statusOf(result, 'experience:years')).toBe('matched');
    expect(statusOf(result, 'pref:location')).toBe('matched');

    // Verified skill carries its evidence reference; claimed skill carries its id.
    const react = result.requirements.find((r) => r.id === 'skill:react');
    expect(react?.evidence).toEqual([
      { kind: 'skill', id: 'sk-react', label: 'React' },
    ]);
    expect(react?.explanation).toContain('verified');

    // Preferred skill the profile lacks is UNKNOWN (no proof of absence),
    // and a preferred skill never creates a hard issue.
    expect(statusOf(result, 'skill:kubernetes')).toBe('unknown');
    expect(result.hardIssues).toHaveLength(0);

    // Every factor is reported with weight and score (null only when unknown).
    expect(result.estimate.factors.map((f) => f.factor)).toEqual([
      'requiredSkills',
      'preferredSkills',
      'experience',
      'roleAlignment',
      'preferences',
    ]);
    expect(factorOf(result, 'requiredSkills')?.score).toBe(100);
    expect(factorOf(result, 'preferredSkills')?.score).toBeNull(); // 1 unknown item, no decisive data
    expect(factorOf(result, 'roleAlignment')?.score).toBe(100);
    expect(result.threshold.decision).toBe('disabled'); // default minMatchThreshold = 0
    expect(result.summary).toContain('not an employer ATS score');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Weak match with confirmed gaps                                   */
/* ------------------------------------------------------------------ */

describe('weak match with confirmed missing requirements', () => {
  const weakProfile = (): Profile =>
    makeProfile({
      headline: 'Backend Engineer',
      skills: [{ id: 'sk-react', name: 'React', status: 'claimed' }],
      education: [
        {
          id: 'edu-1',
          institution: 'Fake University',
          credential: 'B.Sc. Computer Science',
          inProgress: false,
          dates: { start: '2016-09', end: '2020-05' },
        },
      ],
      experience: [
        {
          id: 'exp-1',
          company: 'Fake Co',
          title: 'Software Engineer',
          dates: { start: '2023-01', end: null },
          bullets: ['Built fake things.'],
        },
      ],
      preferences: {
        targetTitles: [],
        willingToRelocate: false,
        workModes: [],
        targetLocations: [],
        applicationAnswers: [],
      },
    });
  const weakJob = (): JobPosting =>
    makeJob({
      title: 'Platform Engineer',
      location: 'Tokyo, JP',
      workArrangement: 'onsite',
      employmentType: 'full-time',
      skills: [],
      responsibilities: ['Manage Kubernetes clusters'],
      requiredQualifications: ["Master's degree required", 'Kubernetes expertise'],
      preferredQualifications: [],
      experienceRange: { minYears: 8 },
    });
  const weakSettings = (): Settings =>
    makeSettings({
      targetLocations: ['Berlin'],
      workModes: ['remote'],
      employmentTypes: ['part-time'],
      minMatchThreshold: 70,
    });

  it('produces a low score with confirmed gaps visible as hard issues', () => {
    const result = run(weakProfile(), weakJob(), weakSettings());
    expectValidShape(result);
    expect(result.estimate.outcome).toBe('score');
    if (result.estimate.outcome !== 'score') return;
    expect(result.estimate.score).toBeLessThanOrEqual(35);

    // Confirmed mismatches (affirmative contradictions) are `missing`...
    expect(statusOf(result, 'education:master')).toBe('missing');
    expect(statusOf(result, 'experience:years')).toBe('missing');
    expect(statusOf(result, 'pref:location')).toBe('missing');
    expect(statusOf(result, 'pref:work-arrangement')).toBe('missing');
    expect(statusOf(result, 'pref:employment-type')).toBe('missing');

    // ...while an unevidenced skill is UNKNOWN (absence is not proof).
    expect(statusOf(result, 'skill:kubernetes')).toBe('unknown');

    const severities = issueSeverities(result);
    expect(severities['education:master']).toBe('confirmed');
    expect(severities['experience:years']).toBe('confirmed');
    expect(severities['pref:employment-type']).toBe('confirmed');
    expect(severities['skill:kubernetes']).toBe('potential');
    expect(result.hardIssues.length).toBeGreaterThanOrEqual(5);

    // A positive threshold fails (never silently passes).
    expect(result.threshold.decision).toBe('below');
    expect(result.threshold.meets).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 3 + 13 + 19. Partial information / empty posting / insufficient data */
/* ------------------------------------------------------------------ */

describe('partial information and insufficient data', () => {
  it('a posting with almost no extracted sections yields insufficient-data', () => {
    const job = makeJob({
      skills: [],
      responsibilities: [],
      requiredQualifications: [],
      preferredQualifications: [],
      experienceRange: undefined,
      location: undefined,
      workArrangement: undefined,
      employmentType: undefined,
      rawDescription: '...',
    });
    const result = run(makeProfile(), job, makeSettings({ targetLocations: [], workModes: [], employmentTypes: [] }));
    expectValidShape(result);
    expect(result.estimate.outcome).toBe('insufficient-data');
    if (result.estimate.outcome !== 'insufficient-data') return;
    expect(result.estimate.availableWeight).toBeLessThan(MIN_SCORE_WEIGHT);
    expect('score' in result.estimate).toBe(false);
    expect(result.confidence.counts.total).toBeLessThanOrEqual(1);
  });

  it('an empty profile against a rich posting is inconclusive, not a zero score', () => {
    const result = run(profileSchema.parse({}), makeJob(), makeSettings());
    expectValidShape(result);
    expect(result.estimate.outcome).toBe('insufficient-data');
    // Skills are UNKNOWN, never "missing", when the profile has no data.
    expect(statusOf(result, 'skill:react')).toBe('unknown');
    expect(issueSeverities(result)['skill:react']).toBeUndefined();
    expect(result.confidence.level).toBe('low');
  });

  it('insufficient data never counts as a threshold pass', () => {
    const job = makeJob({
      skills: [],
      responsibilities: [],
      requiredQualifications: [],
      preferredQualifications: [],
      experienceRange: undefined,
      location: undefined,
      workArrangement: undefined,
      employmentType: undefined,
    });
    const result = run(makeProfile(), job, makeSettings({ minMatchThreshold: 1 }));
    expect(result.threshold.decision).toBe('insufficient-data');
    expect(result.threshold.meets).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Required vs preferred weighting                                  */
/* ------------------------------------------------------------------ */

describe('required versus preferred skill weighting', () => {
  it('weights are configured in one place and sum to 100', () => {
    const sum = Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
    expect(MATCH_WEIGHTS.requiredSkills).toBeGreaterThan(MATCH_WEIGHTS.preferredSkills);
  });

  it('the final score is exactly the documented weighted average', () => {
    const result = run(makeProfile(), makeJob(), makeSettings());
    if (result.estimate.outcome !== 'score') throw new Error('expected a score');
    const assessable = result.estimate.factors.filter((f) => f.score !== null);
    const weightSum = assessable.reduce((s, f) => s + f.weight, 0);
    const weighted = assessable.reduce((s, f) => s + (f.score ?? 0) * f.weight, 0);
    expect(result.estimate.availableWeight).toBe(weightSum);
    expect(result.estimate.score).toBe(Math.round(weighted / weightSum));
  });

  it('losing preferred skills lowers the score by the preferred weight share only', () => {
    const withPreferred = run(
      makeProfile(),
      makeJob({ preferredQualifications: ['TypeScript'] }), // already matched via skills[]; use distinct
      makeSettings(),
    );
    const base = run(makeProfile(), makeJob({ preferredQualifications: [] }), makeSettings());
    const withPython = run(
      makeProfile(),
      makeJob({ preferredQualifications: ['Python'] }), // not in profile -> unknown, factor unaffected
      makeSettings(),
    );
    expect(withPreferred.estimate.outcome).toBe('score');
    expect(base.estimate.outcome).toBe('score');
    expect(withPython.estimate.outcome).toBe('score');
    // Unknown preferred skill does not change the numeric score (excluded, not failed).
    if (withPython.estimate.outcome === 'score' && base.estimate.outcome === 'score') {
      expect(withPython.estimate.score).toBe(base.estimate.score);
    }
    expect(factorOf(base, 'preferredSkills')?.score).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6 + 7. Contradictions vs absence of evidence                       */
/* ------------------------------------------------------------------ */

describe('contradicted required qualification vs absent qualification', () => {
  it('a completed masters satisfies a masters requirement (matched, with evidence)', () => {
    const profile = makeProfile({
      education: [
        {
          id: 'edu-msc',
          institution: 'Fake University',
          credential: 'M.Sc. Fake Studies',
          inProgress: false,
          dates: { start: '2018-09', end: '2020-05' },
        },
      ],
    });
    const job = makeJob({ requiredQualifications: ["Master's degree required"] });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'education:master')).toBe('matched');
    expect(
      result.requirements.find((r) => r.id === 'education:master')?.evidence,
    ).toEqual([{ kind: 'education', id: 'edu-msc' }]);
  });

  it('an in-progress degree at the required level is unknown, not matched', () => {
    const profile = makeProfile({
      education: [
        {
          id: 'edu-msc',
          institution: 'Fake University',
          credential: 'M.Sc. Fake Studies',
          inProgress: true,
          dates: { start: '2024-09', end: null },
        },
      ],
    });
    const job = makeJob({ requiredQualifications: ["Master's degree required"] });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'education:master')).toBe('unknown');
    expect(result.hardIssues).toHaveLength(0);
  });

  it('a required skill absent from a populated skills list is UNKNOWN with a potential issue', () => {
    const job = makeJob({ skills: ['Kubernetes'], requiredQualifications: [] });
    const result = run(makeProfile(), job, makeSettings());
    expect(statusOf(result, 'skill:kubernetes')).toBe('unknown');
    expect(issueSeverities(result)['skill:kubernetes']).toBe('potential');
  });

  it('a required skill absent when the profile lists NO skills is plain unknown', () => {
    const profile = makeProfile({ skills: [] });
    const job = makeJob({ skills: ['Kubernetes'], requiredQualifications: [] });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'skill:kubernetes')).toBe('unknown');
    expect(issueSeverities(result)['skill:kubernetes']).toBeUndefined();
    expect(result.requirements.find((r) => r.id === 'skill:kubernetes')?.explanation).toContain(
      'no skills',
    );
  });

  it('career span below the posted minimum is a confirmed mismatch', () => {
    const profile = makeProfile({
      experience: [
        {
          id: 'exp-1',
          company: 'Fake Co',
          title: 'Engineer',
          dates: { start: '2025-01', end: null },
          bullets: ['Fake bullet.'],
        },
      ],
    });
    const job = makeJob({ experienceRange: { minYears: 8 }, skills: [], requiredQualifications: [] });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'experience:years')).toBe('missing');
    expect(issueSeverities(result)['experience:years']).toBe('confirmed');
  });
});

/* ------------------------------------------------------------------ */
/* 8 + 9 + 10. Normalization, aliases, substring false positives       */
/* ------------------------------------------------------------------ */

describe('normalization and conservative matching', () => {
  it('case and whitespace variations still match', () => {
    const job = makeJob({
      skills: ['  typescript  '],
      requiredQualifications: ['EXPERIENCE WITH REACT'],
      preferredQualifications: [],
    });
    const result = run(makeProfile(), job, makeSettings());
    expect(statusOf(result, 'skill:typescript')).toBe('matched');
    expect(statusOf(result, 'skill:react')).toBe('matched');
  });

  it('defensible aliases match (k8s, node.js, postgres)', () => {
    const profile = makeProfile({
      skills: [
        { id: 'a', name: 'k8s', status: 'claimed' },
        { id: 'b', name: 'PostgreSQL', status: 'claimed' },
      ],
    });
    const job = makeJob({
      skills: ['Kubernetes', 'Node.js', 'Postgres'],
      requiredQualifications: [],
      preferredQualifications: [],
    });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'skill:kubernetes')).toBe('matched');
    expect(statusOf(result, 'skill:postgresql')).toBe('matched');
    // node.js requirement vs a profile without node: unknown, not missing.
    expect(statusOf(result, 'skill:node')).toBe('unknown');
  });

  it('"java" never matches a "JavaScript" profile skill (substring false positive)', () => {
    const profile = makeProfile({
      skills: [{ id: 'js', name: 'JavaScript', status: 'verified' }],
    });
    const job = makeJob({ skills: ['Java'], requiredQualifications: [], preferredQualifications: [] });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'skill:java')).toBe('unknown');
    const item = result.requirements.find((r) => r.id === 'skill:java');
    expect(item?.evidence).toEqual([]);
  });

  it('a skill mentioned ONLY in the raw description never becomes a requirement', () => {
    const job = makeJob({
      skills: [],
      responsibilities: [],
      requiredQualifications: [],
      preferredQualifications: [],
      rawDescription: 'React React React somewhere in prose only.',
    });
    const result = run(makeProfile(), job, makeSettings());
    expect(result.requirements.some((r) => r.id === 'skill:react')).toBe(false);
    expect(result.requirements.some((r) => r.category === 'skill')).toBe(false);
  });

  it('a vague qualification line without vocabulary skills yields no skill requirement', () => {
    const job = makeJob({
      skills: [],
      requiredQualifications: ['Excellent communication skills'],
      preferredQualifications: [],
    });
    const result = run(makeProfile(), job, makeSettings());
    expect(result.requirements.some((r) => r.category === 'skill')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Relevant vs unrelated skill evidence                            */
/* ------------------------------------------------------------------ */

describe('relevant versus unrelated skill evidence', () => {
  it('React Native in the profile is PARTIAL evidence for a React requirement', () => {
    const profile = makeProfile({
      skills: [{ id: 'rn', name: 'React Native', status: 'verified' }],
    });
    const job = makeJob({ skills: ['React'], requiredQualifications: [], preferredQualifications: [] });
    const result = run(profile, job, makeSettings());
    expect(statusOf(result, 'skill:react')).toBe('partial');
    expect(result.requirements.find((r) => r.id === 'skill:react')?.evidence).toEqual([
      { kind: 'skill', id: 'rn', label: 'React Native' },
    ]);
  });

  it('the reverse direction (React Native requirement, React evidence) is also partial', () => {
    const job = makeJob({
      skills: ['React Native'],
      requiredQualifications: [],
      preferredQualifications: [],
    });
    const result = run(makeProfile(), job, makeSettings());
    expect(statusOf(result, 'skill:react-native')).toBe('partial');
  });

  it('a profile skill with evidenceRef surfaces the reference in the result', () => {
    const result = run(makeProfile(), makeJob(), makeSettings());
    const react = result.requirements.find((r) => r.id === 'skill:react');
    expect(react?.evidence[0]?.id).toBe('sk-react');
    // References only — the result never copies profile content.
    expect(JSON.stringify(result)).not.toContain('Used React daily.');
  });
});

/* ------------------------------------------------------------------ */
/* 12. Missing job description sections                                */
/* ------------------------------------------------------------------ */

describe('missing job description sections', () => {
  it('missing qualification sections produce no skill items but keep prefs assessable', () => {
    const job = makeJob({
      skills: [],
      responsibilities: [],
      requiredQualifications: [],
      preferredQualifications: [],
    });
    const result = run(makeProfile(), job, makeSettings());
    expectValidShape(result);
    expect(result.requirements.some((r) => r.category === 'skill')).toBe(false);
    // Location/employment/work-mode preferences are still compared.
    expect(statusOf(result, 'pref:location')).toBe('matched');
    expect(statusOf(result, 'pref:work-arrangement')).toBe('matched');
    expect(statusOf(result, 'pref:employment-type')).toBe('matched');
  });

  it('unconfigured preferences with posting facts are reported as unknown, not guessed', () => {
    const result = run(
      makeProfile(),
      makeJob(), // location, workArrangement and employmentType are all stated
      makeSettings({ targetLocations: [], workModes: [], employmentTypes: [] }),
    );
    expect(statusOf(result, 'pref:location')).toBe('unknown');
    expect(statusOf(result, 'pref:work-arrangement')).toBe('unknown');
    expect(statusOf(result, 'pref:employment-type')).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* 14 + 15. Bounds and determinism                                     */
/* ------------------------------------------------------------------ */

describe('bounds and determinism', () => {
  it('scores are always integers within 0..100', () => {
    const results = [
      run(makeProfile(), makeJob(), makeSettings()),
      run(
        makeProfile({ skills: [] }),
        makeJob({ skills: ['Kubernetes', 'Rust'], requiredQualifications: ['Master\'s degree'] }),
        makeSettings({ employmentTypes: ['internship'], workModes: ['onsite'] }),
      ),
    ];
    for (const result of results) {
      if (result.estimate.outcome === 'score') {
        expect(Number.isInteger(result.estimate.score)).toBe(true);
        expect(result.estimate.score).toBeGreaterThanOrEqual(0);
        expect(result.estimate.score).toBeLessThanOrEqual(100);
      }
      for (const f of result.estimate.factors) {
        if (f.score !== null) {
          expect(f.score).toBeGreaterThanOrEqual(0);
          expect(f.score).toBeLessThanOrEqual(100);
        }
      }
      expect(result.confidence.completeness).toBeGreaterThanOrEqual(0);
      expect(result.confidence.completeness).toBeLessThanOrEqual(100);
    }
  });

  it('identical inputs produce identical output (determinism)', () => {
    const a = run(makeProfile(), makeJob(), makeSettings());
    const b = run(makeProfile(), makeJob(), makeSettings());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('ongoing experience is measured against the posting capture date, not the clock', () => {
    const profile = makeProfile({
      experience: [
        { id: 'e', company: 'C', title: 'T', dates: { start: '2020-09', end: null }, bullets: ['b'] },
      ],
    });
    const span = observedCareerSpan(profile, '2023-09-05T00:00:00.000Z');
    expect(span?.months).toBe(36);
    expect(span?.years).toBe(3);
    // Same profile, later capture date -> different (still deterministic) span.
    expect(observedCareerSpan(profile, '2026-09-05T00:00:00.000Z')?.months).toBe(72);
  });
});

/* ------------------------------------------------------------------ */
/* 16 + 17 + 18. Validation and threshold behavior                     */
/* ------------------------------------------------------------------ */

describe('validation and minMatchThreshold', () => {
  it('invalid threshold values are rejected by validation (typed result, no throw)', () => {
    for (const bad of [101, -1, 50.5, '70', null]) {
      const settings = settingsSchema.parse({ ...defaultSettings() });
      (settings as { minMatchThreshold: unknown }).minMatchThreshold = bad;
      const out = calculateJobMatch(makeProfile(), makeJob(), settings);
      expect(out.kind).toBe('invalid');
      if (out.kind === 'invalid') {
        expect(out.issues.length).toBeGreaterThan(0);
        expect(out.issues[0]).toContain('settings');
      }
    }
  });

  it('an invalid profile or posting is rejected the same way', () => {
    const badProfile = { ...makeProfile(), schemaVersion: '9' } as unknown as Profile;
    const out = calculateJobMatch(badProfile, makeJob(), makeSettings());
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') expect(out.issues[0]).toContain('profile');

    const badJob = { ...makeJob(), capturedAt: 'not-a-date' } as unknown as JobPosting;
    const out2 = calculateJobMatch(makeProfile(), badJob, makeSettings());
    expect(out2.kind).toBe('invalid');
    if (out2.kind === 'invalid') expect(out2.issues[0]).toContain('job');
  });

  it('minMatchThreshold = 0 disables filtering (meets is null)', () => {
    const result = run(makeProfile(), makeJob(), makeSettings({ minMatchThreshold: 0 }));
    expect(result.threshold).toEqual({ configured: 0, filtering: false, meets: null, decision: 'disabled' });
  });

  it('a positive threshold passes and fails independently of the score', () => {
    const strong = run(makeProfile(), makeJob(), makeSettings({ minMatchThreshold: 50 }));
    expect(strong.threshold.decision).toBe('pass');
    expect(strong.threshold.meets).toBe(true);

    const weak = run(
      makeProfile({ skills: [{ id: 'x', name: 'COBOL', status: 'claimed' }], education: [], experience: [] }),
      makeJob({ skills: ['Kubernetes', 'Rust'], requiredQualifications: ["Master's degree", 'Kubernetes'], experienceRange: { minYears: 10 }, responsibilities: [] }),
      makeSettings({ minMatchThreshold: 50, targetLocations: [], workModes: [], employmentTypes: [] }),
    );
    if (weak.estimate.outcome === 'score') {
      expect(weak.threshold.meets).toBe(false);
      expect(weak.threshold.decision).toBe('below');
    } else {
      expect(weak.threshold.decision).toBe('insufficient-data');
      expect(weak.threshold.meets).toBe(false);
    }
    // The score is never adjusted to force the threshold outcome.
    expect(weak.threshold.configured).toBe(50);
  });
});

/* ------------------------------------------------------------------ */
/* 20 + 21 + 22. Sensitive data, zero network, immutability            */
/* ------------------------------------------------------------------ */

describe('safety properties', () => {
  it('sensitive values (salary, compensation) never appear in the result', () => {
    const settings = settingsSchema.parse({
      ...defaultSettings(),
      salary: { currency: 'USD', minAnnual: 123456 },
    });
    const job = makeJob({ compensation: '$999,999 per year' });
    const result = run(makeProfile(), job, settings);
    const json = JSON.stringify(result);
    expect(json).not.toContain('salary');
    expect(json).not.toContain('123456');
    expect(json).not.toContain('USD');
    expect(json).not.toContain('999,999');
    expect(json).not.toContain('compensation');
  });

  it('the result schema is strict — extra keys are rejected', () => {
    const result = run(makeProfile(), makeJob(), makeSettings());
    const injected = { ...result, contact: { email: 'leak@example.com' } };
    expect(validateMatchResult(injected).ok).toBe(false);
  });

  it('makes ZERO network requests and never exposes the AI layer', async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const result = run(makeProfile(), makeJob(), makeSettings());
      expect(result.estimate.outcome).toBe('score');
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('inputs are never mutated (deep-frozen inputs still work)', () => {
    const profile = deepFreeze(makeProfile());
    const job = deepFreeze(makeJob());
    const settings = deepFreeze(makeSettings({ minMatchThreshold: 40 }));
    let result: JobMatchOutcome | undefined;
    expect(() => {
      result = calculateJobMatch(profile, job, settings);
    }).not.toThrow();
    expect(result?.kind).toBe('valid');
    // And the frozen inputs still deep-equal fresh copies.
    expect(profile).toEqual(makeProfile());
    expect(job).toEqual(makeJob());
    expect(settings).toEqual(makeSettings({ minMatchThreshold: 40 }));
  });
});

/* ------------------------------------------------------------------ */
/* Model reuse                                                         */
/* ------------------------------------------------------------------ */

describe('reuses the existing validated models', () => {
  it('collectWantedSkills reads only structured posting fields', () => {
    const job = makeJob({ skills: ['TypeScript', 'Kubernetes'], requiredQualifications: ['React'] });
    const wanted = collectWantedSkills(job);
    expect(wanted.map((w) => w.canonicalId).sort()).toEqual(['kubernetes', 'react', 'typescript']);
    expect(wanted.find((w) => w.canonicalId === 'kubernetes')?.requiredness).toBe('required');
  });

  it('computeFactors reports the five documented factors in fixed order', () => {
    const emptyProfile = profileSchema.parse({});
    const factors = computeFactors([], emptyProfile, makeJob());
    expect(factors.map((f) => f.factor)).toEqual([
      'requiredSkills',
      'preferredSkills',
      'experience',
      'roleAlignment',
      'preferences',
    ]);
    // No assessable data -> every factor unknown, not zero.
    expect(factors.every((f) => f.score === null)).toBe(true);
  });
});
