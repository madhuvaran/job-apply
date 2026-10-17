// @vitest-environment jsdom
/**
 * Options → Dashboard panel tests (Prompt 30 §5, §8.12–8.17).
 *
 * jsdom + `react-dom/client` + `act`, with extension storage mocked in memory.
 * Every record is synthetic. These tests mount the real panel and assert the
 * rendered counts come from the stored records, that unreadable storage is shown
 * as unavailable (never 0), that empty states are honest, that the existing
 * navigation targets are wired, and that nothing is written or fetched.
 *
 * A jsdom render is NOT a loaded-extension browser session: no Manifest V3
 * service worker, popup or real page is exercised here.
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

import DashboardPanel from '../../../entrypoints/options/DashboardPanel';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.backing.clear();
  h.calls.get = 0;
  h.calls.set = 0;
  h.calls.remove = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function seedJobs(postings: unknown[]) {
  h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings });
}

function seedApplications(applications: unknown[]) {
  h.backing.set(STORAGE_KEYS.applications, { schemaVersion: '1', applications });
}

function posting(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: `Role ${id}`,
    company: 'Fake Co',
    rawDescription: 'Synthetic description text.',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

function applicationRecord(id: string, jobId: string, status: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    jobId,
    status,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...patch,
  };
}

async function mount(ui: ReactElement) {
  await act(async () => {
    root.render(ui);
  });
  // One extra microtask flush so the parallel storage reads settle.
  await act(async () => {
    await Promise.resolve();
  });
}

function metricState(key: string): string | null {
  return container.querySelector(`[data-metric="${key}"]`)?.getAttribute('data-state') ?? null;
}

function metricText(key: string): string {
  return (
    container.querySelector(`[data-metric="${key}"] .dashboard-metric-value`)?.textContent ?? ''
  );
}

async function clickText(label: string) {
  const buttons = Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent === label,
  );
  if (buttons.length === 0) throw new Error(`no "${label}" button`);
  await act(async () => {
    buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Dashboard metrics from stored records', () => {
  it('renders the real counts, shortlist and application status', async () => {
    seedJobs([posting('job-a'), posting('job-b')]);
    seedApplications([
      // A planned record is NOT a submission…
      applicationRecord('app-1', 'job-b', 'planned'),
      // …while an interview on a job that is no longer saved still counts.
      applicationRecord('app-2', 'job-orphan', 'interview'),
    ]);
    const onNavigate = vi.fn();

    await mount(createElement(DashboardPanel, { onNavigate }));

    expect(metricText('savedJobs')).toBe('2');
    expect(metricText('reviewJobs')).toBe('2');
    expect(metricText('applyFirst')).toBe('0');
    expect(metricText('goodMatch')).toBe('0');
    expect(metricText('submitted')).toBe('1');
    expect(metricText('interviews')).toBe('1');
    expect(metricText('offers')).toBe('0');
    expect(metricText('upcomingFollowUps')).toBe('0');
    for (const key of ['savedJobs', 'reviewJobs', 'applyFirst', 'goodMatch']) {
      expect(metricState(key)).toBe('value');
    }

    // No profile is stored, so no match estimate exists — the rows say so
    // instead of showing an invented score.
    const rows = container.querySelectorAll('.dashboard-job');
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('No match estimate available');
    // The applied job carries its real application status.
    const plannedRow = Array.from(rows).find(
      (row) => row.getAttribute('data-job-id') === 'job-b',
    );
    // Planned is labelled as not submitted — it never reads as an application.
    expect(plannedRow?.textContent).toContain('Planned (not submitted)');
    // No fabricated metric or claim leaks into the page.
    expect(container.textContent).not.toMatch(/probability|ATS score|applicants/i);
  });

  it('writes nothing and makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    seedJobs([posting('job-a')]);
    seedApplications([]);
    await mount(createElement(DashboardPanel, { onNavigate: vi.fn() }));
    expect(h.calls.set).toBe(0);
    expect(h.calls.remove).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reads each source once on mount and only again on Refresh (no polling)', async () => {
    seedJobs([posting('job-a')]);
    await mount(createElement(DashboardPanel, { onNavigate: vi.fn() }));
    const afterMount = h.calls.get;
    expect(afterMount).toBe(4); // jobs, applications, profile, settings
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(h.calls.get).toBe(afterMount); // nothing polls in the background

    await clickText('Refresh dashboard');
    expect(h.calls.get).toBe(afterMount * 2);
  });
});

describe('Empty states', () => {
  it('reports a genuinely empty store as 0 and offers a real next action', async () => {
    const onNavigate = vi.fn();
    await mount(createElement(DashboardPanel, { onNavigate }));

    expect(metricText('savedJobs')).toBe('0');
    expect(metricText('submitted')).toBe('0');
    expect(container.textContent).toContain('No saved jobs to prioritize yet');
    expect(container.textContent).toContain('No application history yet');
    expect(container.querySelectorAll('.dashboard-job').length).toBe(0);

    await clickText('Add a job');
    expect(onNavigate).toHaveBeenCalledWith('jobs');
  });

  it('explains an all-applied shortlist instead of showing an empty list', async () => {
    seedJobs([posting('job-a')]);
    seedApplications([applicationRecord('app-1', 'job-a', 'applied')]);
    await mount(createElement(DashboardPanel, { onNavigate: vi.fn() }));

    expect(metricText('reviewJobs')).toBe('0');
    expect(metricText('submitted')).toBe('1');
    expect(container.textContent).toContain('Nothing to act on right now');
    expect(container.textContent).toContain('already applied');
  });
});

describe('Malformed and partial storage (§8.14–8.15)', () => {
  it('shows an error and unavailable metrics (not zeros) for malformed jobs', async () => {
    h.backing.set(STORAGE_KEYS.jobPostings, { schemaVersion: '1', postings: 'not-a-list' });
    seedApplications([applicationRecord('app-1', 'job-a', 'offer')]);

    await mount(createElement(DashboardPanel, { onNavigate: vi.fn() }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Saved jobs could not be read',
    );
    for (const key of ['savedJobs', 'reviewJobs', 'applyFirst', 'goodMatch']) {
      expect(metricState(key)).toBe('unavailable');
      expect(metricText(key)).toBe('Unavailable');
    }
    // Partial data: the readable application log is still counted honestly.
    expect(metricText('submitted')).toBe('1');
    expect(metricText('offers')).toBe('1');
    expect(container.querySelector('[data-field="shortlist-unavailable"]')).not.toBeNull();
    // Malformed storage is never overwritten by a read path.
    expect(h.backing.get(STORAGE_KEYS.jobPostings)).toEqual({
      schemaVersion: '1',
      postings: 'not-a-list',
    });
    expect(h.calls.set).toBe(0);
  });

  it('marks only the application metrics unavailable when the log is malformed', async () => {
    seedJobs([posting('job-a')]);
    h.backing.set(STORAGE_KEYS.applications, { schemaVersion: '1', applications: 'not-a-list' });

    await mount(createElement(DashboardPanel, { onNavigate: vi.fn() }));

    expect(metricText('savedJobs')).toBe('1');
    for (const key of ['submitted', 'interviews', 'offers', 'upcomingFollowUps']) {
      expect(metricState(key)).toBe('unavailable');
    }
    // Fail closed: no job is called apply-first while applications are unknown.
    expect(metricText('applyFirst')).toBe('0');
    expect(metricText('reviewJobs')).toBe('1');
    expect(container.textContent).toContain('application log could not be read');
  });
});

describe('Navigation to existing functionality (§8.16)', () => {
  it('opens a job in the Jobs tab and reaches the existing tabs', async () => {
    seedJobs([posting('job-a')]);
    seedApplications([]);
    const onNavigate = vi.fn();
    await mount(createElement(DashboardPanel, { onNavigate }));

    await clickText('View job details');
    expect(onNavigate).toHaveBeenCalledWith('jobs', 'job-a');

    await clickText('Open applications');
    expect(onNavigate).toHaveBeenCalledWith('applications');

    await clickText('Job search');
    expect(onNavigate).toHaveBeenCalledWith('search');

    await clickText('Settings & privacy');
    expect(onNavigate).toHaveBeenCalledWith('settings');

    // Only real tabs are targeted — never an external URL.
    for (const [target] of onNavigate.mock.calls) {
      expect(['jobs', 'applications', 'search', 'settings']).toContain(target);
    }
    // The dashboard's own copy never claims live results.
    expect(container.textContent).toContain('does not search the web');
  });
});
