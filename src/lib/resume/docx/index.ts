/**
 * Public surface of the ATS-friendly resume DOCX writer (Prompt 20).
 *
 * Kept as its own subpath (like `src/lib/resume/pdf/`) so the tailoring and
 * history layers carry no DOCX/ZIP dependency. It consumes the SAME strict
 * `tailoredResumeSchema` contract and the SAME content blocks as the PDF
 * renderer — no competing schema, no duplicated content mapping.
 */
export { MAX_FILENAME_SLUG, renderResumeDocx, resumeDocxFilename, type ResumeDocxResult } from './render';
export {
  downloadResumeDocx,
  type DocxExportDeps,
  type DocxExportFailure,
  type DocxExportOutcome,
} from './export';
export {
  buildDocxParts,
  buildDocumentXml,
  DOCX_MIME,
  resumeBlockTexts,
  type DocxPart,
} from './document';
export { escapeXmlText, findUnsupportedXmlCodePoints } from './xml';
