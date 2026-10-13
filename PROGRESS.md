# PROGRESS

## Done (2026-10-13, task 19 / Prompt 17: opt-in AI-assisted field mapping)
A NARROW semantic-suggestion layer for fields the deterministic classifier cannot
confidently recognise. AI maps a field to an EXISTING saved-answer category; it
never answers, never fills, and never touches the DOM.
- **`src/lib/autofill/mapping.ts`** (new) — strict zod v4 (`.strict()`) request /
  response / proposal contracts plus the eligibility gate, request builder,
  response validator, proposal + approval, and one orchestrator:
  - **Request (the only thing sent):** `{schemaVersion, task:'map-fields',
    allowedCategories, fields:[{fieldId,label,kind}]}`. NO values, profile, job,
    settings, DOM/HTML, URLs, employer content or sensitive data.
  - **Eligibility:** ambiguous/unsupported fields only, interactable +
    single-valued (excludes multi-select, disabled, read-only, hidden, custom
    combobox widgets), with a usable non-sensitive label (defense-in-depth
    sensitive-indicator regex). Recognised/excluded fields are never eligible.
  - **Allowed categories exclude** workAuthorization/sponsorship (never infer
    legal status) and state/country (no saved source); they are further narrowed
    to categories the user actually has saved answers for.
  - **Response:** fixed enum categories + bounded confidence (0–1) + fixed
    reason code; rejects unknown props/categories, duplicate/unknown field ids,
    malformed confidence and oversized payloads. Confidence < 0.7 stays manual.
  - **Orchestrator** reuses the existing provider transport
    (`AiProvider<MappingRequest>`) and `callProviderOnce`/`mapProviderFailure`
    from `src/lib/ai/run.ts` (now exported + generic) — no second client.
    `aiEnabled:false` and a `null` provider short-circuit BEFORE any request is
    built or sent (zero calls). Failures are typed `AiError`s, single attempt.
- **`src/lib/autofill/plan.ts`** — `buildFillPlan` accepts optional, strict
  `categoryOverrides` (fieldId→category). Applied ONLY where the deterministic
  classifier is ambiguous/unsupported; never over an excluded or recognised
  field; legal categories are never overridable. The planner still resolves the
  value from the saved profile. Existing callers/behavior unchanged.
- **`src/lib/autofill/schemas.ts` / `page.ts`** — value-free descriptor flags
  `multiple`/`disabled`/`readOnly`/`hidden` (booleans only; `isElementHidden`
  reused from `execute.ts`) so the mapping gate can exclude non-interactable and
  multi-select controls.
- **`src/lib/ai/provider.ts` / `proxy.ts` / `run.ts`** — `AiProvider<Request =
  AiRequest>` is now generic (proxy is generic too); `callProviderOnce` +
  `mapProviderFailure` exported for reuse. No behavior change for existing
  resume/answer callers (suites unchanged).
- **`entrypoints/popup/App.tsx`** — smallest safe UI: a gated
  **"Suggest field mappings with AI"** action (shown only when `aiEnabled` and
  eligible fields exist) with a plain-language explanation of the exact minimal
  data sent; suggestions are approved PER FIELD and then re-planned through the
  SAME `buildFillPlan`; the existing **Confirm & fill** is still required.
  Cancel clears everything. Since this build configures no provider
  (`MAPPING_PROVIDER = null`), the action reports "unavailable" and fields stay
  manual — the documented integration blocker.
- **Follow-up (privacy-disclosure fix, committed separately):** the popup
  AI-mapping disclosure is now an exact, tested constant (`MAPPING_DISCLOSURE` in
  `mapping.ts`) instead of inline prose. It states that with a configured
  provider and an explicit request only the selected eligible fields'
  **normalized labels, control types and available saved-answer category names**
  are sent; that the labels are **page-derived and may contain website-supplied
  text**; and exactly what is NOT sent (field values, profile/saved answers, job
  description, full page HTML/DOM, URLs, sensitive/legal/compensation). The
  contradictory "no page content / no page text" wording in `README.md` and
  `docs/autofill-compatibility.md` was corrected. No mapping behavior, schema,
  permission or provider-configuration change; `MAPPING_PROVIDER` stays `null`.
- **`src/lib/autofill/mapping.test.ts`** (new, **28 tests**) — AI off ⇒ zero
  calls; scan alone never calls; minimal request shape (no profile/job/settings/
  values/page text); sensitive & non-interactable fields excluded; strict
  response validation (unknown/duplicate/oversized/stale); low-confidence stays
  manual; cancellation makes no call/write; mapping module never imports the
  executor (source scan); approved suggestions flow planner→executor; missing
  answers stay manual; legal/compensation/voluntary/auth/multi-select never
  eligible; unavailable/rate-limit/timeout/invalid-response typed failures;
  deterministic classification unchanged (overrides can't touch excluded or
  recognized fields, nor supply a legal category); no `fetch()` outside the
  provider; descriptor schema still strict.
- **`README.md` / `docs/autofill-compatibility.md`** — AI mapping section:
  off-by-default, exact data sent, eligible/excluded categories, suggestions-only
  guarantee, backend-proxy requirement and the integration blocker.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 573/573 passed** (35 files; 545 baseline + 28 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, **no** `host_permissions`

### Privacy audit
- AI is OFF by default (`aiEnabled:false`); zero provider/network calls when off
  (asserted). No `fetch()`/network outside the provider abstraction (asserted).
- No field values, profile/job/settings content, DOM/HTML, URLs, employer content,
  sensitive data, API keys or telemetry in requests, proposals, errors or logs.
- No new manifest/host permissions; content-script `matches` unchanged; no
  dependency added; no direct third-party API integration.
- Approved mappings still pass through the deterministic planner + executor;
  explicit per-field approval and the existing Confirm step are both required.

### Verified vs unverified
- **Verified (jsdom unit tests):** all bullets above. **Not** verified: a real
  browser, a live provider, or any specific Workday behavior.
- **Integration blocker:** no backend AI endpoint is configurable anywhere in
  this build; the popup AI action is therefore inactive (reports unavailable)
  until an endpoint/provider is configured. This was implemented rather than
  invented (no new setting/permission added).

### Limitations / known issues
- The provider transport is used generically, but the popup wires no endpoint, so
  the AI path is exercised only by tests.
- Category-only mapping cannot fill custom comboboxes or multi-selects (by
  design); those stay manual.
- Single attempt, no retry: timeout/rate-limit surface as typed errors; the
  caller keeps fields manual (no silent provider switch or larger payload).

### Next
- Optionally configure a backend AI endpoint (existing proxy pattern) and pass a
  real `AiProvider<MappingRequest>` into the popup so the suggestion action goes
  live; otherwise keep autofill fully deterministic.

---

## Done (2026-10-13, task 18 / Prompt 16: Workday compatibility discovery & fixtures)
Focused **discovery + fixture** task. No Workday adapter, no AI mapping, and no
broad change to autofill behavior. Evidence is split into **demonstrated**
(our fixtures/tests), **inferred** (standard HTML/ARIA semantics) and
**unverified Workday behavior** (no authenticated Workday environment was used).
- **`src/lib/autofill/schemas.ts`** — `fieldDescriptorSchema` gains two optional
  value-free metadata fields: `role` and `ariaHasPopup` (used to spot custom
  widgets). Still `.strict()`.
- **`src/lib/autofill/page.ts`** — label extraction now resolves
  **`aria-labelledby`** to the referenced element(s) text (previously ignored —
  a real defect), and `baseAttributes` captures `role` + `aria-haspopup`.
  Values are still never read.
- **`src/lib/autofill/classify.ts`** — a custom ARIA combobox/listbox
  (explicit `role="combobox"`/`listbox`, or `aria-haspopup` listbox/tree/grid)
  is now classified **ambiguous → manual** instead of being considered fillable
  text. Native `<select>` is explicitly unaffected; `aria-haspopup="menu"` is
  not treated as a picker.
- **`src/lib/autofill/execute.ts`** — after writing, the executor checks the
  browser's **constraint validity**; a value the page still deems invalid
  (unsatisfied `required`/`pattern`/`type`) returns `verify-failed`, **restores**
  the control to its previous value, and fires no events (so "left unchanged" is
  accurate). Inline validation messages are not parsed.
- **`src/lib/autofill/workday.test.ts`** (new, **18 tests**) — synthetic
  fixtures + characterization: visible/`aria-label`/`aria-labelledby` label
  extraction; native `<select>` vs custom `role="combobox"` (and
  `aria-haspopup` listbox/menu); custom combobox excluded from the plan; radio
  legend context; descriptive vs consent checkboxes; required `pattern` field
  `verify-failed` + value restored, and valid value filled; replaced field →
  `disconnected`/no re-resolution; multi-select skipped and selections intact;
  compensation/legal exclusions; stale-session rejection; no network call.
- **`docs/autofill-compatibility.md`** (new) — per-pattern compatibility matrix
  (supported / partially supported / unsupported / unverified) with the fixture
  behind each status, confirmation requirement, limitations and manual fallback.
- **`README.md`** — documents custom-combobox/manual behavior, constraint
  verification and links the matrix.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 545/545 passed** (34 files; 527 baseline + 18 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, **no** `host_permissions`
- Inspected diff/status: no real candidate/application data or secrets; no
  `.env`, `node_modules` or build artifacts staged; `wxt.config.ts`, manifest
  permissions and content-script `matches` unchanged; matching/tailoring/PDF/
  application-log sources NOT modified; no new dependencies.

### Demonstrated vs unverified
- **Demonstrated (fixtures/tests):** labels (visible/`aria-label`/
  `aria-labelledby`), native single-select, custom combobox → manual, radio
  legend scoping, checkbox classification, required+`pattern` verification,
  replaced-field refusal, multi-select refusal, sensitive exclusions, stale
  session, offline.
- **Inferred:** ARIA combobox/listbox role semantics; that popup widgets need
  real interaction the engine does not perform.
- **Unverified on Workday:** everything site-specific (async option loading,
  custom widgets without ARIA roles, `<div role="combobox">` without a native
  control, inline validation rendering, datalist comboboxes). No Workday
  environment was accessed.

### Limitations / known issues
- Inline validation messages and site-specific JS validation are not parsed;
  only the browser constraint API is checked.
- A custom combobox with neither `role="combobox"` nor an
  `aria-haspopup` listbox/tree/grid cannot be detected and may be treated as
  plain text (documented, unverified).
- `<div role="combobox">` widgets with no native control are never scanned.
- jsdom-only verification: no real browser event loop/framework render cycle;
  no specific-site compatibility is claimed.

### Next
- If pursued, a real Workday test environment (permitted, authenticated) to
  upgrade the "unverified" rows; otherwise keep autofill local and confirmed.

---

## Done (2026-10-13, task 17 / Prompt 15: autofill hardening & compatibility)
- **`src/lib/autofill/execute.ts`** (hardened) — reliability + safety:
  - Controlled inputs: text/textarea/select writes go through the element's
    **native prototype value setter** (NOT any instance-level setter a framework
    installs), so React-style controlled inputs observe the change; bubbling
    `input` + `change` are fired. No React internals, no validation bypass.
  - **Post-fill verification**: every write is read back against the intended
    state; a write that did not take effect returns the new typed
    `verify-failed` status and emits **no** events instead of claiming success.
  - Selects: candidate options exclude placeholders (`Select one`, empty value,
    disabled/hidden) and disabled options; an ambiguous/absent match stays
    `no-match` — the first option is never chosen just because it exists.
  - **`<select multiple>` is detected and NEVER filled** (the plan carries a
    single string answer): it returns the existing typed `unsupported-element`
    with a fixed, value-free message and leaves every selected option exactly as
    it was. Ordinary single-select behavior (placeholder exclusion, unique
    matching, post-fill verification) is unchanged.
  - Radio groups scoped by (form, `name`); a checkbox/radio already in the
    planned state is left untouched (no unnecessary toggle, no event).
    Post-fill state is verified before success.
  - Gates add `inert` subtrees and `[hidden]`/`aria-hidden` ancestors alongside
    disabled/read-only/`display:none`/`visibility:hidden`/disconnected.
  - Fixed, value-free per-field messages (new `verify-failed` literal added to
    `FILL_STATUSES` in `schemas.ts`).
- **`src/lib/autofill/page.ts`** (hardened) — scan→fill session binding: each
  successful scan mints a `scanId` (returned in the scan response); the fill
  request must echo the CURRENT token (`autofillFillRequestSchema` now requires
  `scanId`). A missing/unknown/after-rescan token is rejected with a typed
  `stale-session` (or `invalid-plan`) error and **no writes**. Shaped-but-tampered
  scan/fill payloads are rejected with typed errors instead of being treated as
  foreign messages. Element references stay in memory for one round trip only.
- **`entrypoints/popup/App.tsx`** — carries `scanId` from scan → confirm, sends
  it with the fill request, and surfaces a distinct stale-session message;
  cancel/restart clear it. Confirmation requirement unchanged.
- **Tests** (2 new files, **27 tests**; suite **527 passing (33 files)**):
  `hardening.test.ts` (16) — React-controlled input/textarea native-setter +
  bubbling events; `verify-failed` with no events; placeholder never selected;
  real option still selected; ambiguous select unchanged; multi-select skipped
  with selections left unchanged and a value-free result while a single-select
  still fills; radio-group isolation;
  already-checked checkbox not toggled; unchecked checkbox checked once;
  disabled/read-only/hidden/inert/disconnected skipped; no submit/click; error
  messages carry no values. `session.test.ts` (11) — scanId minted; matching
  token fills; stale token after re-scan rejected; unknown/absent token rejected;
  tampered payload rejected; fill before scan rejected; cancel writes nothing;
  foreign messages ignored; scanned element identity preserved when the form
  structure changes; replaced element → `disconnected` and left untouched;
  error responses never contain a planned value. Existing autofill, matching,
  tailoring, PDF, application-log and storage suites unchanged and passing.
- **Follow-up safety fix (committed separately)** — multi-select detection in
  the executor (`<select multiple>` → `unsupported-element`, selections
  untouched). No profile schema, planner, classifier, UI flow, manifest,
  permission or dependency changes.
- **`README.md`** — autofill section documents the hardening (native setter +
  verification, placeholder/state rules, per-scan session token) and its limits.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 527/527 passed** (500 baseline + 27 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, **no** `host_permissions`
- Pre-commit inspection: no secrets, `.env`, `node_modules` or build artifacts
  staged; content-script `matches` unchanged; matching/tailoring/PDF/
  application-log sources were NOT modified; `wxt.config.ts` untouched.

### Limitations / known issues
- Verified with jsdom + pure unit tests only. **jsdom does not reproduce a real
  browser**: no native constraint validation, no real event loop/framework
  render cycle, no layout for visibility heuristics. Compatibility with any
  specific site is NOT claimed.
- Controlled-input handling uses the documented native-setter + events
  technique; a framework that re-renders from its own state could still revert
  a value — the executor only verifies the immediate post-write state.
- Session binding is per content-script session/tab; a page navigation between
  scan and fill yields `disconnected` (removed nodes) and must be re-scanned.
- `AutofillScanResponse | AutofillFillResponse` still share a `kind: 'ok'`
  variant; consumers narrow by property. Unchanged from Prompt 14.

### Next
- Workday-specific field handling and/or AI-assisted semantic mapping (with the
  existing backend-proxy AI interface), keeping autofill local and confirmed.

---

## Done (2026-10-13, task 16 / Prompt 14: deterministic autofill foundation)
- **`src/lib/autofill/schemas.ts`** (new) — `.strict()` contracts: VALUE-FREE
  `fieldDescriptorSchema` (fieldId, kind text/textarea/select/radio/checkbox,
  inputType, labelText, ariaLabel, name, elementId, autocomplete, placeholder —
  no `value` field exists), `fieldDescriptorsSchema` (cap 200),
  `fillInstructionSchema`/`fillPlanSchema` (value min-1, `source:
  profile|sensitive`, `requiresConfirmation`, cap 200), `fillReportSchema` +
  `FILL_STATUSES` (filled/not-found/disconnected/disabled/read-only/hidden/
  unsupported-element/no-match/error), `FIELD_CATEGORIES`, `formatIssues`.
- **`src/lib/autofill/classify.ts`** (new) — deterministic classifier over
  labelText/ariaLabel/placeholder/name/id/autocomplete (+ input type). Exclusions
  run FIRST and win: password/auth, OTP/2FA, payment/bank, CAPTCHA/bot, EEO/
  voluntary demographics, compensation, legal/consent/attestation, hidden
  inputs. Strong signals (`autocomplete`, `input[type]`) preferred over
  word-bounded label patterns; generic labels (Name/Other/Details/Additional
  information) → ambiguous; multiple matches → ambiguous; none → unsupported.
  Choice kinds (radio/checkbox) only allow choice categories. Reasons are fixed
  literals — no values exist to leak.
- **`src/lib/autofill/plan.ts`** (new) — `buildFillPlan({descriptors, profile,
  sensitive})` re-validates all inputs against the EXISTING profile/sensitive
  schemas (invalid → typed `invalid-input` with path+message only). Maps
  firstName/lastName/email/phone/city → sensitive contact; linkedin/portfolio/
  skills/summary → AI-safe profile; workAuthorization/sponsorship → sensitive
  legal, CHOICE fields only and never `undisclosed`. state/country are
  recognised but have no saved source → manual. Missing answer → manual entry
  (never ""/false/guess). Per-field review entries carry decision + fixed
  reason (+ proposedValue for display only); sensitive entries tagged
  `source:'sensitive'` and kept out of profile payloads. Pure, deterministic,
  no DOM/no AI/no network.
- **`src/lib/autofill/execute.ts`** (new) — isolated executor: re-validates the
  plan (`invalid-plan` → executes nothing), resolves targets by fieldId, checks
  connected/disabled/read-only/hidden, fills text/textarea via the NATIVE value
  setter + `input`+`change` events, matches select options and radio groups/
  checkboxes only on an UNAMBIGUOUS label/value match, and returns per-field
  typed outcomes with fixed, value-free messages. Never submits a form, never
  clicks buttons, never navigates.
- **`src/lib/autofill/page.ts`** (new) — `collectFieldDescriptors(root)` reads
  ONLY control metadata (never values), skips
  hidden/submit/button/image/reset, groups radios by (form,name) into ONE
  descriptor with the fieldset legend, caps at `MAX_SCAN_FIELDS`.
  `createAutofillSession(doc)` handles the two strict messages
  (`job-apply/autofill-scan`, `job-apply/autofill-fill`) and returns
  `undefined` for foreign messages; scan→fill holds element refs in memory only.
  `validateScanResponse`/`validateFillResponse` for the popup.
- **`src/lib/autofill/index.ts`** (new) — public surface.
- **`entrypoints/content.ts`** — chains the autofill session after the capture
  handler in the SAME listener (capture first, then autofill; foreign messages
  still return undefined). No new matches, no manifest change.
- **`entrypoints/popup/App.tsx`** — smallest safe user-initiated flow: an
  *Autofill this application form* button → scan → load profile + sensitive
  (absent tolerated) → build plan → review pane (*Will fill* vs *Needs manual
  input*) → **Confirm & fill** or *Cancel — change nothing* → count-only
  summary. Reuses the existing activeTab + `scripting.executeScript` injection
  fallback; responsive `aria-busy`/disabled states. No auto-fill, no submit.
- **Tests** (5 new files, **48 tests**; suite **500 passing (31 files)**):
  `classify.test.ts` (12) — normalization, supported fields, weak-substring and
  generic/ambiguous cases, choice-kind limits, non-form controls, and the full
  exclusion table. `plan.test.ts` (8) — ordered planning with correct sources,
  choice-only work-auth/sponsorship, missing answers (incl. `undisclosed`),
  excluded-field omission, sensitive separation (no voluntary/compensation in
  the plan JSON), determinism + no input mutation, invalid-input issues without
  values. `execute.test.ts` (13, jsdom) — native-setter fill with input+change,
  textarea, invalid plan no-op, disabled/read-only/hidden/disconnected/
  not-found/unsupported-element gates, only-planned-fields-touched, select
  unambiguous vs ambiguous/absent, radio unique vs duplicate (no guessing),
  checkbox match/skip, no submit/click, value-free messages. `page.test.ts`
  (10, jsdom) — value-free descriptors (a prefilled value never appears), skip
  list, radio grouping, scan cap, session scan/fill/foreign-message/no-fields,
  invalid-plan rejection, validator junk rejection. `boundaries.test.ts` (5) —
  strict-schema rejection, zero network across classify→plan→execute, source
  scan (no AI/fetch/direct storage), and a manifest guard proving permissions
  are still exactly `storage/activeTab/scripting` with no host permissions.
- **`README.md`** — new "Autofill (deterministic foundation, no AI)" section:
  supported field table, excluded categories, user-confirmation behavior,
  integration limits, and explicit "Workday-specific handling and AI-assisted
  semantic field mapping are NOT implemented"; roadmap updated.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 500/500 passed** (452 baseline + 48 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, **no** `host_permissions`
- Pre-commit inspection: no secrets, `.env`, `node_modules` or build artifacts
  staged (`.wxt/tsconfig.json` ephemeral regeneration left uncommitted as in
  every prior task; `.output/` untracked); matching (Prompt 09), tailoring
  (Prompt 11), PDF (Prompt 12) and application-log (Prompt 13) sources were NOT
  modified; `wxt.config.ts` untouched.

### Limitations / known issues
- **Workday-specific handling and AI-assisted semantic field mapping are NOT
  implemented** (explicitly out of scope).
- State/region and country are recognised but have no saved source in the
  current schemas, so they are always reported as manual entry.
- Work-authorization/sponsorship answers are only planned for choice controls
  (select/radio/checkbox); a free-text work-authorization field is left manual.
- The popup scan/session holds element references in memory for one scan→fill
  round trip only; a page navigation between scan and fill yields per-field
  `not-found`/`disconnected` results (no wrong-element writes).
- The content script is declared only for the starter `google.com` match; other
  sites rely on the existing activeTab-triggered injection fallback.
- Executor/UX verified with jsdom + pure tests; no real-browser e2e here.
- `AutofillScanResponse | AutofillFillResponse` share a `kind: 'ok'` variant, so
  consumers must narrow by property (e.g. `'report' in value`); harmless but
  worth tidying if the message surface grows.

### Next
- Workday-specific field handling and/or AI-assisted semantic mapping (with the
  existing backend-proxy AI interface), keeping autofill local and confirmed.

---

## Done (2026-10-13, task 15 / Prompt 13: local application log)
- **`src/lib/applications/schemas.ts`** (new) — strict (`.strict()`) model:
  `applicationSchema` { generated `id`, `jobId`, `status`, optional
  `applicationDate`/`followUpDate` (real `YYYY-MM-DD` calendar dates — regex +
  `isRealCalendarDate` rejects 2026-02-31/month 13), optional `notes`
  (trimmed, capped at `MAX_NOTES_CHARS` 4000; blank normalised to absent),
  `createdAt`/`updatedAt` ISO datetimes }, fixed `APPLICATION_STATUSES`
  (planned/applied/assessment/interview/offer/rejected/withdrawn) + labels,
  `applicationsRecordSchema` (max 1000), `emptyApplicationsRecord`,
  `createApplication`/`applyApplicationPatch` (injected `now`/`id` →
  deterministic; identity fields preserved, `updatedAt` bumped), pure list
  helpers (`upsertApplicationInList`, `removeApplicationFromList`,
  `findApplicationForJob`), `validateApplicationInput`/`formatZodIssues`
  (path+message only). NO salary/contact/credential fields exist.
- **`src/lib/storage.ts`** (minimal extension) — `STORAGE_KEYS.applications`
  = `job-applications.v1` with `loadApplications`/`saveApplications`/
  `resetApplications`, reusing the existing `loadValidated`/`writeValidated`
  service (absent/malformed+raw/unavailable/quota distinctions, never
  overwriting corrupt data). No other storage behaviour changed.
- **`src/lib/applications/service.ts`** (new) — domain rules over the storage
  abstraction, all returning the existing typed-result convention
  (`{ ok } | { ok:false, reason, message }` with reasons absent/malformed/
  unavailable/quota/job-missing/not-found/invalid; `raw` only for malformed):
  `listApplications` (absent → empty list), `createApplicationForJob`
  (validates fields, verifies the referenced job exists via `loadJobPostings`,
  allows deliberate repeats), `startTrackingApplication` (one-click flow reuses
  an existing application for the same job → `alreadyTracked: true`, no
  duplicate), `updateApplication`, `deleteApplication`. Every mutation loads
  first and aborts on malformed/unavailable storage (never overwrites);
  messages are fixed and never contain notes/job text. No AI, no network, no
  sensitive profile.
- **`src/lib/applications/presenter.ts`** (new) — pure view-model:
  `buildApplicationRows` (resolves title/employer/URL, flags orphaned
  references with `ORPHANED_JOB_LABEL`, never invents a title),
  `selectApplicationRows` (status filter + deterministic sort by updated /
  applicationDate (missing last) / created, tie-break by `id`),
  `APPLICATION_*` option lists.
- **`src/lib/applications/index.ts`** (new) — public surface (schemas +
  service + presenter) so the UI never touches `chrome.storage` directly.
- **`entrypoints/options/ApplicationList.tsx`** (new) — presentational list
  (pure props, `react-dom/server`-testable). The destructive delete control is
  wired ONLY when `confirmingDeleteId === row.id`, so a delete always requires
  an explicit confirmation; shows status select, application/follow-up dates,
  notes, employer, optional posting URL, Edit/Delete.
- **`entrypoints/options/ApplicationsPanel.tsx`** (new) — Options →
  **Applications** tab: track a new application (job select + optional date +
  notes), status change, edit notes/dates, two-step delete, filter/sort,
  Refresh; explicit "Replace with empty list" recovery for malformed storage;
  loading/empty/orphaned/storage-error states with safe fixed messages.
- **`entrypoints/options/App.tsx`** — new `applications` tab; **`JobsPanel.tsx`**
  — a *Track application* action per saved job (one-click, duplicate-safe);
  **`style.css`** — application-log styles.
- **Tests** (4 new files, +52 tests; suite **452 passing (26 files)**):
  `schemas.test.ts` (11) — defaults, all statuses + invalid status rejection,
  strict rejection of `salary`/`email`, malformed/impossible dates, notes cap +
  blank normalisation, patch identity preservation + null clears, list helpers,
  record/validation helpers. `service.test.ts` (22) — absent → empty list;
  malformed with recoverable raw and **never overwritten** on create/update/
  delete; unavailable + quota write failures (existing records preserved);
  job-missing rejection without writing; deliberate repeat allowed;
  one-click duplicate-safe reuse; status/notes persistence with bumped
  `updatedAt`; not-found; orphan keeps history (still editable/deletable);
  messages never leak notes or job title; zero network; source scan proving no
  sensitive/AI/fetch/direct-storage imports. `presenter.test.ts` (7) — row
  resolution, orphan flag, status filter, deterministic 3-key sorts
  (missing-last, id tie-break) and order-independence. `ui.test.ts` (7) —
  rendered title/employer/notes/dates/all statuses, orphaned label,
  **delete-confirmation gate** (no destructive confirm until
  `confirmingDeleteId` set), empty state, HTML-escaping of notes, no network.
  `storage.test.ts` (+5 regression) — absent/round-trip/malformed-raw/
  unavailable/quota/reset for the new key, and a check that only the local
  application key is written.
- **`README.md`** — new "Application log (local-only)" section documenting the
  storage key, record fields, status table, explicit-only behavior, duplicate
  and orphan policy, and filter/sort; roadmap updated.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 452/452 passed** (400 baseline + 52 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`
- Pre-commit inspection: no secrets, `.env`, `node_modules` or build artifacts
  staged (`.wxt/tsconfig.json` ephemeral regeneration left uncommitted as in
  every prior task; `.output/` untracked); matching (Prompt 09), tailoring
  (Prompt 11) and PDF (Prompt 12) source files were NOT modified.

### Limitations / known issues
- No reminder notifications, analytics, sync or job-alert features (explicitly
  out of scope); follow-up dates are stored/displayed only.
- Filtering is by single status (no multi-select) and sorting offers three fixed
  keys — deliberately modest and dependency-free.
- The application list is loaded once per panel mount (plus explicit Refresh);
  external edits made in another tab appear on Refresh, not live.
- Duplicate protection covers the one-click Jobs action; the explicit
  form intentionally allows repeat applications for the same job.
- UI is verified with `react-dom/server` presentational tests + pure
  presenter/service tests (no browser e2e in this environment).

### Next
- Wire the AI interface into a user-visible feature and/or application form
  autofill (roadmap), keeping the application log local-only.

---

## Done (2026-10-13, task 14 / Prompt 12: fixed-layout ATS-friendly resume PDF)
- **`pdf-lib@^1.17.1`** (new runtime dependency, lockfile committed) — MIT,
  pure-JS, browser-only PDF writer: no network at runtime, no native code, no
  extension permissions. Chosen over jsPDF because it is deterministic by
  construction (pinned metadata), has an explicit strict API, and lets us
  enforce the schema boundary + layout ourselves. `npm run build` bundles it
  into the options chunk only.
- **`src/lib/resume/pdf/text.ts`** (new) — pure `normalizeForPdf` (CRLF/tabs/
  NBSP/zero-width/typographic punctuation → ASCII equivalents, meaning
  preserved; accented Latin-1 kept verbatim) + `findUnsupportedCodePoints`/
  `formatCodePoints` (report `U+XXXX` only — never the source text).
- **`src/lib/resume/pdf/layout.ts`** (new) — pure, pdf-lib-free layout engine:
  `buildBlocks(resume)` emits a block ONLY for each present schema field;
  `wrapText` (word wrap + hard-break of over-long tokens like URLs);
  `wrapBlocks`; `paginate` keeps a section heading with the first content line
  and splits paragraphs taller than a page instead of clipping them. Renders
  NO internal metadata (ids, `relevance`/`required`/`preferred`/`neutral`,
  evidence refs, selection reasons/notes).
- **`src/lib/resume/pdf/render.ts`** (new) — `renderResumePdf(input)`:
  re-validates against the SAME strict `tailoredResumeSchema` (typed `invalid`
  result, path+code only), normalizes text, refuses non-WinAnsi characters
  (`unsupported-characters`, `U+XXXX`), draws A4 single-column selectable text
  (Helvetica; name/headline/contact/rule/section/entry/bullet styles; `Page X
  of Y` footer), and returns `{ blob, pageCount, filename }`. Deterministic:
  metadata dates pinned to the PDF epoch + `useObjectStreams: false` → identical
  input yields byte-identical output. Typed `render-failed` fallback; never
  throws for expected user-data failures. No storage read, no network, no AI,
  no sensitive import.
- **`src/lib/resume/pdf/download.ts`** (new) — `downloadBlob(blob, filename,
  env?)` with an injectable browser environment: creates a temporary object
  URL, clicks a hidden anchor, and removes the anchor promptly. On success the
  URL is revoked AFTER a short delay (`OBJECT_URL_REVOKE_DELAY_MS`, 10 s) so the
  browser can initiate the download before the Blob is released; on any
  setup/click failure the anchor is removed and the URL is revoked immediately.
  Stores nothing. (See the follow-up reliability fix at the end of this entry.)
- **`src/lib/resume/pdf/export.ts`** (new) — `generateAndDownloadResume(profile,
  job, deps?)` pipeline extracted from React so it is testable: tailor →
  render → download, each failure a typed outcome with a FIXED, safe message
  (`no-profile` / `insufficient` / `invalid` / `unsupported-characters` /
  `render-failed` / `download-unavailable`). No fabrication on any failure path.
- **`src/lib/resume/pdf/index.ts`** (new) — public surface. Kept as its own
  subpath so the Prompt 11 tailoring module carries no PDF dependency.
- **`entrypoints/options/ResumeExport.tsx`** (new) + **`JobsPanel.tsx`** —
  minimal Options → Jobs integration: selecting a saved job now also shows a
  `Resume PDF — <title>` section with a *Download tailored resume PDF* button
  (disabled + `aria-busy` while generating or when no profile is loaded). Uses
  the AI-safe `profile` already loaded by the panel; match-summary behavior is
  untouched. `style.css` gained a small `.resume-export` block.
- **Tests** (5 new files, **49 tests**; suite **400 passing (22 files)**):
  `render.test.ts` (16) — valid render + filename/page count, selectable text
  and NO image XObject, absent-section handling (no stray headings), 90-bullet
  multi-page flow with every bullet + footer present, byte-identical
  determinism, punctuation normalization (Café — “smart” … naïve → ASCII),
  typed `unsupported-characters` (U+65E5, text never echoed), strict rejection
  of `{}`/bad version/injected `apiKey`/`contactEmail` without leaking values,
  no internal ids/relevance/reasons/notes rendered, no `@`/phone, job title not
  rendered as experience, zero network calls, source scan proving no
  sensitive/AI/fetch/storage imports, matching+tailoring API intact.
  `export.test.ts` (7) — happy path downloads once with an `application/pdf`
  Blob; download failure; empty profile → `insufficient` (no PDF); schema-
  invalid profile → `invalid`; null → `no-profile`; non-WinAnsi → `unsupported-
  characters`; zero network. `layout.test.ts` (12) — wrapping, long-URL
  hard-break, present/absent sections, no internal metadata in text, headline
  dedupe, conditional rule, heading kept with first line, tall-paragraph page
  split with no dropped lines. `text.test.ts` (8) — normalization + punctuation
  table, Latin-1 preservation, code-point detection/format. `download.test.ts`
  (6) — anchor removed promptly + revocation DEFERRED (asserted not-called before
  `vi.runAllTimers()`, then called once with the created URL via fake timers),
  immediate single revoke when the click throws (no duplicate timer), cleanup on
  DOM-setup failure, no anchor/revoke when URL creation fails, typed failure
  without a browser env, no storage writes.
- **`README.md`** — new "Resume PDF export (fixed layout, ATS-friendly)"
  section (dependency rationale, integrity guarantees, limitations) and the
  tailoring heading/roadmap updated (PDF renderer now built).

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 400/400 passed** (351 baseline + 49 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`
- Pre-commit inspection: no secrets, `.env`, `node_modules` or build artifacts
  staged (`.wxt/tsconfig.json` ephemeral regeneration left uncommitted as in
  every prior task; `.output/` untracked); matching (Prompt 09) and tailoring
  (Prompt 11) source files were NOT modified.

### Limitations / known issues
- Built-in Helvetica (WinAnsi) covers Latin-1 only: non-Latin scripts/code
  points raise a typed `unsupported-characters` error rather than being
  transliterated, and no custom font is bundled.
- No in-page PDF preview (the browser download is the delivery mechanism) and
  no template/branding options; the download helper's real browser behavior is
  verified at the unit level only (no browser e2e in this environment).
- The options chunk grows (~515 kB minified) because pdf-lib is bundled into
  the options page; acceptable for an options-only feature, not code-split yet.
- Nothing claims the PDF passes any specific employer's ATS.

### Follow-up reliability fix (2026-10-13, task 14b: deferred PDF object-URL revocation)
- **Problem:** `downloadBlob` revoked the temporary Blob object URL synchronously
  in a `finally` right after `anchor.click()`, which can cancel the download
  because the browser resolves Blob URLs asynchronously.
- **Fix (`src/lib/resume/pdf/download.ts`):** the anchor is still removed
  promptly, but on success the object URL is revoked via
  `setTimeout(..., OBJECT_URL_REVOKE_DELAY_MS)` (10 s — comfortably longer than
  local Blob resolution while releasing the small resume Blob promptly; `file-saver`
  uses a more conservative 40 s for the same reason). On URL-creation / DOM-setup /
  click failure the anchor is removed and the URL is revoked immediately exactly
  once (no leak, no pending timer). Public API, filename, renderer, tailoring,
  manifest permissions and UI are unchanged.
- **Tests (`download.test.ts`, now 6):** deferred revocation verified with Vitest
  fake timers (`not.toHaveBeenCalled()` before `vi.runAllTimers()`, then one call
  with the created URL), plus cleanup on click throw / DOM-setup failure / URL-
  creation failure and no duplicate revocation after flushing timers.
- `npx vitest run` → **exit 0, 400/400 passed**; `npm run compile` → **exit 0**;
  `npm run build` → **exit 0**; manifest unchanged
  (`permissions = ["storage", "activeTab", "scripting"]`).

### Next
- Wire the AI interface into a user-visible feature and/or application form
  autofill (roadmap), keeping PDF rendering isolated from tailoring/matching.

---

## Done (2026-10-13, task 13 / Prompt 11: deterministic resume tailoring engine)
- **`src/lib/resume/schemas.ts`** (new) — strict (`.strict()`) output
  contract `tailoredResumeSchema` (v1): provenance (`source` = posting
  id/title/capturedAt ONLY — never the raw description), optional header
  (displayName/headline/locationLabel), optional summary
  (`basis: profile-summary | profile-headline | profile-skills` + verbatim/
  assembled text + `sourceIds`), skills (profile skill id, verbatim name/
  `status`/`years`/`evidenceRef`, annotation `relevance: required|preferred|
  neutral` + `matchedJobSkill` link), experience (id/company/title/location/
  dates/seniority + VERBATIM bullets + `relevance: relevant|fallback` +
  fixed reason ≤200), projects (id/name/description/links + skills projected
  as {id,name,status} + relevance/reason), education/certifications/languages
  (verbatim, always included), optional links, count-only `selectionNotes`.
  Caps: 24 skills (`SKILL_FILL_TARGET` 12), 12 projects, 12 notes.
  `validateTailoredResume` returns path+code issues (no values). Every
  selected item id EQUALS the profile item id → full reviewer traceability;
  EvidenceRefSchema is REUSED from profile.ts (see below), no competing
  schema.
- **`src/lib/resume/relevance.ts`** (new) — documented, tested TIER
  classifier (not a score — Prompt 09's formula/weights/vocabulary/threshold
  untouched): `buildJobSignal(job)` collects canonical skill ids per
  requiredness (`skills[]` + required quals → required; preferred quals →
  preferred; required wins collisions; non-vocabulary posting skills absent,
  never guessed) + posting title tokens + `hasSignal`;
  `skillTier(signal, profileSkillName)` → required|preferred|neutral;
  `entryRelevance(signal, title, texts)` → overlap classification with FIXED,
  non-quoting reasons (required-skill mention / title overlap / preferred
  mention / no-overlap / no-signal).
- **`src/lib/resume/tailor.ts`** (new) — `tailorResume(profile, job)` typed
  result: `ok` (strict payload) | `insufficient` (fixed literal reason —
  nothing renderable, nothing fabricated) | `invalid` (missing input
  markers / schema issues, path+CODE only, never profile/job text). NO
  throws for expected user-data failures. Selection policy (documented in
  the module header): skills ranked required→preferred→neutral-fill-to-12
  (cap 24, duplicate canonicals keep first occurrence, profile iteration
  ONLY so posting skills absent from the profile are never added, claimed
  stays claimed); experience keeps SOURCE (chronological) order — relevance
  decides inclusion only (overlap → keep overlapping; signal-with-zero-
  overlap → keep whole history unchanged; no signal → everything as-is);
  projects overlap-filtered with omission (never fabrication) when a
  signaling posting matches nothing; education/certifications/languages
  always verbatim (dropping credentials could misrepresent); summary =
  profile.summary verbatim → else headline → else "Skills: …" from selected
  names → else OMITTED. Output passes `tailoredResumeSchema.parse` as an
  invariant. Offline: no AI (`runAiRequest` never imported), no network, no
  storage reads/writes, no clock, no settings input at all, no sensitive
  profile path.
- **`src/lib/resume/index.ts`** (new) — public surface re-export.
- **`src/lib/profile.ts`** — smallest possible reuse change: `EvidenceRefSchema`
  is now `export`ed (same pattern as sharing `ExperienceRangeSchema` from
  settings in Prompt 07). No schema shape change.
- **Tests** (2 new files, 37 tests; suite **351 passing (17 files)**):
  `resume/relevance.test.ts` (10) — required/preferred split incl.
  required-wins collision, unrecognized posting skills never guessed,
  empty-posting no-signal, alias tiering (k8s → preferred kubernetes),
  entry relevance reasons (incl. reason never quoting entry text), no-signal
  conservative inclusion, AND a pin that `MATCH_WEIGHTS` are still
  35/10/20/20/15. `resume/tailor.test.ts` (27) — required skills ranked
  ahead of a profile-first preferred skill (source order kept within tier;
  `matchedJobSkill` links only); Kubernetes (in posting, not profile)
  never added; claimed stays claimed with no invented evidence; duplicate
  canonical dedupe; experience/project selection verbatim with ids, bullets
  and dates deep-equal to the profile; no-signal keeps full history in
  order; signal-with-zero-overlap keeps history (reason "included
  unchanged"); relevance filter drops the unrelated entry/project; "no
  invented content" sweep (all bullets ∈ profile, summary === profile
  summary, no metric-style fabrication patterns); education/certs/languages
  always present; header/links verbatim and NO '@'/'555-0100'; empty
  posting → all-neutral skills + fallback history + provenance intact;
  invalid profile/job → typed issues without leaking 'Fake'/'Berlin'/
  'Engineer' text; null inputs → explicit missing markers; empty and
  header-only profiles → `insufficient` (never fabricated); byte-identical
  repeated runs; strict schema rejects injected `apiKey`/`contact`/extra
  bullet/skill keys; API arity is exactly (profile, job); sensitive sample
  values, compensation ('999,999') and the raw description text absent from
  output; fetch spy proves zero network calls; a source scan proves the
  module imports no sensitive store, AI layer, fetch, or storage; matching
  public API + weights unchanged. Prompt 09's matching files were NOT
  modified (`git diff --name-only` verified).
- **`README.md`** — new "Resume tailoring (deterministic, no AI — no PDF
  yet)" section documenting selection rules, truthfulness guarantees and the
  explicit absence of PDF rendering; roadmap updated.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 351/351 passed** (314 baseline + 37 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`
- Pre-commit inspection: `git status`/`git diff` clean of secrets, `.env`,
  `node_modules`, build artifacts (`.wxt/tsconfig.json` regeneration left
  uncommitted as in every prior task); no manifest/config files in the diff.

### Limitations / known issues
- **No PDF rendering** (explicitly out of scope) and no options UI yet —
  the engine is a library awaiting a renderer + consumer prompt.
- Bullet-level subsetting is NOT implemented: a selected experience entry
  keeps ALL its bullets verbatim (conservative; avoids hiding facts). Skill
  neutral-fill target (12) and caps (24/12) are documented heuristics, not
  user-configurable.
- Relevance is vocabulary-scoped (same ~50-skill vocabulary as Prompt 09):
  postings naming unrecognized skills get title-only/no signal; entries
  whose bullets avoid vocabulary words rely on title overlap or the
  documented fallbacks.
- Summary assembly from `profile-skills` (no summary/headline) is a labeled
  list of verbatim skill names — it is not prose and never adds claims.
- Determinism excludes nothing time-based (posting `capturedAt` is provenance
  only); no live-browser/e2e verification (unit level, as with the rest of
  the lib layer).

### Next
- A fixed-layout PDF renderer + Options UI consuming `tailorResume` (the
  presentation layer handles contact details per the existing privacy rules),
  after this engine is reviewed.

---

## Done (2026-10-13, task 12 / Prompt 10: match summary UI in Options → Jobs)
- **`src/lib/matching/presenter.ts`** (new) — pure view-model layer between
  the matcher and React: `buildMatchSummaryView(outcome)` /
  `matchSummaryFromResult(result)` turn the existing result contract into a
  flat `MatchSummaryView` (labels only — NO new scoring logic, every number
  and explanation copied verbatim from `calculateJobMatch`'s output). Exposes
  the estimate, and shows confidence, completeness and assessable weight as
  SEPARATE fields (`Confidence: High confidence`, `75% completeness (6 of 8
  items decidable)`, `90 of 100 points assessable (a score needs at least
  40)`). All four requirement groups always exist in status order with
  distinct labels/descriptions — unknown's description states "NOT a
  confirmed gap; absence of evidence never counts against you" and
  `STATUS_LABELS.unknown ('Unknown (not verified)') !==
  STATUS_LABELS.missing ('Missing (confirmed gap)')`. State constructors for
  `missing-profile` / `missing-job` / `settings-unavailable` / `invalid`
  (typed path+code issues) / `insufficient-data` (reason + "No numeric score
  is shown" message, `score: null`, context badges kept) — a numeric score is
  NEVER shown unless the outcome is a real score. Exported from the matching
  index.
- **`entrypoints/options/MatchSummary.tsx`** (new) — thin presentational
  component (no new framework/dependency): resolves props → view via
  `resolveMatchView(profile, job, settings)` (calls `calculateJobMatch`
  inside a `useMemo`, so it recalculates whenever the selected job, profile
  or settings prop changes) and renders: score with an "estimate" tag +
  aria-label, the four badge fields, hard-requirement checks with severity
  badges (confirmed/potential/unknown), the four status groups as lists with
  per-item status chips + category + requiredness + the contract's
  explanation, the scoring-factor table (weight / score / why), and the
  result summary. `section[aria-label="Match estimate"]` + `data-status` /
  `data-field` / `data-severity` attributes for accessible, non-brittle
  semantics. Offline: no fetch, no AI import, props are AI-safe only.
- **`entrypoints/options/JobsPanel.tsx`** — integrated into the existing Jobs
  tab: each saved job gains an **Estimate match / Hide match**
  (`aria-pressed`) button; the selected posting renders in a
  `Match estimate — <title>` section below the list ("Clear selection"
  resets). Inputs loaded with the project's existing storage patterns:
  `loadProfile()` (AI-safe record ONLY — `loadSensitiveProfile` is never
  called) and `loadSettings()` once on mount (`Promise.all`); absent settings
  fall back to the schema default (threshold 0 = off, documented behavior),
  malformed/unavailable settings pass `null` → honest
  "settings-unavailable" state (no threshold is guessed), corrupt stored data
  is never overwritten by the read path. A selection that disappears (reset/
  removal) simply stops rendering — nothing stale. Selection state is plain
  React state; no app-wide state or storage writes were added.
- **`entrypoints/options/style.css`** — `.job-item-actions` + match-summary
  styles; the four status chips: matched green, partial amber, missing red,
  **unknown gray with a dashed border** so unknown can never visually read as
  missing (mirrors the label distinction).
- **Tests** (2 new files, 28 tests):
  `src/lib/matching/presenter.test.ts` (12) — estimate/confidence/
  completeness/assessable-weight/threshold exposed as distinct fields (score
  pinned at 94 to catch formula drift — formula NOT changed in this task),
  all four groups in order with contract-identical labels/explanations,
  unknown group labeled "Unknown (not verified)" + "NOT a confirmed gap" and
  never "Missing", hard-issue severity labels, insufficient-data (score null,
  messages, badges kept), invalid input (typed issues, no score/groups), all
  three missing-input states, factor rows (`Not assessable` for unknown),
  and salary/compensation strings absent from the view JSON.
  `src/lib/matching/match-summary-ui.test.ts` (16) — component rendered with
  `react-dom/server` (no new dependency; assertions target labels/
  data-attributes, not incidental markup): score "94 / 100" + "estimate" tag
  + caption "not an employer ATS score", confidence/completeness/weight/
  threshold badges, factor table; all four groups with the Kubernetes item
  in `data-status="unknown"` labeled "Unknown (not verified)" (never
  "Missing (confirmed gap)"), master's-degree item in `data-status="missing"`
  labeled "Missing (confirmed gap)"; insufficient-data/invalid/missing
  profile/no job/unavailable settings each render WITHOUT a score element;
  profile change (strong → sparse) and job change alter the rendered output;
  zero network calls during render (fetch spy); salary/compensation values
  absent from markup. Suite: **314 tests passing (15 files)**.
- **`README.md`** — Jobs tab bullet documents the Estimate match flow and
  honest states; roadmap line updated.

### Commands run this task (exit statuses captured inline)
- `npm ci` → exit 0 (node_modules absent again after workspace restore)
- `npx vitest run` → **exit 0, 314/314 passed** (286 baseline + 28 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`

### Limitations / known issues
- Profile and settings load ONCE per Jobs-panel mount (existing storage
  pattern — no storage change listener): an edit made in another tab is picked
  up on the next mount/reload, not live. Selection/profile/settings changes
  within the panel recalculate immediately via `useMemo`.
- The summary renders in the list view only (not inside the edit form);
  editing a posting then returning to the list refreshes it from storage.
- Component tests use `react-dom/server` string rendering (no testing-library,
  per no-new-dependencies); interaction testing (button clicks, selection
  toggling) is covered indirectly through JobsPanel's simple state wiring —
  no browser e2e run (consistent with the rest of the project).
- The score is an integer-pinned regression value in tests (94 for the
  standard fixture); if Prompt 09 weights/vocabulary ever change, that pin
  must be updated deliberately — the formula itself was NOT touched here.
- `README`'s formula section still describes Prompt 09 scope; no scoring,
  vocabulary, weights or threshold behavior changed in this task.

### Next
- Resume tailoring (Prompt 11+) once this UI is reviewed; optionally wire the
  AI layer later with a stored backend endpoint.

---

## Done (2026-10-13, task 11 / Prompt 09: deterministic job match estimate)
- **`src/lib/matching/`** (new, 6 files) — an isolated, OFFLINE, deterministic
  matching engine. `calculateJobMatch(profile, job, settings)` reuses the
  EXISTING validated models (`profileSchema`, `jobPostingSchema`,
  `settingsSchema` — all three re-parsed on entry; invalid input returns a
  typed `{ kind: 'invalid' }` result with path+CODE issues only, never zod
  messages/values, so errors cannot quote personal data). No second profile
  or posting model was created; `minMatchThreshold` is the existing settings
  field (no schema change was needed — the posting already distinguishes
  `requiredQualifications` from `preferredQualifications`).
- **`matching/schemas.ts`** (new) — strict (`.strict()`) result contract:
  `matchRequirementSchema` (bounded label, category, required/preferred,
  status `matched|partial|missing|unknown`, evidence REFERENCES by id — never
  copied content — and a fixed-shape explanation ≤300 chars),
  `matchFactorSchema` (factor + weight + nullable score), `hardIssueSchema`
  (severity `confirmed|potential|unknown`), discriminated `matchEstimateSchema`
  (`score` with integer 0–100 | `insufficient-data` with reason),
  `matchConfidenceSchema` (level + completeness% + counts — explicitly NOT a
  probability), `matchThresholdSchema` (configured/filtering/meets/decision),
  `matchResultSchema` + `validateMatchResult` (issues are path+code only).
- **`matching/vocabulary.ts`** (new) — conservative normalization + curated
  vocabulary (~50 skills, 3 named certifications, education levels): diacritic
  stripping, punctuation→space while KEEPING `#`/`+`/`.` (c#, c++, node.js),
  word-boundary regexes, longest-alias-wins with span-overlap resolution
  ("node.js" → node, never "js"; "java" never matches "javascript"; ".net"
  never matches inside "asp.net"). Deliberately NOT aliased: ambiguous prose
  words (spring/rest/express). Unknown skills are NEVER guessed into the
  vocabulary. `titleTokens` strips level words; `isStrictTokenPrefix` powers
  adjacent-evidence partials ("React Native" ↔ "React").
- **`matching/requirements.ts`** (new) — requirements are extracted ONLY from
  the posting's STRUCTURED fields (skills[], required/preferred
  qualifications, experienceRange, workArrangement, employmentType,
  location); the raw description is never keyword-scanned (a "React" mention
  in prose cannot create a requirement or candidate evidence — tested).
  Status semantics: matched (canonical equality with evidence), partial
  (adjacent evidence / partial preference fit), missing (AFFIRMATIVE
  contradictions only: education ceiling vs completed credentials, career
  span < posted minimum, explicit non-overlapping preferences), unknown
  (insufficient info — a skill absent from the profile is unknown, flagged
  `potential` only when required AND the profile lists skills). Career span is
  computed from profile dates against the posting's `capturedAt` (never the
  clock → deterministic); in-progress degrees never count as completed.
  Preference items (location token-subset match, work mode, employment type,
  experience-range overlap) are emitted when either side has data.
- **`matching/factors.ts`** (new) — ONE weight configuration
  (`MATCH_WEIGHTS`, sums to 100, test-asserted): requiredSkills 35,
  preferredSkills 10, experience 20, roleAlignment 20 (0.6×title token
  overlap + 0.4×responsibility lines touching profile skills, word-bounded),
  preferences 15. Coverage factors use matched=1/partial=0.5/missing=0 over
  DECISIVE items; unknown items are excluded from the ratio and counted in
  completeness (missing data never silently counts as confirmed failure).
  Factors with no decisive data score null and are excluded; remaining
  weights renormalize; `MIN_SCORE_WEIGHT = 40` gates numeric scores.
  These weights are our own heuristic — no employer ATS algorithm is claimed.
- **`matching/estimate.ts`** (new) — orchestration: input validation →
  assessment → factors → weighted integer score clamped 0–100 → hard issues
  (separate from score) → confidence (completeness = decided/total items;
  high ≥75, medium ≥40, else low) → threshold (`0` = disabled, `meets: null`;
  positive = `pass`/`below` from the UNCHANGED score; insufficient-data →
  `meets: false`, never a silent pass) → bounded evidence-based summary.
  Result passes the strict schema as an invariant. Never throws for expected
  failures; no mutation (deep-frozen-input test), no network (fetch-spy test),
  no AI (`runAiRequest` not importable from the module — tested), no storage.
- **Tests** (2 new files, 53 tests): `matching/estimate.test.ts` (36) — the
  full Prompt 09 matrix: strong match w/ verified skills + evidence refs;
  weak match w/ 5 confirmed hard issues + potential skill gap; partial-info →
  insufficient-data; empty profile → inconclusive (unknowns, not zeros);
  required-vs-preferred weighting + exact weighted-average formula check;
  contradicted requirement (bachelor's vs master's) vs in-progress = unknown
  vs absent skill = unknown(+potential); case/whitespace normalization;
  aliases (k8s/node.js/postgres) and non-aliases (spring); substring
  false-positives (java ≠ javascript, raw-prose mentions never become
  requirements); adjacent evidence (React Native ↔ React, both directions);
  missing sections; clamped integer scores; determinism (identical output);
  ongoing experience measured against capturedAt (36 months @2023 capture vs
  72 @2026); invalid settings/threshold (101/-1/50.5/'70'/null) rejected
  typed; threshold 0 disabled / pass / below / insufficient-data-never-passes;
  salary + posting compensation never in result JSON; strict result schema
  rejects injected keys; zero network; deep-frozen inputs. `matching/
  vocabulary.test.ts` (17) — normalization, alias/boundary/overlap rules,
  education detection, title tokens, cert names, vocabulary uniqueness.
  Suite: **286 tests passing (13 files)**.
- **`README.md`** — new "Job match estimate (deterministic, no AI)" section
  (formula table + weights, honest statuses, conservative matching rules,
  threshold semantics, NOT-an-ATS-score disclaimer); status/roadmap updated.

### Commands run this task (exit statuses captured inline)
- `npm ci` → exit 0 (node_modules was absent again after workspace restore)
- `npx vitest run` → **exit 0, 286/286 passed** (233 baseline + 53 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`
- `git grep` verified: no AI-layer imports in `src/lib/matching/`

### Limitations / known issues
- Matching is VOCABULARY-SCOPED: only ~50 curated skills and 3 named
  certifications can be assessed; anything else in the posting is skipped
  (never guessed). Extend `SKILL_VOCABULARY` conservatively.
- Skills absent from a populated profile list are `unknown` (+ `potential`
  hard issue when required), NOT `missing` — absence of listing is not proof.
  The engine can therefore understate confirmed skill gaps by design.
- `excludedEmployers` in settings is NOT consumed by the matcher yet (scope);
  neither is the posting's `compensation` (deliberately ignored) nor
  settings.salary (never read). Profile `preferences.willingToRelocate` is
  used only to soften a location mismatch to `partial`.
- Title/responsibility alignment is token-overlap based — it can
  under-align creative titles ("Solutions Architect" vs "Engineer"); zero
  tech overlap in responsibilities is treated as unknown, not a failure.
- No UI: the engine is library-only (per scope). A dashboard consuming
  `calculateJobMatch` is the next integration step, together with storing a
  backend endpoint for the AI layer when requested.
- No live e2e/browser verification (unit-level only, like the rest of the
  lib layer).

### Next
- A match dashboard/summary UI consuming `calculateJobMatch` (options Jobs
  tab), then resume tailoring (Prompt 10+) once reviewed.

---

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
