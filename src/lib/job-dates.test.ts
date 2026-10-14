/**
 * Tests for the job posting date primitives (src/lib/job-dates.ts) — Prompt 23.
 * Synthetic values only: strict ISO parsing, leap years, impossible dates,
 * prose/relative rejection, display formatting, the future-date warning and the
 * preview/form → schema value mapping. No DOM, no network, no clock of its own.
 */
import { describe, expect, it } from 'vitest';
import {
  describePostingDate,
  extractIsoCalendarDate,
  formatPostingDate,
  FUTURE_POSTING_DATE_WARNING,
  isFuturePostingDate,
  isIsoDateTime,
  isRealCalendarDate,
  localCalendarDate,
  POSTING_DATE_UNKNOWN_LABEL,
  postedDateFieldValue,
  postingDateSchema,
} from './job-dates';

describe('isRealCalendarDate', () => {
  it('accepts real dates including leap days', () => {
    for (const ok of ['2026-10-01', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) {
      expect(isRealCalendarDate(ok), ok).toBe(true);
    }
  });

  it('rejects impossible dates, wrong shapes and prose', () => {
    for (const bad of [
      '2026-02-31',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2023-02-29', // not a leap year
      '1900-02-29', // century, not a leap year
      '2026-2-3',
      '26-02-03',
      '2026/02/03',
      '2026-10-01T00:00:00Z',
      '3 days ago',
      'October 1, 2026',
      '2026',
      '',
    ]) {
      expect(isRealCalendarDate(bad), bad).toBe(false);
    }
  });
});

describe('extractIsoCalendarDate', () => {
  it('extracts the calendar date from a date-only value', () => {
    expect(extractIsoCalendarDate('2026-10-01')).toBe('2026-10-01');
    expect(extractIsoCalendarDate('  2026-10-01  ')).toBe('2026-10-01');
    expect(extractIsoCalendarDate('2024-02-29')).toBe('2024-02-29');
  });

  it('extracts the date part of ISO date-time values, as written (no TZ conversion)', () => {
    expect(extractIsoCalendarDate('2026-10-01T09:30:00Z')).toBe('2026-10-01');
    expect(extractIsoCalendarDate('2026-10-01T23:30:00.000Z')).toBe('2026-10-01');
    expect(extractIsoCalendarDate('2026-10-01T09:30Z')).toBe('2026-10-01');
    expect(extractIsoCalendarDate('2026-10-01T09:30')).toBe('2026-10-01');
    // A late-evening wall clock in a positive offset must NOT roll to the next day.
    expect(extractIsoCalendarDate('2026-10-01T23:30:00+02:00')).toBe('2026-10-01');
    expect(extractIsoCalendarDate('2026-10-01T00:30:00-05:00')).toBe('2026-10-01');
  });

  it('rejects prose, relative wording, impossible values and unparseable extras', () => {
    for (const bad of [
      '3 days ago',
      'Posted last week',
      'today',
      'October 1, 2026',
      '2026-02-31',
      '2026-02-31T10:00:00Z',
      '2026-10-01 09:30:00', // space separator is not ISO date-time
      '2026-10-01T25:00:00Z',
      '2026-10-01 extra',
      '2026-10-01T',
      '2026',
      '',
      '   ',
      undefined,
      null,
      42,
      { datePosted: '2026-10-01' },
      ['2026-10-01'],
    ]) {
      expect(extractIsoCalendarDate(bad), String(bad)).toBeUndefined();
    }
  });

  it('isIsoDateTime accepts only strict ISO date-times', () => {
    expect(isIsoDateTime('2026-10-01T09:30:00Z')).toBe(true);
    expect(isIsoDateTime('2026-10-01T09:30Z')).toBe(true);
    expect(isIsoDateTime('2026-10-01')).toBe(false);
    expect(isIsoDateTime('2026-10-01 09:30:00')).toBe(false);
    expect(isIsoDateTime('2026-02-31T09:30:00Z')).toBe(false);
  });
});

describe('postingDateSchema (strict)', () => {
  it('accepts only real YYYY-MM-DD dates and stays strict about the shape', () => {
    expect(postingDateSchema.safeParse('2026-10-01').success).toBe(true);
    for (const bad of ['2026-2-3', '2026-10-01T00:00:00Z', '2026-02-31', '3 days ago', '', 'x'.repeat(11)]) {
      expect(postingDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('formatting and the future-date check', () => {
  it('formats the stored calendar day in a readable local format', () => {
    expect(formatPostingDate('2026-10-03', 'en-US')).toBe('Oct 3, 2026');
    expect(formatPostingDate('2026-01-31', 'en-US')).toBe('Jan 31, 2026');
    // The displayed day always matches the stored day (built from calendar parts).
    expect(formatPostingDate('2026-12-31')).toContain('2026');
  });

  it('returns invalid input unchanged (never invents a date)', () => {
    expect(formatPostingDate('not-a-date')).toBe('not-a-date');
    expect(formatPostingDate('2026-02-31')).toBe('2026-02-31');
  });

  it('localCalendarDate uses the local calendar day', () => {
    expect(localCalendarDate(new Date(2026, 9, 3, 23, 59))).toBe('2026-10-03');
    expect(localCalendarDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  it('flags only dates after the current calendar date', () => {
    expect(isFuturePostingDate('2026-10-04', '2026-10-03')).toBe(true);
    expect(isFuturePostingDate('2026-10-03', '2026-10-03')).toBe(false);
    expect(isFuturePostingDate('2026-10-02', '2026-10-03')).toBe(false);
    expect(isFuturePostingDate('2027-01-01', '2026-12-31')).toBe(true);
    // Malformed input never produces a warning.
    expect(isFuturePostingDate('soon', '2026-10-03')).toBe(false);
  });

  it('describePostingDate reports unknown dates explicitly and warns for future ones', () => {
    expect(describePostingDate(undefined, '2026-10-03')).toEqual({
      text: POSTING_DATE_UNKNOWN_LABEL,
      warning: null,
    });
    expect(describePostingDate('', '2026-10-03')).toEqual({
      text: POSTING_DATE_UNKNOWN_LABEL,
      warning: null,
    });
    expect(describePostingDate('2026-09-30', '2026-10-03', 'en-US')).toEqual({
      text: 'Posting date: Sep 30, 2026',
      warning: null,
    });
    expect(describePostingDate('2026-10-10', '2026-10-03', 'en-US')).toEqual({
      text: 'Posting date: Oct 10, 2026',
      warning: FUTURE_POSTING_DATE_WARNING,
    });
  });
});

describe('postedDateFieldValue (preview / manual form → schema)', () => {
  it('passes a corrected value through and maps a cleared value to absent', () => {
    expect(postedDateFieldValue('2026-10-03')).toBe('2026-10-03');
    expect(postedDateFieldValue(' 2026-10-03 ')).toBe('2026-10-03');
    expect(postedDateFieldValue('')).toBeUndefined(); // cleared
    expect(postedDateFieldValue('   ')).toBeUndefined(); // cleared
    // Malformed input is passed through so the SCHEMA reports it (never silently dropped).
    expect(postedDateFieldValue('3 days ago')).toBe('3 days ago');
  });
});
