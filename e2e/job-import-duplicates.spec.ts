/**
 * Job intake + duplicate protection in the REAL loaded extension (Prompt 31 §4).
 *
 * Drives the actual Options → Jobs form (`Add job manually`) against the built
 * extension and inspects `chrome.storage.local` afterwards. Covers visible
 * validation, unsafe URLs, the duplicate warning, the re-check immediately
 * before the write (a duplicate added while the form is open), explicit
 * save-separately, cancel, and malformed storage that must never be replaced.
 *
 * All data is synthetic; nothing is submitted or sent anywhere.
 */
import type { Page } from '@playwright/test';
import { expect, STORAGE_KEYS, test } from './fixtures';

const JOB_URL = 'https://example.com/jobs/1';

function posting(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: 'Backend Engineer',
    company: 'Fake Co',
    rawDescription: 'Synthetic description for browser tests.',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

function field(page: Page, label: string) {
  return page.locator('.row').filter({ hasText: label }).first().locator('input, textarea').first();
}

async function openAddForm(page: Page) {
  await page.getByRole('button', { name: 'Add job manually' }).click();
  await expect(page.getByRole('button', { name: 'Save posting' })).toBeVisible();
}

async function fillNewJob(
  page: Page,
  options: { title?: string; company?: string; url?: string; description?: string } = {},
) {
  await field(page, 'Job title').fill(options.title ?? 'Backend Engineer');
  if (options.company !== undefined) await field(page, 'Company').fill(options.company);
  if (options.url !== undefined) await field(page, 'Original URL').fill(options.url);
  await field(page, 'Job description').fill(
    options.description ?? 'Synthetic description typed by the browser test.',
  );
}

async function storedPostings(ext: { read(key: string): Promise<unknown> }) {
  const record = (await ext.read(STORAGE_KEYS.jobPostings)) as {
    postings?: unknown[];
  } | null;
  return record?.postings ?? [];
}

test.describe('Job intake and duplicate protection (loaded extension)', () => {
  test('saves a valid job through the real form without creating an application', async ({ ext }) => {
    await ext.openTab('Jobs');
    await openAddForm(ext.page);
    await fillNewJob(ext.page, { company: 'Fake Co' });

    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.getByRole('status').filter({ hasText: 'Posting saved.' })).toBeVisible();
    await expect(ext.page.locator('.job-item')).toHaveCount(1);
    await expect(ext.page.locator('.job-item')).toContainText('Backend Engineer');

    const postings = await storedPostings(ext);
    expect(postings).toHaveLength(1);
    // Importing a job never creates an application record.
    expect(await ext.read(STORAGE_KEYS.applications)).toBeNull();
  });

  test('blocks invalid input and an unsafe URL with a visible error', async ({ ext }) => {
    await ext.openTab('Jobs');
    await openAddForm(ext.page);

    // Missing title (the description alone is not enough).
    await field(ext.page, 'Job description').fill('Synthetic description only.');
    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.getByRole('alert')).toContainText('Fix before saving');
    expect(await storedPostings(ext)).toHaveLength(0);

    // Unsafe URL scheme: rejected by the same schema storage enforces.
    await field(ext.page, 'Job title').fill('Backend Engineer');
    await field(ext.page, 'Original URL').fill('javascript:alert(1)');
    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.getByRole('alert')).toContainText('originalUrl');
    expect(await storedPostings(ext)).toHaveLength(0);
  });

  test('warns about an existing duplicate, and Cancel saves nothing', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-existing', { originalUrl: JOB_URL })],
      },
    });
    await ext.reload();
    await ext.openTab('Jobs');
    await openAddForm(ext.page);
    await fillNewJob(ext.page, { url: JOB_URL });

    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    const warning = ext.page.locator('.duplicate-warning[data-status="confirmed"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('same canonical URL');
    expect(await storedPostings(ext)).toHaveLength(1);

    // Cancelling the form leaves storage exactly as it was.
    await ext.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(ext.page.getByRole('button', { name: 'Add job manually' })).toBeVisible();
    const postings = await storedPostings(ext);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ id: 'job-existing', originalUrl: JOB_URL });
  });

  test('Save as a separate record is explicit and keeps both records', async ({ ext }) => {
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-existing', { originalUrl: JOB_URL })],
      },
    });
    await ext.reload();
    await ext.openTab('Jobs');
    await openAddForm(ext.page);
    await fillNewJob(ext.page, { url: JOB_URL });
    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.locator('.duplicate-warning[data-status="confirmed"]')).toBeVisible();

    await ext.page.getByRole('button', { name: 'Save as a separate record' }).click();
    await expect(ext.page.getByRole('status').filter({ hasText: 'Posting saved.' })).toBeVisible();

    const postings = (await storedPostings(ext)) as Array<{ id: string; originalUrl?: string }>;
    expect(postings).toHaveLength(2);
    const ids = postings.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    // The original record was neither merged nor rewritten.
    expect(postings).toContainEqual(
      expect.objectContaining({ id: 'job-existing', originalUrl: JOB_URL }),
    );
  });

  test('re-checks duplicates immediately before the write (duplicate added while the form is open)', async ({
    ext,
  }) => {
    await ext.openTab('Jobs');
    await openAddForm(ext.page);
    await fillNewJob(ext.page, { url: JOB_URL });

    // Another tab saves the same posting while this form is still open.
    await ext.seed({
      [STORAGE_KEYS.jobPostings]: {
        schemaVersion: '1',
        postings: [posting('job-other-tab', { originalUrl: JOB_URL })],
      },
    });

    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.locator('.duplicate-warning[data-status="confirmed"]')).toBeVisible();
    // Nothing was written on top of the other tab's record.
    const postings = await storedPostings(ext);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ id: 'job-other-tab' });
  });

  test('malformed storage is surfaced, refuses writes and is never replaced', async ({ ext }) => {
    const malformed = { schemaVersion: '1', postings: 'not-a-list' };
    await ext.seed({ [STORAGE_KEYS.jobPostings]: malformed });
    await ext.reload();
    await ext.openTab('Jobs');

    await expect(ext.page.getByRole('alert').first()).toContainText('malformed');
    expect(await ext.read(STORAGE_KEYS.jobPostings)).toEqual(malformed);

    await openAddForm(ext.page);
    await fillNewJob(ext.page);
    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    // The pre-write check could not read the list → explicit notice, no write.
    await expect(ext.page.locator('.duplicate-warning[data-status="check-failed"]')).toBeVisible();
    expect(await ext.read(STORAGE_KEYS.jobPostings)).toEqual(malformed);

    // Even the explicit override cannot bypass record validation on write.
    await ext.page.getByRole('button', { name: 'Save anyway' }).click();
    await expect
      .poll(async () => ext.read(STORAGE_KEYS.jobPostings))
      .toEqual(malformed);
    await expect(ext.page.locator('.banner-error').filter({ hasText: 'Save failed' })).toBeVisible();
  });
});
