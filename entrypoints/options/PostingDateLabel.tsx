/**
 * Presentational posting-date label (Prompt 23) — pure props, no state.
 *
 * Renders the SAVED posting date in a readable local format, or the explicit
 * "Posting date unknown" label (never the capture time). A date after the
 * current calendar date is flagged with a fixed "verify" warning instead of
 * being presented as fresh. `today` is injectable so the rendering is
 * deterministic in tests; it defaults to the local calendar date at render.
 */
import { describePostingDate, localCalendarDate } from '../../src/lib/job-dates';

export interface PostingDateLabelProps {
  /** Stored `YYYY-MM-DD` posting date, or undefined/absent when unknown. */
  postedDate?: string;
  /** Current local calendar date (`YYYY-MM-DD`); defaults to today. */
  today?: string;
}

export default function PostingDateLabel({ postedDate, today }: PostingDateLabelProps) {
  const display = describePostingDate(postedDate, today ?? localCalendarDate());
  return (
    <>
      <span className="hint posting-date">{display.text}</span>
      {display.warning !== null && (
        <span className="warn posting-date-warning" role="status">
          {display.warning}
        </span>
      )}
    </>
  );
}
