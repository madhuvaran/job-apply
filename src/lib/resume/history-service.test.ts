/**
 * Service tests for the tailored resume version history (Prompt 19).
 *
 * `browser.storage.local` is mocked in-memory with forced failure modes
 * (unavailable / quota) — mirroring src/lib/applications/service.test.ts.
 * Synthetic profile/job/resume fixtures only (never a real profile).
 *
 * Covers: absent/malformed/unavailable/failed-write results, corrupt history
 * preserved and never overwritten, immutable snapshots across later profile
 * and job edits, export from the SAVED snapshot, delete-one semantics,
 * missing job references, the documented cap (refuse, never trim), no
 * sensitive fields, content-free messages and zero network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { profileSchema, type Profile } from '../profile';
import { STORAGE_KEYS } from '../storage';
import { tailorResume } from './tailor';
import type { TailoredResume } from './schemas';
import {
  createResumeHistoryEntry,
  emptyResumeHistoryRecord,
  MAX_RESUME_HISTORY_VERSIONS,
  upsertResumeHistoryEntry,
} from './history';
import {
  deleteResumeVersion,
  getResumeVersion,
  listResumeVersions,
  saveResumeVersion,
} from './history-service';
import { downloadResumeSnapshot } from './pdf/export';
import { baseResume, extractPdfText } from './pdf/test-support';

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
        const e = new Error('write failed');
        e.name = failure.errorName;
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

const job = jobPostingSchema.parse({
  id: 'job-1',
  title: 'Senior Backend Engineer',
  company: 'Acme Fake Co',
  rawDescription: 'We need TypeScript and Kubernetes experience.',
  requiredQualifications: ['TypeScript'],
  capturedAt: '2026-10-13T00:00:00.000Z',
});

const profile = profileSchema.parse({
  schemaVersion: '2',
  displayName: 'Alex Example',
  summary: 'Backend engineer focused on reliable APIs.',
  skills: [
    { id: 'sk-1', name: 'TypeScript' },
    { id: 'sk-2', name: 'Kubernetes' },
  ],
});

function tailor(p: Profile = profile, j: JobPosting = job): TailoredResume {
  const result = tailorResume(p, j);
  if (result.kind !== 'ok') throw new Error('fixture profile is not tailorable');
  return result.resume;
}

const resume = tailor();
const deps = { now: () => '2026-10-13T09:00:00.000Z', id: () => 'rv-1' };

function storedHistory(): { schemaVersion: string; versions: unknown[] } | undefined {
  const raw = h.backing.get(STORAGE_KEYS.resumeHistory);
  return raw === undefined ? undefined : (raw as { schemaVersion: string; versions: unknown[] });
}

beforeEach(() => {
  h.backing.clear();
  h.failure.get = false;
  h.failure.set = false;
  h.failure.errorName = 'StorageUnavailableError';
});

describe('listResumeVersions / getResumeVersion', () => {
  it('returns an empty list when nothing is stored (absent is not an error)', async () => {
    expect(await listResumeVersions()).toEqual({ ok: true, data: [] });
    const missing = await getResumeVersion('rv-1');
    expect(missing).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('round-trips saved versions, newest first, with snapshots intact', async () => {
    const first = await saveResumeVersion({ resume, job }, deps);
    expect(first).toMatchObject({ ok: true, data: { id: 'rv-1' } });

    const second = await saveResumeVersion(
      { resume, job },
      { now: () => '2026-10-14T09:00:00.000Z', id: () => 'rv-2' },
    );
    expect(second.ok).toBe(true);

    const list = await listResumeVersions();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.map((v) => v.id)).toEqual(['rv-2', 'rv-1']);
    expect(list.data[1]!.snapshot).toEqual(resume);
    expect(list.data[0]!.jobTitle).toBe('Senior Backend Engineer');
    expect(list.data[0]!.company).toBe('Acme Fake Co');

    const fetched = await getResumeVersion('rv-1');
    expect(fetched.ok).toBe(true);
    if (fetched.ok) expect(fetched.data.snapshot).toEqual(resume);

    expect(await getResumeVersion('nope')).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('writes only the dedicated history key (never profile/jobs/applications)', async () => {
    h.backing.set(STORAGE_KEYS.profile, profile);
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: [job] });
    h.backing.set(STORAGE_KEYS.applications, { schemaVersion: '1', applications: [] });

    expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);

    expect(h.backing.get(STORAGE_KEYS.profile)).toEqual(profile);
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toEqual({ schemaVersion: '1', postings: [job] });
    // Saving a version never creates or changes an application (and its status).
    expect(h.backing.get(STORAGE_KEYS.applications)).toEqual({
      schemaVersion: '1',
      applications: [],
    });
    expect(h.backing.has(STORAGE_KEYS.resumeHistory)).toBe(true);
    expect(h.backing.has(STORAGE_KEYS.sensitive)).toBe(false);
  });

  it('works without any saved jobs (history never depends on the job store)', async () => {
    expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);
    const list = await listResumeVersions();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data).toHaveLength(1);
  });
});

describe('typed storage failures', () => {
  it('surfaces malformed history with recoverable raw and never overwrites it', async () => {
    const corrupt = { schemaVersion: '1', versions: [{ id: 'x', secret: 'SECRET-VALUE' }] };
    h.backing.set(STORAGE_KEYS.resumeHistory, corrupt);

    const list = await listResumeVersions();
    expect(list).toMatchObject({ ok: false, reason: 'malformed' });
    if (!list.ok) {
      expect(list.raw).toEqual(corrupt);
      expect(list.message).not.toMatch(/SECRET/);
    }

    const saved = await saveResumeVersion({ resume, job }, deps);
    expect(saved).toMatchObject({ ok: false, reason: 'malformed' });
    if (!saved.ok) expect(saved.raw).toEqual(corrupt);

    const deleted = await deleteResumeVersion('rv-1');
    expect(deleted).toMatchObject({ ok: false, reason: 'malformed' });
    const fetched = await getResumeVersion('rv-1');
    expect(fetched).toMatchObject({ ok: false, reason: 'malformed' });

    // Nothing was silently overwritten — corrupt data is still there.
    expect(h.backing.get(STORAGE_KEYS.resumeHistory)).toEqual(corrupt);
  });

  it('surfaces unavailable storage on read and on write', async () => {
    h.failure.get = true;
    expect(await listResumeVersions()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await saveResumeVersion({ resume, job }, deps)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(h.backing.size).toBe(0);

    h.failure.get = false;
    h.failure.set = true;
    h.failure.errorName = 'StorageUnavailableError';
    expect(await saveResumeVersion({ resume, job }, deps)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(h.backing.size).toBe(0);
  });

  it('a failed write (quota) never damages the existing versions', async () => {
    expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);
    const before = storedHistory();

    h.failure.set = true;
    h.failure.errorName = 'QuotaExceededError';
    const second = await saveResumeVersion(
      { resume, job },
      { now: () => '2026-10-14T09:00:00.000Z', id: () => 'rv-2' },
    );
    expect(second).toMatchObject({ ok: false, reason: 'quota' });
    expect(storedHistory()).toEqual(before);
  });
});

describe('save rules', () => {
  it('rejects a schema-invalid resume without writing', async () => {
    const bad = { ...resume, apiKey: 'sk-never', contactEmail: 'secret@example.com' } as unknown as TailoredResume;
    const outcome = await saveResumeVersion({ resume: bad, job }, deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
    if (!outcome.ok) {
      expect((outcome.issues ?? []).join(' ')).not.toMatch(/secret@example\.com|sk-never/);
      expect(outcome.message).not.toMatch(/secret@example\.com|sk-never/);
    }
    expect(h.backing.has(STORAGE_KEYS.resumeHistory)).toBe(false);
  });

  it('rejects a job that does not match the resume provenance', async () => {
    const outcome = await saveResumeVersion(
      { resume, job: { id: 'job-other', title: 'Wrong Job', company: undefined } },
      deps,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
    expect(h.backing.has(STORAGE_KEYS.resumeHistory)).toBe(false);
  });

  it('refuses new saves at the documented cap instead of deleting older versions', async () => {
    let record = emptyResumeHistoryRecord();
    for (let i = 0; i < MAX_RESUME_HISTORY_VERSIONS; i++) {
      record = upsertResumeHistoryEntry(
        record,
        createResumeHistoryEntry(baseResume(), job, {
          now: () => '2026-10-01T00:00:00.000Z',
          id: () => `old-${i}`,
        }),
      );
    }
    h.backing.set(STORAGE_KEYS.resumeHistory, record);
    const before = storedHistory();

    const outcome = await saveResumeVersion({ resume, job }, deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'limit-reached' });
    if (!outcome.ok) expect(outcome.message).toContain('Nothing was deleted');
    expect(storedHistory()).toEqual(before);
  });
});

describe('immutable historical snapshots', () => {
  it('editing the master profile or the job never changes a saved version', async () => {
    expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);

    const editedProfile = profileSchema.parse({
      schemaVersion: '2',
      displayName: 'Alex Example',
      summary: 'Completely different career narrative after an edit.',
      skills: [{ id: 'sk-1', name: 'TypeScript' }],
    });
    const editedJob = jobPostingSchema.parse({ ...job, title: 'Renamed Role' });
    h.backing.set(STORAGE_KEYS.profile, editedProfile);
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: [editedJob] });

    // Regenerating now would produce different content…
    const regenerated = tailor(editedProfile, editedJob);
    expect(regenerated).not.toEqual(resume);

    // …but the stored snapshot is byte-for-byte the original payload.
    const fetched = await getResumeVersion('rv-1');
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data.snapshot).toEqual(resume);
    expect(fetched.data.snapshot.summary?.text).toBe('Backend engineer focused on reliable APIs.');
    expect(fetched.data.snapshot.source.jobTitle).toBe('Senior Backend Engineer');
    // Labels stay as they were saved (nothing re-read or invented).
    expect(fetched.data.jobTitle).toBe('Senior Backend Engineer');
    expect(fetched.data.company).toBe('Acme Fake Co');
  });

  it('exporting a historical version renders the saved snapshot, not a re-tailored resume', async () => {
    expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);

    const editedProfile = profileSchema.parse({
      schemaVersion: '2',
      displayName: 'Alex Example',
      summary: 'Completely different career narrative after an edit.',
      skills: [{ id: 'sk-1', name: 'TypeScript' }],
    });
    h.backing.set(STORAGE_KEYS.profile, editedProfile);

    const fetched = await getResumeVersion('rv-1');
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeSnapshot(fetched.data.snapshot, { download });
    expect(outcome.ok).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);

    const blob = download.mock.calls[0]![0];
    const text = await extractPdfText(blob);
    expect(text).toContain('Backend engineer focused on reliable APIs.');
    expect(text).not.toContain('Completely different career narrative');
  });
});

describe('deleteResumeVersion', () => {
  async function seedThree(): Promise<void> {
    const ids = ['rv-1', 'rv-2', 'rv-3'];
    for (const [i, id] of ids.entries()) {
      const outcome = await saveResumeVersion({ resume, job }, {
        now: () => `2026-10-1${i + 1}T09:00:00.000Z`,
        id: () => id,
      });
      expect(outcome.ok).toBe(true);
    }
  }

  it('deletes only the explicitly selected version', async () => {
    await seedThree();
    const before = storedHistory();

    const outcome = await deleteResumeVersion('rv-2');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.map((v) => v.id)).toEqual(['rv-3', 'rv-1']);
    // The remaining snapshots are untouched.
    expect(outcome.data.every((v) => v.snapshot)).toBe(true);
    expect(storedHistory()!.versions).toHaveLength(2);
    expect(before!.versions).toHaveLength(3);

    // Deleting the same id again is a typed not-found (no further writes).
    expect(await deleteResumeVersion('rv-2')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(storedHistory()!.versions).toHaveLength(2);

    // Other storage keys are never touched.
    expect(h.backing.has(STORAGE_KEYS.profile)).toBe(false);
    expect(h.backing.has(STORAGE_KEYS.applications)).toBe(false);
  });

  it('keeps history intact when the referenced saved job is gone', async () => {
    expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);
    // The user deletes the posting afterwards…
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: [] });

    const list = await listResumeVersions();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data).toHaveLength(1);
    // Reference + labels are preserved exactly (no invented or stripped data).
    expect(list.data[0]!.jobId).toBe('job-1');
    expect(list.data[0]!.jobTitle).toBe('Senior Backend Engineer');
    expect(list.data[0]!.company).toBe('Acme Fake Co');
    expect(list.data[0]!.snapshot).toEqual(resume);

    // And the version can still be exported and deleted.
    const download = vi.fn(() => ({ ok: true as const }));
    expect((await downloadResumeSnapshot(list.data[0]!.snapshot, { download })).ok).toBe(true);
    expect((await deleteResumeVersion('rv-1')).ok).toBe(true);
    expect((await listResumeVersions()).ok).toBe(true);
    expect(storedHistory()!.versions).toHaveLength(0);
  });
});

describe('privacy boundaries', () => {
  it('makes no network calls across save/list/get/delete', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      expect((await saveResumeVersion({ resume, job }, deps)).ok).toBe(true);
      await listResumeVersions();
      await getResumeVersion('rv-1');
      await deleteResumeVersion('rv-1');
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the history modules import no sensitive store, AI layer, fetch or direct storage', () => {
    for (const file of ['history.ts', 'history-service.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from '\.\.\/sensitive'/);
      expect(source).not.toMatch(/sensitiveProfileSchema/);
      expect(source).not.toMatch(/runAiRequest/);
      expect(source).not.toMatch(/fetch\(/);
      // Persistence must go through the storage service, never the raw API.
      expect(source).not.toMatch(/from 'wxt\/browser'/);
      expect(source).not.toMatch(/chrome\.storage/);
    }
  });
});
