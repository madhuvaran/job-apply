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
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_REQUEST_TYPE,
  captureCandidateSchema,
  captureRequestSchema,
  captureResponseSchema,
  extractJobCandidate,
  handleCaptureRequest,
  POSTING_DATE_CONFLICT_NOTICE,
  readPostedDateMicrodata,
  resolvePostedDate,
  validateCaptureResponse,
  type CaptureResponse,
} from './capture';
import { extractIsoCalendarDate, postedDateFieldValue } from './job-dates';
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

  it('reads the published posting date from JSON-LD datePosted', () => {
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.candidate.postedDate).toBe('2026-10-01');
    expect(outcome.candidate.postedDateNotice).toBeUndefined();
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

/* ------------------------------------------------------------------ */
/* Posting date capture (Prompt 23)                                    */
/* ------------------------------------------------------------------ */

const LONG_DESCRIPTION =
  '<div id="job-description">You will build and ship features with the team, review code every day, and keep improving the product. This text is deliberately long enough to satisfy the capture heuristic.</div>';

/** A dated job page: `head` carries structured data, the body a description. */
const datedPage = (head: string): Document =>
  new DOMParser().parseFromString(
    `<html><head><title>Dated Role</title>${head}</head><body>${LONG_DESCRIPTION}</body></html>`,
    'text/html',
  );

const jsonLdPage = (datePosted: unknown): Document =>
  datedPage(
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      headline: 'Dated Role',
      datePosted,
    })}</script>`,
  );

const postedDateOf = (page: Document): string | undefined => {
  const outcome = extractJobCandidate(page, URL_UNDER_TEST);
  if (outcome.kind !== 'ok') throw new Error('expected ok');
  return outcome.candidate.postedDate;
};

const noticeOf = (page: Document): string | undefined => {
  const outcome = extractJobCandidate(page, URL_UNDER_TEST);
  if (outcome.kind !== 'ok') throw new Error('expected ok');
  return outcome.candidate.postedDateNotice;
};

describe('posting date: explicit sources', () => {
  it('reads JSON-LD datePosted as a calendar date (date-only and date-time)', () => {
    expect(postedDateOf(jsonLdPage('2026-10-01'))).toBe('2026-10-01');
    expect(postedDateOf(jsonLdPage('2026-10-01T08:15:00Z'))).toBe('2026-10-01');
    expect(postedDateOf(jsonLdPage('2026-10-01T23:30:00.000+02:00'))).toBe('2026-10-01');
    expect(postedDateOf(jsonLdPage('2024-02-29'))).toBe('2024-02-29'); // leap day
  });

  it('reads itemprop="datePosted" microdata (datetime/content, strict ISO text)', () => {
    expect(postedDateOf(datedPage('<time itemprop="datePosted" datetime="2026-09-15">3 weeks ago</time>'))).toBe(
      '2026-09-15',
    );
    expect(postedDateOf(datedPage('<meta itemprop="datePosted" content="2026-09-15" />'))).toBe('2026-09-15');
    expect(postedDateOf(datedPage('<span itemprop="datePosted">2026-09-16</span>'))).toBe('2026-09-16');
    // itemprop is matched case-insensitively (real-world markup varies).
    expect(postedDateOf(datedPage('<span itemprop="dateposted">2026-09-17</span>'))).toBe('2026-09-17');
  });

  it('uses the same single date from both sources without a notice', () => {
    const page = datedPage(
      '<meta itemprop="datePosted" content="2026-10-01" />' +
        '<script type="application/ld+json">{"@type":"JobPosting","headline":"Dated Role","datePosted":"2026-10-01T00:00:00Z"}</script>',
    );
    expect(postedDateOf(page)).toBe('2026-10-01');
    expect(noticeOf(page)).toBeUndefined();
  });

  it('leaves malformed, impossible, relative and non-string datePosted values absent', () => {
    for (const value of ['3 days ago', 'yesterday', '2026-02-31', '2026-13-01', 'October 1, 2026', '', 12345, null]) {
      const page = jsonLdPage(value);
      expect(postedDateOf(page), String(value)).toBeUndefined();
      expect(noticeOf(page), String(value)).toBeUndefined();
    }
    // Prose in a machine-readable-looking element is still rejected.
    expect(postedDateOf(datedPage('<time itemprop="datePosted">Posted last week</time>'))).toBeUndefined();
  });

  it('reports a conflict between explicit sources instead of picking one', () => {
    const page = datedPage(
      '<meta itemprop="datePosted" content="2026-10-05" />' +
        '<script type="application/ld+json">{"@type":"JobPosting","headline":"Dated Role","datePosted":"2026-10-01"}</script>',
    );
    expect(postedDateOf(page)).toBeUndefined();
    expect(noticeOf(page)).toBe(POSTING_DATE_CONFLICT_NOTICE);
    // The notice is a fixed literal — no page content, no chosen winner.
    expect(noticeOf(page)).not.toMatch(/2026-10-0/);
  });

  it('reports a conflict between two microdata elements too', () => {
    const page = datedPage(
      '<meta itemprop="datePosted" content="2026-10-01" /><span itemprop="datePosted">2026-10-09</span>',
    );
    expect(postedDateOf(page)).toBeUndefined();
    expect(noticeOf(page)).toBe(POSTING_DATE_CONFLICT_NOTICE);
  });
});

describe('posting date: narrow scanning only', () => {
  it('never reads dates from page prose, nav, footer or the description', () => {
    const page = new DOMParser().parseFromString(
      `<html><head><title>Dated Role</title></head><body>
        <nav>Posted 2020-01-01 · Updated 2019-05-05</nav>
        <div id="job-description">
          <p>Apply now. Posted on 2026-10-01 and refreshed 2026-10-02.</p>
          ${LONG_DESCRIPTION}
        </div>
        <footer>Last indexed 2018-08-08</footer>
      </body></html>`,
      'text/html',
    );
    expect(postedDateOf(page)).toBeUndefined();
    expect(noticeOf(page)).toBeUndefined();
  });

  it('readPostedDateMicrodata reads only itemprop=datePosted elements', () => {
    const page = new DOMParser().parseFromString(
      `<html><body>
        <span itemprop="datePosted" datetime="2026-09-15"></span>
        <span itemprop="dateModified">2026-09-16</span>
        <time datetime="2026-09-17"></time>
        <p>2026-09-18</p>
      </body></html>`,
      'text/html',
    );
    expect(readPostedDateMicrodata(page)).toEqual(['2026-09-15']);
  });

  it('resolvePostedDate is pure, dedupes and never picks between distinct dates', () => {
    expect(resolvePostedDate([])).toEqual({});
    expect(resolvePostedDate([undefined, ''])).toEqual({});
    expect(resolvePostedDate(['2026-10-01', '2026-10-01T00:00:00Z'])).toEqual({
      postedDate: '2026-10-01',
    });
    expect(resolvePostedDate(['2026-10-01', '2026-10-02'])).toEqual({
      postedDateNotice: POSTING_DATE_CONFLICT_NOTICE,
    });
    // Invalid values are ignored (they are not competing dates).
    expect(resolvePostedDate(['3 days ago', '2026-10-01'])).toEqual({ postedDate: '2026-10-01' });
  });
});

describe('posting date: boundary validation + preview correction', () => {
  it('keeps the candidate schema strict about the date field', () => {
    const base = { url: URL_UNDER_TEST, title: 'Dated Role' };
    expect(captureCandidateSchema.safeParse({ ...base, postedDate: '2026-10-01' }).success).toBe(true);
    expect(
      captureCandidateSchema.safeParse({ ...base, postedDateNotice: POSTING_DATE_CONFLICT_NOTICE }).success,
    ).toBe(true);
    for (const bad of ['2026-10-01T00:00:00Z', '2026-2-3', '2026-02-31', '3 days ago', '']) {
      expect(captureCandidateSchema.safeParse({ ...base, postedDate: bad }).success, bad).toBe(false);
    }
    // Strict: an unexpected property is still rejected.
    expect(captureCandidateSchema.safeParse({ ...base, postedDate: '2026-10-01', date: 'x' }).success).toBe(
      false,
    );
  });

  it('validates both directions of the message boundary with the date included', () => {
    const response = handleCaptureRequest(
      { type: CAPTURE_REQUEST_TYPE },
      jsonLdPage('2026-10-01'),
      URL_UNDER_TEST,
    );
    expect(captureResponseSchema.safeParse(response).success).toBe(true);
    const validated = validateCaptureResponse(response);
    expect(validated.ok).toBe(true);
    if (validated.ok && validated.value.kind === 'ok') {
      expect(validated.value.candidate.postedDate).toBe('2026-10-01');
    }
    // A tampered response with a non-ISO date is rejected (strict on both sides).
    expect(
      validateCaptureResponse({
        kind: 'ok',
        candidate: { url: URL_UNDER_TEST, title: 'T', postedDate: '3 days ago' },
      }).ok,
    ).toBe(false);
  });

  it('maps a corrected date through and a cleared date to ABSENT (never the capture time)', () => {
    // The preview starts from the captured value…
    const captured = extractJobCandidate(jsonLdPage('2026-10-01'), URL_UNDER_TEST);
    if (captured.kind !== 'ok') throw new Error('expected ok');
    expect(captured.candidate.postedDate).toBe('2026-10-01');
    // …the user corrects or clears it, and the form value is what the schema sees.
    expect(postedDateFieldValue('2026-10-05')).toBe('2026-10-05'); // corrected
    expect(postedDateFieldValue('')).toBeUndefined(); // cleared
    const saved = captureCandidateSchema.parse({
      url: URL_UNDER_TEST,
      title: 'Dated Role',
      postedDate: postedDateFieldValue(''),
    });
    expect(saved.postedDate).toBeUndefined(); // absent, not back-filled
    expect(JSON.parse(JSON.stringify(saved))).not.toHaveProperty('postedDate');
  });

  it('makes no network call and reads no unrelated page text while capturing dates', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const page = datedPage(
        '<meta itemprop="datePosted" content="2026-10-01" /><nav>NAV-NOISE 2026-10-09</nav>',
      );
      expect(postedDateOf(page)).toBe('2026-10-01');
      const response = handleCaptureRequest({ type: CAPTURE_REQUEST_TYPE }, page, URL_UNDER_TEST);
      expect(JSON.stringify(response)).not.toContain('NAV-NOISE');
      expect(extractIsoCalendarDate('2026-10-01')).toBe('2026-10-01');
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Type-level sanity: helper returns the union we declared.
const _typeCheck: (r: CaptureResponse) => string = (r) => r.kind;
void _typeCheck;
