/**
 * Download pipeline for the ATS-friendly resume DOCX (Prompt 20).
 *
 * Mirrors `src/lib/resume/pdf/export.ts`: it takes an ALREADY-VALIDATED
 * `TailoredResume` and renders + downloads it. It deliberately does NOT call
 * `tailorResume` and does not read the profile, a job posting or storage, so:
 * - the current-resume export reuses the same tailored result as the PDF flow
 *   (the caller supplies it — no second tailoring), and
 * - a historical export always uses the SAVED snapshot, unchanged, and works
 *   even when the original job posting no longer exists.
 *
 * The snapshot is never mutated (it is read-only input). Failures are TYPED
 * outcomes with fixed, safe messages that carry no resume/profile text.
 * Offline: no AI, no network.
 */
import type { TailoredResume } from '../schemas';
import { downloadBlob, type DownloadEnvironment, type DownloadResult } from '../pdf/download';
import { renderResumeDocx } from './render';

export type DocxExportFailure =
  | 'invalid'
  | 'unsupported-characters'
  | 'render-failed'
  | 'download-unavailable';

export type DocxExportOutcome =
  | { ok: true; filename: string }
  | { ok: false; reason: DocxExportFailure; message: string };

export interface DocxExportDeps {
  /** Override the download step (defaults to the isolated `downloadBlob`). */
  download?: (blob: Blob, filename: string) => DownloadResult;
  /** Browser environment passed through to the default download helper. */
  environment?: DownloadEnvironment;
}

/**
 * Render and download one `TailoredResume` as a Word document.
 *
 * `resume` is the ONLY required parameter (no profile, no job), which is what
 * makes a historical export snapshot-only and orphan-safe.
 */
export async function downloadResumeDocx(
  resume: TailoredResume,
  deps: DocxExportDeps = {},
): Promise<DocxExportOutcome> {
  const rendered = await renderResumeDocx(resume);
  if (!rendered.ok) {
    return {
      ok: false,
      reason: rendered.code,
      message:
        rendered.code === 'unsupported-characters'
          ? `Some resume text contains characters that cannot be stored in a Word document: ${rendered.issues.join(', ')}. No file was created.`
          : rendered.code === 'invalid'
            ? 'The tailored resume could not be validated, so no Word document was created.'
            : 'The Word document could not be created, so no file was created.',
    };
  }

  const download =
    deps.download ?? ((blob: Blob, filename: string) => downloadBlob(blob, filename, deps.environment));
  const downloaded = download(rendered.blob, rendered.filename);
  if (!downloaded.ok) {
    return { ok: false, reason: 'download-unavailable', message: downloaded.message };
  }

  return { ok: true, filename: rendered.filename };
}
