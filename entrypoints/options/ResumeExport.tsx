/**
 * Resume PDF export (Prompt 12) — the smallest useful Options → Jobs
 * integration for the deterministic tailoring + PDF pipeline.
 *
 * All logic lives in the testable `generateAndDownloadResume` helper; this
 * component only handles the React state (busy / notice / error). It uses the
 * AI-safe profile prop already loaded by the Jobs panel (never the sensitive
 * profile) and produces fixed, safe messages. Offline: no AI, no network, no
 * storage writes.
 */
import { useState } from 'react';
import { generateAndDownloadResume } from '../../src/lib/resume/pdf';
import type { Profile } from '../../src/lib/profile';
import type { JobPosting } from '../../src/lib/job-posting';

export interface ResumeExportProps {
  /** AI-safe master profile (never the sensitive record). null = unavailable. */
  profile: Profile | null;
  job: JobPosting;
}

export default function ResumeExport({ profile, job }: ResumeExportProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      } else {
        setError(outcome.message);
      }
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
      <span className="hint">
        Deterministic and offline: selects content that already exists in your profile for this job.
        No AI, no network. PDF only (no autofill).
      </span>
      {notice !== null && <p className="hint" role="status">{notice}</p>}
      {error !== null && <p className="banner banner-error" role="alert">{error}</p>}
    </div>
  );
}
