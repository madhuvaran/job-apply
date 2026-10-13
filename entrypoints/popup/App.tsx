/**
 * Popup — user-triggered "Capture current job" flow (Prompt 08).
 *
 * - The active tab is inspected ONLY after the user clicks the capture
 *   button. Opening this popup grants `activeTab` for the current tab; we
 *   never read pages in the background, never collect cookies, and never
 *   scrape behind logins (if the page shows a login wall, capture yields
 *   whatever job text is visibly rendered — review the preview!).
 * - The content-script response is untrusted: it is zod-validated before use
 *   (`validateCaptureResponse`). Fields can be corrected before saving.
 * - Saving writes a `page-capture` JobPosting through the validated storage
 *   service. Cancel writes nothing.
 * - Unsupported pages (chrome://, PDFs, files) and permission denial are
 *   handled with explicit fallbacks to manual intake.
 */
import { useCallback, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  CAPTURE_REQUEST_TYPE,
  validateCaptureResponse,
} from '../../src/lib/capture';
import {
  createJobPosting,
  validateJobPostingInput,
  MAX_RAW_DESCRIPTION_CHARS,
} from '../../src/lib/job-posting';
import { upsertJobPosting } from '../../src/lib/storage';
import './App.css';

type Stage = 'idle' | 'capturing' | 'preview' | 'saving' | 'saved' | 'error';

interface FormState {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
}

const EMPTY_FORM: FormState = { title: '', company: '', location: '', url: '', description: '' };

function App() {
  const [stage, setStage] = useState<Stage>('idle');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [truncated, setTruncated] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);

  const fail = useCallback((message: string) => {
    setErrorText(message);
    setStage('error');
  }, []);

  const openOptions = useCallback(() => {
    void browser.runtime.openOptionsPage();
  }, []);

  /* ---------------- capture (user-triggered ONLY) ---------------- */
  const onCapture = useCallback(async () => {
    setErrorText(null);
    setErrors([]);
    setStage('capturing');
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id) {
        fail('No active tab found. Open a job listing page and try again.');
        return;
      }
      const url = tab.url ?? '';
      if (!/^https?:\/\//i.test(url)) {
        fail(
          'This page cannot be captured (browser pages, PDFs and local files are not supported). Use manual intake instead.',
        );
        return;
      }

      // 1) ask an already-injected content script; 2) inject on demand
      // (activeTab was granted when you opened this popup); 3) fail politely.
      let response: unknown;
      try {
        response = await browser.tabs.sendMessage(tab.id, { type: CAPTURE_REQUEST_TYPE });
      } catch {
        try {
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['/content-scripts/content.js'],
          });
          response = await browser.tabs.sendMessage(tab.id, { type: CAPTURE_REQUEST_TYPE });
        } catch {
          fail(
            'Chrome blocked capture on this page (permission denied or unsupported site). Use manual intake instead.',
          );
          return;
        }
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
  }, [fail]);

  /* ---------------- save / cancel ---------------- */
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

  return (
    <div className="popup">
      <h1>Job Apply</h1>

      {stage === 'idle' && (
        <div className="pane">
          <p className="hint">
            Save the job you are looking at. The page is read <strong>only after you click</strong>;
            nothing runs in the background. Review and correct everything before saving.
          </p>
          <button type="button" className="primary" onClick={() => void onCapture()}>
            Capture current job
          </button>
          <button type="button" onClick={openOptions}>Open jobs &amp; settings</button>
          <p className="hint small">
            Best-effort sites: pages with JobPosting structured data (Greenhouse, Lever, Workday,
            Indeed, LinkedIn job pages) and simple career pages. Login walls and app-heavy pages may
            yield little — use manual intake there.
          </p>
        </div>
      )}

      {stage === 'capturing' && <p className="pane">Reading this page&hellip;</p>}

      {stage === 'error' && (
        <div className="pane">
          <p className="error-box" role="alert">{errorText}</p>
          <button type="button" className="primary" onClick={() => void onCapture()}>Try again</button>
          <button type="button" onClick={openOptions}>Use manual intake</button>
          <button type="button" onClick={() => setStage('idle')}>Back</button>
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
          <button
            type="button"
            className="primary"
            onClick={() => void onSave()}
          >
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
