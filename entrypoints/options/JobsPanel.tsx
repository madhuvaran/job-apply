/**
 * Options page — "Jobs" tab: manual job intake (Prompt 07).
 *
 * - Save: validated against the SAME zod schema storage enforces; invalid
 *   forms never write. Edit: loads a saved posting (id + capture timestamp
 *   preserved, updatedAt bumped). Cancel: discards the form, writes nothing.
 * - "Extract sections" is an explicit button running the deterministic
 *   extractor over the pasted description; every extracted line stays
 *   editable, and extraction never modifies the raw description.
 * - Unknown/missing values stay blank (never guessed): company, location,
 *   URL, work arrangement, employment type, experience range, compensation.
 * - Captured jobs from the popup appear in the same list (source labelled).
 * - "Estimate match" (Prompt 10) selects a saved job and renders the
 *   deterministic match summary (Options → Jobs). Matching runs offline via
 *   `calculateJobMatch` over the AI-safe profile + selected posting + loaded
 *   settings; the sensitive profile is never read here. The summary
 *   recalculates automatically when the selection or inputs change.
 * - Resume section (Prompts 12 & 19): download a tailored PDF, explicitly
 *   save a version to the local resume history, and manage saved versions
 *   (open / export snapshot / delete with confirmation) below.
 * - Duplicate protection (Prompts 26 & 26.1): both save paths (this manual form
 *   and the popup capture preview) run `guardJobSave()` IMMEDIATELY BEFORE the
 *   write, which re-reads the PERSISTED job postings (never this component's
 *   possibly stale state, so a posting saved from another tab is still caught).
 *   A confirmed URL/identifier match, an ambiguous match, or a possible
 *   company+title match shows the saved record and waits for an explicit
 *   decision; when editing, that same posting is excluded from its own check.
 *   Nothing is merged, overwritten or deleted, and a separate record is only
 *   created when the user explicitly asks for it.
 * - Priority shortlist (Prompt 24): the saved jobs are grouped into
 *   apply-first / good-match / needs-review / already-applied by the PURE
 *   `prioritizeJobs()` module (`src/lib/prioritization`). This panel only
 *   assembles its inputs — already-computed match estimates, the application
 *   log and today's local calendar date — and never scores anything itself.
 *   Unreadable inputs fail closed (the affected signal is shown as unknown and
 *   a concise explanation appears); nothing is written back to storage and no
 *   application is started, submitted or filled.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createJobPosting,
  extractJobSections,
  MAX_RAW_DESCRIPTION_CHARS,
  validatePostingDraft,
  type JobPosting,
} from '../../src/lib/job-posting';
import { localCalendarDate, postedDateFieldValue } from '../../src/lib/job-dates';
import { guardJobSave, type DuplicateCheckResult } from '../../src/lib/job-duplicates';
import { calculateJobMatch } from '../../src/lib/matching';
import {
  prioritizeJobs,
  type PrioritizationOutcome,
  type PriorityCategory,
} from '../../src/lib/prioritization';
import {
  loadApplications,
  loadJobPostings,
  loadProfile,
  loadSettings,
  resetJobPostings,
  upsertJobPosting,
} from '../../src/lib/storage';
import {
  defaultSettings,
  EMPLOYMENT_TYPES,
  WORK_MODES,
  type EmploymentType,
  type Settings,
  type WorkMode,
} from '../../src/lib/settings';
import type { Profile } from '../../src/lib/profile';
import { Row, Section } from './ui';
import PostingDateLabel from './PostingDateLabel';
import MatchSummary from './MatchSummary';
import PriorityList from './PriorityList';
import ResumeExport from './ResumeExport';
import ResumeHistory from './ResumeHistory';
import { startTrackingApplication, type Application } from '../../src/lib/applications';

interface FormState {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  responsibilities: string;
  requiredQualifications: string;
  preferredQualifications: string;
  skills: string;
  workMode: string; // '' | WorkMode
  employmentType: string; // '' | EmploymentType
  minYears: string;
  maxYears: string;
  compensation: string;
  /** `YYYY-MM-DD` from the date input, or '' for "unknown". */
  postedDate: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  company: '',
  location: '',
  url: '',
  description: '',
  responsibilities: '',
  requiredQualifications: '',
  preferredQualifications: '',
  skills: '',
  workMode: '',
  employmentType: '',
  minYears: '',
  maxYears: '',
  compensation: '',
  postedDate: '',
};

type LoadState = 'loading' | 'ready' | 'malformed' | 'unavailable';

function toList(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function toLines(list: string[]): string {
  return list.join('\n');
}

function parseOptionalNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export interface JobsPanelProps {
  /**
   * Saved job to open on mount (Prompt 30: Dashboard → "View job details").
   * It only preselects the existing match-summary/resume sections for that job —
   * nothing is created, submitted or filled, and the selection can be cleared
   * exactly like a manual one.
   */
  focusJobId?: string | null;
}

export default function JobsPanel({ focusJobId = null }: JobsPanelProps) {
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null); // null = list view / new
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  /**
   * Duplicate protection (Prompts 26 & 26.1): a non-null result means the draft
   * matches already-saved job(s) — nothing has been written and the user decides.
   */
  const [dupCheck, setDupCheck] = useState<DuplicateCheckResult | null>(null);
  /** Fixed message when the pre-write check could not run (nothing was written). */
  const [dupNotice, setDupNotice] = useState<string | null>(null);
  // Match summary (Prompt 10): selection + the AI-safe inputs it needs. A
  // dashboard navigation may preselect one saved job (Prompt 30).
  const [selectedId, setSelectedId] = useState<string | null>(focusJobId);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileState, setProfileState] = useState<'loading' | 'ready'>('loading');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsState, setSettingsState] = useState<'loading' | 'ready'>('loading');
  // Priority shortlist (Prompt 24). The application log is loaded read-only:
  // `null` means it could NOT be read (application status stays unknown and no
  // job is called "already applied").
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [applicationsState, setApplicationsState] = useState<'loading' | 'ready'>('loading');
  const [priorityCategory, setPriorityCategory] = useState<PriorityCategory>('apply-first');
  // Resume version history (Prompt 19): bumped when a version is saved so the
  // history section below reloads without touching any other state.
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const refresh = useCallback(async () => {
    const res = await loadJobPostings();
    if (res.ok) {
      setPostings(res.data.postings);
      setLoadState('ready');
    } else if (res.reason === 'malformed') {
      setLoadState('malformed');
      setLoadMessage(res.message);
    } else if (res.reason === 'absent') {
      setPostings([]);
      setLoadState('ready');
    } else {
      setLoadState('unavailable');
      setLoadMessage(res.message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load the AI-safe profile and job settings for the match summary once.
  // Corrupt/failed settings are surfaced as `null` (no threshold is guessed);
  // an absent profile is `null` and the summary explains what to do. Corrupt
  // stored data is never overwritten by this read path.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [profileRes, settingsRes, applicationsRes] = await Promise.all([
        loadProfile(),
        loadSettings(),
        loadApplications(),
      ]);
      if (cancelled) return;
      setProfile(profileRes.ok ? profileRes.data : null);
      setProfileState('ready');
      // `absent` = the log was never written → reliably empty. Anything else
      // that is not readable (malformed/unavailable) fails closed to `null`.
      setApplications(
        applicationsRes.ok ? applicationsRes.data.applications : applicationsRes.reason === 'absent' ? [] : null,
      );
      setApplicationsState('ready');
      if (settingsRes.ok) {
        setSettings(settingsRes.data);
      } else if (settingsRes.reason === 'absent') {
        // Schema default (minMatchThreshold 0 = filtering off) — documented behavior.
        setSettings(defaultSettings());
      } else {
        setSettings(null);
      }
      setSettingsState('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  /* ---------------- list <-> form ---------------- */
  const startCreate = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setErrors([]);
    setDupCheck(null);
    setCreating(true);
  }, []);

  const startEdit = useCallback((posting: JobPosting) => {
    setForm({
      title: posting.title,
      company: posting.company ?? '',
      location: posting.location ?? '',
      url: posting.originalUrl ?? '',
      description: posting.rawDescription,
      responsibilities: toLines(posting.responsibilities),
      requiredQualifications: toLines(posting.requiredQualifications),
      preferredQualifications: toLines(posting.preferredQualifications),
      skills: toLines(posting.skills),
      workMode: posting.workArrangement ?? '',
      employmentType: posting.employmentType ?? '',
      minYears: posting.experienceRange?.minYears?.toString() ?? '',
      maxYears: posting.experienceRange?.maxYears?.toString() ?? '',
      compensation: posting.compensation ?? '',
      postedDate: posting.postedDate ?? '',
    });
    setEditingId(posting.id);
    setCreating(true);
    setErrors([]);
    setDupCheck(null);
  }, []);

  const cancel = useCallback(() => {
    setCreating(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors([]); // nothing was written
    setDupCheck(null);
  }, []);

  const onExtract = useCallback(() => {
    const sections = extractJobSections(form.description);
    setForm((f) => ({
      ...f,
      responsibilities: toLines(sections.responsibilities),
      requiredQualifications: toLines(sections.requiredQualifications),
      preferredQualifications: toLines(sections.preferredQualifications),
      skills: toLines(sections.skills),
    }));
  }, [form.description]);

  /* ---------------- save (validate, check duplicates, then write) ---------------- */
  /** The form as a posting draft (identity fields preserved when editing). */
  const buildCandidate = useCallback(() => {
    const original = editingId ? postings.find((p) => p.id === editingId) : undefined;
    const minYears = parseOptionalNumber(form.minYears);
    const maxYears = parseOptionalNumber(form.maxYears);
    const nowIso = new Date().toISOString();
    const candidate = {
      ...(original ? { id: original.id, capturedAt: original.capturedAt, source: original.source } : {}),
      title: form.title.trim(),
      company: form.company.trim() || undefined,
      location: form.location.trim() || undefined,
      originalUrl: form.url.trim() || undefined,
      rawDescription: form.description,
      responsibilities: toList(form.responsibilities),
      requiredQualifications: toList(form.requiredQualifications),
      preferredQualifications: toList(form.preferredQualifications),
      skills: toList(form.skills),
      workArrangement: (form.workMode || undefined) as WorkMode | undefined,
      employmentType: (form.employmentType || undefined) as EmploymentType | undefined,
      experienceRange:
        minYears !== undefined || maxYears !== undefined ? { minYears, maxYears } : undefined,
      compensation: form.compensation.trim() || undefined,
      // Blank date → ABSENT (never the capture time, never today).
      postedDate: postedDateFieldValue(form.postedDate),
      ...(original ? { updatedAt: nowIso } : {}),
    };
    return { original, candidate, nowIso };
  }, [editingId, form, postings]);

  /**
   * Write the validated draft. The duplicate gate runs HERE — immediately before
   * the write and against freshly PERSISTED postings (never this component's
   * `postings` state), so a posting saved from another tab is still caught
   * (Prompt 26.1). When editing, the record's own id is excluded so it is never
   * treated as a duplicate of itself.
   *
   * `override` is the user's explicit choice after reviewing a warning: it skips
   * ONLY this gate for one attempt (never a permanent setting) and still goes
   * through the validating storage service, which refuses malformed data.
   */
  const writePosting = useCallback(
    async (override: boolean) => {
      const { original, candidate, nowIso } = buildCandidate();
      if (!override) {
        const decision = await guardJobSave({
          candidate: {
            title: form.title.trim(),
            ...(form.company.trim() === '' ? {} : { company: form.company.trim() }),
            ...(form.url.trim() === '' ? {} : { originalUrl: form.url.trim() }),
          },
          ...(editingId === null ? {} : { excludeJobIds: [editingId] }),
        });
        if (decision.kind === 'blocked-duplicate') {
          setErrors([]);
          setDupNotice(null);
          setDupCheck(decision.result);
          return; // nothing was written
        }
        if (decision.kind === 'blocked-check-failed') {
          setDupCheck(null);
          setDupNotice(decision.message);
          return; // nothing was written
        }
      }
      const posting = createJobPosting(candidate, () => nowIso);
      const res = await upsertJobPosting(posting);
      if (res === null) {
        await refresh();
        setCreating(false);
        setEditingId(null);
        setForm(EMPTY_FORM);
        setDupCheck(null);
        setDupNotice(null);
        setNotice(original ? 'Posting updated.' : 'Posting saved.');
      } else if (!res.ok) {
        setErrors([`Save failed (${res.reason}). ${res.message}`]);
      }
    },
    [buildCandidate, editingId, form, refresh],
  );

  const onSave = useCallback(async () => {
    const { candidate } = buildCandidate();
    // Validate the draft: identity placeholders are supplied for a NEW posting
    // (createJobPosting mints the real id/timestamp); an edit keeps its own.
    const issues = validatePostingDraft(candidate);
    if (issues.length > 0) {
      setErrors(issues);
      return;
    }
    setDupCheck(null);
    setDupNotice(null);
    // The duplicate gate runs inside `writePosting`, immediately before the
    // write and against freshly persisted postings (Prompt 26.1).
    await writePosting(false);
  }, [buildCandidate, writePosting]);

  /**
   * Explicit "save anyway"/"save as a separate record": one attempt, one write —
   * the gate is not re-run, so there is no warning loop, while the storage
   * service still validates and refuses malformed data.
   */
  const onSaveAnyway = useCallback(() => {
    setDupCheck(null);
    setDupNotice(null);
    void writePosting(true);
  }, [writePosting]);

  /** "View saved record": leave the form and open that job in the saved list. */
  const onViewDuplicate = useCallback((jobId: string) => {
    setDupCheck(null);
    setCreating(false);
    setEditingId(null);
    setErrors([]);
    setSelectedId(jobId);
  }, []);

  // Start tracking an application for a saved job (Prompt 13). Reuses an
  // existing application for the same job (no accidental duplicates); the
  // explicit log form still allows deliberate repeat applications.
  const onTrackApplication = useCallback(async (jobId: string) => {
    setErrors([]);
    setNotice(null);
    const outcome = await startTrackingApplication(jobId);
    if (!outcome.ok) {
      setErrors([outcome.message]);
      return;
    }
    setNotice(
      outcome.data.alreadyTracked
        ? 'Already tracking this job — open the Applications tab to update it.'
        : 'Tracking this job as "Planned" — open the Applications tab to update it.',
    );
  }, []);

  const onResetConfirmed = useCallback(async () => {
    setConfirmingReset(false);
    const res = await resetJobPostings();
    if (res === null) {
      await refresh();
      setNotice('Job list replaced with an empty list.');
    } else if (!res.ok) {
      setErrors([`Reset failed (${res.reason}). ${res.message}`]);
    }
  }, [refresh]);

  const sorted = useMemo(
    () => [...postings].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)),
    [postings],
  );

  // Selected posting for the match summary (selection follows the list, so a
  // reset or removal simply clears the summary — nothing stale is rendered).
  const selectedPosting = useMemo(
    () => (selectedId === null ? undefined : postings.find((p) => p.id === selectedId)),
    [postings, selectedId],
  );

  // Priority shortlist inputs (Prompt 24): reuse the ALREADY-COMPUTED match
  // estimates for every saved job and hand them, the application log, the
  // configured minimum and today's LOCAL calendar date to the pure module.
  // Matching is never re-implemented here, no score is invented, and an
  // unreadable input (`null`) makes the module fail closed instead of guessing.
  const priorityOutcome = useMemo<PrioritizationOutcome>(() => {
    const matches =
      profile === null || settings === null
        ? []
        : postings.map((job) => ({
            jobId: job.id,
            result: calculateJobMatch(profile, job, settings),
          }));
    return prioritizeJobs({
      jobs: postings,
      matches,
      applications,
      today: localCalendarDate(),
      minMatchThreshold: settings === null ? null : settings.minMatchThreshold,
    });
  }, [postings, profile, settings, applications]);

  // Extra, panel-known context the pure module cannot see: a missing profile
  // means no estimate exists at all, so every job must fall back to review.
  const priorityNotes = useMemo(
    () =>
      profile === null
        ? [
            'No usable master profile is loaded, so no match estimate exists — every saved job falls back to needs review. Add or repair your profile on the Profile tab.',
          ]
        : [],
    [profile],
  );

  return (
    <div className="jobs-panel">
      {loadState === 'loading' && <div className="banner banner-info">Loading jobs…</div>}
      {loadState === 'unavailable' && (
        <div className="banner banner-error" role="alert">{loadMessage}</div>
      )}
      {loadState === 'malformed' && (
        <div className="banner banner-error" role="alert">
          <p>Stored job data is malformed and could not be loaded. {loadMessage}</p>
          <p>Your data has NOT been overwritten. You can replace it with an empty list explicitly.</p>
          {!confirmingReset && (
            <button type="button" onClick={() => setConfirmingReset(true)}>Replace with empty list…</button>
          )}
          {confirmingReset && (
            <span>
              <button type="button" className="danger" onClick={() => void onResetConfirmed()}>
                Yes, replace
              </button>
              <button type="button" onClick={() => setConfirmingReset(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {notice && (
        <div className="banner banner-info" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {!creating ? (
        <>
          <Section title="Saved jobs">
            {sorted.length === 0 && (
              <p className="hint">
                No jobs saved yet. Add one manually below, or use &ldquo;Capture current job&rdquo;
                in the popup while viewing a job listing.
              </p>
            )}
            {sorted.map((p) => (
              <div className="job-item" key={p.id}>
                <div>
                  <strong>{p.title}</strong>
                  <span className="hint">
                    {[p.company, p.location].filter(Boolean).join(' · ')}
                    {p.company || p.location ? ' — ' : ''}
                    {p.source === 'page-capture' ? 'captured from page' : 'manual entry'} on{' '}
                    {p.capturedAt.slice(0, 10)}
                  </span>
                  <div className="hint">
                    <PostingDateLabel postedDate={p.postedDate} />
                  </div>
                  {p.originalUrl && (
                    <span className="hint">
                      <a href={p.originalUrl} target="_blank" rel="noreferrer noopener">{p.originalUrl}</a>
                    </span>
                  )}
                </div>
                <div className="job-item-actions">
                  <button
                    type="button"
                    aria-pressed={selectedId === p.id}
                    onClick={() => setSelectedId((current) => (current === p.id ? null : p.id))}
                  >
                    {selectedId === p.id ? 'Hide match' : 'Estimate match'}
                  </button>
                  <button type="button" onClick={() => void onTrackApplication(p.id)}>
                    Track application
                  </button>
                  <button type="button" onClick={() => startEdit(p)}>Edit</button>
                </div>
              </div>
            ))}
          </Section>
          <Section title="Priority shortlist">
            {loadState === 'loading' ||
            profileState === 'loading' ||
            settingsState === 'loading' ||
            applicationsState === 'loading' ? (
              <p className="hint">Loading prioritization inputs…</p>
            ) : loadState !== 'ready' ? (
              <p className="hint">
                Saved jobs could not be loaded, so no prioritization is shown. Nothing was changed.
              </p>
            ) : priorityOutcome.kind === 'invalid' ? (
              <div className="banner banner-error" role="alert">
                Prioritization is unavailable: {priorityOutcome.issues.join('; ')}. Nothing was
                changed.
              </div>
            ) : (
              <PriorityList
                result={priorityOutcome.result}
                selected={priorityCategory}
                onSelect={setPriorityCategory}
                extraNotes={priorityNotes}
              />
            )}
          </Section>
          {selectedPosting !== undefined && (
            <>
              <Section title={`Match estimate — ${selectedPosting.title}`}>
                {profileState === 'loading' || settingsState === 'loading' ? (
                  <p className="hint">Loading match inputs…</p>
                ) : (
                  <>
                    <MatchSummary profile={profile} job={selectedPosting} settings={settings} />
                    <button
                      type="button"
                      className="match-clear"
                      onClick={() => setSelectedId(null)}
                    >
                      Clear selection
                    </button>
                  </>
                )}
              </Section>
              <Section title={`Resume PDF — ${selectedPosting.title}`}>
                {profileState === 'loading' ? (
                  <p className="hint">Loading profile…</p>
                ) : (
                  <ResumeExport
                    profile={profile}
                    job={selectedPosting}
                    onVersionSaved={() => setHistoryRefresh((n) => n + 1)}
                  />
                )}
              </Section>
            </>
          )}
          <ResumeHistory refreshToken={historyRefresh} />
          <footer className="options-footer">
            <button type="button" className="primary" onClick={startCreate}>Add job manually</button>
          </footer>
        </>
      ) : (
        <>
          <Section title={editingId ? 'Edit job posting' : 'Add job posting (manual)'}>
            <p className="hint">
              Only what the posting states is stored. Leave unknown fields blank — nothing is
              guessed. The raw description is preserved verbatim.
            </p>
            <Row label="Job title *">
              <input value={form.title} onChange={(e) => set('title', e.target.value)} />
            </Row>
            <Row label="Company">
              <input value={form.company} onChange={(e) => set('company', e.target.value)} placeholder="Leave blank if not stated" />
            </Row>
            <Row label="Location">
              <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Leave blank if not stated" />
            </Row>
            <Row label="Original URL">
              <input value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" />
            </Row>
            <Row label="Job description *">
              <textarea
                rows={8}
                maxLength={MAX_RAW_DESCRIPTION_CHARS}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Row>
            <Row label="Extracted sections">
              <button type="button" onClick={onExtract}>Extract sections from description</button>
              <span className="hint">
                Deterministic extraction from headings (Responsibilities / Requirements / Preferred
                / Skills). Edit the results freely; the raw description is never changed.
              </span>
            </Row>
            <Row label="Responsibilities (one per line)">
              <textarea rows={3} value={form.responsibilities} onChange={(e) => set('responsibilities', e.target.value)} />
            </Row>
            <Row label="Required qualifications">
              <textarea rows={3} value={form.requiredQualifications} onChange={(e) => set('requiredQualifications', e.target.value)} />
            </Row>
            <Row label="Preferred qualifications">
              <textarea rows={3} value={form.preferredQualifications} onChange={(e) => set('preferredQualifications', e.target.value)} />
            </Row>
            <Row label="Skills / technologies">
              <textarea rows={3} value={form.skills} onChange={(e) => set('skills', e.target.value)} />
            </Row>
            <Row label="Work arrangement">
              <select value={form.workMode} onChange={(e) => set('workMode', e.target.value)}>
                <option value="">Not stated</option>
                {WORK_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Row>
            <Row label="Employment type">
              <select value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
                <option value="">Not stated</option>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Row>
            <Row label="Experience range (years)">
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                aria-label="Posting minimum years"
                placeholder="min"
                value={form.minYears}
                onChange={(e) => set('minYears', e.target.value)}
              />
              <span aria-hidden="true">to</span>
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                aria-label="Posting maximum years"
                placeholder="max"
                value={form.maxYears}
                onChange={(e) => set('maxYears', e.target.value)}
              />
            </Row>
            <Row label="Compensation as posted">
              <input
                value={form.compensation}
                onChange={(e) => set('compensation', e.target.value)}
                placeholder="Only if the posting states it — leave blank otherwise"
              />
            </Row>
            <Row label="Posting date">
              <input
                type="date"
                value={form.postedDate}
                onChange={(e) => set('postedDate', e.target.value)}
                aria-label="Posting date (YYYY-MM-DD)"
              />
              <button type="button" onClick={() => set('postedDate', '')} disabled={form.postedDate === ''}>
                Clear date
              </button>
              <span className="hint">
                Only when the posting published one. Leave blank for unknown — a blank date is
                never replaced by the capture time.
              </span>
            </Row>
            {errors.length > 0 && (
              <div className="banner banner-error" role="alert">
                <strong>Fix before saving:</strong>
                <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </div>
            )}
            {dupCheck !== null && (
              <div className="duplicate-warning" role="alert" data-status={dupCheck.status}>
                <p className="warn">{dupCheck.explanation}</p>
                {dupCheck.matches.length > 0 && (
                  <ul className="duplicate-matches">
                    {dupCheck.matches.map((m) => (
                      <li key={m.jobId}>
                        <strong>{m.title}</strong>
                        {m.company !== null && <span className="hint"> — {m.company}</span>}
                        {m.originalUrl !== null && (
                          <span className="hint">
                            {' '}
                            <a href={m.originalUrl} target="_blank" rel="noreferrer noopener">
                              Saved posting
                            </a>
                          </span>
                        )}
                        <button type="button" onClick={() => onViewDuplicate(m.jobId)}>
                          View saved record
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {dupCheck.status === 'possible' && (
                  <p className="hint">
                    Review the saved job before deciding: if this is a different vacancy, saving creates
                    a separate record.
                  </p>
                )}
                <p className="hint">
                  Nothing is merged or overwritten. Saving anyway adds a new, separate record.
                </p>
              </div>
            )}
            {dupNotice !== null && (
              <div className="duplicate-warning" role="status" data-status="check-failed">
                <p className="warn">{dupNotice}</p>
                <p className="hint">
                  Duplicate protection could not run against your saved jobs. Saving anyway still
                  goes through the same validation and will not overwrite stored data it cannot read.
                </p>
              </div>
            )}
          </Section>
          <footer className="options-footer">
            <button type="button" onClick={cancel}>Cancel</button>
            {dupCheck !== null || dupNotice !== null ? (
              <button type="button" className="primary" onClick={onSaveAnyway}>
                {dupCheck === null
                  ? 'Save anyway'
                  : editingId !== null
                    ? 'Save changes anyway'
                    : 'Save as a separate record'}
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => void onSave()}>
                {editingId ? 'Update posting' : 'Save posting'}
              </button>
            )}
          </footer>
        </>
      )}
    </div>
  );
}
