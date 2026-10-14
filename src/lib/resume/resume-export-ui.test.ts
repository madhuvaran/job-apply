/**
 * UI tests for the Options → Jobs resume section
 * (entrypoints/options/ResumeExport.tsx) — Prompts 12 & 19. Rendered with
 * `react-dom/server`: the explicit save control exists, is gated on a loaded
 * profile, and never claims an application was submitted. Synthetic fixtures.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ResumeExport from '../../../entrypoints/options/ResumeExport';
import { jobPostingSchema } from '../job-posting';
import { profileSchema } from '../profile';

const job = jobPostingSchema.parse({
  id: 'job-1',
  title: 'Senior Backend Engineer',
  rawDescription: 'We need TypeScript experience.',
  capturedAt: '2026-10-13T00:00:00.000Z',
});

const profile = profileSchema.parse({
  schemaVersion: '2',
  displayName: 'Alex Example',
  summary: 'Backend engineer.',
  skills: [{ id: 'sk-1', name: 'TypeScript' }],
});

function render(profileProp: typeof profile | null): string {
  return renderToStaticMarkup(
    createElement(ResumeExport, { profile: profileProp, job, onVersionSaved: () => {} }),
  );
}

describe('ResumeExport', () => {
  it('offers PDF and Word downloads plus an explicit save-to-history action when a profile is loaded', () => {
    const html = render(profile);
    expect(html).toContain('Download tailored resume PDF');
    expect(html).toContain('Download tailored resume DOCX');
    expect(html).toContain('Save version to history');
    expect(html).toContain('Save version to history</button>');
    // Both downloads come from one tailored result, and saving is opt-in and
    // explained as local-only.
    expect(html).toContain('same tailored result');
    expect(html).toContain('does not apply anywhere or change any application status');
  });

  it('disables every action and explains itself when no profile is saved', () => {
    const html = render(null);
    expect(html).toContain('No saved profile yet');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Download tailored resume PDF/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Download tailored resume DOCX/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save version to history/);
  });

  it('does not pre-claim a saved version (no "already saved" state on load)', () => {
    const html = render(profile);
    expect(html).not.toContain('Version saved');
    expect(html).not.toContain('role="alert"');
  });

  it('makes no network calls while rendering', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      render(profile);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * Guardrail for the Prompt 20 follow-up (behaviour is covered by
   * src/lib/resume/current-export.test.ts): the component must not own a
   * second tailoring path. All three actions delegate to the one orchestrated
   * flow, so the PDF action cannot tailor twice.
   */
  it('delegates every action to the single-snapshot export flow (no direct tailoring)', () => {
    const source = readFileSync(new URL('../../../entrypoints/options/ResumeExport.tsx', import.meta.url), 'utf8');
    expect(source).toContain("from '../../src/lib/resume/current-export'");
    expect(source).toContain('exportCurrentResume');
    expect(source).not.toMatch(/\btailorResume\b/);
    expect(source).not.toMatch(/\bgenerateAndDownloadResume\b/);
    expect(source).not.toMatch(/\bsaveResumeVersion\b/);
    // The cached snapshot is handed back in, so later actions reuse it.
    expect(source).toContain('current: generated');
  });
});
