/**
 * Popup rendering in the REAL loaded extension (Prompt 31 §7).
 *
 * The popup bundle is opened directly at `chrome-extension://<id>/popup.html`
 * (the same document Chrome loads into the action popup) and must render without
 * runtime errors and without any network traffic.
 *
 * LIMITATION (reported, not hidden): scanning/filling a page cannot be driven
 * here. The capture/fill path needs the `activeTab` grant that only a real user
 * invocation of the toolbar action provides; Playwright cannot click the browser
 * toolbar, and opening popup.html as a tab makes the popup itself the active tab.
 * Content-script and autofill SAFETY are covered by the unit/jsdom suites; no
 * claim is made that a live page was filled.
 */
import { expect, test } from './fixtures';

test.describe('Popup (loaded extension)', () => {
  test('renders without runtime errors and makes no network request', async ({ ext }) => {
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(popup.locator('h1')).toHaveText('Job Apply');
    await expect(popup.getByRole('button').first()).toBeVisible();

    // No external request was issued by the popup (the fixture also asserts
    // this globally for every test).
    const resources = await popup.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name),
    );
    for (const url of resources) {
      expect(url.startsWith(`chrome-extension://${ext.extensionId}/`)).toBe(true);
    }
    expect(ext.externalRequests).toEqual([]);

    // No form submission / navigation happened while rendering.
    expect(popup.url()).toContain('/popup.html');
  });

  test('does not expose capture or autofill controls without a page context', async ({ ext }) => {
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(popup.locator('h1')).toHaveText('Job Apply');

    // The popup must not silently fill or submit anything on its own: no form
    // exists in the document and no download/navigation is triggered.
    await expect(popup.locator('form')).toHaveCount(0);
    expect(ext.consoleErrors).toEqual([]);
  });

  // Autofill / capture cannot be exercised without a user-invoked action popup
  // (see the file comment). Recorded as a skipped test so the gap stays visible
  // instead of being mistaken for coverage.
  test.skip('scans and fills a synthetic job page only after explicit confirmation', () => {
    // Requires the real action popup (activeTab grant) — not reproducible in
    // this harness without a browser UI automation surface for the toolbar.
  });
});
