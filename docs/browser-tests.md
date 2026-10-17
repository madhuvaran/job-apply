# Loaded-extension browser smoke tests (Playwright)

The `e2e/` suite verifies the **built** Chrome MV3 extension in a real Chromium
process. It is deliberately not a jsdom/React re-mount: the fixture launches
Chromium with `--load-extension` and `--disable-extensions-except` on
`.output/chrome-mv3`, resolves the extension id from the running MV3 service
worker, and drives `chrome-extension://…/options.html` and `…/popup.html`.

## Setup

```bash
npm install
npm run build                 # produces .output/chrome-mv3 (required)
npx playwright install chromium
```

Linux packages may be missing on minimal machines. Either install them once with
root (`npx playwright install-deps chromium`) or unpack the runtime libraries into
a prefix yourself. The fixture uses such a prefix when it finds `libnspr4.so` /
`libnss3.so` in it: `CHROMIUM_SYSROOT` names one explicitly, and
`~/.local/chromium-sysroot` is picked up automatically. It then prepends
`usr/lib/x86_64-linux-gnu` and `lib/x86_64-linux-gnu` to the browser's
`LD_LIBRARY_PATH` and, if present, sets `FONTCONFIG_FILE` /
`FONTCONFIG_PATH` from `etc/fonts`. Nothing is changed on a normal machine where
the system libraries already load. This is how the suite was run in a rootless VM
(plain `npm run test:e2e`, no environment variables).

If Chromium still cannot start, the fixture **fails** every test with the launch
error and the missing library name — a green run always means a real browser ran.

## Run

```bash
npm run test:e2e              # build + full suite
npx playwright test           # suite against the current build
npx playwright test e2e/options-dashboard.spec.ts
npx playwright test -g "duplicate"
```

Tests run serially (`workers: 1`) because extension contexts cannot share a
profile. Each test gets a fresh temporary user-data directory and therefore
fresh `chrome.storage.local`.

## What the fixture guarantees

`e2e/fixtures.ts`:

- fails with an actionable message if `.output/chrome-mv3/manifest.json` is
  missing or if Chromium cannot be launched — the suite never silently skips,
- fails if the extension loads but its MV3 service worker does not start,
- collects `console` errors, `pageerror`, `webError` (unhandled rejections) for
  every page and **fails the test** if any occurred,
- records every page/worker HTTP(S) request and **fails the test** if any
  external request was made,
- exposes `seed` / `read` / `clear` helpers that write synthetic records through
  the extension page's own `chrome.storage.local` (the same storage service the
  UI uses), plus `openTab` / `reload`.

Fixtures are synthetic only (`Test User`, `Fake Co`, fake skills/tokens). No
real profile, resume, application or employer data is used, and no employer is
contacted.

## Coverage

| Spec | Verified |
|---|---|
| `options-dashboard.spec.ts` | Options page boots without errors; six tabs; Dashboard is current; metrics from seeded records; empty state; real match estimate + apply-first row; Refresh re-reads (no polling); View job details opens the existing Jobs tab; Dashboard/Jobs/Profile navigation; malformed jobs reported and never overwritten. |
| `job-import-duplicates.spec.ts` | Manual save writes one posting and no application; validation error; unsafe `javascript:` URL rejected; duplicate warning; Cancel saves nothing; explicit save-separately keeps both records; duplicate introduced while the form is open is caught at the write boundary; malformed storage surfaced, refused and byte-identical. |
| `applications.spec.ts` | Stored applications render with job titles/statuses; status filter; status change persists and reaches the dashboard after navigation; `planned` is labelled not submitted and never "already applied"; saving a job never creates/mutates application records. |
| `resume-export.spec.ts` | PDF download (`%PDF-`, > 1 KB, safe filename, success notice); DOCX download (ZIP/OOXML parts, no tables/drawings/hyperlinks); historical version export uses the stored snapshot, not the edited profile; a failed export shows an error, downloads nothing and reports no success. |
| `popup.spec.ts` | Popup document renders without errors, no form, no network; capture/autofill interaction is recorded as an explicit skip (see limitations). |
| `privacy.spec.ts` | Bundle contains no `app_id`/`app_key`/`api.adzuna.com`/provider-key markers; manifest grants only `storage`, `activeTab`, `scripting` with no host permissions and only the existing `*://*.google.com/*` content script; dashboard/job-save/applications/search workflows issue zero external requests. |

## Known limitations

- **Chromium build only.** The suite runs Playwright's Chromium (156.x during
  Prompt 31) headless. Chrome-stable/headful and Firefox were not exercised;
  Chrome ≥ 137 no longer honours `--load-extension` for sideloading.
- **No toolbar interaction.** Scanning/filling a page requires the `activeTab`
  grant created by a real user click on the extension action. Playwright cannot
  click the browser toolbar, and opening `popup.html` as a tab makes that tab the
  active one. Autofill/capture therefore remain covered by unit tests only and
  are reported as an explicit skip — no live page was filled.
- **No real job sites.** All pages are the extension's own documents; no
  authenticated employer site was accessed and no application was submitted.
- **Downloads are inspected structurally.** The PDF signature/size and the DOCX
  ZIP parts/XML are validated; rendering in Word/LibreOffice or a PDF viewer was
  not tested.
- **Network assertions are request-level** (page/worker requests observed by
  Playwright), not OS-level packet capture. They prove the extension's pages make
  no external request during the tested flows, not that no process on the machine
  ever could.
- Headless Chromium in a rootless container emits benign stderr (dbus, crashpad
  CPU-frequency files); the harness asserts on page/worker console errors, not on
  browser stderr.

## Adding a test

Import `test`/`expect` from `./fixtures`, seed records with `ext.seed`, drive the
real UI, and assert on visible text/roles and on `ext.read(...)` afterwards. Do
not import app internals to shortcut the UI: the point of this suite is the built
artifact. Do not add real data, credentials or network calls to a fixture.
