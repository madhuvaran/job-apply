/**
 * Schema + pure-helper tests for the tailored resume version history
 * (Prompt 19). Synthetic fixtures only (never a real profile).
 *
 * Covers: valid record round trips, STRICT rejection of unknown/malformed
 * fields (credentials, sensitive fields, page content), label provenance
 * (nothing invented), snapshot immutability at save time, list helpers
 * (append / delete-one / cap), and value-free validation issues.
 */
import { describe, expect, it } from 'vitest';
import { baseResume } from './pdf/test-support';
import {
  createResumeHistoryEntry,
  emptyResumeHistoryRecord,
  findResumeHistoryEntry,
  formatResumeHistoryIssues,
  isResumeHistoryFull,
  MAX_RESUME_HISTORY_VERSIONS,
  removeResumeHistoryEntry,
  RESUME_HISTORY_STATUS_LABELS,
  resumeHistoryEntrySchema,
  resumeHistoryRecordSchema,
  upsertResumeHistoryEntry,
  validateResumeHistoryEntry,
  type ResumeHistoryEntry,
} from './history';

const JOB = { id: 'job-1', title: 'Senior Backend Engineer', company: 'Acme Fake Co' } as const;
const deps = { now: () => '2026-10-13T08:00:00.000Z', id: () => 'rv-1' };

function entry(): ResumeHistoryEntry {
  return createResumeHistoryEntry(baseResume(), JOB, deps);
}

describe('resumeHistoryEntrySchema', () => {
  it('round-trips a valid entry (parse is idempotent)', () => {
    const created = entry();
    expect(created).toMatchObject({
      id: 'rv-1',
      schemaVersion: '1',
      jobId: 'job-1',
      jobTitle: 'Senior Backend Engineer',
      company: 'Acme Fake Co',
      createdAt: '2026-10-13T08:00:00.000Z',
      status: 'saved',
    });
    const parsed = resumeHistoryEntrySchema.parse(created);
    expect(parsed).toEqual(created);
    expect(resumeHistoryEntrySchema.parse(parsed)).toEqual(parsed);
  });

  it('round-trips through the storage record schema', () => {
    const record = upsertResumeHistoryEntry(emptyResumeHistoryRecord(), entry());
    const parsed = resumeHistoryRecordSchema.parse(record);
    expect(parsed).toEqual(record);
    expect(parsed.versions).toHaveLength(1);
  });

  it('rejects unknown top-level fields (credentials, page content, selectors)', () => {
    const base = entry();
    for (const extra of [
      { apiKey: 'sk-never' },
      { token: 'abc123' },
      { pageContent: '<html>job page</html>' },
      { selector: '#apply' },
      { notes: 'free text' },
      { salary: '100000' },
    ]) {
      const res = resumeHistoryEntrySchema.safeParse({ ...base, ...extra });
      expect(res.success).toBe(false);
    }
  });

  it('rejects sensitive profile fields at the entry and snapshot level', () => {
    const base = entry();
    expect(
      resumeHistoryEntrySchema.safeParse({
        ...base,
        contact: { email: 'person@example.com', phone: '555-0100' },
      }).success,
    ).toBe(false);
    expect(
      resumeHistoryEntrySchema.safeParse({ ...base, legal: { workAuthorization: 'yes' } }).success,
    ).toBe(false);
    // The reused resume schema is strict too: an injected contact field cannot
    // ride inside the snapshot.
    expect(
      resumeHistoryEntrySchema.safeParse({ ...base, snapshot: { ...base.snapshot, contactEmail: 'a@b.co' } })
        .success,
    ).toBe(false);
    expect(
      resumeHistoryEntrySchema.safeParse({
        ...base,
        snapshot: { ...base.snapshot, apiKey: 'sk-never' },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed fields (bad id, timestamp, status, labels, snapshot)', () => {
    const base = entry();
    expect(resumeHistoryEntrySchema.safeParse({ ...base, id: '' }).success).toBe(false);
    expect(resumeHistoryEntrySchema.safeParse({ ...base, createdAt: 'yesterday' }).success).toBe(false);
    expect(resumeHistoryEntrySchema.safeParse({ ...base, status: 'draft' }).success).toBe(false);
    expect(
      resumeHistoryEntrySchema.safeParse({ ...base, jobTitle: 'x'.repeat(201) }).success,
    ).toBe(false);
    expect(resumeHistoryEntrySchema.safeParse({ ...base, snapshot: {} }).success).toBe(false);
    expect(
      resumeHistoryEntrySchema.safeParse({ ...base, snapshot: { ...base.snapshot, schemaVersion: '9' } })
        .success,
    ).toBe(false);
  });

  it('rejects unknown record fields and an over-cap versions list', () => {
    expect(
      resumeHistoryRecordSchema.safeParse({
        schemaVersion: '1',
        versions: [],
        exports: [{ id: 'x' }],
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_RESUME_HISTORY_VERSIONS + 1 }, (_, i) => ({
      ...entry(),
      id: `rv-${i}`,
    }));
    expect(
      resumeHistoryRecordSchema.safeParse({ schemaVersion: '1', versions: tooMany }).success,
    ).toBe(false);
    expect(MAX_RESUME_HISTORY_VERSIONS).toBe(200);
  });

  it('reports value-free validation issues (path + code only)', () => {
    const res = validateResumeHistoryEntry({
      id: '',
      createdAt: 'SECRET-TIMESTAMP-VALUE',
      snapshot: { apiKey: 'SECRET-KEY-VALUE' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const joined = res.issues.join(' | ');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toMatch(/SECRET/);

    const bad = resumeHistoryEntrySchema.safeParse({ id: '', createdAt: 'SECRET-TIME' });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const issues = formatResumeHistoryIssues(bad.error);
      expect(issues.length).toBeGreaterThan(0);
      // "path: code" only — never the stored value.
      expect(issues.every((s) => s.includes(':'))).toBe(true);
      expect(issues.join(' ')).not.toMatch(/SECRET/);
    }
  });
});

describe('createResumeHistoryEntry', () => {
  it('copies labels from the saved job and never invents a missing company', () => {
    const withCompany = createResumeHistoryEntry(baseResume(), JOB, deps);
    expect(withCompany.company).toBe('Acme Fake Co');

    const noCompany = createResumeHistoryEntry(
      baseResume(),
      { id: 'job-1', title: 'Senior Backend Engineer', company: undefined },
      deps,
    );
    expect(noCompany.company).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(noCompany, 'company')).toBe(false);

    // No job supplied at all: title falls back to the snapshot's own provenance.
    const noJob = createResumeHistoryEntry(baseResume(), undefined, deps);
    expect(noJob.jobTitle).toBe(baseResume().source.jobTitle);
    expect(noJob.company).toBeUndefined();
    expect(noJob.jobId).toBe('job-1');
  });

  it('stores an immutable copy: later mutations of the source resume cannot change it', () => {
    const resume = baseResume();
    const created = createResumeHistoryEntry(resume, JOB, deps);

    resume.summary!.text = 'CHANGED AFTER SAVE';
    resume.skills.push({ profileSkillId: 'sk-x', name: 'Invented', status: 'claimed', relevance: 'neutral' });
    resume.source.jobTitle = 'Renamed later';

    expect(created.snapshot.summary!.text).toBe('Backend engineer focused on reliable APIs.');
    expect(created.snapshot.skills).toHaveLength(3);
    expect(created.snapshot.source.jobTitle).toBe('Senior Backend Engineer');
    expect(created.snapshot).not.toBe(resume);
  });

  it('uses the injected clock and id (deterministic, no real clock)', () => {
    const a = createResumeHistoryEntry(baseResume(), JOB, deps);
    const b = createResumeHistoryEntry(baseResume(), JOB, deps);
    expect(a).toEqual(b);
    expect(a.createdAt).toBe('2026-10-13T08:00:00.000Z');
    expect(a.id).toBe('rv-1');
  });
});

describe('record helpers', () => {
  it('upserts newest-first without dropping other versions', () => {
    const first = createResumeHistoryEntry(baseResume(), JOB, deps);
    const second = createResumeHistoryEntry(baseResume(), JOB, {
      now: () => '2026-10-14T08:00:00.000Z',
      id: () => 'rv-2',
    });
    let record = upsertResumeHistoryEntry(emptyResumeHistoryRecord(), first);
    record = upsertResumeHistoryEntry(record, second);
    expect(record.versions.map((v) => v.id)).toEqual(['rv-2', 'rv-1']);

    // Re-saving the same id replaces that entry only — nothing else is lost.
    const updated = { ...first, createdAt: '2026-10-15T00:00:00.000Z' } as ResumeHistoryEntry;
    record = upsertResumeHistoryEntry(record, updated);
    expect(record.versions).toHaveLength(2);
    expect(record.versions.map((v) => v.id)).toEqual(['rv-2', 'rv-1']);
    expect(record.versions[1]!.createdAt).toBe('2026-10-15T00:00:00.000Z');
  });

  it('removes exactly the selected version and finds by id', () => {
    const ids = ['a', 'b', 'c'];
    let record = emptyResumeHistoryRecord();
    for (const id of ids) {
      record = upsertResumeHistoryEntry(
        record,
        createResumeHistoryEntry(baseResume(), JOB, { now: () => '2026-10-13T08:00:00.000Z', id: () => id }),
      );
    }
    expect(findResumeHistoryEntry(record, 'b')?.id).toBe('b');
    expect(findResumeHistoryEntry(record, 'zzz')).toBeUndefined();

    const after = removeResumeHistoryEntry(record, 'b');
    expect(after.versions.map((v) => v.id)).toEqual(['c', 'a']);
    // Removing an unknown id is a no-op copy (nothing else changes).
    expect(removeResumeHistoryEntry(record, 'zzz').versions).toHaveLength(3);
    // Original record untouched (pure helper).
    expect(record.versions).toHaveLength(3);
  });

  it('reports full only at the documented cap', () => {
    let record = emptyResumeHistoryRecord();
    expect(isResumeHistoryFull(record)).toBe(false);
    for (let i = 0; i < MAX_RESUME_HISTORY_VERSIONS; i++) {
      record = upsertResumeHistoryEntry(
        record,
        createResumeHistoryEntry(baseResume(), JOB, {
          now: () => '2026-10-13T08:00:00.000Z',
          id: () => `rv-${i}`,
        }),
      );
    }
    expect(record.versions).toHaveLength(MAX_RESUME_HISTORY_VERSIONS);
    expect(isResumeHistoryFull(record)).toBe(true);
  });

  it('exposes a display label for the single fixed status', () => {
    expect(RESUME_HISTORY_STATUS_LABELS.saved).toBe('Saved');
    expect(Object.keys(RESUME_HISTORY_STATUS_LABELS)).toEqual(['saved']);
  });
});
