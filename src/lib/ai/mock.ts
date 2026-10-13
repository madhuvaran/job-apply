/**
 * Mock provider for tests (Prompt 06).
 *
 * Deterministic, offline and scriptable:
 * - Records every call (request, attempt number, signal) for assertions.
 * - Plays a scripted sequence of steps (typed failures, arbitrary raw
 *   payloads — including deliberately INVALID ones — or a hanging call).
 * - With no steps left, answers with a valid `AiResponse` derived from the
 *   request, so the happy path needs no setup.
 *
 * Never performs I/O; used by unit tests and (optionally) by dev builds as a
 * stand-in backend.
 */
import type { AiProvider, AiProviderCallContext, AiProviderFailure, AiProviderOutcome } from './provider';
import {
  aiResponseSchema,
  AI_SCHEMA_VERSION,
  type AiRequest,
  type AiResponse,
} from './schemas';

export type MockStep =
  /** Return a typed failure (rate limit, http, network, malformed…). */
  | { kind: 'failure'; failure: AiProviderFailure }
  /** Return this raw object as the provider's response body (may be invalid). */
  | { kind: 'raw'; raw: unknown }
  /** Never settle — exercises the orchestrator's timeout/abort path. */
  | { kind: 'hang' };

export interface MockCall {
  request: AiRequest;
  attempt: number;
  signal: AbortSignal;
}

export interface MockProviderOptions {
  /** Steps consumed one per attempt, in order. Empty/exhausted = valid default answer. */
  steps?: MockStep[];
  /** Provider id (default 'mock'). */
  id?: string;
}

export interface MockProvider extends AiProvider {
  /** Every `send()` this provider received, in order. */
  readonly calls: ReadonlyArray<MockCall>;
  /** Scripted steps not yet consumed. */
  readonly remainingSteps: number;
}

/** A valid, deterministic response body for the given request. */
export function mockResponseFor(request: AiRequest): AiResponse {
  return aiResponseSchema.parse({
    schemaVersion: AI_SCHEMA_VERSION,
    task: request.task,
    content: `mock:${request.task}:${request.job.title}`,
    provider: 'mock',
    model: 'mock-model',
  });
}

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const steps: MockStep[] = [...(options.steps ?? [])];
  const calls: MockCall[] = [];

  return {
    id: options.id ?? 'mock',
    get calls() {
      return calls;
    },
    get remainingSteps() {
      return steps.length;
    },
    async send(request: AiRequest, ctx: AiProviderCallContext): Promise<AiProviderOutcome> {
      calls.push({ request, attempt: ctx.attempt, signal: ctx.signal });
      const step = steps.shift();
      if (step === undefined) return { kind: 'response', raw: mockResponseFor(request) };
      switch (step.kind) {
        case 'failure':
          return { kind: 'failure', failure: step.failure };
        case 'raw':
          return { kind: 'response', raw: step.raw };
        case 'hang':
          return new Promise<AiProviderOutcome>(() => {
            /* intentionally never settles */
          });
      }
    },
  };
}
