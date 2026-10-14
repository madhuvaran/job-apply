/**
 * Minimal, explicit WordprocessingML (Office Open XML) builder for the
 * ATS-friendly resume DOCX (Prompt 20).
 *
 * Design (deliberately conservative for machine parsing):
 * - ONE column of ordinary PARAGRAPHS. No tables, no text boxes, no columns,
 *   no drawings/pictures, no shapes — nothing an ATS has to interpret.
 * - The content and SECTION ORDER come from the SAME source as the PDF:
 *   `buildBlocks()` (src/lib/resume/pdf/layout.ts) is reused, so both formats
 *   render identical resume text, headings and ordering for one validated
 *   `TailoredResume`. No resume text is generated, re-worded or dropped here.
 * - Every value is escaped through `escapeXmlText`; nothing untrusted is
 *   concatenated into markup.
 * - No `docProps/core.xml` or `docProps/app.xml` parts are emitted at all, so
 *   there is NO hidden metadata (no creator, no creation/modification time, no
 *   application name) inside the file. Hyperlinks are NOT used — link URLs are
 *   rendered as plain selectable text, exactly like the PDF.
 * - Bullets use a real Word list definition (`numbering.xml`), not a typed
 *   character, so the list survives round-tripping.
 *
 * Pure module: no DOM, no network, no storage, no clock, no sensitive data.
 */
import { buildBlocks, type PdfTextStyle } from '../pdf/layout';
import type { TailoredResume } from '../schemas';
import { escapeXmlText } from './xml';

/** IANA media type of a `.docx` package. */
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const NUMBERING_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const DOCUMENT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const STYLES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const NUMBERING_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

/** Base typeface: Arial (widely available; matches the PDF's Helvetica look). */
const FONT = 'Arial';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

interface ParagraphSpec {
  /** Font size in HALF-POINTS (WordprocessingML `w:sz`). */
  halfPointSize: number;
  bold: boolean;
  /** Space before the paragraph, in TWIPS (1/20 pt). */
  spaceBefore: number;
  bullet: boolean;
  /** Emit a horizontal rule (paragraph bottom border) instead of text. */
  rule: boolean;
  /** Mark as a document outline heading (heading structure only, no theme). */
  heading: boolean;
  /** Left indent in twips (list paragraphs). */
  indent: number;
}

/**
 * Presentation specs mirror `PDF_STYLES` (which the PDF layout engine uses), so
 * the PDF and DOCX exports of one resume read the same way. Word units:
 * font size = half-points, spacing/indent = twips.
 */
const SPECS: Record<PdfTextStyle, ParagraphSpec> = {
  name: { halfPointSize: 38, bold: true, spaceBefore: 0, bullet: false, rule: false, heading: false, indent: 0 },
  headline: { halfPointSize: 23, bold: false, spaceBefore: 60, bullet: false, rule: false, heading: false, indent: 0 },
  contact: { halfPointSize: 19, bold: false, spaceBefore: 60, bullet: false, rule: false, heading: false, indent: 0 },
  rule: { halfPointSize: 0, bold: false, spaceBefore: 200, bullet: false, rule: true, heading: false, indent: 0 },
  sectionTitle: { halfPointSize: 24, bold: true, spaceBefore: 340, bullet: false, rule: false, heading: true, indent: 0 },
  entryTitle: { halfPointSize: 21, bold: true, spaceBefore: 200, bullet: false, rule: false, heading: false, indent: 0 },
  entryMeta: { halfPointSize: 19, bold: false, spaceBefore: 40, bullet: false, rule: false, heading: false, indent: 0 },
  body: { halfPointSize: 20, bold: false, spaceBefore: 80, bullet: false, rule: false, heading: false, indent: 0 },
  bullet: { halfPointSize: 20, bold: false, spaceBefore: 60, bullet: true, rule: false, heading: false, indent: 432 },
};

/** WordprocessingML child order is schema-significant; keep these in order. */
function runProperties(spec: ParagraphSpec): string {
  const parts: string[] = [];
  parts.push(`<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`);
  if (spec.bold) parts.push('<w:b/><w:bCs/>');
  parts.push(`<w:sz w:val="${spec.halfPointSize}"/><w:szCs w:val="${spec.halfPointSize}"/>`);
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

/** CT_PPr child order: keepNext, numPr, pBdr, spacing, ind, outlineLvl. */
function paragraphProperties(spec: ParagraphSpec): string {
  const parts: string[] = [];
  if (spec.heading) parts.push('<w:keepNext/>');
  if (spec.bullet) parts.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  if (spec.rule) {
    parts.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>');
  }
  parts.push(`<w:spacing w:before="${spec.spaceBefore}" w:after="0" w:line="240" w:lineRule="auto"/>`);
  if (spec.indent > 0) parts.push(`<w:ind w:left="${spec.indent}" w:hanging="216"/>`);
  if (spec.heading) parts.push('<w:outlineLvl w:val="0"/>');
  return `<w:pPr>${parts.join('')}</w:pPr>`;
}

function paragraphXml(style: PdfTextStyle, text: string): string {
  const spec = SPECS[style];
  if (spec.rule) return `<w:p>${paragraphProperties(spec)}</w:p>`;
  return `<w:p>${paragraphProperties(spec)}<w:r>${runProperties(spec)}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r></w:p>`;
}

/** A4 portrait with 2 cm margins (1134 twips), matching the PDF page setup. */
const SECTION_PROPERTIES =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>' +
  '</w:sectPr>';

/**
 * The resume as WordprocessingML body paragraphs (content and order from
 * `buildBlocks`, the single source of truth shared with the PDF renderer).
 */
export function buildDocumentXml(resume: TailoredResume): string {
  const body = buildBlocks(resume)
    .map((block) => paragraphXml(block.style, block.text))
    .join('');
  return `${XML_DECLARATION}<w:document xmlns:w="${W_NS}"><w:body>${body}${SECTION_PROPERTIES}</w:body></w:document>`;
}

/** Every renderable text string, for the character-validity pre-check. */
export function resumeBlockTexts(resume: TailoredResume): string[] {
  return buildBlocks(resume).map((block) => block.text);
}

function contentTypesXml(): string {
  return (
    `${XML_DECLARATION}<Types xmlns="${CONTENT_TYPES_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/>` +
    `<Override PartName="/word/styles.xml" ContentType="${STYLES_CONTENT_TYPE}"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="${NUMBERING_CONTENT_TYPE}"/>` +
    '</Types>'
  );
}

function packageRelsXml(): string {
  return (
    `${XML_DECLARATION}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL}" Target="word/document.xml"/>` +
    '</Relationships>'
  );
}

function documentRelsXml(): string {
  return (
    `${XML_DECLARATION}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${STYLES_REL}" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${NUMBERING_REL}" Target="numbering.xml"/>` +
    '</Relationships>'
  );
}

/** Document defaults only (base font + single line spacing) — no named styles. */
function stylesXml(): string {
  return (
    `${XML_DECLARATION}<w:styles xmlns:w="${W_NS}"><w:docDefaults>` +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults></w:styles>'
  );
}

/** One real bullet list definition (numId 1) used by every bullet paragraph. */
function numberingXml(): string {
  return (
    `${XML_DECLARATION}<w:numbering xmlns:w="${W_NS}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
    `<w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/>` +
    '<w:pPr><w:ind w:left="432" w:hanging="216"/></w:pPr>' +
    `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:hint="default"/></w:rPr>` +
    '</w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
  );
}

export interface DocxPart {
  /** ZIP entry name inside the package. */
  path: string;
  /** UTF-8 XML content. */
  content: string;
}

/**
 * The Office Open XML parts, in package order. `[Content_Types].xml` MUST be
 * first. No `docProps/*` part is emitted (no hidden metadata).
 */
export function buildDocxParts(resume: TailoredResume): DocxPart[] {
  return [
    { path: '[Content_Types].xml', content: contentTypesXml() },
    { path: '_rels/.rels', content: packageRelsXml() },
    { path: 'word/document.xml', content: buildDocumentXml(resume) },
    { path: 'word/_rels/document.xml.rels', content: documentRelsXml() },
    { path: 'word/styles.xml', content: stylesXml() },
    { path: 'word/numbering.xml', content: numberingXml() },
  ];
}
