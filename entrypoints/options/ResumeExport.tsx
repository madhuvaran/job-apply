/**
 * Resume PDF + DOCX export and save-version (Prompts 12, 19 & 20) — the
 * Options → Jobs resume section for the deterministic tailoring pipeline.
 *
 * All logic lives in one testable helper, `exportCurrentResume`
 * (src/lib/resume/current-export.ts), which tailors the profile + job ONCE and
 * then reuses that exact validated `TailoredResume` for the PDF, the Word
 * export and the explicit history save. This component only handles React
 * state (busy / notice / error / the snapshot generated for the current
 * inputs), so the tailoring engine never runs twice for one action and the
 * three actions can never diverge onto different payloads.
 *
 * It uses the AI-safe profile prop already loaded by the Jobs panel (never the
 * sensitive profile) and produces fixed, safe messages. Saving is always
 * EXPLICIT (a separate button), appends to local history only, and never
 * submits an application or changes any application status. Offline: no AI,
 * no network.
 */
import { useEffect, useState } from 'react';
import { exportCurrentResume, type CurrentExportAction } from '../../src/lib/resume/current-export';
import type { TailoredResume } from '../../src/lib/resume';
import type { Profile } from '../../src/lib/profile';
import type { JobPosting } from '../../src/lib/job-posting';

export interface ResumeExportProps {
  /** AI-safe master profile (never the sensitive record). null = unavailable. */
  profile: Profile | null;
  job: JobPosting;
  /** Called after a version was explicitly saved, so the history list can refresh. */
  onVersionSaved?: () => void;
}

/** Which action is in flight (keeps each button's own label honest). */
type BusyAction = CurrentExportAction | null;

export default function ResumeExport({ profile, job, onVersionSaved }: ResumeExportProps) {
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const busy = busyAction !== null;
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ONE version generated for the CURRENT profile + job, reused so every
  // later action operates on the same validated payload, and the one already
  // saved from it.
  const [generated, setGenerated] = useState<TailoredResume | null>(null);
  const [saved, setSaved] = useState<TailoredResume | null>(null);

  // A new profile or job means a new version could be generated — never
  // claim the previous inputs were saved.
  useEffect(() => {
    setGenerated(null);
    setSaved(null);
  }, [profile, job]);

  const alreadySaved = generated !== null && saved === generated;

  // One handler for all three actions: the orchestrator tailors once (or
  // reuses the cached snapshot) and returns the exact resume it used.
  const run = async (action: CurrentExportAction): Promise<void> => {
    if (busy) return;
    setBusyAction(action);
    setNotice(null);
    setError(null);
    try {
      const outcome = await exportCurrentResume(action, { profile, job, current: generated });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setGenerated(outcome.resume);
      setNotice(outcome.notice);
      if (action === 'save') {
        setSaved(outcome.resume);
        onVersionSaved?.();
      }
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="resume-export">
      <button
        type="button"
        className="primary"
        disabled={busy || profile === null}
        aria-busy={busyAction === 'pdf'}
        onClick={() => void run('pdf')}
      >
        {busyAction === 'pdf' ? 'Generating PDF\u2026' : 'Download tailored resume PDF'}
      </button>
      <button
        type="button"
        disabled={busy || profile === null}
        aria-busy={busyAction === 'docx'}
        onClick={() => void run('docx')}
      >
        {busyAction === 'docx' ? 'Generating DOCX\u2026' : 'Download tailored resume DOCX'}
      </button>
      <button type="button" disabled={busy || profile === null || alreadySaved} onClick={() => void run('save')}>
        {alreadySaved ? 'Version saved' : 'Save version to history'}
      </button>
      <span className="hint">
        Deterministic and offline: selects content that already exists in your profile for this job.
        No AI, no network. Both downloads come from the same tailored result — a PDF or a Word
        (.docx) file — and neither is auto-filled anywhere. Saving stores a fixed snapshot in this
        browser — it does not apply anywhere or change any application status.
      </span>
      {profile === null && (
        <p className="hint" role="status">
          No saved profile yet — add your profile in the Profile tab to generate or save versions.
          Already-saved versions stay viewable and exportable without a profile.
        </p>
      )}
      {notice !== null && <p className="hint" role="status">{notice}</p>}
      {error !== null && <p className="banner banner-error" role="alert">{error}</p>}
    </div>
  );
}
