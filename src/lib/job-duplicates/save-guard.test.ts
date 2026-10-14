/**
 * Tests for the pre-write duplicate gate (Prompt 26.1).
 *
 * `guardJobSave()` is what both save entry points run immediately before the
 * write. These tests use controlled storage mutations (no timers, no delays) to
 * prove:
 * - the gate re-reads PERSISTED postings, so a posting added after an earlier
 *   check is still caught before the write;
 * - the record being edited can be excluded (never a duplicate of itself);
 * - the explicit override proceeds for one attempt and touches nothing;
 * - malformed/unavailable storage and invalid input block the write with a typed,
 *   fixed decision instead of pretending the list is empty;
 * - the guard itself never writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../storage';
import { guardJobSave } from '.';

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

const CANDIDATE = {
  title: 'Backend Engineer',
  company: 'Fake Co',
  originalUrl: 'https://example.com/jobs/1',
};

function savedJob(patch: Record<string, unknown> = {}) {
  return {
    id: 'job-saved',
    title: 'Backend Engineer',
    company: 'Fake Co',
    rawDescription: 'Fake raw description.',
    source: 'page-capture',
    capturedAt: '2026-10-01T00:00:00.000Z',
    originalUrl: 'https://example.com/jobs/1',
    ...patch,
  };
}

/** Write a valid postings record straight into the mocked storage. */
function persist(...postings: unknown[]): void {
  h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings });
}

function persistedCount(): number {
  const record = h.backing.get(STORAGE_KEYS.jobPostings) as { postings?: unknown[] } | undefined;
  return record?.postings?.length ?? 0;
}

beforeEach(() => {
  h.backing.clear();
  h.failure.getThrows = false;
  h.calls.set = 0;
  h.calls.remove = 0;
});

describe('guardJobSave', () => {
  it('proceeds when nothing saved matches, and never writes', async () => {
    persist();
    const decision = await guardJobSave({ candidate: CANDIDATE });
    expect(decision.kind).toBe('proceed');
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('proceeds on an absent saved list', async () => {
    const decision = await guardJobSave({ candidate: CANDIDATE });
    expect(decision.kind).toBe('proceed');
    expect(h.calls.set).toBe(0);
  });

  it('blocks the write when a matching posting appears AFTER an earlier check', async () => {
    // First check (e.g. when the preview was built): nothing saved yet.
    persist();
    expect((await guardJobSave({ candidate: CANDIDATE })).kind).toBe('proceed');

    // Another tab saves the same posting in the meantime.
    persist(savedJob());

    // The pre-write check re-reads persisted data and stops the write.
    const decision = await guardJobSave({ candidate: CANDIDATE });
    expect(decision.kind).toBe('blocked-duplicate');
    if (decision.kind === 'blocked-duplicate') {
      expect(decision.result.duplicate).toBe(true);
      expect(decision.result.status).toBe('confirmed');
      expect(decision.result.method).toBe('canonical-url');
      expect(decision.result.jobId).toBe('job-saved');
      expect(decision.result.matches[0]?.title).toBe('Backend Engineer');
    }
    expect(persistedCount()).toBe(1); // the guard wrote nothing
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('reports ambiguity rather than picking a winner', async () => {
    persist(savedJob({ id: 'job-b' }), savedJob({ id: 'job-a' }));
    const decision = await guardJobSave({ candidate: CANDIDATE });
    expect(decision.kind).toBe('blocked-duplicate');
    if (decision.kind === 'blocked-duplicate') {
      expect(decision.result.status).toBe('ambiguous');
      expect(decision.result.jobId).toBeNull();
      expect(decision.result.matches.map((m) => m.jobId)).toEqual(['job-a', 'job-b']);
    }
  });

  it('excludes only the excluded ids (an edit is never its own duplicate)', async () => {
    persist(savedJob({ id: 'job-edit' }));

    const asEdit = await guardJobSave({ candidate: CANDIDATE, excludeJobIds: ['job-edit'] });
    expect(asEdit.kind).toBe('proceed');

    // Without the exclusion the very same record would block the write.
    const withoutExclusion = await guardJobSave({ candidate: CANDIDATE });
    expect(withoutExclusion.kind).toBe('blocked-duplicate');

    // A DIFFERENT saved posting with the same URL is still a duplicate.
    persist(savedJob({ id: 'job-other' }));
    const other = await guardJobSave({ candidate: CANDIDATE, excludeJobIds: ['job-edit'] });
    expect(other.kind).toBe('blocked-duplicate');
  });

  it('honours an explicit override for exactly one attempt, writing nothing itself', async () => {
    persist(savedJob());

    const overridden = await guardJobSave({ candidate: CANDIDATE, override: true });
    expect(overridden.kind).toBe('proceed');

    // The override is per-attempt: the very next normal attempt is gated again,
    // so it can never become a durable bypass (and cannot loop the warning).
    const afterOverride = await guardJobSave({ candidate: CANDIDATE });
    expect(afterOverride.kind).toBe('blocked-duplicate');
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('fails safely on malformed storage instead of treating it as empty', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: 'not-a-list' });
    const decision = await guardJobSave({ candidate: CANDIDATE });
    expect(decision.kind).toBe('blocked-check-failed');
    if (decision.kind === 'blocked-check-failed') {
      expect(decision.reason).toBe('malformed');
      expect(decision.message.length).toBeGreaterThan(0);
    }
    // Even the explicit override must not let the caller corrupt that record:
    // the guard itself never writes, and the storage service still refuses.
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
  });

  it('fails safely when storage is unavailable (no throw)', async () => {
    h.failure.getThrows = true;
    const decision = await guardJobSave({ candidate: CANDIDATE });
    expect(decision.kind).toBe('blocked-check-failed');
    if (decision.kind === 'blocked-check-failed') expect(decision.reason).toBe('unavailable');
  });

  it('fails safely on an invalid candidate or invalid options, without quoting values', async () => {
    const badCandidate = await guardJobSave({ candidate: { title: 'CandidateOnlyTitle', extra: true } });
    expect(badCandidate.kind).toBe('blocked-check-failed');
    if (badCandidate.kind === 'blocked-check-failed') {
      expect(badCandidate.reason).toBe('invalid');
      expect(badCandidate.message).not.toContain('CandidateOnlyTitle');
      expect(badCandidate.message).toContain('identity fields');
    }

    persist(savedJob());
    for (const excludeJobIds of [[], ['']] as const) {
      // empty list is valid (nothing excluded); an empty ID is not
      const decision = await guardJobSave({ candidate: CANDIDATE, excludeJobIds });
      if (excludeJobIds.length === 0) expect(decision.kind).toBe('blocked-duplicate');
      else expect(decision.kind).toBe('blocked-check-failed');
    }
    const tooMany = Array.from({ length: 21 }, (_, i) => `job-${i}`);
    const bulk = await guardJobSave({ candidate: CANDIDATE, excludeJobIds: tooMany });
    expect(bulk.kind).toBe('blocked-check-failed');
  });

  it('is deterministic for identical inputs', async () => {
    persist(savedJob());
    expect(await guardJobSave({ candidate: CANDIDATE })).toEqual(
      await guardJobSave({ candidate: CANDIDATE }),
    );
  });
});
