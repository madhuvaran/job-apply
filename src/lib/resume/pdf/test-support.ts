/**
 * Shared helpers + synthetic fixtures for the PDF renderer tests (Prompt 12).
 * NOT part of the shipped renderer: only imported by `*.test.ts`.
 *
 * `extractPdfText` inflates the PDF's content streams (Node `zlib`) and decodes
 * the hex/literal strings pdf-lib writes with `Tj`, so tests assert on the real
 * selectable text embedded in the document — not on file size or a magic
 * header.
 */
import { inflateSync } from 'node:zlib';
import type { TailoredResume } from '../schemas';

/** Concatenated, inflated content streams of a PDF blob (latin1 view). */
export async function pdfContentStreams(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer());
  const raw = buf.toString('latin1');
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const seg = Buffer.from(m[1] ?? '', 'latin1');
    try {
      parts.push(inflateSync(seg).toString('latin1'));
    } catch {
      parts.push(seg.toString('latin1'));
    }
  }
  return parts.join('\n');
}

function decodeHex(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_full, group: string) => {
    switch (group) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '(':
        return '(';
      case ')':
        return ')';
      case '\\':
        return '\\';
      default:
        return String.fromCharCode(parseInt(group, 8));
    }
  });
}

/** All text drawn in the PDF, in document order, one shown string per line. */
export async function extractPdfText(blob: Blob): Promise<string> {
  const content = await pdfContentStreams(blob);
  const shown: string[] = [];
  const re = /<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) shown.push(decodeHex(m[1]));
    else shown.push(unescapeLiteral(m[2] ?? ''));
  }
  return shown.join('\n');
}

/** Does the PDF embed an image XObject (i.e. is it a screenshot)? */
export async function pdfHasImage(blob: Blob): Promise<boolean> {
  const buf = Buffer.from(await blob.arrayBuffer());
  return /\/Subtype\s*\/Image/.test(buf.toString('latin1'));
}

/* ------------------------------------------------------------------ */
/* Synthetic fixtures — clearly fake, never the user's real resume.     */
/* ------------------------------------------------------------------ */

export function baseResume(overrides: Partial<TailoredResume> = {}): TailoredResume {
  return {
    schemaVersion: '1',
    source: {
      jobId: 'job-1',
      jobTitle: 'Senior Backend Engineer',
      jobCapturedAt: '2026-10-13T00:00:00.000Z',
    },
    header: {
      displayName: 'Alex Example',
      headline: 'Backend engineer',
      locationLabel: 'Berlin, Germany',
    },
    summary: {
      basis: 'profile-summary',
      text: 'Backend engineer focused on reliable APIs.',
      sourceIds: [],
    },
    skills: [
      {
        profileSkillId: 'sk-1',
        name: 'TypeScript',
        status: 'verified',
        years: 6,
        relevance: 'required',
        matchedJobSkill: 'TypeScript',
      },
      { profileSkillId: 'sk-2', name: 'Kubernetes', status: 'claimed', relevance: 'preferred' },
      { profileSkillId: 'sk-3', name: 'Figma', status: 'claimed', relevance: 'neutral' },
    ],
    experience: [
      {
        id: 'ex-1',
        company: 'Acme Fake Co',
        title: 'Senior Backend Engineer',
        location: 'Berlin',
        dates: { start: '2021-01', end: null },
        bullets: ['Built APIs in TypeScript.', 'Mentored two junior engineers.'],
        relevance: 'relevant',
        reason: 'Mentions skills the posting requires: TypeScript.',
      },
    ],
    projects: [
      {
        id: 'pr-1',
        name: 'Fake API',
        description: 'A synthetic API project used only in tests.',
        links: ['https://example.com/fake'],
        skills: [{ id: 'sk-1', name: 'TypeScript', status: 'verified' }],
        relevance: 'relevant',
        reason: 'Title overlaps with the posted job title.',
      },
    ],
    education: [
      {
        id: 'ed-1',
        institution: 'Example University',
        credential: 'BSc',
        fieldOfStudy: 'Computer Science',
        grade: 'First class',
        inProgress: false,
        dates: { start: '2014-09', end: '2018-06' },
      },
    ],
    certifications: [{ id: 'ce-1', name: 'AWS Certified Developer', issuer: 'Amazon' }],
    languages: [
      { language: 'English', level: 'fluent' },
      { language: 'German', level: 'intermediate' },
    ],
    links: { github: 'https://github.com/example' },
    selectionNotes: ['Selected 3 of 3 profile skills.'],
    ...overrides,
  };
}
