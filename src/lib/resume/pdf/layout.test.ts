import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  paginate,
  wrapBlocks,
  wrapText,
  type Paragraph,
  type PdfTextStyle,
} from './layout';
import { baseResume } from './test-support';

/** Equality-only measure: every character is 10 points wide (ignores style). */
const tenPerChar = (text: string, _style: PdfTextStyle): number => text.length * 10;

describe('wrapText', () => {
  it('wraps on word boundaries at the measured width', () => {
    expect(wrapText('aaa bbb ccc ddd', 'body', 70, tenPerChar)).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('hard-breaks a token longer than the line so nothing overflows', () => {
    expect(wrapText('aaaaaaaaaaaa', 'body', 50, tenPerChar)).toEqual(['aaaaa', 'aaaaa', 'aa']);
  });

  it('preserves hard line breaks in the source text', () => {
    expect(wrapText('first\nsecond', 'body', 100, tenPerChar)).toEqual(['first', 'second']);
  });

  it('keeps a long URL unbroken across margin-sized chunks', () => {
    const url = 'https://example.com/a/very/long/path';
    const lines = wrapText(url, 'contact', 100, tenPerChar);
    expect(lines.join('')).toBe(url);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
  });
});

describe('buildBlocks', () => {
  it('emits only sections present in the resume', () => {
    const blocks = buildBlocks(baseResume({ projects: [], education: [], certifications: [], languages: [] }));
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Skills');
    expect(texts).toContain('Professional Experience');
    expect(texts).not.toContain('Projects');
    expect(texts).not.toContain('Education');
    expect(texts).not.toContain('Certifications');
    expect(texts).not.toContain('Languages');
  });

  it('never emits relevance tiers, ids or evidence metadata as text', () => {
    const text = buildBlocks(baseResume())
      .map((b) => b.text)
      .join('\n');
    for (const internal of ['sk-1', 'ex-1', 'pr-1', 'relevant', 'required', 'preferred', 'neutral', 'profile-summary']) {
      expect(text).not.toContain(internal);
    }
  });

  it('shows the headline once when it is also the summary', () => {
    const resume = baseResume({
      header: { displayName: 'Alex Example', headline: 'Backend engineer' },
      summary: { basis: 'profile-headline', text: 'Backend engineer', sourceIds: [] },
    });
    const headlineBlocks = buildBlocks(resume).filter((b) => b.style === 'headline');
    expect(headlineBlocks).toHaveLength(0);
  });

  it('includes a separator rule only when a header is present', () => {
    const withHeader = buildBlocks(baseResume());
    expect(withHeader.some((b) => b.style === 'rule')).toBe(true);
    const bare = buildBlocks(
      baseResume({ header: undefined, links: undefined, summary: undefined, skills: baseResume().skills, experience: [], projects: [], education: [], certifications: [], languages: [] }),
    );
    expect(bare.some((b) => b.style === 'rule')).toBe(false);
  });
});

describe('paginate', () => {
  const opts = { pageHeight: 100, margin: 10, footerHeight: 10 };

  it('moves a heading to the next page rather than leaving it orphaned', () => {
    const fillers: Paragraph[] = Array.from({ length: 3 }, () => ({
      style: 'body',
      lines: ['filler'],
      spaceBefore: 4,
    }));
    const heading: Paragraph = { style: 'sectionTitle', lines: ['Heading'], spaceBefore: 17 };
    const body: Paragraph = { style: 'body', lines: ['content'], spaceBefore: 4 };
    const pages = paginate([...fillers, heading, body], opts);
    const headingPage = pages.findIndex((p) => p.some((l) => l.text === 'Heading'));
    expect(pages.length).toBeGreaterThan(1);
    expect(headingPage).toBeGreaterThan(0);
    const page = pages[headingPage] ?? [];
    // Heading is never the last line on its page.
    expect(page[page.length - 1]?.text).not.toBe('Heading');
  });

  it('splits a paragraph taller than a page across pages without dropping lines', () => {
    const lines = Array.from({ length: 30 }, (_v, i) => `line ${i}`);
    const pages = paginate([{ style: 'body', lines, spaceBefore: 0 }], opts);
    const placed = pages.flat().map((l) => l.text);
    expect(placed).toEqual(lines);
    expect(pages.length).toBeGreaterThan(1);
  });

  it('returns a single empty page for no paragraphs', () => {
    expect(paginate([], opts)).toEqual([[]]);
  });
});

describe('wrapBlocks + paginate integration', () => {
  it('produces at least one laid-out line for a full resume', () => {
    const measure = (text: string, style: PdfTextStyle): number => text.length * (style === 'name' ? 8 : 5);
    const paragraphs = wrapBlocks(buildBlocks(baseResume()), 500, measure);
    const pages = paginate(paragraphs, { pageHeight: 841.89, margin: 56, footerHeight: 26 });
    expect(pages[0]?.length ?? 0).toBeGreaterThan(3);
  });
});
