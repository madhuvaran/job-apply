/**
 * AI request orchestration (Prompt 06): the single entry point callers use.
 *
 * Guarantees:
 * - NEVER THROWS for expected failures — every outcome is a typed
 *   discriminated result (`ok` / `fallback` / `error`).
 * - REQUEST SAFETY CHOKEPOINT — `buildAiRequest()` is the only constructor of
 *   outgoing payloads and it projects settings through `settingsForProvider()`
 *   (strips `salary`), embeds only the AI-safe profile, and validates the
 *   whole thing against the strict `aiRequestSchema`. The sensitive profile,
 *   contact details and compensation are structurally unable to appear.
 * - NO-AI FALLBACK — when `settings.aiEnabled` is false (the default), the
 *   provider is NEVER invoked: zero network requests, deterministic local
 *   response built from the candidate's own stored content.
 * - TIMEOUTS — each attempt races a per-attempt timer; on expiry the attempt's
 *   `AbortSignal` is aborted and the attempt is typed as `timeout`.
 * - RATE LIMIT / RETRY — 429-style failures (and transient network/timeout/
 *   5xx failures) are retried up to `maxAttempts` with exponential backoff,
 *   honoring `Retry-After` when the provider supplies it. Non-retryable
 *   failures (other 4xx, invalid response, provider faults) return at once.
 */
import type { Profile } from '../profile';
import { settingsForProvider, type Settings } from '../settings';
import type { AiError } from './errors';
import { localFallbackResponse } from './fallback';
import type { AiProvider, AiProviderFailure, AiProviderOutcome } from './provider';
import {
  AI_SCHEMA_VERSION,
  aiRequestSchema,
  formatZodIssues,
  validateAiResponse,
  type AiJobInput,
  type AiRequest,
  type AiResponse,
  type AiTask,
} from './schemas';

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_RETRY_DELAY_MS = 250;
/** Cap for provider-supplied `Retry-After` values. */
export const MAX_RETRY_AFTER_MS = 120_000;
/** Cap for computed exponential backoff (no jitter). */
export const MAX_BACKOFF_MS = 30_000;

export interface AiRunOptions {
  /** Per-attempt timeout in ms (clamped to >= 1). Default 15 000. */
  timeoutMs?: number;
  /** Total attempts including the first (clamped to >= 1). Default 3. */
  maxAttempts?: number;
  /** First backoff delay in ms; doubles each retry. Default 250. */
  baseRetryDelayMs?: number;
  /**
   * Injectable delay so tests can assert backoff without waiting. Default is
   * a real `setTimeout` promise.
   */
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseRetryDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function resolveOptions(options: AiRunOptions): ResolvedOptions {
  return {
    timeoutMs: Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    maxAttempts: Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
    baseRetryDelayMs: Math.max(
      0,
      Math.floor(options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS),
    ),
    sleep: options.sleep ?? realSleep,
  };
}

/* ------------------------------------------------------------------ */
/* Request construction (the safety chokepoint)                        */
/* ------------------------------------------------------------------ */

export interface AiRequestInput {
  task: AiTask;
  job: AiJobInput;
  /** The AI-safe professional profile ONLY (never the sensitive record). */
  profile: Profile;
  /** Full local settings; `salary` is stripped here before anything is sent. */
  settings: Settings;
}

export type AiBuildResult =
  | { kind: 'ok'; request: AiRequest }
  | { kind: 'invalid'; issues: string[] };

/**
 * Build and strictly validate an outgoing request. Settings go through
 * `settingsForProvider()` — the single place compensation is removed — and
 * the result must pass `aiRequestSchema` (`.strict()`, no `salary` key) or it
 * comes back as a typed `invalid` result instead of ever being sent.
 */
export function buildAiRequest(input: AiRequestInput): AiBuildResult {
  const candidate = {
    schemaVersion: AI_SCHEMA_VERSION,
    task: input.task,
    job: input.job,
    profile: input.profile,
    // THE chokepoint: strips salary and anything else not provider-safe.
    settings: settingsForProvider(input.settings),
  };
  const parsed = aiRequestSchema.safeParse(candidate);
  if (parsed.success) return { kind: 'ok', request: parsed.data };
  return { kind: 'invalid', issues: formatZodIssues(parsed.error.issues) };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export type AiRunResult =
  /** Validated response from the provider (attempts includes the successful one). */
  | { kind: 'ok'; response: AiResponse; attempts: number }
  /** `aiEnabled` was false: local deterministic content, zero network requests. */
  | { kind: 'fallback'; reason: 'ai-disabled'; response: AiResponse }
  /** Typed, non-throwing failure. `attempts` = attempts actually made (0 = never called). */
  | { kind: 'error'; error: AiError; attempts: number };

/* ------------------------------------------------------------------ */
/* Per-attempt call with timeout                                       */
/* ------------------------------------------------------------------ */

export interface ProviderAttemptResult {
  outcome: AiProviderOutcome;
  /** Set when the provider THREW (unexpected fault): name only, never a message. */
  fault?: { errorName: string };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * One provider call with a per-attempt timeout. Exported (Prompt 17) so the
 * semantic field-mapping runner reuses the exact same timeout/abort/fault
 * behavior instead of duplicating it. Generic over the request type.
 */
export async function callProviderOnce<Request = AiRequest>(
  provider: AiProvider<Request>,
  request: Request,
  attempt: number,
  timeoutMs: number,
): Promise<ProviderAttemptResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutOutcome = new Promise<AiProviderOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'failure', failure: { kind: 'timeout' } });
    }, timeoutMs);
  });

  // Expected failures come back as typed outcomes; a THROWN exception is an
  // unexpected fault (we keep the error name but never its message). The
  // try/catch also covers providers that throw SYNCHRONOUSLY.
  let started: Promise<AiProviderOutcome>;
  try {
    started = Promise.resolve(provider.send(request, { signal: controller.signal, attempt, timeoutMs }));
  } catch (err) {
    started = Promise.reject(err);
  }
  const attemptPromise = started
    .then(
      (outcome): ProviderAttemptResult => ({ outcome }),
      (err: unknown): ProviderAttemptResult => {
        if (controller.signal.aborted || isAbortError(err)) {
          return { outcome: { kind: 'failure', failure: { kind: 'timeout' } } };
        }
        return {
          outcome: { kind: 'failure', failure: { kind: 'network' } },
          fault: { errorName: err instanceof Error ? err.name : 'Unknown' },
        };
      },
    );

  try {
    return await Promise.race([attemptPromise, timeoutOutcome.then((outcome) => ({ outcome }))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Failure mapping + retry policy                                      */
/* ------------------------------------------------------------------ */

export interface MappedFailure {
  error: AiError;
  retryable: boolean;
}

export function mapProviderFailure(failure: AiProviderFailure): MappedFailure {
  switch (failure.kind) {
    case 'rate-limited':
      return {
        error: {
          kind: 'rate-limited',
          ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
        },
        retryable: true,
      };
    case 'timeout':
      return { error: { kind: 'timeout' }, retryable: true };
    case 'network':
      return { error: { kind: 'network' }, retryable: true };
    case 'http':
      return { error: { kind: 'http', status: failure.status }, retryable: failure.retryable };
    case 'malformed':
      return {
        error: {
          kind: 'invalid-response',
          issues: ['(root): response body was not valid JSON'],
        },
        retryable: false,
      };
  }
}

function delayFor(failure: AiProviderFailure, attempt: number, options: ResolvedOptions): number {
  if (failure.kind === 'rate-limited' && failure.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, failure.retryAfterMs), MAX_RETRY_AFTER_MS);
  }
  return Math.min(
    options.baseRetryDelayMs * 2 ** (attempt - 1),
    MAX_BACKOFF_MS,
  );
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Run one AI task. Never throws for expected failures.
 *
 * Order of operations (deliberate):
 * 1. Build + strictly validate the outgoing request (typed error if invalid —
 *    unvalidated data is never rendered or sent).
 * 2. If `aiEnabled` is false → local fallback, provider untouched (zero I/O).
 * 3. Otherwise: attempts with per-attempt timeout, retrying rate limits and
 *    transient failures with backoff until `maxAttempts`.
 */
export async function runAiRequest(
  provider: AiProvider,
  input: AiRequestInput,
  options: AiRunOptions = {},
): Promise<AiRunResult> {
  const resolved = resolveOptions(options);

  const built = buildAiRequest(input);
  if (built.kind === 'invalid') {
    return { kind: 'error', error: { kind: 'invalid-request', issues: built.issues }, attempts: 0 };
  }
  const request = built.request;

  // No-AI path: the provider is NEVER invoked — zero network requests.
  if (!request.settings.aiEnabled) {
    return { kind: 'fallback', reason: 'ai-disabled', response: localFallbackResponse(request) };
  }

  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
    const { outcome, fault } = await callProviderOnce(provider, request, attempt, resolved.timeoutMs);

    if (outcome.kind === 'response') {
      const validated = validateAiResponse(outcome.raw);
      if (validated.ok) return { kind: 'ok', response: validated.response, attempts: attempt };
      // Deterministic content problem → typed error, not retried.
      return {
        kind: 'error',
        error: { kind: 'invalid-response', issues: validated.issues },
        attempts: attempt,
      };
    }

    // The provider THREW an unexpected exception: typed, never retried.
    if (fault !== undefined) {
      return {
        kind: 'error',
        error: { kind: 'provider-fault', errorName: fault.errorName },
        attempts: attempt,
      };
    }

    const mapped = mapProviderFailure(outcome.failure);
    if (!mapped.retryable || attempt === resolved.maxAttempts) {
      return { kind: 'error', error: mapped.error, attempts: attempt };
    }
    await resolved.sleep(delayFor(outcome.failure, attempt, resolved));
  }

  // Unreachable: the loop always returns on the final attempt.
  return {
    kind: 'error',
    error: { kind: 'network' },
    attempts: resolved.maxAttempts,
  };
}
