/**
 * Options page: master profile editor.
 *
 * Uses only the validated storage service (via src/lib/editor.ts). No sample
 * data is auto-applied; the sample button explicitly seeds the DRAFT with
 * clearly-fake data and only persists after an explicit Save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addItem,
  applySampleToDraft,
  bulletsToLines,
  dateRangeToFields,
  draftsDiffer,
  emptyDraft,
  fieldsToDateRange,
  isEmptyProfileState,
  linesToBullets,
  loadEditorState,
  newItemCertification,
  newItemEducation,
  newItemExperience,
  newItemProject,
  profileToDraft,
  removeItem,
  saveDraft,
  updateItem,
  validateDraft,
  type EditorLoadState,
  type ProfileDraft,
} from '../../src/lib/editor';
import { sampleProfile } from '../../src/lib/sample-profile';
import type { Profile } from '../../src/lib/profile';
import SettingsPanel from './SettingsPanel';
import JobSearchPanel from './JobSearchPanel';
import JobsPanel from './JobsPanel';
import ApplicationsPanel from './ApplicationsPanel';
import DashboardPanel, { type DashboardNavTarget } from './DashboardPanel';
import { Row, Section } from './ui';
import './style.css';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'error'; message: string };

type Tab = 'dashboard' | 'profile' | 'settings' | 'search' | 'jobs' | 'applications';

export default function App() {
  const [tab, setTab] = useState<Tab>('profile');
  /**
   * Dashboard → Jobs navigation (Prompt 30): the saved job whose details the
   * Jobs tab should open. One-shot by design — pressing the Jobs tab directly
   * clears it again, so a later visit never jumps to an old selection.
   */
  const [jobsFocusId, setJobsFocusId] = useState<string | null>(null);
  const [load, setLoad] = useState<EditorLoadState>({ kind: 'empty' });
  const [draft, setDraftState] = useState<ProfileDraft>(emptyDraft());
  const [savedSnapshot, setSavedSnapshot] = useState<ProfileDraft>(emptyDraft());
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [migrationBanner, setMigrationBanner] = useState<string | null>(null);
  const dirty = useMemo(() => draftsDiffer(draft, savedSnapshot), [draft, savedSnapshot]);
  const errors = useMemo(() => validateDraft(draft), [draft]);

  /** Dashboard navigation: switch tab, optionally focusing a saved job. */
  const onDashboardNavigate = useCallback((target: DashboardNavTarget, jobId?: string) => {
    setJobsFocusId(jobId ?? null);
    setTab(target);
  }, []);

  /* ---------------- load on mount ---------------- */
  useEffect(() => {
    void (async () => {
      const state = await loadEditorState();
      setLoad(state);
      if (state.kind === 'ready') {
        const d = profileToDraft(state.profile);
        setDraft(d);
        setSavedSnapshot(d);
      }
    })();
  }, []);

  /* ---------------- unsaved-change protection ---------------- */
  const setDraft = setDraftState as React.Dispatch<React.SetStateAction<ProfileDraft>>;
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (draftsDiffer(draft, savedSnapshot)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [draft, savedSnapshot]);

  const patch = useCallback(<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  /* ---------------- save ---------------- */
  const onSave = useCallback(async () => {
    setSaveState({ kind: 'saving' });
    const result = await saveDraft(draft);
    if (result === null) {
      const aware: Profile = { ...draft, schemaVersion: '2', updatedAt: new Date().toISOString() };
      const snapshot = profileToDraft(aware);
      setSavedSnapshot(snapshot);
      setSaveState({ kind: 'saved', at: new Date().toLocaleTimeString() });
      setLoad({ kind: 'ready', profile: aware });
    } else if (!result.ok) {
      setSaveState({ kind: 'error', message: `Save failed: ${result.reason}. ${result.message}` });
    }
  }, [draft]);

  /* ---------------- reset (explicit confirmation) ---------------- */
  const onResetConfirmed = useCallback(async () => {
    setConfirmingReset(false);
    const { resetProfile } = await import('../../src/lib/storage');
    const res = await resetProfile();
    if (res === null) {
      const empty = emptyDraft();
      setDraft(empty);
      setSavedSnapshot(empty);
      setSaveState({ kind: 'saved', at: new Date().toLocaleTimeString() });
    } else if (!res.ok) {
      setSaveState({ kind: 'error', message: `Reset failed: ${res.reason}` });
    }
  }, []);

  /* ---------------- migration ---------------- */
  const onMigrate = useCallback(async () => {
    const { migrateLegacyProfile: migrate } = await import('../../src/lib/storage');
    const r = await migrate();
    if (r.migrated === 'legacy_profile') {
      const state = await loadEditorState();
      setLoad(state);
      if (state.kind === 'ready') {
        const d = profileToDraft(state.profile);
        setDraft(d);
        setSavedSnapshot(d);
      }
      setMigrationBanner(
        `Migrated legacy profile. Warnings: ${r.warnings.length ? r.warnings.join(' | ') : 'none'}`,
      );
    } else {
      setMigrationBanner(`Nothing migrated (${r.migrated}). ${r.warnings.join(' | ')}`);
    }
  }, []);

  /* ---------------- sample seeding (explicit) ---------------- */
  const onSeedSample = useCallback(() => {
    setDraft(applySampleToDraft(sampleProfile));
  }, []);

  return (
    <div className="options-page">
      <header className="options-header">
        <h1>
          {tab === 'dashboard'
            ? 'Dashboard'
            : tab === 'profile'
              ? 'Master profile'
              : tab === 'settings'
                ? 'Settings & privacy'
                : tab === 'search'
                  ? 'Job search'
                  : tab === 'jobs'
                    ? 'Jobs'
                    : 'Applications'}
        </h1>
        <nav className="tabs" aria-label="Options sections">
          <button
            type="button"
            className={tab === 'dashboard' ? 'tab active' : 'tab'}
            aria-current={tab === 'dashboard' ? 'page' : undefined}
            onClick={() => setTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={tab === 'profile' ? 'tab active' : 'tab'}
            aria-current={tab === 'profile' ? 'page' : undefined}
            onClick={() => setTab('profile')}
          >
            Profile
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'tab active' : 'tab'}
            aria-current={tab === 'settings' ? 'page' : undefined}
            onClick={() => setTab('settings')}
          >
            Settings &amp; privacy
          </button>
          <button
            type="button"
            className={tab === 'search' ? 'tab active' : 'tab'}
            aria-current={tab === 'search' ? 'page' : undefined}
            onClick={() => setTab('search')}
          >
            Job search
          </button>
          <button
            type="button"
            className={tab === 'jobs' ? 'tab active' : 'tab'}
            aria-current={tab === 'jobs' ? 'page' : undefined}
            onClick={() => {
              setJobsFocusId(null);
              setTab('jobs');
            }}
          >
            Jobs
          </button>
          <button
            type="button"
            className={tab === 'applications' ? 'tab active' : 'tab'}
            aria-current={tab === 'applications' ? 'page' : undefined}
            onClick={() => setTab('applications')}
          >
            Applications
          </button>
        </nav>
        {tab === 'profile' && <SaveStatus state={saveState} dirty={dirty} />}
      </header>

      {tab === 'dashboard' ? (
        <DashboardPanel onNavigate={onDashboardNavigate} />
      ) : tab === 'search' ? (
        <JobSearchPanel />
      ) : tab === 'jobs' ? (
        <JobsPanel focusJobId={jobsFocusId} />
      ) : tab === 'applications' ? (
        <ApplicationsPanel />
      ) : tab === 'settings' ? (
        <SettingsPanel />
      ) : (
        <>
          {load.kind === 'empty' && <EmptyOnboarding migrationBanner={migrationBanner} onMigrate={onMigrate} onSeedSample={onSeedSample} />}
          {load.kind === 'malformed' && (
            <MalformedBanner
              message={load.message}
              onRecover={onResetConfirmed}
              confirming={confirmingReset}
              onAskConfirm={() => setConfirmingReset(true)}
              onCancel={() => setConfirmingReset(false)}
            />
          )}
          {load.kind === 'unavailable' && <div className="banner banner-error">{load.message}</div>}

          <EditorForm
            draft={draft}
            errors={errors}
            patch={patch}
            setDraft={setDraft}
          />

          <footer className="options-footer">
            <button type="button" onClick={onSeedSample}>Seed draft with fake sample</button>
            <button type="button" className="danger" onClick={() => setConfirmingReset(true)} disabled={!dirty && load.kind === 'ready'}>
              Reset profile…
            </button>
            {confirmingReset && (
              <span className="confirm-inline" role="alertdialog" aria-label="Confirm reset">
                Really replace the stored profile with an empty one?
                <button type="button" className="danger" onClick={onResetConfirmed}>Yes, reset</button>
                <button type="button" onClick={() => setConfirmingReset(false)}>Cancel</button>
              </span>
            )}
            <button type="button" className="primary" onClick={onSave} disabled={!dirty || errors.length > 0 || saveState.kind === 'saving'}>
              {saveState.kind === 'saving' ? 'Saving…' : 'Save profile'}
            </button>
          </footer>

          {errors.length > 0 && (
            <div className="banner banner-error" role="alert">
              <strong>Fix before saving:</strong>
              <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  return (
    <div className="save-status" aria-live="polite">
      {state.kind === 'saved' && <span>✓ Saved at {state.at}</span>}
      {state.kind === 'saving' && <span>Saving…</span>}
      {state.kind === 'error' && <span className="error">{state.message}</span>}
      {state.kind === 'idle' && dirty && <span>Unsaved changes</span>}
    </div>
  );
}

function EmptyOnboarding({ onMigrate, onSeedSample, migrationBanner }: {
  onMigrate: () => void;
  onSeedSample: () => void;
  migrationBanner: string | null;
}) {
  return (
    <div className="banner banner-info onboarding">
      <h2>Set up your profile</h2>
      <p>
        Nothing is stored yet. Fill the form below, or migrate data from an older
        version of the extension if you had one.
      </p>
      <button type="button" onClick={onMigrate}>Migrate old profile (non-destructive)</button>
      <button type="button" onClick={onSeedSample}>Seed draft with fake sample (dev)</button>
      <p className="hint">The sample data is obviously fake — it is only a drafting aid and persists only if you save it.</p>
      {migrationBanner && <p className="banner-warning">{migrationBanner}</p>}
    </div>
  );
}

function MalformedBanner({ message, onRecover, confirming, onAskConfirm, onCancel }: {
  message: string;
  onRecover: () => Promise<void>;
  confirming: boolean;
  onAskConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="banner banner-error" role="alert">
      <p>Stored profile data is malformed and could not be loaded. {message}</p>
      <p>Your data has NOT been overwritten. You can recover by replacing it with an empty profile.</p>
      {!confirming && <button type="button" onClick={onAskConfirm}>Recover with empty profile…</button>}
      {confirming && (
        <span>
          <button type="button" className="danger" onClick={() => void onRecover()}>Yes, replace with empty</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor form by sections                                              */
/* ------------------------------------------------------------------ */

interface EditorFormProps {
  draft: ProfileDraft;
  errors: string[];
  patch: <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => void;
  setDraft: React.Dispatch<React.SetStateAction<ProfileDraft>>;
}

function EditorForm({ draft, patch, setDraft }: EditorFormProps) {
  return (
    <div className="sections">
      <Section title="Identity">
        <Row label="Display name">
          <input value={draft.displayName ?? ''} onChange={(e) => patch('displayName', e.target.value || undefined)} placeholder="Shown on the resume" />
        </Row>
        <Row label="Headline">
          <input value={draft.headline ?? ''} onChange={(e) => patch('headline', e.target.value || undefined)} placeholder="e.g. Senior Backend Engineer" />
        </Row>
        <Row label="Location label">
          <input value={draft.locationLabel ?? ''} onChange={(e) => patch('locationLabel', e.target.value || undefined)} placeholder="e.g. Berlin, DE (Remote)" />
        </Row>
        <Row label="Professional summary">
          <textarea value={draft.summary ?? ''} onChange={(e) => patch('summary', e.target.value || undefined)} rows={4} />
        </Row>
      </Section>

      <Section title="Skills">
        <SkillList draft={draft} setDraft={setDraft} />
      </Section>

      <ExperienceSection draft={draft} setDraft={setDraft} />
      <EducationSection draft={draft} setDraft={setDraft} />
      <CertificationsSection draft={draft} setDraft={setDraft} />
      <ProjectsSection draft={draft} setDraft={setDraft} />

      <Section title="Links">
        <Row label="Portfolio URL"><input value={draft.portfolio ?? ''} onChange={(e) => patch('portfolio', e.target.value || undefined)} /></Row>
        <Row label="GitHub URL"><input value={draft.github ?? ''} onChange={(e) => patch('github', e.target.value || undefined)} /></Row>
        <Row label="LinkedIn URL"><input value={draft.linkedin ?? ''} onChange={(e) => patch('linkedin', e.target.value || undefined)} /></Row>
      </Section>

      <Section title="Application answers">
        <p className="hint">
          Target titles, target locations and work modes now live in the
          {' '}<strong>Settings &amp; privacy</strong> tab, where job-search settings
          (employment type, experience range, excluded employers, match threshold,
          resume format, AI) are also kept.
        </p>
        <Row label="Explicit application answers">
          <RepeatableAnswers draft={draft} setDraft={setDraft} />
        </Row>
      </Section>
    </div>
  );
}

function SkillList({ draft, setDraft }: { draft: ProfileDraft; setDraft: (u: (d: ProfileDraft) => ProfileDraft) => void }) {
  const items: Profile['skills'] = draft.skills;
  const set = (next: typeof items) => setDraft((d) => ({ ...d, skills: next }));
  return (
    <div className="repeatable">
      {items.map((skill) => (
        <div className="repeatable-item" key={skill.id}>
          <input placeholder="Skill name" value={skill.name}
            onChange={(e) => set(updateItem(items, skill.id, { name: e.target.value }))} />
          <button type="button" className="remove" onClick={() => set(removeItem(items, skill.id))}>Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => set(addItem(items, { id: crypto.randomUUID(), name: '', status: 'claimed' }))}>Add skill</button>
    </div>
  );
}

function ExperienceSection({ draft, setDraft }: { draft: ProfileDraft; setDraft: (u: (d: ProfileDraft) => ProfileDraft) => void }) {
  const items = draft.experience;
  const set = (next: typeof items) => setDraft((d) => ({ ...d, experience: next }));
  return (
    <Section title="Work history">
      {items.map((exp, idx) => {
        const fields = dateRangeToFields(exp.dates);
        return (
          <fieldset className="card" key={exp.id}>
            <legend>Experience {idx + 1}</legend>
            <Row label="Company">
              <input value={exp.company} onChange={(e) => set(updateItem(items, exp.id, { company: e.target.value }))} />
            </Row>
            <Row label="Title">
              <input value={exp.title} onChange={(e) => set(updateItem(items, exp.id, { title: e.target.value }))} />
            </Row>
            <Row label="Bullets (one per line, required)">
              <textarea rows={3} value={bulletsToLines(exp.bullets)}
                onChange={(e) => set(updateItem(items, exp.id, { bullets: linesToBullets(e.target.value) }))} />
            </Row>
            <Row label="Dates">
              <input type="month" value={fields.start}
                onChange={(e) => set(updateItem(items, exp.id, { dates: { ...fieldsToDateRange(fields), start: e.target.value } }))} />
              <label className="checkbox-label">
                <input type="checkbox" checked={fields.ongoing}
                  onChange={(e) => set(updateItem(items, exp.id, { dates: fieldsToDateRange({ ...fields, ongoing: e.target.checked }) }))} />
                Currently ongoing
              </label>
              {!fields.ongoing && (
                <input type="month" value={fields.end}
                  onChange={(e) => set(updateItem(items, exp.id, { dates: fieldsToDateRange({ ...fields, end: e.target.value }) }))} />
              )}
            </Row>
            <button type="button" className="remove" onClick={() => set(removeItem(items, exp.id))}>Remove experience</button>
          </fieldset>
        );
      })}
      <button type="button" onClick={() => set(addItem(items, newItemExperience()))}>Add experience</button>
    </Section>
  );
}

function EducationSection({ draft, setDraft }: { draft: ProfileDraft; setDraft: (u: (d: ProfileDraft) => ProfileDraft) => void }) {
  const items = draft.education;
  const set = (next: typeof items) => setDraft((d) => ({ ...d, education: next }));
  return (
    <Section title="Education">
      {items.map((edu, idx) => (
        <fieldset className="card" key={edu.id}>
          <legend>Education {idx + 1}</legend>
          <Row label="Institution">
            <input value={edu.institution} onChange={(e) => set(updateItem(items, edu.id, { institution: e.target.value }))} />
          </Row>
          <Row label="Credential">
            <input value={edu.credential ?? ''} onChange={(e) => set(updateItem(items, edu.id, { credential: e.target.value || undefined }))} />
          </Row>
          <Row label="Dates">
            <input type="month" value={edu.dates.start}
              onChange={(e) => set(updateItem(items, edu.id, { dates: { ...edu.dates, start: e.target.value } }))} />
            <input type="month" value={edu.dates.end ?? ''}
              onChange={(e) => set(updateItem(items, edu.id, { dates: { ...edu.dates, end: e.target.value || null } }))} />
          </Row>
          <Row label="In progress">
            <input type="checkbox" checked={edu.inProgress}
              onChange={(e) => set(updateItem(items, edu.id, { inProgress: e.target.checked }))} />
          </Row>
          <button type="button" className="remove" onClick={() => set(removeItem(items, edu.id))}>Remove education</button>
        </fieldset>
      ))}
      <button type="button" onClick={() => set(addItem(items, newItemEducation()))}>Add education</button>
    </Section>
  );
}

function CertificationsSection({ draft, setDraft }: { draft: ProfileDraft; setDraft: (u: (d: ProfileDraft) => ProfileDraft) => void }) {
  const items = draft.certifications;
  const set = (next: typeof items) => setDraft((d) => ({ ...d, certifications: next }));
  return (
    <Section title="Certifications">
      {items.map((cert, idx) => (
        <fieldset className="card" key={cert.id}>
          <legend>Certification {idx + 1}</legend>
          <Row label="Name">
            <input value={cert.name} onChange={(e) => set(updateItem(items, cert.id, { name: e.target.value }))} />
          </Row>
          <Row label="Issuer">
            <input value={cert.issuer ?? ''} onChange={(e) => set(updateItem(items, cert.id, { issuer: e.target.value || undefined }))} />
          </Row>
          <button type="button" className="remove" onClick={() => set(removeItem(items, cert.id))}>Remove certification</button>
        </fieldset>
      ))}
      <button type="button" onClick={() => set(addItem(items, newItemCertification()))}>Add certification</button>
    </Section>
  );
}

function ProjectsSection({ draft, setDraft }: { draft: ProfileDraft; setDraft: (u: (d: ProfileDraft) => ProfileDraft) => void }) {
  const items = draft.projects;
  const set = (next: typeof items) => setDraft((d) => ({ ...d, projects: next }));
  return (
    <Section title="Projects">
      {items.map((proj, idx) => (
        <fieldset className="card" key={proj.id}>
          <legend>Project {idx + 1}</legend>
          <Row label="Name">
            <input value={proj.name} onChange={(e) => set(updateItem(items, proj.id, { name: e.target.value }))} />
          </Row>
          <Row label="Description">
            <textarea rows={2} value={proj.description} onChange={(e) => set(updateItem(items, proj.id, { description: e.target.value }))} />
          </Row>
          <button type="button" className="remove" onClick={() => set(removeItem(items, proj.id))}>Remove project</button>
        </fieldset>
      ))}
      <button type="button" onClick={() => set(addItem(items, newItemProject()))}>Add project</button>
    </Section>
  );
}

function RepeatableAnswers({ draft, setDraft }: { draft: ProfileDraft; setDraft: (u: (d: ProfileDraft) => ProfileDraft) => void }) {
  const items = draft.preferences.applicationAnswers;
  const set = (next: typeof items) =>
    setDraft((d) => ({ ...d, preferences: { ...d.preferences, applicationAnswers: next } }));
  return (
    <div className="repeatable">
      {items.map((ans, idx) => (
        <div className="repeatable-item card" key={ans.id}>
          <Row label="Question">
            <input value={ans.question} onChange={(e) => set(updateItem(items, ans.id, { question: e.target.value }))} />
          </Row>
          <Row label="Saved answer">
            <textarea rows={2} value={ans.answer} onChange={(e) => set(updateItem(items, ans.id, { answer: e.target.value }))} />
          </Row>
          <button type="button" className="remove" onClick={() => set(removeItem(items, ans.id))}>Remove answer</button>
        </div>
      ))}
      <button type="button" onClick={() => set(addItem(items, { id: crypto.randomUUID(), question: '', answer: '' }))}>Add answer</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout atoms are shared with the settings panel (see ./ui.tsx)       */
/* ------------------------------------------------------------------ */
