/**
 * Step 1 of the current-resume export flow (Prompts 12, 19 & 20 follow-up):
 * tailor the AI-safe profile + selected posting EXACTLY ONCE into one strictly
 * validated `TailoredResume`.
 *
 * Why this module exists: the PDF export, the Word export and the explicit
 * "Save version to history" action must all operate on the SAME validated
 * payload. When each action tailored on its own (or a caller tailored again to
 * populate its cached result), one PDF action could run the tailoring engine
 * twice — a wasted, potentially divergent duplicate. Extracting the step makes
 * "tailor once, reuse everywhere" explicit, and the injectable `tailor`
 * parameter makes the guarantee assertable in tests instead of by reading the
 * source.
 *
 * Everything here is deterministic and offline: no AI, no network, no storage.
 * `tailorResume` itself never invents content, and failures are TYPED reasons
 * mapped to fixed, safe messages that carry no profile, resume or job text.
 */
import type { JobPosting } from '../job-posting';
import type { Profile } from '../profile';
import type { TailoredResume } from './schemas';
import { tailorResume, type TailorResult } from './tailor';

/** Why preparing a tailored resume failed (no rendering involved). */
export type PrepareFailureReason = 'no-profile' | 'insufficient' | 'invalid';

export type PrepareOutcome =
  | { ok: true; resume: TailoredResume }
  | { ok: false; reason: PrepareFailureReason };

/**
 * Which verb the failure text ends with: `generated` for a PDF/Word download,
 * `saved` for an explicit history save. Keeps each action's wording (and so
 * the existing user-visible behaviour) intact.
 */
export type PrepareOutcomeWord = 'generated' | 'saved';

/** Injectable tailoring engine — defaults to the real one (`tailorResume`). */
export type Tailor = (profile: Profile, job: JobPosting) => TailorResult;

/**
 * Tailor once: profile + job → one validated `TailoredResume`, or a typed
 * reason. Callers must pass the returned resume to every later step rather
 * than tailoring again.
 */
export function prepareTailoredResume(
  profile: Profile | null,
  job: JobPosting,
  tailor: Tailor = tailorResume,
): PrepareOutcome {
  if (profile === null) return { ok: false, reason: 'no-profile' };

  const tailored = tailor(profile, job);
  if (tailored.kind === 'insufficient') return { ok: false, reason: 'insufficient' };
  if (tailored.kind === 'invalid') return { ok: false, reason: 'invalid' };
  return { ok: true, resume: tailored.resume };
}

/** Fixed text for the missing-profile case (identical for every action). */
export const NO_PROFILE_MESSAGE = 'No saved profile is available yet — add your profile, then try again.';

function insufficientMessage(word: PrepareOutcomeWord): string {
  return `Your profile has no supported resume content yet (summary, skills, experience, projects, education, certifications or languages). ${
    word === 'saved' ? 'Nothing was saved.' : 'Nothing was generated.'
  }`;
}

function invalidMessage(word: PrepareOutcomeWord): string {
  return word === 'saved'
    ? 'The saved profile or job posting could not be validated, so no version was saved.'
    : 'The saved profile or job posting could not be validated, so no resume was generated.';
}

/**
 * The fixed, content-free message for a prepared-resume failure. The wording
 * is action-specific (`generated` / `saved`) but the text is constant — no
 * profile, resume or job content is ever included.
 */
export function prepareFailureMessage(reason: PrepareFailureReason, word: PrepareOutcomeWord): string {
  if (reason === 'no-profile') return NO_PROFILE_MESSAGE;
  if (reason === 'insufficient') return insufficientMessage(word);
  return invalidMessage(word);
}
