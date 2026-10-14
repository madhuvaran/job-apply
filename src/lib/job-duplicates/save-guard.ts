/**
 * Pre-write duplicate gate (Prompt 26.1).
 *
 * `guardJobSave()` is the ONE decision both save entry points (the popup
 * capture preview and Options → Jobs) run IMMEDIATELY BEFORE they write a
 * posting. It re-reads the PERSISTED job postings every time through
 * `lookupDuplicateJob()` — never a component's possibly stale React state — so a
 * posting saved from another tab between an earlier check and the write is still
 * caught.
 *
 * Decisions:
 * - `proceed` — nothing matched (or the user explicitly overrode: see below);
 * - `blocked-duplicate` — a saved posting matched; the caller must stop and show
 *   the existing duplicate warning/review UI with this result;
 * - `blocked-check-failed` — the check could not run (malformed/unavailable
 *   storage, invalid identity or options). Storage is NEVER silently treated as
 *   empty, and the caller may still offer an explicit override.
 *
 * `override: true` is the user's deliberate "save a separate record" choice. It
 * skips ONLY this duplicate gate — it is per-attempt, never persisted, and it
 * does NOT bypass storage validation: the write still goes through the existing
 * `upsertJobPosting()` service, which refuses to touch malformed or unreadable
 * stored data.
 *
 * Read-only, offline, deterministic: no network, no AI, no clock, no telemetry.
 * Failure messages are fixed literals — no job content, no stored values.
 */
import { lookupDuplicateJob, type DuplicateLookupFailureReason } from './service';
import { duplicateCandidateSchema, type DuplicateCandidate, type DuplicateCheckResult } from './schemas';

export type SaveGuardDecision =
  | { kind: 'proceed' }
  | { kind: 'blocked-duplicate'; result: DuplicateCheckResult }
  | {
      kind: 'blocked-check-failed';
      reason: DuplicateLookupFailureReason;
      message: string;
    };

export interface SaveGuardInput {
  /** The posting about to be written (validated here, never trusted). */
  candidate: unknown;
  /** Saved job ids that must not count as a match (the record being edited). */
  excludeJobIds?: readonly string[];
  /** Explicit, per-attempt user override of the duplicate gate only. */
  override?: boolean;
}

const MESSAGE_INVALID_IDENTITY =
  'This posting could not be checked for duplicates because its identity fields are invalid. Nothing was saved.';

export async function guardJobSave(input: SaveGuardInput): Promise<SaveGuardDecision> {
  if (input.override === true) {
    // Deliberate user choice: skip ONLY the duplicate gate. The write itself
    // still validates the record and fails closed on untrusted storage.
    return { kind: 'proceed' };
  }

  const parsed = duplicateCandidateSchema.safeParse(input.candidate);
  if (!parsed.success) {
    return { kind: 'blocked-check-failed', reason: 'invalid', message: MESSAGE_INVALID_IDENTITY };
  }
  const candidate: DuplicateCandidate = parsed.data;

  const lookup = await lookupDuplicateJob(candidate, {
    ...(input.excludeJobIds === undefined ? {} : { excludeJobIds: [...input.excludeJobIds] }),
  });
  if (!lookup.ok) {
    return { kind: 'blocked-check-failed', reason: lookup.reason, message: lookup.message };
  }
  if (lookup.result.duplicate) {
    return { kind: 'blocked-duplicate', result: lookup.result };
  }
  return { kind: 'proceed' };
}
