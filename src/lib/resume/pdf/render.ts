/**
 * Fixed-layout, ATS-friendly resume PDF renderer (Prompt 12).
 *
 * `renderResumePdf(input)` validates an untrusted value against the existing
 * STRICT `tailoredResumeSchema` (Prompt 11 — no competing content schema),
 * lays it out with the pure `layout` module, and draws a single-column,
 * selectable-text PDF via `pdf-lib` (a free, browser-only, pure-JS library —
 * no network, no permissions, no native code).
 *
 * Presentation layer ONLY — it never invents, paraphrases, summarises or
 * corrects content, and it renders no field outside the schema (no contact
 * details, no evidence ids, no relevance/selection metadata, no job text).
 * The sensitive profile is never imported or read; nothing is fetched.
 *
 * Typed results (no throws for expected failures):
 * - `invalid`   — input failed strict schema validation (path+code issues).
 * - `unsupported-characters` — text contains code points the built-in WinAnsi
 *   font cannot encode; we refuse rather than emit a corrupted PDF. Only
 *   `U+XXXX` code points are reported (never the source text).
 * - `render-failed` — an unexpected pdf-lib failure.
 *
 * Determinism: identical valid inputs produce byte-identical PDFs — document
 * metadata dates are pinned to the PDF epoch and object streams are disabled,
 * so there is no clock/randomness in the output.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { validateTailoredResume, type TailoredResume } from '../schemas';
import {
  buildBlocks,
  paginate,
  PDF_STYLES,
  wrapBlocks,
  type PdfTextStyle,
} from './layout';
import { findUnsupportedCodePoints, formatCodePoints, normalizeForPdf } from './text';

/** A4 portrait, points. Conventional single-column margins (≈2 cm). */
export const PDF_PAGE = {
  width: 595.28,
  height: 841.89,
  margin: 56,
  footerHeight: 26,
  footerFontSize: 8,
} as const;

/** Fixed metadata date — keeps output byte-identical across runs. */
const PDF_EPOCH = new Date(0);

export type ResumePdfResult =
  | { ok: true; blob: Blob; pageCount: number; filename: string }
  | { ok: false; code: 'invalid'; issues: string[] }
  | { ok: false; code: 'unsupported-characters'; issues: string[] }
  | { ok: false; code: 'render-failed'; issues: string[] };

/** `resume-<job-title-slug>-tailored.pdf` — no PII (job title is public data). */
export function resumePdfFilename(resume: TailoredResume): string {
  const slug = resume.source.jobTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `resume-${slug.length > 0 ? slug : 'tailored'}-tailored.pdf`;
}

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
}

function fontFor(fonts: FontSet, style: PdfTextStyle): PDFFont {
  return PDF_STYLES[style].bold ? fonts.bold : fonts.regular;
}

/**
 * Probe: can the WinAnsi standard font encode `char`? Wrapped in try/catch
 * because pdf-lib throws for code points outside WinAnsi.
 */
function makeEncoder(fonts: FontSet): (char: string) => boolean {
  return (char: string): boolean => {
    try {
      fonts.regular.widthOfTextAtSize(char, 10);
      fonts.bold.widthOfTextAtSize(char, 10);
      return true;
    } catch {
      return false;
    }
  };
}

/** Measure one (already normalized) line in points. */
function makeMeasure(fonts: FontSet): (text: string, style: PdfTextStyle) => number {
  return (text: string, style: PdfTextStyle): number =>
    fontFor(fonts, style).widthOfTextAtSize(text, PDF_STYLES[style].size);
}

function drawPage(
  page: PDFPage,
  lines: ReturnType<typeof paginate>[number],
  fonts: FontSet,
): void {
  let y = PDF_PAGE.height - PDF_PAGE.margin;
  for (const line of lines) {
    y -= line.spaceBefore;
    y -= PDF_STYLES[line.style].lineHeight;
    if (PDF_STYLES[line.style].kind === 'rule') {
      page.drawLine({
        start: { x: PDF_PAGE.margin, y: y + PDF_STYLES[line.style].lineHeight / 2 },
        end: { x: PDF_PAGE.width - PDF_PAGE.margin, y: y + PDF_STYLES[line.style].lineHeight / 2 },
        thickness: 0.75,
        color: rgb(0.7, 0.7, 0.7),
      });
      continue;
    }
    page.drawText(line.text, {
      x: PDF_PAGE.margin + line.indent,
      y,
      size: PDF_STYLES[line.style].size,
      font: fontFor(fonts, line.style),
      color: rgb(0, 0, 0),
    });
  }
}

function drawFooter(page: PDFPage, fonts: FontSet, index: number, total: number): void {
  const text = `Page ${index + 1} of ${total}`;
  const width = fonts.regular.widthOfTextAtSize(text, PDF_PAGE.footerFontSize);
  page.drawText(text, {
    x: (PDF_PAGE.width - width) / 2,
    y: PDF_PAGE.margin / 2,
    size: PDF_PAGE.footerFontSize,
    font: fonts.regular,
    color: rgb(0.4, 0.4, 0.4),
  });
}

/**
 * Render a validated (or untrusted) resume value to a PDF Blob.
 * Never throws for expected user-data failures.
 */
export async function renderResumePdf(input: unknown): Promise<ResumePdfResult> {
  const validation = validateTailoredResume(input);
  if (!validation.ok) return { ok: false, code: 'invalid', issues: validation.issues };
  const resume = validation.resume;

  try {
    const pdf = await PDFDocument.create();
    pdf.setTitle(`${resume.source.jobTitle} - tailored resume`);
    pdf.setAuthor(resume.header?.displayName ?? 'Candidate');
    pdf.setSubject('Tailored resume (deterministic, no AI)');
    pdf.setProducer('Job Apply extension (offline PDF renderer)');
    pdf.setCreator('Job Apply extension');
    pdf.setCreationDate(PDF_EPOCH);
    pdf.setModificationDate(PDF_EPOCH);

    const fonts: FontSet = {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    };

    // Normalize every rendered string, then refuse if any character cannot be
    // encoded (typed error rather than a corrupted resume).
    const blocks = buildBlocks(resume).map((block) => ({
      style: block.style,
      text: normalizeForPdf(block.text),
    }));

    const canEncode = makeEncoder(fonts);
    const unsupported = new Set<number>();
    for (const block of blocks) {
      for (const cp of findUnsupportedCodePoints(block.text, canEncode)) unsupported.add(cp);
    }
    if (unsupported.size > 0) {
      return {
        ok: false,
        code: 'unsupported-characters',
        issues: [
          `Resume text contains characters the built-in PDF font cannot encode: ${formatCodePoints(
            [...unsupported],
          ).join(', ')}.`,
        ],
      };
    }

    const measure = makeMeasure(fonts);
    const maxWidth = PDF_PAGE.width - 2 * PDF_PAGE.margin;
    const paragraphs = wrapBlocks(blocks, maxWidth, measure);
    const pages = paginate(paragraphs, {
      pageHeight: PDF_PAGE.height,
      margin: PDF_PAGE.margin,
      footerHeight: PDF_PAGE.footerHeight,
    });

    const pageObjects = pages.map(() => pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]));
    pageObjects.forEach((page, index) => {
      drawPage(page, pages[index] ?? [], fonts);
      drawFooter(page, fonts, index, pageObjects.length);
    });

    const bytes = await pdf.save({ useObjectStreams: false });
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    return {
      ok: true,
      blob,
      pageCount: pageObjects.length,
      filename: resumePdfFilename(resume),
    };
  } catch (error) {
    // Never surface resume text or library internals that could carry it.
    return {
      ok: false,
      code: 'render-failed',
      issues: [`PDF rendering failed (${error instanceof Error ? error.name : 'unknown'}).`],
    };
  }
}
