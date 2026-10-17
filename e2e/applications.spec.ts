/**
 * Application tracking in the REAL loaded extension (Prompt 31 §5).
 *
 * Uses synthetic job postings and application records written to the real
 * `chrome.storage.local`, then verifies the Applications tab, its filter, the
 * dashboard metrics after Refresh, and that a `planned` record is never shown as
 * submitted. No employer is contacted and nothing is submitted.
 */
import { expect, STORAGE_KEYS, test } from './fixtures';

function posting(id: string, title: string) {
  return {
    id,
    title,
    company: 'Fake Co',
    rawDescription: 'Synthetic description for browser tests.',
    capturedAt: '2026-10-01T00:00:00.000Z',
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

const JOBS = {
  schemaVersion: '1',
  postings: [posting('job-a', 'Backend Engineer'), posting('job-b', 'Data Engineer')],
};

const APPLICATIONS = {
  schemaVersion: '1',
  applications: [
    application('app-1', 'job-a', 'interview'),
    application('app-2', 'job-b', 'planned'),
  ],
};

test.describe('Application tracking (loaded extension)', () => {
  test('renders stored records and filters by status', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: JOBS,
      [STORAGE_KEYS.applications]: APPLICATIONS,
    });
    await ext.reload();
    await ext.openTab('Applications');

    const items = ext.page.locator('.application-item');
    await expect(items).toHaveCount(2);
    await expect(ext.page.locator('[data-application-id="app-1"]')).toContainText(
      'Backend Engineer',
    );
    await expect(ext.page.locator('[data-application-id="app-1"]')).toContainText('Interview');
    await expect(ext.page.locator('[data-application-id="app-2"]')).toContainText('Planned');

    const filter = ext.page.locator('.row').filter({ hasText: 'Filter' }).locator('select');
    await filter.selectOption('interview');
    await expect(ext.page.locator('.application-item')).toHaveCount(1);
    await expect(ext.page.locator('[data-application-id="app-1"]')).toBeVisible();
    await expect(ext.page.locator('[data-application-id="app-2"]')).toHaveCount(0);
  });

  test('dashboard reflects application metrics after Refresh and never calls planned "already applied"', async ({
    ext,
  }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: JOBS,
      [STORAGE_KEYS.applications]: APPLICATIONS,
    });
    await ext.reload();
    await ext.openTab('Dashboard');

    const submitted = ext.page.locator('[data-metric="submitted"] .dashboard-metric-value');
    const interviews = ext.page.locator('[data-metric="interviews"] .dashboard-metric-value');
    await expect(submitted).toHaveText('1'); // the interview only
    await expect(interviews).toHaveText('1');

    // The planned job stays actionable and is labelled as not submitted.
    const plannedRow = ext.page.locator('[data-job-id="job-b"]');
    await expect(plannedRow).toContainText('Planned (not submitted)');
    await expect(plannedRow).toHaveAttribute('data-category', 'needs-review');

    // A second submission written while the dashboard is open appears on Refresh.
    await ext.seed({
      [STORAGE_KEYS.applications]: {
        schemaVersion: '1',
        applications: [
          application('app-1', 'job-a', 'interview'),
          application('app-2', 'job-b', 'planned'),
          // A second submission on a job that is no longer saved: it counts as
          // submitted but does not change the saved job-b's category.
          application('app-3', 'job-orphan', 'applied', { applicationDate: '2026-10-16' }),
        ],
      },
    });
    await ext.page.getByRole('button', { name: 'Refresh dashboard' }).click();
    await expect(submitted).toHaveText('2'); // interview + applied; planned still excluded
    await expect(ext.page.locator('[data-job-id="job-b"]')).toBeVisible();
    await expect(ext.page.locator('[data-field="already-applied-note"]')).toContainText(
      '1 saved job(s) already have',
    );
  });

  test('a status change from the real row control persists and reaches the dashboard', async ({
    ext,
  }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: JOBS,
      [STORAGE_KEYS.applications]: APPLICATIONS,
    });
    await ext.reload();
    await ext.openTab('Applications');

    await ext.page.getByLabel('Status for Data Engineer').selectOption('applied');
    await expect
      .poll(async () => {
        const record = (await ext.read(STORAGE_KEYS.applications)) as {
          applications: Array<{ id: string; status: string }>;
        };
        return record.applications.find((a) => a.id === 'app-2')?.status;
      })
      .toBe('applied');
    // The unrelated record is untouched.
    const record = (await ext.read(STORAGE_KEYS.applications)) as {
      applications: Array<{ id: string; status: string }>;
    };
    expect(record.applications.find((a) => a.id === 'app-1')?.status).toBe('interview');

    await ext.openTab('Dashboard');
    await expect(ext.page.locator('[data-metric="submitted"] .dashboard-metric-value')).toHaveText(
      '2',
    );
    await expect(ext.page.locator('[data-metric="interviews"] .dashboard-metric-value')).toHaveText(
      '1',
    );
  });

  test('saving a job never creates or mutates application records', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: JOBS,
      [STORAGE_KEYS.applications]: APPLICATIONS,
    });
    const before = await ext.read(STORAGE_KEYS.applications);
    await ext.reload();
    await ext.openTab('Jobs');

    await ext.page.getByRole('button', { name: 'Add job manually' }).click();
    await ext.page.locator('.row').filter({ hasText: 'Job title' }).locator('input').fill('New Role');
    await ext.page
      .locator('.row')
      .filter({ hasText: 'Job description' })
      .locator('textarea')
      .fill('Synthetic description for the new role.');
    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.getByRole('status').filter({ hasText: 'Posting saved.' })).toBeVisible();

    // The application log is byte-for-byte unchanged and no record was invented.
    expect(await ext.read(STORAGE_KEYS.applications)).toEqual(before);
    const applications = (await ext.read(STORAGE_KEYS.applications)) as {
      applications: unknown[];
    };
    expect(applications.applications).toHaveLength(2);
  });
});
