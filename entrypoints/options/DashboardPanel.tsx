/**
 * Options page — "Dashboard" tab (Prompt 30).
 *
 * A READ-ONLY overview of data this browser already stores: saved job postings,
 * the application log, the existing deterministic match estimates and the pure
 * prioritization result. It adds no hosting, no paid service, no credential, no
 * new permission and no dependency; it performs **no network request**, no live
 * Adzuna search, no AI call, no background polling and no automatic application.
 *
 * Data access: exactly ONE validated read per source on mount (and again only
 * when the user presses Refresh). Nothing is written, nothing is merged and a
 * malformed record is never overwritten — the panel explains what could not be
 * read and marks only the affected metrics as unavailable (never as zero).
 *
 * The counts, classifications, ordering and labels all come from
 * `buildDashboardSnapshot()` (`src/lib/dashboard`), which reuses
 * `prioritizeJobs()` and never re-scores anything here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { calculateJobMatch } from '../../src/lib/matching';
import { localCalendarDate } from '../../src/lib/job-dates';
import {
  defaultSettings,
  type Settings,
} from '../../src/lib/settings';
import {
  loadApplications,
  loadJobPostings,
  loadProfile,
  loadSettings,
} from '../../src/lib/storage';
import type { Application } from '../../src/lib/applications';
import type { JobPosting } from '../../src/lib/job-posting';
import type { Profile } from '../../src/lib/profile';
import {
  buildDashboardSnapshot,
  DASHBOARD_METRIC_KEYS,
  DASHBOARD_METRIC_META,
  DASHBOARD_UNAVAILABLE_MESSAGES,
  type DashboardOutcome,
  type DashboardSnapshot,
} from '../../src/lib/dashboard';
import { Section } from './ui';

/** Options tabs the dashboard may navigate to (all already exist). */
export type DashboardNavTarget = 'jobs' | 'applications' | 'search' | 'settings';

export interface DashboardPanelProps {
  /**
   * Navigate to an existing tab. `jobId` asks the Jobs tab to open that saved
   * job's details (match summary + resume section). Never submits anything.
   */
  onNavigate: (target: DashboardNavTarget, jobId?: string) => void;
}

/** One storage source's read state (never conflated with "empty"). */
type Loaded<T> =
  | { kind: 'loading' }
  | { kind: 'ok'; data: T }
  | { kind: 'absent' }
  | { kind: 'failed'; message: string };

type SnapshotState = { kind: 'loading' } | DashboardOutcome;

export default function DashboardPanel({ onNavigate }: DashboardPanelProps) {
  const [jobs, setJobs] = useState<Loaded<JobPosting[]>>({ kind: 'loading' });
  const [applications, setApplications] = useState<Loaded<Application[]>>({ kind: 'loading' });
  const [profile, setProfile] = useState<Loaded<Profile>>({ kind: 'loading' });
  const [settings, setSettings] = useState<Loaded<Settings>>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  // Bumped by the explicit Refresh button only — there is no timer and no
  // storage-change listener, so nothing polls in the background.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setJobs({ kind: 'loading' });
    setApplications({ kind: 'loading' });
    setProfile({ kind: 'loading' });
    setSettings({ kind: 'loading' });
    void (async () => {
      // One read per source, in parallel; each result keeps its own state so a
      // single failure cannot be reported as "nothing stored".
      const [jobsRes, applicationsRes, profileRes, settingsRes] = await Promise.all([
        loadJobPostings(),
        loadApplications(),
        loadProfile(),
        loadSettings(),
      ]);
      if (cancelled) return;

      setJobs(
        jobsRes.ok
          ? { kind: 'ok', data: jobsRes.data.postings }
          : jobsRes.reason === 'absent'
            ? { kind: 'absent' }
            : { kind: 'failed', message: jobsRes.message },
      );
      setApplications(
        applicationsRes.ok
          ? { kind: 'ok', data: applicationsRes.data.applications }
          : applicationsRes.reason === 'absent'
            ? { kind: 'absent' }
            : { kind: 'failed', message: applicationsRes.message },
      );
      setProfile(
        profileRes.ok
          ? { kind: 'ok', data: profileRes.data }
          : profileRes.reason === 'absent'
            ? { kind: 'absent' }
            : { kind: 'failed', message: profileRes.message },
      );
      setSettings(
        settingsRes.ok
          ? { kind: 'ok', data: settingsRes.data }
          : settingsRes.reason === 'absent'
            ? // Schema default (minimum 0 = filtering off) — same documented
              // behavior the Jobs tab uses for an absent settings record.
              { kind: 'ok', data: defaultSettings() }
            : { kind: 'failed', message: settingsRes.message },
      );
      setBusy(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const snapshotState = useMemo<SnapshotState>(() => {
    if (
      jobs.kind === 'loading' ||
      applications.kind === 'loading' ||
      profile.kind === 'loading' ||
      settings.kind === 'loading'
    ) {
      return { kind: 'loading' };
    }
    // `absent` = the list was never written → reliably empty. Anything else
    // unreadable stays `null` and is reported as unavailable, never as 0.
    const postings = jobs.kind === 'ok' ? jobs.data : jobs.kind === 'absent' ? [] : null;
    // `absent` = the log was never written → reliably empty. Anything else
    // unreadable fails closed to `null` (unknown, never "no applications").
    const applicationRecords =
      applications.kind === 'ok' ? applications.data : applications.kind === 'absent' ? [] : null;
    const savedProfile = profile.kind === 'ok' ? profile.data : null;
    const loadedSettings = settings.kind === 'ok' ? settings.data : null;
    // Match estimates are computed ONCE per data load (never per row, never in
    // a loop over renders) by the existing deterministic estimator.
    const matches =
      postings !== null && savedProfile !== null && loadedSettings !== null
        ? postings.map((job) => ({
            jobId: job.id,
            result: calculateJobMatch(savedProfile, job, loadedSettings),
          }))
        : [];
    return buildDashboardSnapshot({
      jobs: postings,
      applications: applicationRecords,
      matches,
      minMatchThreshold: loadedSettings === null ? null : loadedSettings.minMatchThreshold,
      profileAvailable: savedProfile !== null,
      today: localCalendarDate(),
    });
  }, [jobs, applications, profile, settings]);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const loading =
    jobs.kind === 'loading' ||
    applications.kind === 'loading' ||
    profile.kind === 'loading' ||
    settings.kind === 'loading';

  return (
    <div className="dashboard-panel">
      <div className="dashboard-toolbar">
        <p className="hint">
          Everything below is computed offline from data stored in this browser. The dashboard does
          not search the web, fetch listings or contact any service, and it never applies to a job.
        </p>
        <button type="button" onClick={refresh} disabled={busy || loading}>
          {busy || loading ? 'Refreshing…' : 'Refresh dashboard'}
        </button>
      </div>

      {jobs.kind === 'failed' && (
        <div className="banner banner-error" role="alert">
          <strong>Saved jobs could not be read.</strong> {jobs.message} Nothing was changed; open
          Jobs to inspect the stored data.
        </div>
      )}
      {applications.kind === 'failed' && (
        <div className="banner banner-error" role="alert">
          <strong>The application log could not be read.</strong> {applications.message} Nothing was
          changed; open Applications to inspect it.
        </div>
      )}

      {snapshotState.kind === 'loading' && (
        <div className="banner banner-info" role="status">
          Loading dashboard…
        </div>
      )}

      {snapshotState.kind === 'invalid' && (
        <div className="banner banner-error" role="alert">
          Dashboard unavailable: {snapshotState.issues.join('; ')}. Nothing was changed.
        </div>
      )}

      {snapshotState.kind === 'valid' && (
        <DashboardBody
          snapshot={snapshotState.snapshot}
          onNavigate={onNavigate}
          applicationsEmpty={
            applications.kind === 'absent' ||
            (applications.kind === 'ok' && applications.data.length === 0)
          }
        />
      )}
    </div>
  );
}

function DashboardBody({
  snapshot,
  onNavigate,
  applicationsEmpty,
}: {
  snapshot: DashboardSnapshot;
  onNavigate: DashboardPanelProps['onNavigate'];
  applicationsEmpty: boolean;
}) {
  const { metrics, shortlist, notes } = snapshot;
  const noSavedJobs = metrics.savedJobs.kind === 'value' && metrics.savedJobs.value === 0;

  return (
    <>
      <Section title="Overview">
        {notes.length > 0 && (
          <ul className="dashboard-notes" data-field="notes">
            {notes.map((note) => (
              <li key={note} className="hint">
                {note}
              </li>
            ))}
          </ul>
        )}

        <dl className="dashboard-metrics" aria-label="Dashboard metrics">
          {DASHBOARD_METRIC_KEYS.map((key) => {
            const metric = metrics[key];
            const meta = DASHBOARD_METRIC_META[key];
            return (
              <div
                key={key}
                className={metric.kind === 'value' ? 'dashboard-metric' : 'dashboard-metric unavailable'}
                data-metric={key}
                data-state={metric.kind}
              >
                <dt>{meta.label}</dt>
                <dd className="dashboard-metric-value">
                  {metric.kind === 'value' ? metric.value : 'Unavailable'}
                </dd>
                <dd className="hint dashboard-metric-definition">{meta.definition}</dd>
                {metric.kind === 'unavailable' && (
                  <dd className="hint dashboard-metric-reason">
                    {DASHBOARD_UNAVAILABLE_MESSAGES[metric.reason]}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>

        {applicationsEmpty && (
          <p className="hint" data-field="applications-empty">
            No application history yet. Tracking an application from Jobs records it here; the
            dashboard never assumes a saved job has been applied to.
          </p>
        )}
      </Section>

      <Section title="Prioritized jobs">
        <p className="hint">
          A deterministic review order over your saved jobs, their posting dates, your match
          estimates and your application log. It does not know whether a posting is still open, how
          many people applied, or your chances.
        </p>

        {!shortlist.available ? (
          <div className="banner banner-warning" role="alert" data-field="shortlist-unavailable">
            {shortlist.reason === null
              ? 'The prioritized list is unavailable.'
              : DASHBOARD_UNAVAILABLE_MESSAGES[shortlist.reason]}{' '}
            Nothing was changed.
          </div>
        ) : shortlist.actionableCount === 0 ? (
          <p className="hint" data-field="shortlist-empty">
            {noSavedJobs
              ? 'No saved jobs to prioritize yet. Add one in Jobs, or capture one from a job posting with the popup.'
              : shortlist.alreadyAppliedCount > 0
                ? `Nothing to act on right now: all ${shortlist.alreadyAppliedCount} saved job(s) are already applied to.`
                : 'No actionable saved jobs right now.'}{' '}
            <button type="button" onClick={() => onNavigate('jobs')}>
              {noSavedJobs ? 'Add a job' : 'Open Jobs'}
            </button>
          </p>
        ) : (
          <>
            <ul className="dashboard-shortlist" aria-label="Prioritized jobs">
              {shortlist.rows.map((row) => (
                <li
                  key={row.jobId}
                  className="dashboard-job"
                  data-job-id={row.jobId}
                  data-category={row.category}
                >
                  <div className="dashboard-job-head">
                    <strong>{row.title}</strong>
                    {row.company !== null && <span className="hint">{row.company}</span>}
                    {row.location !== null && <span className="hint">{row.location}</span>}
                    <span className="dashboard-category" data-category={row.category}>
                      {row.categoryLabel}
                    </span>
                  </div>
                  <div className="priority-signals">
                    <span className="priority-signal" data-field="match">
                      {row.matchLabel}
                      {row.confidenceLabel !== null && ` · ${row.confidenceLabel} confidence`}
                    </span>
                    <span className="priority-signal" data-field="freshness">
                      {row.freshnessLabel}
                    </span>
                    <span className="priority-signal" data-field="application">
                      {row.applicationLabel}
                    </span>
                    {row.duplicateLabel !== null && (
                      <span
                        className="priority-signal"
                        data-field="duplicate"
                        data-status={row.duplicateStatus}
                      >
                        {row.duplicateLabel}
                      </span>
                    )}
                  </div>
                  <ul className="priority-reasons" data-field="reasons">
                    {row.reasons.map((reason) => (
                      <li key={reason} className="hint">
                        {reason}
                      </li>
                    ))}
                  </ul>
                  <div className="dashboard-job-actions">
                    <button type="button" onClick={() => onNavigate('jobs', row.jobId)}>
                      View job details
                    </button>
                    {row.originalUrl !== null && (
                      <a href={row.originalUrl} target="_blank" rel="noreferrer noopener">
                        Open original posting
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="dashboard-shortlist-footer">
              {shortlist.truncated && (
                <p className="hint" data-field="shortlist-truncated">
                  Showing the first {shortlist.rows.length} of {shortlist.actionableCount} actionable
                  jobs — the full order is in Jobs.
                  <button type="button" onClick={() => onNavigate('jobs')}>
                    Open the full shortlist
                  </button>
                </p>
              )}
              {shortlist.alreadyAppliedCount > 0 && (
                <p className="hint" data-field="already-applied-note">
                  {shortlist.alreadyAppliedCount} saved job(s) already have a submitted or closed
                  application and are kept out of this list — they are still saved.
                  <button type="button" onClick={() => onNavigate('jobs')}>
                    Review them in Jobs
                  </button>
                </p>
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="Next steps">
        <div className="dashboard-actions">
          <button type="button" onClick={() => onNavigate('jobs')}>
            Manage saved jobs
          </button>
          <button type="button" onClick={() => onNavigate('applications')}>
            Open applications
          </button>
          <button type="button" onClick={() => onNavigate('search')}>
            Job search
          </button>
          <button type="button" onClick={() => onNavigate('settings')}>
            Settings &amp; privacy
          </button>
        </div>
      </Section>
    </>
  );
}
