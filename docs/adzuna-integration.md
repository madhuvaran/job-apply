# Adzuna job search integration — feasibility and boundary (Prompt 27)

**Verification date: 2026-10-14 (re-checked 2026-10-15).**
Every API fact below was read first-hand from Adzuna's own documentation and
specification at the URLs listed under *Sources*. Anything that could **not** be
confirmed from an official source is marked **UNVERIFIED** and is not relied on
by the code. Nothing here is legal advice — the Terms of Service are Adzuna's and
should be re-read by whoever operates the deployment.

> **Status: the provider ships UNCONFIGURED and performs zero network requests.**
> There is no live job search in this build, and none of this code calls Adzuna.
> See *Integration boundary* and *What is implemented now* below.

## 1. Sources (read 2026-10-14, re-checked 2026-10-15)

| # | Source | What it establishes |
|---|--------|---------------------|
| S1 | <https://developer.adzuna.com/overview> | Registration, the `app_id`/`app_key` requirement, an example UK request |
| S2 | <https://developer.adzuna.com/swagger/spec/test2.json> | The OpenAPI spec: server URL, paths, parameters, countries, status codes, job fields |
| S3 | <https://developer.adzuna.com/docs/search> | The search guide (registration prompt, snippet wording) |
| S4 | <https://developer.adzuna.com/docs/terms_of_service> | Access limits, attribution requirement, permitted uses |
| S5 | <https://api.adzuna.com/v1/doc/Adzuna::API::Response::Job> | Per-field description of the job object |
| S6 | <https://api.adzuna.com/v1/doc/Adzuna::API::Response::Ad> | `created` semantics, `description` truncation, `redirect_url` compliance note |

## 2. Access and registration

- **VERIFIED**: you register a developer account and receive an **`app_id`** and
  **`app_key`** (S1: "Register to receive an app_key and app_id"; S3 prompts for
  registration). Both are described by the spec as "supplied by Adzuna" (S2).
- **UNVERIFIED**: whether API access is available **free of charge**. The
  reviewed sources document registration and default limits but do not state that
  access is free, and the Terms of Service describe a **14-day trial** for some
  organisational uses (S4). Treat "free tier" as **unconfirmed until an account
  is configured and its quota/plan page is read**.
- **Account-level uncertainty** (cannot be answered from public docs alone):
  - the plan/volume a given key is entitled to;
  - whether India (`in`) results are of the density/quality needed for a
    personal job hunt (the endpoint *supports* it — see §5 — but coverage is an
    account/data question);
  - whether any paid tier is required for sustained use.

## 3. Endpoint and server

- **VERIFIED**: base server `https://api.adzuna.com/v1/api` (S2 `servers`), and
  the search operation is
  **`GET /jobs/{country}/search/{page}`** (S2, S1 — S1 shows
  `https://api.adzuna.com/v1/api/jobs/gb/search/1`).
- `country` and `page` are **path** parameters; everything else is a query
  parameter (S2).

## 4. Authentication

- **VERIFIED**: the operation's two authentication parameters are **`app_id`**
  and **`app_key`**, and the spec declares them **required query parameters**
  (S2). They are not documented as headers for this operation.
- **Consequence for a browser extension**: any credential the extension sends is
  present in the client — visible in DevTools and extractable from the unpacked
  bundle — and would spend the extension author's quota on every user's machine.
  See §9 for the boundary chosen in response.

## 5. Search parameters

Documented by S2 unless noted.

| Parameter | Documented meaning | Bounds |
|-----------|--------------------|--------|
| `what` | Keywords to search for; multiple terms space-separated | — |
| `where` | Geographic centre of the search (place names, postal codes) | — |
| `distance` | Radius in km from `where` | "Defaults to 5km" |
| `max_days_old` | Age of the oldest advertisement returned, in days | no default documented |
| `sort_by` | Ordering | one of `default`, `hybrid`, `date`, `salary`, `relevance` |
| `results_per_page` | Results per page | spec minimum **1**; **no maximum** documented; no default documented |
| `page` (path) | Page number | integer ≥ 1 (spec minimum); no maximum documented |

Also documented but **not implemented** in this foundation (deferred):
`title_only`, `company`, `category`, `salary_min`, `salary_max`,
`salary_include_unknown`, `full_time`, `part_time`, `contract`, `permanent`,
`what_and`, `what_phrase`, `what_or`, `what_exclude`, `sort_dir`,
`location0`…`location7`.

> The spec documents **no maximum** for `results_per_page` and **no default**.
> The caps in this extension (50 results per page, 100 pages, keyword/location
> lengths) are **our own policy bounds** for bandwidth, quota and render sanity —
> they are not Adzuna limits, and the code comments say so.

## 6. Country codes and India

- **VERIFIED** (S2): the `country` enum is exactly
  `gb, us, at, au, be, br, ca, ch, de, es, fr, in, it, mx, nl, nz, pl, sg, za`
  — the spec describes it as an "ISO 8601 country code of the country of
  interest".
- **India (`in`) is in the documented enum**, so India job search is supported
  **by the API contract**. The code encodes the enum verbatim
  (`ADZUNA_COUNTRY_CODES`) and exports `ADZUNA_INDIA_SUPPORTED`.
- **UNVERIFIED / account-level**: result quality and volume for India, and
  whether an individual key's plan restricts which countries it may query.

## 7. Response shape returned by search

**Required per job** (S2 `Job.required`): `id`, `title`, `description`, `created`.

**Documented but optional** (S2): `redirect_url`, `company`, `location`,
`category`, `salary_min`, `salary_max`, `salary_is_predicted`, `contract_time`,
`contract_type`, `adref`, `latitude`, `longitude`.

Details used by the normalizer:

- `created` — "the date the advertisement was placed, as an ISO 8601 date time
  string" (S2, S6). S6 adds that if the source has no creation date, Adzuna uses
  when it first saw the ad. We take the **calendar date exactly as written** and
  never shift it by time zone.
- `description` — "the details of the advertisement, **truncated to 500
  characters**" (S2, S6); S3 calls it a snippet. The normalizer caps the snippet
  at 500 characters.
- `redirect_url` — the spec says to use it to send users to the advertiser "to
  comply with Adzuna's terms and conditions" (S2, S6). **A record without a
  usable http(s) `redirect_url` is skipped** rather than displayed without a link.
- `salary_min`/`salary_max` — amounts "given in the **local currency**" of the
  country searched; the API does not state which currency, so the normalized
  result carries **no currency field** (we must not guess one).
- `salary_is_predicted` — marks a **Jobsworth** estimate (`1`) rather than an
  advertised figure (`0`). Normalized to `predicted: true/false`, or `null` when
  the provider does not state it.
- `company` — we use `display_name` (the advertiser's own form), not
  `canonical_name`.
- `location` — `display_name`, falling back to `area` (documented outermost →
  innermost) joined readably.
- Top level: `results` (array) and `count` (total adverts found) (S2). `mean`,
  `__CLASS__` and the like are **dropped** and never reach a result.

## 8. Rate limits and status codes

- **VERIFIED** (S4, Terms of Service — "Default API access limits / We may vary
  these from time to time"): **25 hits per minute**, **250 hits per day**,
  **1000 hits per week**, **2500 hits per month**. Adzuna may raise limits for
  listings publishers at its discretion.
- **VERIFIED** documented response codes for the search operation (S2):
  `200` success, **`400` "Incorrect parameters"**, **`404` "Resource could not be
  found"**, **`410` "Authorisation failed"**, **`500` "Internal server error"**.
- **UNVERIFIED**: the status returned when a limit is exceeded. The spec does not
  list `429` for this operation, so the transport maps `429` and `401`/`403` as
  **defensive, conventional** interpretations (rate limited / unauthenticated)
  rather than documented guarantees. What Adzuna actually returns on overage
  must be confirmed against a live key.

## 9. Attribution, linking, caching, redistribution

- **VERIFIED attribution** (S4, Terms of Service): *"An API user shall label each
  displayed advert with the phrase 'Adzuna' at least 116 X 23 pixels in size,
  wherein the word 'Adzuna' shall be hyperlinked to http://www.adzuna.co.uk or
  the relevant local domain."* This is encoded as `ADZUNA_ATTRIBUTION` and is
  carried **inside every normalized result page**, so a future UI cannot render
  listings without the required credit and link to hand.
- **VERIFIED linking** (S2, S6): the advert must link out through `redirect_url`.
- **Permitted uses stated in S4**: "Publishing Adzuna ad listings", "Publishing
  Jobsworth salary estimates", and "Personal research". For use by commercial,
  government or academic organisations, S4 describes a **14-day trial** and says
  the material "may not be used in its original format or in aggregation" for
  ongoing work without written consent; a licence may be required afterwards.
- **UNVERIFIED**: any specific **caching** duration or policy — S4 as reviewed
  states none. **Do not add a cache until a documented rule is found.**
- **UNVERIFIED**: a blanket "no redistribution" rule stated in those words; the
  specific restriction found is the organisational-use wording above.

## 10. Credential exposure and the integration boundary

**Risk.** Adzuna authenticates with query parameters, so a key placed in the
browser is a public secret. Bundling it would (a) expose it to every user and
(b) spend the extension author's quota on every install.

**Boundary chosen (no backend required to ship safely).**

```
extension (runJobSearch) ──GET (no credential)──> YOUR https search proxy ──> api.adzuna.com
   strict zod request + response      holds app_id/app_key, attaches them,
   no key, no key field anywhere      returns Adzuna-shaped JSON
```

- The extension talks **only** to a project-owned **`https://`** endpoint
  (`adzunaProviderOptionsSchema`, `jobSearchConfigSchema`); `http://` is rejected.
- Both the provider options schema and the search config schema are **`.strict()`
  with no credential field**, so `appId`/`appKey`/`apiKey`/`token` fail validation
  by construction. `buildAdzunaSearchQuery()` can never emit `app_id`/`app_key`.
- The provider builds the vendor path/query from a **validated** country enum and
  integer page, so no user input is interpolated raw.
- Nothing runs at startup; **no background polling**, no new manifest permission
  and no host permission were added. No Adzuna request is issued until a user
  enables search *and* provides an endpoint.
- No third-party proxy or unofficial wrapper is used.
- Only the search terms and location go to Adzuna — **no profile, resume,
  contact, legal/EEO or compensation data** (the request schema is strict and has
  no such field).

**This build stops at the boundary.** Because no backend is deployed and no key
is configured, the provider is **unconfigured by design** and the extension shows
an explicit "not available" state rather than a fake live search.

## 11. What is implemented now

`src/lib/job-search/` (provider-agnostic) and `src/lib/job-search/adzuna/`:

- **Strict request schema** (`adzuna/schemas.ts`) over the documented parameters,
  with the verified country enum, documented `sort_by` values, and **our own**
  upper bounds. Typed `invalid-request` with field paths; no value echoed.
- **Strict response normalization** (`adzuna/normalize.ts` → `../schemas.ts`):
  a bounded `NormalizedJobResult` (provider, external id, title, company,
  location, posting date, listing URL, snippet, salary range, country) plus a
  `NormalizedSearchResults` page carrying `skipped`/`skippedReasons` and the
  mandatory `attribution`. Optional means **absent**, never invented; unusable
  records are counted, never silently dropped; an unreadable envelope is an
  **error**, never an empty page.
- **Provider contract** (`provider.ts`) and an **Adzuna transport**
  (`adzuna/provider.ts`) that talks only to the project proxy, with typed
  failures (invalid request, provider-rejected, unauthenticated, rate-limited,
  network, server, http, invalid-response, not-configured, timeout,
  provider-fault) and no credential, body or header text in any error.
- **Orchestration + honesty gate** (`service.ts`): `runJobSearch()` validates the
  config, refuses to run when search is disabled or unconfigured (**zero network
  requests**), validates the request, makes **one** attempt with a timeout, and
  normalizes — a failure is never converted into empty results.
- **Tests** (mocked transport; no live call): request validity and bounds,
  response normalization including optional/missing fields and malformed
  rejection, status→error mapping, timeout/network handling, the unavailable
  state, credential-hygiene source scan.

## 12. Deliberately deferred (later prompts)

Job-search UI, saved searches, alerts, automatic polling, retries/backoff,
caching, salary/contract filters, and any live request. **No backend, deployment
or paid service was created.**

## 13. Remaining limitations

- **No live search exists** and none can until a secure `https` proxy holding the
  Adzuna credentials is deployed and configured. The provider is unconfigured.
- Whether Adzuna returns `429` (vs some other code/behaviour) on overage is
  **unverified**; the mapping is defensive.
- The transport trusts the proxy to **forward upstream status codes**. A proxy
  that always answers `200` with an error body is a contract violation this code
  cannot detect.
- Result currency is unknown (amounts are local currency and unlabelled).
- Coverage/quality for India and any plan restrictions are account-level
  questions.
- No caching, per the missing caching policy (§9).

## 14. Exact next step (Prompt 28)

Deploy the **server-side search proxy** that holds `app_id`/`app_key`, attach
that endpoint in settings, and confirm the real overage status code and India
result quality against a configured developer account — then build the search UI
on the normalized page this foundation already produces.
