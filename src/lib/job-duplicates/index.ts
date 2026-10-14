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
  normalizeIdentity,
  sourceDomain,
  DUPLICATE_METHOD_ORDER,
  type DuplicateCheckInput,
} from './duplicates';
export { lookupDuplicateJob, type DuplicateLookupFailureReason, type DuplicateLookupOutcome } from './service';
