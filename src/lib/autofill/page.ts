/**
 * Page-side autofill: value-free form scanning + messaging glue (Prompt 14).
 *
 * `collectFieldDescriptors` reads ONLY form-control metadata (labels, name, id,
 * autocomplete, type) — never the control's value, never arbitrary page text.
 * `createAutofillSession` handles the two popup messages over the existing
 * content-script channel: a scan (returns descriptors + a session token) and a
 * fill (executes a validated plan against the elements that were scanned).
 *
 * A plan is bound to the scan that produced it: every scan mints a fresh
 * `scanId`, a fill request must echo the CURRENT one, and a mismatch (a stale
 * or tampered session) is rejected with a typed `stale-session` error and no
 * writes. Element references are held only in memory for the duration of one
 * scan→fill round trip; nothing is stored or transmitted anywhere.
 */
import { z } from 'zod';
import {
  fieldDescriptorsSchema,
  fillPlanSchema,
  fillReportSchema,
  formatIssues,
  MAX_SCAN_FIELDS,
  type FieldDescriptor,
  type FillReport,
} from './schemas';
import { executeFillPlan } from './execute';

export const AUTOFILL_SCAN_REQUEST_TYPE = 'job-apply/autofill-scan';
export const AUTOFILL_FILL_REQUEST_TYPE = 'job-apply/autofill-fill';

/* ------------------------------------------------------------------ */
/* Message schemas (validated on both sides)                           */
/* ------------------------------------------------------------------ */

export const autofillScanRequestSchema = z
  .object({ type: z.literal(AUTOFILL_SCAN_REQUEST_TYPE) })
  .strict();

export const autofillScanResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('ok'), scanId: z.string().min(1).max(80), descriptors: fieldDescriptorsSchema })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      code: z.enum(['no-fields', 'scan-failed']),
      message: z.string().min(1).max(300),
    })
    .strict(),
]);

export const autofillFillRequestSchema = z
  .object({
    type: z.literal(AUTOFILL_FILL_REQUEST_TYPE),
    /** Session token from the scan that produced `plan`; a mismatch is stale. */
    scanId: z.string().min(1).max(80),
    plan: fillPlanSchema,
  })
  .strict();

export const autofillFillResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), report: fillReportSchema }).strict(),
  z
    .object({
      kind: z.literal('error'),
      code: z.enum(['invalid-plan', 'stale-session']),
      message: z.string().min(1).max(300),
    })
    .strict(),
]);

export type AutofillScanResponse = z.infer<typeof autofillScanResponseSchema>;
export type AutofillFillResponse = z.infer<typeof autofillFillResponseSchema>;
export type AutofillResponse = AutofillScanResponse | AutofillFillResponse;

/** Validate an untrusted scan response (popup side). */
export function validateScanResponse(
  payload: unknown,
): { ok: true; value: AutofillScanResponse } | { ok: false; errors: string[] } {
  const parsed = autofillScanResponseSchema.safeParse(payload);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: formatIssues(parsed.error) };
}

/** Validate an untrusted fill response (popup side). */
export function validateFillResponse(
  payload: unknown,
): { ok: true; value: AutofillFillResponse } | { ok: false; errors: string[] } {
  const parsed = autofillFillResponseSchema.safeParse(payload);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: formatIssues(parsed.error) };
}

/* ------------------------------------------------------------------ */
/* Value-free scanning                                                 */
/* ------------------------------------------------------------------ */

function trimCapped(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

/** Associated label/legend text only — never the control's value. */
function associatedLabel(element: Element, root: ParentNode): string | undefined {
  const labeled = element as { labels?: NodeListOf<HTMLLabelElement> | null };
  if (labeled.labels !== undefined && labeled.labels !== null && labeled.labels.length > 0) {
    const text = Array.from(labeled.labels)
      .map((l) => l.textContent ?? '')
      .join(' ');
    const capped = trimCapped(text, 300);
    if (capped !== undefined) return capped;
  }
  const id = element.getAttribute('id');
  if (id !== null && id.length > 0) {
    const escaped = typeof CSS !== 'undefined' && CSS.escape !== undefined ? CSS.escape(id) : id;
    let forLabel: Element | null = null;
    try {
      forLabel = root.querySelector(`label[for="${escaped}"]`);
    } catch {
      forLabel = null;
    }
    const capped = trimCapped(forLabel?.textContent, 300);
    if (capped !== undefined) return capped;
  }
  const closest = trimCapped(element.closest('label')?.textContent, 300);
  if (closest !== undefined) return closest;
  // ARIA computed name: `aria-labelledby` before `aria-label`.
  const labelledBy = referencedLabel(element);
  if (labelledBy !== undefined) return labelledBy;
  return trimCapped(element.getAttribute('aria-label'), 300);
}

/**
 * Resolve `aria-labelledby` (space-separated element ids) to the referenced
 * text. Read-only metadata from the page's own markup — never a control value.
 */
function referencedLabel(element: Element): string | undefined {
  const ids = (element.getAttribute('aria-labelledby') ?? '').trim();
  if (ids.length === 0) return undefined;
  const doc = element.ownerDocument;
  if (doc === null) return undefined;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/)) {
    if (id.length === 0) continue;
    const escaped =
      typeof CSS !== 'undefined' && CSS.escape !== undefined ? CSS.escape(id) : id;
    let ref: Element | null = null;
    try {
      ref = doc.querySelector(`#${escaped}`);
    } catch {
      ref = null;
    }
    const text = (ref?.textContent ?? '').trim();
    if (text.length > 0) parts.push(text);
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined.slice(0, 300) : undefined;
}

/** Legend/aria-label for a radio group (the question text), not the option text. */
function radioGroupLabel(element: Element, root: ParentNode): string | undefined {
  const fieldset = element.closest('fieldset');
  const legend = trimCapped(fieldset?.querySelector('legend')?.textContent, 300);
  if (legend !== undefined) return legend;
  const aria = trimCapped(element.getAttribute('aria-label'), 300);
  if (aria !== undefined) return aria;
  return associatedLabel(element, root);
}

function baseAttributes(element: HTMLElement): Pick<
  FieldDescriptor,
  'name' | 'elementId' | 'autocomplete' | 'ariaLabel' | 'placeholder' | 'role' | 'ariaHasPopup'
> {
  const name = trimCapped(element.getAttribute('name'), 200);
  const id = trimCapped(element.id, 200);
  const autocomplete = trimCapped(element.getAttribute('autocomplete'), 200);
  const ariaLabel = trimCapped(element.getAttribute('aria-label'), 300);
  const placeholder = trimCapped(element.getAttribute('placeholder'), 300);
  const role = trimCapped(element.getAttribute('role'), 60);
  const ariaHasPopup = trimCapped(element.getAttribute('aria-haspopup'), 60);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(id !== undefined ? { elementId: id } : {}),
    ...(autocomplete !== undefined ? { autocomplete } : {}),
    ...(ariaLabel !== undefined ? { ariaLabel } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(ariaHasPopup !== undefined ? { ariaHasPopup } : {}),
  };
}

const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);

export interface ScanResult {
  descriptors: FieldDescriptor[];
  /** fieldId → element (radio groups store their first radio). */
  registry: Map<string, Element>;
}

/**
 * Collect value-free descriptors for the form controls in `root`, in DOM order,
 * capped at `MAX_SCAN_FIELDS`. Radio buttons sharing a (form, name) pair become
 * ONE descriptor so the group can be matched unambiguously at fill time.
 */
export function collectFieldDescriptors(root: Document | ParentNode): ScanResult {
  const descriptors: FieldDescriptor[] = [];
  const registry = new Map<string, Element>();
  const seenRadioGroups = new Set<string>();
  let counter = 0;

  const controls = (root as ParentNode).querySelectorAll('input, textarea, select');
  for (const element of Array.from(controls)) {
    if (descriptors.length >= MAX_SCAN_FIELDS) break;

    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if (SKIPPED_INPUT_TYPES.has(type)) continue;

      if (type === 'radio') {
        const name = element.getAttribute('name') ?? '';
        const formId = element.closest('form')?.getAttribute('id') ?? '';
        const key = `${formId}::${name}`;
        if (name !== '' && seenRadioGroups.has(key)) continue;
        if (name !== '') seenRadioGroups.add(key);
        const fieldId = `af-${counter++}`;
        const attrs = baseAttributes(element);
        descriptors.push({
          fieldId,
          kind: 'radio',
          inputType: 'radio',
          ...(radioGroupLabel(element, root) !== undefined
            ? { labelText: radioGroupLabel(element, root) }
            : {}),
          ...attrs,
        });
        registry.set(fieldId, element);
        continue;
      }

      const fieldId = `af-${counter++}`;
      const label = associatedLabel(element, root);
      descriptors.push({
        fieldId,
        kind: type === 'checkbox' ? 'checkbox' : 'text',
        inputType: type,
        ...(label !== undefined ? { labelText: label } : {}),
        ...baseAttributes(element),
      });
      registry.set(fieldId, element);
      continue;
    }

    if (element instanceof HTMLTextAreaElement) {
      const fieldId = `af-${counter++}`;
      const label = associatedLabel(element, root);
      descriptors.push({
        fieldId,
        kind: 'textarea',
        ...(label !== undefined ? { labelText: label } : {}),
        ...baseAttributes(element),
      });
      registry.set(fieldId, element);
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      const fieldId = `af-${counter++}`;
      const label = associatedLabel(element, root);
      descriptors.push({
        fieldId,
        kind: 'select',
        ...(label !== undefined ? { labelText: label } : {}),
        ...baseAttributes(element),
      });
      registry.set(fieldId, element);
    }
  }

  return { descriptors, registry };
}

/* ------------------------------------------------------------------ */
/* Content-script session                                              */
/* ------------------------------------------------------------------ */

export interface AutofillSession {
  /** Returns undefined for messages that are not ours. */
  handle(message: unknown): AutofillResponse | undefined;
}

let scanCounter = 0;

/** A fresh, unpredictable-per-session scan token (never persisted). */
function newScanId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    try {
      return `af-${c.randomUUID()}`;
    } catch {
      // fall through to the counter form
    }
  }
  scanCounter += 1;
  return `af-${Date.now().toString(36)}-${scanCounter.toString(36)}`;
}

function messageType(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return undefined;
  return (message as { type?: unknown }).type;
}

/**
 * Creates a session bound to one document. A scan refreshes the element
 * registry and mints a new `scanId`; a fill is applied ONLY when it presents
 * that exact token, so a plan can never be replayed against a different scan.
 */
export function createAutofillSession(root: Document | ParentNode): AutofillSession {
  let registry = new Map<string, Element>();
  let currentScanId: string | null = null;

  return {
    handle(message: unknown): AutofillResponse | undefined {
      if (autofillScanRequestSchema.safeParse(message).success) {
        try {
          const { descriptors, registry: next } = collectFieldDescriptors(root);
          if (descriptors.length === 0) {
            registry = new Map();
            currentScanId = null;
            return {
              kind: 'error',
              code: 'no-fields',
              message: 'No application form fields were found on this page.',
            };
          }
          registry = next;
          currentScanId = newScanId();
          return { kind: 'ok', scanId: currentScanId, descriptors };
        } catch {
          registry = new Map();
          currentScanId = null;
          return {
            kind: 'error',
            code: 'scan-failed',
            message: 'Could not read the form fields on this page.',
          };
        }
      }

      const type = messageType(message);
      if (type !== AUTOFILL_SCAN_REQUEST_TYPE && type !== AUTOFILL_FILL_REQUEST_TYPE) {
        return undefined; // not our message
      }
      if (type === AUTOFILL_SCAN_REQUEST_TYPE) {
        // Shaped like a scan but failed strict validation (extra/tampered keys).
        return {
          kind: 'error',
          code: 'scan-failed',
          message: 'The scan request was malformed.',
        };
      }

      const fillReq = autofillFillRequestSchema.safeParse(message);
      if (!fillReq.success) {
        return {
          kind: 'error',
          code: 'invalid-plan',
          message: 'The fill request was invalid or incomplete. Nothing was changed.',
        };
      }
      if (currentScanId === null || fillReq.data.scanId !== currentScanId) {
        return {
          kind: 'error',
          code: 'stale-session',
          message: 'The form changed since it was scanned. Nothing was changed — scan again.',
        };
      }

      const executed = executeFillPlan(fillReq.data.plan, registry);
      if (!executed.ok) {
        return { kind: 'error', code: 'invalid-plan', message: 'The fill plan was invalid.' };
      }
      return { kind: 'ok', report: executed.report };
    },
  };
}
