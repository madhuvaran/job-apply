/**
 * UI tests for the priority shortlist (entrypoints/options/PriorityList.tsx)
 * and for the Options → Jobs integration (Prompt 24).
 *
 * Rendered with `react-dom/server` (no new dependency, no incidental markup
 * assertions): tests target visible labels, the four category counts, separate
 * match/freshness/application signals, reasons, the safe "Open posting" link
 * and the fail-closed states. `wxt/browser` is mocked only so the module graph
 * resolves (no effect runs during server rendering).
 *
 * Fixtures are entirely fake — no personal data, no secrets, no real postings.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { applicationSchema } from '../applications/schemas';
import { matchResultSchema, type JobMatchResult } from '../matching/schemas';
import { prioritizeJobs, type PrioritizationResult, type PriorityCategory } from '.';

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  },
}));

import PriorityList from '../../../entrypoints/options/PriorityList';
import JobsPanel from '../../../entrypoints/options/JobsPanel';

const TODAY = '2026-10-10';

function makeJob(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-a',
    title: 'Backend Engineer',
    company: 'Fake Co',
    rawDescription: 'Fake raw description.',
    source: 'manual',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  });
}

function scoreResult(patch: Record<string, unknown> = {}): JobMatchResult {
  return matchResultSchema.parse({
    schemaVersion: '1',
    estimate: {
      outcome: 'score',
      score: 82,
      factors: [],
      availableWeight: 100,
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
    threshold: { configured: 60, filtering: true, meets: true, decision: 'pass' },
    summary: 'Fake summary.',
    ...patch,
  });
}

const insuffitientResult = matchResultSchema.parse({
  schemaVersion: '1',
  estimate: {
    outcome: 'insufficient-data',
    reason: 'Not enough comparable data to score this posting.',
    factors: [],
    availableWeight: 20,
    explanation: 'Fake estimate explanation.',
  },
  requirements: [],
  hardIssues: [],
  confidence: {
    level: 'low',
    completeness: 20,
    counts: { total: 5, assessed: 1, matched: 1, partial: 0, missing: 0, unknown: 4 },
    explanation: 'Fake confidence explanation.',
  },
  threshold: { configured: 60, filtering: true, meets: false, decision: 'insufficient-data' },
  summary: 'Fake summary.',
});

/** The same inputs the panel assembles: saved jobs + match results + log. */
function buildResult(): PrioritizationResult {
  const outcome = prioritizeJobs({
    today: TODAY,
    minMatchThreshold: 60,
    jobs: [
      makeJob({ id: 'job-fresh', title: 'Fresh Role', originalUrl: 'https://example.com/jobs/1', postedDate: TODAY }),
      makeJob({ id: 'job-stale', title: 'Stale Role', postedDate: '2026-08-01' }),
      makeJob({ id: 'job-unknown', title: 'Undated Role' }),
      makeJob({ id: 'job-applied', title: 'Applied Role', postedDate: TODAY }),
    ],
    matches: [
      { jobId: 'job-fresh', result: scoreResult() },
      { jobId: 'job-stale', result: scoreResult({ estimate: { outcome: 'score', score: 75, factors: [], availableWeight: 100, explanation: 'x' } }) },
      { jobId: 'job-unknown', result: insuffitientResult },
      { jobId: 'job-applied', result: scoreResult() },
    ],
    applications: [
      applicationSchema.parse({
        id: 'app-1',
        jobId: 'job-applied',
        status: 'interview',
        applicationDate: '2026-10-09',
        createdAt: '2026-10-09T00:00:00.000Z',
        updatedAt: '2026-10-09T00:00:00.000Z',
      }),
    ],
  });
  if (outcome.kind !== 'valid') throw new Error(outcome.issues.join('; '));
  return outcome.result;
}

function render(
  result: PrioritizationResult,
  selected: PriorityCategory = 'apply-first',
  extraNotes: string[] = [],
): string {
  return renderToStaticMarkup(
    createElement(PriorityList, { result, selected, onSelect: () => {}, extraNotes }),
  );
}

describe('PriorityList', () => {
  it('shows the four categories with counts', () => {
    const html = render(buildResult());
    expect(html).toContain('Priority shortlist');
    expect(html).toContain('Apply first (1)');
    expect(html).toContain('Good match (1)');
    expect(html).toContain('Needs review (1)');
    expect(html).toContain('Already applied (1)');
    expect(html).toContain('Freshness window: 7 calendar days');
  });

  it('states that it cannot know availability, applicant counts or chances', () => {
    const html = render(buildResult());
    expect(html).toContain('does not know whether a posting is still open');
    expect(html).toContain('how many people applied');
    expect(html).not.toContain('priority score');
    expect(html).not.toMatch(/probability of (success|getting hired)/i);
  });

  it('marks the inspected category and lists only its jobs', () => {
    const html = render(buildResult(), 'apply-first');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Fresh Role');
    expect(html).not.toContain('Stale Role');

    const older = render(buildResult(), 'good-match');
    expect(older).toContain('Stale Role');
    expect(older).not.toContain('Undated Role'); // that job is needs-review, not a good match
    expect(older).not.toContain('Fresh Role');

    const insufficient = render(buildResult(), 'needs-review');
    expect(insufficient).toContain('Undated Role');
    expect(insufficient).not.toContain('Stale Role');
  });

  it('shows match, freshness and application as separate labelled signals', () => {
    const html = render(buildResult(), 'already-applied');
    expect(html).toContain('data-field="match"');
    expect(html).toContain('data-field="freshness"');
    expect(html).toContain('data-field="application"');
    expect(html).toContain('82 / 100 estimate');
    expect(html).toContain(`Posted today (${TODAY})`);
    expect(html).toContain('Interview');
  });

  it('shows insufficient-data and unknown-date labels instead of a score', () => {
    const html = render(buildResult(), 'needs-review');
    expect(html).toContain('Insufficient data — no score');
    expect(html).toContain('Posting date unknown');
    expect(html).not.toMatch(/\d+ \/ 100 estimate/);
  });

  it('renders the reasons explaining each classification', () => {
    const html = render(buildResult(), 'good-match');
    expect(html).toContain('data-field="reasons"');
    expect(html).toContain('meets your minimum of 60');
    expect(html).toContain('outside the 7-day freshness window');
  });

  it('opens the original posting only through a safe link', () => {
    const html = render(buildResult(), 'apply-first');
    expect(html).toContain('href="https://example.com/jobs/1"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
    // A job without a saved URL renders no link at all.
    expect(render(buildResult(), 'good-match')).not.toContain('Open posting');
  });

  it('surfaces module notes and panel-supplied fail-closed explanations', () => {
    const html = render(buildResult(), 'apply-first', ['No usable master profile is loaded.']);
    expect(html).toContain('data-field="notes"');
    expect(html).toContain('No usable master profile is loaded.');

    // Module notes reach the UI too (here: an unconfigured minimum and an
    // unreadable application log).
    const failClosed = prioritizeJobs({
      today: TODAY,
      jobs: [makeJob({ id: 'job-a' })],
      matches: [],
      applications: null,
      minMatchThreshold: 0,
    });
    if (failClosed.kind !== 'valid') throw new Error(failClosed.issues.join('; '));
    const notesHtml = render(failClosed.result, 'needs-review');
    expect(notesHtml).toContain('minimum 0 disables threshold filtering');
    expect(notesHtml).toContain('application log could not be read');
    expect(notesHtml).toContain('Application status unknown');
    expect(notesHtml).toContain('No match estimate available');
  });

  it('explains an empty category and an empty saved-jobs list', () => {
    const empty = prioritizeJobs({ today: TODAY, jobs: [], applications: [], minMatchThreshold: 60 });
    if (empty.kind !== 'valid') throw new Error(empty.issues.join('; '));
    const html = render(empty.result, 'apply-first');
    expect(html).toContain('No saved jobs to prioritize yet');
    expect(html).not.toContain('data-field="reasons"');

    // A category with no jobs still renders with count 0 and its own empty state.
    const noneApplied = prioritizeJobs({
      today: TODAY,
      jobs: [makeJob({ id: 'job-x', postedDate: TODAY })],
      matches: [{ jobId: 'job-x', result: scoreResult() }],
      applications: [],
      minMatchThreshold: 60,
    });
    if (noneApplied.kind !== 'valid') throw new Error(noneApplied.issues.join('; '));
    const noneHtml = render(noneApplied.result, 'already-applied');
    expect(noneHtml).toContain('Already applied (0)');
    expect(noneHtml).toContain('No saved jobs in this category.');
  });

  it('renders the already-applied precedence for a linked submitted application', () => {
    const html = render(buildResult(), 'already-applied');
    expect(html).toContain('Applied Role');
    expect(html).toContain('already applied or in progress');
  });
});

describe('Options → Jobs regression', () => {
  it('still renders the existing sections plus the priority shortlist', () => {
    const html = renderToStaticMarkup(createElement(JobsPanel));
    expect(html).toContain('Saved jobs');
    expect(html).toContain('Priority shortlist');
    expect(html).toContain('Add job manually');
    expect(html).toContain('Loading jobs…');
    expect(html).toContain('Loading prioritization inputs…');
    // The match summary is never rendered without a selection.
    expect(html).not.toContain('Match estimate');
    expect(html).not.toContain('Resume PDF');
  });
});
