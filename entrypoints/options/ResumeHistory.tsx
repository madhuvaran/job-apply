/**
 * Options → Jobs: local tailored resume version history (Prompt 19).
 *
 * - Reads/writes ONLY through the resume-history service
 *   (`src/lib/resume/history-service.ts`), which uses the validated storage
 *   service (key `job-resume-history.v1`). No direct `chrome.storage`, no
 *   network, no AI, no sensitive profile.
 * - Saving happens only from the resume section's explicit button; this panel
 *   lists saved versions, opens one, exports its SAVED snapshot (never a
 *   re-tailored resume) and deletes — always behind a two-step confirmation.
 * - Malformed history is NEVER overwritten: a malformed record shows a banner
 *   and requires an explicit "Discard malformed history" confirmation.
 * - A missing saved job is an orphaned reference only: the version is kept
 *   and shown with the existing orphaned label; nothing is discarded.
 * - Messages are fixed strings; they never include resume or profile content.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  deleteResumeVersion,
  listResumeVersions,
  type ResumeHistoryEntry,
} from '../../src/lib/resume';
import { downloadResumeSnapshot } from '../../src/lib/resume/pdf';
import { loadJobPostings, resetResumeHistory } from '../../src/lib/storage';
import { Section } from './ui';
import ResumeVersionList from './ResumeVersionList';

type LoadState = 'loading' | 'ready' | 'malformed' | 'unavailable';

export interface ResumeHistoryProps {
  /** Bump to reload after a new version was saved in the resume section. */
  refreshToken?: number;
}

export default function ResumeHistory({ refreshToken = 0 }: ResumeHistoryProps) {
  const [entries, setEntries] = useState<ResumeHistoryEntry[]>([]);
  const [orphanedJobIds, setOrphanedJobIds] = useState<ReadonlySet<string>>(new Set());
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [jobsState, setJobsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [versions, jobs] = await Promise.all([listResumeVersions(), loadJobPostings()]);

    // Resolve job references for the orphaned flag. If the job list itself is
    // unreadable we never claim a job was deleted — an info note explains it.
    if (jobs.ok || jobs.reason === 'absent') {
      const known = new Set(jobs.ok ? jobs.data.postings.map((p) => p.id) : []);
      setOrphanedJobIds(
        new Set(
          versions.ok
            ? versions.data
                .map((v) => v.jobId)
                .filter((id): id is string => id !== undefined && !known.has(id))
            : [],
        ),
      );
      setJobsState('ready');
    } else {
      setOrphanedJobIds(new Set());
      setJobsState('error');
    }

    if (versions.ok) {
      setEntries(versions.data);
      setLoadState('ready');
      return;
    }
    if (versions.reason === 'malformed') {
      setLoadState('malformed');
      setLoadMessage(versions.message);
      return;
    }
    setLoadState('unavailable');
    setLoadMessage(versions.message);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const onToggleOpen = useCallback((id: string) => {
    setConfirmingDeleteId(null);
    setOpenId((current) => (current === id ? null : id));
  }, []);

  const onExport = useCallback(
    async (id: string) => {
      if (busy) return;
      const entry = entries.find((e) => e.id === id);
      if (entry === undefined) {
        setError('That saved resume version no longer exists.');
        return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        // Renders the STORED snapshot — never re-tailors from the current profile.
        const outcome = await downloadResumeSnapshot(entry.snapshot);
        if (!outcome.ok) {
          setError(outcome.message);
          return;
        }
        setNotice(
          `Saved version exported (${outcome.pageCount} page${outcome.pageCount === 1 ? '' : 's'}). Check your downloads.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, entries],
  );

  const onConfirmDelete = useCallback(async (id: string) => {
    setConfirmingDeleteId(null);
    setError(null);
    setNotice(null);
    const outcome = await deleteResumeVersion(id);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setEntries(outcome.data);
    setOpenId((current) => (current === id ? null : current));
    setNotice('Saved version deleted.');
  }, []);

  const onDiscardMalformed = useCallback(async () => {
    setConfirmingDiscard(false);
    setError(null);
    setNotice(null);
    const res = await resetResumeHistory();
    if (res !== null && !res.ok) {
      setError(res.message);
      return;
    }
    setEntries([]);
    setOrphanedJobIds(new Set());
    setLoadMessage('');
    setLoadState('ready');
    setNotice('Malformed resume history discarded. Profile, jobs and applications were not touched.');
  }, []);

  return (
    <Section title="Resume version history">
      {loadState === 'loading' && <p className="hint">Loading saved versions…</p>}

      {loadState === 'unavailable' && (
        <div className="banner banner-error" role="alert">
          {loadMessage}
        </div>
      )}

      {loadState === 'malformed' && (
        <div className="banner banner-error" role="alert">
          <p>Stored resume history is malformed and could not be loaded. {loadMessage}</p>
          <p>
            Your saved versions have NOT been overwritten. You can discard the malformed history
            explicitly — profile, jobs and applications are never touched.
          </p>
          {!confirmingDiscard ? (
            <button type="button" onClick={() => setConfirmingDiscard(true)}>
              Discard malformed history…
            </button>
          ) : (
            <span>
              <button type="button" className="danger" disabled={busy} onClick={() => void onDiscardMalformed()}>
                Yes, discard
              </button>
              <button type="button" onClick={() => setConfirmingDiscard(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}

      {jobsState === 'error' && loadState === 'ready' && (
        <div className="banner banner-info" role="status">
          The saved job list could not be read, so job references below cannot be confirmed. Your
          saved resume versions are unaffected.
        </div>
      )}

      {notice !== null && (
        <div className="banner banner-info" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {loadState === 'ready' && (
        <>
          {entries.length === 0 ? (
            <p className="hint">
              No saved resume versions yet. Generate a resume for a saved job above, then click
              &quot;Save version to history&quot;.
            </p>
          ) : (
            <ResumeVersionList
              entries={entries}
              orphanedJobIds={orphanedJobIds}
              openId={openId}
              confirmingDeleteId={confirmingDeleteId}
              busy={busy}
              onToggleOpen={onToggleOpen}
              onExport={(id) => void onExport(id)}
              onAskDelete={setConfirmingDeleteId}
              onCancelDelete={() => setConfirmingDeleteId(null)}
              onConfirmDelete={(id) => void onConfirmDelete(id)}
            />
          )}
          <p className="hint">
            Versions are stored only in this browser (local storage key <code>job-resume-history.v1</code>)
            and are never sent anywhere. Exporting uses each version&apos;s saved snapshot, so later
            profile or job edits never change it. Nothing here applies to a job or changes an
            application status.
          </p>
        </>
      )}
    </Section>
  );
}
