/**
 * Prioritization behavior required by Prompt 30.
 *
 * These tests pin the parts the dashboard depends on: relevance/freshness
 * separation, posting date vs import date, conservative handling of missing,
 * future and invalid dates, application-status semantics (`planned` is NOT a
 * submission), duplicate indications, and deterministic ordering. All fixtures
 * are synthetic — no personal data, no real postings.
 */
import { describe, expect, it, vi } from 'vitest';
import { applicationSchema, type Application } from '../applications/schemas';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { matchResultSchema, type JobMatchResult } from '../matching/schemas';
import { prioritizeJobs, type PrioritizationResult } from '.';

const TODAY = '2026-10-15';
const THRESHOLD = 60;

function job(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-a',
    title: 'Backend Engineer',
    company: 'Fake Co',
    rawDescription: 'Synthetic description text.',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  });
}

/** A valid already-computed match result (never re-scored here). */
function match(score = 82, configured = THRESHOLD): JobMatchResult {
  const meets = score >= configured;
  return matchResultSchema.parse({
    schemaVersion: '1',
    estimate: {
      outcome: 'score',
      score,
      factors: [],
      availableWeight: 100,
      explanation: 'Synthetic explanation.',
    },
    requirements: [],
    hardIssues: [],
    confidence: {
      level: 'high',
      completeness: 100,
      counts: { total: 0, assessed: 0, matched: 0, partial: 0, missing: 0, unknown: 0 },
      explanation: 'Synthetic confidence.',
    },
    threshold: { configured, filtering: configured > 0, meets, decision: meets ? 'pass' : 'below' },
    summary: 'Synthetic summary.',
  });
}

const INSUFFICIENT = matchResultSchema.parse({
  schemaVersion: '1',
  estimate: {
    outcome: 'insufficient-data',
    reason: 'Not enough comparable data.',
    factors: [],
    availableWeight: 20,
    explanation: 'Synthetic explanation.',
  },
  requirements: [],
  hardIssues: [],
  confidence: {
    level: 'low',
    completeness: 20,
    counts: { total: 5, assessed: 1, matched: 1, partial: 0, missing: 0, unknown: 4 },
    explanation: 'Synthetic confidence.',
  },
  threshold: { configured: THRESHOLD, filtering: true, meets: false, decision: 'insufficient-data' },
  summary: 'Synthetic summary.',
});

function application(patch: Record<string, unknown> = {}): Application {
  return applicationSchema.parse({
    id: 'app-1',
    jobId: 'job-a',
    status: 'applied',
    applicationDate: '2026-10-10',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...patch,
  });
}

function run(overrides: Partial<Parameters<typeof prioritizeJobs>[0]> = {}): PrioritizationResult {
  const outcome = prioritizeJobs({
    today: TODAY,
    minMatchThreshold: THRESHOLD,
    jobs: [job()],
    matches: [{ jobId: 'job-a', result: match() }],
    applications: [],
    ...overrides,
  });
  if (outcome.kind !== 'valid') throw new Error(outcome.issues.join('; '));
  return outcome.result;
}

function entryFor(result: PrioritizationResult, jobId: string) {
  for (const group of result.groups) {
    const found = group.jobs.find((entry) => entry.jobId === jobId);
    if (found !== undefined) return found;
  }
  throw new Error(`no entry for ${jobId}`);
}

describe('relevance and freshness (Prompt 30 §3 A/B, §8.1–8.5)', () => {
  it('classifies a strong match with a known recent posting date as apply first', () => {
    const result = run({ jobs: [job({ postedDate: TODAY })] });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('apply-first');
    expect(entry.freshness).toMatchObject({ postedDate: TODAY, ageDays: 0, withinWindow: true });
    expect(entry.match).toMatchObject({ state: 'score', score: 82, meetsThreshold: true });
    expect(entry.reasons.some((r) => r.includes('meets your minimum of 60'))).toBe(true);
  });

  it('never promotes an unknown posting date to apply first', () => {
    const result = run({ jobs: [job()] });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('good-match');
    expect(entry.freshness).toMatchObject({ postedDate: null, ageDays: null, withinWindow: false });
    expect(entry.freshness.label).toBe('Posting date unknown');
  });

  it('uses the POSTING date, never the local capture date', () => {
    const result = run({
      jobs: [
        job({
          // Captured today, but the posting itself is old: freshness follows the
          // posting date only, and the fresh capture time is never used.
          capturedAt: '2026-10-15T09:00:00.000Z',
          postedDate: '2026-08-01',
        }),
      ],
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('good-match');
    expect(entry.freshness.postedDate).toBe('2026-08-01');
    expect(entry.freshness.ageDays).toBe(75);
    expect(entry.reasons.some((r) => r.includes('outside the 7-day freshness window'))).toBe(true);
  });

  it('treats insufficient data as needs review without inventing a score', () => {
    const result = run({ matches: [{ jobId: 'job-a', result: INSUFFICIENT }] });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('needs-review');
    expect(entry.match).toMatchObject({ state: 'insufficient-data', score: null, meetsThreshold: false });
    expect(entry.match.confidenceLevel).toBe('low');
  });

  it('keeps a below-minimum match in needs review even when the posting is new', () => {
    const result = run({
      jobs: [job({ postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: match(40) }],
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('needs-review');
    expect(entry.match.meetsThreshold).toBe(false);
  });

  it('flags a future posting date for verification and never calls it fresh', () => {
    const future = run({ jobs: [job({ postedDate: '2026-11-01' })] });
    const entry = entryFor(future, 'job-a');
    expect(entry.category).toBe('needs-review');
    expect(entry.freshness).toMatchObject({ postedDate: '2026-11-01', future: true, ageDays: null });
    expect(entry.freshness.label).toContain('Future posting date');

    const tomorrow = run({ jobs: [job({ postedDate: '2026-10-16' })] });
    expect(entryFor(tomorrow, 'job-a').category).toBe('needs-review');
  });

  it('skips an impossible posting date instead of guessing one', () => {
    const result = run({
      jobs: [
        job({ id: 'job-a' }),
        // Raw (unvalidated) record: an impossible calendar date must be skipped,
        // never coerced to a neighbouring day or to the capture time.
        {
          id: 'job-bad',
          title: 'Bad date role',
          rawDescription: 'Synthetic description text.',
          capturedAt: '2026-10-01T00:00:00.000Z',
          postedDate: '2026-02-31',
        },
      ],
    });
    expect(result.skippedJobs).toBe(1);
    expect(result.totalJobs).toBe(1);
    expect(result.notes.some((n) => n.includes('failed validation'))).toBe(true);
  });

  it('handles missing optional job fields without inventing them', () => {
    const bare = run({
      jobs: [
        job({
          company: undefined,
          location: undefined,
          originalUrl: undefined,
          postedDate: undefined,
        }),
      ],
      matches: [],
    });
    const entry = entryFor(bare, 'job-a');
    expect(entry.company).toBeNull();
    expect(entry.originalUrl).toBeNull();
    expect(entry.freshness.postedDate).toBeNull();
    expect(entry.category).toBe('needs-review');
  });
});

describe('application status semantics (§3 C, §8.6–8.7)', () => {
  it('classifies a job with a submitted application as already applied', () => {
    const result = run({ applications: [application({ status: 'interview' })] });
    expect(entryFor(result, 'job-a').category).toBe('already-applied');
    expect(entryFor(result, 'job-a').application).toMatchObject({
      state: 'in-progress',
      status: 'interview',
      linkedCount: 1,
    });
  });

  it('does NOT classify a merely planned application as submitted', () => {
    const result = run({
      jobs: [job({ postedDate: TODAY })],
      applications: [application({ status: 'planned' })],
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('apply-first');
    expect(entry.application.state).toBe('planned');
    expect(entry.application.label).toContain('not submitted');
  });

  it('never links an application by company or title (only by jobId)', () => {
    const result = run({
      jobs: [job({ postedDate: TODAY })],
      applications: [application({ jobId: 'job-somewhere-else', status: 'offer' })],
    });
    expect(entryFor(result, 'job-a').category).toBe('apply-first');
  });

  it('fails closed when the application log is unreadable', () => {
    const result = run({ applications: null });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('needs-review');
    expect(entry.application.state).toBe('unavailable');
  });
});

describe('duplicate indication (§3 D, §8.8)', () => {
  const twoSameUrls = [
    job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1', postedDate: TODAY }),
    job({ id: 'job-b', originalUrl: 'https://example.com/jobs/1', postedDate: TODAY }),
  ];

  it('indicates an equivalent saved posting without merging, hiding or re-classifying it', () => {
    const result = run({
      jobs: twoSameUrls,
      matches: [
        { jobId: 'job-a', result: match() },
        { jobId: 'job-b', result: match() },
      ],
    });
    expect(result.totalJobs).toBe(2); // nothing merged or dropped
    expect(entryFor(result, 'job-a').category).toBe('apply-first');
    expect(entryFor(result, 'job-b').category).toBe('apply-first');
    expect(entryFor(result, 'job-a').duplicate).toEqual({
      status: 'confirmed',
      method: 'canonical-url',
      equivalentJobIds: ['job-b'],
      label: 'Same posting as 1 other saved job',
    });
    expect(entryFor(result, 'job-a').reasons.some((r) => r.includes('Another saved job is the same posting'))).toBe(true);
    expect(result.notes.some((n) => n.includes('nothing was merged'))).toBe(true);
  });

  it('marks a company+title-only similarity as possible, not confirmed', () => {
    const result = run({
      jobs: [job({ id: 'job-a', postedDate: TODAY }), job({ id: 'job-b', postedDate: TODAY })],
      matches: [
        { jobId: 'job-a', result: match() },
        { jobId: 'job-b', result: match() },
      ],
    });
    const duplicate = entryFor(result, 'job-a').duplicate;
    expect(duplicate.status).toBe('possible');
    expect(duplicate.method).toBe('company-title');
    expect(duplicate.label).toContain('verify');
  });

  it('reports ambiguous when several saved jobs share one URL', () => {
    const url = 'https://example.com/jobs/7';
    const result = run({
      jobs: [job({ id: 'job-a', originalUrl: url }), job({ id: 'job-b', originalUrl: url }), job({ id: 'job-c', originalUrl: url })],
    });
    for (const id of ['job-a', 'job-b', 'job-c']) {
      const duplicate = entryFor(result, id).duplicate;
      expect(duplicate.status).toBe('ambiguous');
      expect(duplicate.equivalentJobIds).toHaveLength(2);
      expect(duplicate.equivalentJobIds).not.toContain(id);
    }
  });

  it('reports no duplicate when the identities differ', () => {
    const result = run({
      jobs: [
        job({ id: 'job-a', company: 'One Co', originalUrl: 'https://example.com/jobs/1' }),
        job({ id: 'job-b', company: 'Two Co', originalUrl: 'https://example.com/jobs/2' }),
      ],
    });
    expect(entryFor(result, 'job-a').duplicate).toEqual({
      status: 'none',
      method: null,
      equivalentJobIds: [],
      label: 'No duplicate saved posting detected',
    });
  });
});

describe('stable ordering and determinism (§4, §8.9/8.11)', () => {
  it('orders within a category by known date (newest first), then score, then job id', () => {
    const result = run({
      today: TODAY,
      jobs: [
        job({ id: 'job-d', postedDate: '2026-10-14' }),
        job({ id: 'job-a', postedDate: TODAY }),
        job({ id: 'job-c', postedDate: TODAY }),
        job({ id: 'job-b', postedDate: TODAY }),
      ],
      matches: [
        { jobId: 'job-a', result: match(70) },
        { jobId: 'job-b', result: match(90) },
        { jobId: 'job-c', result: match(90) },
        { jobId: 'job-d', result: match(95) },
      ],
    });
    const ids = result.groups.find((g) => g.category === 'apply-first')?.jobs.map((e) => e.jobId);
    expect(ids).toEqual(['job-b', 'job-c', 'job-a', 'job-d']);
  });

  it('is independent of input order, including with duplicates', () => {
    const jobs = [
      job({ id: 'job-b', originalUrl: 'https://example.com/jobs/1', postedDate: TODAY }),
      job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1', postedDate: TODAY }),
      job({ id: 'job-c' }),
    ];
    const matches = jobs.map((j) => ({ jobId: j.id, result: match(80) }));
    const forward = run({ jobs, matches, applications: [application({ jobId: 'job-b' })] });
    const backward = run({
      jobs: [...jobs].reverse(),
      matches: [...matches].reverse(),
      applications: [application({ jobId: 'job-b' })],
    });
    expect(backward).toEqual(forward);
  });

  it('produces identical output for identical input', () => {
    const input = {
      today: TODAY,
      minMatchThreshold: THRESHOLD,
      jobs: [job({ postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: match() }],
      applications: [],
    };
    expect(prioritizeJobs(input)).toEqual(prioritizeJobs(input));
  });

  it('makes no network call from the priority path', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
