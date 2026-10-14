/**
 * DOCX renderer tests (Prompt 20). The produced package is inspected IN MEMORY
 * (unzipped with the same library used to write it) and every part is parsed as
 * XML, so "valid package" is a structural claim, not a file-size guess.
 * Synthetic fixtures only.
 *
 * NOTE: no Microsoft Word (or any word processor) was used here — external
 * application compatibility is NOT claimed, only OOXML structure.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { baseResume } from '../pdf/test-support';
import type { TailoredResume } from '../schemas';
import { DOCX_MIME } from './document';
import { MAX_FILENAME_SLUG, renderResumeDocx, resumeDocxFilename } from './render';

const EXPECTED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/_rels/document.xml.rels',
  'word/styles.xml',
  'word/numbering.xml',
] as const;

/** Parse XML strictly: a malformed document yields a `parsererror` element. */
function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function part(parts: Record<string, string>, name: string): string {
  const value = parts[name];
  if (value === undefined) throw new Error(`missing package part: ${name}`);
  return value;
}

async function unzip(blob: Blob): Promise<Record<string, string>> {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) out[name] = strFromU8(data);
  return out;
}

async function renderOk(resume: TailoredResume) {
  const result = await renderResumeDocx(resume);
  if (!result.ok) throw new Error(`expected render to succeed, got ${result.code}`);
  return result;
}

/** Decoded text of word/document.xml (what a reader would extract). */
function documentText(documentXml: string): string {
  return parseXml(documentXml).documentElement.textContent ?? '';
}

describe('renderResumeDocx — package', () => {
  it('produces a valid .docx (Office Open XML ZIP) package', async () => {
    const result = await renderOk(baseResume());
    const bytes = new Uint8Array(await result.blob.arrayBuffer());

    expect(result.blob.type).toBe(DOCX_MIME);
    expect(result.filename).toMatch(/\.docx$/);
    expect(bytes.length).toBeGreaterThan(500);
    // Local file header signature "PK\x03\x04" — it really is a ZIP container.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const parts = await unzip(result.blob);
    // [Content_Types].xml must be the first entry of the package.
    expect(Object.keys(parts)[0]).toBe('[Content_Types].xml');
    expect(Object.keys(parts).sort()).toEqual([...EXPECTED_PARTS].sort());

    // Every part must be well-formed XML.
    for (const name of EXPECTED_PARTS) {
      const xml = part(parts, name);
      expect(parseXml(xml).getElementsByTagName('parsererror')).toHaveLength(0);
    }
    // The main document part is declared in the content types.
    expect(parts['[Content_Types].xml']).toContain('/word/document.xml');
    expect(parts['[Content_Types].xml']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    );
    // The package relationships point at the main document part.
    expect(parts['_rels/.rels']).toContain('word/document.xml');
    expect(parts['word/document.xml']).toMatch(/^<\?xml[^>]*\?><w:document /);
  });

  it('contains the expected section headings and representative resume text', async () => {
    const result = await renderOk(baseResume());
    const parts = await unzip(result.blob);
    const text = documentText(part(parts, 'word/document.xml'));

    for (const heading of [
      'Professional Summary',
      'Skills',
      'Professional Experience',
      'Projects',
      'Education',
      'Certifications',
      'Languages',
    ]) {
      expect(text).toContain(heading);
    }
    // Verbatim resume facts survive.
    expect(text).toContain('Alex Example');
    expect(text).toContain('Backend engineer');
    expect(text).toContain('Backend engineer focused on reliable APIs.');
    expect(text).toContain('Acme Fake Co');
    expect(text).toContain('Built APIs in TypeScript.');
    expect(text).toContain('TypeScript');
    expect(text).toContain('Example University');
    expect(text).toContain('AWS Certified Developer');
  });

  it('preserves Unicode and escapes XML-special characters safely', async () => {
    const special = 'R&D <script>alert(1)</script> & "quoted" \'apos\' — Café 日本語 ✓';
    const resume: TailoredResume = {
      ...baseResume(),
      summary: { basis: 'profile-summary', text: special, sourceIds: [] },
    };
    const result = await renderOk(resume);
    const parts = await unzip(result.blob);
    const raw = part(parts, 'word/document.xml');

    // Untrusted text is ESCAPED, never concatenated into markup.
    expect(raw).not.toContain('<script>');
    expect(raw).toContain('&lt;script&gt;');
    expect(raw).toContain('&amp;');
    expect(raw).toContain('&quot;');
    expect(raw).toContain('&apos;');
    // ...and it still parses, with the original meaning intact.
    expect(parseXml(raw).getElementsByTagName('parsererror')).toHaveLength(0);
    expect(documentText(raw)).toContain(special);
    // Unicode is preserved verbatim (DOCX is UTF-8; unlike the PDF we do not
    // transliterate).
    expect(documentText(raw)).toContain('日本語');
    expect(documentText(raw)).toContain('Café');
  });

  it('keeps bullets, dates and section ordering correct', async () => {
    const result = await renderOk(baseResume());
    const parts = await unzip(result.blob);
    const raw = part(parts, 'word/document.xml');
    const text = documentText(raw);

    // Real Word list definition, not a typed character.
    expect(raw).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    expect(parts['word/numbering.xml']).toContain('<w:numFmt w:val="bullet"/>');
    expect(text).toContain('Mentored two junior engineers.');
    // Dates rendered exactly like the PDF layout engine.
    expect(text).toContain('2021-01 - Present');
    expect(text).toContain('2014-09 - 2018-06');

    // Section order is preserved.
    const order = [
      'Professional Summary',
      'Skills',
      'Professional Experience',
      'Projects',
      'Education',
      'Certifications',
      'Languages',
    ];
    const positions = order.map((heading) => raw.indexOf(`>${heading}</w:t>`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders only resume content — never the posting provenance or annotations', async () => {
    const resume: TailoredResume = {
      ...baseResume(),
      source: { jobId: 'job-secret-id', jobTitle: 'Legacy Role', jobCapturedAt: '2026-01-05T00:00:00.000Z' },
    };
    const result = await renderOk(resume);
    const parts = await unzip(result.blob);
    const text = documentText(part(parts, 'word/document.xml'));

    // The posting's title/id and selection annotations are not resume content.
    expect(text).not.toContain('Legacy Role');
    expect(text).not.toContain('job-secret-id');
    expect(text).not.toContain('Mentions skills the posting requires');
    expect(text).not.toContain('Selected 3 of 3 profile skills.');
    // Evidence/annotation ids are never rendered.
    expect(text).not.toContain('profileSkillId');
    expect(text).not.toContain('relevance');
  });

  it('keeps the layout single-column: no tables, graphics, columns or hyperlinks', async () => {
    const result = await renderOk(baseResume());
    const parts = await unzip(result.blob);
    const raw = part(parts, 'word/document.xml');

    for (const forbidden of [
      '<w:tbl',
      '<w:tblPr',
      '<w:drawing',
      '<w:pict',
      '<w:txbxContent',
      '<w:cols',
      '<w:hyperlink',
      '<w:object',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('writes no hidden metadata (no docProps, no creator or timestamps)', async () => {
    const result = await renderOk(baseResume());
    const parts = await unzip(result.blob);

    expect(Object.keys(parts).some((name) => name.startsWith('docProps/'))).toBe(false);
    for (const [name, xml] of Object.entries(parts)) {
      expect(xml, `${name} must not carry core properties`).not.toContain('coreProperties');
      expect(xml, `${name} must not carry a creator field`).not.toContain('dc:creator');
      expect(xml, `${name} must not carry lastModifiedBy`).not.toContain('lastModifiedBy');
    }
  });

  it('is deterministic — identical input yields byte-identical packages', async () => {
    const first = await renderOk(baseResume());
    const second = await renderOk(baseResume());
    const a = Buffer.from(await first.blob.arrayBuffer());
    const b = Buffer.from(await second.blob.arrayBuffer());
    expect(a.equals(b)).toBe(true);
    expect(first.filename).toBe(second.filename);
  });

  it('rejects invalid input before building a package', async () => {
    const outcome = await renderResumeDocx({});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid');
    expect(outcome.issues.length).toBeGreaterThan(0);
    // Issues are path + code only — never values.
    expect(outcome.issues.join(' ')).toMatch(/schemaVersion|\(root\)/);
  });

  it('rejects a resume carrying a field outside the strict schema (e.g. contact data)', async () => {
    const withSensitive = { ...baseResume(), contactEmail: 'alex@example.com' };
    const outcome = await renderResumeDocx(withSensitive);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid');
    // The injected value is never echoed back.
    expect(JSON.stringify(outcome)).not.toContain('alex@example.com');
  });

  it('refuses characters XML cannot represent instead of emitting a corrupted document', async () => {
    const resume: TailoredResume = {
      ...baseResume(),
      summary: { basis: 'profile-summary', text: 'Control \u0001 char', sourceIds: [] },
    };
    const outcome = await renderResumeDocx(resume);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported-characters');
    // Only code points are reported — never the source text.
    expect(outcome.issues).toContain('U+0001');
    expect(JSON.stringify(outcome)).not.toContain('Control');
  });

  it('makes no network calls while rendering', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      await renderOk(baseResume());
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('resumeDocxFilename', () => {
  it('builds a safe filename from the job label', () => {
    expect(resumeDocxFilename(baseResume())).toBe('resume-senior-backend-engineer-tailored.docx');
  });

  it('sanitizes path and markup characters out of the label', () => {
    const resume: TailoredResume = {
      ...baseResume(),
      source: { jobId: 'j', jobTitle: '../../etc/passwd <script> & Co.', jobCapturedAt: '2026-01-05T00:00:00.000Z' },
    };
    const filename = resumeDocxFilename(resume);
    expect(filename).toMatch(/^resume-[a-z0-9-]+-tailored\.docx$/);
    const slug = filename.replace(/^resume-/, '').replace(/-tailored\.docx$/, '');
    // No path separators, dots, angle brackets or whitespace survive in the slug.
    expect(slug).not.toMatch(/[/\\.<>\s]/);
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('<');
  });

  it('caps the label length', () => {
    const resume: TailoredResume = {
      ...baseResume(),
      source: { jobId: 'j', jobTitle: 'x'.repeat(300), jobCapturedAt: '2026-01-05T00:00:00.000Z' },
    };
    const filename = resumeDocxFilename(resume);
    const slug = filename.replace(/^resume-/, '').replace(/-tailored\.docx$/, '');
    expect(slug.length).toBeLessThanOrEqual(MAX_FILENAME_SLUG);
  });

  it('uses a neutral fallback when the label has no usable characters', () => {
    const resume: TailoredResume = {
      ...baseResume(),
      source: { jobId: 'j', jobTitle: '★★★', jobCapturedAt: '2026-01-05T00:00:00.000Z' },
    };
    expect(resumeDocxFilename(resume)).toBe('resume-tailored.docx');
  });
});
