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
  experience range, compensation exactly as posted and the optional **posting
  date**. Unknown fields stay blank — nothing is guessed. The form's date field
  can be set, corrected or cleared; a blank date is stored as **unknown**, never
  filled in from the capture time, and saved jobs show a readable local date or
  **"Posting date unknown"**. A saved date after today is flagged
  **“Future posting date — verify”** rather than presented as fresh. Nothing
expires and nothing is sorted by freshness (no prioritization feature exists). **Estimate match** selects a saved job and renders the
  deterministic match summary (see below): the score is labelled an estimate,
  confidence/completeness and assessable scoring weight appear as separate
  badges, and matched / partial / missing (confirmed) / unknown requirements
  are listed in distinct groups — unknowns are never shown as missing. The
  summary recalculates when you select a different job or when profile,
  posting or settings inputs change; missing profile, missing job, invalid
  input and insufficient data each show an honest message instead of a
  misleading number. The resume section under a selected job downloads a
  tailored **PDF or Word (.docx)** file, or explicitly saves a fixed snapshot
  to the local **resume version history** (see below); the history list is
  always visible under it.

## Capture current job (popup)

Open the job listing in the tab, click the toolbar icon, then **Capture current
job**. The page is inspected **only after that click** (`activeTab`): the
extension extracts likely title, company, location, URL and the visible job
description from job-related page elements only, shows a preview for correction,
and saves on your explicit confirmation. Cancel writes nothing. Unsupported
pages (browser pages, PDFs) and permission denial fall back to manual intake.
No scraping behind logins, no cookies, no background crawling.

**Posting date (optional):** when the page *explicitly publishes* one, the
capture reads it from narrow, trusted-in-context job metadata only — JSON-LD
`JobPosting.datePosted` and `itemprop="datePosted"` microdata (the machine-
readable `datetime`/`content` value, or an element whose text is a strict ISO
date). A strict ISO date is required; a date-time contributes its calendar date
**exactly as written** (no time-zone shifting). Prose, relative wording
(“3 days ago”), impossible dates (2026-02-31) and unparseable values stay
**absent** — the page body is never scanned for dates, and the capture time is
never substituted. If two explicit sources **disagree**, no date is chosen: the
field stays blank with a fixed, content-free notice and the preview lets you
type or clear it before saving.

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

## Resume Word (.docx) export (ATS-friendly, no AI)

`src/lib/resume/docx/` renders the SAME strictly validated `TailoredResume`
payload to a Microsoft Word-compatible `.docx` (Office Open XML) file. It is a
presentation layer only: it never invents, paraphrases or drops content, and it
renders no field outside the resume schema (no contact details, evidence ids,
relevance/selection metadata or job text). Content **and section order** come
from the same source as the PDF (`buildBlocks`), so both formats say the same
thing.

Packaging uses **`fflate`** (MIT, ~8 KB, zero dependencies, browser + Node) as
the ZIP container writer — a `.docx` is a ZIP package and the project had no
way to write one. A full DOCX-generation library was deliberately not used: it
would embed hidden document metadata (creator, application, creation time) and
a generation timestamp, and would hide the OOXML we want to keep explicitly
ATS-safe.

- **Structure:** one column of ordinary paragraphs — no tables, text boxes,
  columns, drawings, shapes or hyperlinks. Section headings are real outline
  headings, bullets use a real Word list definition, and the page is A4 portrait
  with 2 cm margins in Arial.
- **Text:** punctuation and Unicode are preserved verbatim (the package is
  UTF-8), unlike the PDF's Latin-1 fonts. Every value is XML-escaped rather than
  concatenated into markup, and text containing characters XML 1.0 cannot
  represent is refused with a typed error (reporting only `U+XXXX` code points)
  instead of writing a corrupted file.
- **Determinism:** identical input produces a **byte-identical** package — ZIP
  entry timestamps are pinned to a fixed local constant (so the bytes match in
  every timezone), entries are stored uncompressed, and no `docProps` metadata
  part is written at all. The file therefore carries **no hidden metadata** and
  no "generated at" time.
- **Filenames:** `resume-<job-title-slug>-tailored.docx`, falling back to a
  neutral `resume-tailored.docx` when the label has no usable characters.
  Unsafe filename characters are stripped; no employer or job title is invented.

In **Options → Jobs**, the resume section offers **Download tailored resume
PDF** and **Download tailored resume DOCX**. One action tailors the profile +
job **once** and every action shares that single validated result: the PDF and
the Word file are rendered from the *same* object, and **Save version to
history** stores that same object — so the PDF action can never tailor twice,
no second content mapping exists for one format, and the three actions can
never diverge onto different payloads. This is orchestrated by one testable
helper (`exportCurrentResume` in `src/lib/resume/current-export.ts`) that keeps
the four steps separate: tailor once → render/download the PDF from the
snapshot → render/download the Word file from that snapshot → save that same
snapshot only when the user asks. The snapshot is read-only: nothing mutates
it, and a cached snapshot is reused instead of being regenerated. If generation
fails, a fixed, content-free message explains why and no file is written. No AI,
no network, no storage writes; the sensitive profile is never read.

Limitations: verification is **structural** (the package is unzipped and every
part parsed as XML in tests) — no word processor was used, so nothing is claimed
about how Microsoft Word, Google Docs or LibreOffice render or round-trip the
file, and **no universal ATS compatibility is claimed**. There is no template,
branding, font or layout customisation, no image/logo support and no page-count
control.

## Tailored resume version history (local-only, no external service)

In **Options → Jobs**, the resume section can **Save version to history**:
each click stores the exact tailored resume generated for the selected job as
a fixed, strictly validated snapshot in `chrome.storage.local` under the
dedicated versioned key `job-resume-history.v1` — never sync storage, and
never the profile, sensitive-profile, settings, jobs or application-log keys.
Saving is always **explicit**: it never submits an application, never changes
an application status, and makes no network or AI request.

Each record (`src/lib/resume/history.ts`) stores only: a generated version id,
the history schema version, the referenced saved `jobId` (when the snapshot's
provenance has one), `jobTitle`/`company` labels copied from the saved job
**when available**, the creation timestamp, a small `status` (`saved`), and the
resume snapshot itself — the existing strict `tailoredResumeSchema`, reused
rather than duplicated. Records are `.strict()`-validated on read and write:
unknown keys (credentials, tokens, page content, HTML/selectors) and sensitive
profile fields (contact details, legal/EEO/voluntary answers, compensation,
government IDs) are rejected, and validation issues are reported as path +
code only — never resume or profile content. Job details, labels and
timestamps are never invented.

How it works:

- **Save** — appends newest-first; existing versions are never rewritten or
  dropped. The saved payload is the version that was just generated (the
  deterministic `tailorResume` output for the current profile + job), copied
  through the strict schema so later edits cannot reach it.
- **Open** — shows the version's job label, creation date, status and a
  count-only section summary (no resume body text is listed; there is no
  in-page PDF/resume preview in this build).
- **Export PDF / Export DOCX** — each renders the **stored snapshot** through
  the existing `renderResumePdf` / DOCX writer, so a historical file is exactly
  what that version contained even after you edit your profile or the posting
  (verified by byte-identical tests against `renderResumePdf(snapshot)` and the
  DOCX renderer). Neither needs a loaded profile, and both work when the
  original job posting has been deleted (the version is kept as an orphan).
- **Delete** — two-step confirmation that removes exactly the selected
  version; other versions and every other storage key are untouched.
- **Integrity** — absent, malformed, unavailable and quota results are
  distinguished with fixed, content-free messages. Malformed history is
  surfaced with a recoverable raw value and **never** overwritten; replacing
  it requires an explicit confirmation. At the documented cap (**200**
  versions) a new save is *refused* with a clear message instead of silently
  deleting older versions.
- **Orphans are safe** — deleting a saved job posting later leaves its
  versions intact; the row is flagged "Job posting no longer saved" and open /
  export / delete keep working from the snapshot alone.

Limitations: history lives only in this browser (no history sync or
import/export), there is no in-page preview of a saved version (export
downloads the PDF), the 200-version cap is only lifted by deleting versions
yourself, and the UI is verified with `react-dom/server` + unit tests (no
real-browser e2e here).

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

## Job prioritization (freshness-aware, local)

`src/lib/prioritization/` turns the data you already saved into a **review
order**: `prioritizeJobs({ jobs, matches, applications, today,
minMatchThreshold })` groups saved jobs into four categories and explains each
decision. It is pure and local — it reads no storage, never touches the clock
(the caller passes `today` as `YYYY-MM-DD`), never calls the network or an AI
provider, never mutates its input and **never writes a priority back into
storage**. Match estimates are reused exactly as `calculateJobMatch` produced
them; nothing is re-scored here — but a result whose embedded threshold block
contradicts your **current** minimum (different configured value, filtering mode
or pass/below decision) is treated as unusable, and so is supplying more than
one result for the same saved job. Both cases become `needs-review` with no
score instead of being trusted (the `already-applied` rule still wins, and with
settings unreadable the match signal stays `unavailable`).

**It does not know whether a posting is still open, how many people applied, or
your chances of getting hired.** The match estimate and the freshness signal are
reported as **separate** fields — there is deliberately no combined score and no
probability claim anywhere in the result contract.

### Categories (precedence: first match wins)

| Category | Rule |
|---|---|
| `already-applied` | A **reliably linked** application record (its `jobId` equals the saved job's id) with a submitted/in-progress status (`applied`, `assessment`, `interview`, `offer`) or a closed outcome (`rejected`, `withdrawn`). `planned` alone is **not** a submission. |
| `apply-first` | A valid, assessable match meets your configured minimum, the posting date is known and not in the future, the date is inside the freshness window, and no linked application is submitted. |
| `good-match` | The match meets your minimum, but a freshness condition is missing (unknown posting date, or older than the window). The reason says which. |
| `needs-review` | Insufficient/unknown match data, a match below your minimum, a future posting date, an unreadable application log, or unreadable settings. |

### Freshness

- Documented, conservative window: **7 calendar days** (`FRESHNESS_WINDOW_DAYS`).
- Age is computed from **calendar dates** (UTC calendar parts), never elapsed
  milliseconds — month, year, DST and leap-day boundaries are exact. A posting
  dated today is age 0.
- A **future** posting date is flagged `Future posting date — verify` and is
  treated as `needs-review`, never as fresh — even with a perfect match score.
- A **missing/unknown** posting date is never treated as recent (it cannot be
  `apply-first`; it lands in `good-match` or `needs-review`).
- Freshness never overrides a poor or unassessable match: a below-minimum or
  insufficient score is `needs-review` regardless of how new the posting is.

### Stable ordering (within a category)

1. Known posting date, newest first — unknown dates **never** outrank known ones.
2. Match score, highest first, when both jobs have valid numeric scores.
3. Job id ascending as the final tie-breaker.

The underlying saved-job order is never changed and no computed priority is
persisted.

### Fail-closed behavior

Application records are matched **only** by `jobId` — never by company/title, and
an unlinked record is never attached to a job. If the application log cannot be
read (one malformed record is enough) or settings cannot be read, the affected
signal becomes explicitly *unknown* and the job falls back to `needs-review` with
a concise explanation; missing data is never treated as a good match.

Options → Jobs renders this as a compact **Priority shortlist**: the four
categories with counts, a selectable list per category (title/company, match
estimate or an insufficient-data label, posting date or "Posting date unknown",
application status when reliably known), short reasons per job, and a safe
*Open posting* link (`target="_blank" rel="noreferrer noopener"`, only for a
saved http(s) URL). Nothing is opened, submitted or filled automatically.

Limitations: this is a local review order over saved data — no real-time job
discovery, no listing-availability or applicant-count data, no ATS outcome
claims, no navigation or automatic application submission, and no prioritization
is written back to storage. Verification here is unit/`react-dom/server` level
(no real job site was accessed).

## Duplicate job detection (local, no AI)

`src/lib/job-duplicates/` stops the same vacancy from being saved twice while
keeping genuinely different vacancies separate. Both creation paths — the popup
capture preview and *Add job manually* in Options → Jobs — run
`findDuplicateJob()` against the saved list **before** anything is written.

Rules, applied in this order (first hit wins):

1. **Canonical URL** — validated http(s) URLs compared after removing the
   fragment and normalizing only safe, irrelevant differences (scheme/host case,
   a leading `www.`, an explicit default port). The path and every query
   parameter are preserved verbatim: parameters are never stripped or reordered,
   and `http://` is not treated as the same posting as `https://`.
2. **Explicit external identifier** — only identifiers the source itself
   published, and only inside the same source domain (an identifier is trusted
   only when it belongs to that saved job's own URL host). Identifiers are never
   invented or derived, and the same text on two different sites never merges.
   *The current job model and capture metadata provide no such identifier, so in
   this build the rule never fires — it exists for sources that do.*
3. **Normalized company + title** — the weak fallback: case, surrounding and
   repeated whitespace only; no fuzzy, partial or stemmed matching. A hit here is
   reported as a **possible** duplicate for you to review.
4. Otherwise: no duplicate.

If several saved records share the same canonical URL or identifier the result is
**ambiguous** — no winner is chosen and nothing is merged. Results are strict Zod
objects (bounded strings/arrays, fixed reason codes and explanations, saved job
ids/titles only — never page text, captured field values, personal data or raw
errors), and malformed saved records are skipped rather than trusted.

Saving is never automatic or destructive: a match shows a warning with the saved
job's title/company, a *View saved record* action and a safe link to the saved
posting when it has one, and the write only happens if you choose *Save as a
separate record*. Nothing is overwritten, merged or deleted, and the check is
read-only (the saved list is never modified, not even when it is malformed).

Limitations: matching is conservative and textual — the same vacancy reposted
under a different URL with a reworded title legitimately counts as a new job; a
source identifier is trusted only inside that source's own domain; the check
cannot run while the saved list is unreadable (that is reported instead of being
treated as "nothing saved"); and no browser pass over the two warning UIs has
been performed here.

## Autofill (deterministic foundation, no AI)

`src/lib/autofill/` is the first, conservative autofill foundation. It fills
**only** fields it can classify unambiguously from your saved answers, and it
never contacts an AI provider or the network. It never submits a form, and it
never fills a field without your explicit confirmation.

The engine is split so each part is independently testable:

| Module | Responsibility |
|---|---|
| `schemas.ts` | `.strict()` **value-free** field descriptors, the reviewed fill plan, and the per-field report |
| `classify.ts` | deterministic classification from visible label / ARIA name / placeholder / `name` / `id` / `autocomplete` / input type / fieldset legend |
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

**Never filled (excluded categories):** passwords/authentication (an
`input type="password"` control is excluded by its own type even when its label
looks harmless), one-time and
verification codes, payment/card/bank details, CAPTCHA/bot-detection,
equal-opportunity & voluntary demographics (gender, race, veteran, disability,
religion, sexual orientation, …), compensation/salary, and legal
declarations/consent/attestation. Generic labels ("Name", "Other", "Details",
"Additional information") and any field that is ambiguous or matches more than
one category are left for manual entry with a typed reason.

**How it works (user-confirmed, opt-in):** in the popup, *Autofill this
application form* reads only form-control **metadata** (visible label, ARIA name,
fieldset legend, `name`/`id`/`autocomplete`/type — never values), shows a review split into *Will fill* and
*Needs manual input*, and fills **only after you click Confirm**. Cancel makes
no changes. A completion summary reports counts, **not** the values. Select,
radio and checkbox fields are filled only on an unambiguous match; disabled,
read-only, hidden and detached fields are skipped. The form is never submitted
and no navigation is triggered.

**Label detection (Prompt 22):** every available label source is captured as a
separate bounded, value-free string — `label[for]`, a nested `<label>`, and
repeated labels for one control; the explicit ARIA name (`aria-labelledby` with
*every* referenced id — duplicates, comma separators and unresolvable ids are
handled without ever failing the scan — falling back to `aria-label`); the
`placeholder`; and the nearest ancestor `fieldset`/`<legend>` group question
(walking outward past a legend-less nested fieldset). Precedence is deliberate: a
real label or ARIA name wins, a placeholder is only a lower-confidence fallback
when no label exists, and the group question is used only when the control has no
label, ARIA name or placeholder. If a visible label and an explicit ARIA name
conflict, the field is reported **ambiguous → manual** rather than guessed, and a
misleading label can never unlock a sensitive field (the safety exclusions always
see every signal, including the placeholder and the group legend).

**Never overwritten:** a field that already contains a value — typed text or
textarea content, a real (non-placeholder) selected dropdown option, or a radio
group with another option already answered — is left **exactly as it is** and
reported `already-filled` (no write, no events, and the existing value never
appears in any message or report). Only empty fields are filled; ambiguity is
still reported first, so an unmatched field keeps the more specific `no-match`.

**Reliability (hardened):** text/textarea/select values are written through the
element's **native value setter** — not any instance-level setter a framework
installs — followed by bubbling `input` + `change` events, so React-style
controlled inputs observe the change without using framework internals or
bypassing validation. Every write is then **verified**: a value that did not
take effect returns a typed `verify-failed` result and fires no events, so
success is never claimed for a write the page rejected. Dropdown placeholders
("Select one", empty or disabled options) never count as answers and the first
option is never chosen just because it exists; radio groups are scoped by
(form, `name`); and a checkbox/radio already in the planned state is left
untouched. Each scan mints a session token that the confirmed fill must echo, so
a plan can only be applied to the scan that produced it — after the form changes
you must scan and confirm again. Disabled, read-only, hidden, `inert` and
disconnected fields are skipped.

**Custom widgets & validation:** a custom ARIA combobox/listbox
(`role="combobox"`, or `aria-haspopup="listbox|tree|grid"`) is left for **manual
entry** — the engine will not click popup options; native `<select>` controls are
unaffected. After a write the executor also checks the browser's constraint
validity, so a required/`pattern` value the page rejects is reported
`verify-failed` and the control is restored instead of being counted as filled.
Inline validation text and site-specific JavaScript validation are **not**
parsed.

**Compatibility matrix:** see [`docs/autofill-compatibility.md`](docs/autofill-compatibility.md)
for a per-pattern breakdown (supported / partially supported / unsupported /
unverified), the synthetic fixture behind each status, and the evidence
boundary.

**AI-assisted field mapping (opt-in, off by default):** for fields the
deterministic classifier leaves *ambiguous* or *unsupported*, an optional
"suggestions" layer can ask your configured AI provider which **saved answer
category** a field belongs to. It is off unless you enable AI in Settings, and it
only runs when you explicitly click **Suggest field mappings with AI** — never
during scanning or page load.

- **What is sent (and only this):** for each eligible field an opaque field id, a
  short normalized label, the control type, and the names of the answer
  categories **you actually have saved answers for**. The field labels are the
  only page-derived data: they come from the webpage and may contain text
  supplied by the website. **Never sent:** field values, applicant profile data,
  your saved answers themselves, full page text/HTML/DOM, URLs, the job
  description, or sensitive/legal/compensation information. AI stays off ⇒
  **zero** provider calls.
- **Eligible:** ambiguous/unsupported, interactable, single-valued fields with a
  usable non-sensitive label.
- **Never sent / never mapped:** passwords & authentication codes, payment/bank
  fields, CAPTCHA, legal/consent/attestation, compensation/salary, voluntary
  demographic (EEO) questions, **work authorization / sponsorship** (the model
  must never infer legal status), multi-select controls, hidden/disabled/
  read-only fields, and every field the deterministic classifier already
  recognizes.
- **AI suggests mappings only** — it never provides an answer, never runs the
  executor, never chooses a DOM element, and never alters a fill plan. It returns
  a category + bounded confidence + a fixed reason code. Suggestions below a
  conservative threshold stay manual; approval is **per field**, and approved
  mappings go back through the **existing deterministic planner and executor**
  (which resolve the value from your saved profile) and still require the normal
  **Confirm & fill**.
- **Provider:** only the documented backend-proxy pattern — no API key, no second
  client, no new manifest/host permission, no telemetry.

**Integration blocker (documented):** this build configures no backend AI
endpoint anywhere (Settings has no endpoint field, and adding one is out of
scope here), so the popup's `MAPPING_PROVIDER` is `null` and the AI action reports
that mapping is unavailable while every field stays manual. The validated
proposal library, planner integration and tests are complete; wiring the popup
to a real provider is deferred until an endpoint is configured. Verified through
jsdom unit tests only (no real-browser or live-provider testing).

**Integration limits:** this uses the existing `activeTab` + `scripting`
permission model and the current content-script channel — no new permissions
and no host-permission broadening. Reliability is verified with jsdom unit tests
only; jsdom does not reproduce a real browser (no real event loop or framework
render cycle), so no specific-site compatibility is claimed. **Workday-specific
handling is NOT implemented.**

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
tab (Prompt 13), the deterministic autofill foundation (Prompt 14), its
reliability/safety hardening (Prompt 15), Workday-style compatibility discovery
with a synthetic fixture set and matrix (Prompt 16), the opt-in AI-assisted
field-mapping layer (Prompt 17), the local tailored resume version history
+ snapshot export (Prompt 19), the ATS-friendly Word (.docx) resume export
(Prompt 20), optional **job posting-date** capture/display groundwork (Prompt 23
— an explicit published date only), the **freshness-aware job prioritization
+ Options → Jobs priority shortlist** (Prompt 24 — four categories, a documented
7-day freshness window, stable deterministic ordering; no expiry reminders, no
notification, no combined score and nothing written back to storage), that
schema's hardening (Prompt 25), and **duplicate-job detection** on both save
paths (Prompt 26 — conservative canonical-URL / source-identifier / normalized
company+title rules, ambiguous matches never auto-picked, nothing merged or
overwritten).
**Not yet built: a Workday adapter, live wiring of the AI provider endpoint, and
the deeper application-form automation.**
