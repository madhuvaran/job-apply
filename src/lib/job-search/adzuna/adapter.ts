/**
 * Adzuna adapter (Prompt 27): binds the pure Adzuna validation + normalization
 * to the provider-agnostic orchestrator in `../service.ts`.
 *
 * Kept separate from the transport so `runJobSearch()` never imports anything
 * Adzuna-specific, and so tests can swap a deterministic fake adapter in.
 */
import type { JobSearchAdapter } from '../service';
import type { NormalizedSearchResults, SearchValidation } from '../schemas';
import { normalizeAdzunaSearchResponse } from './normalize';
import { ADZUNA_PROVIDER_ID, validateAdzunaSearchRequest, type AdzunaSearchRequest } from './schemas';

export interface AdzunaAdapterOptions {
  /**
   * Injected clock for the `searchedAt` timestamp. Defaults to the real clock;
   * tests pass a fixed value so the normalized page is byte-identical.
   */
  now?: () => string;
}

/** The adapter `runJobSearch()` needs for the Adzuna provider. */
export function createAdzunaAdapter(
  options: AdzunaAdapterOptions = {},
): JobSearchAdapter<AdzunaSearchRequest> {
  return {
    providerId: ADZUNA_PROVIDER_ID,
    validateRequest: (payload: unknown): SearchValidation<AdzunaSearchRequest> =>
      validateAdzunaSearchRequest(payload),
    interpret: (
      raw: unknown,
      context: { request: AdzunaSearchRequest },
    ): SearchValidation<NormalizedSearchResults> =>
      normalizeAdzunaSearchResponse(raw, {
        request: context.request,
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
  };
}
