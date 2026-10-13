/**
 * Tests for the AI request/response contract (src/lib/ai/schemas.ts) —
 * Prompt 06 acceptance: strict zod validation on BOTH sides, no salary in
 * outgoing settings, no sensitive/contact data in the request, no credential
 * field anywhere, sensible size caps.
 *
 * Pure tests: no network, no browser API.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_SCHEMA_VERSION,
  AI_TASKS,
  aiJobInputSchema,
  aiRequestSchema,
  aiResponseSchema,
  formatZodIssues,
  MAX_AI_RESPONSE_CONTENT_CHARS,
  providerSafeSettingsSchema,
  validateAiRequest,
  validateAiResponse,
} from './schemas';
import { profileSchema, type Profile } from '../profile';
import { defaultSettings, settingsForProvider, settingsSchema, type Settings } from '../settings';
import { sampleProfile, sampleSensitiveProfile } from '../sample-profile';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const job = {
  title: 'Fake Staff Engineer',
  company: 'Fake Co',
  location: 'Remote',
  description: 'Build fake things with the team.\nRequirements: fake skills.',
};

const withSalary = settingsSchema.parse({
  ...defaultSettings(),
  salary: { currency: 'USD', minAnnual: 123456 },
});

const enabledSettings = (): Settings => ({ ...defaultSettings(), aiEnabled: true });

const validRequest = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: AI_SCHEMA_VERSION,
  task: 'tailor-resume',
  job,
  profile: sampleProfile,
  settings: settingsForProvider(defaultSettings()),
  ...patch,
});

const issuesOf = (payload: unknown): string[] => {
  const result = validateAiRequest(payload);
  return result.ok ? [] : result.issues;
};

/* ------------------------------------------------------------------ */
/* Request schema                                                      */
/* ------------------------------------------------------------------ */

describe('aiRequestSchema (strict)', () => {
  it('accepts a well-formed request built from AI-safe inputs', () => {
    const result = validateAiRequest(validRequest());
    expect(result.ok).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const issues = issuesOf(validRequest({ apiKey: 'sk-should-never-exist' }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('\n')).toContain('apiKey');
  });

  it('rejects a salary inside settings even if settingsForProvider were bypassed', () => {
    const issues = issuesOf(
      validRequest({ settings: { ...settingsForProvider(defaultSettings()), salary: { currency: 'USD', minAnnual: 1 } } }),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.startsWith('settings'))).toBe(true);
    expect(issues.join('\n')).toContain('salary');
  });

  it('accepts the exact output of settingsForProvider (salary stripped)', () => {
    expect(() =>
      aiRequestSchema.parse(validRequest({ settings: settingsForProvider(withSalary) })),
    ).not.toThrow();
    expect('salary' in settingsForProvider(withSalary)).toBe(false);
  });

  it('rejects the sensitive profile passed as the profile (no shared keys, strict)', () => {
    const issues = issuesOf(validRequest({ profile: sampleSensitiveProfile }));
    expect(issues.length).toBeGreaterThan(0);
    const joined = issues.join('\n');
    expect(joined).toMatch(/contact|legal|voluntary|documents/);
  });

  it('rejects contact details injected into the AI-safe profile (strict)', () => {
    const injected = { ...sampleProfile, email: 'leak@example.com' } as unknown as Profile;
    const issues = issuesOf(validRequest({ profile: injected }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('\n')).toContain('email');
  });

  it('rejects an unknown task', () => {
    expect(issuesOf(validRequest({ task: 'exfiltrate' })).length).toBeGreaterThan(0);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(issuesOf(validRequest({ schemaVersion: '99' })).length).toBeGreaterThan(0);
  });

  it('rejects unknown keys inside the job object', () => {
    const issues = issuesOf(validRequest({ job: { ...job, cookies: 'sid=1' } }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('\n')).toContain('cookies');
  });

  it('rejects a whitespace-only job title and description', () => {
    expect(issuesOf(validRequest({ job: { ...job, title: '   ' } })).length).toBeGreaterThan(0);
    expect(issuesOf(validRequest({ job: { ...job, description: '  \n ' } })).length).toBeGreaterThan(0);
  });

  it('enforces size caps (title 200, description 100k)', () => {
    expect(issuesOf(validRequest({ job: { ...job, title: 'x'.repeat(201) } })).length).toBeGreaterThan(0);
    expect(
      issuesOf(validRequest({ job: { ...job, description: 'x'.repeat(100_001) } })).length,
    ).toBeGreaterThan(0);
    // Exactly at the cap is fine.
    expect(issuesOf(validRequest({ job: { ...job, description: 'x'.repeat(100_000) } }))).toEqual([]);
  });

  it('every sub-schema is strict: job, settings and profile reject extra keys individually', () => {
    expect(aiJobInputSchema.safeParse({ ...job, extra: 1 }).success).toBe(false);
    expect(
      providerSafeSettingsSchema.safeParse({ ...settingsForProvider(defaultSettings()), token: 'x' })
        .success,
    ).toBe(false);
    expect(profileSchema.safeParse({ ...sampleProfile, token: 'x' }).success).toBe(false);
  });

  it('providerSafeSettingsSchema has no salary field in its shape', () => {
    expect(Object.keys(providerSafeSettingsSchema.shape)).not.toContain('salary');
    expect(Object.keys(providerSafeSettingsSchema.shape)).toContain('aiEnabled');
  });
});

/* ------------------------------------------------------------------ */
/* Response schema                                                     */
/* ------------------------------------------------------------------ */

describe('aiResponseSchema (strict)', () => {
  const valid = {
    schemaVersion: AI_SCHEMA_VERSION,
    task: 'tailor-resume',
    content: 'Tailored draft content.',
    provider: 'proxy',
    model: 'some-model',
    usage: { inputTokens: 100, outputTokens: 50 },
  };

  it('accepts a well-formed response (with and without optional fields)', () => {
    expect(validateAiResponse(valid).ok).toBe(true);
    expect(validateAiResponse({ ...valid, model: undefined, usage: undefined }).ok).toBe(true);
    expect(
      validateAiResponse({
        schemaVersion: AI_SCHEMA_VERSION,
        task: 'draft-answer',
        content: 'Because.',
        provider: 'local',
      }).ok,
    ).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const result = validateAiResponse({ ...valid, debugDump: { raw: 'x' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('debugDump');
  });

  it('rejects unknown keys inside usage (strict)', () => {
    const result = validateAiResponse({ ...valid, usage: { inputTokens: 1, outputTokens: 1, cost: 5 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('cost');
  });

  it('rejects missing/empty/whitespace-only content', () => {
    const { content: _c, ...withoutContent } = valid;
    expect(validateAiResponse(withoutContent).ok).toBe(false);
    expect(validateAiResponse({ ...valid, content: '' }).ok).toBe(false);
    expect(validateAiResponse({ ...valid, content: '   \n' }).ok).toBe(false);
  });

  it('rejects oversized content and bad usage numbers', () => {
    expect(validateAiResponse({ ...valid, content: 'x'.repeat(MAX_AI_RESPONSE_CONTENT_CHARS + 1) }).ok).toBe(
      false,
    );
    expect(validateAiResponse({ ...valid, usage: { inputTokens: -1, outputTokens: 0 } }).ok).toBe(false);
    expect(validateAiResponse({ ...valid, usage: { inputTokens: 1.5, outputTokens: 0 } }).ok).toBe(false);
  });

  it('rejects an unknown task and a wrong schemaVersion', () => {
    expect(validateAiResponse({ ...valid, task: 'summarize' }).ok).toBe(false);
    expect(validateAiResponse({ ...valid, schemaVersion: '2' }).ok).toBe(false);
  });

  it('rejects an empty provider id (no anonymous responses)', () => {
    expect(validateAiResponse({ ...valid, provider: '  ' }).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

describe('validation helpers', () => {
  it('formatZodIssues renders root paths as (root) and nests dotted paths', () => {
    expect(formatZodIssues([{ path: [], message: 'bad' }])).toEqual(['(root): bad']);
    expect(formatZodIssues([{ path: ['settings', 'salary'], message: 'nope' }])).toEqual([
      'settings.salary: nope',
    ]);
  });

  it('validateAiRequest returns ok:false with issues (never throws)', () => {
    expect(() => validateAiRequest(null)).not.toThrow();
    const result = validateAiRequest(null);
    expect(result.ok).toBe(false);
  });

  it('task list is exactly the two roadmap tasks (guards accidental expansion)', () => {
    expect([...AI_TASKS]).toEqual(['tailor-resume', 'draft-answer']);
  });
});
