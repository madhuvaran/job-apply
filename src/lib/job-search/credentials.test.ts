/**
 * Credential-hygiene source scan (Prompt 27, test requirement 8).
 *
 * Adzuna authenticates with `app_id`/`app_key` QUERY parameters, so any key in
 * this repository would be both a public-secret leak and a way to burn the
 * developer's quota from every installed copy of the extension. These tests
 * read the module's own source and assert the structural guarantees:
 *
 * - no credential-shaped literal is assigned anywhere in the module;
 * - the module never calls `api.adzuna.com` (only the project's own proxy);
 * - no documentation example can contain a real-looking key.
 *
 * Test files are excluded from the literal-assignment scan because they
 * deliberately contain obviously-fake strings that the schemas must REJECT.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE_DIR = new URL('.', import.meta.url).pathname;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const sourceFiles = listSourceFiles(MODULE_DIR);
const read = (file: string) => ({ file, text: readFileSync(file, 'utf8') });
const sources = sourceFiles.map(read);
const relative = (file: string) => file.slice(MODULE_DIR.length);

/** Assignment of a credential-named field to a non-trivial literal. */
const CREDENTIAL_LITERAL =
  /(?:app_?key|app_?id|api_?key|apikey|client_?secret|access_?token|authorization)\s*[:=]\s*['"`][A-Za-z0-9_\-.]{8,}['"`]/i;

/** A fetch/messaging call whose target is the Adzuna host itself. */
const DIRECT_ADZUNA_CALL = /(?:fetch|XMLHttpRequest|sendBeacon)\s*\([^)]*adzuna\.com/i;

describe('the job-search module contains no credential', () => {
  it('scans a non-empty set of source files', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.some((s) => relative(s.file).endsWith('adzuna/provider.ts'))).toBe(true);
  });

  it('never assigns a credential-shaped literal', () => {
    const offenders = sources
      .filter((s) => CREDENTIAL_LITERAL.test(s.text))
      .map((s) => relative(s.file));
    expect(offenders).toEqual([]);
  });

  it('never calls api.adzuna.com directly', () => {
    const offenders = sources
      .filter((s) => DIRECT_ADZUNA_CALL.test(s.text))
      .map((s) => relative(s.file));
    expect(offenders).toEqual([]);
  });

  it('reaches the vendor only through the project-owned proxy URL builder', () => {
    const provider = sources.find((s) => relative(s.file).endsWith('adzuna/provider.ts'))!;
    // The single outgoing call must be built from our own proxy endpoint.
    expect(provider.text).toContain('fetchImpl(buildAdzunaProxyUrl(endpoint, request)');
    // And it must not carry an authorization header of any kind.
    expect(provider.text.toLowerCase()).not.toContain('authorization');
  });

  it('keeps the credential parameter names in exactly one declarative constant', () => {
    const schemas = sources.find((s) => relative(s.file).endsWith('adzuna/schemas.ts'))!;
    expect(schemas.text).toContain("export const ADZUNA_CREDENTIAL_PARAMS = ['app_id', 'app_key']");
  });
});

describe('the integration document cannot carry a real key', () => {
  const docPath = join(MODULE_DIR, '..', '..', '..', 'docs', 'adzuna-integration.md');

  it('exposes no long hex/base64 secret-looking token', () => {
    const text = readFileSync(docPath, 'utf8');
    expect(text).not.toMatch(/[0-9a-fA-F]{24,}/);
    expect(text).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });

  it('names credentials only as placeholders', () => {
    const text = readFileSync(docPath, 'utf8');
    // Placeholders only: no `app_key = "<value>"` style example.
    expect(text).not.toMatch(/app_key\s*[:=]\s*['"`][^'"`]{8,}['"`]/i);
  });
});
