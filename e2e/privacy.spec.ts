/**
 * Privacy / network assertions for the REAL build (Prompt 31 §8).
 *
 * Static checks read the shipped artifact, not the source tree:
 * - no credentials or provider endpoints in the bundle,
 * - the manifest grants only `storage`, `activeTab`, `scripting` (no hosts).
 * Runtime checks drive the local workflows and prove the pages issue no
 * external HTTP(S) requests — no Adzuna, no AI provider, no telemetry.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';

const BUILD_DIR = path.resolve(process.cwd(), '.output/chrome-mv3');

async function bundleText(): Promise<string> {
  const files = await readdir(BUILD_DIR, { recursive: true, withFileTypes: true });
  const parts: string[] = [];
  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!/\.(js|html|css|json)$/i.test(entry.name)) continue;
    const full = path.join(entry.parentPath ?? BUILD_DIR, entry.name);
    parts.push(await readFile(full, 'utf8'));
  }
  return parts.join('\n');
}

test.describe('Build, permissions and privacy', () => {
  test('ships no credentials or provider endpoints', async () => {
    const text = await bundleText();
    for (const forbidden of [
      'api.adzuna.com',
      'app_id',
      'app_key',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'sk-ant-',
      'x-api-key',
    ]) {
      expect(text, `bundle must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('manifest grants only the documented permissions', async () => {
    const manifest = JSON.parse(await readFile(path.join(BUILD_DIR, 'manifest.json'), 'utf8')) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: Array<{ matches?: string[] }>;
    };
    expect(manifest.permissions?.sort()).toEqual(['activeTab', 'scripting', 'storage']);
    expect(manifest.host_permissions ?? []).toEqual([]);
    const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
    expect(matches).toEqual(['*://*.google.com/*']);
    expect(matches).not.toContain('<all_urls>');
  });

  test('local workflows make no external request at runtime', async ({ ext }) => {
    await ext.openTab('Dashboard');
    await expect(ext.page.locator('[aria-label="Dashboard metrics"]')).toBeVisible();

    await ext.openTab('Jobs');
    await ext.page.getByRole('button', { name: 'Add job manually' }).click();
    await ext.page.locator('.row').filter({ hasText: 'Job title' }).locator('input').fill('Privacy Role');
    await ext.page
      .locator('.row')
      .filter({ hasText: 'Job description' })
      .locator('textarea')
      .fill('Synthetic description for the privacy check.');
    await ext.page.getByRole('button', { name: 'Save posting' }).click();
    await expect(ext.page.getByRole('status').filter({ hasText: 'Posting saved.' })).toBeVisible();

    await ext.openTab('Applications');
    await ext.openTab('Job search'); // live search is unavailable → no request
    await expect(ext.page.locator('[data-state="unavailable"]')).toBeVisible();

    // The fixture captured every page/worker request; none left the extension —
    // so nothing could reach Adzuna, an AI provider or a telemetry endpoint.
    for (const url of ext.externalRequests) {
      expect(url).not.toMatch(/adzuna|openai|anthropic|openrouter/i);
    }
    expect(ext.externalRequests).toEqual([]);

    // Within the page itself, every fetched resource is an extension resource.
    const resources = await ext.page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name),
    );
    // (Chromium may report an empty timing buffer in headless; every entry that
    // IS reported must still be an extension resource.)
    for (const url of resources) {
      expect(url.startsWith(`chrome-extension://${ext.extensionId}/`)).toBe(true);
    }
  });
});
