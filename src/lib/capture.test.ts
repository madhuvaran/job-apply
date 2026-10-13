// @vitest-environment jsdom
/**
 * Tests for the capture module (src/lib/capture.ts) — Prompt 08 acceptance:
 * message-validation tests on both directions, extraction from static HTML
 * fixtures (JSON-LD and DOM-structured job pages), size limits/truncation,
 * exclusion of unrelated page content, and clean failure on pages with no
 * job content. No network, no real browser needed (jsdom parses fixtures).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_REQUEST_TYPE,
  captureCandidateSchema,
  captureRequestSchema,
  captureResponseSchema,
  extractJobCandidate,
  handleCaptureRequest,
  validateCaptureResponse,
  type CaptureResponse,
} from './capture';
import { MAX_RAW_DESCRIPTION_CHARS } from './job-posting';

// Fixtures live in src/lib/fixtures; resolve from the vitest root (project root).
const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'src', 'lib', 'fixtures', name), 'utf8');

const doc = (name: string): Document =>
  new DOMParser().parseFromString(fixture(name), 'text/html');

const URL_UNDER_TEST = 'https://boards.example.com/acme/jobs/123';

describe('message validation (popup <-> content script)', () => {
  it('accepts exactly our capture request; rejects everything else', () => {
    expect(captureRequestSchema.safeParse({ type: CAPTURE_REQUEST_TYPE }).success).toBe(true);
    for (const bad of [
      null,
      'capture',
      {},
      { type: 'other-extension-message' },
      { type: CAPTURE_REQUEST_TYPE, extra: true }, // strict
    ]) {
      expect(captureRequestSchema.safeParse(bad).success, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('valid response round-trips through validateCaptureResponse (defaults applied)', () => {
    const raw = {
      kind: 'ok',
      candidate: { url: URL_UNDER_TEST, title: 'Backend Engineer', descriptionText: '' },
    };
    const res = validateCaptureResponse(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.kind).toBe('ok');
      if (res.value.kind === 'ok') {
        expect(res.value.candidate.descriptionTruncated).toBe(false); // default filled
        expect(res.value.candidate.company).toBeUndefined(); // absent, not guessed
      }
    }
  });

  it('rejects malformed responses with readable, field-path errors', () => {
    const cases: unknown[] = [
      { kind: 'ok', candidate: { url: 'not a url', title: 'T' } },
      { kind: 'ok', candidate: { url: 'ftp://x.example.com', title: 'T' } }, // non-http(s)
      { kind: 'ok', candidate: { url: URL_UNDER_TEST, title: '' } },
      { kind: 'ok', candidate: { url: URL_UNDER_TEST, title: 'x'.repeat(500) } }, // too long
      { kind: 'ok', candidate: { url: URL_UNDER_TEST } }, // missing title
      { kind: 'ok' }, // missing candidate
      { kind: 'unknown-variant' },
      { kind: 'ok', candidate: { url: URL_UNDER_TEST, title: 'T', cookies: 'sid=1' } }, // strict
      'garbage',
    ];
    for (const bad of cases) {
      const res = validateCaptureResponse(bad);
      expect(res.ok, `should reject ${JSON.stringify(bad).slice(0, 80)}`).toBe(false);
      if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  it('error responses are validated too (fixed shape, capped message)', () => {
    const ok = validateCaptureResponse({
      kind: 'error',
      code: 'no-job-content',
      message: 'No job content found on this page.',
    });
    expect(ok.ok).toBe(true);
    expect(
      validateCaptureResponse({ kind: 'error', code: 'made-up', message: 'x' }).ok,
    ).toBe(false);
  });
});

describe('handleCaptureRequest (message-handling behavior)', () => {
  it('ignores messages that are not ours (returns undefined)', () => {
    expect(handleCaptureRequest({ type: 'other' }, doc('job-dom.html'), URL_UNDER_TEST)).toBeUndefined();
    expect(handleCaptureRequest('capture', doc('job-dom.html'), URL_UNDER_TEST)).toBeUndefined();
    expect(handleCaptureRequest(null, doc('job-dom.html'), URL_UNDER_TEST)).toBeUndefined();
  });

  it('returns a schema-valid ok response for a job page', () => {
    const res = handleCaptureRequest({ type: CAPTURE_REQUEST_TYPE }, doc('job-dom.html'), URL_UNDER_TEST);
    expect(res).toBeDefined();
    const parsed = captureResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    const validated = validateCaptureResponse(res);
    expect(validated.ok).toBe(true);
  });

  it('returns a fixed-literal error for pages without job content', () => {
    const res = handleCaptureRequest({ type: CAPTURE_REQUEST_TYPE }, doc('job-noise.html'), URL_UNDER_TEST);
    expect(res).toMatchObject({ kind: 'error', code: 'no-job-content' });
    if (res && res.kind === 'error') {
      expect(res.message).toBe(
        'No job content found on this page. Try a job listing page, or use manual intake.',
      );
      expect(res.message).not.toMatch(/NAV-NOISE|FOOTER-NOISE|Dashboard/); // no page content leaks
    }
  });
});

describe('extraction: JSON-LD job page fixture', () => {
  const outcome = extractJobCandidate(doc('job-jsonld.html'), URL_UNDER_TEST);

  it('reads title/company/location/description from JobPosting JSON-LD', () => {
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.title).toBe('Senior Backend Engineer');
    expect(outcome.candidate.company).toBe('Acme Corp');
    expect(outcome.candidate.location).toBe('Berlin, DE');
    expect(outcome.candidate.descriptionText).toContain('Join our platform team');
    expect(outcome.candidate.url).toBe(URL_UNDER_TEST);
    expect(captureCandidateSchema.safeParse(outcome.candidate).success).toBe(true);
  });

  it('does not collect unrelated page content (nav/footer/main chrome)', () => {
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    const text = outcome.candidate.descriptionText;
    expect(text).not.toContain('NAVIGATION-NOISE');
    expect(text).not.toContain('FOOTER-NOISE');
    expect(text).not.toContain('Page chrome text');
  });
});

describe('extraction: DOM-structured job page fixture (no JSON-LD)', () => {
  const outcome = extractJobCandidate(doc('job-dom.html'), URL_UNDER_TEST);

  it('falls back to h1 / company / location / description container', () => {
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.title).toBe('Frontend Engineer');
    expect(outcome.candidate.company).toBe('Globex');
    expect(outcome.candidate.location).toBe('Remote (EU)');
    expect(outcome.candidate.descriptionText).toContain('accessible interfaces in TypeScript');
    expect(outcome.candidate.descriptionText).toContain('3+ years of frontend experience');
    expect(outcome.candidate.descriptionTruncated).toBe(false);
  });

  it('description stays inside the job container — no nav/footer/aside text', () => {
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.candidate.descriptionText).not.toContain('RELATED-NOISE');
    expect(outcome.candidate.descriptionText).not.toContain('FOOTER-NOISE');
    expect(outcome.candidate.descriptionText).not.toContain('Home');
  });
});

describe('extraction: no-job-content and size limits', () => {
  it('fails cleanly on a page without job content', () => {
    expect(extractJobCandidate(doc('job-noise.html'), URL_UNDER_TEST)).toMatchObject({
      kind: 'error',
      code: 'no-job-content',
    });
  });

  it('truncates very long descriptions at the 100k cap and flags it', () => {
    const filler = 'Ship reliable software with the team and grow your skills. '.repeat(2400); // ~132k chars
    const html = `<html><head><title>Big Role</title></head><body><div class="job-description">${filler}</div></body></html>`;
    const d = new DOMParser().parseFromString(html, 'text/html');
    const outcome = extractJobCandidate(d, URL_UNDER_TEST);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.descriptionTruncated).toBe(true);
    expect(outcome.candidate.descriptionText.length).toBe(MAX_RAW_DESCRIPTION_CHARS);
  });

  it('fields are length-capped (never oversized messages cross the boundary)', () => {
    const longH1 = 'T'.repeat(400);
    const html = `<html><head><title>T</title></head><body><h1>${longH1}</h1><div class="job-description">${'Enough description text to pass the minimum length check used by the heuristic. '.repeat(2)}</div></body></html>`;
    const d = new DOMParser().parseFromString(html, 'text/html');
    const outcome = extractJobCandidate(d, URL_UNDER_TEST);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.title.length).toBeLessThanOrEqual(200);
  });

  it('a broken JSON-LD script does not break extraction (falls back to DOM)', () => {
    const html = `<html><head><title>Fallback Role</title><script type="application/ld+json">{ this is not json</script></head><body><div class="job-description">${'Real description content that is long enough to satisfy the minimum length check. '.repeat(2)}</div></body></html>`;
    const d = new DOMParser().parseFromString(html, 'text/html');
    const outcome = extractJobCandidate(d, URL_UNDER_TEST);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.title).toBe('Fallback Role');
    expect(outcome.candidate.descriptionText).toContain('Real description content');
  });
});

describe('never invents values', () => {
  it('company stays absent when the page states none (no domain guessing)', () => {
    const html = `<html><head><title>Solo Posting</title></head><body><div class="job-description">${'A posting with a description but no company markup at all, long enough for the heuristic to accept. '.repeat(2)}</div></body></html>`;
    const d = new DOMParser().parseFromString(html, 'text/html');
    const outcome = extractJobCandidate(d, 'https://solo.example.com/jobs/9');
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.company).toBeUndefined();
    expect(outcome.candidate.location).toBeUndefined();
  });
});

// Type-level sanity: helper returns the union we declared.
const _typeCheck: (r: CaptureResponse) => string = (r) => r.kind;
void _typeCheck;
