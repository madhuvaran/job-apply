// @vitest-environment jsdom
/**
 * Session-safety tests (Prompt 15) — jsdom, synthetic DOM only.
 *
 * A fill plan is bound to the scan that produced it via a per-scan token. A
 * stale, missing or tampered token is rejected with a typed error and NO
 * writes; scanned element references are never silently re-resolved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOFILL_FILL_REQUEST_TYPE,
  AUTOFILL_SCAN_REQUEST_TYPE,
  createAutofillSession,
  validateFillResponse,
  validateScanResponse,
  type AutofillSession,
} from './page';

function scan(session: AutofillSession): { scanId: string; fieldIds: string[] } {
  const response = session.handle({ type: AUTOFILL_SCAN_REQUEST_TYPE });
  const parsed = validateScanResponse(response);
  if (!parsed.ok || parsed.value.kind !== 'ok') throw new Error('expected scan ok');
  return { scanId: parsed.value.scanId, fieldIds: parsed.value.descriptors.map((d) => d.fieldId) };
}

function fill(
  session: AutofillSession,
  scanId: string | undefined,
  fieldId: string,
  value = 'Ada',
): unknown {
  return session.handle({
    type: AUTOFILL_FILL_REQUEST_TYPE,
    ...(scanId === undefined ? {} : { scanId }),
    plan: {
      schemaVersion: '1',
      instructions: [
        { fieldId, category: 'firstName', value, source: 'sensitive', requiresConfirmation: true },
      ],
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('scan/fill session binding', () => {
  it('mints a scanId and fills only when the fill echoes it', () => {
    document.body.innerHTML = '<label for="fn">First name</label><input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const { scanId, fieldIds } = scan(session);
    expect(scanId.length).toBeGreaterThan(0);

    const response = fill(session, scanId, fieldIds[0] as string);
    const parsed = validateFillResponse(response);
    if (!parsed.ok || parsed.value.kind !== 'ok') throw new Error('expected fill ok');
    expect(parsed.value.report.filledCount).toBe(1);
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('Ada');
  });

  it('rejects a stale scanId after a re-scan without any writes', () => {
    document.body.innerHTML = '<label for="fn">First name</label><input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const first = scan(session);
    scan(session); // a second scan invalidates the first token

    const input = document.getElementById('fn') as HTMLInputElement;
    const response = fill(session, first.scanId, first.fieldIds[0] as string);
    expect(response).toMatchObject({ kind: 'error', code: 'stale-session' });
    expect(input.value).toBe('');
  });

  it('rejects a fill that presents an unknown scanId', () => {
    document.body.innerHTML = '<input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const { fieldIds } = scan(session);
    const response = fill(session, 'not-the-current-token', fieldIds[0] as string);
    expect(response).toMatchObject({ kind: 'error', code: 'stale-session' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });

  it('rejects a fill with no scanId at all (malformed payload)', () => {
    document.body.innerHTML = '<input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const { fieldIds } = scan(session);
    const response = fill(session, undefined, fieldIds[0] as string);
    expect(response).toMatchObject({ kind: 'error', code: 'invalid-plan' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });

  it('rejects a tampered fill payload carrying extra properties', () => {
    document.body.innerHTML = '<input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const { scanId, fieldIds } = scan(session);
    const response = session.handle({
      type: AUTOFILL_FILL_REQUEST_TYPE,
      scanId,
      plan: {
        schemaVersion: '1',
        instructions: [
          {
            fieldId: fieldIds[0],
            category: 'firstName',
            value: 'Ada',
            source: 'sensitive',
            requiresConfirmation: true,
          },
        ],
      },
      extra: 'tampered',
    });
    expect(response).toMatchObject({ kind: 'error', code: 'invalid-plan' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });

  it('rejects a fill before any scan', () => {
    document.body.innerHTML = '<input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const response = fill(session, 'anything', 'af-0');
    expect(response).toMatchObject({ kind: 'error', code: 'stale-session' });
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });

  it('a cancel (no fill message) performs no writes', () => {
    document.body.innerHTML = '<input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    scan(session);
    // Cancelling means the popup never sends a fill request.
    expect((document.getElementById('fn') as HTMLInputElement).value).toBe('');
  });

  it('returns undefined for messages that are not ours', () => {
    const session = createAutofillSession(document);
    expect(session.handle({ type: 'job-apply/other' })).toBeUndefined();
    expect(session.handle(null)).toBeUndefined();
    expect(session.handle(42)).toBeUndefined();
  });
});

describe('page changes after scanning', () => {
  it('keeps scanned element identity when the form structure changes', () => {
    document.body.innerHTML = '<label for="a">First name</label><input id="a" name="firstName" />';
    const session = createAutofillSession(document);
    const { scanId, fieldIds } = scan(session);
    const scanned = document.getElementById('a') as HTMLInputElement;

    // Insert a new field at the top; a naive re-scan would shift fieldId→element.
    const prepended = document.createElement('input');
    prepended.id = 'b';
    prepended.name = 'lastName';
    document.body.prepend(prepended);

    const response = fill(session, scanId, fieldIds[0] as string);
    if (!validateFillResponse(response).ok) throw new Error('expected fill ok');
    expect(scanned.value).toBe('Ada');
    expect(prepended.value).toBe('');
  });

  it('does not fill an element replaced between scan and fill', () => {
    document.body.innerHTML = '<label for="fn">First name</label><input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const { scanId, fieldIds } = scan(session);

    document.getElementById('fn')?.remove();
    const replacement = document.createElement('input');
    replacement.id = 'fn';
    replacement.name = 'firstName';
    replacement.value = 'REPLACEMENT-EXISTING-VALUE';
    document.body.appendChild(replacement);

    const response = fill(session, scanId, fieldIds[0] as string);
    const parsed = validateFillResponse(response);
    if (!parsed.ok || parsed.value.kind !== 'ok') throw new Error('expected fill ok');
    expect(parsed.value.report.filledCount).toBe(0);
    expect(parsed.value.report.results[0]?.status).toBe('disconnected');
    expect(replacement.value).toBe('REPLACEMENT-EXISTING-VALUE');
  });

  it('error responses never contain a planned value', () => {
    document.body.innerHTML = '<input id="fn" name="firstName" />';
    const session = createAutofillSession(document);
    const { fieldIds } = scan(session);
    const response = fill(session, 'stale-token', fieldIds[0] as string, 'Sensitive-Value-XYZ');
    expect(JSON.stringify(response)).not.toContain('Sensitive-Value-XYZ');
  });
});
