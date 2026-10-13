// @vitest-environment jsdom
/**
 * Workday-style compatibility fixtures + tests (Prompt 16) — jsdom, synthetic
 * markup only. NO real candidate data, no live Workday page, no authentication.
 *
 * These fixtures characterize what the CURRENT deterministic engine does with
 * common application-form patterns. They are NOT evidence that any specific
 * Workday implementation behaves identically — see docs/autofill-compatibility.md
 * for the demonstrated / inferred / unverified split.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { profileSchema } from '../profile';
import { sensitiveProfileSchema } from '../sensitive';
import { classifyField } from './classify';
import { executeFillPlan } from './execute';
import {
  AUTOFILL_FILL_REQUEST_TYPE,
  AUTOFILL_SCAN_REQUEST_TYPE,
  collectFieldDescriptors,
  createAutofillSession,
  validateFillResponse,
  validateScanResponse,
} from './page';
import { buildFillPlan } from './plan';
import type { FieldDescriptor, FillInstruction } from './schemas';

/* ------------------------------------------------------------------ */
/* Synthetic fixtures (labels/values are invented)                     */
/* ------------------------------------------------------------------ */

const FIXTURES = {
  /** 1. Standard text input with an associated visible `<label for>`. */
  standardTextInput:
    '<label for="fn">First name</label><input id="fn" name="firstName" type="text" />',
  /** 2. Visible label connected via `aria-labelledby` (no native label). */
  ariaLabelledby:
    '<span id="city-lbl">City</span><input id="city" name="city" aria-labelledby="city-lbl" />',
  /** 3. Field labelled only with `aria-label`. */
  ariaLabel: '<input id="em" name="email" type="email" aria-label="Email address" />',
  /** 4. A combobox implemented as a NATIVE `<select>`. */
  nativeSelect:
    '<label for="sp">Will you require sponsorship?</label>' +
    '<select id="sp" name="sponsorship">' +
    '<option value="">Select one</option><option value="yes">Yes</option><option value="no">No</option></select>',
  /** 5. A CUSTOM combobox: role="combobox" + listbox popup of options. */
  customCombobox:
    '<span id="ctry-lbl">Country</span>' +
    '<input id="ctry" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="ctry-lbl" />' +
    '<ul role="listbox" aria-labelledby="ctry-lbl">' +
    '<li role="option" aria-selected="false">United Kingdom</li>' +
    '<li role="option" aria-selected="false">Canada</li></ul>',
  /** 5b. A widget that only signals a popup via `aria-haspopup`. */
  ariaHasPopupWidget: '<input id="hp" aria-haspopup="listbox" aria-label="Country" />',
  /** 5c. A "*menu*" popup is not an option picker and must not be treated as one. */
  ariaHasPopupMenu: '<input id="mn" aria-haspopup="menu" aria-label="First name" />',
  /** 6. Radio group with a visible group label (fieldset legend). */
  radioGroup:
    '<fieldset><legend>Will you require sponsorship?</legend>' +
    '<label><input type="radio" name="sponsor" value="yes"> Yes</label>' +
    '<label><input type="radio" name="sponsor" value="no"> No</label></fieldset>',
  /** 7. Checkbox with a descriptive (but unsupported) label. */
  checkboxDescriptive:
    '<label><input id="relocate" type="checkbox" name="relocate" value="yes"> I am willing to relocate</label>',
  /** 7b. A legal/consent checkbox that must stay excluded. */
  checkboxConsent:
    '<label><input id="agree" type="checkbox" name="agree" value="yes"> I agree to the terms and conditions</label>',
  /** 8. Required field with a pattern + an inline validation message. */
  requiredWithValidation:
    '<label for="ph">Phone</label>' +
    '<input id="ph" name="phone" type="tel" required pattern="[0-9\\s]+" aria-describedby="ph-err" />' +
    '<p id="ph-err" role="alert">Enter a valid phone number</p>',
  /** 9. Field replaced during a simulated rerender (see session test below). */
  rerenderHost: '<label for="fn">First name</label><input id="fn" name="firstName" type="text" />',
  /** 10. Multi-select that must remain unsupported. */
  multiSelect:
    '<label for="ms">Choose all that apply</label>' +
    '<select id="ms" name="multi" multiple>' +
    '<option value="Alpha" selected>Alpha</option>' +
    '<option value="Beta" selected>Beta</option>' +
    '<option value="Gamma">Gamma</option></select>',
} as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function descriptorFor(elementId: string): FieldDescriptor {
  const found = collectFieldDescriptors(document).descriptors.find((d) => d.elementId === elementId);
  if (found === undefined) throw new Error(`no descriptor for #${elementId}`);
  return found;
}

function instruction(
  fieldId: string,
  value: string,
  category: FillInstruction['category'] = 'firstName',
): FillInstruction {
  return { fieldId, category, value, source: 'sensitive', requiresConfirmation: true };
}

const profile = profileSchema.parse({
  displayName: 'Ada Example',
  summary: 'Pioneer of computing.',
  skills: [{ id: 's1', name: 'TypeScript' }],
  linkedin: 'https://www.linkedin.com/in/ada',
  portfolio: 'https://ada.example.invalid',
});

const sensitive = sensitiveProfileSchema.parse({
  contact: {
    firstName: 'Ada',
    lastName: 'Example',
    email: 'ada@example.invalid',
    phone: '+1 555 0100',
    cityLabel: 'London',
  },
  legal: { workAuthorization: 'authorized_no_sponsorship', sponsorshipNeeded: false },
  voluntary: {
    gender: 'undisclosed',
    raceEthnicity: ['undisclosed'],
    veteranStatus: 'undisclosed',
    disabilityStatus: 'undisclosed',
  },
});

beforeEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ */
/* 1. Label extraction                                                 */
/* ------------------------------------------------------------------ */

describe('label extraction (visible / aria-label / aria-labelledby)', () => {
  it('reads a visible <label for> association', () => {
    document.body.innerHTML = FIXTURES.standardTextInput;
    expect(descriptorFor('fn').labelText).toBe('First name');
  });

  it('resolves aria-labelledby to the referenced element text', () => {
    document.body.innerHTML = FIXTURES.ariaLabelledby;
    const d = descriptorFor('city');
    expect(d.labelText).toBe('City');
    expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'city' });
  });

  it('reads aria-label', () => {
    document.body.innerHTML = FIXTURES.ariaLabel;
    const d = descriptorFor('em');
    expect(d.labelText).toBe('Email address');
    expect(d.ariaLabel).toBe('Email address');
    expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'email' });
  });
});

/* ------------------------------------------------------------------ */
/* 2 & 3. Native select vs custom combobox                             */
/* ------------------------------------------------------------------ */

describe('native select vs custom ARIA combobox', () => {
  it('classifies a native <select> normally', () => {
    document.body.innerHTML = FIXTURES.nativeSelect;
    const d = descriptorFor('sp');
    expect(d.kind).toBe('select');
    expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'sponsorship' });
  });

  it('classifies a role="combobox" widget as ambiguous (manual)', () => {
    document.body.innerHTML = FIXTURES.customCombobox;
    const d = descriptorFor('ctry');
    expect(d.role).toBe('combobox');
    expect(d.ariaHasPopup).toBe('listbox');
    expect(classifyField(d).kind).toBe('ambiguous');
  });

  it('classifies an aria-haspopup="listbox" widget as ambiguous (manual)', () => {
    document.body.innerHTML = FIXTURES.ariaHasPopupWidget;
    expect(classifyField(descriptorFor('hp')).kind).toBe('ambiguous');
  });

  it('does NOT treat aria-haspopup="menu" as a combobox picker', () => {
    document.body.innerHTML = FIXTURES.ariaHasPopupMenu;
    expect(classifyField(descriptorFor('mn'))).toMatchObject({ kind: 'supported', category: 'firstName' });
  });

  it('leaves a custom combobox out of the fill plan entirely', () => {
    document.body.innerHTML = FIXTURES.customCombobox;
    const built = buildFillPlan({
      descriptors: collectFieldDescriptors(document).descriptors,
      profile,
      sensitive,
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    const ctry = descriptorFor('ctry');
    const review = built.review.find((r) => r.fieldId === ctry.fieldId);
    expect(review?.decision).toBe('manual');
    expect(review?.reason).toMatch(/combobox/i);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Radio / checkbox group context                                   */
/* ------------------------------------------------------------------ */

describe('radio and checkbox context', () => {
  it('keeps the radio-group question (legend) so it is classified correctly', () => {
    document.body.innerHTML = FIXTURES.radioGroup;
    const radios = collectFieldDescriptors(document).descriptors;
    expect(radios).toHaveLength(1);
    expect(radios[0]).toMatchObject({ kind: 'radio', labelText: 'Will you require sponsorship?' });
    expect(classifyField(radios[0] as FieldDescriptor)).toMatchObject({
      kind: 'supported',
      category: 'sponsorship',
    });
  });

  it('captures a descriptive checkbox label (unsupported category → manual)', () => {
    document.body.innerHTML = FIXTURES.checkboxDescriptive;
    const d = descriptorFor('relocate');
    expect(d.labelText ?? '').toMatch(/relocate/i);
    expect(classifyField(d).kind).toBe('unsupported');
  });

  it('still excludes a legal/consent checkbox', () => {
    document.body.innerHTML = FIXTURES.checkboxConsent;
    expect(classifyField(descriptorFor('agree')).kind).toBe('excluded');
  });
});

/* ------------------------------------------------------------------ */
/* 5. Required / validation                                            */
/* ------------------------------------------------------------------ */

describe('required + inline validation', () => {
  it('reports verify-failed when the saved value violates the pattern', () => {
    document.body.innerHTML = FIXTURES.requiredWithValidation;
    const input = document.getElementById('ph') as HTMLInputElement;
    const changed = vi.fn();
    input.addEventListener('change', changed);
    const result = executeFillPlan(
      plan([instruction('ph', 'not-a-phone', 'phone')]),
      [{ fieldId: 'ph', element: input }],
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('verify-failed');
    expect(result.report.filledCount).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('fills a required field when the value satisfies the constraint', () => {
    document.body.innerHTML = FIXTURES.requiredWithValidation;
    const input = document.getElementById('ph') as HTMLInputElement;
    const result = executeFillPlan(
      plan([instruction('ph', '555 0100', 'phone')]),
      [{ fieldId: 'ph', element: input }],
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(input.value).toBe('555 0100');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Dynamic rerender                                                 */
/* ------------------------------------------------------------------ */

describe('dynamic rerender', () => {
  it('reports disconnected (and never re-resolves) when the field was replaced', () => {
    document.body.innerHTML = FIXTURES.rerenderHost;
    const session = createAutofillSession(document);
    const scan = session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
    const parsed = validateScanResponse(scan);
    if (!parsed.ok || parsed.value.kind !== 'ok') throw new Error('expected scan ok');
    const fieldId = parsed.value.descriptors[0]?.fieldId as string;

    document.getElementById('fn')?.remove();
    const replacement = document.createElement('input');
    replacement.id = 'fn';
    replacement.name = 'firstName';
    replacement.value = 'RERENDER-EXISTING';
    document.body.appendChild(replacement);

    const fill = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: parsed.value.scanId,
      plan: { schemaVersion: '1', instructions: [instruction(fieldId, 'Ada')] },
    });
    const filled = validateFillResponse(fill);
    if (!filled.ok || filled.value.kind !== 'ok') throw new Error('expected fill ok');
    expect(filled.value.report.results[0]?.status).toBe('disconnected');
    expect(replacement.value).toBe('RERENDER-EXISTING');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Multi-select                                                     */
/* ------------------------------------------------------------------ */

describe('multi-select remains unsupported', () => {
  it('skips a multi-select and leaves selections untouched', () => {
    document.body.innerHTML = FIXTURES.multiSelect;
    const select = document.getElementById('ms') as HTMLSelectElement;
    const result = executeFillPlan(
      plan([instruction('ms', 'Gamma', 'skills')]),
      [{ fieldId: 'ms', element: select }],
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('unsupported-element');
    expect(Array.from(select.selectedOptions).map((o) => o.value)).toEqual(['Alpha', 'Beta']);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Sensitive exclusions                                             */
/* ------------------------------------------------------------------ */

describe('sensitive exclusions remain intact', () => {
  it('excludes compensation and legal fields from the plan', () => {
    document.body.innerHTML =
      '<label for="sal">Expected salary</label><input id="sal" name="salary" />' +
      FIXTURES.checkboxConsent;
    const built = buildFillPlan({
      descriptors: collectFieldDescriptors(document).descriptors,
      profile,
      sensitive,
    });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    for (const r of built.review) expect(r.classification).toBe('excluded');
  });
});

/* ------------------------------------------------------------------ */
/* 9. Cancel / stale session                                           */
/* ------------------------------------------------------------------ */

describe('cancel and stale-session behavior', () => {
  it('rejects a fill with a stale scanId and writes nothing', () => {
    document.body.innerHTML = FIXTURES.standardTextInput;
    const session = createAutofillSession(document);
    session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
    const response = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: 'stale-token',
      plan: { schemaVersion: '1', instructions: [instruction('af-0', 'Ada')] },
    });
    expect(response).toMatchObject({ kind: 'error', code: 'stale-session' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* 10. Offline                                                        */
/* ------------------------------------------------------------------ */

describe('offline', () => {
  it('makes no network call while scanning, planning and filling fixtures', () => {
    document.body.innerHTML = FIXTURES.standardTextInput + FIXTURES.customCombobox;
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const descriptors = collectFieldDescriptors(document).descriptors;
      const built = buildFillPlan({ descriptors, profile, sensitive });
      if (!built.ok) throw new Error('expected ok');
      executeFillPlan(built.plan, [{ fieldId: 'fn', element: document.getElementById('fn') as Element }]);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function plan(instructions: FillInstruction[]): unknown {
  return { schemaVersion: '1', instructions };
}
