# Job Apply — Chrome extension (WXT + React + TypeScript)

Chrome MV3 extension that (1) tailors a resume per job description from a master
profile and renders a fixed ATS-safe PDF, (2) autofills job application forms with
your saved answers, and (3) logs applications. Under active development.

## Development

```bash
npm install        # install dependencies (also runs `wxt prepare`)
npm run dev        # load-as-you-go development build
npm run build      # production build -> .output/chrome-mv3
npm run compile    # typecheck (tsc --noEmit)
npx vitest run     # unit tests
```

Load the built extension in Chrome: `chrome://extensions` → enable Developer mode →
**Load unpacked** → select `.output/chrome-mv3`.

## Options page

Click the extension's **Options** (right-click the toolbar icon → Options). Three
tabs; everything is stored **locally** via `chrome.storage.local`:

- **Profile** — master profile editor (identity, skills, work history, education,
  certifications, projects, links, explicit application answers). Unsaved changes
  are protected; Save is disabled while invalid; corrupt data is never silently
  overwritten (recovery banner instead); "Seed draft with fake sample" is
  obviously-fake dev data that persists only if you save it.
- **Settings & privacy** — job-search preferences with conservative defaults:
  target titles/locations, remote/hybrid/on-site, employment type, experience
  range, optional salary preference (stays on this device, never sent to an AI
  provider), excluded employers, minimum match threshold (0 = off; it applies to
  our own transparent resume-to-job match estimate — never an employer's
  proprietary ATS score), resume format, and the AI on/off switch (**off by
  default**; the current build makes no network requests at all). The tab renders
  a full privacy explanation of what stays local, what may be sent to a provider
  you configure, and what is never sent. One-time non-destructive import copies
  target preferences from an existing profile.
- **Jobs** — saved job postings (manual entries and page captures) plus manual
  intake: title, company, location, original URL, raw description (preserved
  verbatim), deterministic "Extract sections" for responsibilities /
  qualifications / skills, and optional work arrangement, employment type,
  experience range and compensation exactly as posted. Unknown fields stay blank —
  nothing is guessed.

## Capture current job (popup)

Open the job listing in the tab, click the toolbar icon, then **Capture current
job**. The page is inspected **only after that click** (`activeTab`): the
extension extracts likely title, company, location, URL and the visible job
description from job-related page elements only, shows a preview for correction,
and saves on your explicit confirmation. Cancel writes nothing. Unsupported
pages (browser pages, PDFs) and permission denial fall back to manual intake.
No scraping behind logins, no cookies, no background crawling.

**Best-effort capture targets**: pages exposing `JobPosting` structured data
(JSON-LD) — e.g. Greenhouse, Lever, Workday, Indeed and LinkedIn job pages —
and simple career pages with clear job markup. Login walls and app-heavy
single-page apps may yield little; use manual intake there.

## Permissions

`storage` (validated local data), `activeTab` (current tab only, granted when you
open the popup), `scripting` (inject the capture listener into that one tab on
demand). No host permissions, no remote code, no telemetry.

## Privacy model

Contact details, legal/EEO answers, and compensation are stored in a
**separate** record from your professional profile and are never sent to any
LLM service. Salary preferences in Settings are local-only too. No telemetry, no
external calls in the current build; AI stays off until you enable it (Prompt 06
will add the provider abstraction with a backend-proxy pattern for credentials).

## Status / roadmap

Phased plan lives in `PROGRESS.md`. Done so far: profile + evidence schema,
validated storage service, profile editor, settings & privacy model, job-posting
model with manual intake, and user-triggered current-page capture. **Not yet
implemented: the AI provider abstraction (Prompt 06) — no AI calls exist.**
