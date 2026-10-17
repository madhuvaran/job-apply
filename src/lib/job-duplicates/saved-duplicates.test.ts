/**
 * Saved-vs-saved duplicate indications (Prompt 30).
 *
 * The dashboard and the priority shortlist must not present the same saved
 * vacancy as two independent opportunities without saying so. This module reuses
 * the SAME three documented rules the save-flow detector uses (canonical URL →
 * external identifier scoped to its source domain → normalized company+title),
 * but compares the saved list with itself. Everything here is synthetic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { findDuplicateJob, findSavedJobDuplicates, type SavedDuplicatesOutcome } from './duplicates';

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

/** Deterministic, order-free projection of an outcome for comparisons. */
function serialize(outcome: SavedDuplicatesOutcome): unknown {
  if (outcome.kind !== 'valid') return outcome;
  return {
    inspectedJobs: outcome.inspectedJobs,
    skippedJobs: outcome.skippedJobs,
    entries: [...outcome.byJobId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

function entries(outcome: SavedDuplicatesOutcome): [string, { status: string; method: string | null; equivalentJobIds: string[] }][] {
  if (outcome.kind !== 'valid') throw new Error('expected a valid outcome');
  return [...outcome.byJobId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('findSavedJobDuplicates — canonical URL', () => {
  it('reports both records when the canonical URL is identical', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' }),
        job({ id: 'job-b', originalUrl: 'https://www.example.com/jobs/1#apply' }),
      ],
    });
    expect(entries(outcome)).toEqual([
      ['job-a', { status: 'confirmed', method: 'canonical-url', equivalentJobIds: ['job-b'] }],
      ['job-b', { status: 'confirmed', method: 'canonical-url', equivalentJobIds: ['job-a'] }],
    ]);
  });

  it('keeps the path and query string significant (different vacancies never merge)', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1?team=core' }),
        job({ id: 'job-b', originalUrl: 'https://example.com/jobs/1?team=platform' }),
      ],
    });
    // Different query parameters → the weak company+title rule may still fire,
    // but never the trustworthy URL rule.
    for (const [, entry] of entries(outcome)) {
      expect(entry.method).not.toBe('canonical-url');
    }
  });

  it('marks several records sharing one URL as ambiguous and sorts their ids', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-c', title: 'Role C', originalUrl: 'https://example.com/jobs/9' }),
        job({ id: 'job-a', title: 'Role A', originalUrl: 'https://example.com/jobs/9' }),
        job({ id: 'job-b', title: 'Role B', originalUrl: 'https://example.com/jobs/9' }),
      ],
    });
    for (const [id, entry] of entries(outcome)) {
      expect(entry.status).toBe('ambiguous');
      expect(entry.method).toBe('canonical-url');
      expect(entry.equivalentJobIds).not.toContain(id);
      expect(entry.equivalentJobIds).toEqual([...entry.equivalentJobIds].sort());
    }
  });
});

describe('findSavedJobDuplicates — external identifier', () => {
  it('matches the same identifier only inside the same source domain', () => {
    const sameDomain = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', originalUrl: 'https://boards.example.com/a', externalId: 'REQ-1' }),
        job({ id: 'job-b', originalUrl: 'https://boards.example.com/b', externalId: 'REQ-1' }),
      ],
    });
    expect(entries(sameDomain).map(([, e]) => [e.status, e.method])).toEqual([
      ['confirmed', 'external-id'],
      ['confirmed', 'external-id'],
    ]);

    const otherDomain = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', originalUrl: 'https://boards.example.com/a', externalId: 'REQ-1' }),
        job({ id: 'job-b', originalUrl: 'https://jobs.example.org/b', externalId: 'REQ-1' }),
      ],
    });
    for (const [, entry] of entries(otherDomain)) expect(entry.method).not.toBe('external-id');
  });

  it('ignores an identifier when the record has no URL to scope it by', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', title: 'Role A', externalId: 'REQ-1' }),
        job({ id: 'job-b', title: 'Role B', externalId: 'REQ-1' }),
      ],
    });
    for (const [, entry] of entries(outcome)) expect(entry.method).not.toBe('external-id');
  });
});

describe('findSavedJobDuplicates — company + title (weak, review-only)', () => {
  it('reports a possible duplicate for case/whitespace-only differences', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', company: 'Fake Co', title: 'Backend  Engineer' }),
        job({ id: 'job-b', company: ' fake co ', title: 'backend engineer' }),
      ],
    });
    expect(entries(outcome)).toEqual([
      ['job-a', { status: 'possible', method: 'company-title', equivalentJobIds: ['job-b'] }],
      ['job-b', { status: 'possible', method: 'company-title', equivalentJobIds: ['job-a'] }],
    ]);
  });

  it('never uses a one-character identity, a missing company or a different title', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', company: 'A', title: 'Engineer' }),
        job({ id: 'job-b', company: 'A', title: 'Engineer' }),
        // No company at all: the weak rule needs BOTH values.
        job({ id: 'job-c', company: undefined, title: 'Engineer' }),
        job({ id: 'job-d', company: undefined, title: 'Engineer' }),
        job({ id: 'job-e', company: 'Fake Co', title: 'Engineer' }),
        job({ id: 'job-f', company: 'Fake Co', title: 'Designer' }),
      ],
    });
    for (const [, entry] of entries(outcome)) expect(entry.status).toBe('none');
  });

  it('prefers the trustworthy URL rule over company+title', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' }),
        job({ id: 'job-b', originalUrl: 'https://example.com/jobs/1' }),
        job({ id: 'job-c', originalUrl: 'https://example.com/jobs/2' }),
      ],
    });
    const byId = new Map(entries(outcome));
    expect(byId.get('job-a')).toMatchObject({ status: 'confirmed', method: 'canonical-url' });
    // job-c shares company+title with both, but no URL → the weak rule applies.
    expect(byId.get('job-c')).toMatchObject({ status: 'possible', method: 'company-title' });
  });
});

describe('findSavedJobDuplicates — integrity and determinism', () => {
  it('skips malformed records instead of trusting them', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' }),
        { id: 'broken', title: 'No description', capturedAt: '2026-10-01T00:00:00.000Z' },
        job({ id: 'job-b', originalUrl: 'https://example.com/jobs/1' }),
      ],
    });
    expect(outcome.kind).toBe('valid');
    if (outcome.kind !== 'valid') return;
    expect(outcome.inspectedJobs).toBe(2);
    expect(outcome.skippedJobs).toBe(1);
    expect(outcome.byJobId.has('broken')).toBe(false);
  });

  it('returns `none` for every job when nothing is equivalent', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [job({ id: 'job-a', company: 'One Co' }), job({ id: 'job-b', company: 'Two Co' })],
    });
    expect(entries(outcome).map(([, e]) => e.status)).toEqual(['none', 'none']);
    for (const [, entry] of entries(outcome)) expect(entry.equivalentJobIds).toEqual([]);
  });

  it('is independent of input order and never mutates its input', () => {
    const jobs = [
      job({ id: 'job-b', originalUrl: 'https://example.com/jobs/1' }),
      job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' }),
      job({ id: 'job-c', company: 'Other Co' }),
    ];
    const before = JSON.parse(JSON.stringify(jobs)) as unknown[];
    const forward = findSavedJobDuplicates({ savedJobs: jobs });
    const backward = findSavedJobDuplicates({ savedJobs: [...jobs].reverse() });
    expect(serialize(backward)).toEqual(serialize(forward));
    expect(jobs).toEqual(before);
  });

  it('collapses a repeated id and stays order-independent', () => {
    const outcome = findSavedJobDuplicates({
      savedJobs: [
        job({ id: 'job-a', company: 'One Co' }),
        job({ id: 'job-a', company: 'One Co' }),
      ],
    });
    expect(entries(outcome)).toEqual([
      ['job-a', { status: 'none', method: null, equivalentJobIds: [] }],
    ]);
  });

  it('fails typed when the saved list is not a list', () => {
    const outcome = findSavedJobDuplicates({ savedJobs: null as unknown as unknown[] });
    expect(outcome).toEqual({ kind: 'invalid', issues: ['savedJobs: invalid_type'] });
  });

  it('agrees with the save-flow detector on a URL identity', () => {
    const saved = [job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' })];
    const lookup = findDuplicateJob({
      candidate: { title: 'Backend Engineer', originalUrl: 'https://WWW.example.com/jobs/1#top' },
      savedJobs: saved,
    });
    expect(lookup.kind).toBe('valid');
    if (lookup.kind !== 'valid') return;
    expect(lookup.result.status).toBe('confirmed');
    expect(lookup.result.jobId).toBe('job-a');
  });

  it('makes no network call and never links to storage, the AI layer or the clock', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    findSavedJobDuplicates({
      savedJobs: [job({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' })],
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    const source = readFileSync(new URL('./duplicates.ts', import.meta.url), 'utf8');
    const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
    for (const statement of imports) expect(statement).not.toMatch(/from '.*\/(storage|ai)['"]/);
    expect(source).not.toMatch(/Date\.now\(|new Date\(/);
    expect(source).not.toMatch(/chrome\.|browser\.|fetch\(/);
  });
});
