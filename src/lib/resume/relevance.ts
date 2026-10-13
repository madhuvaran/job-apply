/**
 * Deterministic relevance helper for resume tailoring (Prompt 11).
 *
 * This is a TIER classifier, not a score: it reuses Prompt 09's matching
 * vocabulary helpers (`findSkillMentions`, `canonicalizeSkill`,
 * `titleTokens`, `containsPhrase`) and adds no scoring formula — the
 * matching engine's weights/threshold/vocabulary are untouched.
 *
 * Documented behavior (unit-tested):
 * - `buildJobSignal(job)` collects the posting's canonical skill ids per
 *   requiredness: `skills[]` + `requiredQualifications[]` → REQUIRED,
 *   `preferredQualifications[]` → PREFERRED (required wins on collision),
 *   plus the posting's meaningful title tokens and whether ANY usable
 *   signal exists. Unrecognized (non-vocabulary) posting skills are simply
 *   absent — never guessed.
 * - `skillTier(signal, profileSkillName)` → 'required' | 'preferred' |
 *   'neutral'. 'neutral' means "the posting did not name this skill" — it
 *   is NOT a judgment about the candidate.
 * - `entryRelevance(signal, texts)` → { relevant, reason }: relevant when
 *   the entry's title tokens overlap the posting title OR any of its texts
 *   mention a required/preferred posting skill (word-bounded via the
 *   vocabulary). When the posting offers NO usable signal at all, entries
 *   are 'relevant' by source order (conservative inclusion, no guessing).
 *   Reason strings are fixed, non-factual annotations.
 *
 * Pure: no DOM, no network, no storage, no clock.
 */
import type { JobPosting } from '../job-posting';
import {
  canonicalizeSkill,
  findSkillMentions,
  SKILL_VOCABULARY,
  titleTokens,
  type VocabularyEntry,
} from '../matching/vocabulary';

const SKILL_LABELS = new Map<string, string>(
  SKILL_VOCABULARY.map((e: VocabularyEntry) => [e.id, e.label]),
);

export interface JobSignal {
  /** Canonical skill ids the posting marks REQUIRED (skills[] + required quals). */
  required: Set<string>;
  /** Canonical skill ids the posting marks PREFERRED (preferred quals only). */
  preferred: Set<string>;
  /** Meaningful tokens of the posting's job title. */
  titleTokens: Set<string>;
  /** Display label for a canonical id (vocabulary label). */
  labelOf: (canonicalId: string) => string;
  /**
   * True when the posting provides any usable comparison signal (a
   * recognizable skill mention or a comparable title token). False = the
   * engine must fall back to conservative source-order inclusion.
   */
  hasSignal: boolean;
}

export function buildJobSignal(job: JobPosting): JobSignal {
  const required = new Set<string>();
  const preferred = new Set<string>();

  for (const line of [...job.skills, ...job.requiredQualifications]) {
    for (const id of findSkillMentions(line)) required.add(id);
  }
  for (const line of job.preferredQualifications) {
    for (const id of findSkillMentions(line)) {
      if (!required.has(id)) preferred.add(id);
    }
  }

  const jobTitleTokens = new Set(titleTokens(job.title));
  return {
    required,
    preferred,
    titleTokens: jobTitleTokens,
    labelOf: (id) => SKILL_LABELS.get(id) ?? id,
    hasSignal: required.size > 0 || preferred.size > 0 || jobTitleTokens.size > 0,
  };
}

/** Relevance tier of one PROFILE skill against the posting (never invents). */
export function skillTier(signal: JobSignal, profileSkillName: string): 'required' | 'preferred' | 'neutral' {
  const canonical = canonicalizeSkill(profileSkillName);
  if (canonical === null) return 'neutral';
  if (signal.required.has(canonical)) return 'required';
  if (signal.preferred.has(canonical)) return 'preferred';
  return 'neutral';
}

export interface EntryRelevance {
  relevant: boolean;
  /** Fixed-shape, non-factual annotation (never claims possession). */
  reason: string;
}

/**
 * Relevance of a profile entry (experience/project) from its title-ish text
 * and its factual texts (bullets, description, skill names).
 */
export function entryRelevance(
  signal: JobSignal,
  titleText: string,
  texts: string[],
): EntryRelevance {
  if (!signal.hasSignal) {
    return { relevant: true, reason: 'No usable posting signal — included from your profile as-is (source order).' };
  }

  const ownTitleTokens = titleTokens(titleText);
  let titleOverlap = false;
  for (const token of ownTitleTokens) {
    if (signal.titleTokens.has(token)) {
      titleOverlap = true;
      break;
    }
  }

  const requiredMentions = new Set<string>();
  const preferredMentions = new Set<string>();
  for (const text of texts) {
    for (const id of findSkillMentions(text)) {
      if (signal.required.has(id)) requiredMentions.add(id);
      else if (signal.preferred.has(id)) preferredMentions.add(id);
    }
  }

  if (requiredMentions.size > 0) {
    const labels = [...requiredMentions].map(signal.labelOf).slice(0, 4).join(', ');
    return { relevant: true, reason: `Mentions skills the posting requires: ${labels}.` };
  }
  if (titleOverlap) {
    return { relevant: true, reason: 'Title overlaps with the posted job title.' };
  }
  if (preferredMentions.size > 0) {
    const labels = [...preferredMentions].map(signal.labelOf).slice(0, 4).join(', ');
    return { relevant: true, reason: `Mentions skills the posting prefers: ${labels}.` };
  }
  return {
    relevant: false,
    reason: 'No overlap with the posted title or its stated skills — omitted from this tailored draft.',
  };
}
