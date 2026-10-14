/**
 * Current-resume export flow (Prompts 12, 19 & 20 follow-up).
 *
 * One profile + one job → ONE validated `TailoredResume`, reused verbatim by
 * every action:
 *
 *   1. tailor once      — `prepareTailoredResume` (src/lib/resume/prepare.ts)
 *   2. PDF              — `downloadTailoredResumePdf` (snapshot in, no tailor)
 *   3. Word (.docx)     — `downloadResumeDocx` (snapshot in, no tailor)
 *   4. save to history  — `saveResumeVersion` (snapshot in, no tailor)
 *
 * The snapshot already prepared for the active inputs is passed back in as
 * `inputs.current`, so a PDF → Word → Save sequence tailors exactly once: the
 * later actions reuse the cached object instead of re-running the engine or
 * maintaining a parallel mapping. `save` is always explicit (one action = one
 * call); nothing here submits an application or changes a status.
 *
 * The whole flow is a plain async function with injectable steps, so the
 * "tailor once, reuse everywhere" guarantee is asserted through behaviour in
 * tests rather than by reading the component's source. Offline: no AI, no
 * network, no permissions.
 */
import type { JobPosting } from '../job-posting';
import type { Profile } from '../profile';
import { downloadResumeDocx, type DocxExportOutcome } from './docx';
import type { ResumeHistoryEntry } from './history';
import {
  saveResumeVersion,
  type ResumeHistoryOutcome,
  type SaveResumeVersionInput,
} from './history-service';
import { downloadTailoredResumePdf, type SnapshotExportOutcome } from './pdf';
import {
  prepareFailureMessage,
  prepareTailoredResume,
  type PrepareOutcomeWord,
  type Tailor,
} from './prepare';
import type { TailoredResume } from './schemas';
import { tailorResume } from './tailor';

/** The three user-visible actions of the current-resume workflow. */
export type CurrentExportAction = 'pdf' | 'docx' | 'save';

export interface CurrentExportInputs {
  /** AI-safe master profile (never the sensitive record). null = unavailable. */
  profile: Profile | null;
  job: JobPosting;
  /**
   * The snapshot already prepared for these exact inputs, if the user has
   * already run an action. When present it is reused AS-IS — no re-tailoring.
   */
  current?: TailoredResume | null;
}

/** Injectable steps (defaults are the real, production implementations). */
export interface CurrentExportDeps {
  /** Step 1 — the tailoring engine. */
  tailor?: Tailor;
  /** Step 2 — render + download the snapshot as a PDF. */
  downloadPdf?: (resume: TailoredResume) => Promise<SnapshotExportOutcome>;
  /** Step 3 — render + download the same snapshot as a Word document. */
  downloadDocx?: (resume: TailoredResume) => Promise<DocxExportOutcome>;
  /** Step 4 — persist the same snapshot to local history. */
  saveVersion?: (input: SaveResumeVersionInput) => Promise<ResumeHistoryOutcome<ResumeHistoryEntry>>;
}

export type CurrentExportOutcome =
  | { ok: true; resume: TailoredResume; notice: string }
  | { ok: false; message: string };

/**
 * Run one action of the current-resume workflow.
 *
 * Returns the exact snapshot that was used (`resume`) so the caller can cache
 * it and pass it back as `current` for the next action. Failures return the
 * step's typed message unchanged — fixed, safe text with no resume, profile or
 * job content.
 */
export async function exportCurrentResume(
  action: CurrentExportAction,
  inputs: CurrentExportInputs,
  deps: CurrentExportDeps = {},
): Promise<CurrentExportOutcome> {
  const word: PrepareOutcomeWord = action === 'save' ? 'saved' : 'generated';

  // Step 1: reuse the snapshot prepared for these inputs, or tailor ONCE now.
  const prepared =
    inputs.current !== null && inputs.current !== undefined
      ? { ok: true as const, resume: inputs.current }
      : prepareTailoredResume(inputs.profile, inputs.job, deps.tailor ?? tailorResume);
  if (!prepared.ok) {
    return { ok: false, message: prepareFailureMessage(prepared.reason, word) };
  }
  const resume = prepared.resume;

  if (action === 'pdf') {
    const download = deps.downloadPdf ?? ((snapshot: TailoredResume) => downloadTailoredResumePdf(snapshot));
    const outcome = await download(resume);
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return {
      ok: true,
      resume,
      notice: `Resume PDF generated (${outcome.pageCount} page${outcome.pageCount === 1 ? '' : 's'}). Check your downloads.`,
    };
  }

  if (action === 'docx') {
    const download = deps.downloadDocx ?? ((snapshot: TailoredResume) => downloadResumeDocx(snapshot));
    const outcome = await download(resume);
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return { ok: true, resume, notice: 'Word document generated. Check your downloads.' };
  }

  const save = deps.saveVersion ?? ((input: SaveResumeVersionInput) => saveResumeVersion(input));
  const outcome = await save({
    resume,
    job: {
      id: inputs.job.id,
      title: inputs.job.title,
      ...(inputs.job.company !== undefined ? { company: inputs.job.company } : {}),
    },
  });
  if (!outcome.ok) return { ok: false, message: outcome.message };
  return { ok: true, resume, notice: 'Resume version saved to local history. Only this browser stores it.' };
}
