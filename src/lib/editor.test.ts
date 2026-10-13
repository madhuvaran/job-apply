/**
 * Tests for the options-page editor logic (src/lib/editor.ts).
 *
 * browser.storage.local is mocked in-memory. Covers the acceptance areas:
 * persistence after reload (save -> fresh load), invalid input rejection,
 * empty onboarding state, dirty tracking, repeatable add/remove, and the
 * sample-seeding rule (draft-only, no auto-persist).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addItem,
  applySampleToDraft,
  bulletsToLines,
  dateRangeToFields,
  draftsDiffer,
  emptyDraft,
  fieldsToDateRange,
  isEmptyProfileState,
  linesToBullets,
  loadEditorState,
  profileToDraft,
  removeItem,
  saveDraft,
  updateItem,
  validateDraft,
} from './editor';
import { resetProfile } from './storage';
import { sampleProfile } from './sample-profile';

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  return {
    backing,
    storageLocal: {
      get: async (keys: string | string[]) => {
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of wanted) if (backing.has(k)) out[k] = backing.get(k);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) backing.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        const wanted = Array.isArray(keys) ? keys : [keys];
        for (const k of wanted) backing.delete(k);
      },
    },
  };
});

vi.mock('wxt/browser', () => ({ browser: { storage: { local: h.storageLocal } } }));

beforeEach(() => {
  h.backing.clear();
});

describe('empty onboarding state', () => {
  it('reports "empty" load state when nothing is stored', async () => {
    const state = await loadEditorState();
    expect(state).toEqual({ kind: 'empty' });
  });

  it('reports "empty" also after an explicit reset (no content was ever added)', async () => {
    await resetProfile();
    const state = await loadEditorState();
    // Storage says ready (an empty profile object exists), and the editor treats it as empty.
    expect(isEmptyProfileState(state)).toBe(true);
  });

  it('an empty draft is valid — onboarding form starts clean', () => {
    expect(validateDraft(emptyDraft())).toEqual([]);
  });
});

describe('load malformed/unavailable states', () => {
  it('reports malformed with raw for corrupt stored data', async () => {
    h.backing.set('job-profile.v2', { nonsense: 1 });
    const state = await loadEditorState();
    expect(state.kind).toBe('malformed');
    if (state.kind === 'malformed') expect(state.raw).toEqual({ nonsense: 1 });
  });
});

describe('persistence after reload', () => {
  it('saving a draft persists it; a fresh load returns the same profile content', async () => {
    // Build a small realistic draft by hand (nothing invented beyond the user's typed values).
    const draft = emptyDraft();
    draft.displayName = 'Test User';
    draft.summary = 'Fake summary typed by the test user.';
    draft.skills = [{ id: 'sk-1', name: 'Fake Skill', status: 'claimed' }];
    draft.experience = [
      {
        id: 'exp-1',
        company: 'Fake Co',
        title: 'Fake Title',
        dates: { start: '2020-01', end: null },
        bullets: ['Fake bullet typed by the user.'],
      },
    ];

    const res = await saveDraft(draft);
    expect(res).toBeNull();

    // "Reload": load editor state anew.
    const state = await loadEditorState();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') throw new Error('unreachable');
    expect(profileToDraft(state.profile)).toEqual(draft);
    expect(isEmptyProfileState(state)).toBe(false);
  });

  it('round-trips through the exact schema (updatedAt/schemaVersion managed)', async () => {
    const draft = emptyDraft();
    draft.headline = 'Fake headline';
    const res = await saveDraft(draft);
    expect(res).toBeNull();
    const state = await loadEditorState();
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.profile.schemaVersion).toBe('2');
    expect(state.profile.updatedAt).toEqual(expect.any(String));
  });
});

describe('invalid input rejection', () => {
  it('flags malformed month dates as validation errors and refuses to save', async () => {
    const draft = emptyDraft();
    draft.experience = [
      {
        id: 'e1',
        company: 'Co',
        title: 'T',
        dates: { start: 'not-a-date', end: null },
        bullets: ['b'],
      },
    ];
    const errors = validateDraft(draft);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/YYYY-MM/);
    const res = await saveDraft(draft);
    expect(res).not.toBeNull();
    if (res !== null) expect(res.ok).toBe(false);
  });

  it('flags end < start ranges', () => {
    const draft = emptyDraft();
    draft.experience = [
      { id: 'e1', company: 'C', title: 'T', dates: { start: '2021-01', end: '2020-12' }, bullets: ['b'] },
    ];
    expect(validateDraft(draft).join(' ')).toMatch(/end must be >= start/);
  });

  it('flags experience items with no non-empty bullets', () => {
    const draft = emptyDraft();
    draft.experience = [
      { id: 'e1', company: 'C', title: 'T', dates: { start: '2021-01', end: null }, bullets: [] },
    ];
    expect(validateDraft(draft).length).toBeGreaterThan(0);
  });

  it('rejects invalid URL values for links', () => {
    const draft = emptyDraft();
    draft.github = 'not a url';
    expect(validateDraft(draft).join(' ')).toMatch(/github/);
  });

  it('empty bullet lines are dropped by the bridging helper (matches schema >=1 rule)', () => {
    expect(linesToBullets('first\n\n  \nsecond')).toEqual(['first', 'second']);
    expect(linesToBullets('  ')).toEqual([]);
  });
});

describe('sample seeding rule (never auto-persisted)', () => {
  it('seeding the draft does not touch storage', async () => {
    const before = new Set(h.backing.keys());
    applySampleToDraft(sampleProfile);
    expect(new Set(h.backing.keys())).toEqual(before);
  });

  it('a sample-seeded draft only persists after an explicit save', async () => {
    const seeded = applySampleToDraft(sampleProfile);
    expect(h.backing.has('job-profile.v2')).toBe(false);
    const res = await saveDraft(seeded);
    expect(res).toBeNull();
    expect(h.backing.has('job-profile.v2')).toBe(true);
  });
});

describe('dirty tracking', () => {
  it('a stored profile vs empty draft => differs; identical drafts => not dirty', () => {
    const empty = emptyDraft();
    expect(draftsDiffer(empty, empty)).toBe(false);
    const changed = { ...empty, headline: 'Different' };
    expect(draftsDiffer(empty, changed)).toBe(true);
  });

  it('isEmptyProfileState distinguishes truly empty stored profiles from real ones', async () => {
    await saveDraft(emptyDraft());
    expect(isEmptyProfileState(await loadEditorState())).toBe(true);
    await resetProfile();
    const d = applySampleToDraft(sampleProfile);
    await saveDraft(d);
    expect(isEmptyProfileState(await loadEditorState())).toBe(false);
  });
});

describe('repeatable item helpers (pure)', () => {
  it('add/remove/update work by id and never mutate the input', () => {
    const a = { id: 'a', name: 'A', status: 'claimed' as const };
    const b = { id: 'b', name: 'B', status: 'claimed' as const };
    let items = addItem([], a);
    items = addItem(items, b);
    expect(items).toHaveLength(2);
    const afterRemove = removeItem(items, 'a');
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]).toEqual(b);
    expect(items).toHaveLength(2); // original untouched
    const afterUpdate = updateItem(afterRemove, 'b', { name: 'B2' });
    expect(afterUpdate[0]).toMatchObject({ id: 'b', name: 'B2' });
    expect(afterRemove[0]).toMatchObject({ name: 'B' });
  });
});

describe('date field bridging', () => {
  it('ongoing (end=null) round-trips, and empty end with ongoing=false also maps to null', () => {
    expect(dateRangeToFields({ start: '2020-01', end: null })).toEqual({ start: '2020-01', end: '', ongoing: true });
    expect(fieldsToDateRange({ start: '2020-01', end: '', ongoing: true })).toEqual({ start: '2020-01', end: null });
    expect(fieldsToDateRange({ start: '2020-01', end: '2021-02', ongoing: false })).toEqual({ start: '2020-01', end: '2021-02' });
    expect(fieldsToDateRange({ start: '2020-01', end: '', ongoing: false })).toEqual({ start: '2020-01', end: null });
  });

  it('bullets bridging round-trips non-empty content', () => {
    expect(linesToBullets(bulletsToLines(['a', 'b']))).toEqual(['a', 'b']);
  });
});
