/**
 * Resume PDF + DOCX export and save-version (Prompts 12, 19 & 20) — the
 * Options → Jobs resume section for the deterministic tailoring pipeline.
 *
 * All logic lives in testable helpers (`generateAndDownloadResume`,
 * `downloadResumeDocx`, `tailorResume`, `saveResumeVersion`); this component
 * only handles React state (busy / notice / error / the version generated for
 * the current inputs). It uses the AI-safe profile prop already loaded by the
 * Jobs panel (never the sensitive profile) and produces fixed, safe messages.
 *
 * ONE tailored result per profile + job: the validated `TailoredResume` is
 * cached in state and shared by the PDF export, the DOCX export, and "Save
 * version to history". The DOCX export therefore never calls `tailorResume`
 * itself and never alters the resume content — it renders exactly the payload
 * the other actions use (and the same one a successful PDF download produced).
 *
 * Saving is always EXPLICIT (a separate button), appends to local history
 * only, and never submits an application or changes any application status.
 * Offline: no AI, no network.
 */
import { useEffect, useState } from 'react';
import { generateAndDownloadResume } from '../../src/lib/resume/pdf';
import { downloadResumeDocx } from '../../src/lib/resume/docx';
import { saveResumeVersion, tailorResume, type TailoredResume } from '../../src/lib/resume';
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
type BusyAction = null | 'pdf' | 'docx' | 'save';

export default function ResumeExport({ profile, job, onVersionSaved }: ResumeExportProps) {
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const busy = busyAction !== null;
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The version generated for the CURRENT profile + job (reused so every action
  // operates on the same validated payload) and the one already saved from it.
  const [generated, setGenerated] = useState<TailoredResume | null>(null);
  const [saved, setSaved] = useState<TailoredResume | null>(null);

  // A new profile or job means a new version could be generated — never
  // claim the previous inputs were saved.
  useEffect(() => {
    setGenerated(null);
    setSaved(null);
  }, [profile, job]);

  const alreadySaved = generated !== null && saved === generated;

  const onGenerate = async (): Promise<void> => {
    if (busy) return;
    setBusyAction('pdf');
    setNotice(null);
    setError(null);
    try {
      const outcome = await generateAndDownloadResume(profile, job);
      if (outcome.ok) {
        setNotice(
          `Resume PDF generated (${outcome.pageCount} page${outcome.pageCount === 1 ? '' : 's'}). Check your downloads.`,
        );
        // Capture the exact deterministic payload for the DOCX/save actions.
        if (profile !== null) {
          const tailored = tailorResume(profile, job);
          if (tailored.kind === 'ok') setGenerated(tailored.resume);
        }
      } else {
        setError(outcome.message);
      }
    } finally {
      setBusyAction(null);
    }
  };

  // Word (.docx) export. Renders the SAME validated tailored result as the PDF
  // flow — it is NOT tailored again here, and the payload is never modified.
  const onDownloadDocx = async (): Promise<void> => {
    if (busy) return;
    setBusyAction('docx');
    setNotice(null);
    setError(null);
    try {
      let resume = generated;
      if (resume === null) {
        if (profile === null) {
          setError('No saved profile is available yet — add your profile, then try again.');
          return;
        }
        const tailored = tailorResume(profile, job);
        if (tailored.kind === 'insufficient') {
          setError(
            'Your profile has no supported resume content yet (summary, skills, experience, projects, education, certifications or languages). Nothing was generated.',
          );
          return;
        }
        if (tailored.kind === 'invalid') {
          setError('The saved profile or job posting could not be validated, so no resume was generated.');
          return;
        }
        resume = tailored.resume;
        setGenerated(resume);
      }

      const outcome = await downloadResumeDocx(resume);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setNotice('Word document generated. Check your downloads.');
    } finally {
      setBusyAction(null);
    }
  };

  const onSaveVersion = async (): Promise<void> => {
    if (busy) return;
    setBusyAction('save');
    setNotice(null);
    setError(null);
    try {
      let resume = generated;
      if (resume === null) {
        if (profile === null) {
          setError('No saved profile is available yet — add your profile, then try again.');
          return;
        }
        const tailored = tailorResume(profile, job);
        if (tailored.kind === 'insufficient') {
          setError(
            'Your profile has no supported resume content yet (summary, skills, experience, projects, education, certifications or languages). Nothing was saved.',
          );
          return;
        }
        if (tailored.kind === 'invalid') {
          setError('The saved profile or job posting could not be validated, so no version was saved.');
          return;
        }
        resume = tailored.resume;
        setGenerated(resume);
      }

      const outcome = await saveResumeVersion({
        resume,
        job: { id: job.id, title: job.title, ...(job.company !== undefined ? { company: job.company } : {}) },
      });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setSaved(resume);
      setNotice('Resume version saved to local history. Only this browser stores it.');
      onVersionSaved?.();
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
        onClick={() => void onGenerate()}
      >
        {busyAction === 'pdf' ? 'Generating PDF\u2026' : 'Download tailored resume PDF'}
      </button>
      <button
        type="button"
        disabled={busy || profile === null}
        aria-busy={busyAction === 'docx'}
        onClick={() => void onDownloadDocx()}
      >
        {busyAction === 'docx' ? 'Generating DOCX\u2026' : 'Download tailored resume DOCX'}
      </button>
      <button type="button" disabled={busy || profile === null || alreadySaved} onClick={() => void onSaveVersion()}>
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
