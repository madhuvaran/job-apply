/**
 * Resume PDF export + save-version (Prompts 12 & 19) — the Options → Jobs
 * resume section for the deterministic tailoring pipeline.
 *
 * All logic lives in testable helpers (`generateAndDownloadResume`,
 * `tailorResume`, `saveResumeVersion`); this component only handles React
 * state (busy / notice / error / the version generated for the current
 * inputs). It uses the AI-safe profile prop already loaded by the Jobs panel
 * (never the sensitive profile) and produces fixed, safe messages.
 *
 * Saving is always EXPLICIT (a separate button), appends to local history
 * only, and never submits an application or changes any application status.
 * The version kept in state is the one that was generated for the current
 * profile + job, so "Save version to history" stores exactly what "Download"
 * produced; it is cleared whenever either input changes. Offline: no AI, no
 * network.
 */
import { useEffect, useState } from 'react';
import { generateAndDownloadResume } from '../../src/lib/resume/pdf';
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

export default function ResumeExport({ profile, job, onVersionSaved }: ResumeExportProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The version generated for the CURRENT profile + job (reused so "save"
  // stores what "download" produced) and the one already saved from it.
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
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const outcome = await generateAndDownloadResume(profile, job);
      if (outcome.ok) {
        setNotice(
          `Resume PDF generated (${outcome.pageCount} page${outcome.pageCount === 1 ? '' : 's'}). Check your downloads.`,
        );
        // Capture the exact deterministic payload for "Save version to history".
        if (profile !== null) {
          const tailored = tailorResume(profile, job);
          if (tailored.kind === 'ok') setGenerated(tailored.resume);
        }
      } else {
        setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSaveVersion = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  return (
    <div className="resume-export">
      <button
        type="button"
        className="primary"
        disabled={busy || profile === null}
        aria-busy={busy}
        onClick={() => void onGenerate()}
      >
        {busy ? 'Generating PDF\u2026' : 'Download tailored resume PDF'}
      </button>
      <button type="button" disabled={busy || profile === null || alreadySaved} onClick={() => void onSaveVersion()}>
        {alreadySaved ? 'Version saved' : 'Save version to history'}
      </button>
      <span className="hint">
        Deterministic and offline: selects content that already exists in your profile for this job.
        No AI, no network. PDF only (no autofill). Saving stores a fixed snapshot in this browser —
        it does not apply anywhere or change any application status.
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
