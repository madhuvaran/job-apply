/**
 * Loaded-extension fixture (Prompt 31).
 *
 * Launches the real Chromium build with the BUILT extension loaded as an
 * unpacked MV3 extension (`.output/chrome-mv3`), in a throwaway user-data
 * directory, headless. Every test gets a fresh profile and therefore fresh
 * extension storage — no real user data is ever read or written, and nothing
 * outside the temp profile is touched.
 *
 * Captured for every test:
 * - `chrome.runtime` service worker (used to resolve the extension id),
 * - console errors, `pageerror` events and unhandled rejections,
 * - every page/worker request (used to prove no external network traffic).
 *
 * If Chromium is missing, the fixture fails with an actionable message instead
 * of silently skipping — the suite must never look green without a browser.
 */
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** The versioned storage keys the extension itself uses. */
export const STORAGE_KEYS = {
  profile: 'job-profile.v2',
  settings: 'job-settings.v1',
  jobPostings: 'job-postings.v1',
  applications: 'job-applications.v1',
  resumeHistory: 'job-resume-history.v1',
} as const;

export interface ExtensionFixture {
  context: BrowserContext;
  extensionId: string;
  /** The Options page (`options.html`) of the loaded extension. */
  page: Page;
  consoleErrors: string[];
  /** Absolute http(s) requests observed from extension pages/workers. */
  externalRequests: string[];
  /** Seed raw storage records (test fixtures only). */
  seed(items: Record<string, unknown>): Promise<void>;
  /** Read one storage key exactly as stored. */
  read(key: string): Promise<unknown>;
  /** Drop every seeded record. */
  clear(): Promise<void>;
  /** Reload the Options page so components re-read storage on mount. */
  reload(): Promise<void>;
  /** Open a navigation tab and wait for its heading. */
  openTab(label: string): Promise<void>;
}

type ChromeStorage = {
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
      get(key: string): Promise<Record<string, unknown>>;
      clear(): Promise<void>;
    };
  };
};

declare global {
  // eslint-disable-next-line no-var
  var chrome: ChromeStorage | undefined;
}

/**
 * Make a private Chromium runtime available when the host provides one.
 *
 * Chromium needs its system libraries (libnspr4, libnss3, …) on the loader
 * path. On a normal Linux machine they are installed system-wide and this does
 * nothing. On a machine without root they can be unpacked into a prefix
 * instead: `CHROMIUM_SYSROOT` names it explicitly, and
 * `~/.local/chromium-sysroot` is picked up automatically (the layout the docs
 * describe). The prefix is only used when it actually contains the libraries,
 * so a stale or empty directory cannot break an otherwise working machine.
 */
function applyRuntimeEnv(): void {
  if (process.platform !== 'linux') return;
  const libDirs = ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu'];
  const probe = ['libnspr4.so', 'libnss3.so'];
  const candidates = [process.env.CHROMIUM_SYSROOT, path.join(homedir(), '.local', 'chromium-sysroot')]
    .filter((dir): dir is string => typeof dir === 'string' && dir !== '');
  const sysroot = candidates.find((dir) =>
    libDirs.some((sub) => probe.some((name) => existsSync(path.join(dir, sub, name)))),
  );
  if (sysroot === undefined) return;
  const libs = libDirs.map((sub) => path.join(sysroot, sub));
  process.env.LD_LIBRARY_PATH = [...libs, process.env.LD_LIBRARY_PATH ?? '']
    .filter((entry) => entry !== '')
    .join(':');
  const fontsConf = path.join(sysroot, 'etc/fonts/fonts.conf');
  if (existsSync(fontsConf)) process.env.FONTCONFIG_FILE = fontsConf;
  if (!process.env.FONTCONFIG_PATH) process.env.FONTCONFIG_PATH = path.join(sysroot, 'etc/fonts');
}

export const test = base.extend<{ ext: ExtensionFixture }>({
  ext: async ({}, use) => {
    const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
    if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
      throw new Error(
        'Built extension not found at .output/chrome-mv3 — run `npm run build` first.',
      );
    }

    applyRuntimeEnv();
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'job-apply-e2e-'));
    const consoleErrors: string[] = [];
    const externalRequests: string[] = [];
    let context: BrowserContext | null = null;

    try {
      try {
        context = await chromium.launchPersistentContext(userDataDir, {
          channel: 'chromium',
          headless: true,
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-sandbox',
            '--disable-dev-shm-usage',
          ],
        });
      } catch (error) {
        throw new Error(
          'Could not launch the Chromium build with the extension loaded. ' +
            'Install the browser with `npx playwright install chromium` (Linux also needs ' +
            '`npx playwright install-deps chromium`, or set CHROMIUM_SYSROOT). ' +
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const attachPage = (page: Page) => {
        page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
        });
      };
      context.on('page', attachPage);
      context.on('request', (request) => {
        const url = request.url();
        if (/^https?:/i.test(url)) externalRequests.push(url);
      });
      context.on('weberror', (webError) => {
        consoleErrors.push(`unhandled: ${webError.error().message}`);
      });

      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 25_000 }).catch(() => null));
      if (worker === null) {
        throw new Error(
          'The extension loaded but its MV3 background service worker never started; ' +
            'the loaded-extension environment is not healthy.',
        );
      }
      const extensionId = new URL(worker.url()).host;

      const page = await context.newPage();
      attachPage(page);
      await page.goto(`chrome-extension://${extensionId}/options.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('h1')).toHaveText('Master profile');

      const hasStorage = await page.evaluate(() => typeof chrome !== 'undefined');
      if (!hasStorage) throw new Error('chrome.storage is unavailable on the extension page');

      const ext: ExtensionFixture = {
        context,
        extensionId,
        page,
        consoleErrors,
        externalRequests,
        seed: async (items) => {
          await page.evaluate(async (records) => {
            await chrome!.storage.local.set(records);
          }, items);
        },
        read: async (key) => {
          return page.evaluate(async (storageKey) => {
            const result = await chrome!.storage.local.get(storageKey);
            return (result as Record<string, unknown>)[storageKey] ?? null;
          }, key);
        },
        clear: async () => {
          await page.evaluate(async () => {
            await chrome!.storage.local.clear();
          });
        },
        reload: async () => {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await expect(page.locator('h1')).toHaveText('Master profile');
        },
        openTab: async (label) => {
          await page.locator('nav.tabs button', { hasText: label }).click();
          await expect(page.locator('h1')).toHaveText(label === 'Profile' ? 'Master profile' : label);
        },
      };

      await use(ext);
    } finally {
      if (context !== null) await context.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // Every test must finish with a clean console and zero external traffic.
    expect(consoleErrors, `unexpected console/page/worker errors:\n${consoleErrors.join('\n')}`).toEqual([]);
    expect(
      externalRequests,
      `unexpected external HTTP(S) requests:\n${externalRequests.join('\n')}`,
    ).toEqual([]);
  },
});

export { expect };
