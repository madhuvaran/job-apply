import { defineConfig } from '@playwright/test';

/**
 * Loaded-extension smoke tests (Prompt 31).
 *
 * These tests are NOT unit tests: `e2e/fixtures.ts` launches the PLAYWRIGHT
 * CHROMIUM build with `--load-extension` on the real `.output/chrome-mv3` build
 * and drives `chrome-extension://` pages, so the real bundling, manifest,
 * storage service and service worker are exercised.
 *
 * Setup:
 *   npm run build            # produces .output/chrome-mv3
 *   npx playwright install chromium
 *   npm run test:e2e
 *
 * On a machine without root (or without Chromium's system libraries), set
 * `CHROMIUM_SYSROOT` to a directory containing the `usr/lib/x86_64-linux-gnu`
 * runtime libraries; the fixture adds it to the browser's `LD_LIBRARY_PATH`.
 *
 * Extensions cannot run in parallel contexts, so tests run serially.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
});
