/**
 * Public surface of the deterministic resume tailoring engine (Prompt 11).
 *
 * `tailorResume(profile, job)` returns a typed result (`ok` / `insufficient`
 * / `invalid`) holding a strictly validated `tailoredResumeSchema` payload
 * for a LATER fixed-layout PDF renderer (rendering is NOT part of this
 * module). Deterministic, offline, AI-safe-profile only — no sensitive
 * profile, no network, no storage writes.
 *
 * Prompt 19 adds the local tailored resume version history: strict schemas
 * (`./history.ts`) + the storage-backed domain service (`./history-service.ts`).
 * The schemas stay pure (no storage/PDF import) so persistence and rendering
 * remain in their own layers (`src/lib/storage.ts`, `src/lib/resume/pdf/`).
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
export * from './history';
export {
  deleteResumeVersion,
  getResumeVersion,
  listResumeVersions,
  saveResumeVersion,
  type ResumeHistoryErrorReason,
  type ResumeHistoryOutcome,
  type SaveResumeVersionInput,
} from './history-service';
