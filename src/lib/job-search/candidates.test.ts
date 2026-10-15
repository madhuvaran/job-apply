/**
 * Import candidate tests (Prompt 29).
 *
 * Pure: no React, no DOM, no storage, no network. Provider fixtures are
 * SYNTHETIC values parsed through Prompt 27's real normalized-result schema and
 * exist only in this file — they are never rendered as UI results anywhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { normalizeAdzunaSearchResponse } from './adzuna/normalize';
import { adzunaSearchRequestSchema } from './adzuna/schemas';
import {
  buildImportCandidate,
  candidateFromNormalizedJob,
  EMPTY_JOB_IMPORT_FORM,
  identityForDuplicateCheck,
  importCandidateSchema,
  providerSalaryText,
  resetJobImportForm,
  toJobPosting,
  validateJobImportForm,
  type JobImportForm,
} from './candidates';
import { JOB_SEARCH_PROVIDERS, normalizedJobResultSchema, type NormalizedJobResult } from './schemas';
import { duplicateCandidateSchema } from '../job-duplicates/schemas';
import { jobPostingSchema } from '../job-posting';

const ADZUNA_ID = 'adzuna';

function form(patch: Partial<JobImportForm> = {}): JobImportForm {
  return {
    ...resetJobImportForm(),
    title: 'Backend Engineer',
    description: 'Build services with the team.',
    descriptionKind: 'full',
    ...patch,
  };
}

/** Synthetic provider result (test-only fixture, validated by the real schema). */
function providerJob(patch: Partial<NormalizedJobResult> = {}): NormalizedJobResult {
  return normalizedJobResultSchema.parse({
    provider: 'adzuna',
    externalId: 'provider-job-42',
    title: 'Platform Engineer',
    url: 'https://www.adzuna.in/details/provider-job-42',
    country: 'in',
    postedDate: '2026-10-02',
    company: 'Fixture Co',
    location: 'Bengaluru',
    description: 'A short provider excerpt.',
    salary: { min: 900000, max: 1400000, predicted: false },
    ...patch,
  });
}

/* ------------------------------------------------------------------ */
/* Manual import: validation                                            */
/* ------------------------------------------------------------------ */

describe('valid manual imports', () => {
  it('accepts a minimal title + description and defaults honestly', () => {
    const built = buildImportCandidate(form());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.candidate).toEqual({
      title: 'Backend Engineer',
      rawDescription: 'Build services with the team.',
      descriptionKind: 'full',
      source: 'manual',
    });
    // Nothing optional is invented.
    expect('company' in built.candidate).toBe(false);
    expect('location' in built.candidate).toBe(false);
    expect('originalUrl' in built.candidate).toBe(false);
    expect('externalId' in built.candidate).toBe(false);
    expect('provider' in built.candidate).toBe(false);
    expect('postedDate' in built.candidate).toBe(false);
    expect('compensation' in built.candidate).toBe(false);
  });

  it('keeps every optional field the user supplied', () => {
    const built = buildImportCandidate(
      form({
        company: 'Example Ltd',
        location: 'Pune',
        url: 'https://example.com/jobs/1',
        description: 'An excerpt only.',
        descriptionKind: 'snippet',
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.candidate).toMatchObject({
      company: 'Example Ltd',
      location: 'Pune',
      originalUrl: 'https://example.com/jobs/1',
      descriptionKind: 'snippet',
      source: 'manual',
    });
  });

  it('preserves the description VERBATIM (no trimming or normalizing)', () => {
    const built = buildImportCandidate(form({ description: '  leading and trailing  \n' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.candidate.rawDescription).toBe('  leading and trailing  \n');
  });

  it('trims only the derived fields', () => {
    const built = buildImportCandidate(form({ title: '  Backend Engineer  ', company: '  Acme  ' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.candidate.title).toBe('Backend Engineer');
    expect(built.candidate.company).toBe('Acme');
  });
});

describe('invalid manual imports are rejected with typed issues', () => {
  const expectIssue = (patch: Partial<JobImportForm>, field: string): void => {
    const result = validateJobImportForm(form(patch));
    expect(result.some((i) => i.field === field)).toBe(true);
    const built = buildImportCandidate(form(patch));
    expect(built.ok).toBe(false);
  };

  it('requires a title', () => {
    expectIssue({ title: '   ' }, 'title');
  });

  it('requires a description or excerpt', () => {
    expectIssue({ description: '   ' }, 'rawDescription');
    expectIssue({ description: '' }, 'rawDescription');
  });

  it('requires the user to state whether the text is complete or partial', () => {
    expectIssue({ descriptionKind: '' }, 'descriptionKind');
  });

  it('rejects an over-long title, company and description', () => {
    expectIssue({ title: 'x'.repeat(201) }, 'title');
    expectIssue({ company: 'x'.repeat(201) }, 'company');
    expectIssue({ location: 'x'.repeat(201) }, 'location');
    expectIssue({ description: 'x'.repeat(100_001) }, 'rawDescription');
  });

  it('never echoes the offending value back', () => {
    const value = 'javascript:alert("secret-value-12345")';
    const issues = validateJobImportForm(form({ url: value }));
    expect(issues.map((i) => i.message).join(' ')).not.toContain('secret-value-12345');
  });
});

/* ------------------------------------------------------------------ */
/* URL safety                                                           */
/* ------------------------------------------------------------------ */

describe('unsafe URLs are rejected (and never fetched)', () => {
  const unsafe = [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'ftp://example.com/job',
    'chrome://settings',
    '//example.com/jobs/1',
    'not-a-url',
    'JAVASCRIPT:alert(1)',
  ];

  it.each(unsafe)('rejects %s', (url) => {
    const built = buildImportCandidate(form({ url }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.some((i) => i.field === 'originalUrl')).toBe(true);
  });

  it('accepts http and https listing URLs only', () => {
    for (const url of [
      'https://example.com/jobs/1',
      'http://example.com/jobs/1',
      'HTTPS://EXAMPLE.COM/jobs/1',
    ]) {
      const built = buildImportCandidate(form({ url }));
      expect(built.ok, url).toBe(true);
    }
  });

  it('accepts a blank URL (optional field)', () => {
    const built = buildImportCandidate(form({ url: '   ' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect('originalUrl' in built.candidate).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Snippet vs full description                                          */
/* ------------------------------------------------------------------ */

describe('the description kind is explicit and never defaulted silently', () => {
  it('refuses to save when the user has not stated which it is', () => {
    const built = buildImportCandidate(form({ descriptionKind: '' }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.some((i) => i.field === 'descriptionKind')).toBe(true);
  });

  it('marks a pasted excerpt as a snippet', () => {
    const built = buildImportCandidate(form({ descriptionKind: 'snippet' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.candidate.descriptionKind).toBe('snippet');
    expect(built.candidate.rawDescription).toBe('Build services with the team.');
  });

  it('always marks a provider excerpt as a snippet, never as a full description', () => {
    const mapped = candidateFromNormalizedJob(providerJob());
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.candidate.descriptionKind).toBe('snippet');
    expect(mapped.candidate.rawDescription).not.toBe('Build services with the team.');
  });

  it('the candidate schema is strict (no credential or unknown key)', () => {
    const built = buildImportCandidate(form());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const extra of [{ app_key: 'deadbeef' }, { apiKey: 'sk-x' }, { junk: 1 }]) {
      expect(importCandidateSchema.safeParse({ ...built.candidate, ...extra }).success).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Provider result → candidate                                          */
/* ------------------------------------------------------------------ */

describe('provider results normalize deterministically (synthetic fixtures only)', () => {
  it('preserves the source identifier, provider and external job id', () => {
    const mapped = candidateFromNormalizedJob(providerJob());
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.candidate.source).toBe('provider-search');
    expect(mapped.candidate.provider).toBe(ADZUNA_ID);
    expect(mapped.candidate.externalId).toBe('provider-job-42');
    expect(mapped.candidate.originalUrl).toBe('https://www.adzuna.in/details/provider-job-42');
    expect(mapped.candidate.postedDate).toBe('2026-10-02');
    expect(mapped.candidate.title).toBe('Platform Engineer');
  });

  it('does not invent fields the provider omitted', () => {
    const mapped = candidateFromNormalizedJob(
      providerJob({
        company: undefined,
        location: undefined,
        postedDate: undefined,
        salary: undefined,
      }),
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect('company' in mapped.candidate).toBe(false);
    expect('location' in mapped.candidate).toBe(false);
    expect('postedDate' in mapped.candidate).toBe(false);
    expect('compensation' in mapped.candidate).toBe(false);
  });

  it('is deterministic — identical input, identical candidate', () => {
    const a = candidateFromNormalizedJob(providerJob());
    const b = candidateFromNormalizedJob(providerJob());
    expect(a).toEqual(b);
  });

  it('refuses a result with no description rather than fabricating one', () => {
    const mapped = candidateFromNormalizedJob(providerJob({ description: undefined }));
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.issues.some((i) => i.field === 'rawDescription')).toBe(true);
    expect(mapped.issues[0]!.message).toContain('cannot be saved');
  });

  it('states that the provider gave no currency instead of choosing one', () => {
    expect(providerSalaryText({ min: 900000, max: 1400000, predicted: false })).toBe(
      '900000 - 1400000 (currency not stated by the search provider)',
    );
    expect(providerSalaryText({ min: 1000, predicted: null })).toBe(
      '1000 or more (currency not stated by the search provider)',
    );
    expect(providerSalaryText({ max: 2000, predicted: null })).toBe(
      'up to 2000 (currency not stated by the search provider)',
    );
    const predicted = providerSalaryText({ min: 1, max: 2, predicted: true });
    expect(predicted).toContain('estimated by the provider, not advertised');

    const mapped = candidateFromNormalizedJob(providerJob());
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const stored = mapped.candidate.compensation ?? '';
    expect(stored).toContain('currency not stated');
    for (const currency of ['$', '€', '£', '₹', 'USD', 'INR']) {
      expect(stored).not.toContain(currency);
    }
  });

  it('maps a real normalized payload end to end (fixture built by the normalizer)', () => {
    const raw = {
      results: [
        {
          id: 'raw-7',
          title: 'Data Engineer',
          description: 'Excerpt text.',
          created: '2026-10-01T08:00:00Z',
          redirect_url: 'https://www.adzuna.in/details/raw-7',
        },
      ],
      count: 1,
    };
    const page = normalizeAdzunaSearchResponse(raw, {
      request: adzunaSearchRequestSchema.parse({ country: 'in', keywords: 'data' }),
      now: () => '2026-10-15T09:00:00.000Z',
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const mapped = candidateFromNormalizedJob(page.value.results[0]!);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.candidate).toMatchObject({
      title: 'Data Engineer',
      rawDescription: 'Excerpt text.',
      descriptionKind: 'snippet',
      source: 'provider-search',
      provider: JOB_SEARCH_PROVIDERS[0],
      externalId: 'raw-7',
      originalUrl: 'https://www.adzuna.in/details/raw-7',
      postedDate: '2026-10-01',
    });
  });
});

/* ------------------------------------------------------------------ */
/* Duplicate identity + posting conversion                              */
/* ------------------------------------------------------------------ */

describe('the identity handed to the duplicate guard is narrow', () => {
  it('contains only the strict detector fields', () => {
    const built = buildImportCandidate(form({ company: 'Acme', url: 'https://example.com/j/1' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const identity = identityForDuplicateCheck(built.candidate);
    expect(Object.keys(identity).sort()).toEqual(['company', 'originalUrl', 'title']);
    expect(duplicateCandidateSchema.safeParse(identity).success).toBe(true);
  });

  it('carries an external identifier only when one exists', () => {
    const mapped = candidateFromNormalizedJob(providerJob());
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const identity = identityForDuplicateCheck(mapped.candidate);
    expect(identity.externalId).toBe('provider-job-42');
    expect(duplicateCandidateSchema.safeParse(identity).success).toBe(true);
  });

  it('drops optional keys entirely when they are absent', () => {
    const built = buildImportCandidate(form());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const identity = identityForDuplicateCheck(built.candidate);
    expect(Object.keys(identity)).toEqual(['title']);
  });
});

describe('toJobPosting re-validates against the existing posting model', () => {
  it('mints identity/timestamp and keeps every supplied field', () => {
    const built = buildImportCandidate(form({ company: 'Acme' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const posting = toJobPosting(built.candidate, () => '2026-10-15T09:00:00.000Z', () => 'fixed-id');
    expect(posting.id).toBe('fixed-id');
    expect(posting.capturedAt).toBe('2026-10-15T09:00:00.000Z');
    expect(posting.source).toBe('manual');
    expect(posting.company).toBe('Acme');
    expect(posting.descriptionKind).toBe('full');
    expect(jobPostingSchema.safeParse(posting).success).toBe(true);
  });

  it('keeps provider provenance on a mapped result', () => {
    const mapped = candidateFromNormalizedJob(providerJob());
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const posting = toJobPosting(mapped.candidate, () => '2026-10-15T09:00:00.000Z', () => 'id-1');
    expect(posting.source).toBe('provider-search');
    expect(posting.provider).toBe('adzuna');
    expect(posting.externalId).toBe('provider-job-42');
    expect(posting.descriptionKind).toBe('snippet');
  });

  it('rejects a candidate that somehow bypassed validation', () => {
    expect(() =>
      toJobPosting({ ...EMPTY_JOB_IMPORT_FORM } as never, () => '2026-10-15T09:00:00.000Z', () => 'x'),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* No network                                                           */
/* ------------------------------------------------------------------ */

describe('the import mapping is offline', () => {
  it('makes no network request while mapping (provider is not called)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const built = buildImportCandidate(form({ url: 'https://example.com/jobs/1' }));
    const mapped = candidateFromNormalizedJob(providerJob());
    expect(built.ok).toBe(true);
    expect(mapped.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
