/**
 * Options → Dashboard, verified in the REAL loaded extension (Prompt 31 §3).
 *
 * These tests drive the built `options.html` inside Chromium with the unpacked
 * MV3 extension loaded. They prove the dashboard renders from records actually
 * written to `chrome.storage.local`, that Refresh re-reads them, and that its
 * navigation opens the existing Jobs/Profile surfaces. All data is synthetic.
 */
import { expect, STORAGE_KEYS, test } from './fixtures';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(
  TODAY.getDate(),
).padStart(2, '0')}`;

function posting(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: `Role ${id}`,
    company: 'Fake Co',
    rawDescription: 'Synthetic description for browser tests.',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

function application(id: string, jobId: string, status: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    jobId,
    status,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...patch,
  };
}

function metric(page: import('@playwright/test').Page, key: string) {
  return page.locator(`[data-metric="${key}"] .dashboard-metric-value`);
}

test.describe('Options → Dashboard (loaded extension)', () => {
  test('opens without runtime errors and shows honest empty states', async ({ ext }) => {
    await ext.openTab('Dashboard');

    expect(await ext.page.locator('nav.tabs button').allTextContents()).toEqual([
      'Dashboard',
      'Profile',
      'Settings & privacy',
      'Job search',
      'Jobs',
      'Applications',
    ]);
    await expect(
      ext.page.locator('nav.tabs').getByRole('button', { name: 'Dashboard', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(ext.page.locator('[aria-label="Dashboard metrics"]')).toBeVisible();

    // Empty storage is a REAL zero, never an unavailable/fabricated value.
    await expect(metric(ext.page, 'savedJobs')).toHaveText('0');
    await expect(metric(ext.page, 'submitted')).toHaveText('0');
    await expect(metric(ext.page, 'interviews')).toHaveText('0');
    await expect(ext.page.getByText('No saved jobs to prioritize yet')).toBeVisible();
    await expect(ext.page.getByText('No application history yet')).toBeVisible();
    await expect(ext.page.locator('[data-field="shortlist-unavailable"]')).toHaveCount(0);
  });

  test('derives metrics from records actually written to extension storage', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-a'), posting('job-b')],
      },
      [STORAGE_KEYS.applications]: {
        schemaVersion: '1',
        applications: [
          application('app-1', 'job-b', 'planned'),
          application('app-2', 'job-orphan', 'interview'),
        ],
      },
    });
    await ext.reload();
    await ext.openTab('Dashboard');

    await expect(metric(ext.page, 'savedJobs')).toHaveText('2');
    await expect(metric(ext.page, 'reviewJobs')).toHaveText('2');
    // `planned` is not a submission; the orphaned interview record still counts.
    await expect(metric(ext.page, 'submitted')).toHaveText('1');
    await expect(metric(ext.page, 'interviews')).toHaveText('1');
    await expect(metric(ext.page, 'offers')).toHaveText('0');

    // Two actionable rows (no profile → no estimate), and the planned record is
    // labelled as NOT submitted.
    const rows = ext.page.locator('.dashboard-job');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('No match estimate available');
    await expect(ext.page.locator('[data-job-id="job-b"]')).toContainText('Planned (not submitted)');
    await expect(ext.page.getByText('No application history yet')).toHaveCount(0);
  });

  test('computes a real match estimate and an apply-first row from a stored profile', async ({ ext }) => {
    const profile = {
      schemaVersion: '2',
      displayName: 'Test User',
      headline: 'Backend Engineer',
      summary: 'Fake summary for browser tests.',
      locationLabel: 'Fake City',
      skills: [
        { id: 'skill-1', name: 'TypeScript', status: 'claimed' },
        { id: 'skill-2', name: 'React', status: 'claimed' },
      ],
      experience: [],
      education: [],
      certifications: [],
      projects: [],
      preferences: {
        targetTitles: [],
        targetLocations: [],
        workModes: [],
        applicationAnswers: [],
      },
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    await ext.seed({
      [STORAGE_KEYS.profile]: profile,
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [
          posting('job-fresh', {
            title: 'Backend Engineer',
            postedDate: TODAY_ISO,
            rawDescription:
              'We need TypeScript and React for this synthetic backend role. Both are required.',
            responsibilities: ['Build and review TypeScript services with React.'],
            requiredQualifications: ['TypeScript', 'React'],
            preferredQualifications: [],
            skills: ['TypeScript', 'React'],
          }),
        ],
      },
      [STORAGE_KEYS.applications]: { schemaVersion: '1', applications: [] },
    });
    await ext.reload();
    await ext.openTab('Dashboard');

    const row = ext.page.locator('[data-job-id="job-fresh"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/\d+ \/ 100 estimate/);
    await expect(row).toHaveAttribute('data-category', 'apply-first');
    await expect(row).toContainText('Apply first');
    await expect(metric(ext.page, 'applyFirst')).toHaveText('1');
    await expect(metric(ext.page, 'goodMatch')).toHaveText('0');
    await expect(metric(ext.page, 'reviewJobs')).toHaveText('0');
  });

  test('Refresh re-reads storage and updates the visible counts', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: { schemaVersion: '1', postings: [posting('job-a')] },
    });
    await ext.reload();
    await ext.openTab('Dashboard');
    await expect(metric(ext.page, 'savedJobs')).toHaveText('1');

    // Write directly to storage while the dashboard is open (test fixture only).
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-a'), posting('job-b')],
      },
    });
    await expect(metric(ext.page, 'savedJobs')).toHaveText('1'); // no polling
    await ext.page.getByRole('button', { name: 'Refresh dashboard' }).click();
    await expect(metric(ext.page, 'savedJobs')).toHaveText('2');
  });

  test('View job details opens that saved job in the existing Jobs tab', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-a', { title: 'Backend Engineer' })],
      },
    });
    await ext.reload();
    await ext.openTab('Dashboard');

    await ext.page.getByRole('button', { name: 'View job details' }).first().click();
    await expect(ext.page.locator('h1')).toHaveText('Jobs');
    await expect(ext.page.getByRole('button', { name: 'Jobs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(ext.page.getByText('Match estimate — Backend Engineer')).toBeVisible();
  });

  test('switching Dashboard, Jobs and Profile preserves expected navigation', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-a', { title: 'Backend Engineer' })],
      },
    });
    await ext.reload();
    await ext.openTab('Dashboard');
    await ext.page.getByRole('button', { name: 'View job details' }).first().click();
    await expect(ext.page.getByText('Match estimate — Backend Engineer')).toBeVisible();

    // Profile and back to Dashboard: no stale focus, dashboard still renders.
    await ext.openTab('Profile');
    await expect(ext.page.locator('.options-header h1')).toHaveText('Master profile');
    await ext.openTab('Dashboard');
    await expect(ext.page.locator('[aria-label="Dashboard metrics"]')).toBeVisible();

    // Entering Jobs through the TAB (not the dashboard action) starts clean.
    await ext.openTab('Jobs');
    await expect(ext.page.getByRole('heading', { name: 'Saved jobs' })).toBeVisible();
    await expect(ext.page.getByText('Match estimate — Backend Engineer')).toHaveCount(0);
  });

  test('malformed job storage is reported and never overwritten', async ({ ext }) => {
    const malformed = { schemaVersion: '1', postings: 'not-a-list' };
    await ext.seed({ [STORAGE_KEYS.jobPostings]: malformed });
    await ext.reload();
    await ext.openTab('Dashboard');

    await expect(ext.page.getByRole('alert').first()).toContainText('Saved jobs could not be read');
    await expect(ext.page.locator('[data-metric="savedJobs"]')).toHaveAttribute(
      'data-state',
      'unavailable',
    );
    await expect(metric(ext.page, 'savedJobs')).toHaveText('Unavailable');
    await expect(ext.page.locator('[data-field="shortlist-unavailable"]')).toBeVisible();

    expect(await ext.read(STORAGE_KEYS.jobPostings)).toEqual(malformed);
  });
});
