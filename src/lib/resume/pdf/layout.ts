/**
 * Fixed-layout, single-column layout engine for the ATS-friendly resume PDF
 * (Prompt 12).
 *
 * Presentation only: it maps an ALREADY-VALIDATED `TailoredResume` to styled
 * text lines and paginates them. It never generates, paraphrases or drops
 * content — a block is emitted for every present schema field, and every line
 * of every block is placed on a page (long paragraphs and bullets split across
 * pages rather than being clipped or silently truncated).
 *
 * Pure module: takes a `measure` callback (page width in points) instead of
 * importing a PDF library, so wrapping/pagination are unit-testable without
 * rendering. No DOM, no network, no storage.
 *
 * Layout rules (deterministic — no clocks, no randomness):
 * - One column, conventional margins, no tables/columns/graphics.
 * - A section heading is kept with the first line of its content when it fits
 *   (`keepWithNext`): it is moved to the next page rather than left orphaned.
 * - Body text, bullets and long unbroken tokens (URLs, long words) are broken
 *   at the measured width so nothing overflows the margin.
 */
import type { TailoredResume } from '../schemas';

export type PdfTextStyle =
  | 'name'
  | 'headline'
  | 'contact'
  | 'rule'
  | 'sectionTitle'
  | 'entryTitle'
  | 'entryMeta'
  | 'body'
  | 'bullet';

export interface PdfStyleSpec {
  size: number;
  bold: boolean;
  lineHeight: number;
  spaceBefore: number;
  indent: number;
  keepWithNext: boolean;
  /** 'rule' emits a horizontal separator line instead of text. */
  kind: 'text' | 'rule';
}

export const PDF_STYLES: Record<PdfTextStyle, PdfStyleSpec> = {
  name: { size: 19, bold: true, lineHeight: 24, spaceBefore: 0, indent: 0, keepWithNext: false, kind: 'text' },
  headline: { size: 11.5, bold: false, lineHeight: 16, spaceBefore: 3, indent: 0, keepWithNext: false, kind: 'text' },
  contact: { size: 9.5, bold: false, lineHeight: 14, spaceBefore: 3, indent: 0, keepWithNext: false, kind: 'text' },
  rule: { size: 0, bold: false, lineHeight: 14, spaceBefore: 10, indent: 0, keepWithNext: false, kind: 'rule' },
  sectionTitle: { size: 12, bold: true, lineHeight: 18, spaceBefore: 17, indent: 0, keepWithNext: true, kind: 'text' },
  entryTitle: { size: 10.5, bold: true, lineHeight: 15, spaceBefore: 10, indent: 0, keepWithNext: false, kind: 'text' },
  entryMeta: { size: 9.5, bold: false, lineHeight: 13, spaceBefore: 2, indent: 0, keepWithNext: false, kind: 'text' },
  body: { size: 10, bold: false, lineHeight: 14.5, spaceBefore: 4, indent: 0, keepWithNext: false, kind: 'text' },
  bullet: { size: 10, bold: false, lineHeight: 14.5, spaceBefore: 3, indent: 14, keepWithNext: false, kind: 'text' },
};

export interface PdfBlock {
  style: PdfTextStyle;
  text: string;
}

export interface LaidLine {
  style: PdfTextStyle;
  text: string;
  spaceBefore: number;
  indent: number;
}

const PREFERRED_LEVEL_LABELS: Record<string, string> = {
  basic: 'Basic',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  fluent: 'Fluent',
  native: 'Native',
};

function joinMeta(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p.length > 0).join(' | ');
}

function formatDates(start: string, end: string | null): string {
  return `${start} - ${end ?? 'Present'}`;
}

/**
 * Ordered presentation blocks for one validated resume.
 *
 * Only fields PRESENT in the schema are emitted — absent optional sections
 * produce no heading at all. No field outside the schema is ever referenced.
 */
export function buildBlocks(resume: TailoredResume): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  const header = resume.header;

  if (header?.displayName !== undefined) blocks.push({ style: 'name', text: header.displayName });
  // The headline is normally the summary text itself (basis 'profile-headline');
  // show it once, under the name, only when it is NOT already the summary.
  const headlineIsSummary = resume.summary?.basis === 'profile-headline';
  if (header?.headline !== undefined && !headlineIsSummary) {
    blocks.push({ style: 'headline', text: header.headline });
  }
  if (header?.locationLabel !== undefined) {
    blocks.push({ style: 'contact', text: header.locationLabel });
  }
  const links = [resume.links?.portfolio, resume.links?.github, resume.links?.linkedin].filter(
    (l): l is string => l !== undefined,
  );
  if (links.length > 0) blocks.push({ style: 'contact', text: links.join(' | ') });
  if (blocks.length > 0) blocks.push({ style: 'rule', text: '' });

  if (resume.summary !== undefined) {
    blocks.push({ style: 'sectionTitle', text: 'Professional Summary' });
    blocks.push({ style: 'body', text: resume.summary.text });
  }

  if (resume.skills.length > 0) {
    blocks.push({ style: 'sectionTitle', text: 'Skills' });
    blocks.push({
      style: 'body',
      // Verbatim names; years only when the profile supplied them. Relevance
      // tiers and evidence refs are intentionally NOT rendered (internal
      // annotations, not resume content).
      text: resume.skills
        .map((s) => (s.years !== undefined ? `${s.name} (${s.years} yr${s.years === 1 ? '' : 's'})` : s.name))
        .join(', '),
    });
  }

  if (resume.experience.length > 0) {
    blocks.push({ style: 'sectionTitle', text: 'Professional Experience' });
    for (const entry of resume.experience) {
      blocks.push({ style: 'entryTitle', text: `${entry.title} - ${entry.company}` });
      const meta = joinMeta([entry.location, formatDates(entry.dates.start, entry.dates.end)]);
      if (meta.length > 0) blocks.push({ style: 'entryMeta', text: meta });
      for (const bullet of entry.bullets) blocks.push({ style: 'bullet', text: bullet });
    }
  }

  if (resume.projects.length > 0) {
    blocks.push({ style: 'sectionTitle', text: 'Projects' });
    for (const project of resume.projects) {
      blocks.push({ style: 'entryTitle', text: project.name });
      const meta = joinMeta([
        project.dates !== undefined ? formatDates(project.dates.start, project.dates.end) : undefined,
        project.url,
      ]);
      if (meta.length > 0) blocks.push({ style: 'entryMeta', text: meta });
      if (project.description.length > 0) blocks.push({ style: 'body', text: project.description });
      if (project.skills.length > 0) {
        blocks.push({ style: 'entryMeta', text: `Skills: ${project.skills.map((s) => s.name).join(', ')}` });
      }
      if (project.links.length > 0) blocks.push({ style: 'entryMeta', text: project.links.join(' | ') });
    }
  }

  if (resume.education.length > 0) {
    blocks.push({ style: 'sectionTitle', text: 'Education' });
    for (const edu of resume.education) {
      blocks.push({
        style: 'entryTitle',
        text: joinMeta([edu.institution, edu.credential]) || edu.institution,
      });
      const meta = joinMeta([
        edu.fieldOfStudy,
        edu.grade,
        formatDates(edu.dates.start, edu.dates.end),
        edu.inProgress ? 'In progress' : undefined,
      ]);
      if (meta.length > 0) blocks.push({ style: 'entryMeta', text: meta });
    }
  }

  if (resume.certifications.length > 0) {
    blocks.push({ style: 'sectionTitle', text: 'Certifications' });
    for (const cert of resume.certifications) {
      blocks.push({ style: 'entryTitle', text: joinMeta([cert.name, cert.issuer]) || cert.name });
      const meta = joinMeta([
        cert.issued !== undefined ? `Issued ${cert.issued}` : undefined,
        cert.expires !== undefined ? `Expires ${cert.expires}` : undefined,
        cert.credentialUrl,
      ]);
      if (meta.length > 0) blocks.push({ style: 'entryMeta', text: meta });
    }
  }

  if (resume.languages.length > 0) {
    blocks.push({ style: 'sectionTitle', text: 'Languages' });
    blocks.push({
      style: 'body',
      text: resume.languages
        .map((l) => `${l.language} (${PREFERRED_LEVEL_LABELS[l.level] ?? l.level})`)
        .join(', '),
    });
  }

  return blocks;
}

/**
 * Word-wrap one block to `maxWidth` using `measure` (points). Long unbroken
 * tokens are hard-broken character by character so nothing overflows.
 * Hard line breaks inside the source text are preserved.
 */
export function wrapText(
  text: string,
  style: PdfTextStyle,
  maxWidth: number,
  measure: (text: string, style: PdfTextStyle) => number,
): string[] {
  const lines: string[] = [];
  for (const hard of text.split('\n')) {
    const words = hard.split(' ').filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (measure(candidate, style) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      if (measure(word, style) <= maxWidth) {
        current = word;
        continue;
      }
      // Hard-break an over-long token (URL, long word) so it never overflows.
      let chunk = '';
      for (const char of word) {
        const candidateChunk = chunk + char;
        if (measure(candidateChunk, style) <= maxWidth) {
          chunk = candidateChunk;
        } else {
          if (chunk.length > 0) lines.push(chunk);
          chunk = char;
        }
      }
      current = chunk;
    }
    if (current.length > 0) lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

export interface Paragraph {
  style: PdfTextStyle;
  lines: string[];
  spaceBefore: number;
}

/** Wrap every block into a paragraph of positioned-width lines. */
export function wrapBlocks(
  blocks: PdfBlock[],
  maxWidth: number,
  measure: (text: string, style: PdfTextStyle) => number,
): Paragraph[] {
  return blocks.map((block) => {
    const spec = PDF_STYLES[block.style];
    if (spec.kind === 'rule') {
      return { style: block.style, lines: [''], spaceBefore: spec.spaceBefore };
    }
    const width = maxWidth - spec.indent;
    return {
      style: block.style,
      lines: wrapText(block.text, block.style, width, measure),
      spaceBefore: spec.spaceBefore,
    };
  });
}

export interface PaginateOptions {
  pageHeight: number;
  margin: number;
  /** Bottom reserve for the page-number footer. */
  footerHeight: number;
}

/**
 * Flow paragraphs onto pages. A paragraph taller than the usable page is split
 * across pages line by line (never clipped); a heading (`keepWithNext`) that
 * would be the last line on a page moves to the next page together with the
 * first line of the following paragraph.
 */
export function paginate(paragraphs: Paragraph[], options: PaginateOptions): LaidLine[][] {
  const top = options.pageHeight - options.margin;
  const bottom = options.margin + options.footerHeight;
  const pages: LaidLine[][] = [];
  let page: LaidLine[] = [];
  let y = top;

  const breakPage = (): void => {
    pages.push(page);
    page = [];
    y = top;
  };

  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i];
    if (paragraph === undefined) continue;
    const spec = PDF_STYLES[paragraph.style];
    const next = paragraphs[i + 1];
    const nextSpec = next !== undefined ? PDF_STYLES[next.style] : undefined;

    for (let lineIndex = 0; lineIndex < paragraph.lines.length; lineIndex += 1) {
      const isFirst = lineIndex === 0;
      const isLast = lineIndex === paragraph.lines.length - 1;
      const spaceBefore = isFirst && page.length > 0 ? paragraph.spaceBefore : 0;
      const height = spaceBefore + spec.lineHeight;

      // Keep a heading with the first line of the next paragraph.
      const reserve =
        spec.keepWithNext && isLast && nextSpec !== undefined
          ? nextSpec.lineHeight + nextSpec.spaceBefore
          : 0;

      if (page.length > 0 && y - height - reserve < bottom) breakPage();

      page.push({ style: paragraph.style, text: paragraph.lines[lineIndex] ?? '', spaceBefore, indent: spec.indent });
      y -= height;
    }
  }
  if (page.length > 0) pages.push(page);
  if (pages.length === 0) pages.push([]);
  return pages;
}
