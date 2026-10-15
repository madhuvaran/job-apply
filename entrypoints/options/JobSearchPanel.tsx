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
 * - NO AUTO-SAVE OF SEARCH RESULTS: nothing on the results side writes to
 *   storage, scores a match or submits an application. A SEPARATE, explicit
 *   "Add a job from a listing" flow below lets the user paste a job, review it,
 *   and save it through the Prompt 26.1 duplicate guard + the validating storage
 *   service (Prompt 29).
 * - NO AUTO-APPLY: saving a job never creates an application-log entry.
 *
 * Kept intentionally presentational: all logic lives in `src/lib/job-search/ui.ts`
 * so it can be unit-tested without React.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  buildJobSearchRequest,
  createUnconfiguredSearchProvider,
  describeJobSearchAvailability,
  EMPTY_JOB_IMPORT_FORM,
  EMPTY_JOB_SEARCH_FORM,
  EXTENSION_JOB_SEARCH_CONFIG,
  executeJobSearch,
  identityForDuplicateCheck,
  initialJobSearchState,
  JOB_SEARCH_COUNTRY_OPTIONS,
  JOB_SEARCH_SORT_OPTIONS,
  resetJobImportForm,
  resetJobSearchForm,
  toJobPosting,
  validateJobImportForm,
  validateJobSearchForm,
  buildImportCandidate,
  type JobImportCandidate,
  type JobImportField,
  type JobImportForm,
  type JobImportIssue,
  type JobSearchForm,
  type JobSearchIssue,
  type JobSearchViewState,
  type NormalizedJobResult,
  type NormalizedSearchResults,
  type SalaryRange,
} from '../../src/lib/job-search';
import { guardJobSave, type DuplicateCheckResult } from '../../src/lib/job-duplicates';
import { MAX_RAW_DESCRIPTION_CHARS, type JobPosting } from '../../src/lib/job-posting';
import { upsertJobPosting } from '../../src/lib/storage';
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

  /* ---------------- manual import (Prompt 29) ---------------- */
  /**
   * The import flow's lifecycle. Only `form` → `review` → `saved`:
   * nothing is written before the user has seen the review step, and the
   * duplicate guard runs BOTH on entering review and again immediately before
   * the write (never against this component's state).
   */
  type ImportPhase =
    | { kind: 'form' }
    | { kind: 'review'; candidate: JobImportCandidate; dupCheck: DuplicateCheckResult | null; dupNotice: string | null }
    | { kind: 'saved'; job: JobPosting };

  const [importForm, setImportForm] = useState<JobImportForm>(EMPTY_JOB_IMPORT_FORM);
  const [importPhase, setImportPhase] = useState<ImportPhase>({ kind: 'form' });
  const [importIssues, setImportIssues] = useState<JobImportIssue[]>([]);
  const [importError, setImportError] = useState<string | null>(null);

  const importIssueByField = useMemo(() => {
    const map = new Map<JobImportField, string>();
    for (const issue of importIssues) if (!map.has(issue.field)) map.set(issue.field, issue.message);
    return map;
  }, [importIssues]);

  const setImportField = useCallback(<K extends keyof JobImportForm>(key: K, value: string) => {
    setImportForm((current) => ({ ...current, [key]: value }));
  }, []);

  /** Validate + duplicate-check, then show the review step. Writes nothing. */
  const onReviewImport = useCallback(async () => {
    setImportError(null);
    const built = buildImportCandidate(importForm);
    if (!built.ok) {
      setImportIssues(built.issues);
      return;
    }
    setImportIssues([]);
    const decision = await guardJobSave({
      candidate: identityForDuplicateCheck(built.candidate),
    });
    if (decision.kind === 'blocked-duplicate') {
      setImportPhase({ kind: 'review', candidate: built.candidate, dupCheck: decision.result, dupNotice: null });
      return;
    }
    if (decision.kind === 'blocked-check-failed') {
      setImportPhase({ kind: 'review', candidate: built.candidate, dupCheck: null, dupNotice: decision.message });
      return;
    }
    setImportPhase({ kind: 'review', candidate: built.candidate, dupCheck: null, dupNotice: null });
  }, [importForm]);

  /**
   * Write the reviewed candidate. `override` is the user's explicit
   * "save as a separate record" choice: it skips ONLY this duplicate gate for
   * one attempt and never bypasses storage validation.
   */
  const writeImport = useCallback(
    async (override: boolean) => {
      if (importPhase.kind !== 'review') return;
      setImportError(null);
      if (!override) {
        // FINAL boundary check — re-reads persisted postings, never this state.
        const decision = await guardJobSave({
          candidate: identityForDuplicateCheck(importPhase.candidate),
        });
        if (decision.kind === 'blocked-duplicate') {
          setImportPhase({ kind: 'review', candidate: importPhase.candidate, dupCheck: decision.result, dupNotice: null });
          return;
        }
        if (decision.kind === 'blocked-check-failed') {
          setImportPhase({ kind: 'review', candidate: importPhase.candidate, dupCheck: null, dupNotice: decision.message });
          return;
        }
      }
      const posting = toJobPosting(importPhase.candidate);
      const res = await upsertJobPosting(posting);
      if (res === null) {
        setImportPhase({ kind: 'saved', job: posting });
      } else if (!res.ok) {
        setImportError(`Save failed (${res.reason}). ${res.message}`);
      }
    },
    [importPhase],
  );

  const onCancelImport = useCallback(() => {
    setImportIssues([]);
    setImportError(null);
    setImportPhase({ kind: 'form' });
  }, []);

  const onImportAnother = useCallback(() => {
    setImportForm(resetJobImportForm());
    setImportIssues([]);
    setImportError(null);
    setImportPhase({ kind: 'form' });
  }, []);

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

      <Section title="Add a job from a listing">
        {importPhase.kind === 'form' && (
          <form
            aria-label="Add a job from a listing"
            onSubmit={(event) => {
              event.preventDefault();
              void onReviewImport();
            }}
          >
            <p className="hint">
              Paste what you can see on a listing page. Nothing is fetched or scraped — you are
              reading the page yourself — and nothing is written until you have reviewed it and
              pressed Save.
            </p>
            <Field
              id="import-title"
              label="Job title *"
              error={importIssueByField.get('title')}
            >
              <input
                id="import-title"
                value={importForm.title}
                onChange={(e) => setImportField('title', e.target.value)}
                aria-invalid={importIssueByField.has('title')}
              />
            </Field>
            <Field
              id="import-company"
              label="Company"
              hint="Leave blank if the listing does not state one."
              error={importIssueByField.get('company')}
            >
              <input
                id="import-company"
                value={importForm.company}
                onChange={(e) => setImportField('company', e.target.value)}
                aria-invalid={importIssueByField.has('company')}
              />
            </Field>
            <Field
              id="import-location"
              label="Location"
              hint="Leave blank if the listing does not state one."
              error={importIssueByField.get('location')}
            >
              <input
                id="import-location"
                value={importForm.location}
                onChange={(e) => setImportField('location', e.target.value)}
                aria-invalid={importIssueByField.has('location')}
              />
            </Field>
            <Field
              id="import-url"
              label="Original listing URL"
              hint="http:// or https:// only. The link is stored, never opened or fetched."
              error={importIssueByField.get('originalUrl')}
            >
              <input
                id="import-url"
                value={importForm.url}
                onChange={(e) => setImportField('url', e.target.value)}
                aria-invalid={importIssueByField.has('originalUrl')}
              />
            </Field>
            <Field
              id="import-description"
              label="Description or excerpt *"
              error={importIssueByField.get('rawDescription')}
            >
              <textarea
                id="import-description"
                rows={6}
                maxLength={MAX_RAW_DESCRIPTION_CHARS}
                value={importForm.description}
                onChange={(e) => setImportField('description', e.target.value)}
                aria-invalid={importIssueByField.has('rawDescription')}
              />
            </Field>
            <Field
              id="import-kind"
              label="The text above is *"
              hint="So a short excerpt is never stored as a complete description."
              error={importIssueByField.get('descriptionKind')}
            >
              <select
                id="import-kind"
                value={importForm.descriptionKind}
                onChange={(e) => setImportField('descriptionKind', e.target.value)}
                aria-invalid={importIssueByField.has('descriptionKind')}
              >
                <option value="">Select one…</option>
                <option value="full">The complete description</option>
                <option value="snippet">An excerpt (partial)</option>
              </select>
            </Field>
            <div className="search-actions">
              <button type="submit" className="primary">
                Review
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportForm(resetJobImportForm());
                  setImportIssues([]);
                  setImportError(null);
                }}
              >
                Clear
              </button>
            </div>
          </form>
        )}

        {importPhase.kind === 'review' && (
          <div className="import-review">
            <p className="hint">
              <strong>Nothing is saved yet.</strong> This is exactly what will be stored:
            </p>
            <div className="import-review-card">
              <strong className="import-review-title">{importPhase.candidate.title}</strong>
              <span className="hint">
                {[importPhase.candidate.company, importPhase.candidate.location]
                  .filter((value): value is string => value !== undefined)
                  .join(' · ')}
              </span>
              {importPhase.candidate.company === undefined &&
                importPhase.candidate.location === undefined && (
                  <p className="hint">No company or location was provided.</p>
                )}
              {importPhase.candidate.originalUrl !== undefined && (
                <p className="hint">
                  <a
                    href={importPhase.candidate.originalUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {importPhase.candidate.originalUrl}
                  </a>
                </p>
              )}
              <p className="hint">
                {importPhase.candidate.descriptionKind === 'full'
                  ? 'Complete description'
                  : 'Excerpt only — not the complete description'}
                {' · '}source: manually entered
              </p>
              {importPhase.candidate.compensation !== undefined && (
                <p className="hint">Compensation: {importPhase.candidate.compensation}</p>
              )}
              <div className="import-description">{importPhase.candidate.rawDescription}</div>
            </div>

            {importPhase.dupCheck !== null && (
              <div className="duplicate-warning" role="alert" data-status={importPhase.dupCheck.status}>
                <p className="warn">{importPhase.dupCheck.explanation}</p>
                {importPhase.dupCheck.matches.length > 0 && (
                  <ul className="duplicate-matches">
                    {importPhase.dupCheck.matches.map((match) => (
                      <li key={match.jobId}>
                        <strong>{match.title}</strong>
                        {match.company !== null && <span className="hint"> — {match.company}</span>}
                        {match.originalUrl !== null && (
                          <span className="hint">
                            {' '}
                            <a href={match.originalUrl} target="_blank" rel="noreferrer noopener">
                              Saved listing
                            </a>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="hint">
                  Open the <strong>Jobs</strong> tab to inspect the saved record. Nothing is merged or
                  overwritten — saving separately adds a new, separate record.
                </p>
              </div>
            )}
            {importPhase.dupNotice !== null && (
              <div className="duplicate-warning" role="status" data-status="check-failed">
                <p className="warn">{importPhase.dupNotice}</p>
                <p className="hint">
                  Duplicate protection could not run against your saved jobs. Saving separately still
                  goes through the same validation and will not overwrite stored data it cannot read.
                </p>
              </div>
            )}
            {importError !== null && (
              <div className="banner banner-error" role="alert" data-state="import-error">
                {importError}
              </div>
            )}

            <div className="search-actions">
              <button type="button" onClick={onCancelImport}>
                Cancel
              </button>
              {importPhase.dupCheck !== null || importPhase.dupNotice !== null ? (
                <button
                  type="button"
                  className="primary"
                  data-action="save-separately"
                  onClick={() => void writeImport(true)}
                >
                  Save as a separate record
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  data-action="save-import"
                  onClick={() => void writeImport(false)}
                >
                  Save job
                </button>
              )}
            </div>
          </div>
        )}

        {importPhase.kind === 'saved' && (
          <div className="banner banner-info" role="status" data-state="import-saved">
            <strong>Job saved.</strong>
            <p>&ldquo;{importPhase.job.title}&rdquo; was added to your saved jobs.</p>
            <button type="button" onClick={onImportAnother}>
              Add another job
            </button>
            <p className="hint">
              Open the <strong>Jobs</strong> tab to estimate a match, track an application or tailor a
              resume — importing a job never does any of those automatically.
            </p>
          </div>
        )}
      </Section>

      <Section title="Adding jobs without live search">
        <p className="hint">
          Live job search is unavailable until a secure search endpoint is configured. The form
          above is the way to get a listing in from anywhere: paste its title, URL and description,
          review what will be stored, and save it through the same validation, duplicate protection
          and storage everything else uses. For richer editing (extracted sections, work mode, dates)
          use <strong>Jobs → Edit</strong>, and <strong>Capture current job</strong> in the popup
          captures the page you are viewing.
        </p>
        <p className="hint">
          Search results, pagination and saved searches arrive with live search. Nothing found or
          pasted here is saved without your confirmation, and nothing is applied to automatically.
        </p>
      </Section>
    </div>
  );
}

/** Exported for tests: the panel's own issue type (see `src/lib/job-search/ui.ts`). */
export type { JobSearchIssue };
