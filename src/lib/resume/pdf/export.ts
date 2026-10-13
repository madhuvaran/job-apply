/**
 * Tailor → render → download pipeline (Prompt 12), extracted from the React
 * component so the whole flow is unit-testable without a browser.
 *
 * Order of operations (never fabricates a resume):
 * 1. `tailorResume` (Prompt 11) over the AI-safe profile + selected posting.
 * 2. Only on `ok`, `renderResumePdf` the strictly-validated payload.
 * 3. Only on a successful render, hand the Blob to the injected download
 *    helper (default: `downloadBlob`).
 *
 * Every failure is a TYPED outcome with a fixed, safe message — profile/job
 * text is never included, and nothing is written to storage. Offline: no AI,
 * no network.
 */
import type { Profile } from '../../profile';
import type { JobPosting } from '../../job-posting';
import type { TailoredResume } from '../schemas';
import { tailorResume } from '../tailor';
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

export async function generateAndDownloadResume(
  profile: Profile | null,
  job: JobPosting,
  deps: ResumeExportDeps = {},
): Promise<ResumeExportOutcome> {
  if (profile === null) {
    return {
      ok: false,
      reason: 'no-profile',
      message: 'No saved profile is available yet — add your profile, then try again.',
    };
  }

  const tailored = tailorResume(profile, job);
  if (tailored.kind === 'insufficient') {
    return {
      ok: false,
      reason: 'insufficient',
      message:
        'Your profile has no supported resume content yet (summary, skills, experience, projects, education, certifications or languages). Nothing was generated.',
    };
  }
  if (tailored.kind === 'invalid') {
    return {
      ok: false,
      reason: 'invalid',
      message: 'The saved profile or job posting could not be validated, so no resume was generated.',
    };
  }

  const rendered = await renderResumePdf(tailored.resume);
  if (!rendered.ok) {
    return {
      ok: false,
      reason: rendered.code,
      message:
        rendered.code === 'unsupported-characters'
          ? `Some profile text cannot be rendered in the PDF: ${rendered.issues.join(' ')}`
          : 'The resume could not be rendered, so no file was created.',
    };
  }

  const download = deps.download ?? ((blob: Blob, filename: string) => downloadBlob(blob, filename, deps.environment));
  const downloaded = download(rendered.blob, rendered.filename);
  if (!downloaded.ok) {
    return { ok: false, reason: 'download-unavailable', message: downloaded.message };
  }

  return { ok: true, pageCount: rendered.pageCount, filename: rendered.filename };
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

/**
 * Export a SAVED resume version's snapshot (Prompt 19).
 *
 * Renders exactly the provided payload through the existing
 * `renderResumePdf` and hands the Blob to the download helper. It never
 * tailors, never reads the profile or a job posting and never touches
 * storage — so exporting a historical version uses its saved snapshot even
 * after the master profile or the posting has changed. Typed failures with
 * fixed, safe messages (no resume/profile text). Offline: no AI, no network.
 */
export async function downloadResumeSnapshot(
  snapshot: TailoredResume,
  deps: ResumeExportDeps = {},
): Promise<SnapshotExportOutcome> {
  const rendered = await renderResumePdf(snapshot);
  if (!rendered.ok) {
    return {
      ok: false,
      reason: rendered.code,
      message:
        rendered.code === 'unsupported-characters'
          ? `Some profile text cannot be rendered in the PDF: ${rendered.issues.join(' ')}`
          : 'The saved resume version could not be rendered, so no file was created.',
    };
  }

  const download =
    deps.download ?? ((blob: Blob, filename: string) => downloadBlob(blob, filename, deps.environment));
  const downloaded = download(rendered.blob, rendered.filename);
  if (!downloaded.ok) {
    return { ok: false, reason: 'download-unavailable', message: downloaded.message };
  }

  return { ok: true, pageCount: rendered.pageCount, filename: rendered.filename };
}
