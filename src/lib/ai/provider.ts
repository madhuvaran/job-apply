/**
 * The provider interface (Prompt 06; generalized Prompt 17).
 *
 * A provider is a TRANSPORT: it takes a validated `AiRequest` and returns
 * either a raw response object (validated by the orchestrator against
 * `aiResponseSchema`) or a typed failure. Providers never need to know about
 * retries or timeouts — `runAiRequest()` owns those — and they never receive
 * credentials in this extension: authentication lives on the backend proxy
 * (see README: backend-proxy pattern).
 *
 * Contract for implementations:
 * - Honor `ctx.signal`: abort in-flight work when it fires (the orchestrator
 *   aborts on timeout).
 * - Map EXPECTED failures to `AiProviderFailure` (rate limits, HTTP status,
 *   network errors). Thrown exceptions are treated as unexpected
 *   `provider-fault`s and are not retried.
 * - Do not mutate the request.
 */
import type { AiRequest } from './schemas';

/**
 * Providers are generic over the request type (default `AiRequest`, the
 * resume/answer contract). The transport is shape-agnostic — it just serializes
 * the request as JSON to the backend proxy — so the semantic field-mapping
 * layer (Prompt 17) reuses it with its own minimal request type.
 */

export interface AiProviderCallContext {
  /** Aborted when the orchestrator's per-attempt timeout fires. */
  signal: AbortSignal;
  /** 1-based attempt number (for logs/metrics — no payload content). */
  attempt: number;
  /** Per-attempt timeout in milliseconds that produced this signal. */
  timeoutMs: number;
}

/**
 * Expected, typed provider-level failures. `retryable` for HTTP statuses is
 * decided by the provider (5xx/429 yes, other 4xx no) and drives the
 * orchestrator's retry loop.
 */
export type AiProviderFailure =
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'http'; status: number; retryable: boolean }
  /** Response body was not parseable JSON (mapped to `invalid-response`). */
  | { kind: 'malformed' };

export type AiProviderOutcome =
  | { kind: 'response'; raw: unknown }
  | { kind: 'failure'; failure: AiProviderFailure };

export interface AiProvider<Request = AiRequest> {
  /** Stable, non-secret identifier (e.g. 'proxy', 'mock'). Never a credential. */
  readonly id: string;
  send(request: Request, ctx: AiProviderCallContext): Promise<AiProviderOutcome>;
}
