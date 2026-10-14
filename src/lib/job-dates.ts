/**
 * Job posting dates (Prompt 23) — pure, deterministic primitives.
 *
 * A posting date is a CALENDAR DATE (`YYYY-MM-DD`), never a timestamp. These
 * helpers:
 * - validate a real calendar date (including leap years) and reject impossible
 *   ones (2026-02-31, month 13, …);
 * - extract the EXPLICIT calendar date from a strict ISO value (date-only or
 *   date-time) — the date part is taken exactly as written and never converted
 *   between time zones, and anything else (prose, "3 days ago", a bare year,
 *   extra text) stays ABSENT;
 * - format a saved date for display in the user's local format without shifting
 *   the calendar day, and flag a date that lies in the future.
 *
 * No DOM, no network, no clock of its own (callers pass `today`) and no
 * invention: a missing/ambiguous/invalid date is never replaced by `capturedAt`.
 *
 * NOTE: `isRealCalendarDate` also exists in `src/lib/applications/schemas.ts`.
 * That module belongs to the application-log domain, which this task must not
 * touch, so the primitive is kept local here rather than adding a cross-domain
 * import from the job-posting model into the applications domain.
 */
import { z } from 'zod';

/** Longest accepted stored posting date (`YYYY-MM-DD`). */
export const MAX_POSTED_DATE_CHARS = 10;

/** True only for a real calendar date (rejects 2026-02-31, 2026-13-01, …). */
export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A real `YYYY-MM-DD` calendar date (the ONLY shape stored/sent). */
export const postingDateSchema = z
  .string()
  .max(MAX_POSTED_DATE_CHARS)
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealCalendarDate, { message: 'not a real calendar date' });

/**
 * Strict ISO 8601 date-time shape (no prose, no relative wording):
 * `YYYY-MM-DDThh:mm[:ss[.fff…]][Z|±hh:mm]`. Seconds, fraction and offset are
 * each optional, matching the common job-board `datePosted` formats.
 */
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/;

/** True only for a valid ISO date-time string (impossible days rejected). */
export function isIsoDateTime(value: string): boolean {
  const m = ISO_DATE_TIME_PATTERN.exec(value);
  if (m === null) return false;
  if (!isRealCalendarDate(`${m[1]}-${m[2]}-${m[3]}`)) return false;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  return true;
}

/**
 * The explicit calendar date of a strict ISO value, or `undefined`.
 *
 * `'2026-10-01'` → `'2026-10-01'`; `'2026-10-01T23:30:00+02:00'` → `'2026-10-01'`
 * (the date as stated, not converted to UTC); `''`, `'3 days ago'`,
 * `'October 1, 2026'`, `'2026-02-31'`, `'2026-02-31T10:00:00Z'`, `'2026'` and
 * `'2026-10-01 extra'` → `undefined`.
 */
export function extractIsoCalendarDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  if (raw.length === MAX_POSTED_DATE_CHARS) {
    return postingDateSchema.safeParse(raw).success ? raw : undefined;
  }
  if (!isIsoDateTime(raw)) return undefined;
  const datePart = raw.slice(0, MAX_POSTED_DATE_CHARS);
  return isRealCalendarDate(datePart) ? datePart : undefined;
}

/**
 * The user's LOCAL calendar date (`YYYY-MM-DD`) for a `Date` — "today" for the
 * future-date check. Uses local components so a date does not shift by zone.
 */
export function localCalendarDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A saved posting date in the user's local, readable format (e.g. `Oct 3, 2026`).
 * Built from the calendar parts at LOCAL midnight, so the displayed day always
 * matches the stored day. Invalid input is returned unchanged (never invented).
 */
export function formatPostingDate(value: string, locale?: string): string {
  if (!isRealCalendarDate(value)) return value;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Shown when no posting date is known — never a capture/updated timestamp. */
export const POSTING_DATE_UNKNOWN_LABEL = 'Posting date unknown';
/** Shown when the stored posting date is after the current calendar date. */
export const FUTURE_POSTING_DATE_WARNING = 'Future posting date — verify';

/** True when `postedDate` is after `today` (both strict `YYYY-MM-DD`). */
export function isFuturePostingDate(postedDate: string, today: string): boolean {
  if (!isRealCalendarDate(postedDate) || !isRealCalendarDate(today)) return false;
  return postedDate > today; // fixed-width ISO dates compare chronologically
}

export interface PostingDateDisplay {
  /** Readable label, or `Posting date unknown`. */
  text: string;
  /** Fixed warning when the date is in the future, else null. */
  warning: string | null;
}

/**
 * What the UI shows for a saved posting date. An absent/blank date yields the
 * explicit "unknown" label (never the capture time) and no warning.
 */
export function describePostingDate(
  postedDate: string | undefined,
  today: string,
  locale?: string,
): PostingDateDisplay {
  if (postedDate === undefined || postedDate.trim().length === 0) {
    return { text: POSTING_DATE_UNKNOWN_LABEL, warning: null };
  }
  return {
    text: `Posting date: ${formatPostingDate(postedDate, locale)}`,
    warning: isFuturePostingDate(postedDate, today) ? FUTURE_POSTING_DATE_WARNING : null,
  };
}

/**
 * The value a capture preview / manual create-edit form sends to the schema:
 * blank (or whitespace) means "unknown" → absent, never a substituted
 * timestamp. Everything else is passed through verbatim so the strict schema —
 * not the UI — decides validity and reports the error.
 */
export function postedDateFieldValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
