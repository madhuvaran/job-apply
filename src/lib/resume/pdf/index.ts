/**
 * Public surface of the ATS-friendly resume PDF renderer (Prompt 12).
 *
 * Kept as a separate subpath from `src/lib/resume/index.ts` so the tailoring
 * engine (Prompt 11) stays free of any PDF dependency. The renderer consumes
 * the SAME strict `tailoredResumeSchema` contract — no competing schema.
 */
export {
  renderResumePdf,
  resumePdfFilename,
  PDF_PAGE,
  type ResumePdfResult,
} from './render';
export { downloadBlob, type DownloadEnvironment, type DownloadResult } from './download';
export {
  downloadResumeSnapshot,
  generateAndDownloadResume,
  type ResumeExportDeps,
  type ResumeExportFailure,
  type ResumeExportOutcome,
  type SnapshotExportFailure,
  type SnapshotExportOutcome,
} from './export';
export {
  buildBlocks,
  paginate,
  wrapBlocks,
  wrapText,
  PDF_STYLES,
  type LaidLine,
  type PdfBlock,
  type PdfStyleSpec,
  type PdfTextStyle,
} from './layout';
export {
  findUnsupportedCodePoints,
  formatCodePoints,
  normalizeForPdf,
} from './text';
