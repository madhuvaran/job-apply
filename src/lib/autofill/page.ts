/**
 * Page-side autofill: value-free form scanning + messaging glue (Prompt 14).
 *
 * `collectFieldDescriptors` reads ONLY form-control metadata (labels, name, id,
 * autocomplete, type) — never the control's value, never arbitrary page text.
 * `createAutofillSession` handles the two popup messages over the existing
 * content-script channel: a scan (returns descriptors) and a fill (executes a
 * validated plan against the elements that were scanned).
 *
 * Element references are held only in memory for the duration of one
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
  z.object({ kind: z.literal('ok'), descriptors: fieldDescriptorsSchema }).strict(),
  z
    .object({
      kind: z.literal('error'),
      code: z.enum(['no-fields', 'scan-failed']),
      message: z.string().min(1).max(300),
    })
    .strict(),
]);

export const autofillFillRequestSchema = z
  .object({ type: z.literal(AUTOFILL_FILL_REQUEST_TYPE), plan: fillPlanSchema })
  .strict();

export const autofillFillResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), report: fillReportSchema }).strict(),
  z
    .object({
      kind: z.literal('error'),
      code: z.literal('invalid-plan'),
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
  // Last resort for display/classification: the accessible name.
  return trimCapped(element.getAttribute('aria-label'), 300);
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
  'name' | 'elementId' | 'autocomplete' | 'ariaLabel' | 'placeholder'
> {
  const name = trimCapped(element.getAttribute('name'), 200);
  const id = trimCapped(element.id, 200);
  const autocomplete = trimCapped(element.getAttribute('autocomplete'), 200);
  const ariaLabel = trimCapped(element.getAttribute('aria-label'), 300);
  const placeholder = trimCapped(element.getAttribute('placeholder'), 300);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(id !== undefined ? { elementId: id } : {}),
    ...(autocomplete !== undefined ? { autocomplete } : {}),
    ...(ariaLabel !== undefined ? { ariaLabel } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
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

/**
 * Creates a session bound to one document. The scan message refreshes the
 * element registry; the fill message executes against the last scan only.
 */
export function createAutofillSession(root: Document | ParentNode): AutofillSession {
  let registry = new Map<string, Element>();

  return {
    handle(message: unknown): AutofillResponse | undefined {
      if (autofillScanRequestSchema.safeParse(message).success) {
        try {
          const { descriptors, registry: next } = collectFieldDescriptors(root);
          if (descriptors.length === 0) {
            return {
              kind: 'error',
              code: 'no-fields',
              message: 'No application form fields were found on this page.',
            };
          }
          registry = next;
          return { kind: 'ok', descriptors };
        } catch {
          return {
            kind: 'error',
            code: 'scan-failed',
            message: 'Could not read the form fields on this page.',
          };
        }
      }

      const fillReq = autofillFillRequestSchema.safeParse(message);
      if (!fillReq.success) return undefined;

      const executed = executeFillPlan(fillReq.data.plan, registry);
      if (!executed.ok) {
        return { kind: 'error', code: 'invalid-plan', message: 'The fill plan was invalid.' };
      }
      return { kind: 'ok', report: executed.report };
    },
  };
}
