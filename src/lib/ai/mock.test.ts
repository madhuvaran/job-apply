/**
 * Tests for the mock provider (src/lib/ai/mock.ts) — the test double
 * Prompt 06 requires. Pure, offline, scriptable: default valid responses,
 * ordered script consumption, call recording, and the hang step used by the
 * timeout tests.
 */
import { describe, expect, it } from 'vitest';
import { createMockProvider, mockResponseFor } from './mock';
import { buildAiRequest, type AiRequestInput } from './run';
import { validateAiResponse, type AiRequest } from './schemas';
import { defaultSettings, settingsSchema } from '../settings';
import { sampleProfile } from '../sample-profile';

const job = {
  title: 'Fake Staff Engineer',
  company: 'Fake Co',
  description: 'Build fake things.',
};

const enabledInput = (): AiRequestInput => ({
  task: 'tailor-resume',
  job,
  profile: sampleProfile,
  settings: settingsSchema.parse({ ...defaultSettings(), aiEnabled: true }),
});

const request = (): AiRequest => {
  const built = buildAiRequest(enabledInput());
  if (built.kind !== 'ok') throw new Error('fixture request invalid');
  return built.request;
};

const ctx = (attempt = 1) => ({
  signal: new AbortController().signal,
  attempt,
  timeoutMs: 1000,
});

describe('createMockProvider', () => {
  it('defaults to a valid, deterministic response derived from the request', async () => {
    const mock = createMockProvider();
    const req = request();
    const first = await mock.send(req, ctx());
    const second = await mock.send(req, ctx());
    expect(first).toEqual({ kind: 'response', raw: mockResponseFor(req) });
    expect(second).toEqual(first);
    expect(validateAiResponse(first.kind === 'response' ? first.raw : null).ok).toBe(true);
    expect(mockResponseFor(req).content).toBe('mock:tailor-resume:Fake Staff Engineer');
  });

  it('plays scripted steps in order, then falls back to the default answer', async () => {
    const mock = createMockProvider({
      steps: [
        { kind: 'failure', failure: { kind: 'rate-limited', retryAfterMs: 10 } },
        { kind: 'raw', raw: { custom: 'body' } },
      ],
    });
    const req = request();
    expect(await mock.send(req, ctx(1))).toEqual({
      kind: 'failure',
      failure: { kind: 'rate-limited', retryAfterMs: 10 },
    });
    expect(mock.remainingSteps).toBe(1);
    expect(await mock.send(req, ctx(2))).toEqual({ kind: 'response', raw: { custom: 'body' } });
    expect(mock.remainingSteps).toBe(0);
    // Exhausted → valid default response.
    const third = await mock.send(req, ctx(3));
    expect(third.kind).toBe('response');
  });

  it('records every call with its request, attempt number and signal', async () => {
    const mock = createMockProvider();
    const req = request();
    const first = new AbortController().signal;
    await mock.send(req, { signal: first, attempt: 1, timeoutMs: 50 });
    await mock.send(req, { signal: new AbortController().signal, attempt: 2, timeoutMs: 50 });
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0]?.attempt).toBe(1);
    expect(mock.calls[1]?.attempt).toBe(2);
    expect(mock.calls[0]?.signal).toBe(first);
    expect(mock.calls[0]?.request).toEqual(req);
  });

  it('the hang step never settles (drives the orchestrator timeout path)', async () => {
    const mock = createMockProvider({ steps: [{ kind: 'hang' }] });
    let settled = false;
    void mock.send(request(), ctx()).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(mock.remainingSteps).toBe(0);
  });

  it('honors a custom id and starts with zero calls', () => {
    const mock = createMockProvider({ id: 'mock-dev' });
    expect(mock.id).toBe('mock-dev');
    expect(mock.calls.length).toBe(0);
    expect(createMockProvider().id).toBe('mock');
  });
});
