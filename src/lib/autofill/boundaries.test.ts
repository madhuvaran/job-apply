// @vitest-environment jsdom
/**
 * Boundary tests (Prompt 14): strict schemas, offline behavior, and an
 * unchanged manifest (no new permissions).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyField } from './classify';
import { buildFillPlan } from './plan';
import { executeFillPlan } from './execute';
import { fieldDescriptorSchema, fillPlanSchema } from './schemas';

describe('strict schemas', () => {
  it('rejects unknown properties on descriptors and plans', () => {
    expect(fieldDescriptorSchema.safeParse({ fieldId: 'x', kind: 'text', value: 'SECRET' }).success).toBe(false);
    expect(
      fillPlanSchema.safeParse({
        schemaVersion: '1',
        instructions: [{ fieldId: 'x', category: 'firstName', value: 'v', source: 'profile', requiresConfirmation: true, extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an instruction with no value (missing answers are never "")', () => {
    expect(
      fillPlanSchema.safeParse({
        schemaVersion: '1',
        instructions: [{ fieldId: 'x', category: 'firstName', value: '', source: 'profile', requiresConfirmation: true }],
      }).success,
    ).toBe(false);
  });
});

describe('offline & AI boundaries', () => {
  it('makes no network calls across classify → plan → execute', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const descriptor = fieldDescriptorSchema.parse({ fieldId: 'f1', kind: 'text', labelText: 'First name' });
      expect(classifyField(descriptor).kind).toBe('supported');
      const built = buildFillPlan({ descriptors: [descriptor], profile: null, sensitive: null });
      expect(built.ok).toBe(true);
      const executed = executeFillPlan({ schemaVersion: '1', instructions: [] }, []);
      expect(executed.ok).toBe(true);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('module sources import no AI layer, no network and no direct chrome.storage', () => {
    const dir = join(process.cwd(), 'src', 'lib', 'autofill');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(sources).not.toMatch(/runAiRequest|from ['"].*\/ai['"]/);
    expect(sources).not.toMatch(/fetch\s*\(/);
    expect(sources).not.toMatch(/chrome\.storage|browser\.storage/);
  });
});

describe('manifest permissions unchanged', () => {
  it('declares only storage/activeTab/scripting and no host permissions', () => {
    const config = readFileSync(join(process.cwd(), 'wxt.config.ts'), 'utf8');
    expect(config).toMatch(/permissions:\s*\[\s*'storage',\s*'activeTab',\s*'scripting'\s*\]/);
    expect(config).not.toMatch(/host_permissions|hostPermissions/);
  });
});
