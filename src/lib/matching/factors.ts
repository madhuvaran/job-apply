/**
 * Transparent scoring model (Prompt 09).
 *
 * ONE configuration location for the weights (they sum to 100):
 *
 *   requiredSkills    35  coverage of REQUIRED skills the posting states
 *   preferredSkills   10  coverage of PREFERRED ("nice to have") skills
 *   experience        20  observed career span vs the posting's stated range
 *   roleAlignment     20  job-title token overlap (0.6) + responsibility
 *                         lines mentioning profile skills (0.4)
 *   preferences       15  user settings compatibility (location, work mode,
 *                         employment type, experience range)
 *
 * Factor scores are 0–100. Within coverage factors: matched = 1,
 * partial = 0.5, missing = 0 over DECISIVE items only; `unknown` items are
 * excluded from the ratio but counted in the confidence/completeness report
 * (missing data never silently counts as a confirmed failure). A factor with
 * no decisive data scores `null` (unknown) and is excluded from the weighted
 * average — the remaining weights are renormalized, and if too little weight
 * is assessable the result is `insufficient-data` instead of a score.
 *
 * These weights are OUR OWN documented heuristic. They do not reflect any
 * employer's proprietary ATS algorithm, and no employer score is claimed.
 *
 * Pure: no network, no clock, no mutation, no storage.
 */
import type { Profile } from '../profile';
import type { JobPosting } from '../job-posting';
import { canonicalizeSkill, containsPhrase, findSkillMentions, titleTokens } from './vocabulary';
import type { AssessmentItem } from './requirements';
import { MATCH_FACTORS, type MatchFactor } from './schemas';

/** Documented default weights; MUST sum to 100 (asserted by tests). */
export const MATCH_WEIGHTS: Readonly<Record<MatchFactor, number>> = {
  requiredSkills: 35,
  preferredSkills: 10,
  experience: 20,
  roleAlignment: 20,
  preferences: 15,
};

/** Minimum assessable weight required before a numeric score is produced. */
export const MIN_SCORE_WEIGHT = 40;

export interface FactorComputation {
  factor: MatchFactor;
  weight: number;
  /** null = factor could not be assessed from the available data. */
  score: number | null;
  explanation: string;
}

const STATUS_VALUE: Record<'matched' | 'partial' | 'missing', number> = {
  matched: 1,
  partial: 0.5,
  missing: 0,
};

function ratioScore(counts: { matched: number; partial: number; missing: number }): number {
  const decisive = counts.matched + counts.partial + counts.missing;
  const value = (counts.matched + 0.5 * counts.partial) / decisive;
  return Math.min(100, Math.max(0, value * 100));
}

function coverageFactor(
  factor: MatchFactor,
  items: AssessmentItem[],
  requiredness: 'required' | 'preferred',
): FactorComputation {
  const relevant = items.filter((i) => i.category === 'skill' && i.requiredness === requiredness);
  const counts = { matched: 0, partial: 0, missing: 0, unknown: 0 };
  for (const item of relevant) {
    switch (item.status) {
      case 'matched':
        counts.matched += 1;
        break;
      case 'partial':
        counts.partial += 1;
        break;
      case 'missing':
        counts.missing += 1;
        break;
      default:
        counts.unknown += 1;
    }
  }
  const decisive = counts.matched + counts.partial + counts.missing;
  const noun = requiredness === 'required' ? 'required' : 'preferred';
  if (relevant.length === 0) {
    return {
      factor,
      weight: MATCH_WEIGHTS[factor],
      score: null,
      explanation: `The posting states no ${noun} skills we can assess.`,
    };
  }
  if (decisive === 0) {
    return {
      factor,
      weight: MATCH_WEIGHTS[factor],
      score: null,
      explanation: `None of the ${relevant.length} ${noun} skills could be verified from your profile — excluded from the score rather than counted as failures.`,
    };
  }
  return {
    factor,
    weight: MATCH_WEIGHTS[factor],
    score: ratioScore(counts),
    explanation: `${counts.matched} matched, ${counts.partial} partial, ${counts.missing} confirmed gap(s) of ${decisive} assessed ${noun} skills${counts.unknown > 0 ? ` (${counts.unknown} unverifiable, lowering confidence)` : ''}.`,
  };
}

function experienceFactor(items: AssessmentItem[]): FactorComputation {
  const item = items.find((i) => i.id === 'experience:years');
  if (item === undefined || item.status === 'unknown') {
    return {
      factor: 'experience',
      weight: MATCH_WEIGHTS.experience,
      score: null,
      explanation:
        item === undefined
          ? 'The posting states no experience range to compare against.'
          : 'Your profile has no work history to compare — excluded rather than counted as a failure.',
    };
  }
  return {
    factor: 'experience',
    weight: MATCH_WEIGHTS.experience,
    score: STATUS_VALUE[item.status] * 100,
    explanation: item.explanation,
  };
}

/**
 * Role alignment = 0.6 x job-title token overlap + 0.4 x share of the
 * posting's responsibility lines that mention at least one of your listed
 * skills. Sub-scores are computed only from real data; unknown sub-scores
 * are excluded and the known weights renormalized. Zero-overlap
 * responsibilities are "unknown" (prose without concrete skills), not a
 * failure against the candidate.
 */
function roleAlignmentFactor(profile: Profile, job: JobPosting): FactorComputation {
  const postingTitleTokens = titleTokens(job.title);
  const candidateTitles = [
    ...(profile.headline !== undefined ? [profile.headline] : []),
    ...profile.experience.map((e) => e.title),
  ].filter((t) => titleTokens(t).length > 0);

  let titleScore: number | null = null;
  if (postingTitleTokens.length > 0 && candidateTitles.length > 0) {
    const postingSet = new Set(postingTitleTokens);
    let best = 0;
    for (const candidate of candidateTitles) {
      const candidateSet = new Set(titleTokens(candidate));
      let shared = 0;
      for (const token of postingSet) if (candidateSet.has(token)) shared += 1;
      best = Math.max(best, shared / postingSet.size);
    }
    titleScore = Math.min(1, best);
  }

  let responsibilityScore: number | null = null;
  let responsibilityNote = '';
  if (job.responsibilities.length > 0 && profile.skills.length > 0) {
    // A responsibility line is covered when it mentions (word-bounded, via
    // the conservative vocabulary) a skill the profile also lists.
    const covered = job.responsibilities.filter((line) =>
      profile.skills.some((s) => {
        const canonical = canonicalizeSkill(s.name);
        return (
          (canonical !== null && findSkillMentions(line).includes(canonical)) ||
          containsPhrase(line, s.name)
        );
      }),
    ).length;
    if (covered > 0) {
      responsibilityScore = covered / job.responsibilities.length;
    } else {
      responsibilityNote =
        ' The listed responsibilities mention none of your listed skills — nothing concrete to compare (not counted as a failure).';
    }
  }

  const parts: Array<{ score: number; weight: number }> = [];
  if (titleScore !== null) parts.push({ score: titleScore, weight: 0.6 });
  if (responsibilityScore !== null) parts.push({ score: responsibilityScore, weight: 0.4 });

  if (parts.length === 0) {
    return {
      factor: 'roleAlignment',
      weight: MATCH_WEIGHTS.roleAlignment,
      score: null,
      explanation:
        'Neither a comparable job title nor concrete responsibilities could be aligned with your profile.',
    };
  }
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = parts.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight;
  const bits: string[] = [];
  if (titleScore !== null) bits.push(`title overlap ${Math.round(titleScore * 100)}%`);
  if (responsibilityScore !== null) {
    bits.push(`${Math.round(responsibilityScore * 100)}% of responsibility lines touch your skills`);
  }
  return {
    factor: 'roleAlignment',
    weight: MATCH_WEIGHTS.roleAlignment,
    score: Math.min(100, Math.max(0, score * 100)),
    explanation: `${bits.join('; ')}${responsibilityNote}`,
  };
}

function preferencesFactor(items: AssessmentItem[]): FactorComputation {
  const prefItems = items.filter((i) => i.id.startsWith('pref:'));
  const decisive = prefItems.filter((i) => i.status !== 'unknown');
  if (prefItems.length === 0) {
    return {
      factor: 'preferences',
      weight: MATCH_WEIGHTS.preferences,
      score: null,
      explanation: 'No comparable preference data (yours or the posting\'s) is available.',
    };
  }
  if (decisive.length === 0) {
    return {
      factor: 'preferences',
      weight: MATCH_WEIGHTS.preferences,
      score: null,
      explanation: `${prefItems.length} preference dimension(s) exist, but none could be decided from the available data — excluded rather than counted as failures.`,
    };
  }
  const valueOf = (status: 'matched' | 'partial' | 'missing' | 'unknown'): number =>
    status === 'matched' ? 1 : status === 'partial' ? 0.5 : 0;
  const sum = decisive.reduce((acc, i) => acc + valueOf(i.status), 0);
  const unknown = prefItems.length - decisive.length;
  return {
    factor: 'preferences',
    weight: MATCH_WEIGHTS.preferences,
    score: Math.min(100, Math.max(0, (sum / decisive.length) * 100)),
    explanation: `${decisive.filter((i) => i.status === 'matched').length} of ${decisive.length} decidable preference checks match${unknown > 0 ? ` (${unknown} undecidable, lowering confidence)` : ''}.`,
  };
}

/** Compute all five factors in a fixed, deterministic order. */
export function computeFactors(
  items: AssessmentItem[],
  profile: Profile,
  job: JobPosting,
): FactorComputation[] {
  return [
    coverageFactor('requiredSkills', items, 'required'),
    coverageFactor('preferredSkills', items, 'preferred'),
    experienceFactor(items),
    roleAlignmentFactor(profile, job),
    preferencesFactor(items),
  ];
}
