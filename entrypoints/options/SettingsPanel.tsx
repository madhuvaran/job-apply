/**
 * Options page — "Settings & privacy" tab.
 *
 * Covers (Prompt 05): target titles, target locations, remote/hybrid/on-site,
 * employment types, experience range, optional salary preference, excluded
 * employers, minimum match threshold, resume format, AI enabled/disabled, and
 * the privacy explanation of what stays local versus what may be sent to a
 * configured AI provider.
 *
 * Thin view over src/lib/settings.ts (schema, defaults, validation,
 * normalization, seeding mapper) and src/lib/storage.ts (persistence). Rules:
 * - Nothing is written without an explicit Save / Import / Reset click.
 * - AI is off by default; the current build makes no network requests.
 * - Invalid ranges/settings block Save with messages derived from the SAME
 *   zod schema storage enforces.
 * - Import from profile is offered only when settings are absent, is a
 *   read-only copy of profile.preferences, and is disabled while unsaved
 *   edits exist (values are never silently replaced).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  defaultSettings,
  EMPLOYMENT_TYPES,
  hasSeedablePreferences,
  normalizeSettings,
  PRIVACY_NOTICE,
  RESUME_FORMATS,
  validateSettings,
  WORK_MODES,
  type SalaryPreference,
  type Settings,
} from '../../src/lib/settings';
import {
  loadProfile,
  loadSettings,
  migrateSettingsFromProfile,
  resetSettings,
  saveSettings,
} from '../../src/lib/storage';
import { Row, Section } from './ui';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'error'; message: string };

type LoadKind = 'loading' | 'ready' | 'absent' | 'malformed' | 'unavailable';

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [snapshot, setSnapshot] = useState<Settings>(defaultSettings);
  const [loadKind, setLoadKind] = useState<LoadKind>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [seedOffered, setSeedOffered] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(snapshot),
    [settings, snapshot],
  );
  // Normalize BEFORE validating: a trailing newline while typing must not
  // block saving (empty lines are dropped at save time).
  const errors = useMemo(() => validateSettings(normalizeSettings(settings)), [settings]);

  /* ---------------- load ---------------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await loadSettings();
      if (cancelled) return;
      if (res.ok) {
        setSettings(res.data);
        setSnapshot(res.data);
        setLoadKind('ready');
        return;
      }
      const defaults = defaultSettings();
      setSettings(defaults);
      setSnapshot(defaults);
      if (res.reason === 'malformed') {
        setLoadKind('malformed');
        setLoadMessage(res.message);
        return;
      }
      if (res.reason === 'unavailable') {
        setLoadKind('unavailable');
        setLoadMessage(res.message);
        return;
      }
      setLoadKind('absent');
      // Offer a one-time, non-destructive import of targeting from the profile.
      const profile = await loadProfile();
      if (cancelled) return;
      if (profile.ok && hasSeedablePreferences(profile.data.preferences)) setSeedOffered(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- unsaved-change protection ---------------- */
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(settings) !== JSON.stringify(snapshot)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [settings, snapshot]);

  const patch = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  /* ---------------- save ---------------- */
  const onSave = useCallback(async () => {
    const candidate: Settings = {
      ...normalizeSettings(settings),
      updatedAt: new Date().toISOString(),
    };
    setSaveState({ kind: 'saving' });
    const res = await saveSettings(candidate);
    if (res === null) {
      setSettings(candidate);
      setSnapshot(candidate);
      setLoadKind('ready');
      setSaveState({ kind: 'saved', at: new Date().toLocaleTimeString() });
    } else if (!res.ok) {
      setSaveState({ kind: 'error', message: `Save failed: ${res.reason}. ${res.message}` });
    }
  }, [settings]);

  /* ---------------- import targeting from profile (explicit, read-only) ---------------- */
  const onImportSeed = useCallback(async () => {
    const r = await migrateSettingsFromProfile();
    if (r.migrated === 'seeded') {
      const res = await loadSettings();
      if (res.ok) {
        setSettings(res.data);
        setSnapshot(res.data);
        setLoadKind('ready');
        setSeedOffered(false);
        setNotice('Imported target titles, locations and work modes from your master profile. The profile itself was not changed.');
        return;
      }
    }
    setNotice(`Nothing imported (${r.migrated}). ${r.warnings.join(' ')}`);
  }, []);

  /* ---------------- reset (explicit confirmation, defaults only) ---------------- */
  const onResetConfirmed = useCallback(async () => {
    setConfirmingReset(false);
    const res = await resetSettings();
    if (res === null) {
      const defaults = defaultSettings();
      setSettings(defaults);
      setSnapshot(defaults);
      setLoadKind('ready');
      setSaveState({ kind: 'saved', at: new Date().toLocaleTimeString() });
      setNotice('Settings replaced with the conservative defaults.');
    } else if (!res.ok) {
      setSaveState({ kind: 'error', message: `Reset failed: ${res.reason}. ${res.message}` });
    }
  }, []);

  return (
    <div className="settings-panel">
      {loadKind === 'loading' && <div className="banner banner-info">Loading settings…</div>}

      {loadKind === 'malformed' && (
        <div className="banner banner-error" role="alert">
          <p>Stored settings are malformed and could not be loaded. {loadMessage}</p>
          <p>Your data has NOT been overwritten. You can replace it with the defaults explicitly.</p>
          {!confirmingReset && (
            <button type="button" onClick={() => setConfirmingReset(true)}>
              Replace with defaults…
            </button>
          )}
          {confirmingReset && (
            <span>
              <button type="button" className="danger" onClick={() => void onResetConfirmed()}>
                Yes, replace with defaults
              </button>
              <button type="button" onClick={() => setConfirmingReset(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}

      {loadKind === 'unavailable' && (
        <div className="banner banner-error" role="alert">{loadMessage}</div>
      )}

      {loadKind === 'absent' && seedOffered && !dirty && (
        <div className="banner banner-info">
          <strong>Import your targeting preferences?</strong>
          <p className="hint">
            You already stored target titles, locations or work modes in your master profile.
            Import copies them here (read-only — your profile is not modified). You can also
            start from the empty defaults below.
          </p>
          <button type="button" onClick={() => void onImportSeed()}>Import from profile</button>
        </div>
      )}

      {notice && (
        <div className="banner banner-info" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="sections">
        <Section title="Target preferences">
          <Row label="Target titles (one per line)">
            <textarea
              rows={3}
              value={settings.targetTitles.join('\n')}
              placeholder="e.g. Senior Backend Engineer"
              onChange={(e) => patch('targetTitles', e.target.value.split('\n'))}
            />
          </Row>
          <Row label="Target locations (one per line)">
            <textarea
              rows={3}
              value={settings.targetLocations.join('\n')}
              placeholder="e.g. Berlin, DE / Remote (EU)"
              onChange={(e) => patch('targetLocations', e.target.value.split('\n'))}
            />
          </Row>
          <Row label="Work mode">
            {WORK_MODES.map((mode) => (
              <label key={mode} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.workModes.includes(mode)}
                  onChange={(e) =>
                    patch(
                      'workModes',
                      e.target.checked
                        ? [...settings.workModes, mode]
                        : settings.workModes.filter((m) => m !== mode),
                    )
                  }
                />
                {mode}
              </label>
            ))}
          </Row>
          <Row label="Employment type">
            {EMPLOYMENT_TYPES.map((type) => (
              <label key={type} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.employmentTypes.includes(type)}
                  onChange={(e) =>
                    patch(
                      'employmentTypes',
                      e.target.checked
                        ? [...settings.employmentTypes, type]
                        : settings.employmentTypes.filter((t) => t !== type),
                    )
                  }
                />
                {type}
              </label>
            ))}
          </Row>
          <Row label="Experience range (years)">
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              inputMode="numeric"
              placeholder="min"
              aria-label="Minimum years of experience"
              value={settings.experienceRange?.minYears ?? ''}
              onChange={(e) => updateExperienceRange(settings, patch, 'minYears', e.target.value)}
            />
            <span aria-hidden="true">to</span>
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              inputMode="numeric"
              placeholder="max"
              aria-label="Maximum years of experience"
              value={settings.experienceRange?.maxYears ?? ''}
              onChange={(e) => updateExperienceRange(settings, patch, 'maxYears', e.target.value)}
            />
            <span className="hint">Leave both empty for no experience filter.</span>
          </Row>
          <Row label="Excluded employers (one per line)">
            <textarea
              rows={3}
              value={settings.excludedEmployers.join('\n')}
              placeholder="Companies you do not want to be matched with"
              onChange={(e) => patch('excludedEmployers', e.target.value.split('\n'))}
            />
          </Row>
          <Row label="Minimum match threshold">
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              aria-label="Minimum match threshold"
              value={settings.minMatchThreshold}
              onChange={(e) =>
                patch(
                  'minMatchThreshold',
                  e.target.value.trim() === '' ? 0 : Number(e.target.value),
                )
              }
            />
            <span className="hint">
              0–100; <strong>0 = no filtering</strong> (default). Applies to this extension&apos;s
              own transparent resume-to-job match estimate — never an employer&apos;s proprietary
              ATS score, which no one outside the employer can know.
            </span>
          </Row>
        </Section>

        <Section title="Salary preference (optional, stays on this device)">
          <Row label="Currency">
            <input
              type="text"
              maxLength={3}
              placeholder="USD"
              aria-label="Salary currency (3-letter code)"
              value={settings.salary?.currency ?? ''}
              onChange={(e) => updateSalary(settings, patch, { currency: e.target.value.toUpperCase() })}
            />
            <span className="hint">3-letter code, e.g. USD, EUR.</span>
          </Row>
          <Row label="Minimum / maximum annual">
            <input
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              placeholder="min"
              aria-label="Minimum annual amount"
              value={settings.salary?.minAnnual ?? ''}
              onChange={(e) => updateSalary(settings, patch, { minAnnual: parseOptionalNumber(e.target.value) })}
            />
            <span aria-hidden="true">to</span>
            <input
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              placeholder="max"
              aria-label="Maximum annual amount"
              value={settings.salary?.maxAnnual ?? ''}
              onChange={(e) => updateSalary(settings, patch, { maxAnnual: parseOptionalNumber(e.target.value) })}
            />
            <span className="hint">
              Stored only if you provide one. Compensation is never sent to an AI provider.
            </span>
          </Row>
        </Section>

        <Section title="Resume & AI">
          <Row label="Resume format">
            {RESUME_FORMATS.map((format) => (
              <label key={format} className="checkbox-label">
                <input
                  type="radio"
                  name="resume-format"
                  checked={settings.resumeFormat === format}
                  onChange={() => patch('resumeFormat', format)}
                />
                {format === 'pdf' ? 'PDF (fixed ATS-safe layout, default)' : 'DOCX'}
              </label>
            ))}
          </Row>
          <Row label="AI features">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.aiEnabled}
                onChange={(e) => patch('aiEnabled', e.target.checked)}
              />
              Enable AI (off by default)
            </label>
            <p className="hint">
              While AI is off, this extension makes no network requests at all. When you turn it
              on and configure a provider, only the AI-safe master profile and the job description
              you choose are sent to <em>your</em> provider — never your salary preference,
              contact/sensitive record, or legal and voluntary-disclosure answers. Production
              credentials must live behind a backend proxy, never in this extension.
            </p>
          </Row>
        </Section>

        <Section title="Privacy: what stays local, what may be sent">
          <h3>Stays on this device</h3>
          <ul className="privacy-list">
            {PRIVACY_NOTICE.staysLocal.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h3>May be sent to a provider you configure (only with AI enabled)</h3>
          <ul className="privacy-list">
            {PRIVACY_NOTICE.mayBeSent.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h3>Never sent</h3>
          <ul className="privacy-list">
            {PRIVACY_NOTICE.neverSent.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="hint">
            The extension never guesses legal eligibility, sponsorship, demographic or other
            sensitive answers, and never auto-submits an application — filling stops at a review
            step you control.
          </p>
        </Section>
      </div>

      <footer className="options-footer">
        <span className="save-status" aria-live="polite">
          {saveState.kind === 'saved' && <span>&#10003; Saved at {saveState.at}</span>}
          {saveState.kind === 'saving' && <span>Saving&hellip;</span>}
          {saveState.kind === 'error' && <span className="error">{saveState.message}</span>}
          {saveState.kind === 'idle' && dirty && <span>Unsaved changes</span>}
        </span>
        <button
          type="button"
          className="danger"
          onClick={() => setConfirmingReset(true)}
          disabled={loadKind === 'malformed'}
        >
          Reset settings&hellip;
        </button>
        {confirmingReset && loadKind !== 'malformed' && (
          <span className="confirm-inline" role="alertdialog" aria-label="Confirm settings reset">
            Replace all settings with the conservative defaults?
            <button type="button" className="danger" onClick={() => void onResetConfirmed()}>
              Yes, reset
            </button>
            <button type="button" onClick={() => setConfirmingReset(false)}>Cancel</button>
          </span>
        )}
        <button
          type="button"
          className="primary"
          onClick={() => void onSave()}
          disabled={!dirty || errors.length > 0 || saveState.kind === 'saving'}
        >
          {saveState.kind === 'saving' ? 'Saving\u2026' : 'Save settings'}
        </button>
      </footer>

      {errors.length > 0 && (
        <div className="banner banner-error" role="alert">
          <strong>Fix before saving:</strong>
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field helpers (pure transitions over Settings)                      */
/* ------------------------------------------------------------------ */

type Patch = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

function parseOptionalNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Rebuilds the optional experience range; both empty -> undefined (no filter). */
function updateExperienceRange(
  settings: Settings,
  patch: Patch,
  field: 'minYears' | 'maxYears',
  raw: string,
): void {
  const next: { minYears?: number; maxYears?: number } = { ...(settings.experienceRange ?? {}) };
  const parsed = parseOptionalNumber(raw);
  if (parsed === undefined) delete next[field];
  else next[field] = parsed;
  const hasBound = next.minYears !== undefined || next.maxYears !== undefined;
  patch('experienceRange', hasBound ? next : undefined);
}

/**
 * Merges a salary patch. The object may be temporarily incomplete while the
 * user fills it in (e.g. amounts before the currency) — validation reports it
 * and blocks Save, exactly like every other invalid state.
 */
function updateSalary(
  settings: Settings,
  patch: Patch,
  part: Partial<SalaryPreference>,
): void {
  const next = { ...(settings.salary ?? {}), ...part } as SalaryPreference;
  const hasContent =
    next.currency !== undefined && next.currency !== ''
    || next.minAnnual !== undefined
    || next.maxAnnual !== undefined;
  patch('salary', hasContent ? next : undefined);
}
