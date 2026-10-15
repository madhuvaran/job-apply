/**
 * Job-search orchestration and the configuration boundary (Prompt 27).
 *
 * `runJobSearch()` is the ONE entry point a future search UI calls. It owns:
 *
 * 1. CONFIG GATE — the provider is never touched when search is disabled or
 *    has no secure endpoint configured. That path returns an explicit
 *    `not-configured` outcome, NEVER an empty successful result and never a
 *    network request, so the extension can never appear to have working live
 *    search when it does not.
 * 2. REQUEST VALIDATION — the outgoing request is strictly validated by the
 *    provider's adapter before anything leaves the process; invalid input
 *    returns a typed `invalid-request` with field paths and no provider call.
 * 3. ONE CALL, WITH TIMEOUT — a single attempt, aborted on timeout. Retries,
 *    backoff and caching are deliberately NOT implemented here (Prompt 28).
 * 4. NORMALIZATION — the adapter turns the raw payload into the strictly
 *    validated normalized page, or reports `invalid-response`. A failed
 *    request is never turned into an empty page of results.
 *
 * NO CREDENTIALS ANYWHERE: `jobSearchConfigSchema` is `.strict()` and has no
 * credential field, so an attempt to store an `appId`/`appKey`/`apiKey`/token
 * fails validation. Credentials live on the server-side proxy only (see
 * `provider.ts` and docs/adzuna-integration.md).
 *
 * Never throws for expected failures — every outcome is a discriminated result.
 */
import { z } from 'zod';
import type { JobSearchError } from './errors';
import { messageForSearchError } from './errors';
import type {
  JobSearchProvider,
  JobSearchProviderFailure,
  JobSearchProviderOutcome,
} from './provider';
import {
  formatSearchIssues,
  type NormalizedSearchResults,
  type SearchValidation,
} from './schemas';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Per-attempt timeout for one search request. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

/**
 * The extension-side search configuration.
 *
 * There is deliberately NO credential field. `endpoint` is the project's OWN
 * server-side search proxy; that server holds the job-board app id and key.
 * Strict parsing means any extra key — including a well-meant `appKey` — is
 * rejected rather than silently carried into a request.
 */
export const jobSearchConfigSchema = z
  .object({
    /**
     * Master switch. FALSE by default: until the user enables search AND a
     * secure endpoint exists, nothing is ever requested.
     */
    enabled: z.boolean().default(false),
    /**
     * Absolute HTTPS URL of the extension's own search proxy. HTTPS is
     * REQUIRED (stricter than the AI proxy, which also allows http for local
     * development): this endpoint is the thing that holds a job-board key, so
     * a plaintext transport must not be configurable.
     */
    endpoint: z
      .url()
      .max(2048)
      .refine((u) => /^https:\/\//i.test(u), {
        message: 'the search proxy endpoint must use https://',
      })
      .optional(),
  })
  .strict();
export type JobSearchConfig = z.infer<typeof jobSearchConfigSchema>;

/** Parse untrusted configuration into the strict config shape. */
export function parseJobSearchConfig(payload: unknown): SearchValidation<JobSearchConfig> {
  const parsed = jobSearchConfigSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: formatSearchIssues(parsed.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Availability (the honesty gate)                                     */
/* ------------------------------------------------------------------ */

export type JobSearchUnavailableReason = 'disabled' | 'not-configured' | 'invalid';

export type JobSearchAvailability =
  | { available: true; endpoint: string }
  | { available: false; reason: JobSearchUnavailableReason; message: string };

/** Fixed copy: never implies results exist when nothing can be searched. */
export const JOB_SEARCH_UNAVAILABLE_MESSAGES: Readonly<Record<JobSearchUnavailableReason, string>> = {
  disabled: 'Job search is turned off in settings, so no search was performed.',
  'not-configured':
    'Job search needs a configured secure search endpoint before it can run. Live job search is not available in this build.',
  invalid: 'The job search settings are invalid, so no search was performed.',
};

/**
 * Whether a search can run at all — the state a future UI must render instead
 * of a fake live search. Read-only, offline, side-effect free.
 */
export function describeJobSearchAvailability(config: unknown): JobSearchAvailability {
  const parsed = parseJobSearchConfig(config);
  if (!parsed.ok) {
    return {
      available: false,
      reason: 'invalid',
      message: JOB_SEARCH_UNAVAILABLE_MESSAGES.invalid,
    };
  }
  if (!parsed.value.enabled) {
    return {
      available: false,
      reason: 'disabled',
      message: JOB_SEARCH_UNAVAILABLE_MESSAGES.disabled,
    };
  }
  if (parsed.value.endpoint === undefined) {
    return {
      available: false,
      reason: 'not-configured',
      message: JOB_SEARCH_UNAVAILABLE_MESSAGES['not-configured'],
    };
  }
  return { available: true, endpoint: parsed.value.endpoint };
}

/* ------------------------------------------------------------------ */
/* Provider adapter                                                    */
/* ------------------------------------------------------------------ */

/**
 * The provider-specific half: strict request validation and raw→normalized
 * interpretation. Injected so the orchestrator stays provider-agnostic and is
 * fully testable with a deterministic fake adapter and a mock provider.
 */
export interface JobSearchAdapter<Request> {
  /**
   * Stable identifier of the provider this adapter normalizes. Wiring code
   * pairs it with a provider of the same `id` (asserted by tests); the
   * orchestrator treats it as metadata and does not branch on it.
   */
  readonly providerId: string;
  /** Strictly validate an untrusted request (issues = path + message). */
  validateRequest(payload: unknown): SearchValidation<Request>;
  /** Turn a RAW provider payload into a validated normalized page. */
  interpret(
    raw: unknown,
    context: { request: Request },
  ): SearchValidation<NormalizedSearchResults>;
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export type JobSearchRunResult =
  /** A validated, normalized page of results (possibly empty). */
  | { kind: 'ok'; results: NormalizedSearchResults; attempts: number }
  /** Typed, non-throwing failure. `attempts` = attempts actually made (0 = never called). */
  | { kind: 'error'; error: JobSearchError; attempts: number };

export interface JobSearchRunInput<Request> {
  /** Untrusted configuration (validated here). */
  config: unknown;
  /** Untrusted search request (validated by the adapter). */
  request: unknown;
  /** The transport. Never called when search is unavailable. */
  provider: JobSearchProvider<Request>;
  /** The provider's validation/normalization adapter. */
  adapter: JobSearchAdapter<Request>;
  /** Per-attempt timeout in ms (clamped to >= 1). Default 15 000. */
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* Failure mapping                                                     */
/* ------------------------------------------------------------------ */

/**
 * Provider-level failure → typed job-search error. Exhaustive: adding a
 * provider failure kind without teaching this mapper about it is a type error.
 * Statuses are preserved (numbers are safe); no body or header text is carried.
 */
export function mapProviderFailure(failure: JobSearchProviderFailure): JobSearchError {
  switch (failure.kind) {
    case 'provider-rejected':
      return { kind: 'provider-rejected', status: failure.status };
    case 'unauthenticated':
      return { kind: 'unauthenticated', status: failure.status };
    case 'rate-limited':
      return {
        kind: 'rate-limited',
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      };
    case 'server':
      return { kind: 'server', status: failure.status };
    case 'http':
      return { kind: 'http', status: failure.status };
    case 'timeout':
      return { kind: 'timeout' };
    case 'network':
      return { kind: 'network' };
    case 'malformed':
      // Not JSON at all — reported as unreadable data, never as "no results".
      return {
        kind: 'invalid-response',
        issues: ['(root): response body was not valid JSON'],
      };
  }
}

/**
 * One attempt's settlement: the typed provider outcome, the unexpected
 * exception it threw, or the orchestrator's own timeout. Written as an explicit
 * discriminated union so the three cases narrow cleanly.
 */
type AttemptOutcome =
  | { timedOut: true }
  | { timedOut: false; outcome: JobSearchProviderOutcome }
  | { timedOut: false; error: unknown };

function isAbortLike(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Run one job search. Never throws for expected failures.
 *
 * Order of operations (deliberate):
 * 1. Validate the configuration; invalid → typed error, provider untouched.
 * 2. Availability gate — disabled / no endpoint → `not-configured` with FIXED
 *    copy, provider untouched (zero network requests).
 * 3. Validate the request through the adapter; invalid → typed error, no call.
 * 4. One provider call with a per-attempt timeout.
 * 5. Response → adapter.interpret() → validated normalized page, or
 *    `invalid-response`. A failure NEVER becomes an empty result page.
 */
export async function runJobSearch<Request>(
  input: JobSearchRunInput<Request>,
): Promise<JobSearchRunResult> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS));

  const parsedConfig = parseJobSearchConfig(input.config);
  if (!parsedConfig.ok) {
    return {
      kind: 'error',
      error: {
        kind: 'invalid-request',
        issues: parsedConfig.issues.map((issue) => `config.${issue}`),
      },
      attempts: 0,
    };
  }

  const availability = describeJobSearchAvailability(parsedConfig.value);
  if (!availability.available) {
    return {
      kind: 'error',
      error: {
        kind: 'not-configured',
        reason: availability.reason,
        message: availability.message,
      },
      attempts: 0,
    };
  }

  const parsedRequest = input.adapter.validateRequest(input.request);
  if (!parsedRequest.ok) {
    return {
      kind: 'error',
      error: { kind: 'invalid-request', issues: parsedRequest.issues },
      attempts: 0,
    };
  }
  const request = parsedRequest.value;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<AttemptOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  // Expected failures come back typed; a THROWN exception is an unexpected
  // provider fault (error NAME only — never the message, which may quote data).
  let started: Promise<JobSearchProviderOutcome>;
  try {
    started = Promise.resolve(input.provider.send(request, { signal: controller.signal, timeoutMs }));
  } catch (err) {
    started = Promise.reject(err);
  }

  const raced: Promise<AttemptOutcome> = started.then(
    (outcome): AttemptOutcome => ({ timedOut: false, outcome }),
    (err: unknown): AttemptOutcome => ({ timedOut: false, error: err }),
  );

  let settled: AttemptOutcome;
  try {
    settled = await Promise.race([raced, timeoutOutcome]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (settled.timedOut) {
    return { kind: 'error', error: { kind: 'timeout' }, attempts: 1 };
  }

  if ('error' in settled) {
    if (isAbortLike(settled.error, controller.signal)) {
      return { kind: 'error', error: { kind: 'timeout' }, attempts: 1 };
    }
    return {
      kind: 'error',
      error: {
        kind: 'provider-fault',
        errorName: settled.error instanceof Error ? settled.error.name : 'Unknown',
      },
      attempts: 1,
    };
  }

  const outcome = settled.outcome;
  if (outcome.kind === 'failure') {
    return { kind: 'error', error: mapProviderFailure(outcome.failure), attempts: 1 };
  }

  const interpreted = input.adapter.interpret(outcome.raw, { request });
  if (interpreted.ok) {
    return { kind: 'ok', results: interpreted.value, attempts: 1 };
  }
  return {
    kind: 'error',
    error: { kind: 'invalid-response', issues: interpreted.issues },
    attempts: 1,
  };
}

export { messageForSearchError };
