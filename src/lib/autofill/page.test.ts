// @vitest-environment jsdom
/**
 * Page scanning + session tests (Prompt 14) — jsdom, synthetic DOM only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOFILL_FILL_REQUEST_TYPE,
  AUTOFILL_SCAN_REQUEST_TYPE,
  collectFieldDescriptors,
  createAutofillSession,
  validateFillResponse,
  validateScanResponse,
} from './page';
import { MAX_SCAN_FIELDS } from './schemas';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('collectFieldDescriptors', () => {
  it('collects value-free descriptors with labels and attributes', () => {
    document.body.innerHTML = `
      <form>
        <label for="fn">First name</label><input id="fn" name="firstName" autocomplete="given-name" />
        <textarea id="sum" name="summary" aria-label="Professional summary"></textarea>
        <select id="ctry" name="country"></select>
      </form>`;
    const { descriptors } = collectFieldDescriptors(document);
    expect(descriptors.map((d) => d.kind)).toEqual(['text', 'textarea', 'select']);
    expect(descriptors[0]).toMatchObject({
      fieldId: 'af-0',
      labelText: 'First name',
      name: 'firstName',
      elementId: 'fn',
      autocomplete: 'given-name',
    });
    expect(descriptors[1]?.labelText).toBe('Professional summary');
    expect(descriptors[2]?.name).toBe('country');
  });

  it('NEVER reads or includes a value', () => {
    document.body.innerHTML = '<label for="fn">First name</label><input id="fn" value="PREFILLED-SECRET" />';
    const { descriptors } = collectFieldDescriptors(document);
    expect(JSON.stringify(descriptors)).not.toContain('PREFILLED-SECRET');
  });

  it('skips hidden/submit/button/image/reset inputs', () => {
    document.body.innerHTML = `
      <input type="hidden" name="csrf" />
      <input type="submit" value="Go" />
      <input type="button" value="Go" />
      <input type="image" />
      <input type="reset" />
      <input type="text" name="keep" />`;
    const { descriptors } = collectFieldDescriptors(document);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.name).toBe('keep');
  });

  it('groups radios in the same group into ONE descriptor', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Will you require sponsorship?</legend>
        <label><input type="radio" name="sponsor" value="yes" /> Yes</label>
        <label><input type="radio" name="sponsor" value="no" /> No</label>
      </fieldset>`;
    const { descriptors } = collectFieldDescriptors(document);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ kind: 'radio', labelText: 'Will you require sponsorship?' });
  });

  it('caps the number of descriptors', () => {
    document.body.innerHTML = Array.from({ length: MAX_SCAN_FIELDS + 20 }, (_v, i) => `<input name="f${i}" />`).join('');
    const { descriptors } = collectFieldDescriptors(document);
    expect(descriptors).toHaveLength(MAX_SCAN_FIELDS);
  });
});

describe('createAutofillSession', () => {
  it('returns undefined for messages that are not ours', () => {
    const session = createAutofillSession(document);
    expect(session.handle({ type: 'some-other-message' })).toBeUndefined();
    expect(session.handle(null)).toBeUndefined();
    expect(session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE, extra: true })).toBeUndefined();
  });

  it('reports no-fields for an empty page', () => {
    const session = createAutofillSession(document);
    const response = session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
    expect(response).toMatchObject({ kind: 'error', code: 'no-fields' });
  });

  it('scans then fills only after a fill request, using the scanned elements', () => {
    document.body.innerHTML = '<label for="fn">First name</label><input id="fn" name="firstName" />';
    const session = createAutofillSession(document);

    const scan = session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
    expect(validateScanResponse(scan).ok).toBe(true);
    if (scan === undefined || scan.kind !== 'ok' || !('descriptors' in scan)) throw new Error('expected scan ok');
    expect(scan.descriptors[0]?.fieldId).toBe('af-0');

    const fill = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      plan: {
        schemaVersion: '1',
        instructions: [
          { fieldId: 'af-0', category: 'firstName', value: 'Ada', source: 'sensitive', requiresConfirmation: true },
        ],
      },
    });
    expect(validateFillResponse(fill).ok).toBe(true);
    if (fill === undefined || fill.kind !== 'ok' || !('report' in fill)) throw new Error('expected fill ok');
    expect(fill.report.filledCount).toBe(1);
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('Ada');
  });

  it('rejects an invalid plan without touching the page', () => {
    document.body.innerHTML = '<input id="fn" />';
    const session = createAutofillSession(document);
    session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
    const response = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      plan: { schemaVersion: '1', instructions: [{ fieldId: 'af-0' }] },
    });
    // The strict request schema rejects the malformed plan outright.
    expect(response).toBeUndefined();
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });

  it('validators reject junk responses', () => {
    expect(validateScanResponse({ kind: 'ok', descriptors: [{ fieldId: 'x' }] }).ok).toBe(false);
    expect(validateFillResponse({ kind: 'ok', report: { results: [] } }).ok).toBe(false);
  });
});
