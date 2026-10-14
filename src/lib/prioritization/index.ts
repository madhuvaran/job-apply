/**
 * Public surface of the freshness-aware job prioritization (Prompt 24).
 *
 * Pure, deterministic, local: `prioritizeJobs()` reuses the existing schemas
 * (job postings, application log, match results) and adds NO scoring logic of
 * its own. It reads no storage, uses no clock and makes no network/AI call.
 */
export * from './schemas';
export {
  comparePriorityEntries,
  prioritizeJobs,
  FRESHNESS_WINDOW_DAYS,
  type PrioritizationInput,
  type PrioritizationMatchInput,
} from './prioritize';
