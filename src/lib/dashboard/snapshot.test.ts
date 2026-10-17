/**
 * Dashboard snapshot tests (Prompt 30 §5, §8.12–8.15).
 *
 * The snapshot is a pure projection of storage records the caller already read:
 * saved postings, the application log, and already-computed match estimates.
 * These tests pin the metric definitions, the shortlist contents, and — most
 * importantly — that missing/unreadable data is NEVER rendered as a believable
 * zero. All fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applicationSchema, type Application } from '../applications/schemas';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { matchResultSchema, type JobMatchResult } from '../matching/schemas';
import {
  buildDashboardSnapshot,
  DASHBOARD_METRIC_KEYS,
  DASHBOARD_SHORTLIST_LIMIT,
  type DashboardSnapshot,
} from '.';

const TODAY = '2026-10-15';
const THRESHOLD = 60;

function job(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-a',
    title: 'Backend Engineer',
    company: 'Fake Co',
    location: 'Remote',
    rawDescription: 'Synthetic description text.',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  });
}

function match(score = 82): JobMatchResult {
  const meets = score >= THRESHOLD;
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
    threshold: { configured: THRESHOLD, filtering: true, meets, decision: meets ? 'pass' : 'below' },
    summary: 'Synthetic summary.',
  });
}

function application(patch: Record<string, unknown>): Application {
  return applicationSchema.parse({
    id: 'app-1',
    jobId: 'job-a',
    status: 'applied',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...patch,
  });
}

// Deliberately distinct companies/titles/URLs: this fixture is about counts, so
// the weak company+title duplicate rule must stay quiet here.
const JOBS = [
  job({ id: 'job-a', title: 'Backend Engineer', company: 'Fake Co', postedDate: TODAY }),
  job({ id: 'job-b', title: 'Data Engineer', company: 'Data Co', postedDate: '2026-08-01' }),
  job({ id: 'job-c', title: 'Platform Engineer', company: 'Platform Co', location: undefined }),
  job({ id: 'job-d', title: 'Frontend Engineer', company: 'Web Co', postedDate: TODAY }),
];

const MATCHES = [
  { jobId: 'job-a', result: match(82) },
  { jobId: 'job-b', result: match(75) },
  { jobId: 'job-d', result: match(82) },
];

const APPLICATIONS = [
  application({ id: 'app-1', jobId: 'job-d', status: 'interview', followUpDate: '2026-10-20' }),
  application({ id: 'app-2', jobId: 'job-a', status: 'planned' }),
  application({ id: 'app-3', jobId: 'job-orphan', status: 'offer', followUpDate: '2026-10-01' }),
  application({ id: 'app-4', jobId: 'job-gone', status: 'rejected', followUpDate: '2026-12-01' }),
];

function run(overrides: Partial<Parameters<typeof buildDashboardSnapshot>[0]> = {}): DashboardSnapshot {
  const outcome = buildDashboardSnapshot({
    jobs: JOBS,
    applications: APPLICATIONS,
    matches: MATCHES,
    minMatchThreshold: THRESHOLD,
    profileAvailable: true,
    today: TODAY,
    ...overrides,
  });
  if (outcome.kind !== 'valid') throw new Error(outcome.issues.join('; '));
  return outcome.snapshot;
}

function metricValue(snapshot: DashboardSnapshot, key: (typeof DASHBOARD_METRIC_KEYS)[number]) {
  return snapshot.metrics[key];
}

describe('counts derived from actual records (§8.12)', () => {
  it('counts saved jobs and the three actionable categories', () => {
    const snapshot = run();
    expect(snapshot.metrics.savedJobs).toEqual({ kind: 'value', value: 4 });
    expect(snapshot.metrics.applyFirst).toEqual({ kind: 'value', value: 1 });
    expect(snapshot.metrics.goodMatch).toEqual({ kind: 'value', value: 1 });
    expect(snapshot.metrics.reviewJobs).toEqual({ kind: 'value', value: 1 });
    expect(snapshot.shortlist.alreadyAppliedCount).toBe(1);
    expect(snapshot.shortlist.actionableCount).toBe(3);
  });

  it('counts submissions, interviews, offers and upcoming follow-ups with documented semantics', () => {
    const snapshot = run();
    // `planned` is not a submission; rejected/withdrawn records still are.
    expect(metricValue(snapshot, 'submitted')).toEqual({ kind: 'value', value: 3 });
    expect(metricValue(snapshot, 'interviews')).toEqual({ kind: 'value', value: 1 });
    expect(metricValue(snapshot, 'offers')).toEqual({ kind: 'value', value: 1 });
    // Only the follow-up on/after today whose status is not rejected/withdrawn.
    expect(metricValue(snapshot, 'upcomingFollowUps')).toEqual({ kind: 'value', value: 1 });
  });

  it('projects the actionable shortlist in the deterministic priority order', () => {
    const snapshot = run();
    expect(snapshot.shortlist.rows.map((row) => [row.jobId, row.category])).toEqual([
      ['job-a', 'apply-first'],
      ['job-b', 'good-match'],
      ['job-c', 'needs-review'],
    ]);
    const first = snapshot.shortlist.rows[0]!;
    expect(first).toMatchObject({
      title: 'Backend Engineer',
      company: 'Fake Co',
      location: 'Remote',
      categoryLabel: 'Apply first',
      postedDate: TODAY,
      matchLabel: '82 / 100 estimate',
      matchState: 'score',
      confidenceLabel: 'High',
      applicationLabel: 'Planned (not submitted)',
      duplicateStatus: 'none',
      duplicateLabel: null,
    });
    // A job without a location keeps it absent (never invented).
    expect(snapshot.shortlist.rows[2]!.location).toBeNull();
    // The applied job is counted but kept OUT of the actionable shortlist.
    expect(snapshot.shortlist.rows.some((row) => row.jobId === 'job-d')).toBe(false);
  });

  it('carries the duplicate indication into the row', () => {
    const url = 'https://example.com/jobs/1';
    const snapshot = run({
      jobs: [
        job({ id: 'job-a', originalUrl: url, postedDate: TODAY }),
        job({ id: 'job-b', originalUrl: url, postedDate: TODAY }),
      ],
      matches: MATCHES,
      applications: [],
    });
    for (const row of snapshot.shortlist.rows) {
      expect(row.duplicateStatus).toBe('confirmed');
      expect(row.duplicateLabel).toBe('Same posting as 1 other saved job');
      expect(row.reasons.some((r) => r.includes('same posting'))).toBe(true);
    }
  });

  it('caps the shortlist and says how many jobs continue beyond it', () => {
    const many = Array.from({ length: DASHBOARD_SHORTLIST_LIMIT + 3 }, (_, i) =>
      job({ id: `job-${String(i).padStart(2, '0')}`, company: `Co ${i}` }),
    );
    const snapshot = run({ jobs: many, matches: [], applications: [] });
    expect(snapshot.shortlist.rows).toHaveLength(DASHBOARD_SHORTLIST_LIMIT);
    expect(snapshot.shortlist.actionableCount).toBe(DASHBOARD_SHORTLIST_LIMIT + 3);
    expect(snapshot.shortlist.truncated).toBe(true);
  });
});

describe('empty states (§8.13)', () => {
  it('reports real zeros for an empty (but readable) store', () => {
    const snapshot = run({ jobs: [], applications: [], matches: [] });
    for (const key of DASHBOARD_METRIC_KEYS) {
      expect(snapshot.metrics[key]).toEqual({ kind: 'value', value: 0 });
    }
    expect(snapshot.shortlist).toEqual({
      available: true,
      reason: null,
      rows: [],
      actionableCount: 0,
      alreadyAppliedCount: 0,
      truncated: false,
    });
  });

  it('reports saved jobs with no matching information as needing review', () => {
    const snapshot = run({ matches: [], profileAvailable: false });
    expect(snapshot.metrics.applyFirst).toEqual({ kind: 'value', value: 0 });
    expect(snapshot.metrics.goodMatch).toEqual({ kind: 'value', value: 0 });
    // job-d has a submitted application, so it is counted as already applied.
    expect(snapshot.metrics.reviewJobs).toEqual({ kind: 'value', value: 3 });
    expect(snapshot.shortlist.rows).toHaveLength(3);
    for (const row of snapshot.shortlist.rows) {
      expect(row.matchState).toBe('unavailable');
      expect(row.confidenceLabel).toBeNull();
      expect(row.matchLabel).toBe('No match estimate available');
    }
    expect(snapshot.notes.some((n) => n.includes('No usable master profile'))).toBe(true);
  });
});

describe('malformed / unavailable storage (§8.14–8.15)', () => {
  it('marks job-derived metrics unavailable instead of zero when jobs cannot be read', () => {
    const snapshot = run({ jobs: null });
    expect(snapshot.metrics.savedJobs).toEqual({ kind: 'unavailable', reason: 'jobs-unreadable' });
    expect(snapshot.metrics.applyFirst).toEqual({ kind: 'unavailable', reason: 'jobs-unreadable' });
    expect(snapshot.metrics.reviewJobs).toEqual({ kind: 'unavailable', reason: 'jobs-unreadable' });
    expect(snapshot.metrics.goodMatch).toEqual({ kind: 'unavailable', reason: 'jobs-unreadable' });
    expect(snapshot.shortlist).toMatchObject({
      available: false,
      reason: 'jobs-unreadable',
      rows: [],
    });
    // Partial availability: the application log was readable, so its metrics
    // are still real numbers.
    expect(snapshot.metrics.submitted).toEqual({ kind: 'value', value: 3 });
  });

  it('marks application metrics unavailable while still prioritizing jobs', () => {
    const snapshot = run({ applications: null });
    for (const key of ['submitted', 'interviews', 'offers', 'upcomingFollowUps'] as const) {
      expect(snapshot.metrics[key]).toEqual({
        kind: 'unavailable',
        reason: 'applications-unreadable',
      });
    }
    // Fail closed: with an unreadable log no job can be called apply-first.
    expect(snapshot.metrics.applyFirst).toEqual({ kind: 'value', value: 0 });
    expect(snapshot.metrics.reviewJobs).toEqual({ kind: 'value', value: 4 });
  });

  it('treats one invalid application record as an unreadable log', () => {
    const snapshot = run({
      applications: [APPLICATIONS[0]!, { id: 'broken', notes: 'synthetic' }],
    });
    expect(snapshot.metrics.submitted).toEqual({
      kind: 'unavailable',
      reason: 'applications-unreadable',
    });
  });

  it('skips invalid saved records and notes it', () => {
    const snapshot = run({ jobs: [JOBS[0], { id: 'broken', title: 'No description' }] });
    expect(snapshot.metrics.savedJobs).toEqual({ kind: 'value', value: 1 });
    expect(snapshot.notes.some((n) => n.includes('failed validation'))).toBe(true);
  });

  it('returns a typed invalid outcome for an impossible date', () => {
    const outcome = buildDashboardSnapshot({
      jobs: [],
      applications: [],
      matches: [],
      minMatchThreshold: null,
      profileAvailable: false,
      today: '2026-02-31',
    });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.issues).toEqual(['today: custom']);
  });
});

describe('determinism and boundaries (§6, §8.17)', () => {
  it('produces identical snapshots for identical input and never mutates it', () => {
    const input = {
      jobs: JOBS,
      applications: APPLICATIONS,
      matches: MATCHES,
      minMatchThreshold: THRESHOLD,
      profileAvailable: true,
      today: TODAY,
    };
    const before = JSON.stringify(input);
    expect(buildDashboardSnapshot(input)).toEqual(buildDashboardSnapshot(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('makes no network call', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never links to storage, the AI layer, the clock or the network', () => {
    // Static guard: the snapshot module only consumes validated data handed to
    // it and must stay renderable without any browser capability.
    const source = readFileSync(new URL('./snapshot.ts', import.meta.url), 'utf8');
    const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
    for (const statement of imports) expect(statement).not.toMatch(/from '.*\/(storage|ai)['"]/);
    expect(source).not.toMatch(/Date\.now\(|new Date\(/);
    expect(source).not.toMatch(/chrome\.|browser\.|fetch\(/);
    expect(source).not.toMatch(/setInterval|setTimeout/);
  });
});
