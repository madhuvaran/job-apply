/**
 * Duplicate-check service (Prompt 26).
 *
 * A thin, READ-ONLY wrapper that loads the saved job list through the existing
 * storage abstraction and delegates the decision to the pure detector
 * (`findDuplicateJob`). It exists so both save entry points (the popup capture
 * preview and Options → Jobs) share one lookup instead of re-implementing it.
 *
 * Guarantees:
 * - Never writes: no insert, no update, no delete, no repair, no reset. A
 *   malformed stored list is reported, never touched (the save path itself
 *   already refuses to overwrite malformed data).
 * - Expected failures never throw: every outcome is a discriminated result with
 *   a fixed, privacy-safe message (no stored content, no page text, never a raw
 *   exception).
 * - Offline: no network, no AI provider, no sensitive profile, no telemetry.
 */
import { loadJobPostings } from '../storage';
import { findDuplicateJob } from './duplicates';
import type { DuplicateCandidate, DuplicateCheckResult } from './schemas';

export type DuplicateLookupFailureReason = 'malformed' | 'unavailable' | 'invalid';

export type DuplicateLookupOutcome =
  | { ok: true; result: DuplicateCheckResult }
  | { ok: false; reason: DuplicateLookupFailureReason; message: string };

const MESSAGE_INVALID_IDENTITY =
  'This posting could not be checked for duplicates because its identity fields are invalid. Nothing was saved.';

/**
 * Check one not-yet-saved posting against the saved jobs. Read-only; the saved
 * list is never modified, and a list that cannot be read is reported as such
 * rather than being treated as empty.
 */
export async function lookupDuplicateJob(
  candidate: DuplicateCandidate,
): Promise<DuplicateLookupOutcome> {
  const loaded = await loadJobPostings();
  if (!loaded.ok && loaded.reason !== 'absent') {
    return {
      ok: false,
      reason: loaded.reason === 'malformed' ? 'malformed' : 'unavailable',
      message: loaded.message,
    };
  }
  const savedJobs = loaded.ok ? loaded.data.postings : [];
  const outcome = findDuplicateJob({ candidate, savedJobs });
  if (outcome.kind === 'valid') return { ok: true, result: outcome.result };
  return { ok: false, reason: 'invalid', message: MESSAGE_INVALID_IDENTITY };
}
