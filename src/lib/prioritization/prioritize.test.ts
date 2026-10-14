/**
 * Unit tests for the freshness-aware job prioritization (Prompt 24).
 *
 * The module under test is PURE: it validates already-computed inputs with the
 * existing schemas, classifies each saved job, orders the four categories
 * deterministically and returns a strict-validated result. These tests cover
 * every category + precedence rule, application-status semantics (planned vs
 * submitted), unlinked records, threshold boundaries, dates at 0/7/8 days,
 * unknown and future dates, month/year/leap boundaries, stable ordering,
 * fail-closed behaviour for missing/invalid inputs, strict schema rejection,
 * determinism, input immutability and the absence of clock/network/storage/AI
 * access.
 *
 * Fixtures are entirely fake — no personal data, no secrets, no real postings.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applicationSchema, type Application } from '../applications/schemas';
import { calculateJobMatch } from '../matching';
import { matchResultSchema, type JobMatchResult, type ThresholdDecision } from '../matching/schemas';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { defaultSettings, settingsSchema, type Settings } from '../settings';
import { profileSchema, type Profile } from '../profile';
import {
  comparePriorityEntries,
  FRESHNESS_WINDOW_DAYS,
  MAX_PRIORITY_JOBS,
  prioritizationResultSchema,
  prioritizeJobs,
  PRIORITY_CATEGORIES,
  PRIORITY_CATEGORY_META,
  PRIORITY_SCHEMA_VERSION,
  validatePrioritizationResult,
  type PrioritizationInput,
  type PrioritizationResult,
  type PriorityCategory,
  type PriorityEntry,
} from '.';

const TODAY = '2026-10-10';
const CAPTURED_AT = '2026-10-01T00:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Fixtures (fake data only)                                           */
/* ------------------------------------------------------------------ */

function makeJob(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-a',
    title: 'Backend Engineer',
    company: 'Fake Co',
    location: 'Berlin, DE',
    rawDescription: 'Fake raw description.',
    source: 'manual',
    capturedAt: CAPTURED_AT,
    ...patch,
  });
}

function makeApplication(patch: Record<string, unknown> = {}): Application {
  return applicationSchema.parse({
    id: 'app-1',
    jobId: 'job-a',
    status: 'applied',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    ...patch,
  });
}

interface MatchOptions {
  outcome?: 'score' | 'insufficient-data';
  score?: number;
  configured?: number;
  filtering?: boolean;
  decision?: ThresholdDecision;
  meets?: boolean | null;
}

/** A valid, synthetic already-computed match result (never recomputed here). */
function makeMatch(options: MatchOptions = {}): JobMatchResult {
  const {
    outcome = 'score',
    score = 80,
    configured = 60,
    filtering = true,
    decision = 'pass',
    meets = true,
  } = options;
  return matchResultSchema.parse({
    schemaVersion: '1',
    estimate:
      outcome === 'score'
        ? {
            outcome: 'score',
            score,
            factors: [],
            availableWeight: 100,
            explanation: 'Fake estimate explanation.',
          }
        : {
            outcome: 'insufficient-data',
            reason: 'Not enough comparable data to score this posting.',
            factors: [],
            availableWeight: 20,
            explanation: 'Fake estimate explanation.',
          },
    requirements: [],
    hardIssues: [],
    confidence: {
      level: 'high',
      completeness: 100,
      counts: { total: 0, assessed: 0, matched: 0, partial: 0, missing: 0, unknown: 0 },
      explanation: 'Fake confidence explanation.',
    },
    threshold: { configured, filtering, meets: filtering ? meets : null, decision },
    summary: 'Fake summary.',
  });
}

function run(input: Partial<PrioritizationInput> & { jobs: readonly unknown[] }): PrioritizationResult {
  const outcome = prioritizeJobs({
    today: TODAY,
    applications: [],
    minMatchThreshold: 60,
    ...input,
  });
  if (outcome.kind !== 'valid') throw new Error(`expected a valid result: ${outcome.issues.join('; ')}`);
  return outcome.result;
}

function entryFor(result: PrioritizationResult, jobId: string): PriorityEntry {
  for (const group of result.groups) {
    const found = group.jobs.find((j) => j.jobId === jobId);
    if (found !== undefined) return found;
  }
  throw new Error(`no entry for ${jobId}`);
}

function ids(result: PrioritizationResult, category: PriorityCategory): string[] {
  const group = result.groups.find((g) => g.category === category);
  return group === undefined ? [] : group.jobs.map((j) => j.jobId);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Shape and contract                                                  */
/* ------------------------------------------------------------------ */

describe('result contract', () => {
  it('always returns exactly the four categories, in documented order', () => {
    const result = run({ jobs: [makeJob()] });
    expect(result.groups.map((g) => g.category)).toEqual([...PRIORITY_CATEGORIES]);
    expect(PRIORITY_CATEGORIES).toEqual(['apply-first', 'good-match', 'needs-review', 'already-applied']);
    expect(result.schemaVersion).toBe(PRIORITY_SCHEMA_VERSION);
    expect(result.freshnessWindowDays).toBe(FRESHNESS_WINDOW_DAYS);
    expect(FRESHNESS_WINDOW_DAYS).toBe(7);
    expect(result.today).toBe(TODAY);
  });

  it('counts match the jobs in each group and totalJobs', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a' }), makeJob({ id: 'job-b' }), makeJob({ id: 'job-c' })],
      matches: [
        { jobId: 'job-a', result: makeMatch() },
        { jobId: 'job-b', result: makeMatch({ outcome: 'insufficient-data' }) },
      ],
    });
    expect(result.totalJobs).toBe(3);
    for (const group of result.groups) expect(group.count).toBe(group.jobs.length);
    expect(ids(result, 'needs-review')).toEqual(['job-b', 'job-c']);
    expect(result.groups.reduce((n, g) => n + g.count, 0)).toBe(3);
  });

  it('documents every category with a label and a description', () => {
    for (const category of PRIORITY_CATEGORIES) {
      const meta = PRIORITY_CATEGORY_META[category];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('carries NO combined numerical score — match and freshness stay separate', () => {
    const entry = entryFor(run({ jobs: [makeJob()], matches: [{ jobId: 'job-a', result: makeMatch() }] }), 'job-a');
    expect(Object.keys(entry).sort()).toEqual(
      [
        'application',
        'category',
        'company',
        'freshness',
        'jobId',
        'match',
        'originalUrl',
        'reasons',
        'title',
      ].sort(),
    );
    expect(entry).not.toHaveProperty('priorityScore');
    expect(entry.match).not.toHaveProperty('priority');
    expect(entry.match.score).toBe(80);
    expect(entry.freshness).not.toHaveProperty('score');
    expect(entry.reasons.length).toBeGreaterThan(0);
  });

  it('handles an empty saved-jobs list', () => {
    const result = run({ jobs: [] });
    expect(result.totalJobs).toBe(0);
    expect(result.skippedJobs).toBe(0);
    for (const group of result.groups) expect(group.jobs).toEqual([]);
  });

  it('keeps a safe original URL only when it re-validates as http(s)', () => {
    const withUrl = entryFor(run({ jobs: [makeJob({ id: 'job-ok', originalUrl: 'https://example.com/jobs/1' })] }), 'job-ok');
    expect(withUrl.originalUrl).toBe('https://example.com/jobs/1');
    // No URL saved → no link (the UI renders nothing, never an empty href).
    expect(entryFor(run({ jobs: [makeJob({ id: 'job-none' })] }), 'job-none').originalUrl).toBeNull();
    // A record whose URL is not http(s) never validates as a saved job, so it is
    // skipped entirely — a `javascript:` link can never reach the UI.
    const unsafe = run({ jobs: [{ ...makeJob({ id: 'job-bad' }), originalUrl: 'javascript:alert(1)' }] });
    expect(unsafe.totalJobs).toBe(0);
    expect(unsafe.skippedJobs).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Categories and precedence                                           */
/* ------------------------------------------------------------------ */

describe('category rules and precedence', () => {
  it('apply-first: meets the minimum, known recent date, no submitted application', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: makeMatch({ score: 80, configured: 60 }) }],
      minMatchThreshold: 60,
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('apply-first');
    expect(entry.freshness.ageDays).toBe(0);
    expect(entry.freshness.withinWindow).toBe(true);
    expect(entry.reasons.join(' ')).toContain('meets your minimum of 60');
  });

  it('good-match: meets the minimum but the posting date is outside the window', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: '2026-09-30' })], // 10 days old
        matches: [{ jobId: 'job-a', result: makeMatch() }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('good-match');
    expect(entry.freshness.ageDays).toBe(10);
    expect(entry.reasons.join(' ')).toContain('outside the 7-day freshness window');
  });

  it('good-match: meets the minimum but the posting date is unknown', () => {
    const entry = entryFor(
      run({ jobs: [makeJob({ id: 'job-a' })], matches: [{ jobId: 'job-a', result: makeMatch() }] }),
      'job-a',
    );
    expect(entry.category).toBe('good-match');
    expect(entry.freshness.postedDate).toBeNull();
    expect(entry.freshness.label).toBe('Posting date unknown');
    expect(entry.reasons.join(' ')).toContain('Posting date unknown');
  });

  it('needs-review: a score below the configured minimum is never rescued by a fresh date', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch({ score: 59, configured: 60, decision: 'below', meets: false }) }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('needs-review');
    expect(entry.match.state).toBe('score');
    expect(entry.match.score).toBe(59);
    expect(entry.match.meetsThreshold).toBe(false);
    expect(entry.reasons.join(' ')).toContain('below your minimum of 60');
  });

  it('needs-review: insufficient match data even with a fresh posting date', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch({ outcome: 'insufficient-data' }) }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('needs-review');
    expect(entry.match.state).toBe('insufficient-data');
    expect(entry.match.score).toBeNull();
    expect(entry.match.meetsThreshold).toBe(false);
  });

  it('needs-review: a future posting date is flagged for verification, never fresh', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: '2026-10-11' })],
        matches: [{ jobId: 'job-a', result: makeMatch({ score: 100, configured: 60 }) }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('needs-review');
    expect(entry.freshness.future).toBe(true);
    expect(entry.freshness.withinWindow).toBe(false);
    expect(entry.freshness.ageDays).toBeNull();
    expect(entry.freshness.label).toContain('Future posting date — verify');
    // A perfect score never makes a future date look fresh.
    expect(entry.reasons.join(' ')).toContain('is in the future');
  });

  it('already-applied wins over a fresh, well-matching job', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch({ score: 95 }) }],
        applications: [makeApplication({ jobId: 'job-a', status: 'interview' })],
      }),
      'job-a',
    );
    expect(entry.category).toBe('already-applied');
    expect(entry.application.state).toBe('in-progress');
    expect(entry.application.statusLabel).toBe('Interview');
    expect(entry.reasons.join(' ')).toContain('already applied or in progress');
  });

  it('a future-dated job with a good match is needs-review, not good-match', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: '2027-01-01' })],
        matches: [{ jobId: 'job-a', result: makeMatch() }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('needs-review');
  });
});

/* ------------------------------------------------------------------ */
/* Application-status semantics                                        */
/* ------------------------------------------------------------------ */

describe('application status semantics', () => {
  it('planned-only records are never treated as already applied', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch() }],
        applications: [makeApplication({ jobId: 'job-a', status: 'planned' })],
      }),
      'job-a',
    );
    expect(entry.category).toBe('apply-first');
    expect(entry.application.state).toBe('planned');
    expect(entry.application.label).toBe('Planned (not submitted)');
    expect(entry.reasons.join(' ')).toContain('nothing has been submitted yet');
  });

  it.each([
    ['applied', 'in-progress'],
    ['assessment', 'in-progress'],
    ['interview', 'in-progress'],
    ['offer', 'in-progress'],
    ['rejected', 'completed'],
    ['withdrawn', 'completed'],
  ] as const)('status %s is already-applied (%s)', (status, state) => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch() }],
        applications: [makeApplication({ jobId: 'job-a', status })],
      }),
      'job-a',
    );
    expect(entry.category).toBe('already-applied');
    expect(entry.application.status).toBe(status);
    expect(entry.application.state).toBe(state);
  });

  it('reports the recorded application date without inventing one', () => {
    const withDate = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a' })],
        applications: [makeApplication({ jobId: 'job-a', status: 'applied', applicationDate: '2026-10-02' })],
      }),
      'job-a',
    );
    expect(withDate.application.applicationDate).toBe('2026-10-02');
    expect(withDate.reasons.join(' ')).toContain('application date 2026-10-02');

    const withoutDate = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a' })],
        applications: [makeApplication({ jobId: 'job-a', status: 'applied' })],
      }),
      'job-a',
    );
    expect(withoutDate.application.applicationDate).toBeNull();
    expect(withoutDate.reasons.join(' ')).not.toContain('application date');
  });

  it('never associates an application record with a different job id', () => {
    // Same title/company, but the record references another job entirely.
    const result = run({
      jobs: [makeJob({ id: 'job-b', title: 'Backend Engineer', company: 'Fake Co', postedDate: TODAY })],
      matches: [{ jobId: 'job-b', result: makeMatch() }],
      applications: [makeApplication({ id: 'app-x', jobId: 'job-other', status: 'applied' })],
    });
    const entry = entryFor(result, 'job-b');
    expect(entry.application.state).toBe('none');
    expect(entry.category).toBe('apply-first');
  });

  it('prefers a submitted record over a planned one for the same job, deterministically', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a' })],
        applications: [
          makeApplication({ id: 'app-planned', jobId: 'job-a', status: 'planned', updatedAt: '2026-10-09T00:00:00.000Z' }),
          makeApplication({ id: 'app-applied', jobId: 'job-a', status: 'applied', updatedAt: '2026-10-02T00:00:00.000Z' }),
        ],
      }),
      'job-a',
    );
    expect(entry.application.status).toBe('applied');
    expect(entry.application.linkedCount).toBe(2);
  });

  it('breaks same-rank ties on updatedAt descending, then id', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a' })],
        applications: [
          makeApplication({ id: 'app-old', jobId: 'job-a', status: 'applied', updatedAt: '2026-10-02T00:00:00.000Z' }),
          makeApplication({ id: 'app-new', jobId: 'job-a', status: 'interview', updatedAt: '2026-10-08T00:00:00.000Z' }),
        ],
      }),
      'job-a',
    );
    expect(entry.application.status).toBe('interview');
  });
});

/* ------------------------------------------------------------------ */
/* Threshold boundaries                                                */
/* ------------------------------------------------------------------ */

describe('match threshold boundaries', () => {
  it('a score exactly at the minimum qualifies (matcher decision is reused)', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch({ score: 60, configured: 60, decision: 'pass', meets: true }) }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('apply-first');
    expect(entry.match.meetsThreshold).toBe(true);
  });

  it('one point below the minimum does not qualify', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: makeMatch({ score: 60, configured: 61, decision: 'below', meets: false }) }],
      }),
      'job-a',
    );
    expect(entry.category).toBe('needs-review');
  });

  it('an unconfigured minimum (0 disables filtering) accepts any usable estimate', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [
        { jobId: 'job-a', result: makeMatch({ score: 3, configured: 0, filtering: false, decision: 'disabled', meets: null }) },
      ],
      minMatchThreshold: 0,
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('apply-first');
    expect(entry.match.filtering).toBe(false);
    expect(result.threshold).toEqual({ configured: 0, filtering: false });
    expect(result.notes.join(' ')).toContain('minimum 0 disables threshold filtering');
  });

  it('insufficient data can never count as meeting the minimum', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [
          { jobId: 'job-a', result: makeMatch({ outcome: 'insufficient-data', configured: 0, filtering: false, decision: 'insufficient-data', meets: null }) },
        ],
        minMatchThreshold: 0,
      }),
      'job-a',
    );
    expect(entry.match.meetsThreshold).toBe(false);
    expect(entry.category).toBe('needs-review');
  });
});

/* ------------------------------------------------------------------ */
/* Dates and freshness                                                 */
/* ------------------------------------------------------------------ */

describe('freshness windows and calendar boundaries', () => {
  it.each([
    ['2026-10-10', 0, true],
    ['2026-10-09', 1, true],
    ['2026-10-03', 7, true],
    ['2026-10-02', 8, false],
    ['2026-09-30', 10, false],
  ])('posting date %s is %i day(s) old (within window: %s)', (postedDate, ageDays, within) => {
    const entry = entryFor(
      run({ jobs: [makeJob({ id: 'job-a', postedDate })], matches: [{ jobId: 'job-a', result: makeMatch() }] }),
      'job-a',
    );
    expect(entry.freshness.postedDate).toBe(postedDate);
    expect(entry.freshness.ageDays).toBe(ageDays);
    expect(entry.freshness.withinWindow).toBe(within);
    expect(entry.category).toBe(within ? 'apply-first' : 'good-match');
  });

  it('reports age zero as "Posted today"', () => {
    const entry = entryFor(
      run({ jobs: [makeJob({ id: 'job-a', postedDate: TODAY })], matches: [{ jobId: 'job-a', result: makeMatch() }] }),
      'job-a',
    );
    expect(entry.freshness.label).toBe(`Posted today (${TODAY})`);
  });

  it('handles month and year boundaries exactly', () => {
    const entryAt = (postedDate: string, today: string) =>
      entryFor(
        run({
          jobs: [makeJob({ id: 'job-a', postedDate })],
          matches: [{ jobId: 'job-a', result: makeMatch() }],
          today,
        }),
        'job-a',
      );

    // Across a year boundary (no month arithmetic shortcuts).
    const newYear = entryAt('2025-12-31', '2026-01-01');
    expect(newYear.freshness.ageDays).toBe(1);
    expect(newYear.freshness.withinWindow).toBe(true);
    expect(newYear.category).toBe('apply-first');

    const newYearOutside = entryAt('2025-12-24', '2026-01-01');
    expect(newYearOutside.freshness.ageDays).toBe(8);
    expect(newYearOutside.freshness.withinWindow).toBe(false);

    // Across a month boundary, exactly on the window edge.
    const monthEdge = entryAt('2026-09-30', '2026-10-07');
    expect(monthEdge.freshness.ageDays).toBe(7);
    expect(monthEdge.category).toBe('apply-first');

    // Across a short month.
    expect(entryAt('2026-02-28', '2026-03-05').freshness.ageDays).toBe(5);
  });

  it('handles a leap day on both sides of the window', () => {
    const atLeap = (postedDate: string, today: string) => {
      const result = run({
        jobs: [makeJob({ id: 'job-a', postedDate })],
        matches: [{ jobId: 'job-a', result: makeMatch() }],
        today,
      });
      return entryFor(result, 'job-a');
    };
    const inside = atLeap('2024-02-29', '2024-03-07');
    expect(inside.freshness.ageDays).toBe(7);
    expect(inside.freshness.withinWindow).toBe(true);
    expect(inside.category).toBe('apply-first');

    const outside = atLeap('2024-02-29', '2024-03-08');
    expect(outside.freshness.ageDays).toBe(8);
    expect(outside.freshness.withinWindow).toBe(false);

    // 2023 has no 29 February — the stored date itself cannot be a real date.
    expect(prioritizeJobs({ today: '2023-02-29', jobs: [], applications: [], minMatchThreshold: 60 }).kind).toBe('invalid');
  });

  it('treats an unknown posting date as never recent', () => {
    const entry = entryFor(
      run({ jobs: [makeJob({ id: 'job-a' })], matches: [{ jobId: 'job-a', result: makeMatch() }] }),
      'job-a',
    );
    expect(entry.freshness.ageDays).toBeNull();
    expect(entry.freshness.withinWindow).toBe(false);
    expect(entry.freshness.future).toBe(false);
    expect(entry.category).toBe('good-match');
  });
});

/* ------------------------------------------------------------------ */
/* Stable ordering                                                     */
/* ------------------------------------------------------------------ */

describe('stable ordering', () => {
  it('orders by known date (newest first), then score, then job id', () => {
    const result = run({
      jobs: [
        makeJob({ id: 'job-unknown' }),
        makeJob({ id: 'job-old', postedDate: '2026-09-01' }),
        makeJob({ id: 'job-mid-b', postedDate: '2026-09-20' }),
        makeJob({ id: 'job-mid-a', postedDate: '2026-09-20' }),
        makeJob({ id: 'job-newest', postedDate: '2026-09-20' }),
      ],
      matches: [
        { jobId: 'job-unknown', result: makeMatch({ score: 99 }) },
        { jobId: 'job-old', result: makeMatch({ score: 50 }) },
        { jobId: 'job-mid-a', result: makeMatch({ score: 70 }) },
        { jobId: 'job-mid-b', result: makeMatch({ score: 90 }) },
        { jobId: 'job-newest', result: makeMatch({ score: 70 }) },
      ],
    });
    expect(ids(result, 'good-match')).toEqual([
      'job-mid-b', // 2026-09-20, score 90
      'job-mid-a', // 2026-09-20, score 70 — id ascending tie-break
      'job-newest', // 2026-09-20, score 70 (same score, id order)
      'job-old', // 2026-09-01
      'job-unknown', // unknown dates never outrank known ones
    ]);
  });

  it('never lets a high score with an unknown date outrank a known older date', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-known', postedDate: '2026-08-01' }), makeJob({ id: 'job-unknown' })],
      matches: [
        { jobId: 'job-known', result: makeMatch({ score: 61 }) },
        { jobId: 'job-unknown', result: makeMatch({ score: 100 }) },
      ],
    });
    expect(ids(result, 'good-match')).toEqual(['job-known', 'job-unknown']);
  });

  it('falls back to job id when two unknown-date jobs share a score', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-z' }), makeJob({ id: 'job-a' })],
      matches: [
        { jobId: 'job-z', result: makeMatch({ score: 75 }) },
        { jobId: 'job-a', result: makeMatch({ score: 75 }) },
      ],
    });
    expect(ids(result, 'good-match')).toEqual(['job-a', 'job-z']);
  });

  it('comparePriorityEntries implements the documented order', () => {
    const entry = (jobId: string, postedDate: string | null, score: number | null): PriorityEntry =>
      entryFor(
        run({
          jobs: [makeJob({ id: jobId, ...(postedDate === null ? {} : { postedDate }) })],
          matches: score === null ? [] : [{ jobId, result: makeMatch({ score }) }],
        }),
        jobId,
      );
    const known = entry('job-known', '2026-09-01', 50);
    const unknown = entry('job-unknown', null, 99);
    expect(comparePriorityEntries(known, unknown)).toBeLessThan(0);
    expect(comparePriorityEntries(unknown, known)).toBeGreaterThan(0);

    const newer = entry('job-newer', '2026-09-20', 10);
    expect(comparePriorityEntries(newer, known)).toBeLessThan(0);

    const high = entry('job-high', null, 90);
    const low = entry('job-low', null, 20);
    expect(comparePriorityEntries(high, low)).toBeLessThan(0);
    expect(comparePriorityEntries(low, high)).toBeGreaterThan(0);

    const a = entry('job-a', null, 50);
    const b = entry('job-b', null, 50);
    expect(comparePriorityEntries(a, b)).toBeLessThan(0);
    expect(comparePriorityEntries(b, a)).toBeGreaterThan(0);
    expect(comparePriorityEntries(a, a)).toBe(0);
  });

  it('is order-independent: shuffling the input jobs does not change the result', () => {
    const jobs = [
      makeJob({ id: 'job-a', postedDate: '2026-09-20' }),
      makeJob({ id: 'job-b' }),
      makeJob({ id: 'job-c', postedDate: '2026-09-20' }),
      makeJob({ id: 'job-d', postedDate: '2026-08-01' }),
    ];
    const matches = jobs.map((job) => ({ jobId: job.id, result: makeMatch({ score: 70 }) }));
    const forward = run({ jobs, matches });
    const backward = run({ jobs: [...jobs].reverse(), matches: [...matches].reverse() });
    expect(backward).toEqual(forward);
  });

  it('does not modify the saved job order in storage (nothing is written back)', () => {
    const jobs = [makeJob({ id: 'job-c' }), makeJob({ id: 'job-a' }), makeJob({ id: 'job-b' })];
    const before = JSON.stringify(jobs);
    run({ jobs, matches: jobs.map((job) => ({ jobId: job.id, result: makeMatch() })) });
    expect(JSON.stringify(jobs)).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* Fail-closed behaviour                                               */
/* ------------------------------------------------------------------ */

describe('fail-closed signals', () => {
  it('treats an unreadable application log as unknown, never "not applied"', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: makeMatch() }],
      applications: null,
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('needs-review');
    expect(entry.application.state).toBe('unavailable');
    expect(entry.application.status).toBeNull();
    expect(entry.application.label).toBe('Application status unknown');
    expect(result.notes.join(' ')).toContain('application log could not be read');
    expect(ids(result, 'already-applied')).toEqual([]);
  });

  it('fails the whole log closed when one record is unreadable', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: makeMatch() }],
      applications: [makeApplication({ jobId: 'job-a', status: 'applied' }), { id: 'broken', extra: true }],
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.application.state).toBe('unavailable');
    expect(entry.category).toBe('needs-review');
    expect(result.notes.join(' ')).toContain('Some application records could not be read');
  });

  it('fails closed when settings (the configured minimum) are unavailable', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: makeMatch() }],
      minMatchThreshold: null,
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.category).toBe('needs-review');
    expect(entry.match.state).toBe('unavailable');
    expect(entry.match.score).toBeNull();
    expect(entry.match.meetsThreshold).toBeNull();
    expect(result.threshold).toEqual({ configured: null, filtering: false });
    expect(result.notes.join(' ')).toContain('Settings could not be read');
  });

  it('reports an invalid match result as invalid instead of a score', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: { kind: 'invalid', issues: ['profile.headline: invalid_type'] } }],
    });
    const entry = entryFor(result, 'job-a');
    expect(entry.match.state).toBe('invalid');
    expect(entry.match.score).toBeNull();
    expect(entry.category).toBe('needs-review');
    expect(result.notes.join(' ')).toContain('invalid or missing');
  });

  it('reports a structurally invalid match result as invalid', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [{ jobId: 'job-a', result: { schemaVersion: '1', estimate: { outcome: 'score', score: 999 } } }],
      }),
      'job-a',
    );
    expect(entry.match.state).toBe('invalid');
    expect(entry.category).toBe('needs-review');
  });

  it('reports a missing match result as unavailable, not as a low score', () => {
    const entry = entryFor(run({ jobs: [makeJob({ id: 'job-a', postedDate: TODAY })] }), 'job-a');
    expect(entry.match.state).toBe('unavailable');
    expect(entry.match.score).toBeNull();
    expect(entry.match.label).toBe('No match estimate available');
    expect(entry.category).toBe('needs-review');
  });

  it('skips unvalidated saved jobs instead of classifying them', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-ok' }), { ...makeJob({ id: 'job-broken' }), title: '' }, { nothing: true }],
      matches: [{ jobId: 'job-ok', result: makeMatch() }],
    });
    expect(result.totalJobs).toBe(1);
    expect(result.skippedJobs).toBe(2);
    expect(result.notes.join(' ')).toContain('Some saved jobs failed validation');
    expect(() => entryFor(result, 'job-broken')).toThrow();
  });

  it('ignores match entries that are not usable (no jobId / no payload)', () => {
    const entry = entryFor(
      run({
        jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
        matches: [
          { jobId: '', result: makeMatch() },
          { jobId: 'job-a' } as unknown as { jobId: string; result: unknown },
          makeMatch() as unknown as { jobId: string; result: unknown },
        ],
      }),
      'job-a',
    );
    expect(entry.match.state).toBe('unavailable');
    expect(entry.category).toBe('needs-review');
  });
});

/* ------------------------------------------------------------------ */
/* Input validation                                                    */
/* ------------------------------------------------------------------ */

describe('typed invalid outcomes', () => {
  it.each(['2026-02-31', '2026-13-01', '10/10/2026', '2026-10-10 extra', ''])(
    'rejects an unusable today value (%s)',
    (today) => {
      const outcome = prioritizeJobs({ today, jobs: [], applications: [], minMatchThreshold: 60 });
      expect(outcome.kind).toBe('invalid');
      if (outcome.kind === 'invalid') {
        expect(outcome.issues.length).toBeGreaterThan(0);
        expect(outcome.issues[0]?.startsWith('today')).toBe(true);
      }
    },
  );

  it.each([-1, 101, 1.5])('rejects an impossible minimum (%s)', (minMatchThreshold) => {
    const outcome = prioritizeJobs({ today: TODAY, jobs: [], applications: [], minMatchThreshold });
    expect(outcome.kind).toBe('invalid');
  });

  it('classifies a real calculateJobMatch outcome without recomputing the score', () => {
    const profile = fakeProfile();
    const settings = fakeSettings({ minMatchThreshold: 0 });
    const job = makeJob({
      id: 'job-a',
      postedDate: TODAY,
      skills: ['TypeScript'],
      requiredQualifications: ['TypeScript'],
    });
    const outcome = calculateJobMatch(profile, job, settings);
    expect(outcome.kind).toBe('valid');
    if (outcome.kind !== 'valid') throw new Error('fixture must produce a valid matcher outcome');
    expect(outcome.result.estimate.outcome).toBe('score');
    const rawScore = outcome.result.estimate.outcome === 'score' ? outcome.result.estimate.score : null;

    const entry = entryFor(
      run({ jobs: [job], matches: [{ jobId: 'job-a', result: outcome }], minMatchThreshold: 0 }),
      'job-a',
    );
    expect(entry.match.score).toBe(rawScore); // the estimate is reused verbatim
    expect(entry.category).toBe('apply-first');
    expect(entry.freshness.label).toBe(`Posted today (${TODAY})`);

    // The same real estimate, older posting date → good-match (freshness only).
    const oldJob = makeJob({
      id: 'job-a',
      postedDate: '2026-08-01',
      skills: ['TypeScript'],
      requiredQualifications: ['TypeScript'],
    });
    const oldEntry = entryFor(
      run({
        jobs: [oldJob],
        matches: [{ jobId: 'job-a', result: calculateJobMatch(profile, oldJob, settings) }],
        minMatchThreshold: 0,
      }),
      'job-a',
    );
    expect(oldEntry.category).toBe('good-match');
    expect(oldEntry.match.score).toBe(rawScore); // unchanged by the older date

    // The same real estimate with a linked applied record → already-applied.
    const tracked = entryFor(
      run({
        jobs: [job],
        matches: [{ jobId: 'job-a', result: outcome }],
        applications: [makeApplication({ jobId: 'job-a', status: 'applied' })],
        minMatchThreshold: 0,
      }),
      'job-a',
    );
    expect(tracked.category).toBe('already-applied');
  });
});

/* ------------------------------------------------------------------ */
/* Strict result schema                                                */
/* ------------------------------------------------------------------ */

describe('strict result validation', () => {
  it('produces a result that satisfies its own strict schema', () => {
    const result = run({
      jobs: [makeJob({ id: 'job-a', postedDate: TODAY })],
      matches: [{ jobId: 'job-a', result: makeMatch() }],
    });
    expect(prioritizationResultSchema.safeParse(result).success).toBe(true);
    expect(validatePrioritizationResult(result).ok).toBe(true);
  });

  it('rejects an unexpected property on the result or a nested job', () => {
    const result = run({ jobs: [makeJob()] });
    expect(validatePrioritizationResult({ ...result, priorityScore: 87 }).ok).toBe(false);
    const withGroupExtra = {
      ...result,
      groups: result.groups.map((g, i) => (i === 0 ? { ...g, extra: true } : g)),
    };
    expect(validatePrioritizationResult(withGroupExtra).ok).toBe(false);
    const withEntryExtra = {
      ...result,
      groups: result.groups.map((g) => ({
        ...g,
        jobs: g.jobs.map((j) => ({ ...j, priorityScore: 87 })),
      })),
    };
    expect(validatePrioritizationResult(withEntryExtra).ok).toBe(false);
    const withMatchExtra = {
      ...result,
      groups: result.groups.map((g) => ({
        ...g,
        jobs: g.jobs.map((j) => ({ ...j, match: { ...j.match, probability: 0.9 } })),
      })),
    };
    expect(validatePrioritizationResult(withMatchExtra).ok).toBe(false);
  });

  it('rejects a malformed result (wrong category, missing groups, bad counts)', () => {
    const result = run({ jobs: [makeJob()] });
    expect(validatePrioritizationResult({ ...result, totalJobs: -1 }).ok).toBe(false);
    expect(
      validatePrioritizationResult({ ...result, groups: result.groups.slice(0, 3) }).ok,
    ).toBe(false);
    expect(
      validatePrioritizationResult({
        ...result,
        groups: result.groups.map((g, i) => (i === 0 ? { ...g, category: 'top-priority' } : g)),
      }).ok,
    ).toBe(false);
  });

  it('reports issues as paths/codes only (never values)', () => {
    const validation = validatePrioritizationResult({ groups: [], schemaVersion: 'nope' });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.length).toBeGreaterThan(0);
      expect(validation.issues.join(' ')).not.toContain('nope');
    }
  });

  it('keeps the hard-coded job cap exported and positive', () => {
    expect(MAX_PRIORITY_JOBS).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism and purity                                              */
/* ------------------------------------------------------------------ */

describe('determinism and purity', () => {
  function build(): PrioritizationInput {
    const jobs = [
      makeJob({ id: 'job-a', postedDate: TODAY }),
      makeJob({ id: 'job-b' }),
      makeJob({ id: 'job-c', postedDate: '2026-09-01' }),
    ];
    return {
      jobs,
      matches: [
        { jobId: 'job-a', result: makeMatch({ score: 80 }) },
        { jobId: 'job-b', result: makeMatch({ score: 60, configured: 60, decision: 'pass' }) },
        { jobId: 'job-c', result: makeMatch({ outcome: 'insufficient-data' }) },
      ],
      applications: [makeApplication({ jobId: 'job-b', status: 'planned' })],
      today: TODAY,
      minMatchThreshold: 60,
    };
  }

  it('is deterministic for identical inputs', () => {
    expect(prioritizeJobs(build())).toEqual(prioritizeJobs(build()));
  });

  it('does not mutate deeply frozen inputs', () => {
    const input = deepFreeze(build());
    const fingerprint = JSON.stringify(input);
    expect(() => prioritizeJobs(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(fingerprint);
  });

  it('does not read the clock: the system time changes nothing', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      const first = prioritizeJobs(build());
      vi.setSystemTime(new Date('2031-07-04T23:59:59.000Z'));
      const second = prioritizeJobs(build());
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes no network call', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    prioritizeJobs(build());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never links the module to storage, the AI layer, the clock or the network', () => {
    // Static guard: the pure module only consumes validated data handed to it.
    for (const file of ['prioritize.ts', 'schemas.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
      for (const statement of imports) {
        expect(statement).not.toMatch(/from '.*\/(storage|ai)['"]/);
      }
      expect(source).not.toMatch(/Date\.now\(|new Date\(/);
      expect(source).not.toMatch(/chrome\.|browser\./);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures shared with the real matcher                               */
/* ------------------------------------------------------------------ */

function fakeProfile(): Profile {
  return profileSchema.parse({
    headline: 'Backend Engineer',
    skills: [
      { id: 'sk-ts', name: 'TypeScript', status: 'verified', evidenceRef: { kind: 'experience', id: 'exp-1' } },
      { id: 'sk-node', name: 'Node.js', status: 'claimed' },
    ],
    experience: [
      {
        id: 'exp-1',
        company: 'Fake Co',
        title: 'Software Engineer',
        dates: { start: '2018-03', end: null },
        bullets: ['Built fake services.'],
      },
    ],
  });
}

function fakeSettings(patch: Record<string, unknown> = {}): Settings {
  return settingsSchema.parse({
    ...defaultSettings(),
    targetLocations: ['Berlin'],
    workModes: ['remote'],
    employmentTypes: ['full-time'],
    ...patch,
  });
}
