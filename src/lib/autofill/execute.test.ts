// @vitest-environment jsdom
/**
 * Executor tests (Prompt 14) — jsdom, synthetic DOM only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeFillPlan, type FillTarget } from './execute';
import type { FillInstruction } from './schemas';

function instruction(fieldId: string, value: string, category: FillInstruction['category'] = 'firstName'): FillInstruction {
  return { fieldId, category, value, source: 'sensitive', requiresConfirmation: true };
}

function plan(instructions: FillInstruction[]): unknown {
  return { schemaVersion: '1', instructions };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('executeFillPlan — text controls', () => {
  it('fills a text input via the native setter and fires input + change', () => {
    document.body.innerHTML = '<input id="fn" type="text" />';
    const input = document.getElementById('fn') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));

    const result = executeFillPlan(plan([instruction('f1', 'Ada')]), [{ fieldId: 'f1', element: input }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(input.value).toBe('Ada');
    expect(events).toEqual(['input', 'change']);
    expect(result.report.filledCount).toBe(1);
    expect(result.report.skippedCount).toBe(0);
  });

  it('fills a textarea as well', () => {
    document.body.innerHTML = '<textarea id="sum"></textarea>';
    const area = document.getElementById('sum') as HTMLTextAreaElement;
    const result = executeFillPlan(plan([instruction('f1', 'A summary.', 'summary')]), [
      { fieldId: 'f1', element: area },
    ]);
    expect(result.ok && result.report.results[0]?.status).toBe('filled');
    expect(area.value).toBe('A summary.');
  });
});

describe('executeFillPlan — safety gates', () => {
  it('does not execute an invalid plan', () => {
    document.body.innerHTML = '<input id="fn" type="text" />';
    const input = document.getElementById('fn') as HTMLInputElement;
    const bad = executeFillPlan({ schemaVersion: '1', instructions: [{ fieldId: 'f1' }] }, [
      { fieldId: 'f1', element: input },
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid-plan');
    expect(input.value).toBe('');
  });

  it('skips disabled, read-only, hidden and disconnected elements', () => {
    document.body.innerHTML =
      '<input id="dis" type="text" disabled /><input id="ro" type="text" readonly />' +
      '<input id="hid" type="text" style="display:none" />';
    const disconnected = document.createElement('input');
    const targets: FillTarget[] = [
      { fieldId: 'dis', element: document.getElementById('dis') as Element },
      { fieldId: 'ro', element: document.getElementById('ro') as Element },
      { fieldId: 'hid', element: document.getElementById('hid') as Element },
      { fieldId: 'gone', element: disconnected },
    ];
    const result = executeFillPlan(
      plan([
        instruction('dis', 'Ada'),
        instruction('ro', 'Ada'),
        instruction('hid', 'Ada'),
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
      gone: 'disconnected',
    });
    expect(result.report.filledCount).toBe(0);
    // not-found for a fieldId with no target.
    const notFound = executeFillPlan(plan([instruction('missing', 'Ada')]), targets);
    if (!notFound.ok) throw new Error('expected ok');
    expect(notFound.report.results[0]?.status).toBe('not-found');
  });

  it('reports unsupported element types without touching them', () => {
    document.body.innerHTML = '<div id="ce">contenteditable</div>';
    const div = document.getElementById('ce') as Element;
    const result = executeFillPlan(plan([instruction('x', 'Ada')]), [{ fieldId: 'x', element: div }]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('unsupported-element');
  });

  it('only touches fields listed in the plan', () => {
    document.body.innerHTML = '<input id="a" type="text" /><input id="b" type="text" />';
    const a = document.getElementById('a') as HTMLInputElement;
    const b = document.getElementById('b') as HTMLInputElement;
    executeFillPlan(plan([instruction('a', 'Ada')]), [
      { fieldId: 'a', element: a },
      { fieldId: 'b', element: b },
    ]);
    expect(a.value).toBe('Ada');
    expect(b.value).toBe('');
  });
});

describe('executeFillPlan — choice controls require unambiguous matches', () => {
  it('selects the single matching option and fires change', () => {
    document.body.innerHTML =
      '<select id="s"><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select>';
    const select = document.getElementById('s') as HTMLSelectElement;
    const changed = vi.fn();
    select.addEventListener('change', changed);
    const result = executeFillPlan(plan([instruction('s', 'Yes', 'sponsorship')]), [
      { fieldId: 's', element: select },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(select.value).toBe('yes');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('skips an ambiguous or absent select option', () => {
    document.body.innerHTML =
      '<select id="s"><option value="a">Yes</option><option value="b">Yes</option></select>' +
      '<select id="t"><option value="">Choose…</option><option value="no">No</option></select>';
    const ambiguous = document.getElementById('s') as HTMLSelectElement;
    const absent = document.getElementById('t') as HTMLSelectElement;
    const result = executeFillPlan(
      plan([instruction('s', 'Yes', 'sponsorship'), instruction('t', 'Yes', 'sponsorship')]),
      [
        { fieldId: 's', element: ambiguous },
        { fieldId: 't', element: absent },
      ],
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results.map((r) => r.status)).toEqual(['no-match', 'no-match']);
    expect(ambiguous.value).toBe('a');
    expect(absent.value).toBe('');
  });

  it('checks exactly one matching radio in a group', () => {
    document.body.innerHTML =
      '<label><input type="radio" name="q" value="yes"> Yes</label>' +
      '<label><input type="radio" name="q" value="no"> No</label>';
    const first = document.querySelector('input[type="radio"]') as HTMLInputElement;
    const yes = first;
    const result = executeFillPlan(plan([instruction('r', 'Yes', 'sponsorship')]), [
      { fieldId: 'r', element: first },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('filled');
    expect(yes.checked).toBe(true);
  });

  it('does not guess when two radios share the planned label', () => {
    document.body.innerHTML =
      '<label><input type="radio" name="q" value="a"> Yes</label>' +
      '<label><input type="radio" name="q" value="b"> Yes</label>';
    const first = document.querySelector('input[type="radio"]') as HTMLInputElement;
    const result = executeFillPlan(plan([instruction('r', 'Yes', 'sponsorship')]), [
      { fieldId: 'r', element: first },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results[0]?.status).toBe('no-match');
    expect(document.querySelectorAll('input[type="radio"]:checked').length).toBe(0);
  });

  it('checks a matching checkbox and skips a non-matching one', () => {
    document.body.innerHTML =
      '<label><input type="checkbox" name="c1" value="yes"> Yes</label>' +
      '<label><input type="checkbox" name="c2" value="no"> No</label>';
    const yes = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const no = document.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement;
    const result = executeFillPlan(
      plan([instruction('c1', 'Yes', 'sponsorship'), instruction('c2', 'Yes', 'sponsorship')]),
      [
        { fieldId: 'c1', element: yes },
        { fieldId: 'c2', element: no },
      ],
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.results.map((r) => r.status)).toEqual(['filled', 'no-match']);
    expect(yes.checked).toBe(true);
    expect(no.checked).toBe(false);
  });
});

describe('executeFillPlan — never submits or navigates', () => {
  it('does not submit the form or click buttons', () => {
    document.body.innerHTML =
      '<form id="f"><input id="fn" type="text" /><button id="submit" type="submit">Apply</button></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    const button = document.getElementById('submit') as HTMLButtonElement;
    const submitSpy = vi.fn((e: Event) => e.preventDefault());
    const clickSpy = vi.fn();
    form.addEventListener('submit', submitSpy);
    button.addEventListener('click', clickSpy);

    const result = executeFillPlan(plan([instruction('f1', 'Ada')]), [
      { fieldId: 'f1', element: document.getElementById('fn') as Element },
    ]);
    expect(result.ok).toBe(true);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('per-field messages never contain the planned value', () => {
    document.body.innerHTML = '<input id="fn" type="text" />';
    const result = executeFillPlan(
      plan([instruction('a', 'Ada-Lovelace-SECRET'), instruction('missing', 'Ada-Lovelace-SECRET')]),
      [{ fieldId: 'a', element: document.getElementById('fn') as Element }],
    );
    if (!result.ok) throw new Error('expected ok');
    for (const r of result.report.results) {
      expect(r.message).not.toContain('Ada-Lovelace-SECRET');
    }
  });
});
