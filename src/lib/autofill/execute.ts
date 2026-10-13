/**
 * Fill executor (Prompt 14) — isolated, applies ONLY a validated plan.
 *
 * Guarantees:
 * - The plan is re-validated against `fillPlanSchema`; an invalid plan executes
 *   nothing (`{ ok:false, reason:'invalid-plan' }`).
 * - Only fields listed in the plan are touched; no other element is read or
 *   written, and the field's current value is never inspected.
 * - Never submits a form, never clicks Apply/Continue/Next, never accepts a
 *   declaration, never navigates, and never touches `form.submit()` /
 *   `requestSubmit()` / `.click()` on buttons.
 * - Respects disabled, read-only, hidden and disconnected elements, and stale
 *   pages (elements are resolved fresh and checked with `isConnected`).
 * - Select/radio/checkbox values are only applied on an UNAMBIGUOUS match; a
 *   missing or duplicate match is skipped rather than guessed.
 * - Text values are written through the native value setter and followed by
 *   `input` + `change` events (so controlled frameworks notice) — this is not
 *   an attempt to bypass framework validation.
 * - Per-field messages are fixed literals; planned/page values never appear in
 *   a message or report.
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
  error: 'Filling this field failed.',
};

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

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set !== undefined) descriptor.set.call(element, value);
  else element.value = value;
}

function isEnabled(element: Element): boolean {
  const disabled = (element as { disabled?: unknown }).disabled === true;
  if (disabled) return false;
  const fieldset = element.closest('fieldset[disabled]');
  return fieldset === null;
}

function isReadOnly(element: Element): boolean {
  return (element as { readOnly?: unknown }).readOnly === true;
}

function isHidden(element: Element): boolean {
  if ((element as { hidden?: unknown }).hidden === true) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
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

function fillTextLike(element: Element, plannedValue: string): FillStatus {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    setNativeValue(element, plannedValue);
    dispatchValueEvents(element);
    return 'filled';
  }
  return 'unsupported-element';
}

function fillSelect(element: Element, plannedValue: string): FillStatus {
  if (!(element instanceof HTMLSelectElement)) return 'unsupported-element';
  const target = normalizeText(plannedValue);
  const matches = Array.from(element.options).filter(
    (o) => normalizeText(o.value) === target || normalizeText(o.textContent ?? '') === target,
  );
  if (matches.length !== 1) return 'no-match';
  const option = matches[0] as HTMLOptionElement;
  element.value = option.value;
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
  const matches = radioGroup(element).filter((r) => matchesValue(r, plannedValue));
  if (matches.length !== 1) return 'no-match';
  const chosen = matches[0] as HTMLInputElement;
  chosen.checked = true;
  dispatchValueEvents(chosen);
  return 'filled';
}

function fillCheckbox(element: Element, plannedValue: string): FillStatus {
  if (!(element instanceof HTMLInputElement)) return 'unsupported-element';
  if (!matchesValue(element, plannedValue)) return 'no-match';
  element.checked = true;
  dispatchValueEvents(element);
  return 'filled';
}

function fillOne(element: Element | undefined, plannedValue: string): FillFieldResult['status'] {
  if (element === undefined) return 'not-found';
  if (!element.isConnected) return 'disconnected';
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'radio') {
      if (!isEnabled(element)) return 'disabled';
      if (isHidden(element)) return 'hidden';
      return fillRadio(element, plannedValue);
    }
    if (type === 'checkbox') {
      if (!isEnabled(element)) return 'disabled';
      if (isHidden(element)) return 'hidden';
      return fillCheckbox(element, plannedValue);
    }
    if (type === 'hidden') return 'hidden';
    if (isHidden(element)) return 'hidden';
    if (!isEnabled(element)) return 'disabled';
    if (isReadOnly(element)) return 'read-only';
    return fillTextLike(element, plannedValue);
  }
  if (element instanceof HTMLTextAreaElement) {
    if (isHidden(element)) return 'hidden';
    if (!isEnabled(element)) return 'disabled';
    if (isReadOnly(element)) return 'read-only';
    return fillTextLike(element, plannedValue);
  }
  if (element instanceof HTMLSelectElement) {
    if (isHidden(element)) return 'hidden';
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
