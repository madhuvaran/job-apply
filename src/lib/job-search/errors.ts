/**
 * Typed error model for job discovery (Prompt 27).
 *
 * EXPECTED failures never throw: `runJobSearch()` always resolves with a
 * discriminated result whose `error` is one of the variants below. Only true
 * wiring bugs (invalid provider options at construction) may throw, exactly as
 * the AI provider does.
 *
 * Messages are fixed literals or field-path-only issue strings. No provider
 * payload, no response body, no header value, no credential and no request
 * content is ever embedded — the same non-PII rule the storage service and the
 * AI error model follow. `status` is a number from the transport (safe), and
 * `errorName` is an exception CLASS NAME only, never its message (a thrown
 * message may quote an endpoint or a payload).
 */

export type JobSearchError =
  /** OUR strict validation rejected the outgoing request (issues = path + message). */
  | { kind: 'invalid-request'; issues: string[] }
  /** Our request was valid but the provider refused it (HTTP 400/404 as documented). */
  | { kind: 'provider-rejected'; status: number }
  /** The provider rejected our credentials or the caller is not authorised (401/403/410). */
  | { kind: 'unauthenticated'; status: number }
  /** The provider is rate limiting us (HTTP 429). */
  | { kind: 'rate-limited'; retryAfterMs?: number }
  /** Network-level failure: connection refused, DNS, CORS rejection. */
  | { kind: 'network' }
  /** The provider failed on its side (HTTP 5xx). */
  | { kind: 'server'; status: number }
  /** Any other non-2xx status, preserved for diagnosis. */
  | { kind: 'http'; status: number }
  /** The response was not JSON, or did not match the provider's expected shape. */
  | { kind: 'invalid-response'; issues: string[] }
  /** No search provider is configured/enabled — NOT an empty result. */
  | { kind: 'not-configured'; reason: 'disabled' | 'not-configured' | 'invalid'; message: string }
  /** A single attempt exceeded the request timeout; the attempt was aborted. */
  | { kind: 'timeout' }
  /** The provider threw an unexpected exception (name only — never the message). */
  | { kind: 'provider-fault'; errorName: string };

export type JobSearchErrorKind = JobSearchError['kind'];

/** All error kinds, for exhaustiveness tests and UI copy tables. */
export const JOB_SEARCH_ERROR_KINDS = [
  'invalid-request',
  'provider-rejected',
  'unauthenticated',
  'rate-limited',
  'network',
  'server',
  'http',
  'invalid-response',
  'not-configured',
  'timeout',
  'provider-fault',
] as const satisfies readonly JobSearchErrorKind[];

/**
 * Fixed, privacy-safe user-facing message per error kind. Nothing provider- or
 * user-supplied is interpolated; `status` is appended by the UI layer if it
 * wants to show it, never by this table.
 */
export const JOB_SEARCH_ERROR_MESSAGES: Readonly<Record<JobSearchErrorKind, string>> = {
  'invalid-request': 'The search request was invalid, so no search was performed.',
  'provider-rejected':
    'The job search service refused this search. Check the country and search terms and try again.',
  unauthenticated:
    'The job search service rejected its credentials. Job search is unavailable until the search service is configured correctly.',
  'rate-limited':
    'The job search service is rate limiting requests. Please wait before searching again.',
  network: 'The job search service could not be reached. Check your connection and try again.',
  server: 'The job search service is temporarily unavailable. Please try again later.',
  http: 'The job search service returned an unexpected response.',
  'invalid-response':
    'The job search service returned data this app could not read. No results were shown.',
  'not-configured': 'Job search is not configured, so no search was performed.',
  timeout: 'The job search request took too long and was cancelled.',
  'provider-fault': 'The job search service failed unexpectedly.',
};

/** The fixed message for a typed error (never provider content). */
export function messageForSearchError(error: JobSearchError): string {
  return JOB_SEARCH_ERROR_MESSAGES[error.kind];
}
