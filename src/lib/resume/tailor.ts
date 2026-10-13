/**
 * Deterministic resume tailoring engine (Prompt 11).
 *
 * `tailorResume(profile, job)` selects and reorders EXISTING AI-safe profile
 * content for one saved posting. It never generates prose about the
 * candidate, never invents facts, and never reads the sensitive profile,
 * settings, storage, or the network.
 *
 * Selection policy (documented, deterministic, tested):
 * - Skills: ranked by posting relevance — matches of REQUIRED posting skills
 *   (`skills[]` + required qualifications) first, then PREFERRED matches,
 *   then neutral profile skills in source order until `SKILL_FILL_TARGET`
 *   (12) is reached; hard cap `MAX_SELECTED_SKILLS` (24). Duplicate
 *   canonicals keep their FIRST profile occurrence. We iterate the PROFILE
 *   only: posting skills absent from the profile are never added, and a
 *   posting requirement is never turned into a candidate claim.
 *   `status`/`evidenceRef` are copied verbatim — claimed stays claimed.
 * - Experience: profile SOURCE ORDER is preserved (chronology is never
 *   misrepresented); relevance decides INCLUSION only. If at least one
 *   entry overlaps the posting (title tokens or required/preferred skill
 *   mentions), only those are kept; if none overlap, the whole history is
 *   included unchanged (conservative). A posting with no usable signal
 *   includes everything as-is. Bullets are verbatim and complete.
 * - Projects: same overlap rule, but signal-with-zero-overlap omits them
 *   (supplementary section). No signal → all, in source order. Cap 12.
 * - Education, certifications, languages: ALWAYS included verbatim in source
 *   order — dropping credentials could misrepresent the candidate.
 * - Summary: profile.summary verbatim; else headline verbatim; else a
 *   "Skills: …" line assembled from already-selected skill names; else the
 *   section is OMITTED (never fabricated).
 * - Header/links: displayName/headline/locationLabel and portfolio/github/
 *   linkedin copied verbatim when present (contact details belong to the
 *   later rendering layer and never enter this module).
 *
 * Expected failures are TYPED results (no throws): `invalid` (schema
 * validation / missing input; path+code issues only — never profile or job
 * text), `insufficient` (nothing supported to render — fixed literal
 * reason), `ok` (a strictly validated `tailoredResumeSchema` payload whose
 * item ids equal the profile ids for full traceability).
 *
 * Offline: no AI provider, no network, no storage writes, no clock (the
 * posting's own `capturedAt` is provenance only).
 */
import type { Profile } from '../profile';
import { profileSchema } from '../profile';
import type { JobPosting } from '../job-posting';
import { jobPostingSchema } from '../job-posting';
import { canonicalizeSkill } from '../matching/vocabulary';
import {
  MAX_SELECTED_PROJECTS,
  MAX_SELECTED_SKILLS,
  SKILL_FILL_TARGET,
  tailoredResumeSchema,
  type SelectionReason,
  type TailoredCertification,
  type TailoredEducation,
  type TailoredExperience,
  type TailoredLanguage,
  type TailoredProject,
  type TailoredResume,
  type TailoredSkill,
  type TailoredSummary,
} from './schemas';
import { buildJobSignal, entryRelevance, skillTier, type JobSignal } from './relevance';

export type TailorResult =
  /** A strictly validated, traceable tailored resume. */
  | { kind: 'ok'; resume: TailoredResume }
  /** Valid inputs, but the profile supports no renderable content (no fabrication). */
  | { kind: 'insufficient'; reasons: string[] }
  /** Schema-invalid or missing input. Issues are path+code only (no PII). */
  | { kind: 'invalid'; issues: string[] };

function formatIssues(
  prefix: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>,
): string[] {
  return issues.map((i) => `${prefix}.${i.path.map(String).join('.') || '(root)'}: ${i.code}`);
}

/** Fixed literal — reveals nothing about the user's data. */
const INSUFFICIENT_REASON =
  'The profile provides no supported resume content (no summary, skills, experience, projects, education, certifications or languages) — nothing can be rendered without inventing content.';

/** Deterministic dedupe key: canonical vocabulary id, else normalized name. */
function dedupeKey(name: string): string {
  const canonical = canonicalizeSkill(name);
  return canonical !== null ? `c:${canonical}` : `n:${name.trim().toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* Skills (relevance-ranked, source order within tier)                 */
/* ------------------------------------------------------------------ */

interface SkillPick {
  skill: Profile['skills'][number];
  tier: 'required' | 'preferred' | 'neutral';
}

function selectSkills(profile: Profile, signal: JobSignal): {
  skills: TailoredSkill[];
  note: string;
} {
  const tiers: SkillPick[] = profile.skills.map((skill) => ({
    skill,
    tier: skillTier(signal, skill.name),
  }));

  const seen = new Set<string>();
  const picked: SkillPick[] = [];
  const append = (items: SkillPick[]): void => {
    for (const item of items) {
      const key = dedupeKey(item.skill.name);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
    }
  };

  // Required matches → preferred matches → neutral fill; each tier keeps the
  // profile's source order (input arrays are in source order).
  append(tiers.filter((t) => t.tier === 'required'));
  append(tiers.filter((t) => t.tier === 'preferred'));
  if (picked.length < SKILL_FILL_TARGET) {
    // Neutral fill stops exactly at the target — beyond that, extra neutral
    // skills would be keyword stuffing rather than tailoring.
    const room = SKILL_FILL_TARGET - picked.length;
    append(tiers.filter((t) => t.tier === 'neutral').slice(0, room));
  }

  const skills: TailoredSkill[] = picked.slice(0, MAX_SELECTED_SKILLS).map(({ skill, tier }) => {
    const matchedCanonical = canonicalizeSkill(skill.name);
    const isMatched =
      matchedCanonical !== null &&
      (tier === 'required'
        ? signal.required.has(matchedCanonical)
        : tier === 'preferred' && signal.preferred.has(matchedCanonical));
    return {
      profileSkillId: skill.id,
      name: skill.name,
      status: skill.status, // verbatim: claimed NEVER becomes verified
      ...(skill.years !== undefined ? { years: skill.years } : {}),
      ...(skill.evidenceRef !== undefined ? { evidenceRef: skill.evidenceRef } : {}),
      relevance: tier,
      ...(isMatched ? { matchedJobSkill: signal.labelOf(matchedCanonical) } : {}),
    };
  });

  const note = `Selected ${skills.length} of ${profile.skills.length} profile skills — posting matches first, then profile order (cap ${MAX_SELECTED_SKILLS}).`;
  return { skills, note };
}

/* ------------------------------------------------------------------ */
/* Experience (source order; relevance selects, never reorders)        */
/* ------------------------------------------------------------------ */

function selectExperience(profile: Profile, signal: JobSignal): {
  entries: TailoredExperience[];
  note?: string;
} {
  const assessed = profile.experience.map((entry) => ({
    entry,
    rel: entryRelevance(signal, entry.title, [entry.title, ...entry.bullets]),
  }));
  const anyOverlap = signal.hasSignal && assessed.some((a) => a.rel.relevant);
  const kept = anyOverlap ? assessed.filter((a) => a.rel.relevant) : assessed;

  const entries: TailoredExperience[] = kept.map(({ entry, rel }) => ({
    id: entry.id,
    company: entry.company,
    title: entry.title,
    ...(entry.location !== undefined ? { location: entry.location } : {}),
    dates: { start: entry.dates.start, end: entry.dates.end },
    ...(entry.seniority !== undefined ? { seniority: entry.seniority } : {}),
    bullets: [...entry.bullets], // verbatim copies, source order
    relevance: anyOverlap ? ('relevant' as SelectionReason) : ('fallback' as SelectionReason),
    reason: anyOverlap
      ? rel.reason
      : signal.hasSignal
        ? 'No entry overlapped the posting — your work history is included unchanged (source order).'
        : rel.reason,
  }));

  const note =
    kept.length < profile.experience.length
      ? `Selected ${kept.length} of ${profile.experience.length} experience entries; source (chronological) order preserved.`
      : undefined;
  return { entries, ...(note !== undefined ? { note } : {}) };
}

/* ------------------------------------------------------------------ */
/* Projects (relevance-selected; omitted rather than fabricated)       */
/* ------------------------------------------------------------------ */

function selectProjects(profile: Profile, signal: JobSignal): {
  entries: TailoredProject[];
  note?: string;
} {
  const assessed = profile.projects.map((project) => ({
    project,
    rel: entryRelevance(signal, project.name, [
      project.description,
      ...project.skills.map((s) => s.name),
    ]),
  }));
  const anyOverlap = signal.hasSignal && assessed.some((a) => a.rel.relevant);
  const pool = !signal.hasSignal ? assessed : anyOverlap ? assessed.filter((a) => a.rel.relevant) : [];
  const kept = pool.slice(0, MAX_SELECTED_PROJECTS);

  const entries: TailoredProject[] = kept.map(({ project, rel }) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    ...(project.url !== undefined ? { url: project.url } : {}),
    links: [...project.links],
    skills: project.skills.map((s) => ({ id: s.id, name: s.name, status: s.status })),
    ...(project.dates !== undefined
      ? { dates: { start: project.dates.start, end: project.dates.end } }
      : {}),
    relevance: anyOverlap ? ('relevant' as SelectionReason) : ('fallback' as SelectionReason),
    reason: rel.reason,
  }));

  const note =
    signal.hasSignal && profile.projects.length > 0 && kept.length === 0
      ? 'No project overlapped the posting — projects omitted rather than fabricated.'
      : anyOverlap && kept.length < profile.projects.length
        ? `Selected ${kept.length} of ${profile.projects.length} projects by relevance.`
        : undefined;
  return { entries, ...(note !== undefined ? { note } : {}) };
}

/* ------------------------------------------------------------------ */
/* Summary (verbatim or minimal assembly — never generated prose)      */
/* ------------------------------------------------------------------ */

function buildSummary(
  profile: Profile,
  selectedSkills: TailoredSkill[],
): TailoredSummary | undefined {
  if (profile.summary !== undefined && profile.summary.trim().length > 0) {
    return { basis: 'profile-summary', text: profile.summary, sourceIds: [] };
  }
  if (profile.headline !== undefined && profile.headline.trim().length > 0) {
    return { basis: 'profile-headline', text: profile.headline, sourceIds: [] };
  }
  if (selectedSkills.length > 0) {
    const top = selectedSkills.slice(0, 8);
    return {
      basis: 'profile-skills',
      text: `Skills: ${top.map((s) => s.name).join(', ')}`,
      sourceIds: top.map((s) => s.profileSkillId),
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deterministic, offline tailoring. Identical validated inputs always
 * produce identical output. Never throws for expected user-data failures.
 */
export function tailorResume(profile: Profile | null, job: JobPosting | null): TailorResult {
  const missingIssues: string[] = [];
  if (profile === null) missingIssues.push('profile: missing');
  if (job === null) missingIssues.push('job: missing');
  if (missingIssues.length > 0) return { kind: 'invalid', issues: missingIssues };

  const profileCheck = profileSchema.safeParse(profile);
  if (!profileCheck.success) {
    return { kind: 'invalid', issues: formatIssues('profile', profileCheck.error.issues) };
  }
  const jobCheck = jobPostingSchema.safeParse(job);
  if (!jobCheck.success) {
    return { kind: 'invalid', issues: formatIssues('job', jobCheck.error.issues) };
  }

  const p = profileCheck.data;
  const j = jobCheck.data;
  const signal = buildJobSignal(j);

  const { skills, note: skillsNote } = selectSkills(p, signal);
  const { entries: experience, note: experienceNote } = selectExperience(p, signal);
  const { entries: projects, note: projectsNote } = selectProjects(p, signal);
  const summary = buildSummary(p, skills);

  const education: TailoredEducation[] = p.education.map((e) => ({
    id: e.id,
    institution: e.institution,
    ...(e.credential !== undefined ? { credential: e.credential } : {}),
    ...(e.fieldOfStudy !== undefined ? { fieldOfStudy: e.fieldOfStudy } : {}),
    ...(e.grade !== undefined ? { grade: e.grade } : {}),
    inProgress: e.inProgress,
    dates: { start: e.dates.start, end: e.dates.end },
  }));
  const certifications: TailoredCertification[] = p.certifications.map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.issuer !== undefined ? { issuer: c.issuer } : {}),
    ...(c.issued !== undefined ? { issued: c.issued } : {}),
    ...(c.credentialUrl !== undefined ? { credentialUrl: c.credentialUrl } : {}),
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
  }));
  const languages: TailoredLanguage[] = p.languages.map((l) => ({
    language: l.language,
    level: l.level,
  }));

  const hasAnyContent =
    summary !== undefined ||
    skills.length > 0 ||
    experience.length > 0 ||
    projects.length > 0 ||
    education.length > 0 ||
    certifications.length > 0 ||
    languages.length > 0;
  if (!hasAnyContent) return { kind: 'insufficient', reasons: [INSUFFICIENT_REASON] };

  const headerFields = {
    ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
    ...(p.headline !== undefined ? { headline: p.headline } : {}),
    ...(p.locationLabel !== undefined ? { locationLabel: p.locationLabel } : {}),
  };
  const linksFields = {
    ...(p.portfolio !== undefined ? { portfolio: p.portfolio } : {}),
    ...(p.github !== undefined ? { github: p.github } : {}),
    ...(p.linkedin !== undefined ? { linkedin: p.linkedin } : {}),
  };

  const selectionNotes = [
    skillsNote,
    ...(experienceNote !== undefined ? [experienceNote] : []),
    ...(projectsNote !== undefined ? [projectsNote] : []),
    'Education, certifications and languages are included verbatim in profile order.',
  ];

  // Invariant: our own construction must satisfy the strict output schema.
  const resume = tailoredResumeSchema.parse({
    schemaVersion: '1',
    source: { jobId: j.id, jobTitle: j.title, jobCapturedAt: j.capturedAt },
    ...(Object.keys(headerFields).length > 0 ? { header: headerFields } : {}),
    ...(summary !== undefined ? { summary } : {}),
    skills,
    experience,
    projects,
    education,
    certifications,
    languages,
    ...(Object.keys(linksFields).length > 0 ? { links: linksFields } : {}),
    selectionNotes,
  });
  return { kind: 'ok', resume };
}
