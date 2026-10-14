/**
 * Fill executor (Prompt 14; hardened in Prompt 15) — isolated, applies ONLY a
 * validated plan.
 *
 * Guarantees:
 * - The plan is re-validated against `fillPlanSchema`; an invalid plan executes
 *   nothing (`{ ok:false, reason:'invalid-plan' }`).
 * - Only fields listed in the plan are touched; no other element is read or
 *   written. A field's current value is never included in any message or
 *   report; it is read only to restore the control after a failed verification.
 * - Never submits a form, never clicks Apply/Continue/Next, never accepts a
 *   declaration, never navigates, and never touches `form.submit()` /
 *   `requestSubmit()` / `.click()` on buttons.
 * - Respects disabled, read-only, hidden, inert and disconnected elements, and
 *   stale pages (elements are resolved fresh and checked with `isConnected`).
 * - Text/textarea values are written through the element's NATIVE value setter
 *   (the prototype descriptor, NOT any instance-level setter a framework such
 *   as React installs to track changes) and followed by bubbling `input` +
 *   `change` events. This is the documented, framework-agnostic way to let
 *   controlled inputs observe the change — it uses no React internals and is
 *   not an attempt to bypass framework validation.
 * - Every write is VERIFIED against the intended state before success is
 *   reported; a write that did not take effect (or that leaves the control
 *   failing the browser's constraint validation, e.g. a `pattern` our saved
 *   value does not satisfy) yields `verify-failed` and no spurious events.
 *   Inline "this field is invalid" messages are not parsed.
 * - Select options must match unambiguously AND must not be a placeholder
 *   ("Select one", an empty value, a disabled/hidden option, …); the first
 *   option is never chosen just because it exists.
 * - `<select multiple>` controls are NEVER filled: the plan carries a single
 *   string answer, so a multi-select is reported `unsupported-element` and every
 *   selected option is left exactly as it was.
 * - Radio groups are scoped by (form, name); a checkbox/radio already in the
 *   planned state is left untouched (no unnecessary toggle, no event).
 * - Per-field messages are fixed literals; planned/page values never appear in
 *   a message or report.
 * - NEVER OVERWRITE (Prompt 22): a control that already holds a value — typed
 *   content in a text/textarea, a real (non-placeholder) option already selected
 *   in a `<select>`, or another option already chosen in a radio group — is left
 *   EXACTLY as it is and reported `already-filled` (no write, no events). The
 *   existing value is read only to decide, and is never reported or logged.
 */
import { normalizeText } from './classify';
import {
  fillPlanSchema,
  fillReportSchema,
  formatIssues,
  type FillReport,
  type FillStatus,
  type FillFieldResult,
} from './schemas';

export interface FillTarget {
  fieldId: string;
  element: Element;
}

export type ExecuteResult =
  | { ok: true; report: FillReport }
  | { ok: false; reason: 'invalid-plan'; issues: string[] };

const STATUS_MESSAGES: Record<FillStatus, string> = {
  filled: 'Filled from your saved profile.',
  'not-found': 'Field was not found on the page (it may have changed).',
  disconnected: 'Field is no longer attached to the page.',
  disabled: 'Field is disabled.',
  'read-only': 'Field is read-only.',
  hidden: 'Field is hidden.',
  'unsupported-element': 'Unsupported element type.',
  'no-match': 'No unambiguous matching option — left unchanged.',
  'already-filled': 'Field already contains a value — left unchanged.',
  'verify-failed': 'The page did not accept the value — left unchanged.',
  error: 'Filling this field failed.',
};

/**
 * Placeholder dropdown wording that must NEVER count as a valid answer.
 * Compared after `normalizeText` (so "Select one…" → "select one").
 */
const PLACEHOLDER_OPTION_TEXT = new Set([
  '',
  'select',
  'select one',
  'select an option',
  'select option',
  'select a value',
  'select value',
  'please select',
  'please choose',
  'choose',
  'choose one',
  'choose an option',
  'choose a value',
  'pick one',
  'pick an option',
  'make a selection',
  'no selection',
  'none selected',
  'not selected',
]);

/** A dropdown option that exists only as a prompt, never as an answer. */
function isPlaceholderOption(option: HTMLOptionElement): boolean {
  if (option.disabled) return true;
  if ((option as { hidden?: unknown }).hidden === true) return true;
  const rawValue = option.getAttribute('value');
  if (rawValue !== null && rawValue.trim() === '') return true;
  const value = normalizeText(option.value);
  const text = normalizeText(option.textContent ?? '');
  return PLACEHOLDER_OPTION_TEXT.has(value) || PLACEHOLDER_OPTION_TEXT.has(text);
}

function targetMap(targets: FillTarget[] | ReadonlyMap<string, Element>): Map<string, Element> {
  if (Array.isArray(targets)) {
    const map = new Map<string, Element>();
    for (const t of targets) map.set(t.fieldId, t.element);
    return map;
  }
  return new Map(targets);
}

function dispatchValueEvents(element: Element): void {
  const view = element.ownerDocument?.defaultView ?? null;
  const EventCtor: typeof Event | undefined =
    (view as { Event?: typeof Event } | null)?.Event ?? (typeof Event !== 'undefined' ? Event : undefined);
  if (EventCtor === undefined) return;
  element.dispatchEvent(new EventCtor('input', { bubbles: true }));
  element.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

/**
 * Write through the element's NATIVE prototype value setter. Frameworks such
 * as React install an own `value` accessor on the node (a change tracker); the
 * prototype setter is the reliable, documented way to change the value so the
 * framework observes it.
 */
function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set !== undefined) descriptor.set.call(element, value);
  else element.value = value;
}

function isEnabled(element: Element): boolean {
  if ((element as { disabled?: unknown }).disabled === true) return false;
  if (element.closest('fieldset[disabled]') !== null) return false;
  // `inert` subtrees are non-interactable.
  if (element.closest('[inert]') !== null) return false;
  return true;
}

function isReadOnly(element: Element): boolean {
  return (element as { readOnly?: unknown }).readOnly === true;
}

export function isElementHidden(element: Element): boolean {
  if ((element as { hidden?: unknown }).hidden === true) return true;
  if (element.closest('[hidden]') !== null) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.closest('[aria-hidden="true"]') !== null) return true;
  const type = (element as { type?: unknown }).type;
  if (typeof type === 'string' && type.toLowerCase() === 'hidden') return true;
  const view = element.ownerDocument?.defaultView;
  if (view?.getComputedStyle !== undefined) {
    try {
      const style = view.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch {
      // getComputedStyle can throw for detached nodes — ignore.
    }
  }
  return false;
}

/** Associated label text for a control (never its value). */
function labelText(element: Element): string {
  const input = element as HTMLInputElement;
  if (Array.isArray(input.labels) && input.labels.length > 0) {
    return input.labels.map((l) => l.textContent ?? '').join(' ');
  }
  const closest = element.closest('label');
  if (closest !== null) return closest.textContent ?? '';
  return element.getAttribute('aria-label') ?? '';
}

/** Do the element's own value/label match the planned value unambiguously? */
function matchesValue(element: Element, plannedValue: string): boolean {
  const target = normalizeText(plannedValue);
  const own = normalizeText(element.getAttribute('value') ?? '');
  const label = normalizeText(labelText(element));
  return own === target || label === target;
}

/**
 * Browser constraint validation as an extra post-fill check. A control the page
 * still considers invalid (unsatisfied `pattern`, invalid `type` value, …) is
 * reported `verify-failed` instead of as completed. This reads only the
 * browser's validity state — never the value.
 */
function isConstraintValid(element: Element): boolean {
  const validity = (element as { validity?: { valid?: boolean } }).validity;
  if (validity === undefined || typeof validity.valid !== 'boolean') return true;
  return validity.valid === true;
}

function fillTextLike(element: Element, plannedValue: string): FillStatus {
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement)) {
    return 'unsupported-element';
  }
  // NEVER OVERWRITE: a control that already holds content (typed by the
  // applicant, pre-filled by the page/framework, or restored by the site) is
  // left EXACTLY as it is — no write, no events. Only an empty control is
  // filled. The current value is never reported, logged or transmitted.
  if (element.value.trim().length > 0) return 'already-filled';
  const previous = element.value;
  setNativeValue(element, plannedValue);
  // Verify BEFORE dispatching: a failed write must not emit change events, and
  // the control is restored so it is genuinely left as it was.
  if (element.value !== plannedValue || !isConstraintValid(element)) {
    setNativeValue(element, previous);
    return 'verify-failed';
  }
  dispatchValueEvents(element);
  return 'filled';
}

function fillSelect(element: Element, plannedValue: string): FillStatus {
  if (!(element instanceof HTMLSelectElement)) return 'unsupported-element';
  // A multi-select needs a set of answers; the plan only carries a single
  // string, so it is deliberately left untouched rather than guessed.
  if (element.multiple === true) return 'unsupported-element';
  const target = normalizeText(plannedValue);
  const matches = Array.from(element.options).filter(
    (option) =>
      !isPlaceholderOption(option) &&
      (normalizeText(option.value) === target || normalizeText(option.textContent ?? '') === target),
  );
  // Ambiguity/absence is decided FIRST, so an unmatched field still reports the
  // more specific `no-match`.
  if (matches.length !== 1) return 'no-match';
  // NEVER OVERWRITE: a real (non-placeholder) option is already selected — the
  // dropdown already holds an answer, so it is left exactly as it is.
  const current =
    element.selectedIndex >= 0 ? (element.options[element.selectedIndex] as HTMLOptionElement | undefined) : undefined;
  if (current !== undefined && !isPlaceholderOption(current)) return 'already-filled';
  const option = matches[0] as HTMLOptionElement;
  const previous = element.value;
  setNativeValue(element, option.value);
  const selected = element.selectedIndex >= 0 ? element.options[element.selectedIndex] : undefined;
  if (element.value !== option.value || selected !== option || !isConstraintValid(element)) {
    setNativeValue(element, previous);
    return 'verify-failed';
  }
  dispatchValueEvents(element);
  return 'filled';
}

function radioGroup(element: Element): HTMLInputElement[] {
  const input = element as HTMLInputElement;
  const name = input.name;
  if (name === '' || name === undefined) return [input];
  const root: ParentNode = input.form ?? input.ownerDocument;
  const found: HTMLInputElement[] = [];
  for (const el of Array.from(root.querySelectorAll('input[type="radio"]'))) {
    if ((el as HTMLInputElement).name === name) found.push(el as HTMLInputElement);
  }
  return found;
}

function fillRadio(element: Element, plannedValue: string): FillStatus {
  if (!(element instanceof HTMLInputElement)) return 'unsupported-element';
  const group = radioGroup(element);
  const matches = group.filter((r) => matchesValue(r, plannedValue));
  if (matches.length !== 1) return 'no-match';
  const chosen = matches[0] as HTMLInputElement;
  if (chosen.checked === true) return 'filled'; // already in the planned state — no write, no event
  // NEVER OVERWRITE: another option in the group is already answered — the
  // group holds a value, so it is left exactly as it is.
  if (group.some((r) => r.checked)) return 'already-filled';
  chosen.checked = true;
  if (chosen.checked !== true) return 'verify-failed';
  if (group.some((r) => r !== chosen && r.checked)) return 'verify-failed';
  dispatchValueEvents(chosen);
  return 'filled';
}

function fillCheckbox(element: Element, plannedValue: string): FillStatus {
  if (!(element instanceof HTMLInputElement)) return 'unsupported-element';
  if (!matchesValue(element, plannedValue)) return 'no-match';
  // The planned answer is an explicit match, so the intended state is checked.
  if (element.checked === true) return 'filled'; // already planned — no unnecessary toggle
  element.checked = true;
  if (element.checked !== true) return 'verify-failed';
  dispatchValueEvents(element);
  return 'filled';
}

function tryFillTextLike(element: Element, plannedValue: string): FillStatus {
  if (isElementHidden(element)) return 'hidden';
  if (!isEnabled(element)) return 'disabled';
  if (isReadOnly(element)) return 'read-only';
  return fillTextLike(element, plannedValue);
}

function fillOne(element: Element | undefined, plannedValue: string): FillStatus {
  if (element === undefined) return 'not-found';
  if (!element.isConnected) return 'disconnected';
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'radio') {
      if (!isEnabled(element)) return 'disabled';
      if (isElementHidden(element)) return 'hidden';
      return fillRadio(element, plannedValue);
    }
    if (type === 'checkbox') {
      if (!isEnabled(element)) return 'disabled';
      if (isElementHidden(element)) return 'hidden';
      return fillCheckbox(element, plannedValue);
    }
    if (type === 'hidden') return 'hidden';
    return tryFillTextLike(element, plannedValue);
  }
  if (element instanceof HTMLTextAreaElement) {
    return tryFillTextLike(element, plannedValue);
  }
  if (element instanceof HTMLSelectElement) {
    if (isElementHidden(element)) return 'hidden';
    if (!isEnabled(element)) return 'disabled';
    return fillSelect(element, plannedValue);
  }
  return 'unsupported-element';
}

/**
 * Execute a validated plan against resolved targets. Elements are looked up by
 * `fieldId`; missing/stale targets produce per-field `not-found`/`disconnected`
 * results rather than throwing.
 */
export function executeFillPlan(
  plan: unknown,
  targets: FillTarget[] | ReadonlyMap<string, Element>,
): ExecuteResult {
  const parsed = fillPlanSchema.safeParse(plan);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid-plan', issues: formatIssues(parsed.error) };
  }

  const map = targetMap(targets);
  const results: FillFieldResult[] = parsed.data.instructions.map((instruction) => {
    let status: FillStatus;
    try {
      status = fillOne(map.get(instruction.fieldId), instruction.value);
    } catch {
      status = 'error';
    }
    return { fieldId: instruction.fieldId, status, message: STATUS_MESSAGES[status] };
  });

  const filledCount = results.filter((r) => r.status === 'filled').length;
  const report = fillReportSchema.parse({
    schemaVersion: '1',
    results,
    filledCount,
    skippedCount: results.length - filledCount,
  });
  return { ok: true, report };
}
