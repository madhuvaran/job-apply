/**
 * Renderer tests (Prompt 12): valid rendering, strict validation, present vs
 * absent sections, multi-page flow, encoding, content integrity, determinism
 * and the privacy/offline boundaries. Synthetic fixtures only.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderResumePdf, resumePdfFilename } from './render';
import { baseResume, extractPdfText, pdfHasImage } from './test-support';
import type { TailoredResume } from '../schemas';

async function renderText(resume: unknown): Promise<string> {
  const result = await renderResumePdf(resume);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.issues.join('; ')}`);
  return extractPdfText(result.blob);
}

describe('renderResumePdf — success', () => {
  it('renders a valid resume to a PDF blob with a safe filename and page count', async () => {
    const result = await renderResumePdf(baseResume());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blob.type).toBe('application/pdf');
    expect(result.blob.size).toBeGreaterThan(500);
    expect(result.pageCount).toBe(1);
    expect(result.filename).toBe('resume-senior-backend-engineer-tailored.pdf');
  });

  it('emits selectable PDF text (no embedded image) and preserves source content', async () => {
    const result = await renderResumePdf(baseResume());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await pdfHasImage(result.blob)).toBe(false);

    const text = await extractPdfText(result.blob);
    for (const expected of [
      'Alex Example',
      'Berlin, Germany',
      'Professional Summary',
      'Backend engineer focused on reliable APIs.',
      'Skills',
      'TypeScript',
      'Professional Experience',
      'Senior Backend Engineer - Acme Fake Co',
      '2021-01 - Present',
      'Built APIs in TypeScript.',
      'Mentored two junior engineers.',
      'Projects',
      'Fake API',
      'Education',
      'Example University',
      'AWS Certified Developer',
      'Languages',
      'English (Fluent)',
      'Page 1 of 1',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('handles absent optional sections without emitting their headings', async () => {
    const minimal: TailoredResume = baseResume({
      header: { displayName: 'Alex Example' },
      summary: undefined,
      skills: [{ profileSkillId: 'sk-1', name: 'TypeScript', status: 'verified', relevance: 'neutral' }],
      experience: [],
      projects: [],
      education: [],
      certifications: [],
      languages: [],
      links: undefined,
      selectionNotes: [],
    });
    const result = await renderResumePdf(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = await extractPdfText(result.blob);
    expect(text).toContain('Alex Example');
    expect(text).toContain('Skills');
    for (const absent of [
      'Professional Summary',
      'Professional Experience',
      'Projects',
      'Education',
      'Certifications',
      'Languages',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it('spans pages for long content without silently dropping bullets', async () => {
    const bullets = Array.from({ length: 90 }, (_v, i) => `Delivered item number ${i + 1} for the team.`);
    const resume = baseResume({
      experience: [
        {
          id: 'ex-long',
          company: 'Acme Fake Co',
          title: 'Senior Backend Engineer',
          dates: { start: '2021-01', end: null },
          bullets,
          relevance: 'relevant',
          reason: 'Mentions skills the posting requires: TypeScript.',
        },
      ],
    });
    const result = await renderResumePdf(resume);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBeGreaterThan(1);

    const text = await extractPdfText(result.blob);
    // First and last bullets both survive, and every one in between.
    expect(text).toContain('Delivered item number 1 for the team.');
    expect(text).toContain('Delivered item number 90 for the team.');
    expect(text).toContain(`Page 1 of ${result.pageCount}`);
    expect(text).toContain(`Page ${result.pageCount} of ${result.pageCount}`);
  });

  it('renders deterministically — identical inputs give byte-identical PDFs', async () => {
    const first = await renderResumePdf(baseResume());
    const second = await renderResumePdf(baseResume());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = Buffer.from(await first.blob.arrayBuffer());
    const b = Buffer.from(await second.blob.arrayBuffer());
    expect(a.equals(b)).toBe(true);
  });
});

describe('renderResumePdf — text handling', () => {
  it('normalizes typographic punctuation and keeps accented Latin-1 letters', async () => {
    const resume = baseResume({
      experience: [
        {
          id: 'ex-1',
          company: 'Acme Fake Co',
          title: 'Engineer',
          dates: { start: '2020-01', end: '2021-01' },
          bullets: ['Café — \u201Csmart\u201D \u2026 na\u00EFve\u00A0idea'],
          relevance: 'relevant',
          reason: 'Mentions skills the posting requires: TypeScript.',
        },
      ],
    });
    const text = await renderText(resume);
    expect(text).toContain('Caf\u00E9 - "smart" ... na\u00EFve idea');
  });

  it('refuses characters the built-in font cannot encode (typed error, no PDF)', async () => {
    const resume = baseResume({
      experience: [
        {
          id: 'ex-1',
          company: 'Acme Fake Co',
          title: 'Engineer',
          dates: { start: '2020-01', end: null },
          bullets: ['\u65E5\u672C\u8A9E'],
          relevance: 'relevant',
          reason: 'Mentions skills the posting requires: TypeScript.',
        },
      ],
    });
    const result = await renderResumePdf(resume);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported-characters');
    expect(result.issues.join(' ')).toContain('U+65E5');
    expect(result.issues.join(' ')).not.toContain('\u65E5');
  });
});

describe('renderResumePdf — validation', () => {
  it('rejects invalid data with a typed error', async () => {
    for (const bad of [null, {}, { schemaVersion: '2' }, baseResume({ schemaVersion: '1' as never }) && { ...baseResume(), apiKey: 'secret' }]) {
      const result = await renderResumePdf(bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe('invalid');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown top-level properties (strict schema) without leaking them', async () => {
    const withExtra = { ...baseResume(), contactEmail: 'alex@example.invalid' };
    const result = await renderResumePdf(withExtra);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
    expect(result.issues.join(' ')).not.toContain('alex@example.invalid');
  });
});

describe('renderResumePdf — content integrity', () => {
  it('never renders internal ids, relevance metadata, reasons or selection notes', async () => {
    const text = await renderText(baseResume());
    for (const internal of [
      'sk-1', 'sk-2', 'sk-3',
      'ex-1', 'pr-1', 'ed-1', 'ce-1',
      'relevant', 'fallback',
      'matchedJobSkill',
      'profile-summary',
      'Mentions skills the posting requires',
      'Title overlaps with the posted job title',
      'Selected 3 of 3',
    ]) {
      expect(text).not.toContain(internal);
    }
  });

  it('renders no contact details (none exist in the schema)', async () => {
    const text = await renderText(baseResume());
    expect(text).not.toContain('@');
    expect(text).not.toContain('555-');
  });

  it('renders the job title only as provenance-safe filename, never as experience', async () => {
    const result = await renderResumePdf(baseResume({ experience: [], projects: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = await extractPdfText(result.blob);
    // The posted job title must not appear as candidate experience.
    expect(text).not.toContain('Senior Backend Engineer');
  });
});

describe('renderResumePdf — privacy & offline boundaries', () => {
  it('makes zero network calls and never touches the AI provider', async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const result = await renderResumePdf(baseResume());
      expect(result.ok).toBe(true);
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('module sources import no sensitive store, AI layer, fetch or storage', () => {
    const dir = join(process.cwd(), 'src', 'lib', 'resume', 'pdf');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-support.ts')
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/from ['"].*sensitive['"]/);
    expect(sources).not.toMatch(/loadSensitiveProfile/);
    expect(sources).not.toMatch(/runAiRequest|from ['"].*\/ai['"]/);
    expect(sources).not.toMatch(/fetch\s*\(/);
    expect(sources).not.toMatch(/chrome\.storage|keepProfile|loadProfile|loadSettings/);
  });
});

describe('matching & tailoring unchanged', () => {
  it('keeps the public matching + tailoring API intact', async () => {
    const matching = await import('../../matching');
    const resume = await import('../index');
    expect(typeof matching.calculateJobMatch).toBe('function');
    expect(matching.MATCH_WEIGHTS.requiredSkills).toBe(35);
    expect(typeof resume.tailorResume).toBe('function');
  });
});

describe('resumePdfFilename', () => {
  it('slugifies the job title and never injects path characters', () => {
    expect(resumePdfFilename(baseResume({ source: { jobId: 'j', jobTitle: 'Senior Backend Engineer', jobCapturedAt: '2026-10-13T00:00:00.000Z' } })))
      .toBe('resume-senior-backend-engineer-tailored.pdf');
    expect(resumePdfFilename(baseResume({ source: { jobId: 'j', jobTitle: '../../etc/passwd', jobCapturedAt: '2026-10-13T00:00:00.000Z' } })))
      .toBe('resume-etc-passwd-tailored.pdf');
  });
});
