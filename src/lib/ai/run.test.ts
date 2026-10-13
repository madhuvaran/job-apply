/**
 * Tests for orchestration (src/lib/ai/run.ts + fallback.ts) — Prompt 06:
 * request safety chokepoint, no-AI fallback with ZERO network, timeouts,
 * rate-limit/retry with typed errors, and the mock provider happy path.
 *
 * All tests are offline: the "network" is either the in-process mock provider
 * or a fake fetch injected into the proxy provider.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildAiRequest,
  DEFAULT_BASE_RETRY_DELAY_MS,
  runAiRequest,
  type AiRequestInput,
} from './run';
import { createMockProvider, mockResponseFor } from './mock';
import { createProxyProvider } from './proxy';
import { EMPTY_PROFILE_FALLBACK_TEXT } from './fallback';
import { validateAiRequest, validateAiResponse, type AiRequest } from './schemas';
import { defaultSettings, settingsForProvider, settingsSchema, type Settings } from '../settings';
import { profileSchema, type Profile } from '../profile';
import { sampleProfile, sampleSensitiveProfile } from '../sample-profile';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const job = {
  title: 'Fake Staff Engineer',
  company: 'Fake Co',
  location: 'Remote',
  description: 'Build fake things with the team.',
};

const baseInput = (settings: Settings = defaultSettings()): AiRequestInput => ({
  task: 'tailor-resume',
  job,
  profile: sampleProfile,
  settings,
});

const enabledSettings = (patch: Partial<Settings> = {}): Settings =>
  settingsSchema.parse({ ...defaultSettings(), aiEnabled: true, ...patch });

const recorder = (): { delays: number[]; sleep: (ms: number) => Promise<void> } => {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
};

/* ------------------------------------------------------------------ */
/* Request safety chokepoint                                           */
/* ------------------------------------------------------------------ */

describe('buildAiRequest (payload safety)', () => {
  it('projects settings through settingsForProvider — salary never reaches the wire', () => {
    const settings = settingsSchema.parse({
      ...defaultSettings(),
      salary: { currency: 'USD', minAnnual: 123456 },
    });
    const built = buildAiRequest(baseInput(settings));
    expect(built.kind).toBe('ok');
    if (built.kind !== 'ok') return;
    expect(built.request.settings).toEqual(settingsForProvider(settings));
    expect('salary' in built.request.settings).toBe(false);
    const json = JSON.stringify(built.request);
    expect(json).not.toContain('salary');
    expect(json).not.toContain('123456');
    expect(json).not.toContain('USD');
  });

  it('contains no sensitive-profile values (contact, legal, documents)', () => {
    const built = buildAiRequest(baseInput(settingsSchema.parse({
      ...defaultSettings(),
      salary: { currency: 'USD', minAnnual: 999999 },
    })));
    expect(built.kind).toBe('ok');
    if (built.kind !== 'ok') return;
    const json = JSON.stringify(built.request);
    const secrets = [
      sampleSensitiveProfile.contact.email,
      sampleSensitiveProfile.contact.phone,
      sampleSensitiveProfile.contact.address,
      sampleSensitiveProfile.documents.notesAboutMe,
      'workAuthorization',
      'governmentId',
    ].filter((s): s is string => typeof s === 'string' && s.length > 0);
    // The fixture really is populated — the assertions below are meaningful.
    expect(secrets.length).toBe(6);
    for (const secret of secrets) {
      expect(json).not.toContain(secret);
    }
    // The sensitive record's keys cannot appear anywhere in the payload.
    expect(Object.keys(built.request)).toEqual([
      'schemaVersion',
      'task',
      'job',
      'profile',
      'settings',
    ]);
  });

  it('carries the AI-safe profile verbatim and validates strictly', () => {
    const built = buildAiRequest(baseInput());
    expect(built.kind).toBe('ok');
    if (built.kind !== 'ok') return;
    expect(built.request.profile).toEqual(sampleProfile);
    expect(validateAiRequest(built.request).ok).toBe(true);
    expect(built.request.settings.aiEnabled).toBe(false); // default stays off
  });

  it('returns a typed invalid result (no throw) instead of building a bad payload', () => {
    const built = buildAiRequest({
      task: 'tailor-resume',
      job: { ...job, title: '   ' },
      profile: sampleProfile,
      settings: defaultSettings(),
    });
    expect(built.kind).toBe('invalid');
    if (built.kind !== 'invalid') return;
    expect(built.issues.length).toBeGreaterThan(0);
  });

  it('rejects the sensitive record passed where the profile belongs', () => {
    const built = buildAiRequest({
      task: 'tailor-resume',
      job,
      profile: sampleSensitiveProfile as unknown as Profile,
      settings: defaultSettings(),
    });
    expect(built.kind).toBe('invalid');
  });
});

/* ------------------------------------------------------------------ */
/* No-AI fallback (aiEnabled = false, the default)                     */
/* ------------------------------------------------------------------ */

describe('no-AI fallback when aiEnabled is false (default)', () => {
  it('returns the local fallback and NEVER calls the provider', async () => {
    const mock = createMockProvider();
    const result = await runAiRequest(mock, baseInput());
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') return;
    expect(result.reason).toBe('ai-disabled');
    expect(validateAiResponse(result.response).ok).toBe(true);
    expect(result.response.provider).toBe('local');
    expect(mock.calls.length).toBe(0);
    expect(mock.remainingSteps).toBe(0);
  });

  it('makes ZERO network requests through the real proxy provider when disabled', async () => {
    const fetchSpy = vi.fn();
    const proxy = createProxyProvider({
      endpoint: 'https://backend.example.test/api/ai',
      fetchImpl: fetchSpy,
    });
    const result = await runAiRequest(proxy, baseInput());
    expect(result.kind).toBe('fallback');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not even consult scripted provider failures when disabled', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'http', status: 500, retryable: true } }],
    });
    const result = await runAiRequest(mock, baseInput(), { maxAttempts: 3, sleep: async () => {} });
    expect(result.kind).toBe('fallback');
    expect(mock.calls.length).toBe(0);
    expect(mock.remainingSteps).toBe(1); // untouched
  });

  it('fallback content is the candidate’s own stored material, verbatim and deterministic', async () => {
    const mock = createMockProvider();
    const first = await runAiRequest(mock, baseInput());
    const second = await runAiRequest(mock, baseInput());
    expect(first.kind).toBe('fallback');
    expect(second.kind).toBe('fallback');
    if (first.kind !== 'fallback' || second.kind !== 'fallback') return;
    const content = first.response.content;
    expect(second.response.content).toBe(content);
    expect(content).toContain(sampleProfile.summary ?? '');
    expect(content).toContain('Fake Skill A');
    expect(content).toContain('Fake bullet one written by the candidate.');
    expect(content).toContain('Acme Fake Co');
    // Nothing invented: every candidate-facing line is a stored string.
    expect(content).not.toMatch(/\bapply now\b/i);
  });

  it('fallback for draft-answer renders the saved application answers only', async () => {
    const mock = createMockProvider();
    const result = await runAiRequest(mock, { ...baseInput(), task: 'draft-answer' });
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') return;
    expect(result.response.task).toBe('draft-answer');
    expect(result.response.content).toContain('Why do you want to work with us?');
    expect(result.response.content).toContain(
      'Fake answer provided explicitly by the fake candidate.',
    );
    // The tailoring renderer's sections do not leak into the answers fallback.
    expect(result.response.content).not.toContain('Experience\n');
  });

  it('an empty profile yields a fixed status literal (no invented content)', async () => {
    const result = await runAiRequest(createMockProvider(), {
      ...baseInput(),
      profile: profileSchema.parse({}),
    });
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') return;
    expect(result.response.content).toBe(EMPTY_PROFILE_FALLBACK_TEXT);
  });

  it('fallback never contains salary or sensitive values even when they exist locally', async () => {
    const settings = settingsSchema.parse({
      ...defaultSettings(),
      salary: { currency: 'USD', minAnnual: 123456 },
    });
    const result = await runAiRequest(createMockProvider(), baseInput(settings));
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') return;
    const json = JSON.stringify(result.response);
    expect(json).not.toContain('salary');
    expect(json).not.toContain('123456');
    expect(json).not.toContain(sampleSensitiveProfile.contact.email);
    expect(json).not.toContain(sampleSensitiveProfile.contact.phone);
  });

  it('an invalid request fails typed BEFORE any fallback or provider call', async () => {
    const mock = createMockProvider();
    const result = await runAiRequest(mock, {
      ...baseInput(),
      job: { ...job, description: '   ' },
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('invalid-request');
    expect(result.attempts).toBe(0);
    expect(mock.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Happy path with AI enabled                                          */
/* ------------------------------------------------------------------ */

describe('runAiRequest with AI enabled', () => {
  it('calls the provider once and returns a validated response', async () => {
    const mock = createMockProvider();
    const input = baseInput(enabledSettings());
    const result = await runAiRequest(mock, input);
    expect(result).toEqual({ kind: 'ok', response: mockResponseFor(buildOk(input)), attempts: 1 });
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.attempt).toBe(1);
    expect(mock.calls[0]?.signal.aborted).toBe(false);
  });

  it('sends exactly the validated request from buildAiRequest', async () => {
    const mock = createMockProvider();
    const input = baseInput(enabledSettings());
    await runAiRequest(mock, input);
    const built = buildAiRequest(input);
    expect(built.kind).toBe('ok');
    if (built.kind !== 'ok') return;
    expect(mock.calls[0]?.request).toEqual(built.request);
    expect(JSON.stringify(mock.calls[0]?.request)).not.toContain('salary');
  });

  it('a provider failure never throws — it resolves as a typed error result', async () => {
    const boom = {
      id: 'boom',
      send: () => Promise.reject(new TypeError('internal secret that must not leak')),
    };
    const result = await runAiRequest(boom, baseInput(enabledSettings()), {
      sleep: async () => {},
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error).toEqual({ kind: 'provider-fault', errorName: 'TypeError' });
    expect(result.attempts).toBe(1);
    // Neither the message nor any payload leaks into the result.
    expect(JSON.stringify(result)).not.toContain('internal secret');
  });

  it('a provider that throws synchronously is also typed, not propagated', async () => {
    const syncThrow = {
      id: 'sync',
      send: () => {
        throw new RangeError('sync boom');
      },
    };
    const result = await runAiRequest(syncThrow, baseInput(enabledSettings()));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error).toEqual({ kind: 'provider-fault', errorName: 'RangeError' });
  });

  it('an invalid provider response is a typed invalid-response error (not retried)', async () => {
    const mock = createMockProvider({ steps: [{ kind: 'raw', raw: { nope: true } }] });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), { sleep: sleep.sleep });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('invalid-response');
    if (result.error.kind !== 'invalid-response') return;
    expect(result.error.issues.join('\n')).toContain('nope');
    expect(result.attempts).toBe(1);
    expect(sleep.delays).toEqual([]);
    expect(mock.calls.length).toBe(1);
  });

  it('a malformed (non-JSON) provider body maps to invalid-response', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'malformed' } }],
    });
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      maxAttempts: 3,
      sleep: async () => {},
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('invalid-response');
    expect(result.attempts).toBe(1); // deterministic → no retry
  });
});

/* ------------------------------------------------------------------ */
/* Timeouts                                                            */
/* ------------------------------------------------------------------ */

describe('request timeouts', () => {
  it('aborts a hanging attempt and returns a typed timeout error', async () => {
    const mock = createMockProvider({ steps: [{ kind: 'hang' }] });
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      timeoutMs: 20,
      maxAttempts: 1,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('timeout');
    expect(result.attempts).toBe(1);
    // The attempt's signal was aborted — in-flight work is cancelled.
    expect(mock.calls[0]?.signal.aborted).toBe(true);
  });

  it('retries after a timeout and succeeds within maxAttempts', async () => {
    const mock = createMockProvider({ steps: [{ kind: 'hang' }, { kind: 'hang' }] });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      timeoutMs: 15,
      maxAttempts: 3,
      sleep: sleep.sleep,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(3);
    // Exponential backoff between attempts: base, base*2.
    expect(sleep.delays).toEqual([DEFAULT_BASE_RETRY_DELAY_MS, DEFAULT_BASE_RETRY_DELAY_MS * 2]);
    expect(mock.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
  });

  it('exhausts attempts on persistent timeouts and reports the last error', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' }],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      timeoutMs: 10,
      maxAttempts: 3,
      sleep: sleep.sleep,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.kind).toBe('timeout');
    expect(result.attempts).toBe(3);
    expect(sleep.delays.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Rate limit + retry policy                                           */
/* ------------------------------------------------------------------ */

describe('rate-limit and retry handling', () => {
  it('retries a rate limit, honors Retry-After, then succeeds', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'rate-limited', retryAfterMs: 4000 } }],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), { sleep: sleep.sleep });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(2);
    expect(sleep.delays).toEqual([4000]); // Retry-After wins over backoff
  });

  it('falls back to exponential backoff when Retry-After is absent', async () => {
    const mock = createMockProvider({
      steps: [
        { kind: 'failure', failure: { kind: 'rate-limited' } },
        { kind: 'failure', failure: { kind: 'rate-limited' } },
      ],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), { sleep: sleep.sleep });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(3);
    expect(sleep.delays).toEqual([250, 500]);
  });

  it('returns a typed rate-limited error when retries are exhausted', async () => {
    const mock = createMockProvider({
      steps: [
        { kind: 'failure', failure: { kind: 'rate-limited', retryAfterMs: 1000 } },
        { kind: 'failure', failure: { kind: 'rate-limited', retryAfterMs: 1000 } },
      ],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      maxAttempts: 2,
      sleep: sleep.sleep,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error).toEqual({ kind: 'rate-limited', retryAfterMs: 1000 });
    expect(result.attempts).toBe(2);
    expect(sleep.delays).toEqual([1000]);
  });

  it('maxAttempts 1 disables retries entirely', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'rate-limited' } }],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      maxAttempts: 1,
      sleep: sleep.sleep,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.attempts).toBe(1);
    expect(sleep.delays).toEqual([]);
    expect(mock.calls.length).toBe(1);
  });

  it('retryable HTTP 5xx is retried; typed error carries the status when exhausted', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'http', status: 503, retryable: true } }],
    });
    const sleep = recorder();
    const ok = await runAiRequest(mock, baseInput(enabledSettings()), { sleep: sleep.sleep });
    expect(ok.kind).toBe('ok');
    expect(sleep.delays).toEqual([250]);

    const failing = createMockProvider({
      steps: [
        { kind: 'failure', failure: { kind: 'http', status: 500, retryable: true } },
        { kind: 'failure', failure: { kind: 'http', status: 500, retryable: true } },
      ],
    });
    const sleep2 = recorder();
    const err = await runAiRequest(failing, baseInput(enabledSettings()), {
      maxAttempts: 2,
      sleep: sleep2.sleep,
    });
    expect(err.kind).toBe('error');
    if (err.kind !== 'error') return;
    expect(err.error).toEqual({ kind: 'http', status: 500 });
    expect(err.attempts).toBe(2);
  });

  it('a non-retryable HTTP 4xx fails immediately (no sleep, one attempt)', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'http', status: 401, retryable: false } }],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      maxAttempts: 3,
      sleep: sleep.sleep,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error).toEqual({ kind: 'http', status: 401 });
    expect(result.attempts).toBe(1);
    expect(sleep.delays).toEqual([]);
  });

  it('transient network failures are retried', async () => {
    const mock = createMockProvider({
      steps: [{ kind: 'failure', failure: { kind: 'network' } }],
    });
    const sleep = recorder();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), { sleep: sleep.sleep });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(2);
    expect(sleep.delays).toEqual([250]);
  });

  it('clamps nonsensical option values instead of looping or dividing by zero', async () => {
    const mock = createMockProvider();
    const result = await runAiRequest(mock, baseInput(enabledSettings()), {
      timeoutMs: 0,
      maxAttempts: 0,
      baseRetryDelayMs: -10,
    });
    // maxAttempts 0 clamps to 1 → first attempt succeeds.
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.attempts).toBe(1);
  });
});

/** Helper: the request the happy-path mock echoes back. */
function buildOk(input: AiRequestInput): AiRequest {
  const built = buildAiRequest(input);
  if (built.kind !== 'ok') throw new Error('fixture request invalid');
  return built.request;
}
