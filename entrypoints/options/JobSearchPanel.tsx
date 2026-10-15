/**
 * Options → "Job search" tab (Prompt 28).
 *
 * The first usable job-discovery surface. It is a THIN view over Prompt 27's
 * provider-agnostic job-search module:
 *
 * - FORM → REQUEST: the form is turned into a request by the pure
 *   `buildJobSearchRequest()` (`src/lib/job-search/ui.ts`), which delegates the
 *   real validation to Prompt 27's own strict Adzuna schema — no second
 *   validator, no duplicated schema.
 * - STATE MACHINE: `executeJobSearch()` owns the ordering (availability → form →
 *   request) and returns a discriminated view state. A failure can therefore
 *   never be rendered as an empty successful search.
 * - HONEST UNAVAILABLE STATE: no secure proxy is deployed and no endpoint can be
 *   configured in this build (Prompt 27 forbids arbitrary URLs, and no credential
 *   may live in the extension), so search is DISABLED, the Search button is
 *   disabled with the reason shown, and zero network requests are made. Nothing
 *   is faked and no example listings are shown.
 * - PLACEHOLDER-FREE RESULTS: optional provider fields are only rendered when the
 *   provider supplied them; missing company/location are stated as missing rather
 *   than filled with a default, salary is shown WITHOUT inventing a currency, and
 *   the required Adzuna attribution travels with the results.
 * - NO AUTO-SAVE / NO AUTO-APPLY: nothing here writes to storage, tracks an
 *   application or submits a form. Saving a discovered job is a separate,
 *   user-controlled action (see the note in the panel and README).
 *
 * Kept intentionally presentational: all logic lives in `src/lib/job-search/ui.ts`
 * so it can be unit-tested without React.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  buildJobSearchRequest,
  createUnconfiguredSearchProvider,
  describeJobSearchAvailability,
  EMPTY_JOB_SEARCH_FORM,
  EXTENSION_JOB_SEARCH_CONFIG,
  executeJobSearch,
  initialJobSearchState,
  JOB_SEARCH_COUNTRY_OPTIONS,
  JOB_SEARCH_SORT_OPTIONS,
  resetJobSearchForm,
  validateJobSearchForm,
  type JobSearchForm,
  type JobSearchIssue,
  type JobSearchViewState,
  type NormalizedJobResult,
  type NormalizedSearchResults,
  type SalaryRange,
} from '../../src/lib/job-search';
import { formatPostingDate } from '../../src/lib/job-dates';
import { Section } from './ui';

/* ------------------------------------------------------------------ */
/* Formatting helpers (deterministic — no locale/ICU dependency)       */
/* ------------------------------------------------------------------ */

/** Group digits with thousands separators, independent of the host locale. */
export function groupDigits(value: number): string {
  const whole = Math.trunc(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  return `${sign}${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * The salary line, or `null` when the provider stated no amount.
 *
 * NO CURRENCY IS INVENTED: Adzuna returns amounts in the searched country's local
 * currency and never states which one, so the line says so plainly instead of
 * guessing a symbol. A Jobsworth figure is labelled as an estimate.
 */
export function salaryText(salary: SalaryRange): string | null {
  const { min, max } = salary;
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined) {
    return `${groupDigits(min)} – ${groupDigits(max)}`;
  }
  if (min !== undefined) return `${groupDigits(min)} or more`;
  return `up to ${groupDigits(max ?? 0)}`;
}

/* ------------------------------------------------------------------ */
/* Results presentation                                                */
/* ------------------------------------------------------------------ */

function SalaryLine({ salary }: { salary: SalaryRange }) {
  const text = salaryText(salary);
  if (text === null) return null;
  return (
    <p className="search-salary">
      Salary: <strong>{text}</strong>
      <span className="hint">
        {' '}
        The search service did not state a currency, so no currency is shown.
      </span>
      {salary.predicted === true && (
        <span className="hint"> Estimated by Adzuna (Jobsworth) — not an advertised figure.</span>
      )}
    </p>
  );
}

/** One normalized result. Only fields the provider supplied are rendered. */
export function SearchResultCard({ job }: { job: NormalizedJobResult }) {
  // Built from the fields the provider actually supplied; no empty placeholder
  // element is rendered when it supplied none of them.
  const place = [job.company, job.location]
    .filter((v): v is string => v !== undefined)
    .join(' · ');
  return (
    <li className="search-result" data-external-id={job.externalId}>
      <div className="search-result-head">
        <strong className="search-result-title">{job.title}</strong>
        {place !== '' && <span className="hint">{place}</span>}
      </div>
      {place === '' && (
        <p className="hint">The search service did not provide a company or location for this listing.</p>
      )}
      {job.postedDate !== undefined && (
        <p className="hint">Posted {formatPostingDate(job.postedDate)}</p>
      )}
      {job.salary !== undefined && <SalaryLine salary={job.salary} />}
      {job.description !== undefined && <p className="search-snippet">{job.description}</p>}
      <p className="search-result-actions">
        <a href={job.url} target="_blank" rel="noreferrer noopener">
          Open original listing
        </a>
        <span className="hint"> Opens the advertiser&rsquo;s page in a new tab.</span>
      </p>
    </li>
  );
}

/**
 * The results area for a given state. Exported so every state can be rendered
 * and asserted directly with deterministic props (no network, no provider).
 */
export function JobSearchResults({ state }: { state: JobSearchViewState }) {
  switch (state.kind) {
    case 'initial':
      return (
        <div className="search-state" data-state="initial">
          <p className="hint">No search has been run yet. Fill in the form above and choose Search.</p>
        </div>
      );

    case 'unavailable':
      return (
        <div className="search-state search-state-unavailable" data-state="unavailable" role="status">
          <p className="warn">{state.message}</p>
          <p className="hint">
            Nothing was requested and no results are shown. The extension holds no job-board
            credentials and talks only to a secure endpoint operated by you; none is configured in
            this build.
          </p>
        </div>
      );

    case 'invalid':
      return (
        <div className="search-state banner banner-error" data-state="invalid" role="alert">
          <strong>Check the search form:</strong>
          <ul>
            {state.issues.map((issue) => (
              <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      );

    case 'loading':
      return (
        <div className="search-state banner banner-info" data-state="loading" role="status" aria-busy="true">
          Searching…
        </div>
      );

    case 'error':
      return (
        <div
          className="search-state banner banner-error"
          data-state="error"
          data-error-kind={state.error.kind}
          role="alert"
        >
          <strong>Search failed — no results were returned.</strong>
          <p>{state.message}</p>
        </div>
      );

    case 'results':
      return <SearchResultsPage page={state.page} />;
  }
}

function SearchResultsPage({ page }: { page: NormalizedSearchResults }) {
  const count = page.results.length;
  return (
    <div className="search-state" data-state="results" data-count={count}>
      {count === 0 ? (
        <p className="hint" role="status">
          The search ran successfully and returned no matching jobs. Try broader keywords, another
          location or a larger posted-within window.
        </p>
      ) : (
        <>
          <p className="search-count" role="status">
            <strong>{groupDigits(count)}</strong> listing{count === 1 ? '' : 's'} on this page
            {page.totalCount !== undefined && (
              <> of {groupDigits(page.totalCount)} reported by the search service</>
            )}
            .
          </p>
          <ul className="search-results">
            {page.results.map((job) => (
              <SearchResultCard key={`${job.provider}:${job.externalId}`} job={job} />
            ))}
          </ul>
          {page.skipped > 0 && (
            <p className="hint">
              {groupDigits(page.skipped)} listing{page.skipped === 1 ? '' : 's'} could not be used and
              {page.skipped === 1 ? ' was' : ' were'} not shown.
            </p>
          )}
        </>
      )}
      {/* Required provider credit, rendered exactly as the provider states it. */}
      <p className="search-attribution">
        Listings supplied by{' '}
        <a
          href={page.attribution.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            display: 'inline-block',
            ...(page.attribution.minWidthPx === undefined
              ? {}
              : { minWidth: `${page.attribution.minWidthPx}px` }),
            ...(page.attribution.minHeightPx === undefined
              ? {}
              : { minHeight: `${page.attribution.minHeightPx}px` }),
          }}
        >
          {page.attribution.text}
        </a>
      </p>
      <p className="hint">{page.attribution.notice}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form field helpers (real labels — accessible, unlike a bare span)   */
/* ------------------------------------------------------------------ */

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="row">
      <label className="row-label" htmlFor={id}>
        {label}
      </label>
      <div className="row-control">
        {children}
        {error !== undefined && (
          <span className="hint field-error" id={`${id}-error`} role="alert">
            {error}
          </span>
        )}
        {hint !== undefined && <span className="hint">{hint}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export default function JobSearchPanel() {
  const [form, setForm] = useState<JobSearchForm>(EMPTY_JOB_SEARCH_FORM);
  const [state, setState] = useState<JobSearchViewState>(() => initialJobSearchState());

  // The configuration is a constant in this build (no user-editable endpoint).
  const availability = useMemo(
    () => describeJobSearchAvailability(EXTENSION_JOB_SEARCH_CONFIG),
    [],
  );
  // Can never legitimately be called: the disabled config makes `runJobSearch()`
  // return `not-configured` before the transport is reached.
  const provider = useMemo(() => createUnconfiguredSearchProvider(), []);

  const issues = useMemo(() => validateJobSearchForm(form), [form]);
  const issueByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) if (!map.has(issue.field)) map.set(issue.field, issue.message);
    return map;
  }, [issues]);

  const loading = state.kind === 'loading';
  const canSearch = availability.available && issues.length === 0 && !loading;

  const set = useCallback(<K extends keyof JobSearchForm>(key: K, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const onClear = useCallback(() => {
    setForm(resetJobSearchForm());
    setState(initialJobSearchState());
  }, []);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setState({ kind: 'loading' });
      const next = await executeJobSearch({ form, provider });
      setState(next);
    },
    [form, provider],
  );

  const distanceDisabled = form.where.trim() === '';

  return (
    <div className="job-search-panel">
      <Section title="Search jobs">
        <p className="hint">
          Search {JOB_SEARCH_COUNTRY_OPTIONS.length} supported countries for job adverts. Only the
          keywords, location and filters below are sent — never your profile, resume, contact
          details or compensation.
        </p>
        <form aria-label="Job search" onSubmit={(event) => void onSubmit(event)}>
          <Field
            id="job-search-keywords"
            label="Keywords or job title *"
            error={issueByField.get('keywords')}
          >
            <input
              id="job-search-keywords"
              value={form.keywords}
              onChange={(e) => set('keywords', e.target.value)}
              aria-invalid={issueByField.has('keywords')}
              {...(issueByField.has('keywords')
                ? { 'aria-describedby': 'job-search-keywords-error' }
                : {})}
            />
          </Field>

          <Field
            id="job-search-where"
            label="Location"
            hint="Optional. A city, region or postal code."
            error={issueByField.get('where')}
          >
            <input
              id="job-search-where"
              value={form.where}
              onChange={(e) => set('where', e.target.value)}
              aria-invalid={issueByField.has('where')}
            />
          </Field>

          <Field
            id="job-search-country"
            label="Country *"
            error={issueByField.get('country')}
            hint="Only countries the verified search contract supports."
          >
            <select
              id="job-search-country"
              value={form.country}
              onChange={(e) => set('country', e.target.value)}
              aria-invalid={issueByField.has('country')}
            >
              <option value="">Select a country…</option>
              {JOB_SEARCH_COUNTRY_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label} ({option.code})
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="job-search-distance"
            label="Search radius (km)"
            hint="Optional. Requires a location; otherwise it is ignored."
            error={issueByField.get('distanceKm')}
          >
            <input
              id="job-search-distance"
              type="number"
              min={1}
              max={500}
              step={1}
              value={form.distanceKm}
              onChange={(e) => set('distanceKm', e.target.value)}
              disabled={distanceDisabled}
              aria-disabled={distanceDisabled}
              aria-invalid={issueByField.has('distanceKm')}
            />
            {distanceDisabled && <span className="hint">Add a location to use a radius.</span>}
          </Field>

          <Field
            id="job-search-max-days"
            label="Posted within (days)"
            hint="Optional. Leave blank to let the search service decide."
            error={issueByField.get('maxDaysOld')}
          >
            <input
              id="job-search-max-days"
              type="number"
              min={1}
              max={365}
              step={1}
              value={form.maxDaysOld}
              onChange={(e) => set('maxDaysOld', e.target.value)}
              aria-invalid={issueByField.has('maxDaysOld')}
            />
          </Field>

          <Field id="job-search-sort" label="Sort by" error={issueByField.get('sortBy')}>
            <select
              id="job-search-sort"
              value={form.sortBy}
              onChange={(e) => set('sortBy', e.target.value)}
              aria-invalid={issueByField.has('sortBy')}
            >
              {JOB_SEARCH_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="search-actions">
            <button type="submit" className="primary" disabled={!canSearch}>
              Search
            </button>
            <button type="button" onClick={onClear} disabled={loading}>
              Clear
            </button>
          </div>
          <p className="hint" role="status" data-availability={availability.available ? 'available' : 'unavailable'}>
            {!availability.available
              ? availability.message
              : issues.length > 0
                ? 'Fix the highlighted fields to enable search.'
                : 'Ready to search.'}
          </p>
        </form>
      </Section>

      <Section title="Results">
        <JobSearchResults state={state} />
      </Section>

      <Section title="Adding jobs without live search">
        <p className="hint">
          Live job search is unavailable until a secure search endpoint is configured. You can still
          build your job list today: paste a listing&rsquo;s URL and description in
          <strong> Jobs → Add job manually</strong>, or use <strong>Capture current job</strong> in
          the popup while viewing a posting — both go through the same validation, duplicate
          protection and storage as everything else.
        </p>
        <p className="hint">
          Saving a search result, pagination and saved searches arrive with live search; nothing
          found on this screen is saved or applied to automatically.
        </p>
      </Section>
    </div>
  );
}

/** Exported for tests: the panel's own issue type (see `src/lib/job-search/ui.ts`). */
export type { JobSearchIssue };
