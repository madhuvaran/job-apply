/**
 * Content script — current-page job capture (Prompt 08).
 *
 * Security/privacy posture:
 * - The page is NEVER inspected at load time. This script only registers a
 *   message listener; extraction runs solely when the popup (after the user
 *   clicked "Capture current job") sends our typed request.
 * - The request is zod-validated; foreign messages are ignored (undefined),
 *   so other listeners are unaffected.
 * - Errors returned to the popup are fixed literals — no page content leaks.
 * - `globalThis` guard makes re-injection (scripting.executeScript fallback
 *   on pages without the declared content script) idempotent — no duplicate
 *   listeners.
 */
import { handleCaptureRequest } from '../src/lib/capture';
import { createAutofillSession } from '../src/lib/autofill/page';

export default defineContentScript({
  // Unchanged declared host from the starter scaffold; capture on other sites
  // works via activeTab-triggered injection from the popup (see popup/App.tsx).
  matches: ['*://*.google.com/*'],
  main() {
    const g = globalThis as typeof globalThis & { __jobApplyCaptureListener?: boolean };
    if (g.__jobApplyCaptureListener) return;
    g.__jobApplyCaptureListener = true;

    // Autofill is handled by the same listener; it re-scans the page only when
    // the popup asks (user-initiated) and never reads field values.
    const autofill = createAutofillSession(document);

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const capture = handleCaptureRequest(message, document, location.href);
      if (capture !== undefined) {
        sendResponse(capture);
        return undefined;
      }
      const response = autofill.handle(message);
      if (response === undefined) return undefined; // not our message
      sendResponse(response);
      return undefined;
    });
  },
});
