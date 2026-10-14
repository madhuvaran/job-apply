/**
 * UI tests for the posting-date label (entrypoints/options/PostingDateLabel.tsx)
 * — Prompt 23. Rendered with `react-dom/server` (no new dependency); these
 * assert the visible text and the future-date warning, with `today` injected so
 * the rendering is deterministic. No browser, no network.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PostingDateLabel from '../../entrypoints/options/PostingDateLabel';
import { FUTURE_POSTING_DATE_WARNING, POSTING_DATE_UNKNOWN_LABEL } from './job-dates';

const TODAY = '2026-10-03';

function render(postedDate?: string): string {
  return renderToStaticMarkup(createElement(PostingDateLabel, { postedDate, today: TODAY }));
}

describe('PostingDateLabel', () => {
  it('shows "Posting date unknown" when no date is saved (never the capture time)', () => {
    const html = render(undefined);
    expect(html).toContain(POSTING_DATE_UNKNOWN_LABEL);
    expect(html).not.toMatch(/2026-10-03/); // no timestamp substitution
    expect(html).not.toContain(FUTURE_POSTING_DATE_WARNING);
  });

  it('shows the saved date in a readable local format', () => {
    const html = render('2026-09-30');
    expect(html).toContain('Posting date:');
    expect(html).toContain('Sep 30, 2026');
    expect(html).not.toContain(POSTING_DATE_UNKNOWN_LABEL);
  });

  it('warns about a future posting date instead of presenting it as fresh', () => {
    const html = render('2026-10-10');
    expect(html).toContain('Oct 10, 2026');
    expect(html).toContain(FUTURE_POSTING_DATE_WARNING);
    expect(html).toContain('role="status"');
  });

  it('does not warn for a date on or before today', () => {
    expect(render('2026-10-03')).not.toContain(FUTURE_POSTING_DATE_WARNING);
    expect(render('2026-10-02')).not.toContain(FUTURE_POSTING_DATE_WARNING);
  });
});
