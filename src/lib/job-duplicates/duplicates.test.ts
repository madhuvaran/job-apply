/**
 * Unit tests for deterministic duplicate-job detection (Prompt 26).
 *
 * The module is PURE: it validates the candidate and every saved record with the
 * existing schemas, applies the documented rules in order (canonical URL →
 * external identifier within one source domain → normalized company + title),
 * never invents an identifier, never treats a malformed record as a match, never
 * mutates its input and never reads storage/clock/network/DOM/browser state.
 *
 * Fixtures are entirely fake — no personal data, no secrets, no real postings.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import {
  canonicalJobUrl,
  duplicateCheckSchema,
  findDuplicateJob,
  normalizeIdentity,
  sourceDomain,
  validateDuplicateCheck,
  MAX_DUPLICATE_MATCHES,
  type DuplicateCheckResult,
  type DuplicateCandidate,
} from '.';

const CAPTURED_AT = '2026-10-01T00:00:00.000Z';

function makeJob(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-a',
    title: 'Backend Engineer',
    company: 'Fake Co',
    rawDescription: 'Fake raw description.',
    source: 'manual',
    capturedAt: CAPTURED_AT,
    ...patch,
  });
}

function candidate(patch: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return { title: 'Backend Engineer', company: 'Fake Co', ...patch };
}

function find(input: {
  candidate: unknown;
  savedJobs: readonly unknown[];
  externalIds?: readonly unknown[];
}): DuplicateCheckResult {
  const outcome = findDuplicateJob(input);
  if (outcome.kind !== 'valid') throw new Error(`expected a valid result: ${outcome.issues.join('; ')}`);
  return outcome.result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Normalization (the only differences that may be ignored)            */
/* ------------------------------------------------------------------ */

describe('canonicalJobUrl / normalizeIdentity', () => {
  it('removes the fragment and folds safe, irrelevant URL differences', () => {
    expect(canonicalJobUrl('https://Example.COM/Jobs/1?x=1#apply')).toBe('https://example.com/Jobs/1?x=1');
    expect(canonicalJobUrl('https://www.example.com/jobs/1')).toBe('https://example.com/jobs/1');
    expect(canonicalJobUrl('https://example.com:443/jobs/1')).toBe('https://example.com/jobs/1');
    expect(canonicalJobUrl('https://example.com')).toBe('https://example.com/');
    expect(canonicalJobUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('preserves meaningful path and query differences', () => {
    expect(canonicalJobUrl('https://example.com/jobs/1')).not.toBe(canonicalJobUrl('https://example.com/jobs/2'));
    expect(canonicalJobUrl('https://example.com/jobs/1')).not.toBe(canonicalJobUrl('https://example.com/jobs/1/'));
    expect(canonicalJobUrl('https://example.com/jobs?id=1')).not.toBe(canonicalJobUrl('https://example.com/jobs?id=2'));
    // Order and duplicates are never stripped or reordered.
    expect(canonicalJobUrl('https://example.com/jobs?b=2&a=1')).toBe('https://example.com/jobs?b=2&a=1');
    // A scheme change is not treated as the same posting (conservative).
    expect(canonicalJobUrl('http://example.com/jobs/1')).not.toBe(canonicalJobUrl('https://example.com/jobs/1'));
  });

  it('rejects anything that is not a valid http(s) URL', () => {
    for (const bad of ['', 'not a url', 'javascript:alert(1)', 'ftp://example.com/jobs', 'example.com/jobs']) {
      expect(canonicalJobUrl(bad)).toBeUndefined();
    }
  });

  it('derives the source domain from the same canonical form', () => {
    expect(sourceDomain('https://WWW.Example.com/jobs/1')).toBe('example.com');
    expect(sourceDomain('javascript:alert(1)')).toBeUndefined();
  });

  it('normalizes identity with case and whitespace only', () => {
    expect(normalizeIdentity('  Senior   Backend  ENGINEER ')).toBe('senior backend engineer');
    // No punctuation stripping / stemming / fuzzing.
    expect(normalizeIdentity('Backend Engineer (Remote)')).toBe('backend engineer (remote)');
    expect(normalizeIdentity('Backend Engineer')).not.toBe(normalizeIdentity('Backend Engineers'));
  });
});

/* ------------------------------------------------------------------ */
/* Rule 1 — canonical URL                                              */
/* ------------------------------------------------------------------ */

describe('rule 1: canonical URL', () => {
  it('confirms the same posting captured with cosmetic URL differences', () => {
    const saved = makeJob({ id: 'job-saved', originalUrl: 'https://www.Example.com/jobs/1?src=x#top' });
    for (const url of [
      'https://example.com/jobs/1?src=x',
      'https://example.com/jobs/1?src=x#another',
      'https://example.com:443/jobs/1?src=x',
    ]) {
      const result = find({ candidate: candidate({ originalUrl: url }), savedJobs: [saved] });
      expect(result.duplicate).toBe(true);
      expect(result.status).toBe('confirmed');
      expect(result.method).toBe('canonical-url');
      expect(result.jobId).toBe('job-saved');
      expect(result.reasonCode).toBe('same-canonical-url');
      expect(result.matches).toHaveLength(1);
    }
  });

  it('never merges different paths, different queries or another scheme', () => {
    const saved = makeJob({ id: 'job-saved', originalUrl: 'https://example.com/jobs/1?id=1' });
    for (const url of [
      'https://example.com/jobs/2?id=1',
      'https://example.com/jobs/1?id=2',
      'https://example.com/jobs/1/',
      'http://example.com/jobs/1?id=1',
      'https://other.example.com/jobs/1?id=1',
    ]) {
      const result = find({
        candidate: candidate({ title: 'Something Else', company: 'Other Co', originalUrl: url }),
        savedJobs: [saved],
      });
      expect(result.duplicate).toBe(false);
      expect(result.reasonCode).toBe('no-reliable-match');
    }
  });

  it('reports ambiguity instead of choosing between several URL matches', () => {
    const result = find({
      candidate: candidate({ originalUrl: 'https://example.com/jobs/1' }),
      savedJobs: [
        makeJob({ id: 'job-b', title: 'Backend Engineer', originalUrl: 'https://example.com/jobs/1' }),
        makeJob({ id: 'job-a', title: 'Backend Engineer', originalUrl: 'https://example.com/jobs/1' }),
      ],
    });
    expect(result.status).toBe('ambiguous');
    expect(result.ambiguous).toBe(true);
    expect(result.duplicate).toBe(true);
    expect(result.jobId).toBeNull();
    expect(result.reasonCode).toBe('multiple-url-matches');
    expect(result.matches.map((m) => m.jobId)).toEqual(['job-a', 'job-b']);
    expect(result.matches.every((m) => m.method === 'canonical-url')).toBe(true);
  });

  it('ignores saved jobs without a URL when comparing URLs', () => {
    const result = find({
      candidate: candidate({ title: 'Different', company: 'Different Co', originalUrl: 'https://example.com/jobs/1' }),
      savedJobs: [makeJob({ id: 'job-nourl' })],
    });
    expect(result.duplicate).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 2 — external identifier, same source domain only               */
/* ------------------------------------------------------------------ */

describe('rule 2: explicit external identifier', () => {
  const saved = makeJob({ id: 'job-saved', originalUrl: 'https://boards.example.com/job/1' });

  it('confirms the same identifier from the same source domain', () => {
    const result = find({
      candidate: candidate({ title: 'Different title', company: 'Different Co', originalUrl: 'https://boards.example.com/job/2', externalId: 'EXT-1' }),
      savedJobs: [saved],
      externalIds: [{ jobId: 'job-saved', domain: 'boards.example.com', externalId: 'EXT-1' }],
    });
    expect(result.status).toBe('confirmed');
    expect(result.method).toBe('external-id');
    expect(result.jobId).toBe('job-saved');
    expect(result.reasonCode).toBe('same-external-id');
  });

  it('never matches the same identifier from another domain', () => {
    // Same identifier text, different source domain: two different sites' jobs
    // must never merge (the company/title differ too, so nothing else matches).
    const result = find({
      candidate: candidate({ title: 'Different title', company: 'Different Co', originalUrl: 'https://other.example.com/job/2', externalId: 'EXT-1' }),
      savedJobs: [saved],
      externalIds: [{ jobId: 'job-saved', domain: 'boards.example.com', externalId: 'EXT-1' }],
    });
    expect(result.duplicate).toBe(false);
    expect(result.reasonCode).toBe('no-reliable-match');

    // The inverse direction is also scoped by the candidate's own domain.
    const reverse = find({
      candidate: candidate({ title: 'Different title', company: 'Different Co', originalUrl: 'https://boards.example.com/job/2', externalId: 'EXT-1' }),
      savedJobs: [makeJob({ id: 'job-other', originalUrl: 'https://other.example.com/job/1' })],
      externalIds: [{ jobId: 'job-other', domain: 'other.example.com', externalId: 'EXT-1' }],
    });
    expect(reverse.duplicate).toBe(false);
  });

  it('never trusts an identifier whose record has no source domain', () => {
    const result = find({
      candidate: candidate({ title: 'Different title', company: 'Different Co', originalUrl: 'https://boards.example.com/job/2', externalId: 'EXT-1' }),
      savedJobs: [makeJob({ id: 'job-nourl' })],
      externalIds: [{ jobId: 'job-nourl', domain: 'boards.example.com', externalId: 'EXT-1' }],
    });
    expect(result.duplicate).toBe(false);
    expect(result.notes.join(' ')).toContain('identifiers could not be trusted');
  });

  it('compares identifiers exactly (case and surrounding whitespace normalized only)', () => {
    const identity = { title: 'Different title', company: 'Different Co' };
    const lower = find({
      candidate: candidate({ ...identity, originalUrl: 'https://boards.example.com/job/2', externalId: 'ext-1' }),
      savedJobs: [saved],
      externalIds: [{ jobId: 'job-saved', domain: 'boards.example.com', externalId: 'EXT-1' }],
    });
    expect(lower.duplicate).toBe(false); // ids are case-sensitive

    const padded = find({
      candidate: candidate({ ...identity, originalUrl: 'https://boards.example.com/job/2', externalId: ' EXT-1 ' }),
      savedJobs: [saved],
      externalIds: [{ jobId: 'job-saved', domain: 'boards.example.com', externalId: 'EXT-1' }],
    });
    expect(padded.duplicate).toBe(true); // surrounding whitespace is trimmed
    expect(padded.method).toBe('external-id');
  });

  it('notes that an identifier without a URL cannot be scoped', () => {
    const result = find({
      candidate: candidate({ title: 'Only An Id', company: 'Somewhere Co', externalId: 'EXT-9' }),
      savedJobs: [saved],
      externalIds: [{ jobId: 'job-saved', domain: 'boards.example.com', externalId: 'EXT-9' }],
    });
    expect(result.duplicate).toBe(false);
    expect(result.notes.join(' ')).toContain('no URL');
  });

  it('reports ambiguity instead of choosing between several identifier matches', () => {
    const result = find({
      candidate: candidate({ title: 'Different title', company: 'Different Co', originalUrl: 'https://boards.example.com/job/2', externalId: 'EXT-1' }),
      savedJobs: [
        makeJob({ id: 'job-x', originalUrl: 'https://boards.example.com/job/x' }),
        makeJob({ id: 'job-y', originalUrl: 'https://boards.example.com/job/y' }),
      ],
      externalIds: [
        { jobId: 'job-y', domain: 'boards.example.com', externalId: 'EXT-1' },
        { jobId: 'job-x', domain: 'boards.example.com', externalId: 'EXT-1' },
      ],
    });
    expect(result.status).toBe('ambiguous');
    expect(result.jobId).toBeNull();
    expect(result.reasonCode).toBe('multiple-external-id-matches');
    expect(result.matches.map((m) => m.jobId)).toEqual(['job-x', 'job-y']);
  });

  it('prefers the URL rule over the identifier rule', () => {
    const result = find({
      candidate: candidate({ originalUrl: 'https://boards.example.com/job/1', externalId: 'EXT-1' }),
      savedJobs: [saved],
      externalIds: [{ jobId: 'job-saved', domain: 'boards.example.com', externalId: 'EXT-1' }],
    });
    expect(result.method).toBe('canonical-url');
    expect(result.reasonCode).toBe('same-canonical-url');
  });
});

/* ------------------------------------------------------------------ */
/* Rule 3 — normalized company + title (weak, review-only)             */
/* ------------------------------------------------------------------ */

describe('rule 3: normalized company and title', () => {
  it('reports a POSSIBLE duplicate for case/whitespace-only differences', () => {
    const result = find({
      candidate: candidate({ title: '  backend   ENGINEER ', company: ' FAKE co ' }),
      savedJobs: [makeJob({ id: 'job-saved' })],
    });
    expect(result.status).toBe('possible');
    expect(result.duplicate).toBe(true);
    expect(result.method).toBe('company-title');
    expect(result.jobId).toBe('job-saved');
    expect(result.reasonCode).toBe('same-company-and-title');
    expect(result.explanation).toContain('same company and title');
  });

  it('does not match a different title, a different company or a missing company', () => {
    const saved = [makeJob({ id: 'job-saved' })];
    expect(find({ candidate: candidate({ title: 'Backend Engineer II' }), savedJobs: saved }).duplicate).toBe(false);
    expect(find({ candidate: candidate({ company: 'Other Co' }), savedJobs: saved }).duplicate).toBe(false);
    expect(find({ candidate: { title: 'Backend Engineer' }, savedJobs: saved }).duplicate).toBe(false);
    expect(find({ candidate: candidate(), savedJobs: [makeJob({ id: 'job-nocompany', company: undefined })] }).duplicate).toBe(false);
  });

  it('never uses an identity shorter than the documented minimum', () => {
    const result = find({ candidate: candidate({ title: 'a', company: 'b' }), savedJobs: [makeJob({ title: 'a', company: 'b' })] });
    expect(result.duplicate).toBe(false);
    expect(result.reasonCode).toBe('no-usable-identity');
  });

  it('lists every match and stays ambiguous when several saved jobs share company + title', () => {
    const result = find({
      candidate: candidate(),
      savedJobs: [makeJob({ id: 'job-z' }), makeJob({ id: 'job-a' })],
    });
    expect(result.status).toBe('possible');
    expect(result.ambiguous).toBe(true);
    expect(result.jobId).toBeNull();
    expect(result.matches.map((m) => m.jobId)).toEqual(['job-a', 'job-z']);
  });

  it('is only a fallback: a URL match wins', () => {
    const result = find({
      candidate: candidate({ originalUrl: 'https://example.com/jobs/1' }),
      savedJobs: [makeJob({ id: 'job-saved', originalUrl: 'https://example.com/jobs/1' })],
    });
    expect(result.method).toBe('canonical-url');
    expect(result.status).toBe('confirmed');
  });
});

/* ------------------------------------------------------------------ */
/* No identity / malformed input                                       */
/* ------------------------------------------------------------------ */

describe('no usable identity and malformed records', () => {
  it('reports no duplicate and says why when there is nothing to compare', () => {
    const result = find({ candidate: { title: 'Solo Title' }, savedJobs: [makeJob()] });
    expect(result.duplicate).toBe(false);
    expect(result.status).toBe('none');
    expect(result.method).toBeNull();
    expect(result.jobId).toBeNull();
    expect(result.matches).toEqual([]);
    expect(result.reasonCode).toBe('no-usable-identity');
  });

  it('reports no duplicate when a usable identity simply does not match', () => {
    const result = find({
      candidate: candidate({ title: 'Data Engineer', company: 'Other Co', originalUrl: 'https://other.example.com/1' }),
      savedJobs: [makeJob()],
    });
    expect(result.duplicate).toBe(false);
    expect(result.reasonCode).toBe('no-reliable-match');
    expect(result.inspectedJobs).toBe(1);
  });

  it('skips malformed saved records instead of trusting them', () => {
    const result = find({
      candidate: candidate(),
      savedJobs: [
        makeJob({ id: 'job-ok' }),
        { title: '', company: 'Fake Co' }, // invalid: empty title
        { nothing: true },
        { ...makeJob({ id: 'job-badurl' }), originalUrl: 'javascript:alert(1)' },
      ],
    });
    expect(result.inspectedJobs).toBe(1);
    expect(result.skippedJobs).toBe(3);
    expect(result.notes.join(' ')).toContain('Some saved jobs could not be read');
    expect(result.jobId).toBe('job-ok');
  });

  it('fails with a typed invalid outcome for an unusable candidate', () => {
    for (const bad of [{}, { title: '' }, { title: 'x', originalUrl: 'javascript:alert(1)' }, { title: 'x', extra: true }]) {
      const outcome = findDuplicateJob({ candidate: bad, savedJobs: [] });
      expect(outcome.kind).toBe('invalid');
      if (outcome.kind === 'invalid') {
        expect(outcome.issues.length).toBeGreaterThan(0);
        expect(outcome.issues[0]!.startsWith('candidate')).toBe(true);
      }
    }
  });

  it('never quotes the candidate content in diagnostics', () => {
    const result = find({
      candidate: { title: 'CandidateOnlyTitle', company: 'CandidateOnlyCompany' },
      savedJobs: [makeJob()],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('CandidateOnlyTitle');
    expect(serialized).not.toContain('CandidateOnlyCompany');
  });
});

/* ------------------------------------------------------------------ */
/* Contract, determinism and purity                                    */
/* ------------------------------------------------------------------ */

describe('result contract, determinism and purity', () => {
  function input() {
    return {
      candidate: candidate({ originalUrl: 'https://example.com/jobs/1', externalId: 'EXT-1' }),
      savedJobs: [
        makeJob({ id: 'job-b', originalUrl: 'https://example.com/jobs/1' }),
        makeJob({ id: 'job-a', originalUrl: 'https://example.com/jobs/1' }),
        makeJob({ id: 'job-c', title: 'Backend Engineer', company: 'Fake Co' }),
      ],
      externalIds: [{ jobId: 'job-c', domain: 'example.com', externalId: 'EXT-1' }],
    };
  }

  it('produces a result that satisfies its own strict schema', () => {
    const result = find(input());
    expect(duplicateCheckSchema.safeParse(result).success).toBe(true);
    expect(validateDuplicateCheck(result).ok).toBe(true);
    expect(result.schemaVersion).toBe('1');
  });

  it('rejects unexpected properties and malformed results', () => {
    const result = find(input());
    expect(validateDuplicateCheck({ ...result, winner: 'job-a' }).ok).toBe(false);
    expect(validateDuplicateCheck({ ...result, status: 'maybe' }).ok).toBe(false);
    expect(
      validateDuplicateCheck({
        ...result,
        matches: result.matches.map((m) => ({ ...m, extra: 1 })),
      }).ok,
    ).toBe(false);
    expect(validateDuplicateCheck({ groups: [] }).ok).toBe(false);
    expect(MAX_DUPLICATE_MATCHES).toBeGreaterThan(0);
  });

  it('reports issues as paths/codes only (never values)', () => {
    const validation = validateDuplicateCheck({ duplicate: 'yes', secret: 'CandidateOnlyTitle' });
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.issues.join(' ')).not.toContain('CandidateOnlyTitle');
  });

  it('is deterministic and input-order independent', () => {
    const first = find(input());
    const second = find(input());
    expect(second).toEqual(first);
    // Reversing every input list cannot change the outcome.
    const reversedInput = input();
    const reversed = find({
      candidate: reversedInput.candidate,
      savedJobs: [...reversedInput.savedJobs].reverse(),
      externalIds: [...reversedInput.externalIds].reverse(),
    });
    expect(reversed).toEqual(first);
  });

  it('does not mutate deeply frozen inputs', () => {
    const frozen = deepFreeze(input());
    const fingerprint = JSON.stringify(frozen);
    expect(() => findDuplicateJob(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(fingerprint);
  });

  it('does not read the clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      const first = find(input());
      vi.setSystemTime(new Date('2031-07-04T23:59:59.000Z'));
      expect(find(input())).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes no network call', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    findDuplicateJob(input());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never links the pure module to storage, the AI layer, the clock, the DOM or browser APIs', () => {
    // The service wrapper is the ONLY place storage may be touched.
    for (const file of ['duplicates.ts', 'schemas.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
      for (const statement of imports) {
        expect(statement).not.toMatch(/from '.*\/(storage|ai)['"]/);
      }
      expect(source).not.toMatch(/Date\.now\(|new Date\(/);
      expect(source).not.toMatch(/\bdocument\.|\bwindow\.|chrome\.|browser\./);
    }
  });
});
