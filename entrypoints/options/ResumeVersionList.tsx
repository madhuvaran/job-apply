/**
 * Presentational saved-resume-version list (Prompt 19).
 *
 * Pure props only — no storage, no state, no effects — so it renders
 * deterministically and can be tested with `react-dom/server`. Rows show only
 * what a history record carries (job label, company, creation date, status,
 * section counts); a referenced job that no longer exists is flagged with the
 * existing orphaned label and the version is kept. The destructive delete
 * control only appears inside an OPENED version and only behind
 * `confirmingDeleteId === entry.id`, so a delete always requires an explicit
 * confirmation step. PDF and Word (.docx) export are offered per opened version
 * and always use the stored snapshot.
 */
import {
  RESUME_HISTORY_STATUS_LABELS,
  type ResumeHistoryEntry,
  type TailoredResume,
} from '../../src/lib/resume';
import { ORPHANED_JOB_LABEL } from '../../src/lib/applications';

export interface ResumeVersionListProps {
  entries: ResumeHistoryEntry[];
  /** Job ids referenced by versions whose saved job posting no longer exists. */
  orphanedJobIds: ReadonlySet<string>;
  /** The opened version, if any. */
  openId: string | null;
  /** The version currently awaiting delete confirmation, if any. */
  confirmingDeleteId: string | null;
  /** True while an export/delete request is in flight (actions disabled). */
  busy: boolean;
  onToggleOpen: (id: string) => void;
  onExport: (id: string) => void;
  /** Word (.docx) export of the SAME stored snapshot. */
  onExportDocx: (id: string) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}

/** Count-only summary of a snapshot — no resume text is rendered here. */
export function snapshotCounts(snapshot: TailoredResume): string {
  return [
    `${snapshot.skills.length} skills`,
    `${snapshot.experience.length} experience`,
    `${snapshot.projects.length} projects`,
    `${snapshot.education.length} education`,
    `${snapshot.certifications.length} certifications`,
    `${snapshot.languages.length} languages`,
  ].join(' \u00b7 ');
}

export default function ResumeVersionList({
  entries,
  orphanedJobIds,
  openId,
  confirmingDeleteId,
  busy,
  onToggleOpen,
  onExport,
  onExportDocx,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: ResumeVersionListProps) {
  if (entries.length === 0) {
    return <p className="hint">No saved resume versions yet.</p>;
  }

  return (
    <ul className="resume-version-list">
      {entries.map((entry) => {
        const orphaned = entry.jobId !== undefined && orphanedJobIds.has(entry.jobId);
        const open = openId === entry.id;
        // jobTitle falls back to the snapshot's own provenance (never invented).
        const title = entry.jobTitle ?? entry.snapshot.source.jobTitle;
        return (
          <li
            key={entry.id}
            className="resume-version"
            data-version-id={entry.id}
            data-orphaned={orphaned ? 'true' : 'false'}
          >
            <div className="resume-version-head">
              <div>
                <strong className="resume-version-title">{title}</strong>
                <span className="hint">
                  {entry.company !== undefined ? `${entry.company} \u00b7 ` : ''}
                  {`Saved ${entry.createdAt.slice(0, 10)}`}
                  {' \u00b7 '}
                  {RESUME_HISTORY_STATUS_LABELS[entry.status]}
                  {orphaned && (
                    <em className="application-orphan-note">
                      {' '}
                      — {ORPHANED_JOB_LABEL} (saved version kept)
                    </em>
                  )}
                </span>
              </div>
              <div className="resume-version-actions">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => onToggleOpen(entry.id)}
                >
                  {open ? 'Close' : 'Open'}
                </button>
              </div>
            </div>

            {open && (
              <div className="resume-version-details" data-field="details">
                <p className="hint" data-field="counts">{snapshotCounts(entry.snapshot)}</p>
                <p className="hint">
                  Export renders this saved snapshot exactly as it was generated — later changes to
                  your profile or the job posting do not change it.
                </p>
                <div className="resume-version-detail-actions">
                  <button type="button" disabled={busy} onClick={() => onExport(entry.id)}>
                    Export PDF
                  </button>
                  <button type="button" disabled={busy} onClick={() => onExportDocx(entry.id)}>
                    Export DOCX
                  </button>
                  {confirmingDeleteId === entry.id ? (
                    <span className="application-confirm">
                      <span className="hint">Delete this saved resume version permanently?</span>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => onConfirmDelete(entry.id)}
                      >
                        Yes, delete
                      </button>
                      <button type="button" onClick={onCancelDelete}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => onAskDelete(entry.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
