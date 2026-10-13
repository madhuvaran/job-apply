/**
 * UI tests for the application list (entrypoints/options/ApplicationList.tsx)
 * — Prompt 13. Rendered with `react-dom/server` (no new dependency); tests
 * target visible text / data attributes and the delete-confirmation gate, not
 * incidental markup.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ApplicationList from '../../../entrypoints/options/ApplicationList';
import { createJobPosting } from '../job-posting';
import { createApplication } from './schemas';
import { ORPHANED_JOB_LABEL, buildApplicationRows, type ApplicationRow } from './presenter';

const now = '2026-10-10T00:00:00.000Z';
const job = createJobPosting({
  id: 'job-a',
  title: 'Backend Engineer',
  company: 'Acme Fake Co',
  rawDescription: 'x',
  capturedAt: '2026-10-01T00:00:00.000Z',
});

function rows(): ApplicationRow[] {
  const withJob = createApplication(
    { jobId: 'job-a', status: 'interview', applicationDate: '2026-10-02', notes: 'Recruiter call booked.' },
    { now: () => now, id: () => 'a1' },
  );
  const orphan = createApplication(
    { jobId: 'job-gone', status: 'rejected' },
    { now: () => now, id: () => 'a2' },
  );
  return buildApplicationRows([withJob, orphan], [job]);
}

function render(props: Partial<Parameters<typeof ApplicationList>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ApplicationList, {
      rows: rows(),
      confirmingDeleteId: null,
      onAskDelete: () => {},
      onCancelDelete: () => {},
      onConfirmDelete: () => {},
      onStatusChange: () => {},
      onEdit: () => {},
      ...props,
    }),
  );
}

describe('ApplicationList', () => {
  it('renders job title, employer, notes, dates and every status option', () => {
    const html = render();
    expect(html).toContain('Backend Engineer');
    expect(html).toContain('Acme Fake Co');
    expect(html).toContain('Recruiter call booked.');
    expect(html).toContain('Applied 2026-10-02');
    expect(html).toContain('Interview');
    expect(html).toContain('Rejected');
    expect(html).toContain('Withdrawn');
  });

  it('identifies an orphaned application without inventing a job title', () => {
    const html = render();
    expect(html).toContain(ORPHANED_JOB_LABEL);
    expect(html).toContain('data-orphaned="true"');
    expect(html).toContain('data-orphaned="false"');
  });

  it('requires confirmation before offering the destructive delete', () => {
    const idle = render();
    // A delete button exists, but the destructive confirm action does not.
    expect(idle).toContain('>Delete<');
    expect(idle).not.toContain('Yes, delete');
    expect(idle).not.toContain('Delete this application record permanently?');

    const confirming = render({ confirmingDeleteId: 'a1' });
    expect(confirming).toContain('Delete this application record permanently?');
    expect(confirming).toContain('Yes, delete');
    // Other rows still show the plain delete button.
    expect(confirming).toContain('>Delete<');
  });

  it('offers an Edit action per row', () => {
    expect(render()).toContain('>Edit<');
  });

  it('renders an empty state when there are no rows', () => {
    const html = render({ rows: [] });
    expect(html).toContain('No applications to show.');
  });

  it('escapes user notes (no raw HTML injection)', () => {
    const dangerous = createApplication(
      { jobId: 'job-a', notes: '<script>alert(1)</script>' },
      { now: () => now, id: () => 'a9' },
    );
    const html = render({ rows: buildApplicationRows([dangerous], [job]) });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('makes no network calls while rendering', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      render();
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
