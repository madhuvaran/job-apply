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
  nothing is guessed. **Estimate match** selects a saved job and renders the
  deterministic match summary (see below): the score is labelled an estimate,
  confidence/completeness and assessable scoring weight appear as separate
  badges, and matched / partial / missing (confirmed) / unknown requirements
  are listed in distinct groups — unknowns are never shown as missing. The
  summary recalculates when you select a different job or when profile,
  posting or settings inputs change; missing profile, missing job, invalid
  input and insufficient data each show an honest message instead of a
  misleading number.

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

## Job match estimate (deterministic, no AI)

`src/lib/matching/` computes a **transparent 0–100 job match estimate** from
saved data only: `calculateJobMatch(profile, job, settings)` compares a saved
JobPosting's structured sections (from deterministic intake extraction) with
the AI-safe master profile and your job settings. It is offline and
deterministic — no network requests, no AI calls, no clock (the posting's own
capture date anchors time math), no storage writes, and it never touches the
sensitive profile, contact details, legal answers or compensation.

**This is our own estimate. It is NOT an employer's ATS score, an interview
probability, or a guarantee.**

### Scoring formula (weights live in one place: `MATCH_WEIGHTS`)

| Factor | Weight | What it measures |
|---|---|---|
| `requiredSkills` | 35 | coverage of skills the posting marks required (`skills[]` + required qualifications) |
| `preferredSkills` | 10 | coverage of "nice to have" skills |
| `experience` | 20 | profile career span vs the posting's stated experience range |
| `roleAlignment` | 20 | 0.6 × job-title token overlap + 0.4 × responsibility lines touching your listed skills |
| `preferences` | 15 | settings compatibility: location, work mode, employment type, experience range |

Score = weighted average over the factors that can actually be assessed;
unknown factors are excluded (weights renormalized), and if less than 40% of
the weight is assessable the result is an explicit **insufficient-data**
outcome instead of a misleading number.

### Honest statuses (per requirement)

- `matched` — verified profile evidence (references returned, never copies).
- `partial` — adjacent evidence (e.g. React Native for React) or partial preference fit.
- `missing` — an affirmative contradiction (education ceiling, career-span
  shortfall, explicit non-overlapping preference).
- `unknown` — insufficient information. **A skill absent from your profile is
  never treated as proof you lack it** — it is `unknown` (and only flagged as
  a *potential* hard issue when the posting marks it required).

Hard-requirement issues are reported separately from the score with three
severities (`confirmed` / `potential` / `unknown`), alongside a data-
completeness confidence indicator (a coverage measure, not a probability) and
the threshold decision. Skill matching is vocabulary-scoped and conservative
(word boundaries; k8s ≡ Kubernetes; "java" never matches "JavaScript"; a
skill mentioned only in raw prose never becomes a requirement). With
`minMatchThreshold = 0` (the default) threshold filtering is off; a positive
threshold is evaluated separately and insufficient data never counts as a
pass.

## Resume tailoring (deterministic, no AI)

`src/lib/resume/tailor.ts` exposes `tailorResume(profile, job)` which selects
and reorders **existing** AI-safe profile content for one saved posting and
returns a strictly validated `tailoredResumeSchema` payload. It is offline
and deterministic: no network, no AI calls, no settings/storage reads, and
the sensitive profile is never loaded — contact details are out of scope here
and belong to the later rendering layer.

Truthfulness rules (unit-tested): every rendered fact traces to a profile
item id (skills/experience/projects/education/certifications/languages are
verbatim copies; bullets and dates are never rewritten); posting skills that
are absent from the profile are never added; a `claimed` skill stays
`claimed`; no metrics or achievements are ever generated. Skills are ranked
by posting relevance (required matches first, then preferred, then profile
order up to a documented fill target); experience keeps its source
(chronological) order with relevance deciding inclusion only; education,
certifications and languages are always included verbatim. Summary uses the
profile's own summary/headline (or a line assembled from selected skill
names) and is omitted when nothing supported exists — empty input yields an
explicit `insufficient` result instead of fabricated content, and invalid
input yields a typed `invalid` result (field paths only, no profile text).

## Resume PDF export (fixed layout, ATS-friendly)

`src/lib/resume/pdf/` renders the validated `TailoredResume` payload to a
single-column, **selectable-text** PDF using `pdf-lib` (MIT, browser-only,
pure JS — no network, no native code, no permissions). `renderResumePdf(input)`
re-validates the input against the SAME strict `tailoredResumeSchema`
(invalid input yields a typed `invalid` result) and returns a `Blob` plus the
page count and a safe filename.

Content integrity: the renderer is a presentation layer only — it never
invents, paraphrases or drops content, and it renders no field outside the
schema (no contact details, evidence ids, relevance/selection metadata or job
text). A4 portrait, conventional margins, standard section headings,
Helvetica, and `Page X of Y` footers. Headings stay with their first item, and
long paragraphs/URLs/long words wrap or split across pages rather than being
clipped. Output is deterministic (identical input → byte-identical PDF). Text
outside the built-in font's repertoire returns a typed `unsupported-characters`
result (reporting only `U+XXXX` code points) instead of a corrupted file.

In **Options → Jobs**, selecting a saved job shows a **Resume PDF** section
with a *Download tailored resume PDF* button (disabled until a profile is
loaded). It runs `tailorResume` → `renderResumePdf` → an isolated download
helper (the temporary object URL is revoked immediately; nothing is stored).
Invalid or insufficient tailoring explains the problem and generates no file.
No AI, no network, no storage writes; the sensitive profile is never read.

Limitations: the built-in Helvetica fonts cover Latin-1 only, so non-Latin
scripts are refused rather than transliterated; there is no in-page PDF
*preview* (the file is downloaded), no template/branding options, and no
bundled custom fonts. Nothing claims the PDF will pass a specific employer's
ATS.

## Application log (local-only, no external service)

The **Applications** tab in Options tracks applications against your saved job
postings. It is entirely local: records live in `chrome.storage.local` under the
versioned key `job-applications.v1` (never sync storage), no network request is
made, the AI provider is never used, and the separate sensitive profile is never
read.

Each application record (`src/lib/applications/`) stores only: a generated
`id`, the referenced saved `jobId`, a `status`, optional `applicationDate`, an
optional `followUpDate`, optional user notes, and `createdAt`/`updatedAt`
timestamps. Records are `.strict()`-validated — no salary, contact details,
credentials or legal answers can be stored. Dates must be real calendar dates
(`YYYY-MM-DD`; impossible dates such as `2026-02-31` are rejected) and notes are
length-capped.

**Status values** (fixed, documented):

| Value | Label |
|---|---|
| `planned` | Planned |
| `applied` | Applied |
| `assessment` | Assessment |
| `interview` | Interview |
| `offer` | Offer |
| `rejected` | Rejected |
| `withdrawn` | Withdrawn |

Behavior:
- **Explicit only** — nothing is auto-marked "applied" by viewing a job,
  generating a resume, or autofilling. You change the status yourself.
- **Create** requires a saved job (the reference is validated before writing);
  **edit** changes status, notes and dates; **delete** uses a two-step
  confirmation.
- **No accidental duplicates** — the one-click *Track application* action in
  the Jobs tab reuses an existing application for the same job; the explicit
  *Add application* form still lets you record a deliberate repeat application.
- **Orphaned references are safe** — if you later delete a saved job posting,
  its application history is kept and shown as "Job posting no longer saved";
  nothing is silently discarded.
- **Integrity** — malformed storage is surfaced (with a recoverable raw value)
  and never overwritten; create/update/delete all refuse to write while the log
  is malformed. Absent, malformed, unavailable and quota states are distinguished.
- **Filter & sort** — filter by status and sort by last updated, application
  date (missing last) or date created; ordering is deterministic.

## Autofill (deterministic foundation, no AI)

`src/lib/autofill/` is the first, conservative autofill foundation. It fills
**only** fields it can classify unambiguously from your saved answers, and it
never contacts an AI provider or the network. It never submits a form, and it
never fills a field without your explicit confirmation.

The engine is split so each part is independently testable:

| Module | Responsibility |
|---|---|
| `schemas.ts` | `.strict()` **value-free** field descriptors, the reviewed fill plan, and the per-field report |
| `classify.ts` | deterministic classification from label / `aria-label` / `name` / `id` / `autocomplete` / input type |
| `plan.ts` | maps recognised fields to explicitly supported saved answers (missing answer → manual entry) |
| `execute.ts` | isolated executor that applies **only** a validated plan |
| `page.ts` | value-free form scanning + the content-script scan/fill messages |

**Supported field types** (mapped to saved data — nothing is invented):

| Field | Saved source |
|---|---|
| First name, last name | sensitive profile `contact` |
| Email, phone | sensitive profile `contact` |
| City | sensitive profile `contact.cityLabel` |
| State/region, country | *recognised but no saved source exists* → reported as "complete manually" |
| LinkedIn URL | profile `linkedin` |
| Portfolio URL | profile `portfolio` |
| Skills | profile `skills` (names joined) |
| Professional summary | profile `summary` |
| Work authorization | sensitive `legal.workAuthorization` — **choice fields only**, and only when not `undisclosed` |
| Sponsorship | sensitive `legal.sponsorshipNeeded` (Yes/No) — **choice fields only** |

**Never filled (excluded categories):** passwords/authentication, one-time and
verification codes, payment/card/bank details, CAPTCHA/bot-detection,
equal-opportunity & voluntary demographics (gender, race, veteran, disability,
religion, sexual orientation, …), compensation/salary, and legal
declarations/consent/attestation. Generic labels ("Name", "Other", "Details",
"Additional information") and any field that is ambiguous or matches more than
one category are left for manual entry with a typed reason.

**How it works (user-confirmed, opt-in):** in the popup, *Autofill this
application form* reads only form-control **metadata** (labels/name/id/
autocomplete/type — never values), shows a review split into *Will fill* and
*Needs manual input*, and fills **only after you click Confirm**. Cancel makes
no changes. A completion summary reports counts, **not** the values. Select,
radio and checkbox fields are filled only on an unambiguous match; disabled,
read-only, hidden and detached fields are skipped. The form is never submitted
and no navigation is triggered.

**Integration limits:** this uses the existing `activeTab` + `scripting`
permission model and the current content-script channel — no new permissions
and no host-permission broadening. **Workday-specific handling and AI-assisted
semantic field mapping are NOT implemented** in this task.

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
model with manual intake, user-triggered current-page capture, the
provider-agnostic AI interface (Prompt 06), the deterministic job match
estimate (Prompt 09 — library + tests; formula above), its match summary UI
in Options → Jobs (Prompt 10), the deterministic resume tailoring engine
(Prompt 11), the fixed-layout ATS-friendly resume PDF export + Options → Jobs
download action (Prompt 12), the local application log + Options → Applications
tab (Prompt 13), and the deterministic autofill foundation (Prompt 14).
**Not yet built: Workday-specific handling, AI-assisted field mapping, and the
deeper application-form automation.**
