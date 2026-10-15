// @vitest-environment jsdom
/**
 * Job search panel tests (Prompt 28).
 *
 * Two layers, both deterministic and offline:
 * - `JobSearchResults` is rendered with `react-dom/server` for every state, from
 *   fixtures built by the REAL Prompt 27 normalizer (so the fixtures are
 *   guaranteed schema-valid);
 * - the panel itself is mounted in jsdom with `react-dom/client` + `act` to
 *   assert validation feedback, the disabled search button, the reset action and
 *   the accessible labels.
 *
 * No live request, no credential and no API quota is involved anywhere: the
 * panel cannot reach a provider in this build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAdzunaSearchResponse } from './adzuna/normalize';
import { adzunaSearchRequestSchema } from './adzuna/schemas';
import { JOB_SEARCH_ERROR_MESSAGES, type JobSearchError } from './errors';
import { JOB_SEARCH_UNAVAILABLE_MESSAGES } from './service';
import type { NormalizedSearchResults } from './schemas';
import type { JobSearchViewState } from './ui';
import JobSearchPanel, { JobSearchResults, groupDigits, salaryText } from '../../../entrypoints/options/JobSearchPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXED_NOW = '2026-10-15T09:00:00.000Z';
const REQUEST = adzunaSearchRequestSchema.parse({ country: 'in', keywords: 'data engineer' });

/** A schema-valid page, built by the real normalizer. */
function page(raw: unknown): NormalizedSearchResults {
  const result = normalizeAdzunaSearchResponse(raw, { request: REQUEST, now: () => FIXED_NOW });
  if (!result.ok) throw new Error(`fixture invalid: ${result.issues.join('; ')}`);
  return result.value;
}

const FULL_JOB = {
  id: 'abc-123',
  title: 'Senior Data Engineer',
  description: 'Build and maintain the analytics pipelines.',
  created: '2026-10-02T08:00:00Z',
  redirect_url: 'https://www.adzuna.in/details/abc-123',
  company: { display_name: 'Example Analytics Ltd' },
  location: { display_name: 'Bengaluru, Karnataka' },
  salary_min: 900000,
  salary_max: 1400000,
  salary_is_predicted: '1',
};

/** Only the fields the provider is documented to always supply. */
const MINIMAL_JOB = {
  id: 'min-1',
  title: 'QA Engineer',
  description: 'Manual and automated testing.',
  created: '2026-09-30T10:00:00Z',
  redirect_url: 'https://www.adzuna.in/details/min-1',
};

const html = (state: JobSearchViewState) =>
  renderToStaticMarkup(createElement(JobSearchResults, { state }));

/* ------------------------------------------------------------------ */
/* Results-area states                                                 */
/* ------------------------------------------------------------------ */

describe('the results area renders every state distinctly', () => {
  it('initial: no search performed, and no fabricated listings', () => {
    const out = html({ kind: 'initial' });
    expect(out).toContain('data-state="initial"');
    expect(out).toContain('No search has been run yet');
    expect(out).not.toContain('search-result');
    expect(out).not.toContain('Adzuna');
  });

  it('unavailable: explains itself and shows nothing that looks like a result', () => {
    const out = html({
      kind: 'unavailable',
      reason: 'not-configured',
      message: JOB_SEARCH_UNAVAILABLE_MESSAGES['not-configured'],
    });
    expect(out).toContain('data-state="unavailable"');
    expect(out).toContain('Live job search is not available in this build');
    expect(out).toContain('Nothing was requested and no results are shown');
    expect(out).not.toContain('search-result');
    expect(out).not.toContain('no matching jobs');
  });

  it('invalid: lists the issues as an alert', () => {
    const out = html({
      kind: 'invalid',
      issues: [{ field: 'keywords', message: 'Enter a keyword or job title.' }],
    });
    expect(out).toContain('data-state="invalid"');
    expect(out).toContain('role="alert"');
    expect(out).toContain('Enter a keyword or job title.');
    expect(out).not.toContain('search-result');
  });

  it('loading: announced as busy, with no results yet', () => {
    const out = html({ kind: 'loading' });
    expect(out).toContain('data-state="loading"');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('Searching');
    expect(out).not.toContain('search-result');
  });

  it('error: a failed search is NEVER shown as an empty result', () => {
    const out = html({
      kind: 'error',
      error: { kind: 'rate-limited' },
      message: JOB_SEARCH_ERROR_MESSAGES['rate-limited'],
    });
    expect(out).toContain('data-state="error"');
    expect(out).toContain('data-error-kind="rate-limited"');
    expect(out).toContain(JOB_SEARCH_ERROR_MESSAGES['rate-limited']);
    expect(out).toContain('no results were returned');
    // The zero-result wording must never appear for a failure.
    expect(out).not.toContain('returned no matching jobs');
  });

  it('each failure kind keeps its own identity', () => {
    const identityCases: Array<[JobSearchError, string]> = [
      [{ kind: 'unauthenticated', status: 410 }, JOB_SEARCH_ERROR_MESSAGES.unauthenticated],
      [{ kind: 'network' }, JOB_SEARCH_ERROR_MESSAGES.network],
      [
        { kind: 'invalid-response', issues: ['(root): bad'] },
        JOB_SEARCH_ERROR_MESSAGES['invalid-response'],
      ],
    ];
    for (const [error, message] of identityCases) {
      const out = html({ kind: 'error', error, message });
      expect(out).toContain(`data-error-kind="${error.kind}"`);
      expect(out).toContain(message);
    }
  });

  it('zero results: `results` with an empty list, worded as a successful empty search', () => {
    const out = html({ kind: 'results', page: page({ results: [], count: 0 }) });
    expect(out).toContain('data-state="results"');
    expect(out).toContain('data-count="0"');
    expect(out).toContain('returned no matching jobs');
    expect(out).not.toContain('Search failed');
    expect(out).not.toContain('data-error-kind');
    // Attribution still travels with an empty successful page.
    expect(out).toContain('Listings supplied by');
  });
});

/* ------------------------------------------------------------------ */
/* Result cards and optional fields                                    */
/* ------------------------------------------------------------------ */

describe('results render only the fields the provider supplied', () => {
  it('renders every field of a complete listing', () => {
    const out = html({ kind: 'results', page: page({ results: [FULL_JOB], count: 42 }) });
    expect(out).toContain('data-count="1"');
    expect(out).toContain('Senior Data Engineer');
    expect(out).toContain('Example Analytics Ltd');
    expect(out).toContain('Bengaluru, Karnataka');
    expect(out).toContain('Posted ');
    expect(out).toContain('2026');
    expect(out).toContain('900,000');
    expect(out).toContain('1,400,000');
    expect(out).toContain('did not state a currency');
    expect(out).toContain('Estimated by Adzuna (Jobsworth)');
    expect(out).toContain('Build and maintain the analytics pipelines.');
    expect(out).toContain('of 42 reported by the search service');
    // The listing links out through the provider's own URL.
    expect(out).toContain('href="https://www.adzuna.in/details/abc-123"');
    expect(out).toContain('Open original listing');
    expect(out).toContain('rel="noreferrer noopener"');
    // Required attribution, with the documented minimum size.
    expect(out).toContain('min-width:116px');
    expect(out).toContain('min-height:23px');
    expect(out).toContain('>Adzuna</a>');
  });

  it('renders a minimal listing without inventing company, location or salary', () => {
    const out = html({ kind: 'results', page: page({ results: [MINIMAL_JOB] }) });
    expect(out).toContain('QA Engineer');
    expect(out).toContain('did not provide a company or location');
    expect(out).not.toContain('Salary:');
    // The provider DID state a publication date, so it is shown.
    expect(out).toContain('Posted Sep 30, 2026');
    // No empty "·" separator or empty placeholder span for missing fields.
    expect(out).not.toContain('·');
    expect(out).not.toContain('<span class="hint"></span>');
  });

  it('omits a posting date the provider did not state, without substituting today', () => {
    const out = html({
      kind: 'results',
      page: page({ results: [{ ...MINIMAL_JOB, created: 'recently' }] }),
    });
    expect(out).not.toContain('Posted ');
    expect(out).not.toContain('2026-10-15');
  });

  it('renders a snippet-free listing with no empty description element', () => {
    const out = html({
      kind: 'results',
      page: page({ results: [{ ...MINIMAL_JOB, description: undefined }] }),
    });
    expect(out).not.toContain('search-snippet');
  });

  it('never invents a currency for a salary', () => {
    expect(salaryText({ min: 1000, max: 2000, predicted: false })).toBe('1,000 – 2,000');
    expect(salaryText({ min: 1000, predicted: null })).toBe('1,000 or more');
    expect(salaryText({ max: 2000, predicted: null })).toBe('up to 2,000');
    const out = html({ kind: 'results', page: page({ results: [FULL_JOB] }) });
    for (const currency of ['$', '€', '£', '₹', 'USD', 'INR']) {
      expect(out).not.toContain(currency);
    }
  });

  it('marks missing information rather than defaulting it', () => {
    const out = html({ kind: 'results', page: page({ results: [MINIMAL_JOB] }) });
    expect(out).toContain('did not provide');
  });

  it('formats counts without depending on the host locale', () => {
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(1234)).toBe('1,234');
    expect(groupDigits(1234567)).toBe('1,234,567');
  });

  it('reports listings the provider returned but could not be used', () => {
    const out = html({
      kind: 'results',
      page: page({ results: [FULL_JOB, 'not-a-record'], count: 2 }),
    });
    expect(out).toContain('could not be used');
  });
});

/* ------------------------------------------------------------------ */
/* Panel: mount, validation, disabled search, reset                     */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(ui: ReactElement) {
  await act(async () => {
    root.render(ui);
  });
}

/** React-controlled inputs need the native setter plus bubbling events. */
async function setControl(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const $ = <T extends Element>(selector: string) => container.querySelector<T>(selector);
const text = () => container.textContent ?? '';

describe('the panel starts honest and makes no request', () => {
  it('shows the unavailable state, disables Search, and fabricates no listings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await mount(createElement(JobSearchPanel));

    expect(text()).toContain(JOB_SEARCH_UNAVAILABLE_MESSAGES['not-configured']);
    expect($('[data-state="unavailable"]')).not.toBeNull();
    expect($('[data-availability="unavailable"]')).not.toBeNull();
    const submit = $<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    expect(container.querySelectorAll('li.search-result')).toHaveLength(0);
    expect(text()).not.toContain('no matching jobs');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('lists every supported country and nothing else', async () => {
    await mount(createElement(JobSearchPanel));
    const options = Array.from($<HTMLSelectElement>('#job-search-country')!.options).map((o) => o.value);
    expect(options[0]).toBe('');
    const countries = options.slice(1);
    expect(countries).toContain('in');
    expect(countries).toContain('gb');
    expect(countries).not.toContain('xx');
    expect(countries).toHaveLength(19);
    // Remote preference is deliberately absent: the verified contract has no
    // such filter, so it must not be offered as if it worked.
    expect(text().toLowerCase()).not.toContain('remote');
  });

  it('offers a clear/reset action that is not the submit control', async () => {
    await mount(createElement(JobSearchPanel));
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Search');
    expect(buttons).toContain('Clear');
    expect($<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe('Search');
  });
});

describe('form validation is fed back inline', () => {
  it('flags missing keywords, then clears the message once provided', async () => {
    await mount(createElement(JobSearchPanel));
    const keywords = $<HTMLInputElement>('#job-search-keywords')!;
    expect(keywords.getAttribute('aria-invalid')).toBe('true');
    expect($('#job-search-keywords-error')?.textContent).toContain('Enter a keyword');

    await setControl(keywords, 'data engineer');
    expect($('#job-search-keywords-error')).toBeNull();
    expect(keywords.getAttribute('aria-invalid')).toBe('false');
  });

  it('flags a missing country and an unsupported one', async () => {
    await mount(createElement(JobSearchPanel));
    const country = $<HTMLSelectElement>('#job-search-country')!;
    expect($('#job-search-country-error')?.textContent).toContain('Choose a country');

    await setControl(country, 'in');
    expect($('#job-search-country-error')).toBeNull();
  });

  it('bounds the numeric filters and reports out-of-range values', async () => {
    await mount(createElement(JobSearchPanel));
    const where = $<HTMLInputElement>('#job-search-where')!;
    const distance = $<HTMLInputElement>('#job-search-distance')!;
    const maxDays = $<HTMLInputElement>('#job-search-max-days')!;

    // A radius is meaningless without a location, so the control is disabled.
    expect(distance.disabled).toBe(true);
    await setControl(where, 'Pune');
    expect(distance.disabled).toBe(false);

    await setControl(distance, '0');
    expect($('#job-search-distance-error')?.textContent).toContain('between 1 and 500');

    await setControl(distance, '25');
    expect($('#job-search-distance-error')).toBeNull();

    await setControl(maxDays, '500');
    expect($('#job-search-max-days-error')?.textContent).toContain('between 1 and 365');
  });

  it('keeps Search disabled while the form is incomplete, and still unavailable', async () => {
    await mount(createElement(JobSearchPanel));
    await setControl($<HTMLInputElement>('#job-search-keywords')!, 'data engineer');
    await setControl($<HTMLSelectElement>('#job-search-country')!, 'in');
    // The form is now valid, but no provider is configured: the honest reason is
    // shown and Search stays disabled.
    expect(text()).toContain(JOB_SEARCH_UNAVAILABLE_MESSAGES['not-configured']);
    expect($<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect($('[data-state="unavailable"]')).not.toBeNull();
  });
});

describe('the clear action resets the form and the results area', () => {
  it('empties every field and returns to the start state', async () => {
    await mount(createElement(JobSearchPanel));
    await setControl($<HTMLInputElement>('#job-search-keywords')!, 'data engineer');
    await setControl($<HTMLSelectElement>('#job-search-country')!, 'in');
    await setControl($<HTMLInputElement>('#job-search-where')!, 'Pune');

    const clear = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Clear')!;
    await act(async () => {
      clear.click();
    });

    expect($<HTMLInputElement>('#job-search-keywords')!.value).toBe('');
    expect($<HTMLSelectElement>('#job-search-country')!.value).toBe('');
    expect($<HTMLInputElement>('#job-search-where')!.value).toBe('');
    expect($('[data-state="unavailable"]')).not.toBeNull();
    // Still no fabricated listings after a reset.
    expect(container.querySelectorAll('li.search-result')).toHaveLength(0);
  });
});

describe('accessibility', () => {
  it('labels every control programmatically', async () => {
    await mount(createElement(JobSearchPanel));
    const form = $('form');
    expect(form?.getAttribute('aria-label')).toBe('Job search');

    for (const id of [
      'job-search-keywords',
      'job-search-where',
      'job-search-country',
      'job-search-distance',
      'job-search-max-days',
      'job-search-sort',
    ]) {
      const control = $(`#${id}`);
      expect(control, `missing #${id}`).not.toBeNull();
      const label = container.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      expect(label, `missing label for #${id}`).not.toBeNull();
      expect(label!.textContent).toBeTruthy();
    }
  });

  it('uses real buttons (keyboard operable) and announces state changes', async () => {
    await mount(createElement(JobSearchPanel));
    for (const button of Array.from(container.querySelectorAll('button'))) {
      expect(['button', 'submit']).toContain(button.getAttribute('type'));
    }
    // The availability reason and the results area are live status regions.
    expect($('[data-availability]')?.getAttribute('role')).toBe('status');
    expect($('[data-state="unavailable"]')?.getAttribute('role')).toBe('status');
  });
});

/* ------------------------------------------------------------------ */
/* Discovery stays separate from saving/applying                       */
/* ------------------------------------------------------------------ */

describe('the new surface does not duplicate or trigger existing systems', () => {
  const panelSource = readFileSync(
    join(process.cwd(), 'entrypoints', 'options', 'JobSearchPanel.tsx'),
    'utf8',
  );
  const logicSource = readFileSync(join(process.cwd(), 'src', 'lib', 'job-search', 'ui.ts'), 'utf8');

  /**
   * CHANGED BY PROMPT 29 (intentionally, and verified here): the panel may now
   * WRITE — but only through `guardJobSave()` (re-reading persisted postings at
   * the final boundary) and the validating `upsertJobPosting()` service. What it
   * still must never do is score a match, touch the application log, read storage
   * itself, or bypass the service layer.
   */
  it('scores no match and creates no application entry', () => {
    for (const forbidden of ['calculateJobMatch', 'startTrackingApplication']) {
      expect(panelSource, `panel must not reference ${forbidden}`).not.toContain(forbidden);
      expect(logicSource, `logic must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never bypasses the guarded storage service', () => {
    // Raw storage / browser APIs stay off-limits — both must go through services.
    for (const source of [panelSource, logicSource]) {
      expect(source).not.toContain('browser.storage');
      expect(source).not.toContain("from 'wxt/browser'");
    }
    // The search LOGIC itself stays pure; only the panel may persist.
    expect(logicSource).not.toContain('upsertJobPosting');
    expect(logicSource).not.toContain('guardJobSave');
    expect(logicSource).not.toContain('loadJobPostings');
    // The panel must do no storage reads of its own (no stale state for the
    // duplicate check) and must write only via the guarded path.
    expect(panelSource).not.toContain('loadJobPostings');
    expect(panelSource).toContain('guardJobSave(');
    expect(panelSource).toContain('upsertJobPosting(');
  });

  it('makes no direct network call of its own', () => {
    expect(panelSource).not.toContain('fetch(');
    expect(logicSource).not.toContain('fetch(');
  });

  it('holds no credential and no arbitrary endpoint', () => {
    for (const source of [panelSource, logicSource]) {
      expect(source).not.toMatch(/app_key|app_id|apiKey/);
    }
    expect(logicSource).toContain('EXTENSION_JOB_SEARCH_CONFIG');
  });
});
