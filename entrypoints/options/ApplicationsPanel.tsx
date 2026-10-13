/**
 * Options → Applications: local application log (Prompt 13).
 *
 * - Reads/writes ONLY through the application service (`src/lib/applications`),
 *   which uses the validated storage service. No direct `chrome.storage`, no
 *   network, no AI, no sensitive profile.
 * - Every mutation requires an explicit user action; nothing is auto-marked
 *   applied by viewing a job, generating a resume, or autofilling.
 * - Malformed storage is NEVER overwritten: a malformed log shows a banner and
 *   requires an explicit "Replace with empty list" confirmation.
 * - Delete is a two-step confirmation (see ApplicationList).
 * - UI messages are fixed strings from the service; they never include notes,
 *   job text or any application content.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  APPLICATION_FILTER_OPTIONS,
  APPLICATION_SORT_KEYS,
  APPLICATION_SORT_LABELS,
  APPLICATION_STATUS_LABELS,
  createApplicationForJob,
  deleteApplication,
  listApplications,
  selectApplicationRows,
  updateApplication,
  type Application,
  type ApplicationSortKey,
  type ApplicationStatus,
  type ApplicationStatusFilter,
} from '../../src/lib/applications';
import { loadJobPostings, resetApplications } from '../../src/lib/storage';
import type { JobPosting } from '../../src/lib/job-posting';
import { Row, Section } from './ui';
import ApplicationList from './ApplicationList';

type LoadState = 'loading' | 'ready' | 'malformed' | 'unavailable';

interface CreateForm {
  jobId: string;
  applicationDate: string;
  notes: string;
}

const EMPTY_CREATE: CreateForm = { jobId: '', applicationDate: '', notes: '' };

interface EditForm {
  id: string;
  applicationDate: string;
  followUpDate: string;
  notes: string;
}

export default function ApplicationsPanel() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [postingsState, setPostingsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApplicationStatusFilter>('all');
  const [sortKey, setSortKey] = useState<ApplicationSortKey>('updated');
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [editing, setEditing] = useState<EditForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const refresh = useCallback(async () => {
    const [apps, jobs] = await Promise.all([listApplications(), loadJobPostings()]);
    if (jobs.ok) {
      setPostings(jobs.data.postings);
      setPostingsState('ready');
    } else if (jobs.reason === 'absent') {
      setPostings([]);
      setPostingsState('ready');
    } else {
      // The job list itself is unreadable — do not guess; flag it so orphaned
      // rows are explained rather than misrepresented as deleted.
      setPostings([]);
      setPostingsState('error');
    }

    if (apps.ok) {
      setApplications(apps.data);
      setLoadState('ready');
      return;
    }
    if (apps.reason === 'malformed') {
      setLoadState('malformed');
      setLoadMessage(apps.message);
      return;
    }
    setLoadState('unavailable');
    setLoadMessage(apps.message);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(
    () => selectApplicationRows(applications, postings, { status: statusFilter, sort: sortKey }),
    [applications, postings, statusFilter, sortKey],
  );

  const onRefresh = useCallback(async () => {
    setNotice(null);
    setError(null);
    await refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    if (busy) return;
    if (form.jobId === '') {
      setError('Choose a saved job to track first.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await createApplicationForJob({
        jobId: form.jobId,
        ...(form.applicationDate.trim() !== '' ? { applicationDate: form.applicationDate } : {}),
        ...(form.notes.trim() !== '' ? { notes: form.notes } : {}),
      });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setForm(EMPTY_CREATE);
      setNotice('Application added.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, form, refresh]);

  const onStatusChange = useCallback(async (id: string, status: ApplicationStatus) => {
    setError(null);
    const outcome = await updateApplication(id, { status });
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    const updated = outcome.data;
    setApplications((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    setNotice(`Status updated to ${APPLICATION_STATUS_LABELS[status]}.`);
  }, []);

  const onEdit = useCallback(
    (id: string) => {
      const app = applications.find((a) => a.id === id);
      if (app === undefined) return;
      setNotice(null);
      setError(null);
      setEditing({
        id,
        applicationDate: app.applicationDate ?? '',
        followUpDate: app.followUpDate ?? '',
        notes: app.notes ?? '',
      });
    },
    [applications],
  );

  const onSaveEdit = useCallback(async () => {
    if (editing === null || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await updateApplication(editing.id, {
        applicationDate: editing.applicationDate.trim() === '' ? null : editing.applicationDate,
        followUpDate: editing.followUpDate.trim() === '' ? null : editing.followUpDate,
        notes: editing.notes.trim() === '' ? null : editing.notes,
      });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      const updated = outcome.data;
      setApplications((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setEditing(null);
      setNotice('Application updated.');
    } finally {
      setBusy(false);
    }
  }, [busy, editing]);

  const onConfirmDelete = useCallback(
    async (id: string) => {
      setConfirmingDeleteId(null);
      setError(null);
      const outcome = await deleteApplication(id);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setApplications(outcome.data);
      if (editing !== null && editing.id === id) setEditing(null);
      setNotice('Application deleted.');
    },
    [editing],
  );

  const onResetConfirmed = useCallback(async () => {
    setConfirmingReset(false);
    const res = await resetApplications();
    if (res !== null && !res.ok) {
      setError(res.message);
      return;
    }
    setApplications([]);
    setNotice('Application log replaced with an empty list.');
    await refresh();
  }, [refresh]);

  const noJobs = postingsState === 'ready' && postings.length === 0;

  return (
    <div className="applications-panel">
      {loadState === 'loading' && <div className="banner banner-info">Loading applications…</div>}
      {loadState === 'unavailable' && (
        <div className="banner banner-error" role="alert">{loadMessage}</div>
      )}
      {loadState === 'malformed' && (
        <div className="banner banner-error" role="alert">
          <p>Stored application data is malformed and could not be loaded. {loadMessage}</p>
          <p>
            Your data has NOT been overwritten. You can replace it with an empty list explicitly.
          </p>
          {!confirmingReset && (
            <button type="button" onClick={() => setConfirmingReset(true)}>
              Replace with empty list…
            </button>
          )}
          {confirmingReset && (
            <span>
              <button type="button" className="danger" onClick={() => void onResetConfirmed()}>
                Yes, replace
              </button>
              <button type="button" onClick={() => setConfirmingReset(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {postingsState === 'error' && loadState !== 'loading' && (
        <div className="banner banner-info" role="status">
          The saved job list could not be read, so job titles may be missing below. Your
          applications are unaffected.
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

      {loadState !== 'malformed' && (
        <>
          <Section title="Track a new application">
            {noJobs ? (
              <p className="hint">
                No saved jobs yet. Add a job in the <strong>Jobs</strong> tab first, then track an
                application here.
              </p>
            ) : (
              <>
                <Row label="Saved job *">
                  <select
                    value={form.jobId}
                    onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))}
                  >
                    <option value="">Choose a saved job…</option>
                    {postings.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.company !== undefined ? `${p.title} — ${p.company}` : p.title}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Application date">
                  <input
                    type="date"
                    value={form.applicationDate}
                    onChange={(e) => setForm((f) => ({ ...f, applicationDate: e.target.value }))}
                  />
                  <span className="hint">Optional.</span>
                </Row>
                <Row label="Notes">
                  <textarea
                    rows={3}
                    value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Optional — stored locally only"
                  />
                </Row>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || form.jobId === ''}
                  onClick={() => void onCreate()}
                >
                  Add application
                </button>
              </>
            )}
          </Section>

          <Section title="Applications">
            <Row label="Filter">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as ApplicationStatusFilter)}
              >
                {APPLICATION_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => void onRefresh()}>Refresh</button>
            </Row>
            <Row label="Sort by">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as ApplicationSortKey)}
              >
                {APPLICATION_SORT_KEYS.map((key) => (
                  <option key={key} value={key}>{APPLICATION_SORT_LABELS[key]}</option>
                ))}
              </select>
            </Row>

            {loadState === 'loading' ? (
              <p className="hint">Loading…</p>
            ) : applications.length === 0 ? (
              <p className="hint">
                No applications tracked yet. Choose a saved job above and click "Add application".
              </p>
            ) : (
              <ApplicationList
                rows={rows}
                confirmingDeleteId={confirmingDeleteId}
                onAskDelete={(id) => setConfirmingDeleteId(id)}
                onCancelDelete={() => setConfirmingDeleteId(null)}
                onConfirmDelete={(id) => void onConfirmDelete(id)}
                onStatusChange={(id, status) => void onStatusChange(id, status)}
                onEdit={onEdit}
              />
            )}

            {editing !== null && (
              <div className="application-edit">
                <h3>Edit application</h3>
                <Row label="Application date">
                  <input
                    type="date"
                    value={editing.applicationDate}
                    onChange={(e) => setEditing({ ...editing, applicationDate: e.target.value })}
                  />
                </Row>
                <Row label="Follow-up date">
                  <input
                    type="date"
                    value={editing.followUpDate}
                    onChange={(e) => setEditing({ ...editing, followUpDate: e.target.value })}
                  />
                </Row>
                <Row label="Notes">
                  <textarea
                    rows={4}
                    value={editing.notes}
                    onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  />
                </Row>
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                <button type="button" className="primary" disabled={busy} onClick={() => void onSaveEdit()}>
                  Save changes
                </button>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
