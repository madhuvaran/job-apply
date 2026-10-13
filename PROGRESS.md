# PROGRESS

## Done (2026-10-13, task 10 / Prompt 06: provider-agnostic AI interface)
- **`src/lib/ai/schemas.ts`** (new) — zod-validated wire contract (v1), strict
  (`.strict()`) at EVERY level: `aiRequestSchema` = schemaVersion literal +
  `task` enum (`tailor-resume` | `draft-answer`) + `aiJobInputSchema` (shared
  JobPosting caps: title 200, short fields 200, description 100k, non-blank,
  no extra keys) + embedded `profileSchema` (AI-safe record ONLY) +
  embedded `providerSafeSettingsSchema` (`settingsSchema.omit({ salary
  }).strict()`); `aiResponseSchema` = non-blank content (1–50k), provider id,
  optional `model` + `.strict()` `usage` token counters; `validateAiRequest` /
  `validateAiResponse` / `formatZodIssues` (path + message, same shape as
  `validateSettings`). Unknown keys in the request, job, settings, profile,
  response or usage are all rejected.
- **`src/lib/ai/errors.ts`** (new) — typed `AiError` union
  (`invalid-request` / `invalid-response` / `timeout` / `rate-limited` /
  `http` / `network` / `provider-fault`) + `AI_ERROR_KINDS`. Fixed-literal or
  path-only strings — never payload content, never credentials (non-PII rule
  from the storage service).
- **`src/lib/ai/provider.ts`** (new) — the provider interface: `send(request,
  ctx)` with `ctx = { signal, attempt, timeoutMs }` returns a typed
  `AiProviderOutcome` (raw response | `AiProviderFailure`: `rate-limited`
  (+`retryAfterMs`) / `timeout` / `network` / `http` (+`retryable`) /
  `malformed`). No credential field exists anywhere in the contract.
- **`src/lib/ai/run.ts`** (new) — `buildAiRequest()` is THE payload
  chokepoint: projects settings through `settingsForProvider()` (strips
  `salary`), embeds only the AI-safe profile, strict-validates the result
  (a still-present `salary` fails validation instead of being sent).
  `runAiRequest()` NEVER throws for expected failures; returns
  `{ kind: 'ok' | 'fallback' | 'error' }` (+`attempts`): (1) typed
  `invalid-request` before anything runs (attempts 0), (2) `aiEnabled:false`
  → local fallback with the provider NEVER invoked — zero network requests,
  (3) per-attempt timeout (default 15 000 ms; `AbortController` aborts the
  in-flight attempt) + retry loop for rate limits / 5xx / network / timeout
  with exponential backoff (250 ms base, doubling, capped 30 s), honoring
  `Retry-After` (capped 120 s), max 3 attempts; non-retryable failures
  (other 4xx, invalid response, thrown provider → `provider-fault` with the
  error NAME only, never its message) return on attempt 1. `sleep` is
  injectable so tests assert exact backoff without waiting.
- **`src/lib/ai/fallback.ts`** (new) — deterministic no-AI response
  (`provider: 'local'`): `tailor-resume` renders the candidate's stored
  profile content verbatim (stored order, capped at 50k, fixed literal for an
  empty profile); `draft-answer` renders the saved application answers
  verbatim. Nothing is generated, invented or reworded.
- **`src/lib/ai/proxy.ts`** (new) — `createProxyProvider({ endpoint })`, the
  only production transport: JSON POST to the extension's OWN backend.
  Options are `.strict()` with NO credential field (passing an `apiKey` throws
  at wiring time — a config bug, not a runtime AI failure). Maps 429 →
  `rate-limited` (Retry-After delta-seconds OR HTTP-date → ms), 5xx →
  retryable `http`, other 4xx → non-retryable `http`, fetch `TypeError` →
  `network`, abort → `timeout`, non-JSON 2xx body → `malformed`. Sends only
  `content-type`/`accept` headers (no Authorization/x-api-key — by design) and
  forwards the orchestrator's AbortSignal.
- **`src/lib/ai/mock.ts`** (new) — `createMockProvider()` for tests: records
  every call (request, attempt, signal), plays scripted steps (typed failures,
  arbitrary raw payloads including deliberately invalid ones, `hang`), and
  defaults to a valid response `mock:<task>:<job title>`. Offline, no I/O.
- **`src/lib/ai/index.ts`** (new) — public surface re-export.
- **Tests** (4 new files, 79 tests): `schemas.test.ts` (23) — strict request/
  response matrix (extra keys rejected at every level incl. inside `usage`),
  `salary` inside settings rejected, sensitive record and injected contact
  keys rejected as/inside the profile, size caps (200 / 100k / 50k), helper
  formatting. `run.test.ts` (30) — chokepoint (serialized request contains no
  `salary`/amount/currency and no sensitive value; deep-equals
  `settingsForProvider` output), ZERO-network fallback (mock untouched AND
  proxy `fetch` spy untouched; scripted failures and retry options never even
  consulted), fallback content (verbatim + deterministic, answers vs profile
  render, empty-profile literal, no salary/sensitive strings), invalid-request
  → attempts 0 with provider untouched, ok path, invalid response not retried,
  timeouts (aborted signal asserted, retry-then-succeed with backoff 250→500,
  exhaustion), retry policy (Retry-After honored over backoff, 4xx immediate,
  `maxAttempts`/clamp behavior, thrown + synchronously-throwing providers →
  `provider-fault` with no message leak). `proxy.test.ts` (21) — options
  strictness (no key field; bad endpoint throws), no auth headers, body equals
  the validated request, 429/Retry-After (seconds + HTTP-date + absent),
  5xx/4xx mapping, TypeError→network, AbortError→timeout, non-JSON→malformed,
  end-to-end `runAiRequest` retry through the proxy, zero fetches when
  `aiEnabled` is false. `mock.test.ts` (5). Suite: **233 tests passing
  (11 files)**.
- **`README.md`** — new "AI provider interface (backend-proxy pattern)"
  section: architecture diagram (extension → own backend → vendor), key
  custody rules, response contract JSON, CORS note (backend allows the
  extension origin → **no host permission needed**), timeout/retry semantics;
  privacy + status paragraphs updated. `wxt.config.ts` untouched.

### Commands run this task (exit statuses captured inline)
- `npm ci` → exit 0 (node_modules was absent after restore; lockfile preserved)
- `npx vitest run` → **exit 0, 233/233 passed** (154 baseline + 79 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest verified unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`,
  no `optional_host_permissions`

### Limitations / known issues
- Library + tests only: nothing calls `runAiRequest()` yet (Prompt 06 scope).
  No UI switch and no stored backend endpoint — enabling `aiEnabled` alone
  changes nothing on the wire until a later prompt wires a feature to it.
- No real backend exists: `createProxyProvider` is exercised against a fake
  `fetch` only. No live vendor call, no CORS handshake and no key custody are
  tested or claimed — the backend must be built before production use, and
  the manifest gains no host permission (by design; the proxy relies on CORS).
- Retry delays are verified with an injected `sleep` (exact backoff values,
  no real waiting); timeout tests use real 10–20 ms timers. Backoff has no
  jitter.
- The extension validates only the request/response ENVELOPE; what the
  backend puts into the vendor prompt and how vendor output is filtered is
  the backend's responsibility (knowledge.md content rules are documented in
  README but not enforceable client-side).
- `.wxt/tsconfig.json` shows as modified after `npm ci` (regenerated by
  `wxt prepare`); it is generated output and intentionally not committed,
  matching earlier tasks. `.output/` is build output, also not committed.

### Next
- Prompt 09+ (match estimate / tailoring) consuming `runAiRequest`, and —
  when requested — a settings field + options UI for the backend endpoint.

---

## Done (2026-10-13, task 9 / Prompt 08: user-triggered current-page job capture)
- **`src/lib/capture.ts`** (new) — provider/page-free capture library: zod message
  schemas on BOTH sides (`captureRequestSchema` strict; `captureResponseSchema`
  discriminated union ok/error; `validateCaptureResponse` for the popup), plus
  `extractJobCandidate(doc, url)` — conservative DOM extraction that only reads
  JSON-LD `JobPosting` data, `<title>`/h1/og: meta, a short allowlist of
  company/location selectors, and the SINGLE largest job-ish container
  (article / role=main / job-description classes). Whole-body dumps are never
  taken; company is NEVER guessed from the domain; error messages are fixed
  literals (no page content leaks). Size caps enforced before send (100k
  description with `descriptionTruncated` flag, 200-char fields). Broken
  JSON-LD falls back to DOM heuristics; JSON-LD HTML descriptions are
  tag-stripped. `handleCaptureRequest()` is pure and unit-tested.
- **`src/lib/fixtures/`** (new) — static HTML fixtures: JSON-LD job page,
  DOM-structured page (no JSON-LD), no-job-content page — each with deliberate
  nav/footer/aside noise to prove unrelated content is not collected.
- **`entrypoints/content.ts`** — starter log replaced by an idempotent
  `browser.runtime.onMessage` listener (globalThis guard → re-injection safe).
  The page is NEVER inspected at load time; extraction runs only when the
  popup sends `job-apply/capture-request` after the user's click.
- **`entrypoints/popup/App.tsx`** (+ App.css/style.css) — WXT counter demo
  replaced by the capture flow: Capture current job → active tab read ONLY
  after the click → preview with editable title/company/location/URL/
  description → Save (validated zod write via `upsertJobPosting`, source
  `page-capture`) / Cancel (writes nothing). Handles: unsupported pages
  (chrome://, PDFs, files), missing content script (on-demand injection via
  scripting API, then retry), permission denial, invalid message payloads —
  each with an explicit fallback to manual intake. Description truncated
  beyond 100k chars is flagged in the preview.
- **`wxt.config.ts`** — permissions now `['storage', 'activeTab', 'scripting']`:
  `activeTab` is granted only when the user opens the popup (narrowest
  per-tab access; no host permissions added), `scripting` only injects our
  capture listener into that one tab. Verified in built manifest.
- **Tests**: `src/lib/capture.test.ts` (new, 16 tests): message validation both
  directions (foreign/extra-key/oversized/non-http payloads rejected; errors
  are field-path only), handler ignores foreign messages, fixture-based
  extraction (JSON-LD and DOM), exclusion of nav/footer/aside noise, no-job-
  content failure with fixed literal, 100k truncation + flag, field caps,
  broken-JSON-LD fallback, no company/location invention. jsdom added as a
  devDependency to parse fixtures (`@vitest-environment jsdom`). Suite:
  **154 tests passing (7 files)**.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 154/154 passed**
- `npm run compile` → **exit 0** (fixed: content.ts import path, ScriptPublicPath
  leading slash, createJobPosting z-input typing, storage-result narrowing,
  `description?.length` possibly undefined)
- `npm run build` → **exit 0**; built manifest `permissions = ["storage",
  "activeTab", "scripting"]`, no host_permissions
- Temp CDP probe script used for earlier manual checks was deleted (not part
  of the project)

### Limitations / known issues
- Capture is BEST-EFFORT and tested only against static fixtures (jsdom), not
  live sites — no live-site compatibility is claimed. Documented best-effort
  targets (see README): pages exposing `JobPosting` JSON-LD (Greenhouse,
  Lever, Workday, Indeed, LinkedIn job pages) and simple career pages. App-
  heavy/login-walled pages may yield title-only or `no-job-content` → use
  manual intake. No scraping behind logins is implemented or claimed.
- Popup/content-script behavior in a real browser is NOT e2e-tested (no
  Playwright run); the message handler itself is unit-tested via
  `handleCaptureRequest`. Manual check: load `.output/chrome-mv3` unpacked,
  open a job listing, click the toolbar icon → Capture current job.
- Manifest still declares the starter's `*://*.google.com/*` content-script
  match (injection elsewhere uses activeTab); trimming it is a separate,
  behavior-changing task.

### Next
- Prompt 06 (still pending): provider-agnostic AI interface with zod-validated
  requests/responses, timeouts, rate-limit handling, no-AI fallback and
  backend-proxy docs — then Prompt 09+ (match estimate / tailoring).

---

## Done (2026-10-13, task 8 / Prompt 07: JobPosting model + manual intake)
- **`src/lib/job-posting.ts`** (new) — normalized `JobPosting` schema v1:
  title (required), company/location/originalUrl (optional, URL http/https
  only ≤2048 chars), `rawDescription` (verbatim — never trimmed/normalized,
  ≤100k chars, whitespace-only rejected), responsibilities / required +
  preferred qualifications / skills (capped lists), `experienceRange` (shared
  validated min/max-years schema exported from settings.ts — one source of
  truth), `workArrangement`/`employmentType` (shared enums, NOT coerced —
  unknown values rejected, never guessed), `compensation` (verbatim string,
  only when explicitly stated), `source` (`manual`|`page-capture`),
  `capturedAt`, optional `updatedAt`. `.strict()` — extra keys (cookies,
  tokens) cannot be stored. UNKNOWN VALUES STAY ABSENT, preserved in raw.
  Record schema (`job-postings.v1`, ≤500 postings) + `createJobPosting`
  (fills id/timestamp, invents nothing) + pure `upsertPostingInList` +
  deterministic `extractJobSections` (whole-line known headings only;
  unknown "Label: …" lines stop the section and stay in raw; over-long lines
  skipped; pure).
- **`src/lib/storage.ts`** — `STORAGE_KEYS.jobPostings`, `loadJobPostings`,
  `saveJobPostings`, `upsertJobPosting` (insert-or-replace-by-id; preserves
  `capturedAt`; fails closed on corrupt stored list — raw preserved),
  `resetJobPostings` (explicit-only).
- **`entrypoints/options/JobsPanel.tsx`** (new) — Jobs tab: saved list
  (source + date + URL), manual intake form (title/company/location/URL/raw
  description + editable extracted line lists via explicit "Extract sections"
  button + work arrangement/employment type/experience range/compensation),
  Save (schema-validated, invalid forms never write), Edit (id + capturedAt
  preserved, updatedAt bumped), Cancel (writes nothing). Malformed stored
  data surfaces a recovery banner; corrupt data never overwritten silently.
- **`entrypoints/options/App.tsx`** — third tab "Jobs" (header stays in sync);
  `entrypoints/options/ui.tsx` extracted earlier for shared Section/Row.
- **Tests**: `src/lib/job-posting.test.ts` (new, 22): minimal postings,
  missing optionals stay absent, malformed/non-http/oversized URLs,
  byte-for-byte noisy-description round-trip, 100k cap, list caps, enum
  non-coercion, shared range validation, verbatim compensation, source/
  timestamp, extractor (headings/bullets/CRLF/noise/over-long/purity),
  upsert + record defaults. `src/lib/storage.test.ts` +16: postings
  round-trip, absent vs malformed (raw preserved), upsert insert/update
  across "reload", invalid posting rejected without write, corrupt-list
  upsert fails closed, reset scoped to the postings key only.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 154/154 passed** (cumulative with Prompt 08)
- `npm run compile` → **exit 0**; `npm run build` → **exit 0**

### Limitations / known issues
- No delete-confirmation UI for saved postings (not requested); reset exists
  at the storage API level only.
- No browser e2e run; Jobs tab verified by unit tests + typecheck + build.

---

## NOT implemented (2026-10-13): Prompt 06 — AI provider abstraction
- RESOLVED in task 10 (see the top entry): `src/lib/ai/` now exists with the
  full provider abstraction, tests and README docs. Historical note follows.
- Prompt 06 was requested but superseded mid-task by Prompts 07/08 before any
  of it was implemented. No `src/lib/ai/` code exists. Everything in this
  repo still makes zero network requests; `aiEnabled` in settings is stored
  but not yet consumed by any code path. Prompt 06 remains the recommended
  next task before any tailoring/match features.

---

## Done (2026-10-13, task 7 / Prompt 05: preferences and privacy settings)
- **`src/lib/settings.ts`** (new) — settings schema v1 with CONSERVATIVE
  defaults (`settingsSchema.parse({})`): target titles/locations, work modes
  + employment types (shared enums), optional experience range (shared
  min/max-years sub-schema, exported for reuse), optional salary preference
  (3-letter currency + optional annual bounds, min≤max, only when provided),
  excluded employers, `minMatchThreshold` 0–100 (0 = filtering OFF; applies
  to the extension's own transparent resume-to-job match estimate — never an
  employer ATS score), `resumeFormat` (default pdf), `aiEnabled` (default
  FALSE). `.strict()` — legal-eligibility/sensitive keys (workAuthorization,
  demographic, criminal-history…) cannot be stored. `normalizeSettings`
  (drops blank list lines so a trailing Enter never blocks Save),
  `seedSettingsFromPreferences` (pure profile→settings seeding mapper),
  `hasSeedablePreferences`, `settingsForProvider` (strips `salary` so
  compensation can never reach an LLM — tested), and `PRIVACY_NOTICE`
  (structured stays-local / may-be-sent / never-sent copy rendered by the UI
  and asserted by tests so docs cannot silently drift).
- **`src/lib/storage.ts`** — `STORAGE_KEYS.settings` (`job-settings.v1`),
  `loadSettings`/`saveSettings`/`resetSettings` (explicit-only), and
  `migrateSettingsFromProfile()` — non-destructive seeding of target
  titles/locations/work modes from `profile.preferences` (existing settings
  never overwritten, corrupt settings never replaced — raw preserved, profile
  read-only, distinct outcomes seeded/already_present/blocked_corrupt_target/
  no_source/source_malformed/storage_unavailable/write_failed).
- **`entrypoints/options/SettingsPanel.tsx`** (new) + tabbed options page
  (Profile | Settings & privacy): all fields, per-issue validation messages
  from the same zod schema storage enforces, explicit Import-from-profile
  banner (offered only when settings are absent and profile has targeting;
  disabled while unsaved edits exist), explicit reset-to-defaults with
  confirmation, malformed-data recovery banner, beforeunload guard, and the
  full privacy explanation section. `entrypoints/options/ui.tsx` (new)
  extracted shared Section/Row atoms; profile editor's duplicate target-
  titles/locations/work-modes rows removed (single source of truth =
  settings; applicationAnswers stay in the profile editor with a pointer).
- **Tests**: `src/lib/settings.test.ts` (new, 24) + `src/lib/storage.test.ts`
  grown to 41 (persistence round-trip, absent/malformed/unavailable, invalid
  write rejected, reset scoped, seeding/migration matrix, idempotency).

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 110/110 passed** at the time (cumulative later
  to 154/154 with Prompts 07/08)
- `npm run compile` → **exit 0**; `npm run build` → **exit 0**

### Limitations / known issues
- Browser-level UI verification of the settings tab (and later Jobs tab / popup)
  was not completed — a headless-Chrome CDP probe confirmed the built
  extension loads and exposes targets, but the full interactive flow was only
  verified at the logic/unit level. Manual steps: load `.output/chrome-mv3`
  unpacked, open Options → Settings & privacy, import/adjust/save, reload,
  confirm persistence.
- `settingsForProvider` exists as a tested guard for future provider code;
  nothing consumes it until Prompt 06 lands.

---

## Done (2026-10-12, task 6 / Prompt 04: profile editor options page)
- **`entrypoints/options/`** (new: `index.html`, `main.tsx`, `App.tsx`, `style.css`) —
  master-profile editor built with React over the validated storage service.
  Sections: identity (displayName/headline/location/summary), skills (add/remove by
  id), work history (company, title, month inputs with ongoing checkbox, bullets
  textarea — bridged through `dateRangeToFields`/`linesToBullets`), education,
  certifications, projects, links (URL fields), preferences (target titles/locations
  as line lists, work-modes checkboxes, explicit application answers as repeatable
  q/a cards).
  - Validation messages derive from the SAME zod schema storage enforces
    (`validateDraft` in `src/lib/editor.ts`); Save is disabled while invalid and
    invalid input is rejected on write (tested).
  - Save state machine (idle/saving/saved@time/error), unsaved-change protection
    (beforeunload guard when draft ≠ saved snapshot).
  - Reset requires an inline explicit confirmation; corrupt stored data surfaces a
    `malformed` banner offering reset-with-empty (raw preserved per Prompt 03).
  - Empty onboarding banner with non-destructive migration button; migration
    warnings displayed verbatim.
  - Sample seeding is draft-only and explicitly labeled fake: nothing persists
    without a deliberate Save (tested).
- **`src/lib/editor.ts`** (new) — framework-free editor logic: draft type
  (`Profile` minus schemaVersion/updatedAt), load state machine (empty / ready /
  malformed / unavailable), `saveDraft`, `validateDraft`, repeatable add/remove/
  update helpers, month-field & bullets bridging, `isEmptyProfileState` for the
  onboarding state. All unit-tested.
- **`src/lib/profile.ts`** — `SkillSchema` now carries an `id` (skills must be
  addressable list items like experience/education; migration and tests updated).
- **`wxt.config.ts`** — added `permissions: ['storage']` (narrowest permission enabling
  `browser.storage.local`; verified in built manifest) and remapped the `@/` alias
  to `./src/` (WXT's default alias points at the project root; our code lives under
  `src/lib/` per knowledge.md).
- **`README.md`** — rewritten for the actual project (dev commands, options-page
  usage, privacy model, permission note).
- **Tests**: `src/lib/editor.test.ts` (new, 18 tests): empty onboarding state,
  persistence after "reload" (save → fresh load → same content), invalid input
  rejection (bad month, end<start, missing bullets, bad URL — validation errors AND
  storage refusing the write), sample-seeding never auto-persists, dirty tracking,
  repeatable add/remove/update purity, date/bullets bridging. Suite: **70 tests
  passing** (4 files).

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 70/70 passed**
- `npm run compile` → **exit 0** (after fixing: `@/` alias resolution, generic
  narrowing in App.tsx, missing `id` on skills surfaced by the typed UI wiring)
- `npm run build` → **exit 0**; verified built manifest: `options_ui.page =
  options.html`, `permissions = ["storage"]`
- `git commit` → `options page: profile editor over validated storage + storage permission`

### Limitations / known issues
- Browser-level behavior (beforeunload guard, month-input UX, real reload flow)
  is unit-tested at the logic level only; no Playwright/e2e run. Manual verification
  steps for the user: load `.output/chrome-mv3` unpacked, open Options, save a
  profile, close/reopen, confirm persistence.
- Sensitive-data (contact/legal) editing UI is NOT yet in options — it belongs to
  the same page but was split off to keep this commit reviewable; next prompt.
- The `@/` alias now works at build time; tests use relative imports (vitest path
  alias not configured).
- Skills gained an `id` — a schema-shape change; storage migration not needed
  (legacy mapper assigns ids at copy time), but any user-created v2 profiles from
  before this commit would fail validation and land in the `malformed` recovery
  flow (recoverable via the new banner).

### Next
- Prompt 05 / phase 1c: extend options page with the sensitive profile section
  (contact, legal, voluntary disclosures — stored under the separate sensitive key,
  never projected into AI-safe data), plus popup surface showing profile status.

---

## Done (2026-10-12, task 5 / Prompt 03: validated storage service)
- **`src/lib/storage.ts`** refactored into a typed storage service with discriminated results.
  Every load returns `StorageResult<T>` distinguishing **ok / absent / malformed /
  unavailable (storage API threw) / quota (write rejected for size)** — callers no longer
  guess. Malformed results carry a recoverable `raw` field (the corrupt stored value);
  corrupt data is **never silently overwritten** — recovery happens only via explicit
  `resetProfile()` / `resetSensitiveProfile()` calls.
- New API: `loadProfile`, `loadSensitiveProfile`, `saveProfile`, `saveSensitiveProfile`
  (zod-validated on read AND write; write-failure returns result instead of throwing,
  `null` = success), `resetProfile` (empty valid profile), `resetSensitiveProfile`
  (all-`undisclosed` sentinels + RFC 2606 `.invalid` email — no invented personal data,
  satisfying min(1)/z.email schema constraints), and `STORAGE_KEYS`.
- Migration `migrateLegacyProfile` now distinguishes `none | legacy_profile |
  blocked_existing | blocked_corrupt_target` and refuses to proceed when the target key
  is malformed (raw preserved for recovery) or storage is unavailable. Legacy key is
  never deleted or modified. Pure mapper `mapLegacyToProfile` extracted and exported
  for direct testing (skips unparseable start dates with warning; coerces bad end
  dates to null, never invents dates).
- **No PII in errors**: failure messages contain only storage key names, error type
  names (e.g. `QuotaExceededError`) and issue counts — zod issue text (which can quote
  values) is deliberately not embedded; `raw` is available for explicit salvage.
- **No secrets in storage**: profile payloads are schema data only; `.strict()`
  parsing rejects any extra fields (e.g. a token/cookie field cannot be sneaked in).
- **`src/lib/legacy.ts`** (new): `LegacyProfileV1` type extracted to avoid coupling;
  legacy reads now validated with a loose-but-real schema (`z.looseObject`), so junk
  legacy data returns `malformed` instead of being trusted blindly.
- **Tests**: `src/lib/storage.test.ts` grown to **25 tests, 52 total across 3 files,
  all passing**. New coverage: absent vs malformed vs unavailable distinctions, raw
  recovery without overwrite, get-throw → unavailable, write-throw → quota
  (QuotaExceededError) vs unavailable, no-PII message assertion, save-rejects-invalid
  without writing, sensitive absent/malformed, resets (explicit-only, all-undisclosed,
  AI-safe untouched by sensitive reset and vice versa, legacy key untouched), legacy
  junk → malformed with raw, migration blockers (existing, corrupt target preserved,
  malformed legacy, storage-down), and pure-mapper truthfulness tests.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 52/52 passed** (3 files)
- `npm run compile` (tsc --noEmit) → **exit 0** (two real type bugs found & fixed:
  null-vs-ok narrowing on write result; union narrowing on StorageResult)
- `npm run build` (wxt build, chrome-mv3) → **exit 0**
- `git commit` → `storage service: discriminated results, quota/unavailable, resets, no-PII errors`

### Limitations / known issues
- Quota detection keys off `QuotaExceededError` names; other vendors may need mapping
  added when firefox build is exercised.
- Resets are API-level; no UI confirmation flow exists yet (options UI, next phase).
- Browser-runtime storage behavior still untested beyond mocks (unit-level only).
- The sensitive reset uses `undisclosed@example.invalid` (schema requires a valid
  email format); UI must treat a `.invalid` email as "not yet provided".

### Next
- Prompt 04 / roadmap phase 1b: options entrypoint UI (profile editor, load-sample,
  migration trigger, malformed-data recovery banner showing `raw`), add `storage`
  permission in `wxt.config.ts`, README setup section.

---

## Done (2026-10-12, task 4 / Prompt 02: profile schema + evidence model, v2)
- **`src/lib/profile.ts`** — replaced starter schema with complete, optional-field-friendly
  zod v4 model (`PROFILE_SCHEMA_VERSION = '2'`): headline, summary, displayName,
  locationLabel, skills (with `status: claimed|verified` + optional **EvidenceRef**
  {kind enum, id, quote} back-references), experience ([]), education
  (inProgress default false), certifications, projects, languages (CEFR-like enum),
  portfolio/github/linkedin URLs (z.url() validated), preferences (targetTitles,
  workModes enum onsite|hybrid|remote, targetLocations, applicationAnswers the user
  explicitly wrote). `.strict()` everywhere; no invented defaults — all defaults are
  empty arrays/false schema markers; `parse({})` yields a valid empty profile.
  Exported `Profile` + all section types.
- **`src/lib/sensitive.ts`** (new) — SEPARATE sensitive schema (`SENSITIVE_SCHEMA_VERSION = '2'`):
  contact (email z.email, phone, free-text address, cityLabel), legal
  (workAuthorization enum incl. `undisclosed`, sponsorshipNeeded), voluntary
  (gender/raceEthnicity/veteran/disability enums incl. `undisclosed`), documents
  (compensationExpectation, governmentIdMasked, notes). Shares NO data keys with the
  AI-safe profile (both have only `schemaVersion` metadata in common).
- **`src/lib/storage.ts`** — split keys: `job-profile.v2` (AI-safe) and
  `job-profile.sensitive.v2` (sensitive), typed get/save with zod on every read;
  `getProfile`/`getSensitiveProfile` return **null** on missing OR corrupt data (never throw).
  Legacy key `job-profile` (starter v1) preserved read-only via `getLegacyProfile()`.
  **Non-destructive migration** `migrateLegacyProfile()`: copies legacy data to v2 key,
  NEVER deletes the legacy key, refuses to overwrite an existing v2 profile, skips
  experience items whose legacy start date isn't YYYY-MM (with warning, no invention,
  no date guessing), composes displayName only from provided first/last, does NOT
  migrate email/phone (they belong to the sensitive profile — structural separation
  verified in tests).
- **`src/lib/sample-profile.ts`** — updated to v2 with both fakes: `sampleProfile`
  (AI-safe, fully invented fake data: Test User / test@example.com / Acme Fake Co)
  and `sampleSensitiveProfile` (fake contact + all-voluntary "undisclosed").
- **Tests** (37 total, all passing):
  - `src/lib/profile.test.ts` (19): minimal profile validity + empty defaults,
    sample round-trip, strict rejection of unknown keys, wrong schema version,
    malformed month (2020-13), end < start, malformed full date (day 32), bad URL,
    bad language/seniority/evidence enums, empty bullets/ids, omission of every
    optional field, skill status defaults to claimed, structural absence of
    contact/legal/voluntary fields from the AI-safe profile.
  - `src/lib/sensitive.test.ts` (8): round-trip, all-undisclosed acceptance,
    invalid email rejection, bad legal enum + extra-key rejection, wrong version,
    three structural separation tests (incl. zero shared data keys between schemas).
  - `src/lib/storage.test.ts` (10): mocked `browser.storage.local` (vi.hoisted map),
    null on missing/corrupt, valid round-trips, save rejects schema-invalid input
    without writing, legacy read, and 3 migration tests (copy preserved legacy,
    skip-with-warning, no-overwrite, no-op).

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 37/37 passed** (3 files)
- `npm run compile` (tsc --noEmit) → **exit 0**
- `npm run build` (wxt build, chrome-mv3) → **exit 0**
- `git commit` → `profile schema + evidence model (v2)`

### Limitations / known issues
- Migration copies truthfully but dropsENTA legacy email/phone (by design — sensitive
  profile is separate and empty until the user fills it via options UI, phase 1b).
- Legacy free-form dates that aren't YYYY-MM are skipped with warnings (not guessed).
- Options UI (entrypoints/options/) does not exist yet — storage helpers are ready
  but nothing user-facing reads them. `storage` permission still not declared in the
  manifest until that UI lands (rule 13).
- No destructive migration was performed anywhere; legacy key remains in storage
  until a future explicit, tested cleanup task.

### Next
- Roadmap phase 1b (next prompt): options entrypoint UI to author/edit the v2
  profile + sensitive profile, add `storage` permission in `wxt.config.ts`, load
  sample profile button, and a first real migration trigger from the UI.

---

## Baseline audit (2026-10-12, task 3): see prior entry below — 13-phase roadmap established.
## Previous tasks
- Task 3: repository audit + phased plan (commit `bfd4a8b`). node_modules missing
  resolved by `npm ci`.
- Task 2: profile schema + storage (`profile schema + storage`, commit `72ed962`).
- Task 1: initial scaffold (commit `0936b2d`).
