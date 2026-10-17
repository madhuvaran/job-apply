/**
 * Resume exports in the REAL loaded extension (Prompt 31 §6).
 *
 * Generates the resume through the actual Options UI, captures the browser
 * downloads, and inspects the bytes: PDF signature + non-empty content, DOCX as
 * a ZIP/OOXML package with the expected parts. A saved version is then exported
 * after the profile changes, proving the historical snapshot is used.
 *
 * The profile is entirely synthetic ("Test User", fake tokens). No real personal
 * data is used, and no file is claimed to render correctly in Word/LibreOffice —
 * only the package structure is verified.
 */
import { readFile } from 'node:fs/promises';
import type { Download, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { expect, STORAGE_KEYS, test, type ExtensionFixture } from './fixtures';

const ORIGINAL_TOKEN = 'ORIGINALPROFILESUMMARYTOKEN';
const EDITED_TOKEN = 'EDITEDPROFILESUMMARYTOKEN';

function fakeProfile(summary: string) {
  return {
    schemaVersion: '2',
    displayName: 'Test User',
    headline: 'Backend Engineer',
    summary,
    locationLabel: 'Fake City',
    skills: [
      { id: 'skill-1', name: 'TypeScript', status: 'claimed' },
      { id: 'skill-2', name: 'React', status: 'claimed' },
    ],
    experience: [
      {
        id: 'exp-1',
        company: 'Acme Fake Co',
        title: 'Backend Engineer',
        bullets: ['Built synthetic services with TypeScript and React.'],
        dates: { start: '2020-01', end: '2024-12' },
      },
    ],
    education: [],
    certifications: [],
    projects: [],
    preferences: { targetTitles: [], targetLocations: [], workModes: [], applicationAnswers: [] },
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const JOB = {
  id: 'job-a',
  title: 'Backend Engineer',
  company: 'Fake Co',
  rawDescription: 'Synthetic role using TypeScript and React.',
  responsibilities: ['Build TypeScript services with React.'],
  requiredQualifications: ['TypeScript', 'React'],
  preferredQualifications: [],
  skills: ['TypeScript', 'React'],
  capturedAt: '2026-10-01T00:00:00.000Z',
};

async function seedResume(ext: ExtensionFixture, summary: string) {
  await ext.seed({
    [STORAGE_KEYS.profile]: fakeProfile(summary),
    [STORAGE_KEYS.jobPostings]: { schemaVersion: '1', postings: [JOB] },
    [STORAGE_KEYS.applications]: { schemaVersion: '1', applications: [] },
  });
}

async function selectJob(page: Page) {
  await page.getByRole('button', { name: 'Estimate match' }).first().click();
  await expect(page.getByText('Resume PDF — Backend Engineer')).toBeVisible();
}

async function downloadBytes(page: Page, button: string): Promise<{ download: Download; bytes: Buffer }> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error(`no download path for ${button}`);
  return { download, bytes: await readFile(path) };
}

function docxPart(bytes: Buffer, part: string): string {
  const entries = unzipSync(new Uint8Array(bytes));
  const file = entries[part];
  if (file === undefined) throw new Error(`missing ${part}`);
  return new TextDecoder().decode(file);
}

test.describe('Resume export (loaded extension)', () => {
  test('downloads a real PDF and a ZIP-based DOCX from the built extension', async ({ ext }) => {
    await seedResume(ext, ORIGINAL_TOKEN);
    await ext.reload();
    await ext.openTab('Jobs');
    await selectJob(ext.page);

    const pdf = await downloadBytes(ext.page, 'Download tailored resume PDF');
    expect(await pdf.download.failure()).toBeNull();
    expect(pdf.download.suggestedFilename()).toMatch(/^resume-backend-engineer-tailored\.pdf$/);
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.bytes.length).toBeGreaterThan(1000);
    await expect(ext.page.getByRole('status').filter({ hasText: 'Resume PDF generated' })).toBeVisible();

    const docx = await downloadBytes(ext.page, 'Download tailored resume DOCX');
    expect(await docx.download.failure()).toBeNull();
    expect(docx.download.suggestedFilename()).toMatch(/^resume-backend-engineer-tailored\.docx$/);
    expect(docx.bytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    const entries = Object.keys(unzipSync(new Uint8Array(docx.bytes)));
    expect(entries).toContain('[Content_Types].xml');
    expect(entries).toContain('_rels/.rels');
    expect(entries).toContain('word/document.xml');

    const xml = docxPart(docx.bytes, 'word/document.xml');
    expect(xml).toContain('Test User');
    expect(xml).toContain(ORIGINAL_TOKEN);
    expect(xml).not.toContain('<!DOCTYPE');
    expect(xml).not.toContain('<!ENTITY');
    // ATS-friendly single-column markup: no tables, drawings or hyperlinks.
    expect(xml).not.toContain('<w:tbl>');
    expect(xml).not.toContain('<w:drawing');
    expect(xml).not.toContain('<w:hyperlink');
  });

  test('exports a historical version from its stored snapshot, not the edited profile', async ({
    ext,
  }) => {
    await seedResume(ext, ORIGINAL_TOKEN);
    await ext.reload();
    await ext.openTab('Jobs');
    await selectJob(ext.page);

    await ext.page.getByRole('button', { name: 'Save version to history' }).click();
    await expect(ext.page.getByRole('button', { name: 'Version saved' })).toBeDisabled();

    // Edit the profile AFTER saving the version.
    await ext.seed({ [STORAGE_KEYS.profile]: fakeProfile(EDITED_TOKEN) });
    await ext.reload();
    await ext.openTab('Jobs');

    const version = ext.page.locator('.resume-version').first();
    await expect(version).toHaveCount(1);
    await version.getByRole('button', { name: 'Open', exact: true }).click();
    const docx = await downloadBytes(ext.page, 'Export DOCX');
    expect(docx.download.suggestedFilename()).toMatch(/\.docx$/);
    const xml = docxPart(docx.bytes, 'word/document.xml');
    expect(xml).toContain(ORIGINAL_TOKEN);
    expect(xml).not.toContain(EDITED_TOKEN);
  });

  test('a failed export reports an error and downloads nothing', async ({ ext }) => {
    // Vertical tab: not representable in an XML 1.0 document.
    await seedResume(ext, `Bad ${String.fromCharCode(11)} character`);
    await ext.reload();
    await ext.openTab('Jobs');
    await selectJob(ext.page);

    let downloaded = false;
    ext.page.once('download', () => {
      downloaded = true;
    });
    await ext.page.getByRole('button', { name: 'Download tailored resume DOCX' }).click();
    await expect(ext.page.locator('.banner-error').filter({ hasText: 'cannot be stored' })).toBeVisible();
    expect(downloaded).toBe(false);
    await expect(ext.page.getByRole('status').filter({ hasText: 'generated' })).toHaveCount(0);
  });
});
