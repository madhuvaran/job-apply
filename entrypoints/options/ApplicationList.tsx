/**
 * Presentational application list (Prompt 13).
 *
 * Pure props only — no storage, no state, no effects — so it renders
 * deterministically and can be tested with `react-dom/server`. The destructive
 * delete control is ONLY wired behind `confirmingDeleteId === row.id`, so a
 * delete always requires an explicit confirmation step.
 */
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  ORPHANED_JOB_LABEL,
  type ApplicationRow,
  type ApplicationStatus,
} from '../../src/lib/applications';

export interface ApplicationListProps {
  rows: ApplicationRow[];
  /** The row currently awaiting delete confirmation, if any. */
  confirmingDeleteId: string | null;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
  onStatusChange: (id: string, status: ApplicationStatus) => void;
  onEdit: (id: string) => void;
}

export default function ApplicationList({
  rows,
  confirmingDeleteId,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onStatusChange,
  onEdit,
}: ApplicationListProps) {
  if (rows.length === 0) {
    return <p className="hint">No applications to show.</p>;
  }

  return (
    <ul className="application-list">
      {rows.map((row) => (
        <li
          key={row.id}
          className="application-item"
          data-application-id={row.id}
          data-orphaned={row.orphaned ? 'true' : 'false'}
        >
          <div className="application-head">
            <div>
              <strong className="application-title">
                {row.jobTitle ?? ORPHANED_JOB_LABEL}
              </strong>
              <span className="hint">
                {row.employer !== null ? row.employer : ''}
                {row.orphaned && (
                  <em className="application-orphan-note">
                    {' '}
                    — {ORPHANED_JOB_LABEL} (application history kept)
                  </em>
                )}
              </span>
            </div>
            <label className="application-status">
              <span className="hint">Status</span>
              <select
                value={row.status}
                aria-label={`Status for ${row.jobTitle ?? ORPHANED_JOB_LABEL}`}
                onChange={(e) => onStatusChange(row.id, e.target.value as ApplicationStatus)}
              >
                {APPLICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {APPLICATION_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="application-dates hint">
            <span data-field="application-date">
              {row.applicationDate !== null ? `Applied ${row.applicationDate}` : 'No application date'}
            </span>
            {row.followUpDate !== null && (
              <span data-field="follow-up-date">{`Follow-up ${row.followUpDate}`}</span>
            )}
            <span data-field="updated">{row.updatedAtLabel}</span>
          </div>

          {row.notes !== null && (
            <p className="application-notes" data-field="notes">
              {row.notes}
            </p>
          )}

          {row.jobUrl !== null && (
            <a
              className="hint"
              href={row.jobUrl}
              target="_blank"
              rel="noreferrer noopener"
              data-field="job-url"
            >
              {row.jobUrl}
            </a>
          )}

          <div className="application-actions">
            {confirmingDeleteId === row.id ? (
              <span className="application-confirm">
                <span className="hint">Delete this application record permanently?</span>
                <button type="button" className="danger" onClick={() => onConfirmDelete(row.id)}>
                  Yes, delete
                </button>
                <button type="button" onClick={onCancelDelete}>
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <button type="button" onClick={() => onEdit(row.id)}>
                  Edit
                </button>
                <button type="button" onClick={() => onAskDelete(row.id)}>
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
