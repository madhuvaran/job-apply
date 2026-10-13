/**
 * Popup — user-triggered job capture (Prompt 08) and autofill (Prompt 14).
 *
 * - The active tab is inspected ONLY after a user click. Opening this popup
 *   grants `activeTab` for the current tab; nothing runs in the background and
 *   no page is read without an explicit action.
 * - Autofill is a two-step, explicit flow: the popup asks the content script
 *   for a VALUE-FREE list of form-field descriptors, builds a plan from your
 *   saved profile, shows a review of what will be filled vs. left manual, and
 *   only fills after you confirm. Nothing is submitted and no navigation is
 *   triggered. Cancel makes no changes.
 * - Page responses are untrusted: they are zod-validated before use.
 * - Sensitive contact/legal answers are read from the separate sensitive store
 *   and are never sent to the AI provider (autofill does not touch the AI).
 */
import { useCallback, useState } from 'react';
import { browser } from 'wxt/browser';
import { CAPTURE_REQUEST_TYPE, validateCaptureResponse } from '../../src/lib/capture';
import type { AiProvider } from '../../src/lib/ai';
import {
  AUTOFILL_FILL_REQUEST_TYPE,
  AUTOFILL_SCAN_REQUEST_TYPE,
  MAPPING_DISCLOSURE,
  approveMappings,
  buildFillPlan,
  eligibleMappingFields,
  requestMappingProposal,
  validateFillResponse,
  validateScanResponse,
  type FieldDescriptor,
  type FillPlan,
  type MappingProposal,
  type MappingRequest,
  type PlanReviewEntry,
} from '../../src/lib/autofill';
import type { Settings } from '../../src/lib/settings';
import {
  createJobPosting,
  validateJobPostingInput,
  MAX_RAW_DESCRIPTION_CHARS,
} from '../../src/lib/job-posting';
import {
  loadProfile,
  loadSensitiveProfile,
  loadSettings,
  upsertJobPosting,
} from '../../src/lib/storage';
import './App.css';

type Stage =
  | 'idle'
  | 'capturing'
  | 'preview'
  | 'saving'
  | 'saved'
  | 'error'
  | 'af-scanning'
  | 'af-preview'
  | 'af-filling'
  | 'af-done';

interface FormState {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
}

interface AfSummary {
  filled: number;
  skipped: number;
  total: number;
}

const EMPTY_FORM: FormState = { title: '', company: '', location: '', url: '', description: '' };

/**
 * The AI mapping transport. There is deliberately NO endpoint/credential here:
 * this build configures no backend provider, so the value is `null` and the AI
 * action reports "unavailable" while every field stays manual. Wiring a real
 * provider (the existing backend-proxy pattern) is the documented integration
 * blocker — no second client, no API key, no new permission is added here.
 */
const MAPPING_PROVIDER: AiProvider<MappingRequest> | null = null;

/** Fixed, content-free messages for AI mapping failures (never page/answer data). */
const MAPPING_ERROR_TEXT: Record<string, string> = {
  'invalid-request': 'AI mapping could not be prepared. Fields stay manual.',
  'invalid-response': 'The AI returned a result we could not use. Fields stay manual.',
  timeout: 'The AI provider timed out. Fields stay manual.',
  'rate-limited': 'The AI provider is rate limiting. Try again later; fields stay manual.',
  http: 'The AI provider returned an error. Fields stay manual.',
  network: 'Could not reach the AI provider. Fields stay manual.',
  'provider-fault': 'The AI provider failed. Fields stay manual.',
};

interface AfContext {
  profile: unknown;
  sensitive: unknown;
  settings: Settings | null;
}

interface AiState {
  status: 'idle' | 'loading' | 'unavailable' | 'empty' | 'error' | 'ready';
  message?: string;
  proposal?: MappingProposal;
  selected: Record<string, boolean>;
}

const IDLE_AI: AiState = { status: 'idle', selected: {} };

function App() {
  const [stage, setStage] = useState<Stage>('idle');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [truncated, setTruncated] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Autofill review state (held in memory only; never stored).
  const [afReview, setAfReview] = useState<PlanReviewEntry[]>([]);
  const [afPlan, setAfPlan] = useState<FillPlan | null>(null);
  // Session token from the scan that produced afPlan; a fill is only accepted
  // by the page for this exact scan (stale/tampered requests are rejected).
  const [afScanId, setAfScanId] = useState<string | null>(null);
  const [afSummary, setAfSummary] = useState<AfSummary | null>(null);
  // Deterministic inputs kept so an approved AI mapping can be re-planned
  // through the SAME planner. Held in memory only; never stored or logged.
  const [afDescriptors, setAfDescriptors] = useState<FieldDescriptor[]>([]);
  const [afContext, setAfContext] = useState<AfContext | null>(null);
  const [aiState, setAiState] = useState<AiState>(IDLE_AI);

  const fail = useCallback((message: string) => {
    setErrorText(message);
    setStage('error');
  }, []);

  const openOptions = useCallback(() => {
    void browser.runtime.openOptionsPage();
  }, []);

  /** The active tab's id + URL, or a fixed failure message. */
  const activeTab = useCallback(async (): Promise<{ tabId: number; url: string } | null> => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) {
      fail('No active tab found. Open an application form page and try again.');
      return null;
    }
    const url = tab.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      fail('This page is not supported (browser pages, PDFs and local files).');
      return null;
    }
    return { tabId: tab.id, url };
  }, [fail]);

  /**
   * Send a message to the active tab, injecting the content script on demand
   * (activeTab was granted when you opened this popup). Throws when blocked.
   */
  const sendToTab = useCallback(async (tabId: number, message: unknown): Promise<unknown> => {
    try {
      return await browser.tabs.sendMessage(tabId, message);
    } catch {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
      return await browser.tabs.sendMessage(tabId, message);
    }
  }, []);

  /* ---------------- capture (user-triggered ONLY) ---------------- */
  const onCapture = useCallback(async () => {
    setErrorText(null);
    setErrors([]);
    setStage('capturing');
    try {
      const tab = await activeTab();
      if (tab === null) return;
      let response: unknown;
      try {
        response = await sendToTab(tab.tabId, { type: CAPTURE_REQUEST_TYPE });
      } catch {
        fail('Chrome blocked capture on this page (permission denied or unsupported site). Use manual intake instead.');
        return;
      }
      const parsed = validateCaptureResponse(response);
      if (!parsed.ok) {
        fail(`The page returned data we could not read (${parsed.errors[0] ?? 'invalid response'}).`);
        return;
      }
      if (parsed.value.kind === 'error') {
        fail(parsed.value.message);
        return;
      }
      const c = parsed.value.candidate;
      setForm({
        title: c.title,
        company: c.company ?? '',
        location: c.location ?? '',
        url: c.url,
        description: c.descriptionText,
      });
      setTruncated(c.descriptionTruncated);
      setStage('preview');
    } catch {
      fail('Could not reach this tab. Re-open the popup and try again.');
    }
  }, [activeTab, fail, sendToTab]);

  /* ---------------- autofill: scan + plan (no changes yet) ---------------- */
  const onAutofillStart = useCallback(async () => {
    setErrorText(null);
    setAfReview([]);
    setAfPlan(null);
    setAfScanId(null);
    setAfSummary(null);
    setAfDescriptors([]);
    setAfContext(null);
    setAiState(IDLE_AI);
    setStage('af-scanning');
    try {
      const tab = await activeTab();
      if (tab === null) return;

      let scanRaw: unknown;
      try {
        scanRaw = await sendToTab(tab.tabId, { type: AUTOFILL_SCAN_REQUEST_TYPE });
      } catch {
        fail('Chrome blocked reading this page (permission denied or unsupported site).');
        return;
      }
      const scan = validateScanResponse(scanRaw);
      if (!scan.ok) {
        fail(`The page returned fields we could not read (${scan.errors[0] ?? 'invalid response'}).`);
        return;
      }
      if (scan.value.kind === 'error') {
        fail(scan.value.message);
        return;
      }

      const [profileRes, sensitiveRes, settingsRes] = await Promise.all([
        loadProfile(),
        loadSensitiveProfile(),
        loadSettings(),
      ]);
      const profileData = profileRes.ok ? profileRes.data : null;
      const sensitiveData = sensitiveRes.ok ? sensitiveRes.data : null;
      const settingsData = settingsRes.ok ? settingsRes.data : null;
      const built = buildFillPlan({
        descriptors: scan.value.descriptors,
        profile: profileData,
        sensitive: sensitiveData,
      });
      if (!built.ok) {
        fail('Your saved profile could not be used for autofill. Check it in Options and try again.');
        return;
      }
      setAfReview(built.review);
      setAfPlan(built.plan);
      setAfScanId(scan.value.scanId);
      setAfDescriptors(scan.value.descriptors);
      setAfContext({ profile: profileData, sensitive: sensitiveData, settings: settingsData });
      setStage('af-preview');
    } catch {
      fail('Could not reach this tab. Re-open the popup and try again.');
    }
  }, [activeTab, fail, sendToTab]);

  /* ---------------- autofill: execute (after explicit confirm) ---------------- */
  const onAutofillConfirm = useCallback(async () => {
    if (afPlan === null || afScanId === null) return;
    setStage('af-filling');
    try {
      const tab = await activeTab();
      if (tab === null) return;
      let response: unknown;
      try {
        response = await sendToTab(tab.tabId, {
          type: AUTOFILL_FILL_REQUEST_TYPE,
          scanId: afScanId,
          plan: afPlan,
        });
      } catch {
        fail('Chrome blocked filling this page. Nothing was changed.');
        return;
      }
      const parsed = validateFillResponse(response);
      if (!parsed.ok) {
        fail('The page returned a result we could not read. Some fields may have been filled.');
        return;
      }
      if (parsed.value.kind === 'error') {
        fail(
          parsed.value.code === 'stale-session'
            ? 'The form changed since it was scanned. Nothing was changed — reopen the popup and scan again.'
            : 'The fill plan could not be applied. Nothing was changed.',
        );
        return;
      }
      const report = parsed.value.report;
      setAfSummary({ filled: report.filledCount, skipped: report.skippedCount, total: report.results.length });
      setStage('af-done');
    } catch {
      fail('Could not reach this tab. Nothing was changed.');
    }
  }, [activeTab, afPlan, afScanId, fail, sendToTab]);

  const onAutofillCancel = useCallback(() => {
    setAfReview([]);
    setAfPlan(null);
    setAfScanId(null);
    setAfSummary(null);
    setAfDescriptors([]);
    setAfContext(null);
    setAiState(IDLE_AI);
    setStage('idle'); // nothing was written or filled
  }, []);

  /* ---------------- AI mapping (opt-in; provider may be unavailable) -------- */
  const onAiSuggest = useCallback(async () => {
    if (afScanId === null || afContext === null) return;
    setAiState({ status: 'loading', selected: {} });
    const result = await requestMappingProposal({
      descriptors: afDescriptors,
      profile: afContext.profile,
      sensitive: afContext.sensitive,
      settings: afContext.settings ?? { aiEnabled: false } as Settings,
      scanId: afScanId,
      provider: MAPPING_PROVIDER,
    });
    if (result.kind === 'ok') {
      setAiState({ status: 'ready', proposal: result.proposal, selected: {} });
      return;
    }
    if (result.kind === 'provider-unavailable') {
      setAiState({
        status: 'unavailable',
        message: 'No AI provider is configured in this build, so mapping stays manual.',
        selected: {},
      });
      return;
    }
    if (result.kind === 'no-eligible-fields' || result.kind === 'no-saved-answers') {
      setAiState({ status: 'empty', message: 'Nothing to map automatically.', selected: {} });
      return;
    }
    if (result.kind === 'ai-disabled') {
      setAiState(IDLE_AI);
      return;
    }
    setAiState({ status: 'error', message: MAPPING_ERROR_TEXT[result.error.kind] ?? 'AI mapping failed. Fields stay manual.', selected: {} });
  }, [afDescriptors, afContext, afScanId]);

  const onAiToggle = useCallback((fieldId: string, checked: boolean) => {
    setAiState((s) => ({ ...s, selected: { ...s.selected, [fieldId]: checked } }));
  }, []);

  const onAiApplyApproved = useCallback(() => {
    const proposal = aiState.proposal;
    if (proposal === undefined || afScanId === null || afContext === null) return;
    const approvedIds = Object.entries(aiState.selected)
      .filter(([, checked]) => checked)
      .map(([fieldId]) => fieldId);
    const approved = approveMappings(proposal, approvedIds, afScanId);
    if (!approved.ok) {
      fail('The form changed since it was scanned. Nothing was changed — reopen the popup and scan again.');
      return;
    }
    const rebuilt = buildFillPlan({
      descriptors: afDescriptors,
      profile: afContext.profile,
      sensitive: afContext.sensitive,
      categoryOverrides: approved.categoryOverrides,
    });
    if (!rebuilt.ok) {
      fail('Your saved profile could not be used for autofill. Check it in Options and try again.');
      return;
    }
    setAfReview(rebuilt.review);
    setAfPlan(rebuilt.plan);
    setAiState(IDLE_AI); // suggestions are consumed; execution still needs Confirm
  }, [afDescriptors, afContext, afScanId, aiState.proposal, aiState.selected, fail]);

  /* ---------------- save / cancel (capture) ---------------- */
  const onSave = useCallback(async () => {
    setErrors([]);
    const fields = {
      title: form.title.trim(),
      company: form.company.trim() || undefined,
      location: form.location.trim() || undefined,
      originalUrl: form.url.trim() || undefined,
      rawDescription: form.description,
      source: 'page-capture' as const,
    };
    const issues = validateJobPostingInput({ ...fields, id: 'x', capturedAt: new Date().toISOString() });
    if (issues.length > 0) {
      setErrors(issues);
      return;
    }
    setStage('saving');
    try {
      const posting = createJobPosting(fields);
      const res = await upsertJobPosting(posting);
      if (res === null) {
        setStage('saved');
      } else if (!res.ok) {
        fail(`Save failed (${res.reason}). ${res.message}`);
      }
    } catch {
      fail('Could not validate the posting. Review the fields and try again.');
    }
  }, [form, fail]);

  const onCancel = useCallback(() => {
    setForm(EMPTY_FORM);
    setTruncated(false);
    setErrors([]);
    setStage('idle'); // nothing was written
  }, []);

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const fillable = afReview.filter((r) => r.decision === 'fill');
  const manual = afReview.filter((r) => r.decision === 'manual');
  const aiEnabled = afContext?.settings?.aiEnabled === true;
  const aiEligible = aiEnabled && afDescriptors.length > 0 ? eligibleMappingFields(afDescriptors) : [];

  return (
    <div className="popup">
      <h1>Job Apply</h1>

      {stage === 'idle' && (
        <div className="pane">
          <p className="hint">
            Save the job you are looking at, or fill the application form with your saved answers.
            The page is read <strong>only after you click</strong>; nothing runs in the background.
          </p>
          <button type="button" className="primary" onClick={() => void onCapture()}>
            Capture current job
          </button>
          <button type="button" onClick={() => void onAutofillStart()}>
            Autofill this application form
          </button>
          <button type="button" onClick={openOptions}>Open jobs &amp; settings</button>
          <p className="hint small">
            Autofill previews every field and fills only after you confirm. It never submits the
            form and never fills passwords, payment, demographic, compensation or legal fields.
          </p>
        </div>
      )}

      {stage === 'capturing' && <p className="pane">Reading this page&hellip;</p>}
      {stage === 'af-scanning' && <p className="pane">Reading form fields&hellip;</p>}
      {stage === 'af-filling' && <p className="pane">Filling after your confirmation&hellip;</p>}

      {stage === 'error' && (
        <div className="pane">
          <p className="error-box" role="alert">{errorText}</p>
          <button type="button" className="primary" onClick={() => setStage('idle')}>Back</button>
          <button type="button" onClick={openOptions}>Open jobs &amp; settings</button>
        </div>
      )}

      {stage === 'af-preview' && (
        <div className="pane">
          <p className="hint">
            Review before filling. Nothing is filled until you confirm, and the form is never
            submitted.
          </p>

          {aiEnabled && aiEligible.length > 0 && (
            <div className="af-ai">
              <h2 className="af-heading">AI-assisted mapping (optional)</h2>
              <p className="hint small">
                {MAPPING_DISCLOSURE.map((line, index) => (
                  <span key={line}>
                    {line}
                    {index < MAPPING_DISCLOSURE.length - 1 ? ' ' : ''}
                  </span>
                ))}
              </p>
              <p className="hint small">
                AI only suggests which saved answer category a field belongs to; you approve each
                one, and only then does the usual review and confirm step apply.
              </p>
              {aiState.status === 'idle' && (
                <button type="button" onClick={() => void onAiSuggest()}>
                  Suggest field mappings with AI
                </button>
              )}
              {aiState.status === 'loading' && <p className="hint">Asking your AI provider&hellip;</p>}
              {(aiState.status === 'unavailable' ||
                aiState.status === 'empty' ||
                aiState.status === 'error') && (
                <p className="hint small" role="status">
                  {aiState.message}
                </p>
              )}
              {aiState.status === 'ready' && aiState.proposal !== undefined && (
                <div>
                  <p className="hint small">
                    {aiState.proposal.suggestedCount} suggestion
                    {aiState.proposal.suggestedCount === 1 ? '' : 's'} — approve the ones you agree
                    with; they then join the fill plan for the usual confirm step.
                  </p>
                  <ul className="af-list">
                    {aiState.proposal.entries.map((e) => (
                      <li key={e.fieldId} className="af-row">
                        {e.decision === 'suggest' ? (
                          <label>
                            <input
                              type="checkbox"
                              checked={aiState.selected[e.fieldId] === true}
                              onChange={(ev) => onAiToggle(e.fieldId, ev.target.checked)}
                            />{' '}
                            <strong>{e.displayLabel}</strong>{' '}
                            <span className="af-value">→ {e.category}</span>
                            <span className="hint small">{e.reason}</span>
                          </label>
                        ) : (
                          <>
                            <strong>{e.displayLabel}</strong>
                            <span className="hint small">{e.reason}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  <button type="button" onClick={onAiApplyApproved}>
                    Apply approved mappings
                  </button>
                  <button type="button" onClick={() => setAiState(IDLE_AI)}>
                    Dismiss suggestions
                  </button>
                </div>
              )}
            </div>
          )}

          <h2 className="af-heading">Will fill ({fillable.length})</h2>
          {fillable.length === 0 ? (
            <p className="hint">Nothing can be filled automatically — see below.</p>
          ) : (
            <ul className="af-list">
              {fillable.map((r) => (
                <li key={r.fieldId} className="af-row">
                  <strong>{r.displayLabel}</strong>
                  <span className="af-value">{r.proposedValue}</span>
                  <span className="hint small">{r.source === 'sensitive' ? 'from your sensitive details' : 'from your profile'}</span>
                </li>
              ))}
            </ul>
          )}
          <h2 className="af-heading">Needs manual input ({manual.length})</h2>
          <ul className="af-list">
            {manual.map((r) => (
              <li key={r.fieldId} className="af-row af-manual">
                <strong>{r.displayLabel}</strong>
                <span className="hint small">{r.reason}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="primary"
            disabled={fillable.length === 0}
            onClick={() => void onAutofillConfirm()}
          >
            Confirm &amp; fill {fillable.length} field{fillable.length === 1 ? '' : 's'}
          </button>
          <button type="button" onClick={onAutofillCancel}>Cancel — change nothing</button>
        </div>
      )}

      {stage === 'af-done' && afSummary !== null && (
        <div className="pane">
          <p>
            Filled <strong>{afSummary.filled}</strong> of {afSummary.total} planned field
            {afSummary.total === 1 ? '' : 's'} ({afSummary.skipped} skipped). Values are not shown
            here.
          </p>
          <p className="hint">Review the form and complete anything left blank. Nothing was submitted.</p>
          <button type="button" className="primary" onClick={() => setStage('idle')}>Done</button>
        </div>
      )}

      {stage === 'preview' && (
        <div className="pane">
          <p className="hint">
            Extracted from this page after your click — <strong>review and correct</strong> before
            saving.
          </p>
          {truncated && (
            <p className="warn">
              The description was longer than the 100k-character limit and was truncated. The full
              text stays on the original page.
            </p>
          )}
          <label>
            Job title *
            <input value={form.title} onChange={(e) => set('title')(e.target.value)} />
          </label>
          <label>
            Company
            <input value={form.company} onChange={(e) => set('company')(e.target.value)} placeholder="Leave blank if not stated" />
          </label>
          <label>
            Location
            <input value={form.location} onChange={(e) => set('location')(e.target.value)} placeholder="Leave blank if not stated" />
          </label>
          <label>
            Original URL
            <input value={form.url} onChange={(e) => set('url')(e.target.value)} />
          </label>
          <label>
            Job description *
            <textarea
              rows={8}
              maxLength={MAX_RAW_DESCRIPTION_CHARS}
              value={form.description}
              onChange={(e) => set('description')(e.target.value)}
            />
          </label>
          {errors.length > 0 && (
            <ul className="error-list" role="alert">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <button type="button" className="primary" onClick={() => void onSave()}>
            Save posting
          </button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      )}

      {stage === 'saving' && <p className="pane">Saving&hellip;</p>}

      {stage === 'saved' && (
        <div className="pane">
          <p>Saved to your job list (source: page capture).</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setForm(EMPTY_FORM);
              setTruncated(false);
              setStage('idle');
            }}
          >
            Capture another
          </button>
          <button type="button" onClick={openOptions}>Open jobs list</button>
        </div>
      )}
    </div>
  );
}

export default App;
