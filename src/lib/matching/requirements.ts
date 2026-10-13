/**
 * Requirement extraction and assessment (Prompt 09).
 *
 * Compares the posting's STRUCTURED, deterministically-extracted requirement
 * fields (skills / requiredQualifications / preferredQualifications /
 * experienceRange / workArrangement / employmentType / location) against the
 * AI-safe profile and the user's job settings. The raw description is NEVER
 * scanned for keywords — a skill mentioned only in prose cannot create a
 * requirement or candidate evidence.
 *
 * Status semantics (documented, tested):
 * - `matched`  — verified profile evidence with the same canonical identity.
 * - `partial`  — adjacent/related evidence (e.g. "React Native" for React),
 *                or a preference satisfied only partially.
 * - `missing`  — an AFFIRMATIVE contradiction: profile or settings data that
 *                conflicts with the stated requirement (education ceiling,
 *                career-span shortfall, explicit non-overlapping preference).
 * - `unknown`  — insufficient information. Absence of a skill in the profile
 *                is NOT proof the candidate lacks it, so it is `unknown`
 *                (flagged as a `potential` hard issue when the profile does
 *                list skills). Nothing here is ever inferred or invented.
 *
 * Pure: no network, no clock (uses the posting's own `capturedAt` as the
 * as-of date), no mutation of inputs, no storage, no sensitive-profile data.
 */
import type { Profile } from '../profile';
import type { JobPosting } from '../job-posting';
import type { Settings } from '../settings';
import {
  canonicalizeCertification,
  canonicalizeSkill,
  displayLabel,
  educationLevelFromText,
  educationLevelLabel,
  educationLevelRank,
  findSkillMentions,
  isStrictTokenPrefix,
  normalizeForMatch,
  SKILL_VOCABULARY,
  CERTIFICATION_VOCABULARY,
  tokens,
  type EducationLevel,
} from './vocabulary';
import {
  MATCH_CATEGORIES,
  type IssueSeverity,
  type MatchEvidence,
  type MatchRequirement,
  type MatchStatus,
  type Requiredness,
} from './schemas';

/** A requirement item plus an optional hard-issue annotation. */
export interface AssessmentItem extends Omit<MatchRequirement, 'evidence'> {
  evidence?: MatchEvidence[];
  issue?: { severity: IssueSeverity; explanation: string };
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

const SKILL_LABELS = new Map(SKILL_VOCABULARY.map((e) => [e.id, e.label]));
const CERT_LABELS = new Map(CERTIFICATION_VOCABULARY.map((e) => [e.id, e.label]));

/** Join list items for explanations, bounded so no field can bloat a message. */
function joinCapped(values: string[], separator: string, max: number): string {
  const out: string[] = [];
  let length = 0;
  for (const value of values) {
    const nextLength = length + value.length + (out.length > 0 ? separator.length : 0);
    if (nextLength > max) {
      out.push('…');
      break;
    }
    out.push(value);
    length = nextLength;
  }
  return out.join(separator);
}

function parseMonth(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function parseIsoMonth(value: string): { year: number; month: number } | null {
  return parseMonth(value.slice(0, 7));
}

export interface CareerSpan {
  /** Total months between the earliest start and the latest end (or as-of). */
  months: number;
  /** Years, rounded to one decimal (deterministic). */
  years: number;
  earliestStart: string;
  earliestExperienceId: string;
}

/**
 * Observed career span from the profile's work history. Ongoing positions
 * (end = null) are measured against the posting's `capturedAt` date so the
 * function stays deterministic for identical inputs.
 */
export function observedCareerSpan(profile: Profile, asOfIso: string): CareerSpan | null {
  if (profile.experience.length === 0) return null;
  const asOf = parseIsoMonth(asOfIso);
  if (asOf === null) return null;

  let earliest: { year: number; month: number } | null = null;
  let earliestId = '';
  let latest: { year: number; month: number } = asOf;

  for (const exp of profile.experience) {
    const start = parseMonth(exp.dates.start);
    if (start === null) continue; // schema guarantees YYYY-MM; defensive only
    if (
      earliest === null ||
      start.year < earliest.year ||
      (start.year === earliest.year && start.month < earliest.month)
    ) {
      earliest = start;
      earliestId = exp.id;
    }
    const end = exp.dates.end === null ? asOf : parseMonth(exp.dates.end);
    if (end !== null && (end.year > latest.year || (end.year === latest.year && end.month > latest.month))) {
      latest = end;
    }
  }
  if (earliest === null) return null;

  const months = Math.max(0, (latest.year - earliest.year) * 12 + (latest.month - earliest.month));
  return {
    months,
    years: Math.round((months / 12) * 10) / 10,
    earliestStart: `${String(earliest.year).padStart(4, '0')}-${String(earliest.month).padStart(2, '0')}`,
    earliestExperienceId: earliestId,
  };
}

/* ------------------------------------------------------------------ */
/* Wanted skills (posting -> canonical requirement list)               */
/* ------------------------------------------------------------------ */

interface WantedSkill {
  canonicalId: string;
  label: string;
  requiredness: 'required' | 'preferred';
}

/**
 * Requirements are taken ONLY from the structured fields the deterministic
 * intake extraction produced. `skills[]` and `requiredQualifications[]` are
 * treated as required; `preferredQualifications[]` as preferred (required
 * wins when a skill appears in both). Unrecognized skills are skipped — they
 * are never guessed into the vocabulary.
 */
export function collectWantedSkills(job: JobPosting): WantedSkill[] {
  const map = new Map<string, WantedSkill>();
  const add = (line: string, requiredness: 'required' | 'preferred'): void => {
    for (const mention of findSkillMentions(line)) {
      const existing = map.get(mention);
      if (existing !== undefined) {
        if (requiredness === 'required') existing.requiredness = 'required';
        continue;
      }
      map.set(mention, {
        canonicalId: mention,
        label: SKILL_LABELS.get(mention) ?? mention,
        requiredness,
      });
    }
  };
  for (const skill of job.skills) add(skill, 'required');
  for (const line of job.requiredQualifications) add(line, 'required');
  for (const line of job.preferredQualifications) add(line, 'preferred');
  return [...map.values()].sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
}

interface ProfileSkillView {
  id: string;
  name: string;
  canonical: string | null;
  status: 'claimed' | 'verified';
}

function assessSkill(
  wanted: WantedSkill,
  profileSkills: ProfileSkillView[],
): {
  status: MatchStatus;
  evidence?: MatchEvidence[];
  explanation: string;
  issue?: AssessmentItem['issue'];
} {
  const exact = profileSkills.find((p) => p.canonical === wanted.canonicalId);
  if (exact !== undefined) {
    const strength =
      exact.status === 'verified'
        ? 'listed in your skills and marked verified with an evidence reference'
        : 'listed in your skills (claimed by you, no evidence reference attached)';
    return {
      status: 'matched',
      evidence: [{ kind: 'skill', id: exact.id, label: exact.name }],
      explanation: `${wanted.label}: ${strength}.`,
    };
  }

  const adjacent = profileSkills.find((p) => isStrictTokenPrefix(p.name, wanted.label));
  if (adjacent !== undefined) {
    return {
      status: 'partial',
      evidence: [{ kind: 'skill', id: adjacent.id, label: adjacent.name }],
      explanation: `${wanted.label}: your profile lists the related skill "${adjacent.name}" — adjacent evidence, not an exact match.`,
    };
  }

  if (profileSkills.length === 0) {
    return {
      status: 'unknown',
      explanation: `${wanted.label}: your profile lists no skills, so there is nothing to compare. This is not evidence that you lack it.`,
    };
  }
  return {
    status: 'unknown',
    explanation: `${wanted.label}: not among the ${profileSkills.length} skills in your profile. Absence from your list is not proof you lack it.`,
    issue:
      wanted.requiredness === 'required'
        ? {
            severity: 'potential',
            explanation: `${wanted.label} is required and not listed in your profile — potential gap worth verifying before applying.`,
          }
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Education / certification / experience                              */
/* ------------------------------------------------------------------ */

const CERT_MENTION = /certification|certificate|certified/;

function detectEducationLevels(lines: string[]): {
  specific: EducationLevel | null;
  generic: boolean;
} {
  let specific: EducationLevel | null = null;
  let generic = false;
  for (const line of lines) {
    const level = educationLevelFromText(line);
    if (level === null) continue;
    if (level === 'degree') {
      generic = true;
      continue;
    }
    if (specific === null || educationLevelRank(level) > educationLevelRank(specific)) {
      specific = level;
    }
  }
  return { specific, generic };
}

interface EducationView {
  id: string;
  level: EducationLevel | 'degree';
  inProgress: boolean;
}

function assessEducation(
  level: EducationLevel | 'degree',
  requiredness: Requiredness,
  education: EducationView[],
): {
  status: MatchStatus;
  evidence?: MatchEvidence[];
  explanation: string;
  issue?: AssessmentItem['issue'];
} {
  const label = educationLevelLabel(level);
  if (education.length === 0) {
    return {
      status: 'unknown',
      explanation: `${label}: your profile lists no education, so this cannot be verified. Absence is not proof.`,
    };
  }
  const completed = education.filter((e) => !e.inProgress);
  const best = completed.reduce<EducationView | null>(
    (acc, e) => (acc === null || educationLevelRank(e.level) > educationLevelRank(acc.level) ? e : acc),
    null,
  );

  if (best !== null && educationLevelRank(best.level) >= educationLevelRank(level)) {
    return {
      status: 'matched',
      evidence: [{ kind: 'education', id: best.id }],
      explanation: `${label}: your profile lists a completed credential at or above this level.`,
    };
  }

  const inProgressAtLevel = education.find(
    (e) => e.inProgress && educationLevelRank(e.level) >= educationLevelRank(level),
  );
  if (inProgressAtLevel !== undefined) {
    return {
      status: 'unknown',
      evidence: [{ kind: 'education', id: inProgressAtLevel.id }],
      explanation: `${label}: your profile lists this level as in progress, not completed — not counted as a match.`,
    };
  }

  if (best !== null) {
    const bestLabel = educationLevelLabel(best.level);
    return {
      status: 'missing',
      evidence: [{ kind: 'education', id: best.id }],
      explanation: `${label}: your profile's highest completed credential is ${bestLabel} — a confirmed conflict with this stated requirement.`,
      issue:
        requiredness === 'required'
          ? {
              severity: 'confirmed' as IssueSeverity,
              explanation: `${label} appears to be required, but your profile's highest completed credential is ${bestLabel}.`,
            }
          : undefined,
    };
  }

  // Education exists but nothing completed (all entries in progress).
  return {
    status: 'unknown',
    explanation: `${label}: your profile lists education entries, but none completed at this level.`,
  };
}

function assessCertification(
  named: string | null,
  certifications: Array<{ id: string; name: string }>,
): { status: MatchStatus; evidence?: MatchEvidence[]; explanation: string } {
  if (named !== null) {
    const label = CERT_LABELS.get(named) ?? named;
    const hit = certifications.find((c) => canonicalizeCertification(c.name) === named);
    if (hit !== undefined) {
      return {
        status: 'matched',
        evidence: [{ kind: 'certification', id: hit.id, label: hit.name }],
        explanation: `${label}: a matching certification is listed in your profile.`,
      };
    }
    if (certifications.length === 0) {
      return {
        status: 'unknown',
        explanation: `${label}: your profile lists no certifications. Absence is not proof you do not hold it.`,
      };
    }
    return {
      status: 'unknown',
      explanation: `${label}: your profile lists ${certifications.length} certification(s), but none clearly matches this name.`,
    };
  }

  // Generic "a certification" requirement.
  if (certifications.length === 0) {
    return {
      status: 'unknown',
      explanation: 'A certification is requested but not named; your profile lists none. Absence is not proof.',
    };
  }
  return {
    status: 'partial',
    evidence: certifications
      .slice(0, 3)
      .map((c) => ({ kind: 'certification' as const, id: c.id, label: c.name })),
    explanation: `The posting asks for a certification but does not name one; your profile lists ${certifications.length}. Verify one applies.`,
  };
}

function assessExperience(
  job: JobPosting,
  profile: Profile,
): {
  status: MatchStatus;
  evidence?: MatchEvidence[];
  explanation: string;
  issue?: AssessmentItem['issue'];
} | null {
  if (job.experienceRange === null || job.experienceRange === undefined) return null;
  const min = job.experienceRange.minYears ?? 0;
  const max = job.experienceRange.maxYears;
  const span = observedCareerSpan(profile, job.capturedAt);

  if (span === null) {
    return {
      status: 'unknown',
      explanation: `The posting asks for ${min}${max !== undefined ? `-${max}` : '+'} years; your profile lists no work history to compare. Absence is not proof.`,
    };
  }
  if (span.years < min) {
    return {
      status: 'missing',
      evidence: [{ kind: 'experience', id: span.earliestExperienceId, label: span.earliestStart }],
      explanation: `The posting asks for at least ${min} years; your profile's history spans about ${span.years} years since ${span.earliestStart} — a confirmed shortfall.`,
      issue: {
        severity: 'confirmed',
        explanation: `Required experience (${min}+ years) exceeds the ~${span.years} years observable in your profile since ${span.earliestStart}.`,
      },
    };
  }
  if (max !== undefined && span.years > max) {
    return {
      status: 'partial',
      evidence: [{ kind: 'experience', id: span.earliestExperienceId, label: span.earliestStart }],
      explanation: `Your profile's history spans about ${span.years} years, above the posted maximum of ${max} — overqualification signals can matter too.`,
    };
  }
  return {
    status: 'matched',
    evidence: [{ kind: 'experience', id: span.earliestExperienceId, label: span.earliestStart }],
    explanation: `The posting asks for ${min}${max !== undefined ? `-${max}` : '+'} years; your profile's history spans about ${span.years} since ${span.earliestStart}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Preference comparisons                                              */
/* ------------------------------------------------------------------ */

function assessEmploymentType(job: JobPosting, settings: Settings): AssessmentItem | null {
  if (settings.employmentTypes.length === 0 && job.employmentType === undefined) return null;
  const common = {
    id: 'pref:employment-type',
    category: 'employment-type' as const,
    requiredness: 'unknown' as const,
  };

  if (settings.employmentTypes.length === 0) {
    return {
      ...common,
      label: 'Employment type',
      status: 'unknown',
      explanation:
        'The posting states an employment type, but you have no employment-type preference configured.',
    };
  }
  if (job.employmentType === undefined) {
    return {
      ...common,
      label: 'Employment type',
      status: 'unknown',
      explanation: 'You configured an employment-type preference, but the posting does not state one.',
    };
  }
  if (settings.employmentTypes.includes(job.employmentType)) {
    return {
      ...common,
      label: `Employment type: ${job.employmentType}`,
      status: 'matched',
      evidence: [{ kind: 'settings', id: 'employmentTypes' }],
      explanation: `The posting is ${job.employmentType}, which is among your configured employment types.`,
    };
  }
  return {
    ...common,
    label: `Employment type: ${job.employmentType}`,
    status: 'missing',
    explanation: `The posting is ${job.employmentType}, but your settings allow only ${joinCapped(settings.employmentTypes, ', ', 60)} — an explicit preference conflict.`,
    issue: {
      severity: 'confirmed' as IssueSeverity,
      explanation: `Employment type ${job.employmentType} conflicts with your explicitly configured employment types.`,
    },
  };
}

function assessWorkArrangement(job: JobPosting, settings: Settings): AssessmentItem | null {
  if (settings.workModes.length === 0 && job.workArrangement === undefined) return null;
  const common = {
    id: 'pref:work-arrangement',
    category: 'work-arrangement' as const,
    requiredness: 'unknown' as const,
  };

  if (settings.workModes.length === 0) {
    return {
      ...common,
      label: 'Work arrangement',
      status: 'unknown',
      explanation: 'The posting states a work arrangement, but you have no work-mode preference configured.',
    };
  }
  if (job.workArrangement === undefined) {
    return {
      ...common,
      label: 'Work arrangement',
      status: 'unknown',
      explanation: 'You configured a work-mode preference, but the posting does not state one.',
    };
  }
  if (settings.workModes.includes(job.workArrangement)) {
    return {
      ...common,
      label: `Work arrangement: ${job.workArrangement}`,
      status: 'matched',
      evidence: [{ kind: 'settings', id: 'workModes' }],
      explanation: `The posting is ${job.workArrangement}, which matches your configured work modes.`,
    };
  }
  return {
    ...common,
    label: `Work arrangement: ${job.workArrangement}`,
    status: 'missing',
    explanation: `The posting is ${job.workArrangement}, but your settings allow only ${joinCapped(settings.workModes, ', ', 60)} — an explicit preference conflict.`,
    issue: {
      severity: 'confirmed' as IssueSeverity,
      explanation: `Work arrangement ${job.workArrangement} conflicts with your explicitly configured work modes.`,
    },
  };
}

function assessLocation(
  job: JobPosting,
  settings: Settings,
  profile: Profile,
): AssessmentItem | null {
  if (settings.targetLocations.length === 0 && job.location === undefined) return null;
  const common = {
    id: 'pref:location',
    category: 'location' as const,
    requiredness: 'unknown' as const,
  };

  if (settings.targetLocations.length === 0) {
    return {
      ...common,
      label: 'Location',
      status: 'unknown',
      explanation: 'The posting states a location, but you have no target locations configured.',
    };
  }
  if (job.location === undefined) {
    return {
      ...common,
      label: 'Location',
      status: 'unknown',
      explanation: 'You configured target locations, but the posting does not state a location.',
    };
  }

  const location = job.location;
  const postingTokens = new Set(tokens(location));
  const overlaps = settings.targetLocations.some((target) => {
    const targetTokens = tokens(target);
    if (targetTokens.length === 0) return false;
    if (normalizeForMatch(target) === normalizeForMatch(location)) return true;
    // Conservative token-subset rule: "Berlin" matches "Berlin, DE".
    return targetTokens.every((t) => postingTokens.has(t));
  });
  if (overlaps) {
    return {
      ...common,
      label: `Location: ${displayLabel(job.location, 60)}`,
      status: 'matched',
      evidence: [{ kind: 'settings', id: 'targetLocations' }],
      explanation: `The posted location "${displayLabel(job.location, 60)}" matches your target locations.`,
    };
  }
  if (job.workArrangement === 'remote') {
    return {
      ...common,
      label: `Location: ${displayLabel(job.location, 60)}`,
      status: 'partial',
      explanation: `Remote posting with location "${displayLabel(job.location, 60)}" that is not among your targets — flexibility is likely but unverified.`,
    };
  }
  if (profile.preferences.willingToRelocate) {
    return {
      ...common,
      label: `Location: ${displayLabel(job.location, 60)}`,
      status: 'partial',
      explanation: `"${displayLabel(job.location, 60)}" is not among your target locations, but your profile says you are willing to relocate.`,
    };
  }
  return {
    ...common,
    label: `Location: ${displayLabel(job.location, 60)}`,
    status: 'missing',
    explanation: `The posted location "${displayLabel(job.location, 60)}" is not among your target locations and the posting is not remote.`,
    issue: {
      severity: 'confirmed' as IssueSeverity,
      explanation: `Location "${displayLabel(job.location, 60)}" conflicts with your configured target locations (no relocation willingness recorded).`,
    },
  };
}

function assessExperienceRangePreference(job: JobPosting, settings: Settings): AssessmentItem | null {
  if (settings.experienceRange === undefined && job.experienceRange === undefined) return null;
  const common = {
    id: 'pref:experience-range',
    category: 'experience-range' as const,
    requiredness: 'unknown' as const,
  };

  if (settings.experienceRange === undefined) {
    return {
      ...common,
      label: 'Experience range',
      status: 'unknown',
      explanation:
        'The posting states an experience range, but you have no experience-range preference configured.',
    };
  }
  if (job.experienceRange === undefined) {
    return {
      ...common,
      label: 'Experience range',
      status: 'unknown',
      explanation: 'You configured an experience-range preference, but the posting does not state one.',
    };
  }

  const sMin = settings.experienceRange.minYears ?? 0;
  const sMax = settings.experienceRange.maxYears ?? Number.POSITIVE_INFINITY;
  const pMin = job.experienceRange.minYears ?? 0;
  const pMax = job.experienceRange.maxYears ?? Number.POSITIVE_INFINITY;
  const postingLabel = `${pMin}${Number.isFinite(pMax) ? `-${pMax}` : '+'}y`;
  const settingsLabel = `${sMin}${Number.isFinite(sMax) ? `-${sMax}` : '+'}y`;

  if (pMin > sMax || sMin > pMax) {
    return {
      ...common,
      label: `Experience range: ${postingLabel}`,
      status: 'missing',
      explanation: `The posting's range (${postingLabel}) does not overlap your configured range (${settingsLabel}) — an explicit preference conflict.`,
      issue: {
        severity: 'confirmed' as IssueSeverity,
        explanation: `Posted experience range ${postingLabel} conflicts with your configured range ${settingsLabel}.`,
      },
    };
  }
  if (pMin >= sMin && pMax <= sMax) {
    return {
      ...common,
      label: `Experience range: ${postingLabel}`,
      status: 'matched',
      evidence: [{ kind: 'settings', id: 'experienceRange' }],
      explanation: `The posting's range (${postingLabel}) fits within your configured range (${settingsLabel}).`,
    };
  }
  return {
    ...common,
    label: `Experience range: ${postingLabel}`,
    status: 'partial',
    evidence: [{ kind: 'settings', id: 'experienceRange' }],
    explanation: `The posting's range (${postingLabel}) overlaps but is not contained in your configured range (${settingsLabel}).`,
  };
}

/* ------------------------------------------------------------------ */
/* Main assessment                                                     */
/* ------------------------------------------------------------------ */

/**
 * Assess every requirement the posting provides enough information for.
 * Items are returned in a stable order (category, then id) so identical
 * inputs always produce identical output.
 */
export function assessRequirements(
  profile: Profile,
  job: JobPosting,
  settings: Settings,
): AssessmentItem[] {
  const items: AssessmentItem[] = [];

  const profileSkills: ProfileSkillView[] = profile.skills.map((s) => ({
    id: s.id,
    name: s.name,
    canonical: canonicalizeSkill(s.name),
    status: s.status,
  }));

  for (const wanted of collectWantedSkills(job)) {
    const assessed = assessSkill(wanted, profileSkills);
    items.push({
      id: `skill:${wanted.canonicalId}`,
      label: wanted.label,
      category: 'skill',
      requiredness: wanted.requiredness,
      status: assessed.status,
      evidence: assessed.evidence,
      explanation: assessed.explanation,
      ...(assessed.issue !== undefined ? { issue: assessed.issue } : {}),
    });
  }

  // Education: highest level required / preferred by the posting.
  const requiredEducation = detectEducationLevels(job.requiredQualifications);
  const preferredEducation = detectEducationLevels(job.preferredQualifications);
  const educationViews: EducationView[] = profile.education.map((e) => ({
    id: e.id,
    level: educationLevelFromText(`${e.credential ?? ''} ${e.fieldOfStudy ?? ''}`) ?? 'degree',
    inProgress: e.inProgress,
  }));
  const educationItems = new Map<string, { level: EducationLevel | 'degree'; requiredness: Requiredness }>();
  if (requiredEducation.specific !== null) {
    educationItems.set(requiredEducation.specific, {
      level: requiredEducation.specific,
      requiredness: 'required',
    });
  } else if (requiredEducation.generic) {
    educationItems.set('degree', { level: 'degree', requiredness: 'required' });
  }
  if (preferredEducation.specific !== null && !educationItems.has(preferredEducation.specific)) {
    educationItems.set(preferredEducation.specific, {
      level: preferredEducation.specific,
      requiredness: 'preferred',
    });
  } else if (
    preferredEducation.specific === null &&
    preferredEducation.generic &&
    !educationItems.has('degree')
  ) {
    educationItems.set('degree', { level: 'degree', requiredness: 'preferred' });
  }
  for (const [key, def] of [...educationItems.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const assessed = assessEducation(def.level, def.requiredness, educationViews);
    items.push({
      id: `education:${key}`,
      label: educationLevelLabel(def.level),
      category: 'education',
      requiredness: def.requiredness,
      status: assessed.status,
      evidence: assessed.evidence,
      explanation: assessed.explanation,
      ...(assessed.issue !== undefined ? { issue: assessed.issue } : {}),
    });
  }

  // Certifications named (or generically requested) in qualification lines.
  const certItems = new Map<string, { named: string | null; requiredness: Requiredness }>();
  const scanCerts = (lines: string[], requiredness: Requiredness): void => {
    for (const line of lines) {
      if (!CERT_MENTION.test(normalizeForMatch(line))) continue;
      const named = canonicalizeCertification(line);
      const key = named ?? 'any';
      const existing = certItems.get(key);
      if (existing !== undefined) {
        if (requiredness === 'required') existing.requiredness = 'required';
        continue;
      }
      certItems.set(key, { named, requiredness });
    }
  };
  scanCerts(job.requiredQualifications, 'required');
  scanCerts(job.preferredQualifications, 'preferred');
  const certifications = profile.certifications.map((c) => ({ id: c.id, name: c.name }));
  for (const [key, def] of [...certItems.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const assessed = assessCertification(def.named, certifications);
    items.push({
      id: `certification:${key}`,
      label: def.named !== null ? (CERT_LABELS.get(def.named) ?? def.named) : 'A certification',
      category: 'certification',
      requiredness: def.requiredness,
      status: assessed.status,
      evidence: assessed.evidence,
      explanation: assessed.explanation,
    });
  }

  // Experience years (posting's structured range vs observed career span).
  const experience = assessExperience(job, profile);
  if (experience !== null) {
    items.push({
      id: 'experience:years',
      label: 'Relevant experience (years)',
      category: 'experience',
      requiredness: 'unknown',
      status: experience.status,
      evidence: experience.evidence,
      explanation: experience.explanation,
      ...(experience.issue !== undefined ? { issue: experience.issue } : {}),
    });
  }

  // User-preference comparisons.
  const prefItems = [
    assessLocation(job, settings, profile),
    assessWorkArrangement(job, settings),
    assessEmploymentType(job, settings),
    assessExperienceRangePreference(job, settings),
  ];
  for (const item of prefItems) {
    if (item !== null) items.push(item);
  }

  return items.sort((a, b) => {
    const catDiff = MATCH_CATEGORIES.indexOf(a.category) - MATCH_CATEGORIES.indexOf(b.category);
    return catDiff !== 0 ? catDiff : a.id.localeCompare(b.id);
  });
}
