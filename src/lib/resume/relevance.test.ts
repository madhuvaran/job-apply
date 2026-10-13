/**
 * Tests for the documented relevance helper (src/lib/resume/relevance.ts).
 * The helper is a TIER classifier built on Prompt 09's vocabulary — these
 * tests pin its behavior without touching the matching engine.
 */
import { describe, expect, it } from 'vitest';
import { buildJobSignal, entryRelevance, skillTier } from './relevance';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { MATCH_WEIGHTS } from '../matching/factors';

function makeJob(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-1',
    title: 'Backend Engineer',
    rawDescription: 'Fake raw description.',
    responsibilities: [],
    requiredQualifications: ['Experience with React'],
    preferredQualifications: ['TypeScript familiarity', 'Kubernetes knowledge'],
    skills: ['Node.js'],
    source: 'manual',
    capturedAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  });
}

describe('buildJobSignal', () => {
  it('splits required (skills[] + required quals) from preferred (preferred quals)', () => {
    const signal = buildJobSignal(makeJob());
    expect([...signal.required].sort()).toEqual(['node', 'react']);
    expect([...signal.preferred].sort()).toEqual(['kubernetes', 'typescript']);
    expect(signal.titleTokens.has('backend')).toBe(true);
    expect(signal.titleTokens.has('engineer')).toBe(true);
    expect(signal.hasSignal).toBe(true);
  });

  it('required wins when a skill appears on both sides', () => {
    const signal = buildJobSignal(
      makeJob({ preferredQualifications: ['React nice to have'], skills: [] }),
    );
    expect(signal.required.has('react')).toBe(true);
    expect(signal.preferred.has('react')).toBe(false);
  });

  it('unrecognized posting skills are never guessed into the vocabulary', () => {
    const signal = buildJobSignal(
      makeJob({ skills: ['SAP HANA custom module'], requiredQualifications: [], preferredQualifications: [] }),
    );
    expect(signal.required.size).toBe(0);
    expect(signal.preferred.size).toBe(0);
  });

  it('an empty posting has no signal', () => {
    const signal = buildJobSignal(
      makeJob({ skills: [], requiredQualifications: [], preferredQualifications: [] }),
    );
    // 'Backend Engineer' still yields comparable title tokens.
    expect(signal.hasSignal).toBe(true);
    const titleless = buildJobSignal(makeJob({ title: 'II', skills: [], requiredQualifications: [], preferredQualifications: [] }));
    expect(titleless.hasSignal).toBe(false);
  });
});

describe('skillTier', () => {
  it('maps profile skill names (incl. aliases) to posting tiers', () => {
    const signal = buildJobSignal(makeJob());
    expect(skillTier(signal, 'React')).toBe('required');
    expect(skillTier(signal, 'k8s')).toBe('preferred'); // alias resolves to the PREFERRED 'kubernetes'
    expect(skillTier(signal, 'TypeScript')).toBe('preferred');
    expect(skillTier(signal, 'CSS')).toBe('neutral');
    expect(skillTier(signal, 'teamwork')).toBe('neutral');
  });
});

describe('entryRelevance', () => {
  const signal = buildJobSignal(makeJob());

  it('required skill mention in the entry makes it relevant', () => {
    const r = entryRelevance(signal, 'Software Engineer', ['Built fake things with React.']);
    expect(r.relevant).toBe(true);
    expect(r.reason).toContain('requires: React');
  });

  it('title overlap alone makes it relevant', () => {
    const r = entryRelevance(signal, 'Backend Engineer II', ['Did unrelated work.']);
    expect(r.relevant).toBe(true);
    expect(r.reason).toContain('Title overlaps');
  });

  it('zero overlap with a signaling posting is not relevant, with a fixed reason', () => {
    const r = entryRelevance(signal, 'Data Analyst', ['Made dashboards.']);
    expect(r.relevant).toBe(false);
    expect(r.reason).toContain('No overlap');
    expect(r.reason).not.toContain('dashboard'); // reason never quotes entry text
  });

  it('no signal at all → conservative inclusion with its own fixed reason', () => {
    const empty = buildJobSignal(
      makeJob({ title: 'II', skills: [], requiredQualifications: [], preferredQualifications: [] }),
    );
    const r = entryRelevance(empty, 'Anything', ['Anything at all.']);
    expect(r.relevant).toBe(true);
    expect(r.reason).toContain('No usable posting signal');
  });
});

describe('matching engine is untouched', () => {
  it('Prompt 09 weights remain exactly as documented', () => {
    expect(MATCH_WEIGHTS).toEqual({
      requiredSkills: 35,
      preferredSkills: 10,
      experience: 20,
      roleAlignment: 20,
      preferences: 15,
    });
  });
});
