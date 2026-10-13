/**
 * Schema/model tests for the application log (Prompt 13). Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES,
  MAX_NOTES_CHARS,
  applicationSchema,
  applyApplicationPatch,
  createApplication,
  emptyApplicationsRecord,
  findApplicationForJob,
  removeApplicationFromList,
  upsertApplicationInList,
  validateApplicationInput,
  type Application,
} from './schemas';

const deps = { now: () => '2026-10-10T00:00:00.000Z', id: () => 'app-1' };

function make(overrides: Record<string, unknown> = {}): Application {
  return createApplication({ jobId: 'job-1', ...overrides }, deps);
}

describe('applicationSchema', () => {
  it('accepts a minimal valid record and defaults status to "planned"', () => {
    const app = make();
    expect(app.status).toBe('planned');
    expect(app.schemaVersion).toBe('1');
    expect(app.createdAt).toBe('2026-10-10T00:00:00.000Z');
    expect(app.updatedAt).toBe(app.createdAt);
    expect(app.notes).toBeUndefined();
  });

  it('accepts every documented status and rejects unknown ones', () => {
    for (const status of APPLICATION_STATUSES) {
      expect(make({ status }).status).toBe(status);
    }
    expect(applicationSchema.safeParse({ ...make(), status: 'ghosted' }).success).toBe(false);
  });

  it('rejects unknown properties (strict) — no salary/contact fields can sneak in', () => {
    const bad = { ...make(), salary: '999,999', email: 'x@example.com' };
    const parsed = applicationSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => make({ applicationDate: '2026-13-01' })).toThrow();
    expect(() => make({ applicationDate: '2026-02-31' })).toThrow();
    expect(() => make({ followUpDate: '01-02-2026' })).toThrow();
    expect(make({ applicationDate: '2026-02-28' }).applicationDate).toBe('2026-02-28');
  });

  it('caps notes length and normalizes blank notes to absent', () => {
    expect(() => make({ notes: 'x'.repeat(MAX_NOTES_CHARS + 1) })).toThrow();
    expect(make({ notes: 'x'.repeat(MAX_NOTES_CHARS) }).notes).toHaveLength(MAX_NOTES_CHARS);
    expect(make({ notes: '   ' }).notes).toBeUndefined();
    expect(make({ notes: '  keep me  ' }).notes).toBe('keep me');
  });
});

describe('applyApplicationPatch', () => {
  it('preserves identity fields and bumps updatedAt', () => {
    const app = make({ notes: 'old' });
    const next = applyApplicationPatch(app, { status: 'interview', notes: 'new' }, () => '2026-11-01T00:00:00.000Z');
    expect(next.id).toBe(app.id);
    expect(next.jobId).toBe(app.jobId);
    expect(next.createdAt).toBe(app.createdAt);
    expect(next.updatedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(next.status).toBe('interview');
    expect(next.notes).toBe('new');
  });

  it('clears optional fields with null and leaves them when undefined', () => {
    const app = make({ applicationDate: '2026-01-02', followUpDate: '2026-02-03', notes: 'n' });
    const cleared = applyApplicationPatch(app, { applicationDate: null, notes: null });
    expect(cleared.applicationDate).toBeUndefined();
    expect(cleared.notes).toBeUndefined();
    // undefined keeps the existing follow-up date.
    expect(cleared.followUpDate).toBe('2026-02-03');
  });
});

describe('list helpers', () => {
  it('upserts by id and removes by id', () => {
    const a = createApplication({ jobId: 'job-1' }, { now: deps.now, id: () => 'a' });
    const b = createApplication({ jobId: 'job-2' }, { now: deps.now, id: () => 'b' });
    let list = upsertApplicationInList([a], b);
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
    const updated = { ...a, status: 'offer' as const, updatedAt: '2026-12-01T00:00:00.000Z' };
    list = upsertApplicationInList(list, updated);
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.id === 'a')?.status).toBe('offer');
    expect(removeApplicationFromList(list, 'a').map((x) => x.id)).toEqual(['b']);
  });

  it('finds the application tracking a job', () => {
    const a = make();
    expect(findApplicationForJob([a], 'job-1')?.id).toBe('app-1');
    expect(findApplicationForJob([a], 'job-9')).toBeUndefined();
  });

  it('emptyApplicationsRecord is valid and empty', () => {
    expect(emptyApplicationsRecord()).toEqual({ schemaVersion: '1', applications: [] });
  });
});

describe('validateApplicationInput', () => {
  it('returns path+message issues for invalid drafts (no content echo)', () => {
    const issues = validateApplicationInput({ jobId: '', status: 'nope' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(' ')).toMatch(/jobId|status/);
  });
});
