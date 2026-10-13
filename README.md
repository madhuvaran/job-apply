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

## AI provider interface (backend-proxy pattern)

`src/lib/ai/` is a provider-agnostic AI layer. Nothing in the extension talks
to Anthropic/OpenAI/… directly and **no API keys are stored in the extension** —
not in code, not in `chrome.storage`, not in the manifest:

```
extension (runAiRequest) ──JSON POST──> your backend ──> AI vendor API
   no keys, no secrets                  holds the vendor key,
   strict zod on both sides             returns zod-validated JSON
```

How it works:

- **One entry point**: `runAiRequest(provider, { task, job, profile, settings })`
  returns a typed discriminated result — `{ kind: 'ok' }`, `{ kind: 'fallback' }`
  or `{ kind: 'error' }` — and **never throws for expected failures**.
- **Strict schemas both ways**: `aiRequestSchema` / `aiResponseSchema`
  (`.strict()`) validate the outgoing payload and the backend's response.
  Unknown or extra fields (including a credential field) fail validation and
  surface as a typed `invalid-request` / `invalid-response` error.
- **Payload safety chokepoint**: every outgoing request is built by
  `buildAiRequest()`, which projects settings through `settingsForProvider()`
  (strips `salary`) and embeds only the AI-safe profile (`job-profile.v2`).
  The sensitive profile (contact, legal/EEO, documents) and compensation are
  structurally excluded — tests assert they can never appear on the wire.
- **AI off = zero network**: `aiEnabled` defaults to `false`. When it is off,
  `runAiRequest` returns the local fallback (the candidate's own stored
  content, verbatim — nothing generated) and the provider is never invoked.
- **Timeouts & rate limits**: each attempt has a per-attempt timeout (default
  15 s) that aborts the request via `AbortSignal`. HTTP 429s and transient
  failures (5xx/network/timeout) are retried up to 3 attempts with exponential
  backoff, honoring `Retry-After`. Other 4xx errors fail immediately with a
  typed `{ kind: 'http', status }` error.
- **Providers**: `createProxyProvider({ endpoint })` (production transport —
  its options are strict and have *no* API-key field) and
  `createMockProvider()` (offline, scriptable, for tests).

Your backend must (1) hold the vendor API key as a server-side secret,
(2) translate the `AiRequest` JSON into the vendor's prompt format,
(3) return JSON matching the response contract below, and (4) send CORS
headers allowing the extension's `chrome-extension://` origin — that is all
the extension needs, so **no host permission is added to the manifest**.

Response contract (strict):

```json
{
  "schemaVersion": "1",
  "task": "tailor-resume",
  "content": "…model-produced text…",
  "provider": "your-backend",
  "model": "vendor-model-name",
  "usage": { "inputTokens": 1200, "outputTokens": 400 }
}
```

`model` and `usage` are optional; every other key is required and no extra
keys are allowed. The extension makes no request at all until you enable AI
in Settings & privacy *and* wire a backend endpoint — with AI off (the
default) the current build still performs zero network requests.

## Permissions

`storage` (validated local data), `activeTab` (current tab only, granted when you
open the popup), `scripting` (inject the capture listener into that one tab on
demand). No host permissions, no remote code, no telemetry.

## Privacy model

Contact details, legal/EEO answers, and compensation are stored in a
**separate** record from your professional profile and are never sent to any
LLM service. Salary preferences in Settings are local-only too, and every
outgoing AI payload is projected through `settingsForProvider()` as a second
layer of defense. No telemetry, no analytics. AI stays **off by default**:
while it is off the extension makes zero network requests (verified by unit
tests). When you do enable it, requests go only to the backend endpoint you
configure — provider credentials live on that backend, never in this
extension (see the backend-proxy pattern above).

## Status / roadmap

Phased plan lives in `PROGRESS.md`. Done so far: profile + evidence schema,
validated storage service, profile editor, settings & privacy model, job-posting
model with manual intake, user-triggered current-page capture, and the
provider-agnostic AI interface (Prompt 06: strict request/response schemas,
timeouts, rate-limit retries, no-AI fallback, mock provider, backend-proxy
docs). **Not yet wired into features: no UI/feature calls the AI interface yet
— tailoring and match estimate come next.**
