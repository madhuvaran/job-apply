// @vitest-environment jsdom
/**
 * Options-level Dashboard wiring (Prompt 30 §5, §8.16).
 *
 * Mounts the real Options `App` with storage mocked in memory and proves the
 * dashboard is reachable, marked current, and that its "View job details"
 * action actually lands on the EXISTING Jobs tab with that saved job selected
 * (its match-summary section is rendered) — no new surface, no new permission,
 * no write.
 *
 * jsdom only: this is not a loaded-extension browser test.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../storage';

type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    backing,
    calls,
    browser: {
      storage: {
        local: {
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
        },
      },
    },
  };
});

vi.mock('wxt/browser', () => ({ browser: h.browser }));

import App from '../../../entrypoints/options/App';

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

async function mount(ui: ReactElement) {
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function tabButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('nav.tabs button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no "${label}" tab`);
  return button as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Options → Dashboard tab', () => {
  it('is marked current when opened and shows the local overview', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, {
      schemaVersion: '1',
      postings: [
        {
          id: 'job-a',
          title: 'Backend Engineer',
          company: 'Fake Co',
          rawDescription: 'Synthetic description text.',
          capturedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });

    await mount(createElement(App));
    await click(tabButton('Dashboard'));

    expect(container.querySelector('h1')?.textContent).toBe('Dashboard');
    expect(tabButton('Dashboard').getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[aria-label="Dashboard metrics"]')).not.toBeNull();
    expect(container.textContent).toContain('Prioritized jobs');
    expect(h.calls.set).toBe(0); // read-only
  });

  it('opens a saved job in the existing Jobs tab from "View job details"', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, {
      schemaVersion: '1',
      postings: [
        {
          id: 'job-a',
          title: 'Backend Engineer',
          company: 'Fake Co',
          rawDescription: 'Synthetic description text.',
          capturedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });

    await mount(createElement(App));
    await click(tabButton('Dashboard'));

    const details = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View job details',
    );
    expect(details).toBeDefined();
    await click(details!);

    // Landed on the real Jobs tab, with that job's existing sections opened.
    expect(container.querySelector('h1')?.textContent).toBe('Jobs');
    expect(tabButton('Jobs').getAttribute('aria-current')).toBe('page');
    expect(container.textContent).toContain('Match estimate — Backend Engineer');
    expect(container.textContent).toContain('Saved jobs');
    expect(h.calls.set).toBe(0); // navigating never writes
  });

  it('does not carry a dashboard selection into a later manual Jobs visit', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, {
      schemaVersion: '1',
      postings: [
        {
          id: 'job-a',
          title: 'Backend Engineer',
          company: 'Fake Co',
          rawDescription: 'Synthetic description text.',
          capturedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });

    await mount(createElement(App));
    await click(tabButton('Dashboard'));
    const details = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View job details',
    );
    await click(details!);
    expect(container.textContent).toContain('Match estimate — Backend Engineer');

    // Leaving and re-entering Jobs through the tab itself clears the focus.
    await click(tabButton('Profile'));
    await click(tabButton('Jobs'));
    expect(container.textContent).toContain('Saved jobs');
    expect(container.textContent).not.toContain('Match estimate — Backend Engineer');
  });

  it('makes no network request when the dashboard is opened', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await mount(createElement(App));
    await click(tabButton('Dashboard'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
