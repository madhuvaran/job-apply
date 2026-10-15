/**
 * Adzuna job discovery (Prompt 27) — feasibility-verified foundation.
 *
 * Verified against Adzuna's official documentation on 2026-10-14; see
 * `docs/adzuna-integration.md` for the sources and for what is still
 * account-level uncertain.
 *
 * What this module is:
 * - a strict, bounded request schema over the DOCUMENTED Adzuna search
 *   parameters (`schemas.ts`);
 * - a pure normalizer from Adzuna's payload into the normalized result shape
 *   used by the rest of the app (`normalize.ts`);
 * - a transport that sends requests ONLY to the project's own https search
 *   proxy, which holds the `app_id`/`app_key` (`provider.ts`);
 * - the adapter that wires both into `runJobSearch()` (`adapter.ts`).
 *
 * What it deliberately is NOT: no UI, no saved searches, no alerts, no polling,
 * no direct api.adzuna.com call, no credential anywhere in the extension, and
 * no placeholder key that could be mistaken for a working one.
 *
 * India: `in` is in Adzuna's documented country enum for the search endpoint
 * (`ADZUNA_COUNTRY_CODES`, `ADZUNA_INDIA_SUPPORTED`), so India search is
 * supported *by the API contract*; whether a given developer account's tier
 * covers the volume you need is an account-level question (see the doc).
 */
export * from './schemas';
export * from './normalize';
export * from './provider';
export * from './adapter';
