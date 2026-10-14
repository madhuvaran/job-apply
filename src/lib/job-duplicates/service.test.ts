/**
 * Tests for the read-only duplicate-check service (Prompt 26).
 *
 * `browser.storage.local` is mocked in memory (same pattern as
 * `src/lib/storage.test.ts`). These tests prove the lookup:
 * - reports a confirmed match when the saved list contains the same posting,
 * - treats an absent list as reliably empty (not an error),
 * - surfaces malformed/unavailable storage as a typed failure instead of
 *   claiming "nothing saved" (fail closed),
 * - NEVER writes: a malformed record is reported and left byte-identical, and
 *   no `set`/`remove` call is ever made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../storage';
import { lookupDuplicateJob } from '.';

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  const failure = { getThrows: false };
  const calls = { set: 0, remove: 0 };
  const storageLocal = {
    get: async (keys: string | string[]) => {
      if (failure.getThrows) {
        const e = new Error('storage backend blew up');
        e.name = 'StorageUnavailableError';
        throw e;
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      calls.set += 1;
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      calls.remove += 1;
      for (const k of Array.isArray(keys) ? keys : [keys]) backing.delete(k);
    },
  };
  return { backing, failure, calls, storageLocal };
});

vi.mock('wxt/browser', () => ({
  browser: { storage: { local: h.storageLocal } },
}));

const SAVED_JOB = {
  id: 'job-saved',
  title: 'Backend Engineer',
  company: 'Fake Co',
  rawDescription: 'Fake raw description.',
  source: 'page-capture',
  capturedAt: '2026-10-01T00:00:00.000Z',
  originalUrl: 'https://example.com/jobs/1',
};

function store(record: unknown): void {
  h.backing.set(STORAGE_KEYS.jobPostings, record);
}

beforeEach(() => {
  h.backing.clear();
  h.failure.getThrows = false;
  h.calls.set = 0;
  h.calls.remove = 0;
});

describe('lookupDuplicateJob', () => {
  it('confirms a posting that is already saved (same canonical URL)', async () => {
    store({ schemaVersion: '1', postings: [SAVED_JOB] });
    const outcome = await lookupDuplicateJob({
      title: 'Backend Engineer',
      company: 'Fake Co',
      originalUrl: 'https://www.Example.com/jobs/1#apply',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.duplicate).toBe(true);
      expect(outcome.result.status).toBe('confirmed');
      expect(outcome.result.jobId).toBe('job-saved');
      expect(outcome.result.inspectedJobs).toBe(1);
    }
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('treats an absent saved list as reliably empty', async () => {
    const outcome = await lookupDuplicateJob({ title: 'Backend Engineer', company: 'Fake Co' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.duplicate).toBe(false);
      expect(outcome.result.reasonCode).toBe('no-reliable-match');
      expect(outcome.result.inspectedJobs).toBe(0);
    }
    expect(h.calls.set).toBe(0);
  });

  it('fails closed when the saved list is malformed, without touching it', async () => {
    const malformed = { schemaVersion: '1', postings: 'not-a-list' };
    store(malformed);
    const outcome = await lookupDuplicateJob({ title: 'Backend Engineer', originalUrl: 'https://example.com/jobs/1' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('malformed');
    // The stored value is unchanged and nothing was written.
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toBe(malformed);
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('fails closed (typed, no throw) when storage is unavailable', async () => {
    store({ schemaVersion: '1', postings: [SAVED_JOB] });
    h.failure.getThrows = true;
    const outcome = await lookupDuplicateJob({ title: 'Backend Engineer' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unavailable');
      expect(outcome.message.length).toBeGreaterThan(0);
    }
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('rejects an unusable candidate without reading or writing storage', async () => {
    store({ schemaVersion: '1', postings: [SAVED_JOB] });
    const outcome = await lookupDuplicateJob({ title: '' } as unknown as { title: string });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('invalid');
      expect(outcome.message).toContain('identity fields');
    }
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });
});
