/**
 * Priority shortlist (Prompt 24) — renders the deterministic prioritization
 * result inside Options → Jobs.
 *
 * - Presentational only: every label, count, reason and signal comes from the
 *   pure `prioritizeJobs()` result. No scoring, no inference, no data access.
 * - The four categories are shown with counts; selecting one lists its jobs
 *   (ordered by the module). Match estimate, freshness and application status
 *   are shown as SEPARATE signals — there is no combined score and no claim
 *   about how likely an application is to succeed.
 * - The "Open posting" action is a plain safe link
 *   (`target="_blank" rel="noreferrer noopener"`) and is only rendered when the
 *   saved URL re-validated as http(s). Nothing is submitted, filled or opened
 *   automatically.
 */
import type {
  PrioritizationResult,
  PriorityCategory,
} from '../../src/lib/prioritization';

export interface PriorityListProps {
  result: PrioritizationResult;
  /** Currently inspected category (controlled by the panel). */
  selected: PriorityCategory;
  onSelect: (category: PriorityCategory) => void;
  /** Fail-closed context the panel knows and the module cannot (e.g. no profile). */
  extraNotes?: string[];
}

export default function PriorityList({ result, selected, onSelect, extraNotes = [] }: PriorityListProps) {
  const notes = [...result.notes, ...extraNotes];
  const active = result.groups.find((g) => g.category === selected) ?? result.groups[0];

  return (
    <section className="priority" aria-label="Job priority shortlist" data-total={result.totalJobs}>
      <h3>Priority shortlist</h3>
      <p className="hint">
        A deterministic review order computed offline from your saved jobs, their posting dates, your match
        estimates and your application log. It does not know whether a posting is still open, how many people
        applied, or your chances — it only suggests where to look first. Freshness window:{' '}
        {result.freshnessWindowDays} calendar days.
      </p>

      {notes.length > 0 && (
        <ul className="priority-notes" data-field="notes">
          {notes.map((note) => (
            <li key={note} className="hint">
              {note}
            </li>
          ))}
        </ul>
      )}

      {result.totalJobs === 0 ? (
        <p className="hint">
          No saved jobs to prioritize yet. Add one manually or capture one from a job posting first.
        </p>
      ) : (
        <>
          <div className="priority-categories">
            {result.groups.map((group) => (
              <button
                key={group.category}
                type="button"
                aria-pressed={group.category === active?.category}
                data-category={group.category}
                onClick={() => onSelect(group.category)}
              >
                {group.label} ({group.count})
              </button>
            ))}
          </div>

          {active !== undefined && (
            <div className="priority-group" data-category={active.category}>
              <h4>
                {active.label} ({active.count})
              </h4>
              <p className="hint">{active.description}</p>
              {active.jobs.length === 0 ? (
                <p className="hint">No saved jobs in this category.</p>
              ) : (
                <ul className="priority-jobs">
                  {active.jobs.map((entry) => (
                    <li key={entry.jobId} data-job-id={entry.jobId} data-category={entry.category}>
                      <div className="priority-job-head">
                        <strong>{entry.title}</strong>
                        {entry.company !== null && <span className="hint">{entry.company}</span>}
                      </div>
                      <div className="priority-signals">
                        <span className="priority-signal" data-field="match">
                          {entry.match.label}
                        </span>
                        <span className="priority-signal" data-field="freshness">
                          {entry.freshness.label}
                        </span>
                        <span className="priority-signal" data-field="application">
                          {entry.application.label}
                        </span>
                      </div>
                      <ul className="priority-reasons" data-field="reasons">
                        {entry.reasons.map((reason) => (
                          <li key={reason} className="hint">
                            {reason}
                          </li>
                        ))}
                      </ul>
                      {entry.originalUrl !== null && (
                        <a href={entry.originalUrl} target="_blank" rel="noreferrer noopener">
                          Open posting
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
