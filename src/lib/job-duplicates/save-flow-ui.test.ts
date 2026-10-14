/**
 * Regression renders for the two job-creation entry points (Prompt 26).
 *
 * The duplicate warning itself needs interaction (and this repo has no DOM test
 * library by convention), so these tests pin the parts that CAN be rendered
 * deterministically: both entry points still render with the duplicate check
 * wired in, and the Jobs create form keeps its existing markup. `wxt/browser` is
 * mocked only so the module graph resolves (no effect runs during server
 * rendering).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    runtime: { openOptionsPage: async () => {} },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => [] },
  },
}));

import PopupApp from '../../../entrypoints/popup/App';
import JobsPanel from '../../../entrypoints/options/JobsPanel';

describe('job-creation entry points (Prompt 26)', () => {
  it('the popup still renders its idle stage', () => {
    const html = renderToStaticMarkup(createElement(PopupApp));
    expect(html).toContain('Save the job you are looking at');
    expect(html).not.toContain('duplicate-warning');
  });

  it('Options → Jobs still renders its list, create entry point and priority section', () => {
    const html = renderToStaticMarkup(createElement(JobsPanel));
    expect(html).toContain('Saved jobs');
    expect(html).toContain('Add job manually');
    expect(html).toContain('Priority shortlist');
    // No duplicate warning until a save is actually attempted.
    expect(html).not.toContain('duplicate-warning');
  });
});
