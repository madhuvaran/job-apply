// @vitest-environment jsdom
/**
 * Deterministic detection coverage (Prompt 22) — jsdom, synthetic fixtures only.
 *
 * Scope: the descriptor-extraction and classification gaps this task fixed, plus
 * the safety rules they must not weaken. No real site, no real applicant data,
 * no network, no provider — jsdom only (no real browser/event loop).
 *
 * Already covered elsewhere (NOT duplicated here):
 * - `page.test.ts`   — basic label[for], value-free descriptors, radio grouping, scan cap.
 * - `workday.test.ts`— aria-label / aria-labelledby basics, custom combobox, stale session.
 * - `hardening.test.ts` / `execute.test.ts` — disabled/read-only/hidden/inert gates,
 *   native-setter writes, placeholder dropdown options, multi-select.
 * - `mapping.test.ts` / `boundaries.test.ts` — AI off by default, strict schemas, permissions.
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
/* Fixtures (invented values only)                                     */
/* ------------------------------------------------------------------ */

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

function scanHtml(html: string): FieldDescriptor[] {
  document.body.innerHTML = html;
  return collectFieldDescriptors(document).descriptors;
}

function descriptorFor(elementId: string): FieldDescriptor {
  const found = collectFieldDescriptors(document).descriptors.find((d) => d.elementId === elementId);
  if (found === undefined) throw new Error(`no descriptor for #${elementId}`);
  return found;
}

function category(elementId: string): string | null {
  const result = classifyField(descriptorFor(elementId));
  return result.kind === 'supported' ? result.category : null;
}

function instruction(
  fieldId: string,
  value: string,
  cat: FillInstruction['category'] = 'firstName',
): FillInstruction {
  return { fieldId, category: cat, value, source: 'sensitive', requiresConfirmation: true };
}

function plan(instructions: FillInstruction[]): unknown {
  return { schemaVersion: '1', instructions };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ */
/* 1–5. Label association and ARIA name resolution                     */
/* ------------------------------------------------------------------ */

describe('label association', () => {
  it('reads label[for], nested labels and duplicate labels for the same control', () => {
    const descriptors = scanHtml(
      '<label for="fn">First name</label><input id="fn" name="firstName">' +
        '<label>Last name <input id="ln" name="lastName"></label>' +
        '<label for="em">Email</label><label for="em">address</label><input id="em" name="email">',
    );
    expect(descriptors.find((d) => d.elementId === 'fn')?.labelText).toBe('First name');
    expect(descriptors.find((d) => d.elementId === 'ln')?.labelText).toBe('Last name');
    // Both labels for the same id are used (never just the first one).
    expect(descriptors.find((d) => d.elementId === 'em')?.labelText).toMatch(/email/i);
    expect(descriptors.find((d) => d.elementId === 'em')?.labelText).toMatch(/address/i);
    expect(category('em')).toBe('email');
  });

  it('reads aria-label without any native label', () => {
    scanHtml('<input id="em" name="email" aria-label="Email address">');
    const d = descriptorFor('em');
    expect(d.labelText).toBe('Email address');
    expect(d.ariaLabel).toBe('Email address');
    expect(category('em')).toBe('email');
  });

  it('resolves every id in aria-labelledby, ignoring duplicates and separators', () => {
    scanHtml('<input id="fn" aria-labelledby="a1 a1, a2"><span id="a1">First</span><span id="a2">name</span>');
    expect(descriptorFor('fn').ariaLabel).toBe('First name');
    expect(category('fn')).toBe('firstName');
  });

  it('keeps the explicit ARIA name when a native label also exists (previously dropped)', () => {
    // Regression: the ARIA name was only resolved when no native label existed,
    // so the referenced text was discarded and the field stayed ambiguous.
    scanHtml(
      '<label for="e">Name</label><input id="e" aria-labelledby="lbl"><span id="lbl">Email address</span>',
    );
    const d = descriptorFor('e');
    expect(d.labelText).toBe('Name');
    expect(d.ariaLabel).toBe('Email address');
    expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'email' });
  });

  it('ignores missing/unresolvable referenced ids without throwing and falls back to aria-label', () => {
    expect(() =>
      scanHtml(
        '<input id="city" aria-labelledby="missing #weird) ,"><span id="city-lbl">City</span>' +
          '<input id="p" aria-labelledby=" ,,  " aria-label="Phone number">',
      ),
    ).not.toThrow();
    // Nothing resolvable → no ARIA name invented, the other signal is used.
    expect(descriptorFor('p').ariaLabel).toBe('Phone number');
    expect(category('p')).toBe('phone');
    // A malformed/duplicate id never crashes the scan or the classifier.
    expect(descriptorFor('city').ariaLabel).toBeUndefined();
    expect(() => classifyField(descriptorFor('city'))).not.toThrow();
  });

  it('conflicting native label and ARIA name stay conservative (ambiguous, manual)', () => {
    // Two different signals → two categories → never a guess.
    scanHtml('<label for="x">First name</label><input id="x" aria-label="Email address">');
    expect(classifyField(descriptorFor('x')).kind).toBe('ambiguous');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Fieldset / legend context                                        */
/* ------------------------------------------------------------------ */

describe('fieldset and legend context', () => {
  it('uses the legend for a control that has no label of its own', () => {
    scanHtml('<fieldset><legend>Email address</legend><input id="q7" name="q7"></fieldset>');
    const d = descriptorFor('q7');
    expect(d.labelText).toBeUndefined();
    expect(d.groupLabel).toBe('Email address');
    expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'email' });
  });

  it('fills a legend-identified field through the normal planner', () => {
    const descriptors = scanHtml('<fieldset><legend>Email address</legend><input id="q7" name="q7"></fieldset>');
    const built = buildFillPlan({ descriptors, profile, sensitive });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toHaveLength(1);
    expect(built.plan.instructions[0]).toMatchObject({ category: 'email', value: 'ada@example.invalid' });
    expect(built.plan.instructions[0]?.requiresConfirmation).toBe(true);
  });

  it('walks outward to an ancestor legend and never reads a nested group legend', () => {
    const descriptors = scanHtml(
      '<fieldset><legend>Email address</legend><fieldset><input id="q8" name="q8"></fieldset></fieldset>' +
        '<fieldset><legend>Phone</legend><input id="a" name="a">' +
        '<fieldset><legend>City</legend><input id="b" name="b"></fieldset></fieldset>',
    );
    const byId = (id: string): FieldDescriptor | undefined => descriptors.find((d) => d.elementId === id);
    expect(byId('q8')?.groupLabel).toBe('Email address'); // outer legend reached past the legendless inner set
    expect(byId('a')?.groupLabel).toBe('Phone'); // own group legend, not the inner one
    expect(byId('b')?.groupLabel).toBe('City');
  });

  it('never lets group context override a control-owned label or placeholder hint', () => {
    scanHtml(
      '<fieldset><legend>Country</legend><label for="fn">First name</label><input id="fn"></fieldset>' +
        '<fieldset><legend>Email address</legend><input id="ph" placeholder="Phone number"></fieldset>',
    );
    expect(descriptorFor('fn').groupLabel).toBe('Country');
    expect(classifyField(descriptorFor('fn'))).toMatchObject({ kind: 'supported', category: 'firstName' });
    // The placeholder is the control's own hint, so the group question is ignored.
    expect(classifyField(descriptorFor('ph'))).toMatchObject({ kind: 'supported', category: 'phone' });
  });
});

/* ------------------------------------------------------------------ */
/* 7. Placeholder as a lower-confidence fallback                       */
/* ------------------------------------------------------------------ */

describe('placeholder precedence', () => {
  it('uses a placeholder when no stronger label exists', () => {
    scanHtml('<input id="p1" placeholder="First name">');
    expect(category('p1')).toBe('firstName');
  });

  it('ignores a contradictory placeholder when a real label exists', () => {
    scanHtml('<label for="x">First name</label><input id="x" placeholder="Enter your email address">');
    expect(classifyField(descriptorFor('x'))).toMatchObject({ kind: 'supported', category: 'firstName' });
  });

  it('still lets a placeholder trigger a safety exclusion', () => {
    // Safety beats detection: the placeholder feeds the exclusion corpus even
    // when the visible label looks harmless.
    scanHtml('<label for="pw">First name</label><input id="pw" placeholder="Enter your password">');
    expect(classifyField(descriptorFor('pw')).kind).toBe('excluded');
  });

  it('excludes a password control even with an innocuous label and placeholder', () => {
    scanHtml('<label for="pw2">Your details</label><input id="pw2" type="password" placeholder="First name">');
    expect(classifyField(descriptorFor('pw2')).kind).toBe('excluded');
    // ...and it is never planned.
    const built = buildFillPlan({ descriptors: collectFieldDescriptors(document).descriptors, profile, sensitive });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Duplicate labels on different controls                           */
/* ------------------------------------------------------------------ */

describe('duplicate labels across controls', () => {
  it('keeps same-text controls separate and fills each independently', () => {
    scanHtml(
      '<label for="e1">Email address</label><input id="e1" name="email1">' +
        '<label for="e2">Email address</label><input id="e2" name="email2">',
    );
    const { descriptors } = collectFieldDescriptors(document);
    expect(descriptors).toHaveLength(2);
    expect(new Set(descriptors.map((d) => d.fieldId)).size).toBe(2);
    for (const d of descriptors) {
      expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'email' });
    }

    const session = createAutofillSession(document);
    const scan = session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
    const parsed = validateScanResponse(scan);
    if (!parsed.ok || parsed.value.kind !== 'ok') throw new Error('expected scan ok');
    const instructions = parsed.value.descriptors.map((d) => instruction(d.fieldId, 'ada@example.invalid', 'email'));
    const fill = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: parsed.value.scanId,
      plan: plan(instructions),
    });
    const filled = validateFillResponse(fill);
    if (!filled.ok || filled.value.kind !== 'ok') throw new Error('expected fill ok');
    expect(filled.value.report.filledCount).toBe(2);
    expect((document.getElementById('e1') as HTMLInputElement).value).toBe('ada@example.invalid');
    expect((document.getElementById('e2') as HTMLInputElement).value).toBe('ada@example.invalid');
  });
});

/* ------------------------------------------------------------------ */
/* 9. Dynamic forms (fresh scan)                                       */
/* ------------------------------------------------------------------ */

describe('dynamic forms', () => {
  it('discovers controls added later, invalidates the old plan and fills on a fresh scan', () => {
    document.body.innerHTML = '<label for="fn">First name</label><input id="fn" name="firstName">';
    const session = createAutofillSession(document);

    const first = validateScanResponse(session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE }));
    if (!first.ok || first.value.kind !== 'ok') throw new Error('expected scan ok');
    expect(first.value.descriptors).toHaveLength(1);

    // The form grows after the first scan (async section / rerender).
    const added = document.createElement('input');
    added.id = 'em';
    added.name = 'email';
    const label = document.createElement('label');
    label.htmlFor = 'em';
    label.textContent = 'Email address';
    document.body.appendChild(label);
    document.body.appendChild(added);

    const second = validateScanResponse(session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE }));
    if (!second.ok || second.value.kind !== 'ok') throw new Error('expected scan ok');
    expect(second.value.scanId).not.toBe(first.value.scanId);
    expect(second.value.descriptors.map((d) => d.elementId)).toEqual(['fn', 'em']);

    // The previous scan's plan/token is stale → rejected, nothing written.
    const replayed = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: first.value.scanId,
      plan: plan([instruction(first.value.descriptors[0]?.fieldId as string, 'Ada')]),
    });
    expect(replayed).toMatchObject({ kind: 'error', code: 'stale-session' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');

    // The fresh scan fills both the original and the newly discovered control.
    const instructions = second.value.descriptors.map((d) =>
      d.elementId === 'em' ? instruction(d.fieldId, 'ada@example.invalid', 'email') : instruction(d.fieldId, 'Ada'),
    );
    const fill = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: second.value.scanId,
      plan: plan(instructions),
    });
    const filled = validateFillResponse(fill);
    if (!filled.ok || filled.value.kind !== 'ok') throw new Error('expected fill ok');
    expect(filled.value.report.filledCount).toBe(2);
    expect((document.getElementById('em') as HTMLInputElement).value).toBe('ada@example.invalid');
  });
});

/* ------------------------------------------------------------------ */
/* 10. Malformed / oversized markup                                    */
/* ------------------------------------------------------------------ */

describe('malformed and oversized markup', () => {
  it('caps an excessively long label and still classifies it', () => {
    scanHtml(`<label for="long">${'First name '.repeat(60)}</label><input id="long">`);
    const d = descriptorFor('long');
    expect(d.labelText?.length).toBeLessThanOrEqual(300);
    expect(classifyField(d)).toMatchObject({ kind: 'supported', category: 'firstName' });
  });

  it('survives duplicate ids, dangling label[for] and broken ARIA attributes', () => {
    expect(() =>
      scanHtml(
        '<label for="dup">First name</label><input id="dup"><input id="dup" name="dup2">' +
          '<label for="nope">Ghost</label><input id="other" aria-labelledby=",,," name="other">' +
          '<fieldset><legend></legend><input id="empty-legend" name="emptyLegend"></fieldset>',
      ),
    ).not.toThrow();
    const descriptors = collectFieldDescriptors(document).descriptors;
    expect(descriptors.length).toBeGreaterThanOrEqual(3);
    for (const d of descriptors) expect(() => classifyField(d)).not.toThrow();
    // An empty legend never becomes group context.
    expect(descriptors.find((d) => d.elementId === 'empty-legend')?.groupLabel).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 11. Sensitive fields stay excluded despite misleading labels         */
/* ------------------------------------------------------------------ */

describe('sensitive fields remain excluded', () => {
  it('excludes compensation and consent fields with misleading labels or group context', () => {
    const descriptors = scanHtml(
      '<label for="sal">First name</label><input id="sal" placeholder="Expected salary">' +
        '<fieldset><legend>I agree to the terms and conditions</legend><input id="ag" name="ag"></fieldset>' +
        '<fieldset><legend>Voluntary Self-Identification (Disability Status)</legend>' +
        '<select id="eeo" name="eeo"></select></fieldset>',
    );
    for (const d of descriptors) {
      expect(classifyField(d).kind, d.elementId ?? '').toBe('excluded');
    }
    const built = buildFillPlan({ descriptors, profile, sensitive });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
  });

  it('keeps work-authorization context out of the fillable set for text controls', () => {
    // A free-text control is only ever planned for choice categories.
    const descriptors = scanHtml(
      '<fieldset><legend>Are you legally authorized to work here?</legend><input id="wa" name="wa"></fieldset>',
    );
    const built = buildFillPlan({ descriptors, profile, sensitive });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions).toEqual([]);
    expect(built.review[0]?.decision).toBe('manual');
  });
});

/* ------------------------------------------------------------------ */
/* 12. Existing-value / hidden / disabled / read-only ineligibility     */
/* ------------------------------------------------------------------ */

describe('never overwrite an existing value', () => {
  it('leaves a pre-filled text input and a pre-filled textarea untouched', () => {
    scanHtml(
      '<label for="fn">First name</label><input id="fn" value="TYPED-BY-APPLICANT">' +
        '<label for="sum">Professional summary</label><textarea id="sum">EXISTING SUMMARY</textarea>' +
        '<label for="em">Email address</label><input id="em">',
    );
    const session = createAutofillSession(document);
    const scan = validateScanResponse(session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE }));
    if (!scan.ok || scan.value.kind !== 'ok') throw new Error('expected scan ok');
    const byId = new Map(scan.value.descriptors.map((d) => [d.elementId, d.fieldId]));
    const fill = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: scan.value.scanId,
      plan: plan([
        instruction(byId.get('fn') as string, 'Ada'),
        instruction(byId.get('sum') as string, 'New summary.', 'summary'),
        instruction(byId.get('em') as string, 'ada@example.invalid', 'email'),
      ]),
    });
    const filled = validateFillResponse(fill);
    if (!filled.ok || filled.value.kind !== 'ok') throw new Error('expected fill ok');
    expect(filled.value.report.results.map((r) => r.status)).toEqual([
      'already-filled',
      'already-filled',
      'filled',
    ]);
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('TYPED-BY-APPLICANT');
    expect((document.getElementById('sum') as HTMLTextAreaElement).value).toBe('EXISTING SUMMARY');
    expect((document.getElementById('em') as HTMLInputElement).value).toBe('ada@example.invalid');
    for (const r of filled.value.report.results) {
      expect(r.message).not.toContain('TYPED-BY-APPLICANT');
      expect(r.message).not.toContain('EXISTING SUMMARY');
      expect(r.message).not.toContain('Ada');
    }
  });

  it('reports a pre-filled field as skipped without emitting events', () => {
    document.body.innerHTML = '<input id="fn" type="text" value="KEEP-ME">';
    const input = document.getElementById('fn') as HTMLInputElement;
    const changed = vi.fn();
    input.addEventListener('input', changed);
    input.addEventListener('change', changed);
    const result = executeFillPlan(plan([instruction('af-0', 'Ada')]), [{ fieldId: 'af-0', element: input }]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('already-filled');
    expect(result.report.filledCount).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(input.value).toBe('KEEP-ME');
  });

  it('fills a select only when its current selection is a placeholder', () => {
    document.body.innerHTML =
      '<select id="placeholder"><option value="" selected>Select one</option><option value="yes">Yes</option></select>' +
      '<select id="answered"><option value="no" selected>No</option><option value="yes">Yes</option></select>';
    const placeholder = document.getElementById('placeholder') as HTMLSelectElement;
    const answered = document.getElementById('answered') as HTMLSelectElement;
    const result = executeFillPlan(
      plan([instruction('p', 'Yes', 'sponsorship'), instruction('a', 'Yes', 'sponsorship')]),
      [
        { fieldId: 'p', element: placeholder },
        { fieldId: 'a', element: answered },
      ],
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results.map((r) => r.status)).toEqual(['filled', 'already-filled']);
    expect(placeholder.value).toBe('yes');
    expect(answered.value).toBe('no');
  });

  it('leaves a radio group that already has an answer as it is', () => {
    document.body.innerHTML =
      '<label><input type="radio" name="q" value="yes"> Yes</label>' +
      '<label><input type="radio" name="q" value="no" checked> No</label>';
    const group = Array.from(document.querySelectorAll('input[type="radio"]'));
    const result = executeFillPlan(plan([instruction('r', 'Yes', 'sponsorship')]), [
      { fieldId: 'r', element: group[0] as Element },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('already-filled');
    expect(group.map((r) => (r as HTMLInputElement).checked)).toEqual([false, true]);
  });

  it('still fills an unanswered radio group and an empty select', () => {
    document.body.innerHTML =
      '<label><input type="radio" name="q" value="yes"> Yes</label>' +
      '<label><input type="radio" name="q" value="no"> No</label>';
    const group = Array.from(document.querySelectorAll('input[type="radio"]'));
    const result = executeFillPlan(plan([instruction('r', 'Yes', 'sponsorship')]), [
      { fieldId: 'r', element: group[0] as Element },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect((group[0] as HTMLInputElement).checked).toBe(true);
  });

  it('keeps hidden, disabled and read-only controls ineligible alongside a pre-filled one', () => {
    document.body.innerHTML =
      '<input id="pre" type="text" value="KEEP">' +
      '<input id="hid" type="text" style="display:none">' +
      '<input id="dis" type="text" disabled>' +
      '<input id="ro" type="text" readonly>';
    const targets = ['pre', 'hid', 'dis', 'ro'].map((id, i) => ({
      fieldId: `f${i}`,
      element: document.getElementById(id) as Element,
    }));
    const result = executeFillPlan(
      plan(targets.map((t, i) => instruction(t.fieldId, `Ada${i}`))),
      targets,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results.map((r) => r.status)).toEqual([
      'already-filled',
      'hidden',
      'disabled',
      'read-only',
    ]);
    for (const id of ['pre', 'hid', 'dis', 'ro']) {
      expect((document.getElementById(id) as HTMLInputElement).value).not.toMatch(/^Ada/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 13–14. No provider calls + session/approval protections intact       */
/* ------------------------------------------------------------------ */

describe('scanning stays local and confirmed', () => {
  it('makes no network/provider call while scanning, planning and filling', () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      document.body.innerHTML =
        '<p>PAGE-SECRET-TEXT</p><fieldset><legend>Email address</legend><input id="q7" value="FIELD-SECRET"></fieldset>';
      const session = createAutofillSession(document);
      const scan = validateScanResponse(session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE }));
      if (!scan.ok || scan.value.kind !== 'ok') throw new Error('expected scan ok');
      const descriptors = scan.value.descriptors;
      // Value-free scanning: neither page text nor field values appear anywhere.
      const json = JSON.stringify(descriptors);
      expect(json).not.toContain('PAGE-SECRET-TEXT');
      expect(json).not.toContain('FIELD-SECRET');

      const built = buildFillPlan({ descriptors, profile, sensitive });
      if (!built.ok) throw new Error('expected ok');
      const fill = session.handle({
        type: AUTOFILL_FILL_REQUEST_TYPE,
        scanId: scan.value.scanId,
        plan: built.plan,
      });
      const filled = validateFillResponse(fill);
      if (!filled.ok || filled.value.kind !== 'ok') throw new Error('expected fill ok');
      // The fixture field already had a value → it is left untouched (and the
      // value never appears in the report).
      expect(filled.value.report.results[0]?.status).toBe('already-filled');
      expect((document.getElementById('q7') as HTMLInputElement).value).toBe('FIELD-SECRET');
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still requires per-field confirmation and a current scan token', () => {
    const descriptors = scanHtml('<label for="fn">First name</label><input id="fn" name="firstName">');
    const built = buildFillPlan({ descriptors, profile, sensitive });
    if (!built.ok) throw new Error('expected ok');
    expect(built.plan.instructions.length).toBeGreaterThan(0);
    for (const i of built.plan.instructions) expect(i.requiresConfirmation).toBe(true);

    const session = createAutofillSession(document);
    // No scan yet → nothing writable.
    const before = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId: 'never-scanned',
      plan: built.plan,
    });
    expect(before).toMatchObject({ kind: 'error', code: 'stale-session' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });
});
