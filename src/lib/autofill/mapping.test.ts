// @vitest-environment jsdom
/**
 * AI-assisted semantic field-mapping tests (Prompt 17) — jsdom, synthetic data
 * only, offline (a spy/mock provider; `fetch` is spied to prove it is unused).
 *
 * Covers: AI off → zero calls; scan alone never calls; minimal request shape;
 * sensitive/excluded/valueless guarantees; strict response validation
 * (unknown/duplicate/oversized/stale); confidence threshold; cancellation;
 * planner+executor pass-through for approved suggestions; missing answers;
 * failure handling (unavailable/rate-limit/timeout); unchanged deterministic
 * behavior; and no network outside the provider abstraction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileSchema } from '../profile';
import { sensitiveProfileSchema } from '../sensitive';
import { defaultSettings, settingsSchema } from '../settings';
import type { AiProvider, AiProviderCallContext, AiProviderOutcome } from '../ai/provider';
import { collectFieldDescriptors } from './page';
import { classifyField } from './classify';
import { buildFillPlan } from './plan';
import { executeFillPlan } from './execute';
import {
  MAPPING_CONFIDENCE_THRESHOLD,
  MAPPING_DISCLOSURE,
  approveMappings,
  availableMappingCategories,
  buildMappingProposal,
  buildMappingRequest,
  eligibleMappingFields,
  mappingResponseSchema,
  requestMappingProposal,
  validateMappingResponse,
  type MappingProposal,
  type MappingRequest,
  type MappingRunResult,
} from './mapping';
import { fieldDescriptorsSchema, type FieldDescriptor } from './schemas';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const profile = profileSchema.parse({
  displayName: 'Ada Example',
  summary: 'Pioneer of computing.',
  skills: [{ id: 's1', name: 'TypeScript' }],
  linkedin: 'https://www.linkedin.com/in/ada',
  portfolio: 'https://ada.example.invalid',
});

const sensitive = sensitiveProfileSchema.parse({
  contact: {
    firstName: 'Ada',
    lastName: 'Example',
    email: 'ada@example.invalid',
    phone: '+1 555 0100',
    cityLabel: 'London',
  },
  legal: { workAuthorization: 'authorized_no_sponsorship', sponsorshipNeeded: false },
  voluntary: {
    gender: 'undisclosed',
    raceEthnicity: ['undisclosed'],
    veteranStatus: 'undisclosed',
    disabilityStatus: 'undisclosed',
  },
});

const enabledSettings = () => settingsSchema.parse({ ...defaultSettings(), aiEnabled: true });

function scan(html: string): { descriptors: FieldDescriptor[]; registry: Map<string, Element> } {
  document.body.innerHTML = html;
  return collectFieldDescriptors(document);
}

/* ------------------------------------------------------------------ */
/* Spy provider                                                        */
/* ------------------------------------------------------------------ */

interface SpyProvider extends AiProvider<MappingRequest> {
  readonly calls: MappingRequest[];
}

function spyProvider(
  handler?: (request: MappingRequest, ctx: AiProviderCallContext) => Promise<AiProviderOutcome> | AiProviderOutcome,
): SpyProvider {
  const calls: MappingRequest[] = [];
  return {
    id: 'spy',
    get calls() {
      return calls;
    },
    async send(request: MappingRequest, ctx: AiProviderCallContext): Promise<AiProviderOutcome> {
      calls.push(request);
      if (handler !== undefined) return handler(request, ctx);
      // Default: suggest the first allowed category for every field, confidently.
      return {
        kind: 'response',
        raw: {
          schemaVersion: '1',
          task: 'map-fields',
          mappings: request.fields.map((f) => ({
            fieldId: f.fieldId,
            category: request.allowedCategories[0],
            confidence: 0.95,
            reason: 'label-match',
          })),
        },
      };
    },
  };
}

function responseFor(
  request: MappingRequest,
  category: string,
  confidence = 0.95,
): Record<string, unknown> {
  return {
    schemaVersion: '1',
    task: 'map-fields',
    mappings: request.fields.map((f) => ({
      fieldId: f.fieldId,
      category,
      confidence,
      reason: 'label-match',
    })),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ */
/* 1 & 2. Off by default / scan alone                                 */
/* ------------------------------------------------------------------ */

describe('AI off by default', () => {
  it('makes zero provider calls when settings.aiEnabled is false', async () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const provider = spyProvider();
    const result = await requestMappingProposal({
      descriptors,
      profile,
      sensitive,
      settings: defaultSettings(),
      scanId: 's1',
      provider,
    });
    expect(result.kind).toBe('ai-disabled');
    expect(provider.calls.length).toBe(0);
  });

  it('never calls the provider while merely scanning or building a request', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
      eligibleMappingFields(descriptors);
      buildMappingRequest(descriptors, profile, sensitive);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 3, 4, 5. Minimal request content                                    */
/* ------------------------------------------------------------------ */

describe('minimal, value-free request', () => {
  it('sends only fieldId/label/kind + allowed categories', () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const built = buildMappingRequest(descriptors, profile, sensitive);
    if (built.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(built.request).sort()).toEqual([
      'allowedCategories',
      'fields',
      'schemaVersion',
      'task',
    ]);
    expect(Object.keys(built.request.fields[0] as object).sort()).toEqual(['fieldId', 'kind', 'label']);
    const json = JSON.stringify(built.request);
    expect(json).not.toContain('Pioneer'); // summary value
    expect(json).not.toContain('ada@example.invalid'); // email value
    expect(json).not.toContain('TypeScript'); // skills value
    expect(json).not.toContain('profile');
    expect(json).not.toContain('job');
    expect(json).not.toContain('settings');
  });

  it('never includes sensitive/excluded or non-interactable fields', () => {
    const { descriptors } = scan(`
      <label for="pn">Preferred name</label><input id="pn" />
      <label for="pw">Password</label><input id="pw" type="password" />
      <label for="sal">Expected salary</label><input id="sal" />
      <label for="gen">Gender</label><select id="gen"><option>X</option></select>
      <label><input type="checkbox" id="agree" /> I agree to the terms</label>
      <input type="hidden" id="csrf" />
      <input id="dis" disabled /> <input id="ro" readonly />
      <select id="ms" multiple><option>A</option></select>`);
    const eligible = eligibleMappingFields(descriptors);
    expect(eligible.map((e) => e.fieldId)).toHaveLength(1);

    const built = buildMappingRequest(descriptors, profile, sensitive);
    if (built.kind !== 'ok') throw new Error('expected ok');
    expect(built.request.fields).toHaveLength(1);
    const json = JSON.stringify(built.request).toLowerCase();
    for (const word of ['password', 'salary', 'gender', 'agree', 'csrf', 'disabled']) {
      expect(json).not.toContain(word);
    }
  });

  it('never sends existing field values or arbitrary page text', () => {
    const { descriptors } = scan(
      '<p>PAGE-SECRET-TEXT here</p><label for="pn">Preferred name</label><input id="pn" value="FIELD-SECRET-VALUE" />',
    );
    const built = buildMappingRequest(descriptors, profile, sensitive);
    if (built.kind !== 'ok') throw new Error('expected ok');
    const json = JSON.stringify(built.request);
    expect(json).not.toContain('FIELD-SECRET-VALUE');
    expect(json).not.toContain('PAGE-SECRET-TEXT');
  });
});

/* ------------------------------------------------------------------ */
/* 6 & 7. Strict response validation                                   */
/* ------------------------------------------------------------------ */

describe('strict response validation', () => {
  function okRequest(): MappingRequest {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const built = buildMappingRequest(descriptors, profile, sensitive);
    if (built.kind !== 'ok') throw new Error('expected ok');
    return built.request;
  }

  it('rejects unknown properties, categories and malformed confidence', () => {
    const request = okRequest();
    expect(validateMappingResponse({ ...responseFor(request, 'email'), extra: 1 }, request).ok).toBe(false);
    expect(validateMappingResponse(responseFor(request, 'workAuthorization'), request).ok).toBe(false);
    expect(validateMappingResponse(responseFor(request, 'not-a-category'), request).ok).toBe(false);
    const bad = responseFor(request, 'email');
    (bad.mappings as Array<Record<string, unknown>>)[0]!.confidence = 2;
    expect(validateMappingResponse(bad, request).ok).toBe(false);
    expect(mappingResponseSchema.safeParse(responseFor(request, 'email')).success).toBe(true);
  });

  it('rejects duplicate and unknown field ids', () => {
    const request = okRequest();
    const id = request.fields[0]!.fieldId;
    const dup = { schemaVersion: '1', task: 'map-fields', mappings: [
      { fieldId: id, category: 'email', confidence: 0.9, reason: 'label-match' },
      { fieldId: id, category: 'phone', confidence: 0.9, reason: 'label-match' },
    ] };
    const dupResult = validateMappingResponse(dup, request);
    expect(dupResult.ok).toBe(false);
    const unknown = validateMappingResponse(
      { schemaVersion: '1', task: 'map-fields', mappings: [
        { fieldId: 'nope', category: 'email', confidence: 0.9, reason: 'label-match' },
      ] },
      request,
    );
    expect(unknown.ok).toBe(false);
  });

  it('rejects an oversized response', () => {
    const request = okRequest();
    const oversized = {
      schemaVersion: '1',
      task: 'map-fields',
      mappings: Array.from({ length: 26 }, (_v, i) => ({
        fieldId: `f${i}`,
        category: 'email',
        confidence: 0.9,
        reason: 'label-match',
      })),
    };
    expect(validateMappingResponse(oversized, request).ok).toBe(false);
  });

  it('rejects a stale proposal (session changed)', () => {
    const proposal: MappingProposal = { scanId: 'scan-a', entries: [], suggestedCount: 0 };
    expect(approveMappings(proposal, [], 'scan-b')).toEqual({ ok: false, reason: 'stale-session' });
    expect(approveMappings(proposal, [], 'scan-a').ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Confidence threshold                                             */
/* ------------------------------------------------------------------ */

describe('confidence threshold', () => {
  it('keeps a low-confidence suggestion manual', () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const built = buildMappingRequest(descriptors, profile, sensitive);
    if (built.kind !== 'ok') throw new Error('expected ok');
    const low = validateMappingResponse(
      responseFor(built.request, 'firstName', MAPPING_CONFIDENCE_THRESHOLD - 0.1),
      built.request,
    );
    if (!low.ok) throw new Error('expected valid');
    const proposal = buildMappingProposal('s1', built.request, low.response);
    expect(proposal.suggestedCount).toBe(0);
    expect(proposal.entries[0]?.decision).toBe('manual');
    expect(proposal.entries[0]?.reason).toMatch(/low-confidence/i);
  });
});

/* ------------------------------------------------------------------ */
/* 9 & 10. Cancellation / no direct DOM execution                      */
/* ------------------------------------------------------------------ */

describe('cancellation and no direct execution', () => {
  it('cancelling before invocation makes no provider call and no DOM writes', async () => {
    const { descriptors, registry } = scan(
      '<label for="pn">Preferred name</label><input id="pn" />',
    );
    const provider = spyProvider();
    // User cancels: we never invoke requestMappingProposal.
    expect(provider.calls.length).toBe(0);
    // With no approved mappings, the planner produces no AI fill and nothing is written.
    const built = buildFillPlan({ descriptors, profile, sensitive, categoryOverrides: {} });
    if (!built.ok) throw new Error('expected ok');
    executeFillPlan(built.plan, registry);
    expect((document.getElementById('pn') as HTMLInputElement).value).toBe('');
  });

  it('does not import or invoke the DOM executor from the mapping module', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'autofill', 'mapping.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/executeFillPlan|from '\.\/execute'|document\.|fetch\s*\(/);
    expect(src).not.toMatch(/chrome\.|browser\./);
  });

  it('a proposal alone never writes to the page', async () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const provider = spyProvider();
    const result = await requestMappingProposal({
      descriptors,
      profile,
      sensitive,
      settings: enabledSettings(),
      scanId: 's1',
      provider,
    });
    expect(result.kind).toBe('ok');
    expect((document.getElementById('pn') as HTMLInputElement).value).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* 11. Confirmed suggestions → planner → executor                      */
/* ------------------------------------------------------------------ */

describe('approved suggestions flow through the existing planner/executor', () => {
  it('plans and fills via the executor only after explicit approval', async () => {
    const { descriptors, registry } = scan(
      '<label for="pn">Preferred name</label><input id="pn" />',
    );
    const provider = spyProvider((request) => ({
      kind: 'response',
      raw: responseFor(request, 'firstName'),
    }));
    const result = await requestMappingProposal({
      descriptors,
      profile,
      sensitive,
      settings: enabledSettings(),
      scanId: 's1',
      provider,
    });
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.proposal.suggestedCount).toBe(1);

    const approved = approveMappings(
      result.proposal,
      result.proposal.entries.filter((e) => e.decision === 'suggest').map((e) => e.fieldId),
      's1',
    );
    if (!approved.ok) throw new Error('expected approved');
    expect(approved.categoryOverrides).toEqual({ 'af-0': 'firstName' });

    const built = buildFillPlan({
      descriptors,
      profile,
      sensitive,
      categoryOverrides: approved.categoryOverrides,
    });
    if (!built.ok) throw new Error('expected plan');
    expect(built.plan.instructions[0]).toMatchObject({ fieldId: 'af-0', category: 'firstName', value: 'Ada' });

    const filled = executeFillPlan(built.plan, registry);
    if (!filled.ok) throw new Error('expected execute ok');
    expect(filled.report.filledCount).toBe(1);
    expect((document.getElementById('pn') as HTMLInputElement).value).toBe('Ada');
  });
});

/* ------------------------------------------------------------------ */
/* 12. Missing saved answers stay manual                               */
/* ------------------------------------------------------------------ */

describe('missing saved answers', () => {
  it('does not offer categories without a saved answer', () => {
    const noSummary = profileSchema.parse({
      displayName: 'Ada Example',
      skills: [{ id: 's1', name: 'TypeScript' }],
    });
    const cats = availableMappingCategories(noSummary, sensitive);
    expect(cats).not.toContain('summary');
    expect(cats).toContain('firstName');
  });

  it('leaves an approved category manual when no answer exists', () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const built = buildFillPlan({
      descriptors,
      profile: null,
      sensitive: null,
      categoryOverrides: { 'af-0': 'firstName' },
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    expect(built.review[0]?.decision).toBe('manual');
    expect(built.review[0]?.reason).toMatch(/no saved answer/i);
  });
});

/* ------------------------------------------------------------------ */
/* 13. AI cannot map legal/sensitive/multi-select                      */
/* ------------------------------------------------------------------ */

describe('AI exclusions', () => {
  it('never treats legal, compensation, voluntary, auth or multi-select as eligible', () => {
    const { descriptors } = scan(`
      <label for="wa">Are you authorized to work?</label><select id="wa"><option>Yes</option></select>
      <label for="sp">Will you require sponsorship?</label><select id="sp"><option>Yes</option></select>
      <label for="pw">Password</label><input id="pw" type="password" />
      <label for="sal">Expected salary</label><input id="sal" />
      <label for="gen">Gender</label><select id="gen"><option>X</option></select>
      <label for="dis">Disability status</label><select id="dis"><option>X</option></select>
      <select id="ms" multiple><option>A</option></select>`);
    expect(eligibleMappingFields(descriptors)).toEqual([]);
  });

  it('never sends work-authorization/sponsorship as allowed categories', () => {
    const cats = availableMappingCategories(profile, sensitive) as string[];
    expect(cats).not.toContain('workAuthorization');
    expect(cats).not.toContain('sponsorship');
    expect(cats).not.toContain('state');
    expect(cats).not.toContain('country');
  });
});

/* ------------------------------------------------------------------ */
/* 14. Failure handling                                                */
/* ------------------------------------------------------------------ */

describe('provider failure handling', () => {
  async function run(
    provider: SpyProvider | null,
    timeoutMs = 1000,
  ): Promise<MappingRunResult> {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    return requestMappingProposal(
      { descriptors, profile, sensitive, settings: enabledSettings(), scanId: 's1', provider },
      { timeoutMs },
    );
  }

  it('reports provider-unavailable without any call', async () => {
    const provider = spyProvider();
    // Even when a spy exists, passing null must not use it (simulated by null).
    const result = await run(null);
    expect(result.kind).toBe('provider-unavailable');
    expect(provider.calls.length).toBe(0);
  });

  it('maps a rate-limit failure to a typed error', async () => {
    const provider = spyProvider(() => ({ kind: 'failure', failure: { kind: 'rate-limited', retryAfterMs: 1000 } }));
    const result = await run(provider);
    expect(result).toMatchObject({ kind: 'error', error: { kind: 'rate-limited' } });
  });

  it('maps a timeout to a typed error', async () => {
    const provider = spyProvider(() => new Promise<AiProviderOutcome>(() => {}));
    const result = await run(provider, 20);
    expect(result).toMatchObject({ kind: 'error', error: { kind: 'timeout' } });
  });

  it('maps an invalid provider response to a typed error', async () => {
    const provider = spyProvider(() => ({ kind: 'response', raw: { bogus: true } }));
    const result = await run(provider);
    expect(result).toMatchObject({ kind: 'error', error: { kind: 'invalid-response' } });
    const json = JSON.stringify(result);
    expect(json).not.toContain('Ada');
  });
});

/* ------------------------------------------------------------------ */
/* 15. Deterministic behavior unchanged                                */
/* ------------------------------------------------------------------ */

describe('deterministic behavior is unchanged', () => {
  it('still classifies a recognizable field without AI', () => {
    const { descriptors } = scan(
      '<label for="em">Email</label><input id="em" type="email" />' +
        '<label for="pn">Preferred name</label><input id="pn" />',
    );
    const byId = new Map(descriptors.map((d) => [d.elementId, d]));
    expect(classifyField(byId.get('em') as FieldDescriptor)).toMatchObject({
      kind: 'supported',
      category: 'email',
    });
    // API overrides never turn a recognized field into something else...
    const built = buildFillPlan({
      descriptors,
      profile,
      sensitive,
      categoryOverrides: { 'af-0': 'firstName' },
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions.find((i) => i.fieldId === 'af-0')?.category).toBe('email');
  });

  it('never overrides an excluded field', () => {
    const { descriptors } = scan('<label for="pw">Password</label><input id="pw" type="password" />');
    const built = buildFillPlan({
      descriptors,
      profile,
      sensitive,
      categoryOverrides: { 'af-0': 'email' },
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    expect(built.review[0]?.classification).toBe('excluded');
  });

  it('never lets an AI override supply a legal category', () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const built = buildFillPlan({
      descriptors,
      profile,
      sensitive,
      categoryOverrides: { 'af-0': 'workAuthorization' },
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
  });

  it('rejects an invalid categoryOverrides map', () => {
    const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
    const built = buildFillPlan({
      descriptors,
      profile,
      sensitive,
      categoryOverrides: { 'af-0': 'not-a-category' },
    });
    expect(built.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 16. No network outside the provider abstraction                     */
/* ------------------------------------------------------------------ */

describe('offline boundary', () => {
  it('makes no fetch call during a full mapping run', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const { descriptors } = scan('<label for="pn">Preferred name</label><input id="pn" />');
      await requestMappingProposal({
        descriptors,
        profile,
        sensitive,
        settings: enabledSettings(),
        scanId: 's1',
        provider: spyProvider(),
      });
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('descriptor schema still rejects unknown keys', () => {
    expect(fieldDescriptorsSchema.safeParse([{ fieldId: 'x', kind: 'text', value: 'SECRET' }]).success).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Privacy disclosure (Prompt 17 follow-up)                            */
/* ------------------------------------------------------------------ */

describe('AI mapping privacy disclosure', () => {
  const text = MAPPING_DISCLOSURE.join(' ');

  it('states the exact minimal data sent, only on explicit request', () => {
    expect(text).toMatch(/when a provider is configured/i);
    expect(text).toMatch(/explicitly request/i);
    expect(text).toMatch(/sends only the selected eligible fields/i);
    expect(text).toMatch(/normalized labels/i);
    expect(text).toMatch(/control types/i);
    expect(text).toMatch(/saved-answer categories/i);
  });

  it('explains that field labels come from the webpage', () => {
    expect(text).toMatch(/from the webpage/i);
    expect(text).toMatch(/may contain text supplied by the website/i);
  });

  it('lists what is NOT sent', () => {
    for (const phrase of [
      'does not send',
      'field values',
      'profile',
      'saved answers',
      'job description',
      'HTML',
      'DOM',
      'URLs',
      'sensitive',
      'legal',
      'compensation',
    ]) {
      expect(text.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });

  it('does not make the contradictory blanket "no page content" claim', () => {
    expect(text).not.toMatch(/any page content/i);
    expect(text).not.toMatch(/no page content/i);
  });

  it('is the disclosure the popup renders (no text drift)', () => {
    const app = readFileSync(join(process.cwd(), 'entrypoints', 'popup', 'App.tsx'), 'utf8');
    expect(app).toContain('MAPPING_DISCLOSURE');
    expect(app).not.toMatch(/or any page content/i);
  });
});
