// @vitest-environment jsdom
/**
 * Manual job import flow tests (Prompt 29).
 *
 * jsdom + `react-dom/client` + `act`, with extension storage mocked in memory.
 * Every storage mutation happens in this test file only — no network, no
 * provider, no real credentials, no real personal data.
 *
 * Covers the flow end to end: validation → review (still no write) → duplicate
 * check → save / save as separate, plus the fail-closed paths: a duplicate found
 * at review, a duplicate added between review and the final write, malformed
 * storage, and storage failures. Also asserts importing never creates an
 * application-log entry and never makes a network request.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../storage';

type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  const calls = { set: 0, get: 0, remove: 0 };
  const storageLocal = {
    get: async (keys: string | string[]) => {
      calls.get += 1;
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (backing.has(key)) out[key] = backing.get(key);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      calls.set += 1;
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      calls.remove += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) backing.delete(key);
    },
  };
  return { backing, calls, browser: { storage: { local: storageLocal } } };
});

vi.mock('wxt/browser', () => ({ browser: h.browser }));

import JobSearchPanel from '../../../entrypoints/options/JobSearchPanel';

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.backing.clear();
  h.calls.set = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(JobSearchPanel));
  });
}

/** React-controlled inputs need the native setter plus bubbling events. */
async function setControl(selector: string, value: string) {
  const el = container.querySelector(selector);
  if (el === null) throw new Error(`no element for ${selector}`);
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickText(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button "${label}"`);
  await act(async () => {
    button.click();
  });
}

function importForm(): HTMLFormElement {
  const form = container.querySelector('form[aria-label="Add a job from a listing"]');
  if (form === null) throw new Error('import form not rendered');
  return form as HTMLFormElement;
}

async function submitImportForm() {
  await act(async () => {
    importForm().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const text = () => container.textContent ?? '';
const query = (selector: string) => container.querySelector(selector);

/** Fill the form with valid values (title, description and kind are required). */
async function fillValidForm(overrides: Record<string, string> = {}) {
  await setControl('#import-title', overrides['title'] ?? 'Backend Engineer');
  await setControl('#import-description', overrides['description'] ?? 'Build services with the team.');
  await setControl('#import-kind', overrides['descriptionKind'] ?? 'full');
  if (overrides['company'] !== undefined) await setControl('#import-company', overrides['company']);
  if (overrides['location'] !== undefined) await setControl('#import-location', overrides['location']);
  if (overrides['url'] !== undefined) await setControl('#import-url', overrides['url']);
}

function storedPostings(): unknown {
  const record = h.backing.get(STORAGE_KEYS.jobPostings) as
    | { postings?: unknown[] }
    | undefined;
  return record?.postings ?? null;
}

function existingJob(patch: Record<string, unknown> = {}) {
  return {
    id: 'existing-1',
    title: 'Backend Engineer',
    company: 'Acme',
    rawDescription: 'An already saved posting.',
    capturedAt: '2026-10-01T00:00:00.000Z',
    source: 'manual',
    originalUrl: 'https://example.com/jobs/existing',
    ...patch,
  };
}

function seedJob(patch: Record<string, unknown> = {}) {
  h.backing.set(STORAGE_KEYS.jobPostings, {
    schemaVersion: '1',
    postings: [existingJob(patch)],
  });
}

/* ------------------------------------------------------------------ */
/* Sections and states                                                 */
/* ------------------------------------------------------------------ */

describe('the import experience sits beside an unavailable search', () => {
  it('offers manual import while search stays unavailable and unfabricated', async () => {
    await mount();
    expect(query('form[aria-label="Add a job from a listing"]')).not.toBeNull();
    expect(query('[data-state="unavailable"]')).not.toBeNull();
    expect(text()).toContain('Live job search is unavailable');
    // The import area is NOT presented as search results.
    expect(container.querySelectorAll('li.search-result')).toHaveLength(0);
    expect(query('.search-attribution')).toBeNull();
    expect(text()).not.toContain('no matching jobs');
  });

  it('labels every import control and uses a real submit button', async () => {
    await mount();
    for (const id of [
      'import-title',
      'import-company',
      'import-location',
      'import-url',
      'import-description',
      'import-kind',
    ]) {
      expect(container.querySelector(`#${id}`), `missing #${id}`).not.toBeNull();
      expect(container.querySelector(`label[for="${id}"]`), `missing label for ${id}`).not.toBeNull();
    }
    const review = importForm().querySelector('button[type="submit"]');
    expect(review?.textContent).toBe('Review');
  });
});

/* ------------------------------------------------------------------ */
/* Validation (nothing written)                                         */
/* ------------------------------------------------------------------ */

describe('invalid imports are rejected without writing anything', () => {
  it('reports the missing required fields', async () => {
    await mount();
    await submitImportForm();

    expect(text()).toContain('Enter the job title.');
    expect(text()).toContain('Paste the job description or an excerpt');
    expect(text()).toContain('Say whether the text you pasted is the full description or an excerpt.');
    expect(storedPostings()).toBeNull();
    expect(query('form[aria-label="Add a job from a listing"]')).not.toBeNull();
  });

  it('rejects an unsafe URL and never writes it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await mount();
    await fillValidForm({ url: 'javascript:alert(1)' });
    await submitImportForm();

    expect(text()).toContain('Enter a valid listing URL beginning with http:// or https://');
    expect(text()).not.toContain('alert(1)');
    expect(storedPostings()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('clears the messages once the fields are filled', async () => {
    await mount();
    await submitImportForm();
    expect(text()).toContain('Enter the job title.');
    await fillValidForm();
    await submitImportForm();
    expect(text()).not.toContain('Enter the job title.');
    expect(query('.import-review')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Review before saving                                                 */
/* ------------------------------------------------------------------ */

describe('nothing is saved before the user confirms it', () => {
  it('shows exactly what will be stored and writes nothing on Review', async () => {
    await mount();
    await fillValidForm({
      company: 'Example Ltd',
      location: 'Pune',
      url: 'https://example.com/jobs/99',
    });
    await submitImportForm();

    expect(query('.import-review')).not.toBeNull();
    expect(text()).toContain('Nothing is saved yet');
    expect(text()).toContain('Backend Engineer');
    expect(text()).toContain('Example Ltd');
    expect(text()).toContain('https://example.com/jobs/99');
    expect(text()).toContain('Complete description');
    expect(text()).toContain('source: manually entered');
    // Still nothing written — no automatic save from pasting text.
    expect(storedPostings()).toBeNull();
    expect(h.calls.set).toBe(0);
  });

  it('marks an excerpt as an excerpt in the review', async () => {
    await mount();
    await fillValidForm({ descriptionKind: 'snippet' });
    await submitImportForm();
    expect(text()).toContain('Excerpt only');
    expect(text()).not.toContain('Complete description');
  });

  it('Cancel returns to the form keeping the entered values, and writes nothing', async () => {
    await mount();
    await fillValidForm();
    await submitImportForm();
    await clickText('Cancel');

    expect(query('form[aria-label="Add a job from a listing"]')).not.toBeNull();
    expect(query('.import-review')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#import-title')!.value).toBe('Backend Engineer');
    expect(storedPostings()).toBeNull();
  });

  it('Save writes one validated posting and no application entry', async () => {
    await mount();
    await fillValidForm({ company: 'Example Ltd', description: '  Raw text  ' });
    await submitImportForm();
    await clickText('Save job');

    expect(query('[data-state="import-saved"]')).not.toBeNull();
    expect(text()).toContain('Job saved');

    const postings = storedPostings() as Array<Record<string, unknown>> | null;
    expect(postings).toHaveLength(1);
    expect(postings![0]).toMatchObject({
      title: 'Backend Engineer',
      company: 'Example Ltd',
      source: 'manual',
      descriptionKind: 'full',
      rawDescription: '  Raw text  ',
    });
    expect(typeof postings![0]!['id']).toBe('string');
    expect(typeof postings![0]!['capturedAt']).toBe('string');
    // Importing ≠ applying: the application log must stay untouched.
    expect(h.backing.has(STORAGE_KEYS.applications)).toBe(false);
    // Never shown as an Adzuna search result.
    expect(container.querySelectorAll('li.search-result')).toHaveLength(0);
    expect(query('.search-attribution')).toBeNull();
  });

  it('“Add another job” resets the form for the next entry', async () => {
    await mount();
    await fillValidForm();
    await submitImportForm();
    await clickText('Save job');
    await clickText('Add another job');

    expect(container.querySelector<HTMLInputElement>('#import-title')!.value).toBe('');
    expect(query('form[aria-label="Add a job from a listing"]')).not.toBeNull();
    expect((storedPostings() as unknown[]).length).toBe(1);
  });

  it('makes no network request through the whole flow', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await mount();
    await fillValidForm({ url: 'https://example.com/jobs/99' });
    await submitImportForm();
    await clickText('Save job');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* Duplicate protection                                                 */
/* ------------------------------------------------------------------ */

describe('a duplicate found at review blocks the write', () => {
  it('shows the existing warning and leaves the saved job untouched', async () => {
    seedJob();
    const before = JSON.stringify(h.backing.get(STORAGE_KEYS.jobPostings));
    await mount();
    await fillValidForm({ company: 'Acme' });
    await submitImportForm();

    const warning = query('.duplicate-warning[data-status="possible"]');
    expect(warning).not.toBeNull();
    expect(text()).toContain('A saved job has the same company and title');
    expect(text()).toContain('Backend Engineer');
    // NOTHING was written or merged; the existing record is byte-identical.
    expect(query('[data-state="import-saved"]')).toBeNull();
    // NOTHING was written or merged at review time: the stored value is byte-identical.
    expect(h.calls.set).toBe(0);
    expect(JSON.stringify(h.backing.get(STORAGE_KEYS.jobPostings))).toBe(before);
    expect((storedPostings() as unknown[]).length).toBe(1);

    await clickText('Save as a separate record');
    const postings = storedPostings() as Array<Record<string, unknown>>;
    expect(postings).toHaveLength(2);
    // The pre-existing record survives with its own identity and text — nothing
    // was merged, overwritten or re-keyed (only re-validated on write).
    const surviving = postings.find((p) => p['id'] === 'existing-1');
    expect(surviving).toBeDefined();
    expect(surviving!['title']).toBe('Backend Engineer');
    expect(surviving!['rawDescription']).toBe('An already saved posting.');
    expect(surviving!['originalUrl']).toBe('https://example.com/jobs/existing');
  });

  it('offers no “Save job” button while a duplicate is showing', async () => {
    seedJob();
    await mount();
    await fillValidForm({ company: 'Acme' });
    await submitImportForm();
    expect(query('[data-action="save-import"]')).toBeNull();
    expect(query('[data-action="save-separately"]')).not.toBeNull();
    // Inspecting the match is offered (read-only, opens the saved listing).
    const link = query('.duplicate-warning a');
    expect(link?.getAttribute('href')).toBe('https://example.com/jobs/existing');
  });
});

describe('a duplicate added between review and save is still caught', () => {
  it('blocks at the final boundary without relying on component state', async () => {
    // The review happens against an EMPTY saved list...
    await mount();
    await fillValidForm({ company: 'Example Ltd' });
    await submitImportForm();
    expect(query('[data-action="save-import"]')).not.toBeNull();
    expect(query('.duplicate-warning')).toBeNull();

    // ...then "another tab" saves the same vacancy BEFORE our write.
    seedJob({ company: 'Example Ltd' });

    await clickText('Save job');

    expect(query('[data-state="import-saved"]')).toBeNull();
    expect(query('.duplicate-warning[data-status="possible"]')).not.toBeNull();
    // Still only the other tab's record — our import was NOT written.
    expect((storedPostings() as unknown[]).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Storage failure is fail-closed                                       */
/* ------------------------------------------------------------------ */

describe('malformed storage fails safely', () => {
  it('explains the failed check, refuses to write, and never replaces the data', async () => {
    const malformed = { junk: true };
    h.backing.set(STORAGE_KEYS.jobPostings, malformed);
    const before = JSON.stringify(malformed);

    await mount();
    await fillValidForm({ company: 'Example Ltd' });
    await submitImportForm();

    const notice = query('.duplicate-warning[data-status="check-failed"]');
    expect(notice).not.toBeNull();
    expect(text()).toContain('Duplicate protection could not run');

    await clickText('Save as a separate record');
    // The storage service refuses to touch unreadable data: the malformed value
    // is reported instead of being silently replaced with an empty list.
    expect(query('[data-state="import-saved"]')).toBeNull();
    expect(query('[data-state="import-error"]')).not.toBeNull();
    expect(text()).toContain('Save failed (malformed)');
    expect(JSON.stringify(h.backing.get(STORAGE_KEYS.jobPostings))).toBe(before);
  });
});
