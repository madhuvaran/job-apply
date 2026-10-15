/**
 * Tests for the JobPosting model (src/lib/job-posting.ts) — Prompt 07
 * acceptance: minimal postings, malformed URLs, long/noisy descriptions,
 * missing optional fields, unknown-value preservation, and the deterministic
 * section extractor. Storage persistence lives in storage.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createJobPosting,
  extractJobSections,
  jobPostingSchema,
  jobPostingsRecordSchema,
  MAX_LIST_ITEMS,
  MAX_RAW_DESCRIPTION_CHARS,
  postingUrlSchema,
  upsertPostingInList,
  validateJobPostingInput,
  validatePostingDraft,
  type JobPosting,
} from './job-posting';
import { postedDateFieldValue } from './job-dates';

const CAPTURED_AT = '2026-10-13T10:00:00.000Z';

const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'job-1',
  title: 'Backend Engineer',
  rawDescription: 'Build and maintain APIs.',
  capturedAt: CAPTURED_AT,
  ...over,
});

const parse = (over: Record<string, unknown> = {}): JobPosting =>
  jobPostingSchema.parse(minimal(over));

describe('minimal postings and missing optional fields', () => {
  it('a minimal posting (title + raw + timestamps) is valid with all defaults', () => {
    const p = parse();
    expect(p.title).toBe('Backend Engineer');
    expect(p.schemaVersion).toBe('1');
    expect(p.source).toBe('manual');
    // Everything unknown stays ABSENT — never invented:
    expect(p.company).toBeUndefined();
    expect(p.location).toBeUndefined();
    expect(p.originalUrl).toBeUndefined();
    expect(p.workArrangement).toBeUndefined();
    expect(p.employmentType).toBeUndefined();
    expect(p.experienceRange).toBeUndefined();
    expect(p.compensation).toBeUndefined();
    expect(p.responsibilities).toEqual([]);
    expect(p.requiredQualifications).toEqual([]);
    expect(p.preferredQualifications).toEqual([]);
    expect(p.skills).toEqual([]);
    expect(p.updatedAt).toBeUndefined();
  });

  it('required fields are enforced (missing title/description/capturedAt/id)', () => {
    expect(jobPostingSchema.safeParse({ ...minimal(), title: '' }).success).toBe(false);
    expect(jobPostingSchema.safeParse({ id: 'x', title: 'T', capturedAt: CAPTURED_AT }).success).toBe(false);
    expect(jobPostingSchema.safeParse({ id: 'x', title: 'T', rawDescription: 'd', capturedAt: CAPTURED_AT, }).success).toBe(true);
    expect(jobPostingSchema.safeParse({ ...minimal(), capturedAt: 'yesterday' }).success).toBe(false);
    expect(jobPostingSchema.safeParse({ ...minimal(), id: '' }).success).toBe(false);
  });

  it('whitespace-only description is rejected (raw must contain content)', () => {
    expect(jobPostingSchema.safeParse(minimal({ rawDescription: '   \n\t  ' })).success).toBe(false);
  });

  it('unknown extra keys are rejected (strict schema)', () => {
    expect(jobPostingSchema.safeParse(minimal({ cookies: 'session=abc' })).success).toBe(false);
  });
});

describe('URL validation (malformed URLs)', () => {
  it('rejects malformed and non-http(s) URLs', () => {
    for (const bad of ['not a url', 'example.com/jobs/1', 'htp://x.com', 'ftp://files.example.com', 'javascript:alert(1)', '']) {
      expect(postingUrlSchema.safeParse(bad).success, `should reject: ${bad}`).toBe(false);
    }
    expect(jobPostingSchema.safeParse(minimal({ originalUrl: 'not a url' })).success).toBe(false);
    expect(jobPostingSchema.safeParse(minimal({ originalUrl: 'ftp://files.example.com' })).success).toBe(false);
  });

  it('accepts valid http/https URLs and preserves them', () => {
    expect(jobPostingSchema.safeParse(minimal({ originalUrl: 'https://example.com/jobs/123?ref=abc' })).success).toBe(true);
    expect(parse({ originalUrl: 'http://boards.example.org/x' }).originalUrl).toBe(
      'http://boards.example.org/x',
    );
  });

  it('rejects URLs beyond the size limit', () => {
    const long = `https://example.com/${'a'.repeat(3000)}`;
    expect(postingUrlSchema.safeParse(long).success).toBe(false);
  });
});

describe('size limits and long/noisy descriptions', () => {
  it('accepts a noisy description VERBATIM (round-trips byte-for-byte)', () => {
    const noisy =
      '  Sr. Engineer – Résumé?\r\n\r\n\r\n\tWeird \u0000-free\u2028text • bullets ― dashes\n'.repeat(50);
    const p = parse({ rawDescription: noisy });
    expect(p.rawDescription).toBe(noisy); // preserved, not trimmed/normalized
    expect(noisy.length).toBeLessThan(MAX_RAW_DESCRIPTION_CHARS);
  });

  it('rejects a description over 100k chars', () => {
    const long = 'x'.repeat(MAX_RAW_DESCRIPTION_CHARS + 1);
    expect(jobPostingSchema.safeParse(minimal({ rawDescription: long })).success).toBe(false);
    expect(
      jobPostingSchema.safeParse(minimal({ rawDescription: 'x'.repeat(MAX_RAW_DESCRIPTION_CHARS) }))
        .success,
    ).toBe(true);
  });

  it('list fields are capped (item count and per-item length)', () => {
    const many = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `item ${i}`);
    expect(jobPostingSchema.safeParse(minimal({ skills: many })).success).toBe(false);
    expect(
      jobPostingSchema.safeParse(minimal({ responsibilities: ['y'.repeat(1001)] })).success,
    ).toBe(false);
    expect(jobPostingSchema.safeParse(minimal({ responsibilities: [''] })).success).toBe(false);
  });
});

describe('unknown values are never coerced (enums and ranges stay strict)', () => {
  it('unknown work arrangement / employment type values are rejected, not guessed', () => {
    expect(jobPostingSchema.safeParse(minimal({ workArrangement: 'remote-ish' })).success).toBe(false);
    expect(jobPostingSchema.safeParse(minimal({ employmentType: 'gig' })).success).toBe(false);
    expect(parse({ workArrangement: 'hybrid' }).workArrangement).toBe('hybrid');
  });

  it('experience range uses the shared validated range (min<=max, 0..50)', () => {
    expect(jobPostingSchema.safeParse(minimal({ experienceRange: { minYears: 8, maxYears: 3 } })).success).toBe(false);
    expect(jobPostingSchema.safeParse(minimal({ experienceRange: { minYears: -1 } })).success).toBe(false);
    expect(jobPostingSchema.safeParse(minimal({ experienceRange: {} })).success).toBe(false);
    expect(parse({ experienceRange: { minYears: 3, maxYears: 5 } }).experienceRange).toEqual({
      minYears: 3,
      maxYears: 5,
    });
  });

  it('compensation is verbatim and only stored when provided', () => {
    expect(parse({ compensation: '$120k–$150k USD / year' }).compensation).toBe('$120k–$150k USD / year');
    expect(parse().compensation).toBeUndefined();
    expect(jobPostingSchema.safeParse(minimal({ compensation: '' })).success).toBe(false);
  });
});

describe('postedDate (published posting date, optional)', () => {
  it('defaults to ABSENT — never derived from capturedAt/updatedAt', () => {
    const p = parse();
    expect(p.postedDate).toBeUndefined();
    expect('postedDate' in p).toBe(false);
  });

  it('accepts a real calendar date, including a leap day', () => {
    expect(parse({ postedDate: '2026-10-01' }).postedDate).toBe('2026-10-01');
    expect(parse({ postedDate: '2024-02-29' }).postedDate).toBe('2024-02-29');
  });

  it('rejects impossible dates, timestamps, prose and wrong shapes', () => {
    for (const bad of [
      '2026-02-31',
      '2023-02-29',
      '2026-13-01',
      '2026-10-01T00:00:00Z',
      '2026-2-3',
      '3 days ago',
      'October 1, 2026',
      '',
      '2026-10-01T00:00:00Z',
    ]) {
      expect(jobPostingSchema.safeParse(minimal({ postedDate: bad })).success, bad).toBe(false);
    }
  });

  it('keeps the schema strict: an unknown date-ish property is rejected', () => {
    expect(jobPostingSchema.safeParse(minimal({ postedDate: '2026-10-01', datePosted: '2026-10-01' })).success).toBe(
      false,
    );
    expect(jobPostingSchema.safeParse(minimal({ postedAt: '2026-10-01' })).success).toBe(false);
  });

  it('createJobPosting carries an explicit date and never invents one', () => {
    const withDate = createJobPosting(
      { title: 'Dated', rawDescription: 'd', postedDate: '2026-10-01' },
      () => CAPTURED_AT,
      () => 'fixed',
    );
    expect(withDate.postedDate).toBe('2026-10-01');
    const without = createJobPosting(
      { title: 'Undated', rawDescription: 'd' },
      () => CAPTURED_AT,
      () => 'fixed-2',
    );
    expect(without.postedDate).toBeUndefined();
  });

  it('a cleared date field maps to absent (not to the capture time)', () => {
    const cleared = createJobPosting(
      {
        title: 'Cleared',
        rawDescription: 'd',
        postedDate: postedDateFieldValue(''),
      },
      () => CAPTURED_AT,
      () => 'fixed-3',
    );
    expect(cleared.postedDate).toBeUndefined();
    expect(cleared.capturedAt).toBe(CAPTURED_AT); // provenance is separate
    // What actually gets serialized for storage has no date key at all.
    expect(JSON.parse(JSON.stringify(cleared))).not.toHaveProperty('postedDate');
  });
});

describe('validatePostingDraft (create/edit form drafts)', () => {
  const draft = {
    title: 'Backend Engineer',
    rawDescription: 'Build and maintain APIs.',
    responsibilities: [],
    requiredQualifications: [],
    preferredQualifications: [],
    skills: [],
  };

  it('validates a NEW draft without generating id/capturedAt errors', () => {
    // Regression: validating the raw draft reported missing `id`/`capturedAt`,
    // so the Options → Jobs create form could never save.
    expect(validatePostingDraft(draft)).toEqual([]);
    expect(validateJobPostingInput(draft).length).toBeGreaterThan(0);
  });

  it('keeps an edit’s own identity and reports a bad postedDate with its field path', () => {
    expect(
      validatePostingDraft({ ...draft, id: 'job-7', capturedAt: CAPTURED_AT, postedDate: '2026-10-01' }),
    ).toEqual([]);
    const issues = validatePostingDraft({ ...draft, postedDate: '2026-02-31' });
    expect(issues.join(' ')).toMatch(/postedDate/);
  });
});

describe('source and capture timestamp', () => {
  it('defaults to manual source; page-capture accepted explicitly', () => {
    expect(parse().source).toBe('manual');
    expect(parse({ source: 'page-capture' }).source).toBe('page-capture');
    expect(jobPostingSchema.safeParse(minimal({ source: 'scraper' })).success).toBe(false);
  });

  it('createJobPosting fills id and capturedAt without inventing content', () => {
    const p = createJobPosting(
      { title: 'Data Engineer', rawDescription: 'Pipelines.', source: 'manual' },
      () => CAPTURED_AT,
      () => 'fixed-id',
    );
    expect(p.id).toBe('fixed-id');
    expect(p.capturedAt).toBe(CAPTURED_AT);
    expect(p.company).toBeUndefined();
    expect(jobPostingSchema.safeParse(p).success).toBe(true);
  });
});

describe('extractJobSections (deterministic, conservative)', () => {
  const description = [
    'Senior Frontend Engineer',
    'Acme Corp — Berlin / Remote',
    '',
    'Responsibilities:',
    '- Build React components',
    '- Ship features with the team',
    '• Review code',
    '',
    'Requirements:',
    '5 years of experience with TypeScript',
    '1. Degree or equivalent experience',
    '',
    'Nice to have:',
    '+ Experience with testing',
    '',
    'Skills:',
    'React, TypeScript, Node.js',
    'GraphQL',
    '',
    'Something unknown: this line belongs to no section',
    'Compensation: 80k-100k EUR',
  ].join('\n');

  it('files lines under recognized headings and strips bullet markers', () => {
    const out = extractJobSections(description);
    expect(out.responsibilities).toEqual([
      'Build React components',
      'Ship features with the team',
      'Review code',
    ]);
    expect(out.requiredQualifications).toEqual([
      '5 years of experience with TypeScript',
      'Degree or equivalent experience',
    ]);
    expect(out.preferredQualifications).toEqual(['Experience with testing']);
    expect(out.skills).toEqual(['React', 'TypeScript', 'Node.js', 'GraphQL']);
  });

  it('never invents: text outside recognized headings stays out of every bucket', () => {
    const out = extractJobSections(description);
    const all = Object.values(out).flat().join('\n');
    expect(all).not.toContain('Something unknown');
    expect(all).not.toContain('80k-100k');
    expect(all).not.toContain('Senior Frontend Engineer');
  });

  it('stops a bucket at an unknown short "Heading:" line', () => {
    const text = ['Requirements:', '- A skill', 'Benefits:', '- Lots of pizza', '- Remote'].join('\n');
    const out = extractJobSections(text);
    expect(out.requiredQualifications).toEqual(['A skill']);
    expect(out.responsibilities).toEqual([]);
  });

  it('is robust to noisy input: empty text, CRLF, no headings, over-long lines', () => {
    expect(extractJobSections('')).toEqual({
      responsibilities: [],
      requiredQualifications: [],
      preferredQualifications: [],
      skills: [],
    });
    const crlf = 'Requirements:\r\n- item one\r\n\r\n- item two\r\n';
    expect(extractJobSections(crlf).requiredQualifications).toEqual(['item one', 'item two']);
    // No recognized headings at all -> nothing extracted (raw keeps it all).
    expect(extractJobSections('We are a great company. Join us!\nAmazing stuff.').responsibilities).toEqual([]);
    const noisy = `Requirements:\n${'a'.repeat(2000)}`;
    expect(extractJobSections(noisy).requiredQualifications).toEqual([]); // over-long line skipped
    const many = ['Requirements:', ...Array.from({ length: 200 }, (_, i) => `- skill ${i}`)].join('\n');
    expect(extractJobSections(many).requiredQualifications.length).toBeLessThanOrEqual(MAX_LIST_ITEMS);
  });

  it('is pure: output arrays are new objects, input untouched', () => {
    const text = 'Skills:\n- React';
    const a = extractJobSections(text);
    a.skills.push('mutated');
    expect(extractJobSections(text).skills).toEqual(['React']);
  });
});

describe('upsertPostingInList + record schema', () => {
  const p = (id: string, title: string): JobPosting => createJobPosting(
    { title, rawDescription: 'd', source: 'manual' },
    () => CAPTURED_AT,
    () => id,
  );

  it('prepends new postings and replaces existing by id (keeps list size stable)', () => {
    const a = p('1', 'A');
    const b = p('2', 'B');
    let list = upsertPostingInList([], a);
    list = upsertPostingInList(list, b);
    expect(list.map((x) => x.id)).toEqual(['2', '1']);
    const b2 = { ...b, title: 'B edited' };
    list = upsertPostingInList(list, b2);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(b2);
    expect(list[1]).toEqual(a);
  });

  it('record schema defaults to an empty list and validates round-trip', () => {
    const empty = jobPostingsRecordSchema.parse({});
    expect(empty).toEqual({ schemaVersion: '1', postings: [] });
    const rec = jobPostingsRecordSchema.parse({ postings: [p('1', 'A')] });
    expect(jobPostingsRecordSchema.parse(rec)).toEqual(rec);
    expect(jobPostingsRecordSchema.safeParse({ postings: [{ junk: 1 }] }).success).toBe(false);
  });
});

/**
 * Prompt 29 extends the model with descriptionKind / externalId / provider and a
 * widened source enum. The extension MUST be backward compatible: records stored
 * by earlier prompts keep parsing, keep their meaning, and gain no invented data.
 */
describe('import provenance fields (Prompt 29) are backward compatible', () => {
  /** Exactly what an earlier prompt would have written (no new keys). */
  const preTwentyNineRecord = {
    id: 'job-old',
    schemaVersion: '1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Pune',
    originalUrl: 'https://example.com/jobs/old',
    rawDescription: 'Build and maintain APIs.',
    capturedAt: CAPTURED_AT,
    source: 'page-capture',
  };

  it('parses an old record unchanged and describes it as a full description', () => {
    const parsed = jobPostingSchema.parse(preTwentyNineRecord);
    expect(parsed.descriptionKind).toBe('full');
    expect(parsed.source).toBe('page-capture');
    expect(parsed.externalId).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
    // Nothing else about the record changes.
    expect(parsed.title).toBe('Backend Engineer');
    expect(parsed.rawDescription).toBe('Build and maintain APIs.');
    expect(parsed.originalUrl).toBe('https://example.com/jobs/old');
    expect(parsed.capturedAt).toBe(CAPTURED_AT);
  });

  it('upgrades a whole stored record without rewriting or dropping entries', () => {
    const upgraded = jobPostingsRecordSchema.parse({
      schemaVersion: '1',
      postings: [preTwentyNineRecord, minimal({ id: 'job-new' })],
    });
    expect(upgraded.postings).toHaveLength(2);
    expect(upgraded.postings.map((posting) => posting.descriptionKind)).toEqual(['full', 'full']);
    // Stable: re-reading the upgraded record changes nothing further.
    expect(jobPostingsRecordSchema.parse(upgraded)).toEqual(upgraded);
  });

  it('accepts the new provenance values and still refuses unknown ones', () => {
    expect(parse({ source: 'provider-search' }).source).toBe('provider-search');
    expect(jobPostingSchema.safeParse(minimal({ source: 'scraper' })).success).toBe(false);
    expect(parse({ descriptionKind: 'snippet' }).descriptionKind).toBe('snippet');
    expect(jobPostingSchema.safeParse(minimal({ descriptionKind: 'partial' })).success).toBe(false);
  });

  it('accepts a source-published external id and provider, rejecting empty or over-long values', () => {
    const parsed = parse({ externalId: 'job-42', provider: 'adzuna' });
    expect(parsed.externalId).toBe('job-42');
    expect(parsed.provider).toBe('adzuna');

    for (const bad of [{ externalId: '  ' }, { externalId: 'x'.repeat(101) }]) {
      expect(jobPostingSchema.safeParse(minimal(bad)).success).toBe(false);
    }
    for (const bad of [{ provider: ' ' }, { provider: 'x'.repeat(61) }]) {
      expect(jobPostingSchema.safeParse(minimal(bad)).success).toBe(false);
    }
    // Strict: no unknown keys ride along with the new ones.
    expect(jobPostingSchema.safeParse(minimal({ externalIdExtra: 'x' })).success).toBe(false);
  });

  it('keeps an unknown provider untouched (never mapped to a guessed name)', () => {
    const parsed = parse();
    expect('provider' in parsed).toBe(false);
    expect('externalId' in parsed).toBe(false);
  });
});
