/**
 * Tests for the match summary presenter (src/lib/matching/presenter.ts) —
 * Prompt 10: the view model must surface estimate + confidence + assessable
 * weight, group all four statuses with unknown clearly distinct from
 * missing, handle invalid/insufficient/missing-input states without a
 * misleading score, and never carry sensitive values.
 *
 * The presenter is pure; React rendering is covered in
 * match-summary-ui.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMatchSummaryView,
  CATEGORY_LABELS,
  missingJobView,
  missingProfileView,
  matchSummaryFromResult,
  SEVERITY_LABELS,
  settingsUnavailableView,
  STATUS_LABELS,
} from './presenter';
import { calculateJobMatch } from './estimate';
import { profileSchema, type Profile } from '../profile';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { defaultSettings, settingsSchema, type Settings } from '../settings';

const AS_OF = '2026-09-01T00:00:00.000Z';

function makeProfile(patch: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    headline: 'Backend Engineer',
    skills: [
      { id: 'sk-react', name: 'React', status: 'verified', evidenceRef: { kind: 'experience', id: 'exp-1' } },
      { id: 'sk-ts', name: 'TypeScript', status: 'claimed' },
      { id: 'sk-node', name: 'Node.js', status: 'claimed' },
    ],
    experience: [
      { id: 'exp-1', company: 'Fake Co', title: 'Software Engineer', dates: { start: '2018-03', end: null }, bullets: ['Built fake things.'] },
    ],
    education: [
      { id: 'edu-1', institution: 'Fake University', credential: 'B.Sc. Fake Studies', inProgress: false, dates: { start: '2014-09', end: '2018-05' } },
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
    rawDescription: 'Fake raw description.',
    responsibilities: ['Build services with Node.js'],
    requiredQualifications: ['Experience with React', "Master's degree required"],
    preferredQualifications: ['Kubernetes knowledge'],
    skills: ['TypeScript', 'React Native'],
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

const readyView = () => buildMatchSummaryView(calculateJobMatch(makeProfile(), makeJob(), makeSettings()));

describe('ready view surfaces estimate, confidence and assessable weight separately', () => {
  it('exposes score, confidence, completeness, weight and threshold as distinct fields', () => {
    const view = readyView();
    expect(view.status).toBe('ready');
    expect(view.score).toBe(94); // pinned: catches accidental formula drift (formula not changed in Prompt 10)
    expect(view.scoreLabel).toBe('94 / 100');
    expect(view.confidenceLabel).toMatch(/confidence$/);
    expect(view.completenessLabel).toMatch(/% completeness \(\d+ of \d+ items decidable\)/);
    expect(view.availableWeightLabel).toMatch(/^\d+ of 100 points assessable \(a score needs at least 40\)$/);
    expect(view.thresholdLabel).toBe('Threshold: off (your minimum is 0)');
    expect(view.estimateCaption).toContain('not an employer ATS score');
    expect(view.summary.length).toBeGreaterThan(0);
  });

  it('confidence and completeness are never merged into the score label', () => {
    const view = readyView();
    expect(view.scoreLabel).toBe('94 / 100');
    expect(view.scoreLabel).not.toContain('confidence');
    expect(view.confidenceLabel).not.toContain('94');
  });

  it('threshold pass / below / disabled labels are distinct', () => {
    const pass = buildMatchSummaryView(
      calculateJobMatch(makeProfile(), makeJob(), makeSettings({ minMatchThreshold: 10 })),
    );
    expect(pass.thresholdLabel).toBe('Threshold: meets your minimum of 10');
    const below = buildMatchSummaryView(
      calculateJobMatch(makeProfile(), makeJob(), makeSettings({ minMatchThreshold: 95 })),
    );
    expect(below.thresholdLabel).toBe('Threshold: below your minimum of 95');
    expect(below.score).toBe(94); // threshold never changes the score
  });
});

describe('requirement groups keep the result contract terminology', () => {
  it('renders all four groups in order with counts and descriptions', () => {
    const view = readyView();
    expect(view.groups.map((g) => g.status)).toEqual(['matched', 'partial', 'missing', 'unknown']);
    for (const group of view.groups) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.description.length).toBeGreaterThan(0);
    }
    // Fixture guarantees every group is populated.
    for (const group of view.groups) expect(group.items.length).toBeGreaterThan(0);
  });

  it('unknown is visibly distinct: its own label, never "Missing"', () => {
    const view = readyView();
    const unknown = view.groups.find((g) => g.status === 'unknown');
    const missing = view.groups.find((g) => g.status === 'missing');
    expect(unknown?.label).toBe('Unknown (not verified)');
    expect(unknown?.description).toContain('NOT a confirmed gap');
    expect(missing?.label).toBe('Missing (confirmed)');
    expect(missing?.description).toContain('Confirmed gaps');

    const kubernetes = unknown?.items.find((i) => i.id === 'skill:kubernetes');
    expect(kubernetes).toBeDefined();
    expect(kubernetes?.statusLabel).toBe('Unknown (not verified)');
    expect(kubernetes?.statusLabel).not.toContain('Missing');
    expect(STATUS_LABELS.unknown).not.toBe(STATUS_LABELS.missing);
    // Missing items are only ever in the missing group.
    expect(missing?.items.every((i) => i.status === 'missing')).toBe(true);
    expect(unknown?.items.every((i) => i.status === 'unknown')).toBe(true);
  });

  it('items carry explanation and labels from the result contract (no invention)', () => {
    const view = readyView();
    const result = calculateJobMatch(makeProfile(), makeJob(), makeSettings());
    if (result.kind !== 'valid') throw new Error('fixture invalid');
    const contractById = new Map(result.result.requirements.map((r) => [r.id, r]));
    for (const group of view.groups) {
      for (const item of group.items) {
        const source = contractById.get(item.id);
        expect(source).toBeDefined();
        expect(item.explanation).toBe(source?.explanation);
        expect(item.label).toBe(source?.label);
        expect(item.categoryLabel).toBe(CATEGORY_LABELS[source?.category ?? 'skill']);
      }
    }
  });

  it('hard issues carry severity labels from the contract', () => {
    const view = buildMatchSummaryView(
      calculateJobMatch(makeProfile(), makeJob({ location: 'Tokyo, JP', workArrangement: 'onsite' }), makeSettings()),
    );
    expect(view.hardIssues.length).toBeGreaterThan(0);
    for (const issue of view.hardIssues) {
      expect(issue.severityLabel).toBe(SEVERITY_LABELS[issue.severity]);
      expect(issue.explanation.length).toBeGreaterThan(0);
    }
    expect(view.hardIssues.some((i) => i.severityLabel === 'Confirmed mismatch')).toBe(true);
  });
});

describe('insufficient data and invalid inputs never show a misleading score', () => {
  it('insufficient-data: score is null, messages explain why, badges still shown', () => {
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
    const settings = makeSettings({ targetLocations: [], workModes: [], employmentTypes: [] });
    const view = buildMatchSummaryView(calculateJobMatch(makeProfile(), job, settings));
    expect(view.status).toBe('insufficient-data');
    expect(view.score).toBeNull();
    expect(view.scoreLabel).toBe('');
    expect(view.messages.join(' ')).toContain('No numeric score is shown');
    expect(view.messages.join(' ')).toContain('would be misleading');
    // Context (confidence/completeness/weight) is still available for an honest read.
    expect(view.completenessLabel).not.toBeNull();
    expect(view.availableWeightLabel).not.toBeNull();
  });

  it('invalid input: typed issues are surfaced, no score, no groups', () => {
    const badJob = { ...makeJob(), capturedAt: 'nope' } as unknown as JobPosting;
    const view = buildMatchSummaryView(calculateJobMatch(makeProfile(), badJob, makeSettings()));
    expect(view.status).toBe('invalid');
    expect(view.score).toBeNull();
    expect(view.groups).toEqual([]);
    expect(view.factors).toEqual([]);
    expect(view.messages[0]).toContain('failed validation');
    expect(view.messages[0]).toContain('job.');
  });

  it('missing inputs each get their own state and a non-misleading message', () => {
    const profile = missingProfileView();
    expect(profile.status).toBe('missing-profile');
    expect(profile.score).toBeNull();
    expect(profile.messages[0]).toContain('Profile');

    const job = missingJobView();
    expect(job.status).toBe('missing-job');
    expect(job.messages[0]).toContain('Select a saved job');

    const settings = settingsUnavailableView();
    expect(settings.status).toBe('settings-unavailable');
    expect(settings.score).toBeNull();
    expect(settings.messages[0]).toContain('Settings could not be loaded');
  });
});

describe('factors and privacy', () => {
  it('factor rows show weight and score labels, "Not assessable" for unknown factors', () => {
    const view = readyView();
    expect(view.factors.map((f) => f.factor)).toEqual([
      'requiredSkills',
      'preferredSkills',
      'experience',
      'roleAlignment',
      'preferences',
    ]);
    const preferred = view.factors.find((f) => f.factor === 'preferredSkills');
    expect(preferred?.weightLabel).toBe('10');
    expect(preferred?.scoreLabel).toBe('Not assessable');
    expect(preferred?.score).toBeNull();
    const required = view.factors.find((f) => f.factor === 'requiredSkills');
    expect(required?.weightLabel).toBe('35');
    expect(required?.scoreLabel).not.toBe('Not assessable');
  });

  it('the view never contains salary or compensation values from inputs', () => {
    const settings = settingsSchema.parse({
      ...makeSettings(),
      salary: { currency: 'USD', minAnnual: 123456 },
    });
    const job = makeJob({ compensation: '$999,999 per year' });
    const view = buildMatchSummaryView(calculateJobMatch(makeProfile(), job, settings));
    const json = JSON.stringify(view);
    expect(json).not.toContain('salary');
    expect(json).not.toContain('123456');
    expect(json).not.toContain('USD');
    expect(json).not.toContain('999,999');
    expect(json).not.toContain('compensation');
  });
});
