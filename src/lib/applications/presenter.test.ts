/**
 * Presenter tests (Prompt 13): row building, orphan handling, deterministic
 * filtering and sorting. Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { createJobPosting, type JobPosting } from '../job-posting';
import { createApplication, type Application } from './schemas';
import {
  ORPHANED_JOB_LABEL,
  buildApplicationRows,
  selectApplicationRows,
} from './presenter';

const jobA = createJobPosting({
  id: 'job-a',
  title: 'Backend Engineer',
  company: 'Acme Fake Co',
  originalUrl: 'https://example.com/jobs/a',
  rawDescription: 'x',
  capturedAt: '2026-10-01T00:00:00.000Z',
});
const jobB = createJobPosting({
  id: 'job-b',
  title: 'Data Engineer',
  rawDescription: 'y',
  capturedAt: '2026-10-02T00:00:00.000Z',
});
const postings: JobPosting[] = [jobA, jobB];

function app(
  id: string,
  jobId: string,
  extra: Partial<Parameters<typeof createApplication>[0]> = {},
  patch: { createdAt?: string; updatedAt?: string } = {},
): Application {
  const base = createApplication({ jobId, ...extra }, { now: () => '2026-10-10T00:00:00.000Z', id: () => id });
  return { ...base, createdAt: patch.createdAt ?? base.createdAt, updatedAt: patch.updatedAt ?? base.updatedAt };
}

describe('buildApplicationRows', () => {
  it('resolves title, employer and URL from the saved job', () => {
    const [row] = buildApplicationRows([app('a1', 'job-a')], postings);
    expect(row?.jobTitle).toBe('Backend Engineer');
    expect(row?.employer).toBe('Acme Fake Co');
    expect(row?.jobUrl).toBe('https://example.com/jobs/a');
    expect(row?.orphaned).toBe(false);
    expect(row?.statusLabel).toBe('Planned');
    expect(row?.updatedAtLabel).toMatch(/^Updated \d{4}-\d{2}-\d{2}$/);
  });

  it('flags an orphaned reference without inventing a title', () => {
    const [row] = buildApplicationRows([app('a2', 'job-gone')], postings);
    expect(row?.orphaned).toBe(true);
    expect(row?.jobTitle).toBeNull();
    expect(row?.jobUrl).toBeNull();
    expect(ORPHANED_JOB_LABEL).not.toBe('');
  });
});

describe('selectApplicationRows', () => {
  const list = [
    app('a-planned', 'job-a', { status: 'planned' }, { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }),
    app('a-interview', 'job-b', { status: 'interview', applicationDate: '2026-10-03' }, { createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' }),
    app('a-offer', 'job-gone', { status: 'offer', applicationDate: '2026-09-01' }, { createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' }),
  ];

  it('filters by status and passes everything through for "all"', () => {
    expect(selectApplicationRows(list, postings, { status: 'all' })).toHaveLength(3);
    expect(selectApplicationRows(list, postings, { status: 'interview' }).map((r) => r.id)).toEqual([
      'a-interview',
    ]);
    expect(selectApplicationRows(list, postings, { status: 'rejected' })).toEqual([]);
  });

  it('sorts by last updated (default) descending', () => {
    expect(selectApplicationRows(list, postings).map((r) => r.id)).toEqual([
      'a-interview',
      'a-offer',
      'a-planned',
    ]);
  });

  it('sorts by application date descending with missing dates last', () => {
    expect(selectApplicationRows(list, postings, { sort: 'applicationDate' }).map((r) => r.id)).toEqual([
      'a-interview',
      'a-offer',
      'a-planned',
    ]);
  });

  it('sorts by created descending and breaks ties by id ascending (deterministic)', () => {
    const tied = [
      app('b', 'job-a', {}, { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }),
      app('a', 'job-a', {}, { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }),
      app('c', 'job-b', {}, { createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }),
    ];
    expect(selectApplicationRows(tied, postings, { sort: 'created' }).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('is order-independent for identical input (deterministic)', () => {
    const reversed = [...list].reverse();
    const forward = selectApplicationRows(list, postings, { sort: 'updated' }).map((r) => r.id);
    const backward = selectApplicationRows(reversed, postings, { sort: 'updated' }).map((r) => r.id);
    expect(backward).toEqual(forward);
  });
});
