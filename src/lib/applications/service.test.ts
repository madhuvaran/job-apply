/**
 * Service tests for the application log (Prompt 13).
 *
 * `browser.storage.local` is mocked in-memory with forced failure modes
 * (unavailable / quota) — mirroring src/lib/storage.test.ts. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobPosting, type JobPosting } from '../job-posting';
import { STORAGE_KEYS } from '../storage';
import {
  APPLICATION_STATUS_LABELS,
  applicationsRecordSchema,
  type Application,
} from './schemas';
import {
  createApplicationForJob,
  deleteApplication,
  listApplications,
  startTrackingApplication,
  updateApplication,
} from './service';

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  const failure = { get: false, set: false, errorName: 'StorageUnavailableError' };
  const storageLocal = {
    get: async (keys: string | string[]) => {
      if (failure.get) {
        const e = new Error('storage backend blew up');
        e.name = failure.errorName;
        throw e;
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      if (failure.set) {
        const e = new Error('write too large');
        e.name = 'QuotaExceededError';
        throw e;
      }
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      for (const k of wanted) backing.delete(k);
    },
  };
  return { backing, failure, storageLocal };
});

vi.mock('wxt/browser', () => ({ browser: { storage: { local: h.storageLocal } } }));

const JOB = createJobPosting({
  id: 'job-1',
  title: 'Backend Engineer',
  company: 'Acme Fake Co',
  rawDescription: 'We need TypeScript experience.',
  capturedAt: '2026-10-01T00:00:00.000Z',
});
const deps = { now: () => '2026-10-10T00:00:00.000Z', id: () => 'app-1' };

function seedJobs(postings: JobPosting[] = [JOB]): void {
  h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings });
}

function storedApplications(): Application[] {
  const raw = h.backing.get(STORAGE_KEYS.applications);
  if (raw === undefined) return [];
  const parsed = applicationsRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data.applications : [];
}

beforeEach(() => {
  h.backing.clear();
  h.failure.get = false;
  h.failure.set = false;
  h.failure.errorName = 'StorageUnavailableError';
});

describe('listApplications', () => {
  it('returns an empty list when nothing is stored (absent is not an error)', async () => {
    expect(await listApplications()).toEqual({ ok: true, data: [] });
  });

  it('surfaces malformed storage with recoverable raw, never inventing records', async () => {
    const corrupt = { schemaVersion: '1', applications: [{ id: 'x', notes: 'SECRET-NOTE' }] };
    h.backing.set(STORAGE_KEYS.applications, corrupt);
    const res = await listApplications();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('malformed');
    expect(res.raw).toEqual(corrupt);
    // Message carries key + issue count only — never the notes content.
    expect(res.message).not.toContain('SECRET-NOTE');
  });

  it('surfaces unavailable storage', async () => {
    h.failure.get = true;
    const res = await listApplications();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unavailable');
  });
});

describe('createApplicationForJob', () => {
  it('creates a validated application for a saved job and persists it', async () => {
    seedJobs();
    const res = await createApplicationForJob({ jobId: 'job-1' }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe('planned');
    expect(res.data.id).toBe('app-1');
    expect(res.data.createdAt).toBe('2026-10-10T00:00:00.000Z');
    expect(storedApplications()).toEqual([res.data]);
  });

  it('rejects a missing job reference and writes nothing', async () => {
    seedJobs();
    const res = await createApplicationForJob({ jobId: 'job-missing' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('job-missing');
    expect(h.backing.has(STORAGE_KEYS.applications)).toBe(false);
  });

  it('rejects a job reference when no jobs are stored at all', async () => {
    const res = await createApplicationForJob({ jobId: 'job-1' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('job-missing');
  });

  it('rejects invalid fields without writing', async () => {
    seedJobs();
    const res = await createApplicationForJob({ jobId: 'job-1', applicationDate: '2026-02-31' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('invalid');
      expect(res.issues?.join(' ')).toMatch(/applicationDate/);
    }
    expect(h.backing.has(STORAGE_KEYS.applications)).toBe(false);
  });

  it('never overwrites malformed stored data', async () => {
    seedJobs();
    const corrupt = { nonsense: true, notes: 'SECRET-NOTE' };
    h.backing.set(STORAGE_KEYS.applications, corrupt);
    const res = await createApplicationForJob({ jobId: 'job-1' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
    expect(h.backing.get(STORAGE_KEYS.applications)).toEqual(corrupt);
  });

  it('surfaces quota write failures without discarding existing records', async () => {
    seedJobs();
    h.backing.set(STORAGE_KEYS.applications, { schemaVersion: '1', applications: [] });
    h.failure.set = true;
    const res = await createApplicationForJob({ jobId: 'job-1' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('quota');
    // Existing (empty) record still present, not clobbered.
    expect(h.backing.get(STORAGE_KEYS.applications)).toEqual({ schemaVersion: '1', applications: [] });
  });

  it('surfaces unavailable storage when reading the log fails', async () => {
    seedJobs();
    h.failure.get = true;
    const res = await createApplicationForJob({ jobId: 'job-1' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unavailable');
  });

  it('allows a deliberate repeat application for the same job', async () => {
    seedJobs();
    await createApplicationForJob({ jobId: 'job-1' }, { now: deps.now, id: () => 'app-1' });
    await createApplicationForJob({ jobId: 'job-1' }, { now: deps.now, id: () => 'app-2' });
    expect(storedApplications().map((a) => a.id)).toEqual(['app-2', 'app-1']);
  });
});

describe('startTrackingApplication (one-click flow)', () => {
  it('creates a planned application the first time', async () => {
    seedJobs();
    const res = await startTrackingApplication('job-1', deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.alreadyTracked).toBe(false);
    expect(res.data.application.status).toBe('planned');
    expect(storedApplications()).toHaveLength(1);
  });

  it('reuses an existing application for the same job (no duplicate record)', async () => {
    seedJobs();
    await startTrackingApplication('job-1', { now: deps.now, id: () => 'app-1' });
    const again = await startTrackingApplication('job-1', { now: deps.now, id: () => 'app-2' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.alreadyTracked).toBe(true);
    expect(again.data.application.id).toBe('app-1');
    expect(storedApplications()).toHaveLength(1);
  });
});

describe('updateApplication', () => {
  it('persists a status change and a notes edit, bumping updatedAt', async () => {
    seedJobs();
    const created = await createApplicationForJob({ jobId: 'job-1' }, deps);
    if (!created.ok) throw new Error('setup failed');

    const statusRes = await updateApplication(
      created.data.id,
      { status: 'interview' },
      { now: () => '2026-10-20T00:00:00.000Z' },
    );
    expect(statusRes.ok).toBe(true);
    if (!statusRes.ok) return;
    expect(statusRes.data.status).toBe('interview');
    expect(APPLICATION_STATUS_LABELS[statusRes.data.status]).toBe('Interview');
    expect(statusRes.data.createdAt).toBe(created.data.createdAt);
    expect(statusRes.data.updatedAt).toBe('2026-10-20T00:00:00.000Z');

    const notesRes = await updateApplication(created.data.id, { notes: 'Recruiter call booked.' });
    expect(notesRes.ok).toBe(true);
    if (!notesRes.ok) return;
    expect(notesRes.data.notes).toBe('Recruiter call booked.');
    expect(storedApplications()[0]?.notes).toBe('Recruiter call booked.');
  });

  it('rejects an invalid patch and an unknown id', async () => {
    seedJobs();
    await createApplicationForJob({ jobId: 'job-1' }, deps);
    const bad = await updateApplication('app-1', { applicationDate: '2026-02-31' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid');
    const missing = await updateApplication('nope', { status: 'applied' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('not-found');
  });

  it('does not overwrite malformed stored data', async () => {
    const corrupt = { nonsense: true };
    h.backing.set(STORAGE_KEYS.applications, corrupt);
    const res = await updateApplication('anything', { status: 'applied' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
    expect(h.backing.get(STORAGE_KEYS.applications)).toEqual(corrupt);
  });
});

describe('deleteApplication', () => {
  it('deletes one record and keeps the rest', async () => {
    seedJobs();
    await createApplicationForJob({ jobId: 'job-1' }, { now: deps.now, id: () => 'app-1' });
    await createApplicationForJob({ jobId: 'job-1' }, { now: deps.now, id: () => 'app-2' });
    const res = await deleteApplication('app-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((a) => a.id)).toEqual(['app-2']);
    expect(storedApplications().map((a) => a.id)).toEqual(['app-2']);
  });

  it('reports not-found and does not overwrite malformed data', async () => {
    seedJobs();
    const missing = await deleteApplication('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('not-found');

    const corrupt = { nonsense: true };
    h.backing.set(STORAGE_KEYS.applications, corrupt);
    const blocked = await deleteApplication('app-1');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('malformed');
    expect(h.backing.get(STORAGE_KEYS.applications)).toEqual(corrupt);
  });
});

describe('orphaned job references are non-destructive', () => {
  it('keeps application history when the referenced job is deleted', async () => {
    seedJobs();
    const created = await createApplicationForJob({ jobId: 'job-1' }, deps);
    if (!created.ok) throw new Error('setup failed');
    // The user deletes the job posting afterwards.
    seedJobs([]);
    const list = await listApplications();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.map((a) => a.id)).toEqual(['app-1']);
    // History remains editable and deletable.
    expect((await updateApplication('app-1', { status: 'offer' })).ok).toBe(true);
    expect((await deleteApplication('app-1')).ok).toBe(true);
  });
});

describe('privacy & offline boundaries', () => {
  it('error messages never include notes or job content', async () => {
    seedJobs();
    const secret = 'SECRET-NOTE-DO-NOT-LEAK';
    const corrupt = { applications: [{ id: 'x', notes: secret }] };
    h.backing.set(STORAGE_KEYS.applications, corrupt);
    const res = await listApplications();
    if (!res.ok) {
      expect(res.message).not.toContain(secret);
      expect(res.message).not.toContain('Backend Engineer');
    }
    const jobs = await (await import('../storage')).loadJobPostings();
    if (jobs.ok) expect(jobs.data.postings[0]?.title).toBe('Backend Engineer');
  });

  it('makes zero network calls across the whole read/mutate surface', async () => {
    seedJobs();
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      await listApplications();
      await createApplicationForJob({ jobId: 'job-1' }, deps);
      await startTrackingApplication('job-1', deps);
      await updateApplication('app-1', { status: 'applied' });
      await deleteApplication('app-1');
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('source boundaries', () => {
  it('imports no sensitive store, AI layer, fetch or direct chrome.storage', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'src', 'lib', 'applications');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
      // Strip comments so prose ABOUT the rule cannot trip the scan.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(sources).not.toMatch(/from ['"].*sensitive['"]/);
    expect(sources).not.toMatch(/loadSensitiveProfile/);
    expect(sources).not.toMatch(/runAiRequest|from ['"].*\/ai['"]/);
    expect(sources).not.toMatch(/fetch\s*\(/);
    // Persistence goes through the storage abstraction, never chrome/browser.storage directly.
    expect(sources).not.toMatch(/chrome\.storage|browser\.storage/);
  });
});
