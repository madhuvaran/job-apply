# PROGRESS

## Done (2026-10-15, task 34 / Prompt 28: Job search UI foundation)
The first usable job-discovery surface: a new **Options → "Job search" tab**
reusing the existing full-page extension surface (no new entry point, no popup
change, no backend, no deployment, no paid service, no new dependency, no
permission or manifest change, and no credential anywhere). Live search is
still **unavailable** and the UI says so plainly; it performs **zero network
requests** and shows no example or fabricated listings.

### Files
- **`entrypoints/options/JobSearchPanel.tsx`** (new) — the panel (default
  export), plus the exported `JobSearchResults` (all view states) and
  `SearchResultCard`, and the deterministic `groupDigits`/`salaryText` helpers.
- **`src/lib/job-search/ui.ts`** (new) — ALL of the logic, pure and
  React-free: `JobSearchForm` + `EMPTY_JOB_SEARCH_FORM`/`resetJobSearchForm`,
  `validateJobSearchForm()` (friendly per-field messages), `buildJobSearchRequest()`
  (form → request, delegating the real validation to Prompt 27's
  `validateAdzunaSearchRequest` schema), the `JobSearchViewState` union,
  `initialJobSearchState()`, `searchStateFromRunResult()`, `executeJobSearch()`,
  the verified-enum option lists (`JOB_SEARCH_COUNTRY_OPTIONS`,
  `ADZUNA_COUNTRY_LABELS`, `JOB_SEARCH_SORT_OPTIONS`), the single
  `EXTENSION_JOB_SEARCH_CONFIG` constant and `createUnconfiguredSearchProvider()`.
- **`entrypoints/options/App.tsx`** — added the `search` tab (nav button, title,
  render branch). No other screen changed.
- **`entrypoints/options/style.css`** — a `/* Job search (Prompt 28) */` block
  only; the form reuses the existing `.row`/`.row-label`/`.row-control`/`.hint`
  atoms.
- **`src/lib/job-search/index.ts`** — re-exports `./ui`.
- Tests: **`src/lib/job-search/ui.test.ts` (33)**,
  **`src/lib/job-search/job-search-ui.test.ts` (28, jsdom)** and
  **`src/lib/job-search/options-search-tab.test.ts` (3, jsdom, Options wiring)**.

### Architecture decision (where it belongs)
The popup stays a lightweight quick-action surface (scan page → autofill), so
discovery lives in the **existing Options page** as a fifth tab beside Jobs.
No new extension entry point, no hosted dashboard or web app was introduced.

### Search fields and behaviour
Keywords (required), location (optional), **country from the verified 19-code
enum only** (India included), search radius in km (documented `distance`;
**disabled until a location is entered**, since it is meaningless without one),
posted-within days (documented `max_days_old`) and sort order (documented
`sort_by` values only). Live inline validation with real `<label for>`-associated
controls, `aria-invalid`/`aria-describedby`, a Search button that is **disabled
whenever the provider is unavailable or the form is invalid** (with the reason
shown), and a Clear/reset action that empties every field and returns to the
start state. A trailing blank line-artifact: none — only fields the provider
supplied are rendered.

**Remote preference was deliberately NOT added**: the verified contract has no
remote-work filter, and the prompt forbids presenting unsupported controls as if
they filtered anything. No such control exists anywhere in the panel (asserted).

### States handled (all implemented; the last five are unreachable at runtime
until a provider is configured, and are covered by tests)
`initial` (no search yet) · `unavailable` (no secure endpoint — the only state
this build can reach) · `invalid` (typed form issues) · `loading` ·
`results` (validated normalized page) · `results` with **zero** listings (worded
as a successful empty search) · and **distinct** errors for
`rate-limited`/`unauthenticated`, `network`, `server`, `provider-rejected` and
`invalid-response`. A failure is never rendered as an empty successful search
(asserted: the error state never contains the zero-result wording, and the
non-`results` states render no result cards).

### No-hosting compliance
`EXTENSION_JOB_SEARCH_CONFIG` is `{ enabled: true }` **with no endpoint** — so
availability reports `not-configured` ("needs a configured secure search
endpoint … not available in this build") rather than the misleading `disabled`
("turned off in settings"), which would claim a setting the app does not have.
There is no user-editable endpoint and no key field (Prompt 27 forbids arbitrary
URLs); `createUnconfiguredSearchProvider()` throws if ever called, so a future
change that enables search without wiring a real provider fails loudly as a
typed `provider-fault` instead of silently appearing to work. Verified in the
built bundle: **no `app_key`/`app_id`/`api_key`/`bearer`, no `api.adzuna.com`
call target** — the only vendor strings are the provider id and the attribution
URL `https://www.adzuna.co.uk/`.

### Attribution, links and honesty for future listings
Result cards render the provider's own listing URL (strictly validated by
Prompt 27) with `rel="noreferrer noopener"`, mark missing company/location as
missing, **never invent a currency** (the API states none — the line says so),
label Jobsworth figures as estimates, and each page carries Adzuna's required
attribution at the documented minimum size (`min-width:116px`;
`min-height:23px`) linked to Adzuna. Nothing implies a manually entered or
imported job came from Adzuna.

### Local import fallback — DEFERRED (with reason, per Prompt 28 §5)
Two related actions were intentionally not added:
1. **Import a job locally** — already implemented and tested in Options → Jobs
   (*Add job manually*: URL + description + validation + duplicate guard +
   storage) and in the popup (*Capture current job*). A second form in the search
   panel would duplicate that intake, so the panel instead points users to it.
2. **Save a search result into Jobs** — deferred to Prompt 29. The provider's
   search response carries only a **truncated 500-character snippet**, and a
   posting's `rawDescription` is stored **verbatim** and feeds resume tailoring
   and match estimation; storing a snippet as if it were the full description
   would misrepresent it. Saving also needs a new `source` value, which is a
   posting-model change that does not belong in this prompt.

Discovery therefore never writes storage, scores a match or starts an
application (asserted by a source scan of both new files for
`upsertJobPosting`/`guardJobSave`/`createJobPosting`/`calculateJobMatch`/
`startTrackingApplication`/`loadJobPostings`/`browser.storage`/`fetch(`).

### Tests (+64 → 1106 total; 61 files)
- **`ui.test.ts` (33, pure)** — options come from the verified enum (India
  included, every country labelled, only documented sort values); validation
  requires keywords + a supported country, enforces the same bounds as the
  provider schema, ignores a radius without a location, and never echoes a
  value; `buildJobSearchRequest` sends only what was provided, applies the
  schema's own `page`/`resultsPerPage` defaults, drops a locationless radius and
  can carry **no** credential/profile key; the build reports `not-configured`
  and the unconfigured transport throws rather than returning fake jobs;
  `executeJobSearch` returns `unavailable` with **zero provider calls**, reports
  `invalid` without calling, returns `results` (incl. a genuinely empty page) for
  a valid payload, and maps unauthenticated / rate-limited / network / server /
  provider-rejected / malformed / unreadable-payload / thrown-provider to the
  right typed error — never to an empty success.
- **`job-search-ui.test.ts` (28, jsdom + `react-dom/server`)** — every state
  rendered from fixtures built by the REAL Prompt 27 normalizer; a failed search
  never shows the zero-result wording and a zero-result page never shows error
  wording; optional fields render only when supplied (minimal listing states the
  missing company/location, omits salary, still shows the date the provider DID
  state, and leaves no empty placeholder span); no currency is ever rendered;
  counts are locale-independent; inaccessible-listing counts are surfaced. Panel
  behaviour: unavailable state + **disabled Search** + no fabricated listings +
  **`fetch` never called**; lists exactly 19 countries and no remote control;
  inline validation appears and clears; radius disabled until a location exists
  and bounds are reported; Clear empties the form and resets the view;
  accessibility (form `aria-label`, every control programmatically labelled,
  real buttons, live `role="status"` regions).
- **`options-search-tab.test.ts` (3, jsdom, mocked extension storage)** — mounts
  the real Options `App`: the **Job search** tab is offered in order alongside the
  existing sections, opening it renders the panel, marks the tab
  `aria-current="page"`, shows the honest `unavailable` state with Search disabled
  and no fabricated listings, and switching back to Profile restores that
  section — the entry point the user actually clicks is exercised.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 1106/1106 passed** (61 files; 1042 before + 64 new)
- `npm run compile` (tsc --noEmit) → **exit 0** (four test-only type errors found
  and fixed before committing)
- `npm run build` (wxt build, chrome-mv3) → **exit 0**; the new tab is present in
  the built options chunk, and the manifest is unchanged
  (`storage`, `activeTab`, `scripting`; no host permissions)
- Bundle scan of `.output/chrome-mv3` → no credential names, no
  `api.adzuna.com` call target, no new permissions or entry points

### Limitations / known issues
- **Live search is not available** and cannot be until a secure `https` proxy
  holding the credentials is deployed and configured; Search stays disabled.
- Only the `unavailable` state is reachable at runtime in this build; the other
  states are implemented and test-verified but not observable without a provider.
- Pagination is fixed at page 1; nothing is cached (no documented caching rule).
- Saving a discovered job, saved searches and alerts are deferred (see above).
- UI verification is **jsdom-based**, not a real loaded-extension session — the
  repo's existing UI tests have the same limitation, and a plain browser tab
  cannot stand in for the extension (other tabs use `chrome.storage`).

### Next
- Prompt 29 (not started — this task stops here): deploy the server-side search
  proxy that holds `app_id`/`app_key`, configure its endpoint, verify the live
  states (including the real overage status) end to end, and then add
  save-from-search with an honest handling of the truncated snippet.

---
## Done (2026-10-15, task 33 / Prompt 27: Adzuna job-search feasibility + integration foundation)
Provider-agnostic job-discovery foundation plus a feasibility-verified Adzuna layer.
**No live search, no UI, no saved search/alert/polling, no backend, no deployment,
no new dependency, no permission or manifest change, and no credential anywhere in
the extension.** Facts were verified first-hand from Adzuna's official docs and
OpenAPI spec (2026-10-14, re-checked 2026-10-15) and written up with sources and
explicit uncertainties in **`docs/adzuna-integration.md`**.

### Verified API facts (source list in the doc; S2 = official OpenAPI spec)
- **Endpoint** `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`
  (S2 `servers` = `https://api.adzuna.com/v1/api`); `country`/`page` are path
  params, everything else query params.
- **Auth** `app_id` + `app_key`, documented as REQUIRED **query** parameters.
- **Countries** the exact 19-code enum, **India (`in`) included**; `sort_by` ∈
  {`default`,`hybrid`,`date`,`salary`,`relevance`}; `what`, `where`, `distance`
  (doc default 5 km), `max_days_old`; `results_per_page` spec-minimum 1 with **no
  documented maximum** and **no documented default**.
- **Status codes** documented for search: 200/400/404/**410 = "Authorisation
  failed"**/500. **429 is NOT documented** (mapped defensively).
- **Job fields** required `id`, `title`, `description`, `created`; optional
  `redirect_url`, `company`, `location`, `salary_min/max`, `salary_is_predicted`,
  `contract_time/type`, `category`, `adref`, `latitude`, `longitude`.
  `created` is ISO 8601; `description` truncated to **500 chars**;
  `redirect_url` is required to comply with Adzuna's terms.
- **Access limits** (Terms of Service): **25/min, 250/day, 1000/week, 2500/month**.
- **Attribution** (ToS): label each advert **"Adzuna", >=116x23 px, hyperlinked**.
- **Uncertain / account-level** (documented as such, not assumed): whether access
  is free; the overage status code; caching policy (none stated — so **no cache**
  is implemented); India result quality; plan restrictions.

### Architecture chosen (matching the existing AI backend-proxy pattern)
`src/lib/job-search/` (provider-agnostic) + `src/lib/job-search/adzuna/`:
- **`schemas.ts`** — bounded `NormalizedJobResult` + `NormalizedSearchResults`
  (with `skipped`/`skippedReasons` and mandatory `attribution`). Reuses
  `postingUrlSchema`/`postingDateSchema`/`MAX_TITLE_CHARS` from the job-posting
  model, so a result is directly compatible with the posting, duplicate and match
  systems. Optional means **absent**, never invented; raw provider keys (`__CLASS__`,
  `adref`, coordinates) never survive.
- **`errors.ts` / `provider.ts`** — typed, non-throwing error model (invalid
  request, provider-rejected, unauthenticated, rate-limited, network, server,
  http, invalid-response, not-configured, timeout, provider-fault) and a transport
  contract. No credential/body/header text in any error.
- **`service.ts`** — `runJobSearch()`: config validation → **honesty gate**
  (disabled/unconfigured ⇒ `not-configured`, **zero network requests**) → request
  validation → **one** attempt with timeout → normalization. A failure is never
  turned into an empty result page.
- **`adzuna/schemas.ts`** — strict `.strict()` request over the documented params;
  verified country enum + `ADZUNA_INDIA_SUPPORTED`; `buildAdzunaSearchQuery()` can
  never emit `app_id`/`app_key`; `ADZUNA_ATTRIBUTION` carries the 116x23 credit.
- **`adzuna/normalize.ts`** — pure raw→normalized mapping; a record without a
  usable http(s) `redirect_url` is skipped (not shown link-less); unusable records
  are counted with **fixed reasons**; a malformed envelope is an **error**, while
  `results: []` is a real empty result.
- **`adzuna/provider.ts`** — the ONLY transport: sends to the project's own
  **https** proxy URL (built from the validated request) and never calls
  `api.adzuna.com`; options schema is `.strict()` with **no credential field**,
  so `appId`/`appKey` fail validation by construction.
- **`adzuna/adapter.ts` + `index.ts`** — wires the pure Adzuna layer into
  `runJobSearch()` without coupling the orchestrator to Adzuna.

### Integration boundary (no backend available)
Adzuna authenticates with a query-parameter key, which a browser extension cannot
hold safely, so the extension ships **unconfigured** and talks only to a future
project-owned `https` proxy. It never appears to have working live search:
`describeJobSearchAvailability()` reports `disabled` / `not-configured` and the
provider is never invoked. No placeholder key exists that could be mistaken for a
working one. No request is made on startup and no background polling was added.

### Tests (+102 → 1042 total; 5 new files, mocked transport, no live call)
- **`adzuna/schemas.test.ts` (23)** — country enum verbatim, India, `sort_by`,
  attribution size, defaults, every country accepted, keyword/location/pagination/
  radius/age bounds, credential/endpoint/profile-field rejection, query never
  contains `app_id`/`app_key`, documented India path.
- **`adzuna/normalize.test.ts` (19)** — full mapping + injected clock/attribution,
  raw keys absent, deterministic, empty results = real empty, missing `count`
  omitted, minimal record, malformed optionals dropped, `area` fallback, no
  capture-time date substitute, 500-char snippet cap, `predicted` true/false/null,
  single-sided + swapped salary, malformed envelope rejected, fixed skip reasons,
  page cap counted.
- **`adzuna/provider.test.ts` (27)** — options reject credentials/http and never
  echo values; proxy URL has the documented request and no credential; GET with no
  auth header; 410/401/403→unauthenticated, 400/404→provider-rejected, 5xx→server,
  other→http, 429→rate-limited (+`Retry-After`), network/abort→network/timeout,
  non-JSON→malformed, body never leaked, sends only to our proxy.
- **`service.test.ts` (26)** — config has no credential field and requires https;
  availability states; **disabled/unconfigured ⇒ zero provider calls and never an
  empty page**; invalid request rejected pre-call; happy path normalization; every
  failure mapping; provider throw → provider-fault; never-settling/aborting
  provider → timeout; provider-agnostic fake adapter; **no timer scheduled when
  unavailable** (no polling).
- **`credentials.test.ts` (7)** — source scan: no credential-shaped literal, no
  direct `api.adzuna.com` call, transport reaches the vendor only through the
  proxy URL builder, credential names live in exactly one constant, and the doc
  contains no long hex/base64 token.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 1042/1042 passed** (58 files; 940 before + 102 new)
- `npm run compile` (tsc --noEmit) → **exit 0** (two test-only type errors were found
  and fixed before committing)
- `npm run build` (wxt build, chrome-mv3) → **exit 0** (manifest unchanged:
  `storage`, `activeTab`, `scripting`; no host permissions)
- Bundle scan of `.output/chrome-mv3` → no `app_id`/`app_key`/`api_key` secret and
  no `api.adzuna.com` call target anywhere in the shipped JS.

### Limitations / known issues
- **No live search exists** and none can until a secure `https` proxy holding the
  credentials is deployed and configured. The provider ships unconfigured.
- The overage status (429 vs another code) is **unverified**; the mapping is
  defensive. The transport trusts the proxy to forward upstream status codes.
- Result currency is unknown (amounts are local-currency and unlabelled).
- Caching is **not** implemented because the reviewed terms state no caching policy.
- Whether API access is free, India result quality and plan restrictions remain
  account-level questions to confirm with a configured developer account.

### Next
- Prompt 28 (not started — this task stops here): deploy the server-side search
  proxy that holds `app_id`/`app_key`, attach it in settings, confirm the real
  overage status and India result quality against a configured account, then build
  the search UI on the normalized page this foundation already produces.

---
## Done (2026-10-14, task 32 / Prompt 26.1: recheck duplicates immediately before save)
Focused fix for the race found in the Prompt 26 review: the duplicate gate could
rely on a copy of the saved list read earlier (Options → Jobs used its in-memory
`postings` state), so a posting saved from another tab between the check and the
write could slip through. No new feature, no matching-rule change, no new
dependency, permission or manifest change.

### Root cause
- Options → Jobs ran `findDuplicateJob()` against the component's `postings`
  React state and then wrote — state loaded at mount time is stale the moment
  another tab saves something.
- The popup checked on click but the check and the write were separate steps with
  no guarantee the list was re-read at write time.

### Fix
- **`src/lib/job-duplicates/schemas.ts`** — new strict, bounded
  `duplicateLookupOptionsSchema` with `excludeJobIds` (max `MAX_EXCLUDED_JOBS`
  = 20, each id `1..MAX_IDENTITY_CHARS`) for the record being edited.
- **`src/lib/job-duplicates/service.ts`** — `lookupDuplicateJob(candidate,
  options = {})` still ALWAYS re-reads the persisted postings through
  `loadJobPostings()` (never a caller's cached list), and now filters out the
  excluded ids. Invalid options fail closed with a fixed message (no values).
- **`src/lib/job-duplicates/save-guard.ts`** (new, pure orchestration) —
  `guardJobSave({ candidate, excludeJobIds?, override? })` returns
  `proceed` | `blocked-duplicate` | `blocked-check-failed`. It validates the
  candidate itself, then re-reads persisted data through the service. `override`
  is the explicit per-attempt user choice: it skips ONLY the duplicate gate and
  never bypasses storage validation.
- **Popup** (`entrypoints/popup/App.tsx`) — `writePosting(override)` runs the
  guard inside the write path (immediately before `createJobPosting` +
  `upsertJobPosting`), so a duplicate shows the existing warning instead of
  saving. `onSave` validates then calls `writePosting(false)`;
  `onSaveAnyway` → `writePosting(true)` (one attempt, one write — no loop). The
  "check could not run" case now renders the same warning block with
  `data-status="check-failed"` and an explicit `Save anyway`.
- **Options → Jobs** (`entrypoints/options/JobsPanel.tsx`) — the state-based
  check is gone: `writePosting(override)` runs the guard immediately before the
  write, passing `excludeJobIds: [editingId]` when editing, so the record never
  flags itself while a *different* saved record with the same identity still
  blocks. New `dupNotice` state mirrors the popup; the primary button becomes
  `Save anyway` (check failed) / `Save changes anyway` (editing) /
  `Save as a separate record` (new record).

### Regression tests (+19 → 940 total)
- **`save-guard.test.ts` (10, mocked extension storage)** — proceeds with nothing
  saved / absent list; **blocks when a matching posting is persisted AFTER an
  earlier check** (the exact race) and writes nothing; ambiguity passthrough
  (`status: 'ambiguous'`, `jobId: null`); `excludeJobIds` excludes only the
  given ids (no exclusion → blocked; a *different* record with the same URL →
  blocked); override proceeds for one attempt, the next normal attempt is gated
  again, and the guard made zero `set`/`remove` calls; malformed and unavailable
  storage → typed `blocked-check-failed`; invalid candidate/options → fixed
  message that never quotes the value; deterministic for identical inputs.
- **`save-race-ui.test.ts` (7, jsdom + `react-dom/client` + `act`, no timers)**
  — the race is simulated by mutating the MOCKED STORAGE between render and
  save, so component state can never see the new posting:
  popup blocks the save and shows the warning, then the explicit override writes
  exactly one extra record; popup normal save unchanged; popup malformed storage
  → check-failed warning + `Save anyway` that still fails validation
  (`Save failed (malformed)`) and leaves the stored value byte-identical;
  Options → Jobs covers the same four cases, plus **editing never flags its own
  record** (`Posting updated.`, still one stored posting).
- **`service.test.ts` (5 → 7)** — scoped exclusions filter only the given ids
  (other records still match) and every invalid-options shape fails closed
  without writing.

### Concurrency limitation (documented in README + here)
Chrome storage provides no transactional compare-and-write, so a fresh read
immediately before writing NARROWS the race window but does not make duplicate
detection atomic: two tabs saving the same vacancy at the same instant can still
both succeed. No locking layer, storage architecture change, dependency or
permission was added to claim otherwise.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 940/940 passed** (53 files; 921 before + 19 new)
- `npm run compile` (tsc --noEmit) → **exit 0**
- `npm run build` (wxt build, chrome-mv3) → **exit 0** (manifest unchanged:
  `storage`, `activeTab`, `scripting`; no host permissions)

### Limitations / known issues
- The pre-write check is not atomic (see above); the definitive fix would need a
  transactional storage layer that does not exist in `chrome.storage`.
- The override is deliberately blunt: choosing *Save as a separate record* saves
  a second record even if the first is the same vacancy — the user's explicit
  choice is honoured, and it is never remembered for later saves.
- Rule 2 (source-scoped external identifier) remains inert until some source
  publishes a trustworthy identifier (unchanged from Prompt 26).
- UI verification is now jsdom-based (a real DOM, no timers), but still not a
  real browser extension session.

### Next
- Prompt 27 (not started — this task stops here).

---
## Done (2026-10-14, task 31 / Prompt 26: duplicate-job detection and safe capture)
One focused feature: the same vacancy can no longer be saved twice by accident,
and two genuinely different vacancies are never merged. No new dependency,
permission or manifest change, no scraping, no extra network request, no AI, no
automatic merge/overwrite/delete, and no change to matching, resume or
application-log behavior.

### Inspected entry points (before writing any code)
- Storage key/model: `STORAGE_KEYS.jobPostings` (`job-postings.v1`) with the
  strict `jobPostingSchema` (no external job identifier field exists anywhere).
- Both creation paths write through `upsertJobPosting()`:
  1. popup capture preview — `entrypoints/popup/App.tsx` `onSave`
     (`createJobPosting` + `upsertJobPosting`, `source: 'page-capture'`);
  2. Options → Jobs manual form — `entrypoints/options/JobsPanel.tsx` `onSave`
     (`validatePostingDraft` + `createJobPosting` + `upsertJobPosting`).
- Capture metadata (`src/lib/capture.ts`) publishes url/title/company/location/
  description/`postedDate` only — no trustworthy external identifier.

### New pure module — `src/lib/job-duplicates/`
- **`schemas.ts`** — strict result contract: `DUPLICATE_SCHEMA_VERSION`,
  bounded `MAX_DUPLICATE_MATCHES`/`MAX_IDENTITY_CHARS`/`MIN_IDENTITY_CHARS`,
  ordered `DUPLICATE_METHODS` (`canonical-url` → `external-id` →
  `company-title`), `DUPLICATE_STATUSES` (`none`/`confirmed`/`possible`/
  `ambiguous`), fixed `DUPLICATE_REASON_CODES` + fixed privacy-safe
  `DUPLICATE_REASON_EXPLANATIONS`, strict candidate / saved-identifier / match /
  result schemas (URLs reuse the existing `postingUrlSchema`) and
  `validateDuplicateCheck()` (path+code issues only).
- **`duplicates.ts`** — `findDuplicateJob({ candidate, savedJobs, externalIds })`,
  plus exported `canonicalJobUrl`, `sourceDomain`, `normalizeIdentity`. Rules:
  1. canonical URL — fragment removed; scheme/host case, leading `www.` and an
     explicit default port normalized; path, query and scheme otherwise
     PRESERVED verbatim (parameters never stripped or reordered);
  2. external identifier — only identifiers the source itself published, only
     compared inside the candidate's own source domain, and trusted only when
     the referenced saved job's own URL host matches the claimed domain (never
     invented, never cross-domain);
  3. normalized company + title (case, surrounding/repeated whitespace only — no
     fuzzy/partial/stemmed matching), reported as `possible` for review;
  4. otherwise no duplicate.
  Several hits on a trustworthy identity produce `ambiguous` with `jobId: null`
  (no winner chosen); matches are de-duplicated and sorted by job id, so input
  order can never change the outcome. Malformed saved records are skipped and
  counted (`skippedJobs`) — never trusted as matches. Invalid candidate → typed
  `{ kind: 'invalid', issues }`. No storage/DOM/browser/network/AI/clock access,
  no input mutation, and diagnostics never quote page text or candidate values.
- **`service.ts`** — `lookupDuplicateJob(candidate)`: read-only wrapper over the
  existing `loadJobPostings()` (the ONLY place storage is touched). Never writes
  (no insert/update/repair/reset), treats an absent list as reliably empty, and
  returns a typed failure (`malformed`/`unavailable`/`invalid`) with a fixed
  message instead of claiming "nothing saved".
- **`index.ts`** — public surface.

### Save-flow protection (both paths, before any write)
- **Popup** (`entrypoints/popup/App.tsx`): `onSave` validates the draft, then
  calls `lookupDuplicateJob`; a duplicate shows a warning panel (saved
  title/company, `View saved record` → `openOptions()`, safe link to the saved
  posting when it has one, `Save as a separate record`, `Cancel`) and nothing is
  written until an explicit choice. An inconclusive check shows a fixed notice
  and still requires an explicit save. Saving clears the warning and moves to
  the existing `saved` stage.
- **Options → Jobs** (`entrypoints/options/JobsPanel.tsx`): the manual form runs
  the same pure check against the jobs already loaded (the record being edited is
  excluded from its own check), shows the same warning with a `View saved record`
  action that opens that job in the saved list, and swaps the primary button to
  `Save as a separate record`. Editing an existing record is not blocked (it is
  an intentional update of one record, not a second copy).
- No auto-merge, no overwrite, no delete, no silent second copy anywhere.

### Tests (+41, all new)
- **`duplicates.test.ts` (34)** — canonicalization (fragment/case/`www.`/default
  port normalized; path, trailing slash, query order/values and scheme
  preserved; non-http(s) rejected), URL rule (confirmed on cosmetic differences;
  never merges different path/query/scheme/host; ambiguity with no winner;
  saved jobs without a URL ignored), identifier rule (same domain confirmed;
  cross-domain never matches in either direction; untrusted entries noted;
  case-sensitive but whitespace-trimmed; ambiguity; URL rule wins), company+title
  rule (case/whitespace-only match → `possible`; different title/company/missing
  company never match; sub-minimum identity ignored; several matches stay
  ambiguous), no-usable-identity / no-reliable-match, malformed saved records
  skipped, typed invalid candidate, no candidate content in diagnostics, strict
  result schema + unexpected-property rejection, determinism, input-order
  independence, deep-frozen input immutability, clock independence,
  zero `fetch`, and a static guard that the pure files import no storage/AI and
  never touch the clock, DOM or browser APIs.
- **`service.test.ts` (5)** — confirmed match from stored data; absent list as
  reliably empty; malformed list → typed `malformed` failure with the stored
  value left byte-identical; unavailable storage → typed failure without
  throwing; invalid candidate rejected; and `set`/`remove` call counts of ZERO in
  every case (read-only proof).
- **`save-flow-ui.test.ts` (2)** — both entry points still render with the check
  wired in (popup idle stage; Options → Jobs list, create button and priority
  section), with no warning shown before a save is attempted.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 921/921 passed** (51 files; 880 before + 41 new)
- `npm run compile` (tsc --noEmit) → **exit 0**
- `npm run build` (wxt build, chrome-mv3) → **exit 0** (manifest unchanged:
  `storage`, `activeTab`, `scripting`; no host permissions)

### Limitations / known issues
- Matching is conservative and textual: the same vacancy reposted under a
  different URL with a reworded title legitimately counts as a new job, and a
  company+title hit is only ever a `possible` duplicate the user must confirm.
- **Rule 2 is inert in this build**: neither the saved model nor the capture
  metadata carries a trustworthy external job identifier, and inventing one is
  explicitly out of scope. The rule is implemented, domain-scoped and unit
  tested, and activates only if a source starts providing such an identifier.
- The check cannot run while the saved job list is unreadable (malformed/
  unavailable): that state is reported to the user rather than treated as
  "nothing saved", and the save path itself still refuses to overwrite malformed
  stored data.
- Verified at unit + `react-dom/server` level only: the duplicate warning is
  driven by component state, so no real-browser pass (clicking through the
  warning, opening a saved record) has been performed here.
- Dismissing a warning is always an explicit user action; nothing is merged,
  overwritten, deleted or auto-saved.

### Next
- Prompt 27 (not started — this task stops here).

---
## Done (2026-10-14, task 30 / Prompt 25: harden prioritization validation)
Focused robustness fix for the Prompt 24 module. No new feature, no category-rule
change, no matching-algorithm/application-tracking/UI-design/manifest change, no
new dependency or permission.

### Semantic validation now reuses the domain schemas — `src/lib/prioritization/schemas.ts`
- `today` and `freshness.postedDate` use the existing `postingDateSchema`
  (real `YYYY-MM-DD`, leap years included; impossible/malformed values such as
  `2026-02-31`, `2026-13-01`, `2023-02-29`, `2026-1-1`, `10/10/2026` rejected).
- `application.applicationDate` uses the existing `applicationDateSchema`.
- `originalUrl` uses the existing `postingUrlSchema` (http(s) only).
- `notes` cap raised 6 → 10 (up to 8 fixed fail-closed notes can now occur);
  every object stays `.strict()` and no parsing logic is duplicated.
- Two new match states: `threshold-mismatch` and `duplicate-input`. This is an
  enum extension — results that validated before still validate, and the UI
  renders `match.label` generically, so no UI change was needed.

### Threshold consistency fails closed
- New pure `thresholdIsConsistent(result, configured)` mirrors the matcher's
  documented mapping (`buildThreshold` in `src/lib/matching/estimate.ts`):
  `configured` must equal the supplied minimum, `filtering === (minimum > 0)`,
  minimum 0 → decision `disabled` with `meets` null, positive minimum over
  insufficient data → decision `insufficient-data` with `meets` false, and a
  score → `meets === (score >= minimum)` with decision `pass`|`below`.
- A validated result that contradicts the supplied current threshold (different
  minimum, different filtering mode, or an internally incoherent decision) is
  re-labelled `threshold-mismatch`: no score, no threshold, no confidence →
  `needs-review`, unless the higher-precedence `already-applied` rule applies.
  The supplied score/threshold is never recalculated or rewritten.
- Settings unavailable → the match signal stays `unavailable` (no comparison is
  attempted, no mismatch is invented).
- Threshold zero keeps its documented meaning: filtering disabled, any usable
  score qualifies, insufficient data still never does.

### Duplicate match inputs fail closed
- At most ONE entry per `jobId` is trusted. A second entry — identical,
  conflicting, or payload-less — makes that job's match signal
  `duplicate-input` → `needs-review` with a fixed reason and note. There is no
  last-wins behaviour, and shuffling duplicates (in either order) cannot change
  the classification or the score.
- New fixed notes `NOTE_THRESHOLD_MISMATCH` / `NOTE_DUPLICATE_MATCH_INPUT` and
  new reasons for both states; suppliers' input objects are never mutated.

### Tests
- `prioritize.test.ts` 71 → **117 tests** (+46): semantic date/URL rejection
  (impossible, malformed and leap-day values; `javascript:`, `ftp:`, `data:`,
  bare-host and empty URLs; null and valid values accepted; strict objects kept)
  while valid `prioritizeJobs()` output still validates; threshold consistency
  (another minimum, filtering disabled/enabled, internally incoherent decision,
  fixed reason, unchanged `already-applied` precedence, settings-unavailable
  path, real-matcher results at minimum 0/60/100 never misflagged, a real result
  computed under an older minimum now flagged, insufficient data unusable at 0
  and 60); duplicate inputs (identical, conflicting, payload-less duplicates,
  order independence, other jobs unaffected, fixed note/reason, no mutation).
  Two pre-existing synthetic fixtures were made matcher-consistent (a 0 minimum
  emits `disabled`, and scores below the minimum emit `below`) — they had been
  relying on the very incoherence this task removes.
- `priority-ui.test.ts` unchanged (11) — the new labels render through the
  existing generic `match.label` pill.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 880/880 passed** (48 files; 834 before + 46 new)
- `npm run compile` (tsc --noEmit) → **exit 0**
- `npm run build` (wxt build, chrome-mv3) → **exit 0** (manifest unchanged:
  `storage`, `activeTab`, `scripting`; no host permissions)

### Limitations / known issues
- Threshold consistency is a comparison against the CURRENT settings, not a
  re-verification of the estimate: a result computed under a different minimum
  is simply not trusted (the panel recomputes the estimate on load, so this only
  affects externally supplied results).
- The duplicate policy is deliberately blunt: any second entry for the same job
  id makes that signal unusable, even when the two entries are identical.
- Still verified at unit + `react-dom/server` level only (no real job site, no
  real-browser pass), and the priority view remains a review order over saved
  data with no availability/applicant-count/probability claims.

### Next
- Prompt 26 (not started — this task stops here).

---
## Done (2026-10-14, task 29 / Prompt 24: freshness-aware job prioritization + priority shortlist)
One focused, local feature: turn ALREADY-SAVED data (saved jobs, published
posting dates, deterministic match estimates, the application log) into a review
order with an explanatory UI. No new dependency, permission or manifest change,
no scraping/polling, no AI/network, no write-back to storage, no automatic
navigation/submission, and no claim about whether a job is open, how many people
applied, or the odds of being hired.

### Pure module — `src/lib/prioritization/` (new)
- **`schemas.ts`** — strict result contract: `PRIORITY_SCHEMA_VERSION`,
  `FRESHNESS_WINDOW_DAYS = 7`, `MAX_PRIORITY_JOBS = 1000`, ordered
  `PRIORITY_CATEGORIES` (`apply-first`, `good-match`, `needs-review`,
  `already-applied`) with fixed `PRIORITY_CATEGORY_META` labels/descriptions, and
  `.strict()` match/freshness/application/entry/group/result schemas with bounded
  strings + `validatePrioritizationResult()` (issues are path+code only). **No
  combined score field exists anywhere** — the three signals stay separate.
- **`prioritize.ts`** — `prioritizeJobs({ jobs, matches, applications, today,
  minMatchThreshold })`: validates saved jobs with the EXISTING `jobPostingSchema`
  (invalid records are skipped and counted, never classified), validates each
  already-computed result with the EXISTING `validateMatchResult` (a
  `JobMatchOutcome` wrapper is also accepted — nothing is re-scored), validates
  application records with the EXISTING `applicationSchema`, and takes an
  EXPLICIT `today`. No storage, no clock, no network, no AI, no input mutation;
  posting URLs are re-validated through the existing `postingUrlSchema`.
- **Categories (precedence, first match wins):** 1. `already-applied` for a
  reliably linked record with a submitted/in-progress status (`applied`,
  `assessment`, `interview`, `offer`) or a closed one (`rejected`, `withdrawn`) —
  `planned` alone is NOT a submission; 2. unreadable application log →
  `needs-review` (fail closed); 3. unusable/insufficient/below-minimum match →
  `needs-review` (freshness never rescues it); 4. future posting date →
  `needs-review` (verify, never fresh, even at score 100); 5. everything met →
  `apply-first`; 6. otherwise → `good-match` (unknown or older posting date).
- **Freshness:** calendar-day age from UTC calendar parts via the new pure
  `calendarDaysBetween()` in `src/lib/job-dates.ts` (reused, not duplicated); age
  0 = posted today; window is `<= 7`; future dates are flagged and never fresh;
  unknown dates are never recent.
- **Ordering (within a category):** known posting date newest first (unknown
  dates never outrank known ones), then match score descending when both are
  numeric, then `jobId` ascending. `comparePriorityEntries()` is exported and
  tested directly; input order never changes the output.
- **Fail-closed notes** (fixed literals, no job/page content): settings
  unreadable, application log unreadable, one unreadable application record,
  skipped invalid jobs, invalid match results, "minimum 0 disables threshold
  filtering".
- **`index.ts`** — public surface.

### UI — Options → Jobs
- **`entrypoints/options/PriorityList.tsx`** (new, presentational): four category
  buttons with counts (`aria-pressed`), the selected category's jobs with
  title/company, three separate signal pills (match label, freshness label,
  application status), short reasons, and a safe *Open posting* link only when a
  saved http(s) URL exists (`target="_blank" rel="noreferrer noopener"`). Empty
  states for "no saved jobs" and for an empty category.
- **`entrypoints/options/JobsPanel.tsx`**: loads the application log read-only
  next to the profile/settings it already loaded (`ok` → records, `absent` →
  reliably empty, anything else → `null` = unreadable), computes match estimates
  with the EXISTING `calculateJobMatch` for every saved job, and memoizes the pure
  `prioritizeJobs` call with `localCalendarDate()` as `today`. Shows a loading
  line, a fail-closed line when saved jobs cannot be loaded, a typed error line
  for an invalid outcome, and a panel-known extra note when no usable profile is
  loaded (so every job falls back to review). Selection is local UI state; the
  saved-jobs list, match summary, resume export and history are untouched.
- **`entrypoints/options/style.css`**: `.priority*` styles (visually distinct
  pills for match / freshness / application).

### Tests (+82, all new)
- **`src/lib/prioritization/prioritize.test.ts` (71)** — result contract (four
  categories in order, counts/`totalJobs`, no combined score field, empty list,
  URL safety incl. a `javascript:` record being skipped), every category and
  precedence (already-applied over fresh+high score; future-dated `needs-review`;
  below-minimum; insufficient data), application semantics (`planned` never
  "already applied"; all seven statuses mapped; application date surfaced only
  when recorded; unlinked records never associated; submitted beats planned;
  tie-breaks), threshold boundaries (exactly at the minimum, one below, disabled
  minimum 0, insufficient data never passing), freshness (0/1/7/8/10 days,
  "Posted today", month boundary, year boundary, leap day 2024-02-29 with the
  impossible 2023-02-29 rejected, unknown date never recent), stable ordering
  (date → score → id, unknown last, input-order independence, no storage
  reordering), fail-closed signals (unreadable log, one bad record, unreadable
  settings, invalid/missing match, skipped invalid jobs, unusable match entries),
  typed invalid outcomes (bad `today` values, impossible thresholds), an
  integration case running the REAL `calculateJobMatch` (score reused verbatim;
  fresh → `apply-first`, older → `good-match`, linked record → `already-applied`),
  strict schema validation/unexpected-property rejection, determinism,
  deep-frozen input immutability, clock independence (`vi.setSystemTime` changes
  nothing), zero `fetch` calls, and a static guard that the module imports no
  storage/AI module and never reads the clock.
- **`src/lib/prioritization/priority-ui.test.ts` (11)** — `PriorityList` markup:
  four category counts, the "cannot know availability/applicants/chances" notice,
  selected category + only its jobs, three separate signals, insufficient-data and
  "Posting date unknown" instead of a score, reasons, safe link (and no link
  without one), module + panel notes, empty states; plus a `JobsPanel`
  `react-dom/server` regression render (existing "Saved jobs"/"Add job manually"
  markup plus the new "Priority shortlist" section and its loading state) with
  `wxt/browser` mocked for module resolution.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 834/834 passed** (48 files; 752 baseline + 82 new)
- `npm run compile` (tsc --noEmit) → **exit 0**
- `npm run build` (wxt build, chrome-mv3) → **exit 0** (manifest unchanged:
  `storage`, `activeTab`, `scripting`; no host permissions)

### Limitations / known issues
- The priority view is a REVIEW ORDER over saved data: it makes no claim that a
  posting is still open, that it has few applicants, or that applying will
  succeed; there is no expiry reminder, notification, sorting of the saved-jobs
  list, or write-back of any computed priority.
- Application linkage is by `jobId` only (the existing relationship). If that
  relationship is missing (unlinked/orphaned record, unreadable log) the status
  stays explicitly unknown and the job cannot be `apply-first`.
- Match estimates are only as good as the saved posting/profile data; a job with
  no usable estimate is `needs-review` by design rather than guessed.
- Verified at unit + `react-dom/server` level only: no real job site was accessed,
  and no real-browser pass (clicking category buttons, opening a posting link) was
  exercised.

### Next
- Prompt 25 (not started — this task stops here).

---
## Done (2026-10-14, task 28 / Prompt 23: capture and display job posting dates)
One focused feature: capture and display the ACTUAL posting date when a source
explicitly publishes one. No prioritization dashboard, no expiry, no sorting by
freshness, no new dependency, no new permission, no AI/network involvement.

### Data model
- **`src/lib/job-dates.ts`** (new, pure) — `postingDateSchema` (strict
  `YYYY-MM-DD` + `isRealCalendarDate`, leap years included, rejecting 2026-02-31
  / month 13 / wrong shapes), `extractIsoCalendarDate` (accepts a date-only value
  or a strict ISO date-time and returns its calendar date **exactly as written**,
  never time-zone shifted; rejects prose, "3 days ago", bare years, impossible
  dates and trailing text), `isIsoDateTime`, `localCalendarDate`,
  `formatPostingDate` (readable local format built from calendar parts, so the
  displayed day always matches the stored day), `isFuturePostingDate`,
  `describePostingDate` (+ `POSTING_DATE_UNKNOWN_LABEL`,
  `FUTURE_POSTING_DATE_WARNING`) and `postedDateFieldValue` (blank → absent for
  the preview/form).
- **`src/lib/job-posting.ts`** — the strict `jobPostingSchema` gains **optional**
  `postedDate` (real calendar date only). No schema-version bump: the field is
  additive and optional, so existing records without it still validate and load
  unchanged and no migration is required. Missing/invalid/ambiguous dates stay
  absent — `capturedAt`/`updatedAt` are never substituted.

### Capture (explicitly published dates only)
- **`src/lib/capture.ts`** — the candidate/response schemas gain optional
  `postedDate` + a fixed `postedDateNotice`. Two narrow, explicit job-metadata
  sources, consistent with the existing architecture and never a body scan:
  JSON-LD `JobPosting.datePosted` (string or array) and `itemprop="datePosted"`
  microdata (only elements that declare an `itemprop` attribute are examined;
  the machine-readable `datetime`/`content` value wins, and an element's own text
  is used only when it is strict ISO). `resolvePostedDate` combines them: none →
  absent, one distinct date → that date, **more than one → absent plus the fixed
  content-free conflict notice** (a winner is never chosen). Prose, relative
  wording, impossible dates and malformed values stay absent. The popup preview
  shows the proposed date and lets you correct or clear it before saving.
- **`src/lib/fixtures/job-jsonld.html`** — the JSON-LD fixture now publishes
  `"datePosted": "2026-10-01"` so the main capture path exercises the feature.

### UI
- **`entrypoints/popup/App.tsx`** — capture preview gains an optional
  `type="date"` posting-date field (prefilled from the capture, editable and
  clearable) plus a hint explaining that a blank date is never the capture time,
  and the conflict notice when two explicit sources disagreed.
- **`entrypoints/options/JobsPanel.tsx`** — the create/edit form gains an
  optional posting-date input with an explicit **Clear date** button; editing
  preloads the saved date and preserves it while other fields change; a blank
  value is stored as absent. **Fix (see defect below): the form now validates
  through `validatePostingDraft`.**
- **`entrypoints/options/PostingDateLabel.tsx`** (new, presentational) —
  renders the saved date in a readable local format, **"Posting date unknown"**
  when absent (never the capture time), and the fixed
  **"Future posting date — verify"** warning for a date after today.
- The list item also keeps its existing provenance line ("captured from page on
  …"), which is explicitly capture metadata, not a freshness claim.

### Defect found and fixed (in scope: the Jobs create/edit form)
- `JobsPanel.onSave` validated the raw draft, which has no `id`/`capturedAt`,
  against the full strict schema — so the manual **create** path always failed
  with generated `id`/`capturedAt` issues and could never save a job. It now uses
  the new `validatePostingDraft()` (job-posting.ts), which supplies documented
  placeholders for a new posting and keeps an edit's own identity; the popup
  capture save path uses the same helper (it previously inlined the placeholders).
  A regression test pins that a new draft validates with no generated-field
  errors while a bad `postedDate` is still reported with its field path.

### Tests (+41; 711 → 752 total)
- **`src/lib/job-dates.test.ts`** (new) — real leap days (2024/2000) vs
  non-leap (2023/1900); impossible dates, wrong shapes, prose and relative
  wording; date-only and ISO date-time extraction incl. offsets (`+02:00`,
  `-05:00`) with no time-zone rollover; strict schema; readable formatting
  (explicit locale) and invalid-input pass-through; local "today"; future-date
  boundaries (before/on/after, year boundary, malformed); `unknown` label; the
  preview/form → schema value mapping (corrected, cleared, malformed passed
  through for the schema to report).
- **`src/lib/job-dates-ui.test.ts`** (new) — the label renders
  "Posting date unknown" with no timestamp substitution, the readable saved date,
  the future warning (`role="status"`) and no warning for today/past.
- **`src/lib/capture.test.ts`** — JSON-LD `datePosted` (date-only, date-time,
  leap day), microdata `datetime`/`content`/strict-ISO text and case-insensitive
  `itemprop`, agreement between sources, absent for malformed/relative/impossible
  values, **conflict between sources and between microdata elements → absent +
  fixed notice (no page text, no winner)**, no dates taken from prose/nav/footer/
  description, `readPostedDateMicrodata` only reading `itemprop=datePosted`,
  `resolvePostedDate` purity/dedupe, strict candidate schema (unknown property and
  non-ISO date rejected), both directions of the boundary validation, preview
  correction/clearing, and zero network calls.
- **`src/lib/job-posting.test.ts`** — `postedDate` optional/absent by default,
  leap day accepted, impossible dates/timestamps/prose rejected, strict rejection
  of `datePosted`/`postedAt`, `createJobPosting` carries an explicit date and
  never invents one, cleared → absent (serialized record has no key), and the
  `validatePostingDraft` regression above.
- **`src/lib/storage.test.ts`** — save → reload → edit (preserves the date) →
  clear (key removed, `capturedAt` unchanged) and a **legacy record without
  `postedDate` loading correctly**; a schema-invalid date is refused without
  writing.

### Commands run this task (exit statuses captured)
- `npx vitest run` → **exit 0, 752/752 passed** (46 files; 711 baseline + 41 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`,
  content-script matches still `*://*.google.com/*`

### Verified vs unverified
- **Verified:** jsdom/unit tests with synthetic fixtures and fake job data only.
  **No real job site was accessed or submitted to**, and no real-browser
  interaction (typing in the popup preview / date picker) was exercised — the
  preview correction/clearing path is verified at the pure value-mapping level.
- Not claimed: that any captured date is accurate unless the source explicitly
  published it; nothing here verifies a third-party site's metadata quality.

### Limitations / known issues
- Only two explicit sources are read (JSON-LD `datePosted` and
  `itemprop="datePosted"` microdata). A posting that states its date only as
  prose ("Posted 3 weeks ago") or in a framework-specific JSON blob keeps an
  unknown date — by design, nothing is guessed.
- A `<time itemprop="datePosted">` whose machine-readable attribute is missing
  and whose text is not strict ISO (e.g. "October 1, 2026") is treated as
  unknown.
- Dates are displayed in the local format via `toLocaleDateString`; the stored
  value stays `YYYY-MM-DD` and the displayed day never shifts by time zone.
- No expiry, notifications, freshness sorting or prioritization — the
  prioritization dashboard is explicitly not part of this task.
- `README.md` documents the feature; `docs/autofill-compatibility.md` was
  deliberately left untouched (autofill is unrelated to this task).

### Next
- Prompt 24 was not started. The posting date groundwork is in place for a later
  prioritization feature; remaining verification would be a real-browser pass
  over the popup preview and the Options date input.

---

## Done (2026-10-14, task 27 / Prompt 22: deterministic detection + field coverage)
Focused autofill-detection task. No Workday adapter, no AI change, no new
permission, no dependency, no manifest/content-script change. Detection stays
deterministic, offline and value-free.

### Genuine gaps found (audited page.ts / classify.ts / plan.ts / execute.ts)
1. **Explicit ARIA name discarded when a native label existed** — `associatedLabel`
   resolved `aria-labelledby`/`aria-label` only when there was NO visible `<label>`,
   so `<label for=e>Name</label><input id=e aria-labelledby=lbl>` lost the
   referenced text entirely and stayed **ambiguous** (measured with a jsdom probe
   before the fix).
2. **Fragile `aria-labelledby` parsing** — duplicate ids were concatenated
   ("Phone Phone"), comma-separated IDREF lists (common in the wild) resolved to
   nothing, and a malformed token could make the whole attribute unusable.
3. **No fieldset/legend context for non-radio controls** — an unlabelled control
   inside `<fieldset><legend>Email address</legend>…` was **unsupported**, and
   `fieldset.querySelector('legend')` could read a nested group's legend instead
   of the nearest ancestor's (a control in a legend-less nested fieldset stayed
   unsupported even though the outer group named it).
4. **Placeholder treated as a peer signal** — a real label plus a boilerplate
   placeholder (label "First name", placeholder "Enter your email address")
   produced two categories → **ambiguous → manual**.
5. **`type=password` not excluded by its own type** — a password box with an
   innocuous label/placeholder was classified as a supported category and could
   have been written to.
6. **Existing values were overwritten** — the executor wrote the saved answer
   without checking whether the control already held content (nothing enforced
   the "never overwrite" rule, and the value-free review pane cannot show the
   current page value).

### Fixes (smallest change per gap)
- **`src/lib/autofill/page.ts`** — new `ariaName()` (resolved `aria-labelledby`,
  else the `aria-label` attribute) and `nativeLabel()` split out of
  `associatedLabel()`; the explicit ARIA name is now captured on EVERY descriptor
  (`ariaLabel`) even when a visible label exists. `referencedLabel()` splits on
  whitespace **and** commas, de-duplicates ids, skips unresolvable/malformed ones
  and caps the result. New `nearestLegend()` walks outward to the nearest ancestor
  `<legend>` using only a fieldset's **direct-child** legend (never a nested
  group's), exposed as the new value-free descriptor field `groupLabel`;
  `radioGroupLabel()` uses it too.
- **`src/lib/autofill/classify.ts`** — two corpora: the **safety** corpus still
  contains EVERY signal (incl. placeholder and legend) so exclusions cannot be
  bypassed by a misleading label; the **match** corpus (category detection) drops
  the placeholder when a real label/ARIA name exists and uses the legend only when
  the control has no label/ARIA name/placeholder of its own. The password
  exclusion additionally checks the control's own `type`. Module header documents
  rules 7–8.
- **`src/lib/autofill/schemas.ts`** — new optional, bounded (300) `groupLabel`
  descriptor field (strict schema kept) and the new `already-filled` fill status.
- **`src/lib/autofill/execute.ts`** — **never overwrite**: an `input`/`textarea`
  with non-empty content, a `<select>` whose current selection is a real
  (non-placeholder) option, or a radio group with another option already chosen is
  left exactly as it is and reported `already-filled` (no write, no events, message
  never contains the value). Ambiguity is still resolved FIRST, so an unmatched
  field keeps `no-match`; placeholder-selected selects, empty fields, unchecked
  radios/checkboxes and multi-selects behave exactly as before.
- **`src/lib/autofill/plan.ts`** — the review label falls back through real label
  → ARIA name → placeholder → group legend → `name`/`id` (display only).

### Tests — `src/lib/autofill/detection.test.ts` (new, **28 tests**, jsdom)
Covers requested cases 1–14: `label[for]`/nested/duplicate labels; `aria-label`;
multi-id, duplicated, comma-separated and missing `aria-labelledby` ids;
ARIA-name-plus-native-label (regression for gap 1); conservative ambiguity when
the two conflict; legend context (nested groups; never overriding an owned
label/placeholder); placeholder precedence (fallback only, still feeds safety
exclusions, plus the `type=password` case); duplicate labels staying independent
(each filled via the real session); dynamic controls discovered by a fresh scan
(old token rejected `stale-session`, new scan fills the added field);
oversized/malformed markup (300-char cap, duplicate ids, dangling `label[for]`,
empty legend) never throwing; sensitive/legal/compensation/EEO exclusions intact
despite misleading labels and group context; existing-value + hidden/disabled/
read-only ineligibility in one pass; zero network/provider calls across
scan→plan→fill (value-free descriptor JSON asserted); per-field
`requiresConfirmation` and the scan-token requirement intact. Already-covered
behaviours were deliberately NOT duplicated (see the file header).

### Commands run this task (exit statuses captured)
- `npx vitest run` → **exit 0, 711/711 passed** (44 files; 683 baseline + 28 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, no `host_permissions`,
  content-script matches still `*://*.google.com/*`

### Verified vs unverified
- **Verified:** jsdom unit tests only (synthetic fixtures). No real browser, no
  live site, and **no Workday environment** was used — nothing here claims
  complete Workday support.
- **Inferred:** standard HTML/ARIA semantics of the fixtures.

### Limitations / known issues
- Detection is still label/attribute based: a group legend only identifies a field
  when the question names it ("My Information" stays manual), and
  `<div role="combobox">` widgets with no native control are still never scanned.
- "Never overwrite" means a page-supplied default answer (a real option preselected
  in a dropdown, an already-answered radio group) is reported `already-filled`
  rather than replaced — the user changes it manually.
- If a visible label and an explicit ARIA name disagree, the field stays manual.
- No real-browser/framework-render verification (same jsdom boundary as every
  previous autofill task).

### Next
- Prompt 23 was not started. Remaining work: a permitted real-browser/Workday test
  environment to upgrade the unverified compatibility rows, and live provider
  wiring for AI mapping (a separate, explicitly scoped task).

---

## Done (2026-10-14, task 26 / Prompt 21: real-browser verification of the PDF and DOCX exports)
Verification-only task — **no product feature, no dependency, no Prompt 22 work,
no source change (repo diff = this file only).** Executed an automated
**real-Chromium** verification of the current and historical export workflows,
specializing in DOCX downloads.

### Method (reused the Prompt 19 approach)
- Throwaway harness **outside the repository**
  (`%LOCALAPPDATA%\Temp\p19-verify\verify21.mjs`, `playwright-core` installed in
  that temp dir only — nothing committed, no repository dependency added).
  It drives Playwright's **bundled Chromium** (`chromium-1234`…\chrome.exe) via
  `launchPersistentContext` with `--load-extension` / `--disable-extensions-except`
  on the freshly built `.output/chrome-mv3`, **headless**, `acceptDownloads: true`.
  System Chrome cannot side-load (Chrome ≥137 removed `--load-extension`).
  Extension loaded; MV3 service worker
  `chrome-extension://dfikbkpbilhklcdajlceobmpgcalkpgb`.
- **Fake data only**: profile, two job postings and a fake sensitive profile were
  seeded straight into `chrome.storage.local` with distinctive markers
  (`ORIGSUMMARYTOKENAAA`, `ORIGBULLETTOKENCCC`, edited variants
  `EDITSUMMARYTOKENBBB` / `EDITBULLETTOKENDDD`). The user's real profile was
  never read, written or displayed.
- Downloads were captured through the **browser's own download events** and
  written to a temp directory **outside the repo**
  (`%LOCALAPPDATA%\Temp\p21-verify\out[C]\`), then inspected offline:
  PDF text via the same inflate + `Tj` technique as
  `src/lib/resume/pdf/test-support.ts`; the DOCX was unzipped with a small
  local ZIP reader and `word/document.xml` parsed with the **browser's
  `DOMParser`** (safe parse — asserts no `parsererror`, no `<!DOCTYPE>` /
  `<!ENTITY>`).

### Results — 3 runs
| Run | Build | Checks | Exit |
|---|---|---|---|
| A | clean (`e12a573` artifact) | **32 passed, 0 failed**, 5 skipped (counter checks) | **0** |
| B | temporarily instrumented | **37 passed, 0 failed, 0 skipped** | **0** |
| C | clean again after reverting the hook | **32 passed, 0 failed**, 5 skipped | **0** |

**Current resume (Options → Jobs)**
- The section offers **PDF, DOCX and save** actions once a job is selected
  (`beforeSelect={pdf:0,docx:0,save:0}` → `afterSelect pdf=1 docx=1 save=1`).
- PDF download: 3,005 bytes, header `%PDF-`, notice
  `Resume PDF generated (1 page). Check your downloads.`
- DOCX download: 9,267 bytes, `PK\x03\x04`, package parts
  `[Content_Types].xml`, `_rels/.rels`, `word/document.xml` (+ `styles.xml`,
  `numbering.xml`, `word/_rels/document.xml.rels`) — **valid ZIP/OOXML**.
- XML parsed cleanly (no DTD/entities); the fake resume text, all six section
  headings and their **canonical order** are present in BOTH formats:
  Professional Summary → Skills → Professional Experience → Education →
  Certifications → Languages. Both formats expose the **same 7/7 content
  tokens** (same prepared snapshot). DOCX has **0 tables, 0 drawings, 0
  hyperlinks** (single-column ATS markup).
- Filenames safe: `resume-senior-backend-engineer-tailored.pdf` /
  `.docx` (no spaces or path characters).
- **Failures**: a PDF export with an unencodable display name fails with
  `Some profile text cannot be rendered in the PDF: … U+65E5, U+672C, U+8A9E.`
  and a DOCX export with an XML-invalid character fails with
  `Some resume text contains characters that cannot be stored in a Word
  document: U+000B. No file was created.` — in both cases **no download
  happened, no success notice appeared, and the error carried only `U+XXXX`
  codes** (no resume/profile text).

**Historical snapshots**
- Save wrote **only** `job-resume-history.v1` (`changedKeys=["job-resume-history.v1"]`,
  `job-applications.v1` still absent).
- The saved version exported PDF + DOCX containing the original markers.
- After editing the master profile's **summary, a skill and an experience
  bullet**, both historical exports still rendered the **original** snapshot and
  **not** a single edited token; the stored record stayed byte-identical and
  no stored key changed (`storageUnchanged=true`).
- With the job posting removed, the version stayed listed with
  `data-orphaned="true"` ("…no longer saved") and still exported both formats.
- Delete still requires the two-step confirmation (`confirmShown=1`, storage
  unchanged while confirming), **Cancel wrote nothing**, and the confirmed
  delete removed exactly that version.

**Single-snapshot workflow (temporary instrumentation, never shipped)**
A one-line call counter was added to `prepareTailoredResume`, built, measured,
then **reverted** (working tree clean; the final `.output` contains **0 files**
mentioning the probe; nothing committed):
- a single PDF action: `null → 1` (**tailors exactly once**);
- DOCX on the same inputs: `1 → 1` (no re-tailor);
- save on the same inputs: `1 → 1` (reuses the snapshot);
- historical PDF + DOCX after a reload: `null → null` (no tailoring at all);
- a changed profile + new PDF: `null → 1` (the counter is live, not stuck).

**Privacy / storage / permissions**
- **No `http(s)` request** during the whole run (4 requests total, all
  `chrome-extension://`); no AI/network call.
- Built manifest still `permissions=[activeTab,scripting,storage]`,
  `host_permissions=null`.
- `job-applications.v1` was **never created or modified**.
- Seeded sensitive tokens (`fake.person@secret.invalid`, `+493000000001`,
  `SECRETADDRESS1 Fakestrasse 1`) are absent from the AI-safe profile record,
  from the PDF and from the DOCX. Schema inspection confirms why:
  contact/legal/voluntary/documents live only in the separate
  `src/lib/sensitive.ts` record (`job-profile.sensitive.v2`),
  `tailoredResumeSchema` has no contact field, and the history entry schema is
  `.strict()`, so an out-of-contract key is rejected (also unit-tested in
  `pdf/render.test.ts`, `docx/render.test.ts`, `history.test.ts`).

### Harness defects found (mine, not the product's)
The first run reported 5 failures; all three causes were in the throwaway
harness and were fixed and re-run: `await Promise.all([...])[0]` bound `[0]` to
the Promise (read the error before the click finished), the action buttons were
counted before a job was selected (the section only renders then), and the
rendered language label is `English (Fluent)`, not `English (fluent)`. **No
product defect was found in any run.**

### Commands run this task (exit statuses captured inline)
- `npm run build` → **exit 0** (clean, and again after removing the probe)
- real-browser harness (clean build) → **exit 0, 32/32 checks passed**
- real-browser harness (instrumented build) → **exit 0, 37/37 checks passed**
- `npx vitest run` → **exit 0, 683/683 passed (43 files)**
- `npm run compile` → **exit 0**

### Limitations / still unverified
- **Chromium only, headless** — not Chrome-stable (cannot CLI-side-load
  extensions at ≥137), not a human-driven session, and **no word processor was
  opened**: nothing is claimed about how Word, Google Docs or LibreOffice
  render/round-trip these files, and **no ATS compatibility is claimed**.
- Tailor-call counts came from a temporary, now-reverted instrumentation hook;
  without it the browser cannot observe internal call counts (the 5 checks are
  reported as SKIP on clean builds).
- Downloads were captured by the harness and written to a temp path; the OS
  “Save as” flow and the browser's download UI were not exercised.
- Network coverage is Playwright's context-level request event (extension
  service-worker requests may not surface there); unit tests independently
  assert `fetch` is never called.
- No accessibility/keyboard pass, no multi-tab or sync-storage test.

---

## Done (2026-10-14, task 25 / Prompt 20 follow-up: one tailored snapshot per export)
Fixes a real double-tailoring bug in the current-resume workflow. No Prompt 21
work, no new features, no new dependencies, no new permissions, no unrelated
refactors.

### The bug
`entrypoints/options/ResumeExport.tsx` called `generateAndDownloadResume(profile,
job)` (the PDF pipeline, which tailors internally) and THEN called
`tailorResume(profile, job)` a second time to populate its cached `generated`
result. The tailoring engine therefore ran twice for one PDF click, and the
cached payload later used by DOCX and “Save version to history” was a second,
independent tailoring rather than the exact result the PDF was rendered from.

### The fix (smallest clean correction)
- **`src/lib/resume/prepare.ts` (new)** — step 1: `prepareTailoredResume(profile,
  job, tailor?)` tailors exactly ONCE into one strictly validated
  `TailoredResume`, or returns a typed reason (`no-profile` / `insufficient` /
  `invalid`). `prepareFailureMessage(reason, 'generated' | 'saved')` is the ONE
  place holding the fixed, content-free failure text, preserving each action's
  existing wording (PDF/DOCX say “generated”, save says “saved”). Imports no
  PDF, DOCX or storage module, so nothing can re-render or re-read for a
  failure.
- **`src/lib/resume/pdf/export.ts`** — the render+download tail is now a single
  private helper shared by all entry points, so `invalid` /
  `unsupported-characters` / `render-failed` / `download-unavailable` and the
  `U+XXXX`-only reporting exist once. NEW `downloadTailoredResumePdf(resume,
  deps?)` renders/downloads an ALREADY-PREPARED current resume (snapshot in, no
  tailoring, no profile/job read). `generateAndDownloadResume` keeps its public
  interface, typed outcomes and messages and now delegates step 1 to
  `prepareTailoredResume` (existing callers unchanged). `downloadResumeSnapshot`
  (history / orphan-safe) is unchanged.
- **`src/lib/resume/current-export.ts` (new)** — the testable orchestrator
  `exportCurrentResume(action, inputs, deps)` for `'pdf' | 'docx' | 'save'`.
  Steps are injectable (tailor, PDF, DOCX, save). It reuses `inputs.current`
  when a snapshot already exists and only tailors when there is none, then
  returns `{ ok: true, resume, notice }` carrying the SAME object it acted on so
  the caller can cache it. No re-tailoring, no separate PDF/DOCX mapping, no
  storage read, no network.
- **`entrypoints/options/ResumeExport.tsx`** — all three buttons now call
  `exportCurrentResume(action, { profile, job, current: generated })`; the
  duplicated inline tailoring blocks are gone and the component holds only
  React state. Button labels, notices, disabled states, filename behaviour,
  privacy protections and history semantics are unchanged; the PDF message
  (`Resume PDF generated (N page(s)). Check your downloads.`) and the save
  wording are byte-identical to before.

### Guarantees, tested by behaviour (not source text)
`src/lib/resume/current-export.test.ts` (16 tests) injects the four steps:
- exactly ONE tailoring call per PDF action, and **still one** across a
  PDF → DOCX → Save sequence (`current` reused);
- the SAME object (identity, not a copy) is passed to the PDF and DOCX
  renderers, each receiving only the snapshot (no profile/job argument);
- Save receives that exact snapshot plus the copied job label
  (`{ id, title, company? }`);
- a cached snapshot still exports with `profile: null` and a different posting
  in scope (snapshot-only, like history) — the tailor is never called;
- action-specific fixed failure text (no-profile / insufficient / invalid),
  verbatim passthrough of render/download and history-save failures, no
  success claim on failure, and no network calls.
It also runs the REAL tailoring + PDF + DOCX engines end-to-end from one
profile+job (only the browser download stubbed) and asserts both formats were
handed the identical snapshot object.
`src/lib/resume/pdf/export.test.ts` adds the `downloadTailoredResumePdf`
behaviour (render happy path, payload not mutated, typed download failure,
`U+XXXX`-only unsupported-character failure) and keeps the
`generateAndDownloadResume` suite green. `resume-export-ui.test.ts` adds a
source guard: the component imports the single-snapshot flow and no longer
imports `tailorResume` / `generateAndDownloadResume` / `saveResumeVersion`.

### Verification (raw exit codes, after the last file change)
| Command | Exit | Result |
|---|---|---|
| `npx vitest run` | **0** | **683 passed / 43 files** (662/42 before → +21 tests) |
| `npm run compile` | **0** | clean (`tsc --noEmit`) |
| `npm run build` | **0** | built; manifest permissions still exactly `storage, activeTab, scripting`; no host permissions |

### Not done / limitations
- **No word processor was opened**, as before: rendering/round-tripping in Word
  / Google Docs / LibreOffice stays unverified and no ATS compatibility is
  claimed.
- The DOCX (`current` and historical) buttons are still covered by
  `react-dom/server` + orchestrator unit tests, not by the Prompt 19 real-browser
  harness.
- `generateAndDownloadResume` is no longer used by the Options UI (the
  snapshot-based helper is); it is kept deliberately as a public,
  backward-compatible entry point and stays covered by its own tests.

## Done (2026-10-14, task 24 / Prompt 20: ATS-friendly DOCX resume export)
Adds a deterministic, ATS-friendly Word (`.docx`, Office Open XML) export of a
tailored resume, alongside the existing PDF export. No Prompt 21 work, no other
feature changes.

### Acceptance criteria → where it is met
- **Valid `.docx` from a validated `TailoredResume`** — `renderResumeDocx`
  re-validates with the EXISTING strict `tailoredResumeSchema` (no competing
  schema) and emits a minimal OOXML package (`[Content_Types].xml`,
  `_rels/.rels`, `word/document.xml`, `word/_rels/document.xml.rels`,
  `word/styles.xml`, `word/numbering.xml`). Tests unzip it and parse every part
  as XML.
- **Single-column, ATS-safe structure** — ordinary paragraphs only: no tables,
  text boxes, columns, drawings/shapes or hyperlinks (asserted). Headings use
  `w:outlineLvl`; bullets use a real Word list definition (`numbering.xml`), not
  a typed character.
- **Content + ordering preserved** — the document body is built from the SAME
  `buildBlocks()` (src/lib/resume/pdf/layout.ts) the PDF renderer uses, so both
  formats render identical text, headings and section order for one resume.
  Nothing is invented, re-worded or dropped; posting provenance, ids and
  relevance/selection annotations are never rendered.
- **XML-safe encoding** — every value goes through `escapeXmlText`; text with
  characters XML 1.0 cannot represent is refused with a typed
  `unsupported-characters` result (reporting only `U+XXXX`) rather than writing
  a corrupted package.
- **No hidden metadata / no external links** — NO `docProps/*` part is emitted
  at all (no creator, application, or creation/modification time) and link URLs
  render as plain text, exactly like the PDF.
- **Current-resume export** — the Options → Jobs section now offers *Download
  tailored resume PDF* and *Download tailored resume DOCX*; both are rendered
  from the SAME cached validated `TailoredResume` for the current profile + job.
  The DOCX path never calls `tailorResume` on an existing result and never
  mutates the payload. Safe filename
  `resume-<job-title-slug>-tailored.docx` (characters outside `[a-z0-9]`
  stripped, 60-char cap, neutral `resume-tailored.docx` fallback; no employer or
  title invented); typed, content-free failure messages.
- **Historical export** — each saved history version now has *Export DOCX* next
  to *Export PDF*, both rendering that version's **saved snapshot** with no
  profile/job read (the export function takes ONLY a `TailoredResume`). Orphaned
  versions (job posting deleted) stay exportable; the snapshot, history entry
  and application status are never mutated.
- **Privacy** — the sensitive profile is never imported or read (source-scanned
  in tests); strict-schema rejection stops any out-of-contract field (e.g. a
  `contactEmail`/`sensitive` injection) from entering the document; no resume
  content is logged; no network/AI call (fetch spies asserted).

### New dependency (and why)
- **`fflate@^0.8.3`** → `dependencies` (runtime, bundled). MIT, ~8 KB, ZERO
  dependencies, browser + Node, ESM-first with proper types.
  **Why needed:** a `.docx` IS a ZIP package and the project had no way to write
  one. Used ONLY as the ZIP container writer.
  **Why not a full DOCX library** (`docx`): it emits `docProps/core.xml` with
  creator + creation/modification timestamps (hidden metadata this prompt
  forbids) and packs with the current time (not byte-deterministic), and it
  hides the OOXML we want to keep explicitly ATS-safe. `jszip` was also
  rejected: its `export =` typings do not typecheck under this repo's
  `verbatimModuleSyntax` config. The OOXML itself is authored by us, mirroring
  how `pdf-lib` is used only as the low-level writer while `pdf/layout.ts` owns
  all content.
- No manifest/host permission, credential, API key or remote service was added;
  no other dependency changed.

### Files
- **New:** `src/lib/resume/docx/xml.ts` (XML escaping + XML-1.0 character
  validity), `document.ts` (OOXML parts + paragraph/heading/bullet mapping),
  `render.ts` (validate → build → deterministic ZIP → Blob + safe filename),
  `export.ts` (`downloadResumeDocx(snapshot)` — render + download, typed
  failures), `index.ts` (public surface).
- **New tests:** `docx/render.test.ts` (16), `docx/export.test.ts` (12).
- **Changed:** `entrypoints/options/ResumeExport.tsx` (DOCX button + per-action
  busy state; PDF flow otherwise unchanged), `ResumeVersionList.tsx`
  (`onExportDocx` prop + *Export DOCX* action), `ResumeHistory.tsx` (shared
  PDF/DOCX export handler), `README.md`, `PROGRESS.md`, `package.json`,
  `package-lock.json`, and the two UI test files (new prop + DOCX assertions).

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 662/662 passed** (42 files; 634 baseline + 28 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**

### Limitations / not verified
- **No word processor was used.** Verification is structural (in-memory ZIP
  inspection + XML parsing of every part). How Microsoft Word, Google Docs or
  LibreOffice render or round-trip the file is **not** verified, and no
  universal ATS compatibility is claimed.
- Layout is fixed: no templates, branding, fonts, logos/images or page-count
  control. A long resume simply flows onto further pages.
- ZIP entries are stored (uncompressed), so the file is larger than a
  DEFLATE-compressed DOCX; this is deliberate (byte-determinism, no compressor).
- The DOCX export is unit-tested only — it was **not** included in the
  Prompt 19 real-browser harness (that harness covered the history UI/PDF).

### Next
- Prompt 21 is out of scope for this task.

---

## Done (2026-10-14, task 23 / Prompt 19 follow-up: real-browser verification of the resume-history UI)
Executed (not merely documented) an automated **real-browser** verification of
Prompt 19's UI against a live `chrome.storage.local`, using a throwaway harness
kept OUTSIDE the repository. **No repository dependency was added; no Prompt 19
source changed; repo change = this file only.**
- **Method.** `playwright-core` (installed only in a temp dir, never committed)
  driving Playwright's **bundled Chromium** (`chromium-1234`, under
  `%LOCALAPPDATA%\ms-playwright\...\chrome.exe`) via `launchPersistentContext`
  with `--load-extension` / `--disable-extensions-except` pointed at the built
  `.output/chrome-mv3`. Ran **headless** — no headful fallback was needed. The
  system Chrome (155.0.8059.40) cannot be used for this: Chrome ≥137 removed
  `--load-extension`, so only bundled Chromium can side-load an unpacked
  extension. The extension loaded, its MV3 service worker registered
  (`extId=dfikbkpbilhklcdajlceobmpgcalkpgb`), and the options page rendered.
- **Result: 22/22 checks PASS** — real `chrome.storage.local`, real PDF downloads
  captured through the browser's own download event, and PDF text extracted with
  the same zlib + `Tj` technique as `src/lib/resume/pdf/test-support.ts`:
  - **Save** writes the dedicated key `job-resume-history.v1`; the entry carries
    a generated `id`, `schemaVersion` 1, `jobId`/`jobTitle`/`company` copied from
    the saved job, `status: saved`, an ISO `createdAt`, and the
    `tailoredResumeSchema` snapshot.
  - Save writes **only** the history key: a full storage diff before/after the
    click yielded `changedKeys=["job-resume-history.v1"]`, with profile/jobs
    byte-identical and no `job-applications.v1` created.
  - The save button flips to disabled **"Version saved"** with a notice; the
    history row shows title / company / `Saved <date>` / status; the version
    **persists across an options-page reload**.
  - **Open** shows count-only details (`2 skills · 1 experience · 0 projects …`)
    and leaks no resume body text into the DOM.
  - **Export PDF** downloads a real `%PDF-` file (2,539 bytes) whose extracted
    text contains the stored snapshot's summary.
  - After editing the profile, export still renders the **ORIGINAL** snapshot and
    NOT the new summary; export also succeeds with the **profile key absent**
    (proves no re-tailoring and no profile read).
  - Two versions (two jobs) → the two-step delete removes **only** the selected
    version; the confirmation gate appears while storage is unchanged and
    **Cancel writes nothing**; the list updates.
  - An orphaned `jobId` keeps the version, flags it `data-orphaned="true"`
    ("…no longer saved"), and still exports.
  - Malformed history shows the banner and is **not overwritten** (the raw
    `"NOT-A-RECORD"` value was still present); the explicit **Discard** replaces
    it with an empty valid record.
  - At the documented 200-version cap, a save is **refused** with the fixed
    message and nothing is deleted (still 200 versions).
- **Observation (benign, not a defect):** the options page does **not** rewrite
  the profile/jobs keys on load. An early raw `JSON.stringify` comparison
  differed only by **object key ordering after the `chrome.storage` round-trip**;
  a canonical key-sorted comparison showed no difference and a
  storage-vs-storage diff before/after the save was byte-identical. Recorded so
  the artifact is not mistaken for a storage write.

### Commands run this task (exit statuses captured inline)
- real-browser harness: `node verify.mjs <ext> <chromium> headless <out>` →
  **22/22 PASS** (`%LOCALAPPDATA%\Temp\p19-verify\out\results.json`)
- `npx vitest run` → **exit 0, 634/634 passed** (40 files)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**

### Limitations / still unverified
- Verified on **Chromium only, headless** — not Chrome-stable (which cannot
  CLI-side-load extensions at ≥137) and not a human-driven manual session.
- The download was captured via the browser's download event and saved to disk by
  the harness; OS-level "Save as"/Downloads-folder placement and the browser's
  download UI were not exercised.
- The malformed-history and 200-cap paths were reached by injecting storage
  states (not reachable through normal UI) — intentional.
- No sync storage, cross-device, multi-tab live-update, or accessibility/keyboard
  pass was performed.

### Next
- Unchanged: Prompt 20 was explicitly out of scope for this verification.

---

## Done (2026-10-13, task 22 / Prompt 19 follow-up: git audit & generated-artifact cleanup)
Verification-only audit of the GitHub `main` state after Prompt 19, plus a
narrow cleanup. No Prompt 19 source or behavior changed; no new feature.
- **Git state (before changes):** branch `main`, working tree clean, tracking
  `origin/main` (0 ahead / 0 behind). `8114132` (Prompt 18), `c9e5d15`
  (Prompt 19 implementation) and `3efdfca` are all reachable from `main`.
- **`c9e5d15` (Prompt 19 implementation):** 19 files, source + docs + tests
  only (`src/lib/resume/history.ts`, `history-service.ts`, `storage.ts`,
  `pdf/export.ts` + UI `ResumeHistory.tsx` / `ResumeVersionList.tsx` /
  `ResumeExport.tsx` / `JobsPanel.tsx` / `style.css` and 6 test files).
- **`3efdfca` (investigated follow-up):** 24 files, **generated output only**
  — 16 `.output/chrome-mv3/**` build bundles/assets and 8 `.wxt/**` generated
  types (`.wxt/tsconfig.json` was previously tracked as an empty `{}`). No
  source, docs, config or Prompt 19 behavior change; no secrets, `.env`,
  credentials or real personal profile data (scan of the diff surfaced only
  the commit author email and bundled library/React code).
- **`.gitignore`** (was `node_modules` only) — added `.output` and `.wxt`
  (WXT's standard generated directories; root `tsconfig.json` extends
  `./.wxt/tsconfig.json`, regenerated automatically by `postinstall: wxt
  prepare`). Removed the two directories from the Git index with
  `git rm -r --cached` (working files preserved on disk); normal cleanup
  commit — no history rewrite, no force-push.
- **Prompt 19 verification (all PASS):** dedicated versioned key
  `job-resume-history.v1`; strict zod `.strict()` schemas + validated storage
  results; malformed history never silently overwritten (load-first abort,
  explicit-only reset); historical export renders the saved `TailoredResume`
  snapshot via `downloadResumeSnapshot` (no re-tailoring, no profile/job read);
  delete targets exactly the selected id; the 200-version cap refuses saves
  (`limit-reached`) instead of trimming; sensitive profile data rejected/
  excluded; existing tailoring, PDF export, matching and application-log
  behavior unchanged.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 634/634 passed** (40 files)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**

### Limitations / not independently verified
- Cleanup affects version control only; `.output`/`.wxt` are regenerated by
  `wxt prepare` / `wxt build`. Prompt 19 UI still verified by unit/jsdom tests
  (no real-browser interaction).

### Next
- Unchanged: Prompt 20 was explicitly out of scope for this audit.

---

## Done (2026-10-13, task 21 / Prompt 19: local tailored resume version history)
Local-only save/revisit/export/delete of the resume versions generated per job.
Integrates with the EXISTING deterministic `tailorResume` + `renderResumePdf`
workflow; no DOCX, no AI wiring, no Workday adapter, no application-log change.
- **`src/lib/resume/history.ts`** (new) — strict zod v4 (`.strict()`) model:
  `resumeHistoryEntrySchema` { generated `id`, `schemaVersion`, optional
  `jobId`, optional `jobTitle`/`company` labels, `createdAt`, fixed `status`
  (`saved`), and the `snapshot` — the EXISTING `tailoredResumeSchema` reused,
  never duplicated } plus `resumeHistoryRecordSchema` (cap
  `MAX_RESUME_HISTORY_VERSIONS` 200). Unknown keys (credentials, tokens, page
  content, HTML/selectors) and sensitive profile fields are rejected on read
  AND write; issues are `path: code` only (no content). Pure helpers:
  `createResumeHistoryEntry` (labels copied from the saved job / snapshot
  provenance — never invented; company omitted when absent; injected `now`/`id`),
  `upsertResumeHistoryEntry` (newest-first, replace-by-id, nothing dropped),
  `removeResumeHistoryEntry` (exactly one id), `findResumeHistoryEntry`,
  `isResumeHistoryFull`, `validateResumeHistoryEntry`, `formatResumeHistoryIssues`.
  No storage/PDF/sensitive import (pure module).
- **`src/lib/storage.ts`** (minimal extension) — dedicated versioned key
  `STORAGE_KEYS.resumeHistory` = `job-resume-history.v1` with
  `loadResumeHistory`/`saveResumeHistory`/`resetResumeHistory` over the
  existing `loadValidated`/`writeValidated` service (absent / malformed+raw /
  unavailable / quota distinctions; corrupt data never silently overwritten).
  Profile, sensitive, settings, jobs and application-log keys are untouched.
- **`src/lib/resume/history-service.ts`** (new) — domain rules with the typed
  outcome convention (`{ ok } | { ok:false, reason, message, issues?, raw? }`;
  reasons absent/malformed/unavailable/quota/invalid/not-found/limit-reached):
  `listResumeVersions` (absent → empty list), `getResumeVersion`,
  `saveResumeVersion` (strict snapshot validation, job/resume provenance
  cross-check, load-first abort on malformed/unavailable, **refuses** at the
  200 cap with `limit-reached` — never trims older versions),
  `deleteResumeVersion` (exactly the selected id). Messages are fixed and
  carry no resume/profile/job content. No AI, no network, no sensitive profile,
  no direct `chrome.storage` (source-scanned in tests).
- **`src/lib/resume/pdf/export.ts`** — new `downloadResumeSnapshot(snapshot,
  deps?)`: renders the PROVIDED payload through the existing
  `renderResumePdf` and downloads it. No tailoring, no profile/job read, no
  storage — a historical export always uses its saved snapshot (byte-identical
  to `renderResumePdf(snapshot)` in tests). Typed failures reuse the same fixed
  messages (`invalid` / `unsupported-characters` / `render-failed` /
  `download-unavailable`).
- **UI (Options → Jobs):** `ResumeExport.tsx` gains an explicit **Save version
  to history** button (saves the version just generated for the current
  profile+job; disabled once that version is saved, reset when profile/job
  change; never submits or touches application status) and an honest
  no-profile message. New `ResumeHistory.tsx` (container: loads versions + job
  references, malformed/unavailable banners with explicit-only discard,
  orphan banner, export/delete handlers) + `ResumeVersionList.tsx`
  (presentational: labels, `Saved <date>`, status, count-only details behind
  **Open**, **Export PDF**, two-step **Delete** gated on `confirmingDeleteId`).
  `JobsPanel.tsx` renders the history section (always visible, even without a
  selected job) and refreshes it via `onVersionSaved`; `style.css` gained a
  small `.resume-version*` block. No preview exists in this build, so opening a
  version shows labels/counts instead of a rendered preview (documented).
- **Tests (6 files, +55 tests; suite 634 passing (40 files)):**
  `resume/history.test.ts` (14) — entry/record round trips, strict rejection of
  unknown keys (`apiKey`/`token`/`pageContent`/`selector`/`salary`/…),
  sensitive-field rejection at entry AND snapshot level, malformed id/date/
  status/label/snapshot, over-cap record, value-free issues (never echo
  `SECRET…`), label provenance (no invented company/title), snapshot
  immutability against later source mutation, injected clock/id determinism,
  newest-first upsert without drops, delete-one, cap helper. `resume/history-service.test.ts`
  (16) — absent → empty; save→list→get round trip (newest first); only the
  history key written (profile/jobs/applications byte-unchanged; no application
  created); works with no job store; malformed with recoverable raw and never
  overwritten on save/delete/get (message free of content); unavailable read/
  write; quota write preserves existing versions; invalid resume + mismatched
  job rejected without writing; 200-cap save refused (`Nothing was deleted`);
  profile+job edited after save → stored snapshot deep-equals the original
  while re-tailoring differs; export after edit contains the ORIGINAL summary
  and not the new one; delete removes only the selected version; orphaned job
  reference keeps labels/snapshot and stays exportable/deletable; zero fetch;
  source scan (no sensitive/AI/fetch/direct-storage imports). `resume/history-ui.test.ts`
  (9) — labels/date/status, count-only details (no resume body text), open/
  closed gating, **delete-confirmation gate**, orphan flag + kept version,
  empty state, HTML-escaping, busy-disabled actions, zero network.
  `resume/resume-export-ui.test.ts` (4) — save control present + explained,
  both actions disabled without a profile, no pre-claimed "saved" state, zero
  network. `resume/pdf/snapshot-export.test.ts` (7) — download once, exported
  bytes identical to `renderResumePdf(snapshot)` (snapshot text present,
  posting provenance still not rendered), only the snapshot is a required
  parameter, typed invalid/unsupported-character/download failures, zero
  network. `storage.test.ts` (+5) — absent, one-entry round trip (local key
  only), malformed+raw preserved with content-free message, unavailable +
  quota with the stored record intact, explicit reset touching no other key.
- **`README.md`** — new "Tailored resume version history (local-only)"
  section (storage key, record fields, save/open/export/delete behavior, cap,
  orphan policy, limitations) + Jobs-tab and roadmap updates.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 634/634 passed** (40 files; 579 baseline + 55 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, **no** `host_permissions`

### Privacy / security audit
- Dedicated local key `job-resume-history.v1` (never sync); no profile /
  sensitive / settings / jobs / application-log key reused or overwritten;
  `npm install` lockfile churn reverted (no dependency added — `pdf-lib`,
  `react`, `zod` only, as before).
- No API keys/credentials/tokens field exists in the strict schemas; sensitive
  profile, legal/EEO/voluntary, compensation and government-ID fields are
  structurally rejected (tested at entry and snapshot level).
- No page content, full job description, HTML/scripts/selectors in records;
  the snapshot is the existing tailored-resume schema only. Validation issues
  and service messages are path+code / fixed text — no resume or profile
  content in logs or errors.
- No new manifest/host permission, no new dependency, no network/AI call
  (fetch spies asserted across save/list/get/export/render), no telemetry.
- Saving never submits an application or changes its status (application key
  asserted byte-unchanged after a save).

### Verified vs unverified
- **Verified (unit/jsdom + `react-dom/server`):** all bullets above, including
  snapshot immutability and export-from-snapshot. **Not** verified: a real
  browser (real `chrome.storage.local`, real download click, options-page
  interaction) — the UI is tested only through server-rendered markup and
  mocked storage/download.

### Limitations / known issues
- No in-page preview of a generated or saved resume (none exists in this
  build); opening a version shows labels, date and count-only section counts,
  and export downloads the PDF.
- The documented 200-version cap refuses new saves instead of trimming;
  removing old versions is always a manual, confirmed delete. No history
  export/import or sync — history lives only in this browser.
- History records reference jobs by id; deleting a posting leaves the version
  intact (orphan label), and the service never re-reads job postings for
  integrity. Malformed history requires the explicit "Discard malformed
  history" confirmation to recover (mirrors the application log).
- `ResumeExport` keeps the version generated for the current profile+job in
  component state; switching job (or profile) clears it, so the next save
  generates from the then-current inputs (deterministic, documented).

### Next
- Optional: in-page resume/version preview, history export/import, or wiring
  an application log link from a saved version — all separately scoped.

---

## Done (2026-10-13, task 20 / Prompt 18: AI mapping provider readiness & privacy wording)
Documentation/wording alignment plus a small provider-readiness audit. No
mapping behavior, schema, permission or provider-configuration change.
- **Privacy wording fix** — `docs/autofill-compatibility.md` *Never sent* row now
  reads "Page content beyond the selected eligible fields' normalized labels."
  (replacing "employer content") and lists field values, full page
  text/HTML/DOM, URLs, job description, profile data, saved answers, settings,
  sensitive/legal/compensation data and API keys. `README.md` "What is sent"
  bullet and the `MAPPING_DISCLOSURE` constant + `mapping.ts` header comment were
  aligned so nothing claims that no webpage-derived content is sent (the
  normalized field labels ARE page-derived and may contain website text).
- **Provider readiness audit (unchanged, confirmed):**
  - `MAPPING_PROVIDER` stays `null` — no endpoint, credential or live provider.
  - The popup shows a clear unavailable message when no provider is configured.
  - `requestMappingProposal` short-circuits `ai-disabled` / `provider-unavailable`
    BEFORE building or sending; deterministic autofill continues and fields stay
    manual.
  - AI stays OFF by default (`aiEnabled:false`, zero calls); scanning never calls
    the provider.
  - No API key/secret in code, settings or storage; no direct third-party API,
    no new host/manifest permission, no telemetry, no new service.
  - Failures are typed, single-attempt, fixed-message (no silent provider
    fallback, no page content in errors/logs).
- **Test** — one targeted test added (`mapping.test.ts`): an unavailable provider
  leaves the recognized field filling via the deterministic planner/executor
  while the ambiguous field stays manual. No existing tests duplicated.

### Commands run this task (exit statuses captured inline)
- `npx vitest run` → **exit 0, 579/579 passed** (35 files; 578 baseline + 1 new)
- `npm run compile` → **exit 0**
- `npm run build` → **exit 0**; built manifest unchanged:
  `permissions = ["storage", "activeTab", "scripting"]`, **no** `host_permissions`

### Limitations / not independently verified
- Live provider integration is **not** implemented (explicitly out of scope);
  the AI path remains exercised only by unit tests with a mock/spy provider.
- No real-browser or live-endpoint testing.

### Next
- A separately scoped task may wire a real backend-proxy provider endpoint; until
  then AI mapping stays unavailable and autofill stays fully deterministic.

---

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
