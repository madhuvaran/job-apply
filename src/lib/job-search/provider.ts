/**
 * The job-search provider contract (Prompt 27).
 *
 * A provider is a TRANSPORT: it takes a strictly validated search request and
 * returns either a raw response payload (which the provider's adapter then
 * normalizes) or a typed failure. Providers own nothing else — retries,
 * timeouts, normalization and error presentation belong to the orchestrator.
 *
 * SECURITY POSTURE (the reason this interface exists at all):
 * A job-board API key cannot safely live in a browser extension — the request
 * would put it in the client, where any user can read it out of the network
 * tab or the unpacked bundle. Every Adzuna call therefore goes through a
 * provider that talks to the project's OWN server-side endpoint, which holds
 * the credential (the same "backend-proxy pattern" the AI provider uses). The
 * extension never receives, stores or transmits a provider key, and the
 * provider options schema has NO field for one on purpose.
 *
 * Contract for implementations:
 * - Honor `ctx.signal`: abort in-flight work when it fires (the orchestrator
 *   aborts on timeout).
 * - Map EXPECTED failures to `JobSearchProviderFailure` (status codes, network
 *   errors, non-JSON bodies). Thrown exceptions are treated as unexpected
 *   `provider-fault`s.
 * - Never place credentials, request content or response bodies in a failure.
 * - Never mutate the request.
 */

export interface JobSearchCallContext {
  /** Aborted when the orchestrator's timeout fires. */
  signal: AbortSignal;
  /** Per-attempt timeout in milliseconds that produced this signal. */
  timeoutMs: number;
}

/**
 * Expected, typed provider-level failures.
 *
 * `provider-rejected` is used for a status the provider's own documentation
 * defines as "your request was wrong" (Adzuna: 400 incorrect parameters, 404
 * resource not found); `unauthenticated` for its documented authorisation
 * failure (Adzuna: 410 — see `adzuna/provider.ts`); `server` for 5xx; `http`
 * preserves any other status.
 */
export type JobSearchProviderFailure =
  | { kind: 'provider-rejected'; status: number }
  | { kind: 'unauthenticated'; status: number }
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'network' }
  | { kind: 'server'; status: number }
  | { kind: 'http'; status: number }
  | { kind: 'timeout' }
  /** Body was not parseable JSON. */
  | { kind: 'malformed' };

export type JobSearchProviderOutcome =
  | { kind: 'response'; raw: unknown }
  | { kind: 'failure'; failure: JobSearchProviderFailure };

/**
 * Providers are generic over the request type so the transport stays
 * shape-agnostic (the Adzuna adapter supplies its validated request type).
 * `id` is a stable, non-secret identifier — never a credential.
 */
export interface JobSearchProvider<Request> {
  readonly id: string;
  send(request: Request, ctx: JobSearchCallContext): Promise<JobSearchProviderOutcome>;
}
