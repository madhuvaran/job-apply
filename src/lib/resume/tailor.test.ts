/**
 * Tests for the deterministic resume tailoring engine
 * (src/lib/resume/tailor.ts + schemas.ts) — Prompt 11 matrix:
 * relevance ranking, required > preferred, no invented content, verbatim
 * bullets/evidence, conservative empty-job handling, typed failures,
 * insufficient content, determinism, strict schemas, privacy boundaries
 * (no sensitive profile, no AI, no network) — synthetic fixtures only.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tailorResume, type TailorResult } from './tailor';
import { validateTailoredResume, tailoredResumeSchema, type TailoredResume } from './schemas';
import { profileSchema, type Profile } from '../profile';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { sampleSensitiveProfile } from '../sample-profile';

/* ------------------------------------------------------------------ */
/* Synthetic fixtures                                                  */
/* ------------------------------------------------------------------ */

const AS_OF = '2026-09-01T00:00:00.000Z';

function makeProfile(patch: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    displayName: 'Fake Candidate',
    headline: 'Backend Engineer',
    summary: 'Fake summary written by the fake candidate.',
    locationLabel: 'Fake City, FC (Remote)',
    // TypeScript intentionally FIRST in source order even though the posting
    // only prefers it — ranking must put required skills ahead of it.
    skills: [
      { id: 'sk-ts', name: 'TypeScript', status: 'claimed' },
      { id: 'sk-figma', name: 'Figma', status: 'claimed' },
      { id: 'sk-react', name: 'React', status: 'verified', evidenceRef: { kind: 'experience', id: 'exp-1', quote: 'Used React daily.' } },
      { id: 'sk-css', name: 'CSS', status: 'claimed' },
      { id: 'sk-node', name: 'Node.js', status: 'claimed' },
    ],
    experience: [
      {
        id: 'exp-1',
        company: 'Fake Co',
        title: 'Software Engineer',
        location: 'Fake City, FC',
        dates: { start: '2018-03', end: null },
        bullets: ['Built fake things with React.', 'Owned the Node.js services.'],
        seniority: 'mid',
      },
      {
        id: 'exp-2',
        company: 'Other Fake Co',
        title: 'Data Analyst',
        dates: { start: '2015-01', end: '2017-12' },
        bullets: ['Made dashboards.'],
      },
    ],
    education: [
      {
        id: 'edu-1',
        institution: 'Fake University',
        credential: 'B.Sc. Fake Studies',
        inProgress: false,
        dates: { start: '2014-09', end: '2018-05' },
      },
    ],
    certifications: [
      { id: 'cert-1', name: 'Fake Certification', issuer: 'Fake Issuer', issued: '2022-06-15' },
    ],
    projects: [
      {
        id: 'proj-1',
        name: 'Fake Project Alpha',
        description: 'A fake project the fake candidate built with React.',
        links: ['https://github.com/fake-user/fake-repo'],
        skills: [{ id: 'pskill-1', name: 'React', status: 'claimed' }],
        dates: { start: '2023-01', end: '2023-06' },
      },
      {
        id: 'proj-2',
        name: 'Marketing Site',
        description: 'Fake marketing copy for a fake product.',
        links: [],
        skills: [],
      },
    ],
    languages: [{ language: 'English', level: 'native' }],
    portfolio: 'https://portfolio.example.com/fake-user',
    github: 'https://github.com/fake-user',
    linkedin: 'https://www.linkedin.com/in/fake-user',
    ...patch,
  });
}

function makeJob(patch: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({
    id: 'job-1',
    title: 'Backend Engineer',
    company: 'Fake Co',
    location: 'Berlin, DE',
    rawDescription: 'A fake raw description.',
    responsibilities: ['Build services with Node.js'],
    requiredQualifications: ['Experience with React'],
    preferredQualifications: ['TypeScript familiarity', 'Kubernetes knowledge'],
    skills: ['Node.js'],
    experienceRange: { minYears: 3 },
    workArrangement: 'remote',
    employmentType: 'full-time',
    source: 'manual',
    capturedAt: AS_OF,
    ...patch,
  });
}

function ok(profile: Profile, job: JobPosting): TailoredResume {
  const result = tailorResume(profile, job);
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.kind}: ${'issues' in result ? result.issues.join(';') : result.reasons.join(';')}`);
  }
  return result.resume;
}

const skillIds = (r: TailoredResume): string[] => r.skills.map((s) => s.profileSkillId);
const skillNames = (r: TailoredResume): string[] => r.skills.map((s) => s.name);

/* ------------------------------------------------------------------ */
/* 1 + 2. Relevance prioritization (required > preferred > neutral)    */
/* ------------------------------------------------------------------ */

describe('skill ranking', () => {
  it('prioritizes job-relevant supported skills ahead of profile source order', () => {
    const resume = ok(makeProfile(), makeJob());
    const ids = skillIds(resume);
    // Required matches lead even though TypeScript is FIRST in the profile.
    expect(ids.slice(0, 2)).toEqual(['sk-react', 'sk-node']);
    expect(ids.indexOf('sk-ts')).toBeGreaterThan(ids.indexOf('sk-react'));
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-react')?.relevance).toBe('required');
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-node')?.relevance).toBe('required');
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-ts')?.relevance).toBe('preferred');
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-css')?.relevance).toBe('neutral');
  });

  it('preserves source order WITHIN each tier and links matched posting skills', () => {
    const resume = ok(makeProfile(), makeJob());
    // Neutral fill keeps profile order: Figma (idx 1) before CSS (idx 3).
    expect(skillIds(resume)).toEqual(['sk-react', 'sk-node', 'sk-ts', 'sk-figma', 'sk-css']);
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-react')?.matchedJobSkill).toBe('React');
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-node')?.matchedJobSkill).toBe('Node.js');
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-ts')?.matchedJobSkill).toBe('TypeScript');
    expect(resume.skills.find((s) => s.profileSkillId === 'sk-css')?.matchedJobSkill).toBeUndefined();
  });

  it('caps neutral fill at the documented target (no keyword stuffing)', () => {
    const extra = Array.from({ length: 13 }, (_, i) => ({
      id: `sk-extra-${i}`,
      name: `Extra Skill ${i}`,
      status: 'claimed' as const,
    }));
    const profile = makeProfile({ skills: [...makeProfile().skills, ...extra] });
    const resume = ok(profile, makeJob());
    // 3 relevant + neutral fill to exactly the target of 12.
    expect(resume.skills).toHaveLength(12);
    expect(resume.skills.length).toBeLessThan(profile.skills.length);
    // The tail neutrals are dropped in profile source order (Extra 6..12 gone).
    expect(skillIds(resume)).not.toContain('sk-extra-11');
    expect(skillIds(resume)).toContain('sk-extra-5');
  });
});

/* ------------------------------------------------------------------ */
/* 3 + 4. Never add posting skills; never upgrade claimed skills       */
/* ------------------------------------------------------------------ */

describe('truthfulness of selected skills', () => {
  it('posting skills absent from the profile are NEVER added', () => {
    const resume = ok(makeProfile(), makeJob());
    expect(skillNames(resume)).not.toContain('Kubernetes');
    expect(resume.skills.some((s) => s.matchedJobSkill === 'Kubernetes')).toBe(false);
    // Nor can an unrecognized posting skill leak in.
    const odd = ok(makeProfile(), makeJob({ skills: ['SAP HANA module'], requiredQualifications: ['SAP HANA module'] }));
    expect(skillNames(odd)).not.toContain('SAP HANA module');
  });

  it('profile status is copied verbatim — claimed stays claimed, verified stays verified', () => {
    const profile = makeProfile();
    const resume = ok(profile, makeJob());
    const byId = new Map(profile.skills.map((s) => [s.id, s]));
    for (const skill of resume.skills) {
      const source = byId.get(skill.profileSkillId);
      expect(source).toBeDefined();
      expect(skill.status).toBe(source?.status);
      expect(skill.name).toBe(source?.name);
      expect(skill.years).toBe(source?.years);
      // Evidence references are preserved exactly, never fabricated.
      expect(skill.evidenceRef).toEqual(source?.evidenceRef);
    }
    // The claimed TypeScript skill has no invented evidence.
    const ts = resume.skills.find((s) => s.profileSkillId === 'sk-ts');
    expect(ts?.status).toBe('claimed');
    expect(ts?.evidenceRef).toBeUndefined();
  });

  it('duplicate canonical skills keep only their first profile occurrence', () => {
    const profile = makeProfile({
      skills: [
        { id: 'sk-a', name: 'React', status: 'claimed' },
        { id: 'sk-b', name: 'React.js', status: 'claimed' },
      ],
    });
    const resume = ok(profile, makeJob({ requiredQualifications: ['React'] }));
    expect(skillIds(resume)).toEqual(['sk-a']);
  });
});

/* ------------------------------------------------------------------ */
/* 5 + 6. Verbatim experience/projects, no invented facts              */
/* ------------------------------------------------------------------ */

describe('experience and project selection', () => {
  it('keeps only overlapping experience, verbatim, in source order, with ids', () => {
    const profile = makeProfile();
    const resume = ok(profile, makeJob());
    expect(resume.experience.map((e) => e.id)).toEqual(['exp-1']); // Data Analyst has no overlap
    const entry = resume.experience[0];
    const source = profile.experience.find((e) => e.id === 'exp-1');
    expect(entry?.company).toBe(source?.company);
    expect(entry?.title).toBe(source?.title);
    expect(entry?.dates).toEqual(source?.dates);
    expect(entry?.seniority).toBe(source?.seniority);
    expect(entry?.bullets).toEqual(source?.bullets); // verbatim, same order
    expect(entry?.relevance).toBe('relevant');
    expect(entry?.reason.length).toBeGreaterThan(0);
  });

  it('with no usable posting signal the whole history is kept unchanged (source order)', () => {
    const profile = makeProfile();
    const resume = ok(
      profile,
      makeJob({ title: 'II', skills: [], requiredQualifications: [], preferredQualifications: [], responsibilities: [] }),
    );
    expect(resume.experience.map((e) => e.id)).toEqual(['exp-1', 'exp-2']);
    expect(resume.experience.every((e) => e.relevance === 'fallback')).toBe(true);
    expect(resume.experience[0]?.reason).toContain('No usable posting signal');
  });

  it('signal-with-zero-overlap keeps the full history rather than an empty resume', () => {
    const resume = ok(
      makeProfile(),
      makeJob({ title: 'Compliance Officer', skills: [], requiredQualifications: [], preferredQualifications: [], responsibilities: [] }),
    );
    // Title tokens exist but nothing overlaps — history included unchanged.
    expect(resume.experience.map((e) => e.id)).toEqual(['exp-1', 'exp-2']);
    expect(resume.experience[0]?.reason).toContain('included unchanged');
  });

  it('selects relevant projects verbatim and drops unrelated ones', () => {
    const profile = makeProfile();
    const resume = ok(profile, makeJob());
    expect(resume.projects.map((p) => p.id)).toEqual(['proj-1']);
    const project = resume.projects[0];
    const source = profile.projects.find((p) => p.id === 'proj-1');
    expect(project?.description).toBe(source?.description);
    expect(project?.links).toEqual(source?.links);
    expect(project?.skills).toEqual([
      { id: 'pskill-1', name: 'React', status: 'claimed' },
    ]);
    expect(project?.relevance).toBe('relevant');
  });

  it('no invented content: every rendered fact traces to the profile or is an annotation', () => {
    const profile = makeProfile();
    const resume = ok(profile, makeJob());
    const json = JSON.stringify(resume);

    // All bullets are exact copies of profile bullets.
    const profileBullets = new Set(profile.experience.flatMap((e) => e.bullets));
    for (const entry of resume.experience) {
      for (const bullet of entry.bullets) expect(profileBullets.has(bullet)).toBe(true);
    }
    // Summary is verbatim profile summary (no generated prose).
    expect(resume.summary?.basis).toBe('profile-summary');
    expect(resume.summary?.text).toBe(profile.summary);
    // Common fabrication signals are absent.
    expect(json).not.toMatch(/increased|boosted|improved by|led to a \d+%|grew \d+%/i);
    // Dates/employers/credentials only come from the profile.
    expect(resume.education[0]?.institution).toBe('Fake University');
    expect(resume.certifications[0]?.name).toBe('Fake Certification');
  });

  it('education, certifications and languages are always included verbatim', () => {
    const resume = ok(makeProfile(), makeJob());
    expect(resume.education.map((e) => e.id)).toEqual(['edu-1']);
    expect(resume.certifications.map((c) => c.id)).toEqual(['cert-1']);
    expect(resume.languages).toEqual([{ language: 'English', level: 'native' }]);
  });

  it('header and links are copied verbatim (no contact details exist to copy)', () => {
    const resume = ok(makeProfile(), makeJob());
    expect(resume.header).toEqual({
      displayName: 'Fake Candidate',
      headline: 'Backend Engineer',
      locationLabel: 'Fake City, FC (Remote)',
    });
    expect(resume.links).toEqual({
      portfolio: 'https://portfolio.example.com/fake-user',
      github: 'https://github.com/fake-user',
      linkedin: 'https://www.linkedin.com/in/fake-user',
    });
    expect(JSON.stringify(resume)).not.toContain('@');
    expect(JSON.stringify(resume)).not.toContain('555-0100');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Empty / minimal job description                                 */
/* ------------------------------------------------------------------ */

describe('conservative handling of an empty job description', () => {
  it('no skill tiers are assigned and content falls back to profile order', () => {
    const resume = ok(
      makeProfile(),
      makeJob({
        title: 'II',
        rawDescription: '.',
        skills: [],
        responsibilities: [],
        requiredQualifications: [],
        preferredQualifications: [],
        experienceRange: undefined,
        workArrangement: undefined,
        employmentType: undefined,
        location: undefined,
      }),
    );
    // Nothing can be called "required" or "preferred" — no relevance claims.
    expect(resume.skills.every((s) => s.relevance === 'neutral')).toBe(true);
    expect(resume.skills.every((s) => s.matchedJobSkill === undefined)).toBe(true);
    // All experience kept (source order), marked fallback, reason present.
    expect(resume.experience.map((e) => e.id)).toEqual(['exp-1', 'exp-2']);
    expect(resume.experience.every((e) => e.relevance === 'fallback')).toBe(true);
    expect(resume.projects.map((p) => p.id)).toEqual(['proj-1', 'proj-2']);
    // Provenance still records which posting this was tailored for.
    expect(resume.source).toEqual({ jobId: 'job-1', jobTitle: 'II', jobCapturedAt: AS_OF });
  });
});

/* ------------------------------------------------------------------ */
/* 8 + 9. Typed failures and insufficient content                     */
/* ------------------------------------------------------------------ */

describe('expected failures are typed results (never throws)', () => {
  it('invalid profile data → invalid with path+code issues only', () => {
    const bad = { ...makeProfile(), schemaVersion: '9' } as unknown as Profile;
    const result = tailorResume(bad, makeJob());
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.issues[0]).toContain('profile.');
    // No profile text leaks into issues.
    const joined = result.issues.join(' ');
    expect(joined).not.toContain('Fake');
    expect(joined).not.toContain('summary');
  });

  it('invalid job data → invalid with job path+code issues only', () => {
    const bad = { ...makeJob(), capturedAt: 'nope' } as unknown as JobPosting;
    const result = tailorResume(makeProfile(), bad);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.issues[0]).toContain('job.');
    expect(result.issues.join(' ')).not.toContain('Berlin');
    expect(result.issues.join(' ')).not.toContain('Engineer');
  });

  it('missing inputs → invalid with explicit missing markers', () => {
    expect(tailorResume(null, makeJob())).toEqual({ kind: 'invalid', issues: ['profile: missing'] });
    expect(tailorResume(makeProfile(), null)).toEqual({ kind: 'invalid', issues: ['job: missing'] });
    expect(tailorResume(null, null)).toEqual({
      kind: 'invalid',
      issues: ['profile: missing', 'job: missing'],
    });
  });

  it('an empty profile yields an honest insufficient result (no fabricated content)', () => {
    const result = tailorResume(profileSchema.parse({}), makeJob());
    expect(result.kind).toBe('insufficient');
    if (result.kind !== 'insufficient') return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('no supported resume content');
    expect(result.reasons[0]).toContain('without inventing content');
  });

  it('a header-only profile is still insufficient (identity alone is not a resume)', () => {
    const result = tailorResume(profileSchema.parse({ displayName: 'Fake Candidate' }), makeJob());
    expect(result.kind).toBe('insufficient');
  });
});

/* ------------------------------------------------------------------ */
/* 10 + 11. Determinism and strict schemas                             */
/* ------------------------------------------------------------------ */

describe('determinism and strict output schema', () => {
  it('identical inputs produce byte-identical output', () => {
    const a = tailorResume(makeProfile(), makeJob());
    const b = tailorResume(makeProfile(), makeJob());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (a.kind !== 'ok') throw new Error('fixture not ok');
    expect(a.resume.selectionNotes.every((n) => n.length > 0)).toBe(true);
  });

  it('every successful result validates against the strict schema', () => {
    const result = tailorResume(makeProfile(), makeJob());
    if (result.kind !== 'ok') throw new Error('fixture not ok');
    const check = validateTailoredResume(result.resume);
    expect(check.ok).toBe(true);
    expect(tailoredResumeSchema.safeParse(result.resume).success).toBe(true);
  });

  it('strict schemas reject unknown properties at every level', () => {
    const base = tailorResume(makeProfile(), makeJob());
    if (base.kind !== 'ok') throw new Error('fixture not ok');

    expect(validateTailoredResume({ ...base.resume, apiKey: 'sk-injected' }).ok).toBe(false);
    expect(validateTailoredResume({ ...base.resume, contact: { email: 'leak@example.com' } }).ok).toBe(false);

    const withExtraBulletKey = {
      ...base.resume,
      experience: [{ bogus: true }],
    };
    expect(validateTailoredResume(withExtraBulletKey).ok).toBe(false);

    const withExtraSkillKey = {
      ...base.resume,
      skills: [{ ...base.resume.skills[0], sourceText: 'leak' }],
    };
    expect(validateTailoredResume(withExtraSkillKey).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 12 + 13. Privacy and AI/network boundaries                          */
/* ------------------------------------------------------------------ */

describe('privacy and offline boundaries', () => {
  it('the API accepts only profile + job (no sensitive profile, no settings)', () => {
    expect(tailorResume.length).toBe(2);
    // Sensitive sample values can never appear: the input shape has no path
    // for them and the output schema is strict.
    const resume = ok(makeProfile(), makeJob());
    const json = JSON.stringify(resume);
    expect(json).not.toContain(sampleSensitiveProfile.contact.email);
    expect(json).not.toContain(sampleSensitiveProfile.contact.phone);
    expect(json).not.toContain(sampleSensitiveProfile.contact.address);
    expect(json).not.toContain('workAuthorization');
    expect(json).not.toContain('voluntary');
  });

  it("the posting's compensation never enters the result", () => {
    const resume = ok(makeProfile(), makeJob({ compensation: '$999,999 per year' }));
    const json = JSON.stringify(resume);
    expect(json).not.toContain('999,999');
    expect(json).not.toContain('compensation');
    // Nor does the posting's raw description text (only id/title/date are kept).
    expect(json).not.toContain('A fake raw description.');
  });

  it('makes zero network calls and never touches the AI layer', async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      expect(tailorResume(makeProfile(), makeJob()).kind).toBe('ok');
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('module sources import neither the sensitive store nor the AI layer', () => {
    const dir = join(process.cwd(), 'src', 'lib', 'resume');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')) // skip this test file itself
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/from ['"].*sensitive['"]/);
    expect(sources).not.toMatch(/loadSensitiveProfile/);
    expect(sources).not.toMatch(/runAiRequest|from ['"].*\/ai['"]/);
    expect(sources).not.toMatch(/fetch\s*\(/);
    expect(sources).not.toMatch(/chrome\.storage|loadProfile|loadSettings/);
  });
});

/* ------------------------------------------------------------------ */
/* 14. Matching engine unchanged                                       */
/* ------------------------------------------------------------------ */

describe('matching engine untouched', () => {
  it('tailoring reuses vocabulary helpers without changing matching behavior', async () => {
    const matching = await import('../matching');
    // The tailoring API lives only in the resume module.
    expect('tailorResume' in matching).toBe(false);
    // Existing public matching API still present.
    expect(typeof matching.calculateJobMatch).toBe('function');
    expect(matching.MATCH_WEIGHTS.requiredSkills).toBe(35);
  });
});
