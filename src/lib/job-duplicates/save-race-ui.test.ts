// @vitest-environment jsdom
/**
 * Race-condition regression tests for the two save paths (Prompt 26.1).
 *
 * jsdom + `react-dom/client` + `act`, with the extension storage mocked in
 * memory. The race is simulated by MUTATING THE MOCKED STORAGE between rendering
 * the component and clicking save — the component's React state never sees the
 * new posting, so a save that used stale state would wrongly succeed. No timers,
 * no delays, no flakiness.
 *
 * Covered for BOTH entry points: a posting added from "another tab" after the
 * preview/panel was built blocks the normal save (with the duplicate warning),
 * the explicit "save as a separate record" override then writes exactly one
 * extra record (no loop), malformed storage still fails safely, and editing a
 * posting never flags that posting as its own duplicate.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../storage';

type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

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
  const captureResponse = {
    kind: 'ok',
    candidate: {
      url: 'https://example.com/jobs/1',
      title: 'Backend Engineer',
      company: 'Fake Co',
      descriptionText: 'Fake captured description text for the regression test.',
      descriptionTruncated: false,
    },
  };
  const browser = {
    storage: { local: storageLocal },
    runtime: { openOptionsPage: async () => {} },
    tabs: {
      query: async () => [{ id: 7, url: 'https://example.com/jobs/1' }],
      sendMessage: async () => captureResponse,
    },
    scripting: { executeScript: async () => [] },
  };
  return { backing, failure, calls, storageLocal, browser, captureResponse };
});

vi.mock('wxt/browser', () => ({ browser: h.browser }));

import PopupApp from '../../../entrypoints/popup/App';
import JobsPanel from '../../../entrypoints/options/JobsPanel';

/** The record "another tab" saves while the UI is open. */
function savedJob(patch: Record<string, unknown> = {}) {
  return {
    id: 'job-from-other-tab',
    title: 'Backend Engineer',
    company: 'Fake Co',
    rawDescription: 'Fake raw description.',
    source: 'page-capture',
    capturedAt: '2026-10-01T00:00:00.000Z',
    originalUrl: 'https://example.com/jobs/1',
    ...patch,
  };
}

function persist(...postings: unknown[]): void {
  h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings });
}

function persistedPostings(): unknown[] {
  const record = h.backing.get(STORAGE_KEYS.jobPostings) as { postings?: unknown[] } | undefined;
  return record?.postings ?? [];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.backing.clear();
  h.failure.getThrows = false;
  h.calls.set = 0;
  h.calls.remove = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

/** Render and let every load effect settle (microtasks only — no timers). */
async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) {
    const all = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    throw new Error(`no button labelled "${label}" (found: ${all.join(' | ')})`);
  }
  return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
  const target = button(label);
  await act(async () => {
    target.click();
  });
}

/** Set a React-controlled field the way a user would (native setter + event). */
async function fillByRowLabel(label: string, value: string): Promise<void> {
  const row = [...container.querySelectorAll('.row')].find(
    (r) => r.querySelector('.row-label')?.textContent?.trim() === label,
  );
  const field = row?.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement | undefined;
  if (field === undefined) {
    const labels = [...container.querySelectorAll('.row-label')].map((l) => l.textContent?.trim());
    throw new Error(`no field in row "${label}" (rows: ${labels.join(' | ')})`);
  }
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function warning(): Element | null {
  return container.querySelector('.duplicate-warning');
}

/* ------------------------------------------------------------------ */
/* Popup save path                                                     */
/* ------------------------------------------------------------------ */

describe('popup save path', () => {
  it('blocks a normal save when a duplicate was saved after the preview was built', async () => {
    await render(createElement(PopupApp));
    await click('Capture current job');
    expect(container.textContent).toContain('review and correct');
    expect(persistedPostings()).toEqual([]);

    // Another tab saves the very same posting now: the preview's state has no
    // idea, so only a fresh pre-write read can catch it.
    persist(savedJob());

    await click('Save posting');
    expect(warning()).not.toBeNull();
    expect(warning()?.getAttribute('data-status')).toBe('confirmed');
    expect(container.textContent).toContain('Backend Engineer');
    expect(persistedPostings()).toHaveLength(1); // nothing was written

    // The explicit override writes exactly one extra record — once, no loop.
    await click('Save as a separate record');
    expect(warning()).toBeNull();
    expect(container.textContent).toContain('Saved to your job list');
    expect(persistedPostings()).toHaveLength(2);
    expect(h.calls.remove).toBe(0);
  });

  it('still saves normally when no duplicate exists (unchanged behavior)', async () => {
    await render(createElement(PopupApp));
    await click('Capture current job');
    await click('Save posting');
    expect(persistedPostings()).toHaveLength(1);
    expect(container.textContent).toContain('Saved to your job list');
    expect(warning()).toBeNull();
  });

  it('fails safely on malformed storage and never corrupts it', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: 'not-a-list' });
    await render(createElement(PopupApp));
    await click('Capture current job');

    await click('Save posting');
    expect(warning()?.getAttribute('data-status')).toBe('check-failed');
    expect(button('Save anyway')).toBeDefined(); // explicit, per-attempt override
    expect(persistedPostings()).toBe('not-a-list');

    // The explicit override must not bypass storage validation.
    await click('Save anyway');
    expect(container.textContent).toContain('Save failed (malformed)');
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toEqual({
      schemaVersion: '1',
      postings: 'not-a-list',
    });
    expect(h.calls.remove).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Options → Jobs save path                                            */
/* ------------------------------------------------------------------ */

async function openCreateForm(): Promise<void> {
  await click('Add job manually');
  await fillByRowLabel('Job title *', 'Backend Engineer');
  await fillByRowLabel('Company', 'Fake Co');
  await fillByRowLabel('Original URL', 'https://example.com/jobs/1');
  await fillByRowLabel('Job description *', 'Fake manual description text.');
}

describe('Options → Jobs save path', () => {
  it('blocks a normal create when a duplicate was saved after the panel loaded', async () => {
    await render(createElement(JobsPanel));
    await openCreateForm();
    expect(persistedPostings()).toEqual([]);

    // Another tab saves the same posting while the form is open.
    persist(savedJob());

    await click('Save posting');
    expect(warning()).not.toBeNull();
    expect(warning()?.getAttribute('data-status')).toBe('confirmed');
    expect(container.textContent).toContain('Backend Engineer');
    expect(persistedPostings()).toHaveLength(1); // nothing was written

    await click('Save as a separate record');
    expect(warning()).toBeNull();
    expect(container.textContent).toContain('Posting saved.');
    expect(persistedPostings()).toHaveLength(2);
  });

  it('still creates normally when no duplicate exists', async () => {
    await render(createElement(JobsPanel));
    await openCreateForm();
    await click('Save posting');
    expect(persistedPostings()).toHaveLength(1);
    expect(container.textContent).toContain('Posting saved.');
    expect(warning()).toBeNull();
  });

  it('never treats the posting being edited as its own duplicate', async () => {
    persist(savedJob({ id: 'job-edit' }));
    await render(createElement(JobsPanel));
    await click('Edit');
    await click('Update posting');

    expect(warning()).toBeNull();
    expect(container.textContent).toContain('Posting updated.');
    expect(persistedPostings()).toHaveLength(1); // updated in place
  });

  it('fails safely on malformed storage, and the override cannot bypass validation', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: 'not-a-list' });
    await render(createElement(JobsPanel));
    await openCreateForm();

    await click('Save posting');
    expect(warning()?.getAttribute('data-status')).toBe('check-failed');
    expect(button('Save anyway')).toBeDefined();

    await click('Save anyway');
    expect(container.textContent).toContain('Save failed (malformed)');
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toEqual({
      schemaVersion: '1',
      postings: 'not-a-list',
    });
    expect(h.calls.remove).toBe(0);
  });
});
