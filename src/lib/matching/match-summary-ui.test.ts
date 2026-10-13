/**
 * UI/integration tests for the Match Summary component
 * (entrypoints/options/MatchSummary.tsx) — Prompt 10.
 *
 * Rendered with `react-dom/server` (no new test dependency, no incidental
 * markup assertions — tests target labels, data-status/data-field semantics
 * and visible text). Covers: valid display of estimate + confidence +
 * assessable weight, the four status groups with unknown never labelled
 * missing, insufficient-data / invalid / missing inputs without a
 * misleading score, re-render on input change, and zero network calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MatchSummary, { resolveMatchView } from '../../../entrypoints/options/MatchSummary';
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

const render = (props: {
  profile: Profile | null;
  job: JobPosting | null;
  settings: Settings | null;
}): string => renderToStaticMarkup(createElement(MatchSummary, props));

/** Decode the entity escaping react-dom/server applies to visible text. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/g, '&');
}

/**
 * The requirement `<li>` whose visible content mentions `label` (null when
 * absent). Only requirement items carry `data-status`; hard-issue items
 * (`data-severity`) are excluded so labels present in both never confuse.
 */
function findItem(html: string, label: string): string | null {
  const items = html
    .split('<li ')
    .slice(1)
    .filter((chunk) => chunk.startsWith('data-status='))
    .map((chunk) => chunk.split('</li>')[0] ?? '');
  return items.find((item) => unescapeHtml(item).includes(label)) ?? null;
}

describe('valid result renders estimate, confidence and assessable weight', () => {
  it('shows the score labelled as an estimate plus separate badges', () => {
    const html = render({ profile: makeProfile(), job: makeJob(), settings: makeSettings() });
    const view = resolveMatchView(makeProfile(), makeJob(), makeSettings());
    expect(html).toContain('data-status="ready"');
    expect(html).toContain(`${view.score} / 100`);
    expect(html).toContain('aria-label="Estimate 94 out of 100"');
    expect(html).toContain('>estimate<');
    expect(html).toContain('not an employer ATS score');
    expect(html).toContain('data-field="confidence"');
    expect(html).toContain('data-field="completeness"');
    expect(html).toContain('% completeness');
    expect(html).toContain('data-field="available-weight"');
    expect(html).toContain('of 100 points assessable');
    expect(html).toContain('data-field="threshold"');
  });

  it('renders the scoring-factor table with weights', () => {
    const html = render({ profile: makeProfile(), job: makeJob(), settings: makeSettings() });
    expect(html).toContain('data-field="factors"');
    expect(html).toContain('data-factor="requiredSkills"');
    expect(html).toContain('data-field="weight"');
    expect(html).toContain('do not reflect any employer');
  });
});

describe('the four statuses render distinctly; unknown is never "missing"', () => {
  const html = render({ profile: makeProfile(), job: makeJob(), settings: makeSettings() });

  it('all four status groups are present with counts', () => {
    expect(html).toContain('data-status="matched"');
    expect(html).toContain('data-status="partial"');
    expect(html).toContain('data-status="missing"');
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('Matched (');
    expect(html).toContain('Unknown (not verified) (');
    expect(html).toContain('Missing (confirmed) (');
  });

  it('the unknown requirement (Kubernetes) is labeled unknown, not missing', () => {
    const item = findItem(html, 'Kubernetes');
    expect(item).not.toBeNull();
    expect(item ?? '').toContain('data-status="unknown"');
    expect(item ?? '').toContain('Unknown (not verified)');
    expect(item ?? '').not.toContain('Missing (confirmed gap)');
    expect(item ?? '').toContain('not proof you lack it');
  });

  it('a confirmed gap is labeled missing and lives in the missing group', () => {
    const item = findItem(html, "Master's degree");
    expect(item).not.toBeNull();
    expect(item ?? '').toContain('data-status="missing"');
    expect(item ?? '').toContain('Missing (confirmed gap)');
  });

  it('a matched requirement shows its status and category', () => {
    const item = findItem(html, 'React Native');
    expect(item).not.toBeNull();
    expect(item ?? '').toContain('data-status="partial"');
    const react = findItem(html, 'React');
    expect(react ?? '').toContain('Matched');
    expect(react ?? '').toContain('Required by posting');
  });

  it('hard-requirement issues render with severity labels', () => {
    const rendered = render({
      profile: makeProfile(),
      job: makeJob({ location: 'Tokyo, JP', workArrangement: 'onsite' }),
      settings: makeSettings(),
    });
    expect(rendered).toContain('data-field="hard-issues"');
    expect(rendered).toContain('Confirmed mismatch');
    expect(rendered).toContain('data-severity="confirmed"');
  });
});

describe('non-misleading states', () => {
  it('insufficient data renders NO numeric score but keeps the context badges', () => {
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
    const html = render({ profile: makeProfile(), job, settings });
    expect(html).toContain('data-status="insufficient-data"');
    expect(html).not.toContain('class="match-score"');
    expect(html).not.toContain(' / 100');
    expect(html).toContain('No numeric score is shown');
    expect(html).toContain('data-field="completeness"');
    expect(html).toContain('data-field="available-weight"');
  });

  it('invalid inputs render the typed validation state, not a score', () => {
    const badJob = { ...makeJob(), capturedAt: 'nope' } as unknown as JobPosting;
    const html = render({ profile: makeProfile(), job: badJob, settings: makeSettings() });
    expect(html).toContain('data-status="invalid"');
    expect(html).not.toContain('class="match-score"');
    expect(html).toContain('failed validation');
  });

  it('missing profile shows a helpful state and no score', () => {
    const html = render({ profile: null, job: makeJob(), settings: makeSettings() });
    expect(html).toContain('data-status="missing-profile"');
    expect(html).not.toContain('class="match-score"');
    expect(html).toContain('No usable master profile yet');
  });

  it('no selected job shows a helpful state and no score', () => {
    const html = render({ profile: makeProfile(), job: null, settings: makeSettings() });
    expect(html).toContain('data-status="missing-job"');
    expect(html).not.toContain('class="match-score"');
    expect(html).toContain('Select a saved job');
  });

  it('unavailable settings shows a helpful state and no score', () => {
    const html = render({ profile: makeProfile(), job: makeJob(), settings: null });
    expect(html).toContain('data-status="settings-unavailable"');
    expect(html).not.toContain('class="match-score"');
    expect(html).toContain('Settings could not be loaded');
  });
});

describe('recalculation and safety', () => {
  it('changing the profile changes the displayed result', () => {
    const job = makeJob();
    const strong = render({ profile: makeProfile(), job, settings: makeSettings() });
    const empty = render({ profile: profileSchema.parse({}), job, settings: makeSettings() });
    expect(strong).toContain('class="match-score"');
    expect(strong).not.toBe(empty);
    // Sparse profile becomes an honest insufficient-data view, not a low score.
    expect(empty).toContain('data-status="insufficient-data"');
    expect(empty).not.toContain('class="match-score"');
  });

  it('changing the selected job changes the displayed result', () => {
    const profile = makeProfile();
    const settings = makeSettings();
    const a = render({ profile, job: makeJob(), settings });
    const b = render({ profile, job: makeJob({ id: 'job-2', title: 'Unrelated Role', skills: [], requiredQualifications: [], preferredQualifications: [], responsibilities: [] }), settings });
    expect(a).not.toBe(b);
    expect(a).toContain('data-status="ready"');
  });

  it('makes zero network calls while rendering (offline matcher)', () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const html = render({ profile: makeProfile(), job: makeJob(), settings: makeSettings() });
      expect(html.length).toBeGreaterThan(0);
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders no sensitive values from settings or the posting', () => {
    const settings = settingsSchema.parse({
      ...makeSettings(),
      salary: { currency: 'USD', minAnnual: 123456 },
    });
    const job = makeJob({ compensation: '$999,999 per year' });
    const html = render({ profile: makeProfile(), job, settings });
    expect(html).not.toContain('123456');
    expect(html).not.toContain('999,999');
    expect(html).not.toContain('salary');
    expect(html).not.toContain('compensation');
  });
});
