// @vitest-environment jsdom
/**
 * Options-level wiring test (Prompt 28).
 *
 * The Job search interface is only useful if the user can actually reach it, so
 * this mounts the real Options `App` (with extension storage mocked in memory)
 * and asserts the new tab exists, switches the panel, marks itself current, and
 * lands on the honest unavailable state — never on fabricated results.
 *
 * No network, no live provider, no real browser extension session.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  return {
    backing,
    browser: {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const wanted = Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const key of wanted) if (backing.has(key)) out[key] = backing.get(key);
            return out;
          },
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) backing.set(key, value);
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) backing.delete(key);
          },
        },
      },
    },
  };
});

vi.mock('wxt/browser', () => ({ browser: h.browser }));

import App from '../../../entrypoints/options/App';
import { JOB_SEARCH_UNAVAILABLE_MESSAGES } from './service';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.backing.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(ui: ReactElement) {
  await act(async () => {
    root.render(ui);
  });
}

function tabButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('nav.tabs button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no "${label}" tab`);
  return button as HTMLButtonElement;
}

describe('Options → Job search tab', () => {
  it('is offered alongside the existing sections', async () => {
    await mount(createElement(App));
    const labels = Array.from(container.querySelectorAll('nav.tabs button')).map((b) => b.textContent);
    expect(labels).toEqual([
      // Dashboard was added ahead of the existing sections (Prompt 30); no
      // existing tab was removed or reordered.
      'Dashboard',
      'Profile',
      'Settings & privacy',
      'Job search',
      'Jobs',
      'Applications',
    ]);
  });

  it('opens the search panel, marks the tab current and shows the honest state', async () => {
    await mount(createElement(App));
    // The profile editor is the default section.
    expect(container.querySelector('form[aria-label="Job search"]')).toBeNull();

    await act(async () => {
      tabButton('Job search').click();
    });

    expect(container.querySelector('h1')?.textContent).toBe('Job search');
    expect(container.querySelector('form[aria-label="Job search"]')).not.toBeNull();
    expect(container.querySelector('nav.tabs button[aria-current="page"]')?.textContent).toBe(
      'Job search',
    );

    // Unavailable — not results, and nothing fabricated.
    expect(container.querySelector('[data-state="unavailable"]')).not.toBeNull();
    expect(container.textContent).toContain(JOB_SEARCH_UNAVAILABLE_MESSAGES['not-configured']);
    expect(container.querySelectorAll('li.search-result')).toHaveLength(0);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it('returns to the profile section when another tab is chosen', async () => {
    await mount(createElement(App));
    await act(async () => {
      tabButton('Job search').click();
    });
    await act(async () => {
      tabButton('Profile').click();
    });
    expect(container.querySelector('form[aria-label="Job search"]')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Master profile');
  });
});
