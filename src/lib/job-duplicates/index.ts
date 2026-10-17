/**
 * Public surface of deterministic duplicate-job detection (Prompt 26).
 *
 * `findDuplicateJob()` is pure and local (no storage/DOM/browser/network/AI/
 * clock, no mutation); `lookupDuplicateJob()` is the read-only storage wrapper
 * the save entry points use.
 */
export * from './schemas';
export {
  canonicalJobUrl,
  findDuplicateJob,
  findSavedJobDuplicates,
  normalizeIdentity,
  sourceDomain,
  DUPLICATE_METHOD_ORDER,
  type DuplicateCheckInput,
  type SavedDuplicatesInput,
  type SavedDuplicatesOutcome,
} from './duplicates';
export { lookupDuplicateJob, type DuplicateLookupFailureReason, type DuplicateLookupOutcome } from './service';
export {
  guardJobSave,
  type SaveGuardDecision,
  type SaveGuardInput,
} from './save-guard';
