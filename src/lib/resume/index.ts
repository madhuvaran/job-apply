/**
 * Public surface of the deterministic resume tailoring engine (Prompt 11).
 *
 * `tailorResume(profile, job)` returns a typed result (`ok` / `insufficient`
 * / `invalid`) holding a strictly validated `tailoredResumeSchema` payload
 * for a LATER fixed-layout PDF renderer (rendering is NOT part of this
 * module). Deterministic, offline, AI-safe-profile only — no sensitive
 * profile, no network, no storage writes.
 */
export * from './schemas';
export {
  buildJobSignal,
  entryRelevance,
  skillTier,
  type EntryRelevance,
  type JobSignal,
} from './relevance';
export { tailorResume, type TailorResult } from './tailor';
