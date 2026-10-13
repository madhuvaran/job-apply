/**
 * Typed error model for the AI interface (Prompt 06).
 *
 * EXPECTED failures never throw: `runAiRequest()` always resolves with a
 * discriminated result whose `error` is one of the variants below. Only true
 * programmer bugs (invalid option objects handed to constructors) may throw.
 *
 * Messages are deliberately fixed literals or field-path-only issue strings —
 * no request content, no provider payloads, no credentials are ever embedded
 * (same non-PII rule as the storage service).
 */

export type AiError =
  /** The outgoing request failed strict zod validation (issues = path + message). */
  | { kind: 'invalid-request'; issues: string[] }
  /** The provider's response failed strict zod validation (or was not JSON). */
  | { kind: 'invalid-response'; issues: string[] }
  /** A single attempt exceeded the request timeout; the attempt was aborted. */
  | { kind: 'timeout' }
  /** Provider signalled rate limiting (HTTP 429 / equivalent) and retries ran out. */
  | { kind: 'rate-limited'; retryAfterMs?: number }
  /** Non-2xx HTTP status from the backend proxy (retryable statuses are retried first). */
  | { kind: 'http'; status: number }
  /** Network-level failure: connection refused, DNS, CORS rejection. */
  | { kind: 'network' }
  /** The provider threw an unexpected exception (name only — never the message). */
  | { kind: 'provider-fault'; errorName: string };

export type AiErrorKind = AiError['kind'];

/** All error kinds, for exhaustiveness tests and UI copy tables. */
export const AI_ERROR_KINDS = [
  'invalid-request',
  'invalid-response',
  'timeout',
  'rate-limited',
  'http',
  'network',
  'provider-fault',
] as const satisfies readonly AiErrorKind[];
