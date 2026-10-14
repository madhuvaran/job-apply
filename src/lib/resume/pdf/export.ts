/**
 * Tailor → render → download pipeline (Prompt 12), extracted from the React
 * component so the whole flow is unit-testable without a browser.
 *
 * Order of operations (never fabricates a resume):
 * 1. `prepareTailoredResume` (steps the Prompt 11 tailoring engine exactly
 *    once) over the AI-safe profile + selected posting.
 * 2. Only on `ok`, `renderResumePdf` the strictly-validated payload.
 * 3. Only on a successful render, hand the Blob to the injected download
 *    helper (default: `downloadBlob`).
 *
 * Every failure is a TYPED outcome with a fixed, safe message — profile/job
 * text is never included, and nothing is written to storage. Offline: no AI,
 * no network.
 *
 * Three exports share ONE render+download tail:
 * - `generateAndDownloadResume` — the original tailor+render+download entry
 *   point. Its public interface and behaviour are unchanged (existing callers
 *   keep working).
 * - `downloadTailoredResumePdf` — render+download an ALREADY-PREPARED current
 *   resume, so the PDF action reuses the one validated snapshot instead of
 *   tailoring a second time.
 * - `downloadResumeSnapshot` — render+download a SAVED history version.
 */
import type { Profile } from '../../profile';
import type { JobPosting } from '../../job-posting';
import type { TailoredResume } from '../schemas';
import { prepareFailureMessage, prepareTailoredResume } from '../prepare';
import { renderResumePdf } from './render';
import { downloadBlob, type DownloadEnvironment, type DownloadResult } from './download';

export type ResumeExportFailure =
  | 'no-profile'
  | 'insufficient'
  | 'invalid'
  | 'render-failed'
  | 'unsupported-characters'
  | 'download-unavailable';

export type ResumeExportOutcome =
  | { ok: true; pageCount: number; filename: string }
  | { ok: false; reason: ResumeExportFailure; message: string };

export interface ResumeExportDeps {
  /** Override the download step (defaults to the isolated `downloadBlob`). */
  download?: (blob: Blob, filename: string) => DownloadResult;
  /** Browser environment passed through to the default download helper. */
  environment?: DownloadEnvironment;
}

/** Failure reasons a saved-snapshot export can produce (no tailoring step). */
export type SnapshotExportFailure =
  | 'invalid'
  | 'unsupported-characters'
  | 'render-failed'
  | 'download-unavailable';

export type SnapshotExportOutcome =
  | { ok: true; pageCount: number; filename: string }
  | { ok: false; reason: SnapshotExportFailure; message: string };

/** Render-failure text for a resume generated for the CURRENT inputs. */
const CURRENT_RENDER_FAILED_MESSAGE = 'The resume could not be rendered, so no file was created.';
/** Render-failure text for a SAVED history version's snapshot. */
const SNAPSHOT_RENDER_FAILED_MESSAGE = 'The saved resume version could not be rendered, so no file was created.';

/**
 * Shared render + download tail: render a validated payload and hand the Blob
 * to the download helper. `renderFailedMessage` keeps each entry point's own
 * wording while the logic (and the typed failure set) stays single-sourced.
 */
async function renderAndDownloadPdf(
  resume: TailoredResume,
  deps: ResumeExportDeps,
  renderFailedMessage: string,
): Promise<SnapshotExportOutcome> {
  const rendered = await renderResumePdf(resume);
  if (!rendered.ok) {
    return {
      ok: false,
      reason: rendered.code,
      message:
        rendered.code === 'unsupported-characters'
          ? `Some profile text cannot be rendered in the PDF: ${rendered.issues.join(' ')}`
          : renderFailedMessage,
    };
  }

  const download = deps.download ?? ((blob: Blob, filename: string) => downloadBlob(blob, filename, deps.environment));
  const downloaded = download(rendered.blob, rendered.filename);
  if (!downloaded.ok) {
    return { ok: false, reason: 'download-unavailable', message: downloaded.message };
  }

  return { ok: true, pageCount: rendered.pageCount, filename: rendered.filename };
}

export async function generateAndDownloadResume(
  profile: Profile | null,
  job: JobPosting,
  deps: ResumeExportDeps = {},
): Promise<ResumeExportOutcome> {
  const prepared = prepareTailoredResume(profile, job);
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.reason,
      message: prepareFailureMessage(prepared.reason, 'generated'),
    };
  }

  return renderAndDownloadPdf(prepared.resume, deps, CURRENT_RENDER_FAILED_MESSAGE);
}

/**
 * Export a SAVED resume version's snapshot (Prompt 19).
 *
 * Renders exactly the provided payload through the existing `renderResumePdf`
 * and hands the Blob to the download helper. It never tailors, never reads the
 * profile or a job posting and never touches storage — so exporting a
 * historical version uses its saved snapshot even after the master profile or
 * the posting has changed. Typed failures with fixed, safe messages (no
 * resume/profile text). Offline: no AI, no network.
 */
export async function downloadResumeSnapshot(
  snapshot: TailoredResume,
  deps: ResumeExportDeps = {},
): Promise<SnapshotExportOutcome> {
  return renderAndDownloadPdf(snapshot, deps, SNAPSHOT_RENDER_FAILED_MESSAGE);
}

/**
 * Export the CURRENT tailored resume (Prompt 20 follow-up).
 *
 * Takes the ONE already-validated `TailoredResume` the current-resume flow
 * prepared for the active profile + job and renders it — so the PDF action
 * never calls the tailoring engine again, and the Word export and the explicit
 * history save all operate on this exact same object. The payload is read-only
 * input: it is not mutated. Typed failures with fixed, safe messages. No
 * profile/job read, no storage write, no network.
 */
export async function downloadTailoredResumePdf(
  resume: TailoredResume,
  deps: ResumeExportDeps = {},
): Promise<SnapshotExportOutcome> {
  return renderAndDownloadPdf(resume, deps, CURRENT_RENDER_FAILED_MESSAGE);
}
