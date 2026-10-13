// @vitest-environment jsdom
/**
 * Executor hardening tests (Prompt 15) — jsdom, synthetic fixtures only.
 *
 * These cover real-world form behaviors: controlled (React-style) inputs,
 * post-fill verification, dropdown placeholders, radio-group scoping and
 * checkbox state, plus the non-interactable gates. jsdom does NOT reproduce a
 * real browser event loop, native constraint validation, or a framework's
 * render cycle — see the limitations in README/PROGRESS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeFillPlan, type FillTarget } from './execute';
import type { FillInstruction } from './schemas';

function instruction(
  fieldId: string,
  value: string,
  category: FillInstruction['category'] = 'firstName',
): FillInstruction {
  return { fieldId, category, value, source: 'sensitive', requiresConfirmation: true };
}

function plan(instructions: FillInstruction[]): unknown {
  return { schemaVersion: '1', instructions };
}

/* ------------------------------------------------------------------ */
/* Synthetic fixtures                                                  */
/* ------------------------------------------------------------------ */

const FIXTURES = {
  reactTextInput: '<label for="fn">First name</label><input id="fn" name="firstName" type="text" />',
  reactTextarea:
    '<label for="sum">Professional summary</label><textarea id="sum" name="summary"></textarea>',
  selectMultiple:
    '<label for="ms">Choose all that apply</label>' +
    '<select id="ms" name="multi" multiple>' +
    '<option value="MultiOption-Alpha" selected>MultiOption-Alpha</option>' +
    '<option value="MultiOption-Beta" selected>MultiOption-Beta</option>' +
    '<option value="MultiOption-Gamma">MultiOption-Gamma</option></select>',
  selectPlaceholder:
    '<label for="sp">Will you require sponsorship?</label>' +
    '<select id="sp" name="sponsorship">' +
    '<option value="" selected disabled>Select one</option>' +
    '<option value="yes">Yes</option><option value="no">No</option></select>',
  radioTwoQuestions:
    '<fieldset><legend>Will you require sponsorship?</legend>' +
    '<label><input type="radio" name="q_sponsor" value="yes"> Yes</label>' +
    '<label><input type="radio" name="q_sponsor" value="no"> No</label></fieldset>' +
    '<fieldset><legend>Are you authorized to work?</legend>' +
    '<label><input type="radio" name="q_auth" value="yes"> Yes</label>' +
    '<label><input type="radio" name="q_auth" value="no"> No</label></fieldset>',
  checkboxes:
    '<label><input type="checkbox" name="c_yes" value="yes" checked> Yes</label>' +
    '<label><input type="checkbox" name="c_no" value="no"> No</label>',
  gated:
    '<input id="dis" type="text" disabled />' +
    '<input id="ro" type="text" readonly />' +
    '<input id="hid" type="text" style="display:none" />' +
    '<input id="inert" type="text" inert />',
} as const;

beforeEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ */
/* React-controlled inputs                                             */
/* ------------------------------------------------------------------ */

describe('controlled inputs use the native setter', () => {
  it('writes a React-style controlled text input via the native value setter', () => {
    document.body.innerHTML = FIXTURES.reactTextInput;
    const input = document.getElementById('fn') as HTMLInputElement;
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (proto?.get === undefined || proto.set === undefined) throw new Error('no native value descriptor');

    // Simulate React's own-property change tracker on the node: it records the
    // value and forwards to the native setter. Our executor must NOT go through
    // this tracker (it uses the prototype setter directly) so the framework can
    // observe the change.
    const instanceSet = vi.fn((v: string) => {
      proto.set?.call(input, v);
    });
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => proto.get?.call(input),
      set: instanceSet,
    });

    const events: Array<{ type: string; bubbles: boolean }> = [];
    input.addEventListener('input', (e) => events.push({ type: e.type, bubbles: e.bubbles }));
    input.addEventListener('change', (e) => events.push({ type: e.type, bubbles: e.bubbles }));

    const result = executeFillPlan(plan([instruction('f1', 'Ada')]), [{ fieldId: 'f1', element: input }]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(instanceSet).not.toHaveBeenCalled();
    expect(input.value).toBe('Ada');
    expect(events).toEqual([
      { type: 'input', bubbles: true },
      { type: 'change', bubbles: true },
    ]);
  });

  it('writes a React-style controlled textarea via the native value setter', () => {
    document.body.innerHTML = FIXTURES.reactTextarea;
    const area = document.getElementById('sum') as HTMLTextAreaElement;
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (proto?.get === undefined || proto.set === undefined) throw new Error('no native value descriptor');
    const instanceSet = vi.fn((v: string) => {
      proto.set?.call(area, v);
    });
    Object.defineProperty(area, 'value', {
      configurable: true,
      get: () => proto.get?.call(area),
      set: instanceSet,
    });

    const result = executeFillPlan(plan([instruction('f1', 'A summary.', 'summary')]), [
      { fieldId: 'f1', element: area },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(instanceSet).not.toHaveBeenCalled();
    expect(area.value).toBe('A summary.');
  });
});

/* ------------------------------------------------------------------ */
/* Post-fill verification                                              */
/* ------------------------------------------------------------------ */

describe('post-fill verification', () => {
  it('returns verify-failed and fires no events when a write does not take effect', () => {
    document.body.innerHTML = '<input id="fn" type="text" />';
    const input = document.getElementById('fn') as HTMLInputElement;
    const proto = HTMLInputElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'value');
    if (original?.get === undefined) throw new Error('no native value descriptor');

    // A control that silently refuses writes (e.g. a read-only widget).
    Object.defineProperty(proto, 'value', { configurable: true, get: original.get, set() {} });
    try {
      const changed = vi.fn();
      input.addEventListener('change', changed);
      const result = executeFillPlan(plan([instruction('f1', 'Ada')]), [
        { fieldId: 'f1', element: input },
      ]);
      if (!result.ok) throw new Error('expected ok');
      expect(result.report.results[0]?.status).toBe('verify-failed');
      expect(result.report.filledCount).toBe(0);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(proto, 'value', original);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Select / radio / checkbox                                           */
/* ------------------------------------------------------------------ */

describe('select hardening', () => {
  it('never selects a placeholder option even when the planned value matches it', () => {
    document.body.innerHTML = FIXTURES.selectPlaceholder;
    const select = document.getElementById('sp') as HTMLSelectElement;
    const before = select.value;
    const result = executeFillPlan(plan([instruction('sp', 'Select one', 'sponsorship')]), [
      { fieldId: 'sp', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('no-match');
    expect(select.value).toBe(before);
    expect(select.selectedIndex).toBe(0);
  });

  it('still selects a real option alongside a placeholder', () => {
    document.body.innerHTML = FIXTURES.selectPlaceholder;
    const select = document.getElementById('sp') as HTMLSelectElement;
    const result = executeFillPlan(plan([instruction('sp', 'Yes', 'sponsorship')]), [
      { fieldId: 'sp', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(select.value).toBe('yes');
  });

  it('leaves an ambiguous select unchanged (never picks the first option)', () => {
    document.body.innerHTML =
      '<select id="s"><option value="a">Yes</option><option value="b">Yes</option></select>';
    const select = document.getElementById('s') as HTMLSelectElement;
    const result = executeFillPlan(plan([instruction('s', 'Yes', 'sponsorship')]), [
      { fieldId: 's', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('no-match');
    expect(select.value).toBe('a');
  });
});

describe('multi-select hardening', () => {
  it('skips a <select multiple> with a typed unsupported-element result', () => {
    document.body.innerHTML = FIXTURES.selectMultiple;
    const select = document.getElementById('ms') as HTMLSelectElement;
    const result = executeFillPlan(plan([instruction('ms', 'MultiOption-Gamma', 'skills')]), [
      { fieldId: 'ms', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('unsupported-element');
    expect(result.report.filledCount).toBe(0);
  });

  it('leaves every existing selected option of a multi-select unchanged', () => {
    document.body.innerHTML = FIXTURES.selectMultiple;
    const select = document.getElementById('ms') as HTMLSelectElement;
    const before = Array.from(select.selectedOptions).map((o) => o.value);

    executeFillPlan(plan([instruction('ms', 'MultiOption-Alpha', 'skills')]), [
      { fieldId: 'ms', element: select },
    ]);

    const after = Array.from(select.selectedOptions).map((o) => o.value);
    expect(after).toEqual(before);
    expect(after).toEqual(['MultiOption-Alpha', 'MultiOption-Beta']);
    // The option that matched the planned value is NOT newly selected.
    expect((select.querySelector('option[value="MultiOption-Gamma"]') as HTMLOptionElement).selected).toBe(
      false,
    );
  });

  it('never exposes the planned answer or existing option values in the result', () => {
    document.body.innerHTML = FIXTURES.selectMultiple;
    const select = document.getElementById('ms') as HTMLSelectElement;
    const result = executeFillPlan(plan([instruction('ms', 'Planned-Answer-SECRET', 'skills')]), [
      { fieldId: 'ms', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    const json = JSON.stringify(result.report);
    expect(json).not.toContain('Planned-Answer-SECRET');
    expect(json).not.toContain('MultiOption-Alpha');
    expect(json).not.toContain('MultiOption-Beta');
    expect(json).not.toContain('MultiOption-Gamma');
  });

  it('still fills an ordinary single-select', () => {
    document.body.innerHTML = FIXTURES.selectPlaceholder;
    const select = document.getElementById('sp') as HTMLSelectElement;
    const result = executeFillPlan(plan([instruction('sp', 'Yes', 'sponsorship')]), [
      { fieldId: 'sp', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(select.selectedOptions.length).toBe(1);
    expect(select.value).toBe('yes');
  });
});

describe('radio group scoping', () => {
  it('only affects the question whose group was scanned', () => {
    document.body.innerHTML = FIXTURES.radioTwoQuestions;
    const sponsorFirst = document.querySelector('input[name="q_sponsor"]') as HTMLInputElement;
    const result = executeFillPlan(plan([instruction('r', 'Yes', 'sponsorship')]), [
      { fieldId: 'r', element: sponsorFirst },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(document.querySelectorAll('input[name="q_sponsor"]:checked').length).toBe(1);
    expect((document.querySelector('input[name="q_sponsor"]') as HTMLInputElement).checked).toBe(true);
    // The unrelated authorization question is untouched.
    expect(document.querySelectorAll('input[name="q_auth"]:checked').length).toBe(0);
  });
});

describe('checkbox state', () => {
  it('does not toggle an already-checked checkbox and reports no event', () => {
    document.body.innerHTML = FIXTURES.checkboxes;
    const yes = document.querySelector('input[name="c_yes"]') as HTMLInputElement;
    expect(yes.checked).toBe(true);
    const changed = vi.fn();
    yes.addEventListener('change', changed);
    const result = executeFillPlan(plan([instruction('c1', 'Yes', 'sponsorship')]), [
      { fieldId: 'c1', element: yes },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(yes.checked).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it('checks an unchecked matching checkbox exactly once', () => {
    document.body.innerHTML = FIXTURES.checkboxes;
    const no = document.querySelector('input[name="c_no"]') as HTMLInputElement;
    const changed = vi.fn();
    no.addEventListener('change', changed);
    const result = executeFillPlan(plan([instruction('c1', 'No', 'sponsorship')]), [
      { fieldId: 'c1', element: no },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(no.checked).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* Non-interactable gates                                              */
/* ------------------------------------------------------------------ */

describe('non-interactable fields are skipped', () => {
  it('skips disabled, read-only, hidden, inert and disconnected fields', () => {
    document.body.innerHTML = FIXTURES.gated;
    const disconnected = document.createElement('input');
    const targets: FillTarget[] = [
      { fieldId: 'dis', element: document.getElementById('dis') as Element },
      { fieldId: 'ro', element: document.getElementById('ro') as Element },
      { fieldId: 'hid', element: document.getElementById('hid') as Element },
      { fieldId: 'inert', element: document.getElementById('inert') as Element },
      { fieldId: 'gone', element: disconnected },
    ];
    const result = executeFillPlan(
      plan([
        instruction('dis', 'Ada'),
        instruction('ro', 'Ada'),
        instruction('hid', 'Ada'),
        instruction('inert', 'Ada'),
        instruction('gone', 'Ada'),
      ]),
      targets,
    );
    if (!result.ok) throw new Error('expected ok');
    const byStatus = Object.fromEntries(result.report.results.map((r) => [r.fieldId, r.status]));
    expect(byStatus).toEqual({
      dis: 'disabled',
      ro: 'read-only',
      hid: 'hidden',
      inert: 'disabled',
      gone: 'disconnected',
    });
    expect(result.report.filledCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* No submission / no value leaks                                      */
/* ------------------------------------------------------------------ */

describe('execution never submits and never leaks values', () => {
  it('does not submit the form or click Apply/Continue/Next', () => {
    document.body.innerHTML =
      '<form id="f"><input id="fn" type="text" />' +
      '<button id="apply" type="submit">Apply</button>' +
      '<button id="next" type="button">Next</button></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    const submit = vi.fn((e: Event) => e.preventDefault());
    const applyClick = vi.fn();
    const nextClick = vi.fn();
    form.addEventListener('submit', submit);
    (document.getElementById('apply') as Element).addEventListener('click', applyClick);
    (document.getElementById('next') as Element).addEventListener('click', nextClick);

    const result = executeFillPlan(plan([instruction('f1', 'Ada')]), [
      { fieldId: 'f1', element: document.getElementById('fn') as Element },
    ]);
    expect(result.ok).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(applyClick).not.toHaveBeenCalled();
    expect(nextClick).not.toHaveBeenCalled();
  });

  it('error/none-match results never contain the planned value', () => {
    document.body.innerHTML = '<input id="ro" type="text" readonly />';
    const result = executeFillPlan(
      plan([
        instruction('ro', 'Sensitive-Answer-XYZ'),
        instruction('missing', 'Sensitive-Answer-XYZ'),
      ]),
      [{ fieldId: 'ro', element: document.getElementById('ro') as Element }],
    );
    if (!result.ok) throw new Error('expected ok');
    const json = JSON.stringify(result.report);
    expect(json).not.toContain('Sensitive-Answer-XYZ');
  });
});
