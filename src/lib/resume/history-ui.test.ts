/**
 * UI tests for the saved-resume-version list
 * (entrypoints/options/ResumeVersionList.tsx) — Prompt 19. Rendered with
 * `react-dom/server` (no new dependency); tests target visible text / data
 * attributes and the delete-confirmation gate, not incidental markup.
 * Synthetic fixtures only.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ResumeVersionList from '../../../entrypoints/options/ResumeVersionList';
import { ORPHANED_JOB_LABEL } from '../applications';
import { createResumeHistoryEntry, type ResumeHistoryEntry } from './history';
import { baseResume } from './pdf/test-support';

const JOB = { id: 'job-1', title: 'Senior Backend Engineer', company: 'Acme Fake Co' } as const;
const deps = { now: () => '2026-10-13T09:00:00.000Z', id: () => 'rv-1' };

function entries(): ResumeHistoryEntry[] {
  return [
    createResumeHistoryEntry(baseResume(), JOB, deps),
    createResumeHistoryEntry(
      baseResume({ source: { jobId: 'job-gone', jobTitle: 'Platform Engineer', jobCapturedAt: '2026-10-01T00:00:00.000Z' } }),
      { id: 'job-gone', title: 'Platform Engineer', company: undefined },
      { now: () => '2026-10-12T09:00:00.000Z', id: () => 'rv-2' },
    ),
  ];
}

type ListProps = Parameters<typeof ResumeVersionList>[0];

function render(overrides: Partial<ListProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ResumeVersionList, {
      entries: entries(),
      orphanedJobIds: new Set<string>(['job-gone']),
      openId: null,
      confirmingDeleteId: null,
      busy: false,
      onToggleOpen: () => {},
      onExport: () => {},
      onExportDocx: () => {},
      onAskDelete: () => {},
      onCancelDelete: () => {},
      onConfirmDelete: () => {},
      ...overrides,
    }),
  );
}

describe('ResumeVersionList', () => {
  it('renders the saved job label, company, creation date and status', () => {
    const html = render();
    expect(html).toContain('Senior Backend Engineer');
    expect(html).toContain('Acme Fake Co');
    expect(html).toContain('Saved 2026-10-13');
    expect(html).toContain('Saved');
    expect(html).toContain('data-version-id="rv-1"');
  });

  it('shows count-only details, never the resume body text', () => {
    const html = render({ openId: 'rv-1' });
    expect(html).toContain('3 skills');
    expect(html).toContain('1 experience');
    expect(html).toContain('1 education');
    // No resume content (summary/bullets) is rendered in the list.
    expect(html).not.toContain('Backend engineer focused on reliable APIs.');
    expect(html).not.toContain('Built APIs in TypeScript.');
    // The snapshot guarantee is explained.
    expect(html).toContain('saved snapshot');
  });

  it('only reveals export/delete for an opened version', () => {
    const closed = render();
    expect(closed).toContain('>Open<');
    expect(closed).not.toContain('Export PDF');
    expect(closed).not.toContain('Export DOCX');
    expect(closed).not.toContain('>Delete<');
    expect(closed).not.toContain('aria-expanded="true"');

    const open = render({ openId: 'rv-1' });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('Export PDF');
    expect(open).toContain('Export DOCX');
    expect(open).toContain('>Delete<');
    // The other row stays closed.
    expect(open.match(/Export PDF/g)).toHaveLength(1);
    expect(open.match(/Export DOCX/g)).toHaveLength(1);
  });

  it('requires an explicit confirmation before offering the destructive delete', () => {
    const idle = render({ openId: 'rv-1' });
    expect(idle).not.toContain('Yes, delete');
    expect(idle).not.toContain('Delete this saved resume version permanently?');

    const confirming = render({ openId: 'rv-1', confirmingDeleteId: 'rv-1' });
    expect(confirming).toContain('Delete this saved resume version permanently?');
    expect(confirming).toContain('Yes, delete');
    expect(confirming).toContain('>Cancel<');
  });

  it('flags a missing saved job without dropping the version', () => {
    const html = render();
    expect(html).toContain('data-orphaned="true"');
    expect(html).toContain('data-orphaned="false"');
    expect(html).toContain(ORPHANED_JOB_LABEL);
    expect(html).toContain('saved version kept');
    // The orphaned version is still listed (history is preserved).
    expect(html).toContain('Platform Engineer');
    expect(html).toContain('data-version-id="rv-2"');
  });

  it('renders an empty state when there are no versions', () => {
    const html = render({ entries: [] });
    expect(html).toContain('No saved resume versions yet.');
  });

  it('escapes job labels (no raw HTML injection)', () => {
    const dangerous = createResumeHistoryEntry(
      baseResume(),
      { id: 'job-1', title: '<script>alert(1)</script>', company: undefined },
      deps,
    );
    const html = render({ entries: [dangerous] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('disables export and delete while a request is in flight', () => {
    const busy = render({ openId: 'rv-1', busy: true });
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Export PDF/);
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Export DOCX/);
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Delete/);
    // Toggling open stays available.
    expect(busy).not.toMatch(/<button[^>]*disabled[^>]*>Close</);
  });

  it('makes no network calls while rendering', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      render({ openId: 'rv-1' });
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
