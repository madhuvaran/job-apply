/**
 * Adzuna provider (Prompt 27) — the ONLY Adzuna transport in this extension.
 *
 * WHY A PROXY. Adzuna's documented authentication is two QUERY parameters,
 * `app_id` and `app_key` (official OpenAPI spec, read 2026-10-14). A browser
 * extension cannot hold those safely: anything the extension sends is present
 * in the client, readable from the network panel and extractable from the
 * unpacked bundle, and any user of the extension would burn the developer's
 * quota. So this provider sends the validated search request to the project's
 * OWN server-side endpoint, which attaches the credentials and returns
 * Adzuna-shaped JSON. The extension stores no Adzuna key, has no field to
 * accept one, and never talks to api.adzuna.com.
 *
 * The options schema is `.strict()` with NO credential field on purpose —
 * passing `appId`/`appKey`/anything else fails validation, by design.
 *
 * HTTP mapping, using Adzuna's DOCUMENTED status codes (OpenAPI spec):
 * - 400 "Incorrect parameters"      -> provider-rejected (your request was wrong)
 * - 404 "Resource could not be found" -> provider-rejected (unknown country/page)
 * - 410 "Authorisation failed"      -> unauthenticated  (Adzuna's auth-failure code)
 * - 401 / 403                       -> unauthenticated
 * - 429                             -> rate-limited (+ Retry-After parsed to ms)
 * - 5xx                             -> server
 * - other non-2xx                   -> http (status preserved)
 *
 * CAVEAT: `429` (and `401`/`403`) are NOT in the search operation's documented
 * response list — only 200/400/404/410/500 are. They are mapped defensively as
 * the conventional meanings because exceeding Adzuna's documented access limits
 * must fail safely; the actual overage status is unverified until a live key is
 * configured (see docs/adzuna-integration.md §8).
 * - fetch/network throw              -> network (an abort by our signal -> timeout)
 * - body not JSON                    -> malformed
 *
 * The proxy is expected to FORWARD the upstream status codes; a proxy that
 * always answers 200 with an error body is a contract violation this file
 * cannot detect, which is documented as a limitation.
 *
 * No credentials, request content or response body ever appear in a failure.
 */
import { z } from 'zod';
import type {
  JobSearchCallContext,
  JobSearchProvider,
  JobSearchProviderOutcome,
} from '../provider';
import {
  adzunaSearchPath,
  buildAdzunaSearchQuery,
  type AdzunaSearchRequest,
} from './schemas';

/**
 * Provider options. `endpoint` is the project's own search proxy and MUST use
 * https (stricter than the AI proxy, which also permits http for local
 * development): this is the endpoint that holds a job-board key.
 */
export const adzunaProviderOptionsSchema = z
  .object({
    /** Absolute https URL of the extension's OWN Adzuna search proxy. */
    endpoint: z
      .url()
      .max(2048)
      .refine((u) => /^https:\/\//i.test(u), {
        message: 'the search proxy endpoint must use https://',
      }),
    /** Injectable fetch for tests. Defaults to globalThis.fetch. */
    fetchImpl: z
      .custom<(url: string, init: RequestInit) => Promise<Response>>(
        (fn) => typeof fn === 'function',
        { message: 'expected a function' },
      )
      .optional(),
  })
  .strict();

export type AdzunaProviderOptions = z.infer<typeof adzunaProviderOptionsSchema>;

export type AdzunaProviderOptionsValidation =
  | { ok: true; options: AdzunaProviderOptions }
  | { ok: false; issues: string[] };

/**
 * Non-throwing options validation — used by tests and by any future wiring that
 * wants to surface configuration problems instead of crashing.
 */
export function validateAdzunaProviderOptions(
  payload: unknown,
): AdzunaProviderOptionsValidation {
  const parsed = adzunaProviderOptionsSchema.safeParse(payload);
  if (parsed.success) return { ok: true, options: parsed.data };
  return {
    ok: false,
    // Field paths only — a rejected value (which could be a mistyped secret) is
    // never echoed back.
    issues: parsed.error.issues.map(
      (iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.message}`,
    ),
  };
}

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to milliseconds. */
export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function isAbortLike(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

/**
 * Build the request URL we hand to our own proxy: our proxy base + the Adzuna
 * path + the provider query, which NEVER contains credentials.
 */
export function buildAdzunaProxyUrl(endpoint: string, request: AdzunaSearchRequest): string {
  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const query = new URLSearchParams(buildAdzunaSearchQuery(request)).toString();
  return `${base}${adzunaSearchPath(request)}${query.length > 0 ? `?${query}` : ''}`;
}

/**
 * Create the Adzuna provider.
 *
 * Throws on INVALID OPTIONS only (a wiring bug at construction time — never a
 * credential, since there is no field for one). Requests always return typed
 * outcomes.
 */
export function createAdzunaProvider(
  options: AdzunaProviderOptions,
): JobSearchProvider<AdzunaSearchRequest> {
  const validated = validateAdzunaProviderOptions(options);
  if (!validated.ok) {
    // Contains field paths only (no values echoed).
    throw new Error(`invalid adzuna provider options: ${validated.issues.join('; ')}`);
  }
  const { endpoint } = validated.options;
  const fetchImpl =
    validated.options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));

  return {
    id: 'adzuna',
    async send(
      request: AdzunaSearchRequest,
      ctx: JobSearchCallContext,
    ): Promise<JobSearchProviderOutcome> {
      let res: Response;
      try {
        res = await fetchImpl(buildAdzunaProxyUrl(endpoint, request), {
          method: 'GET',
          headers: { accept: 'application/json' },
          // NOTE: no credential header and no credential query parameter exists
          // here — by design. The proxy authenticates server-side.
          signal: ctx.signal,
        });
      } catch (err) {
        if (isAbortLike(err, ctx.signal)) return { kind: 'failure', failure: { kind: 'timeout' } };
        return { kind: 'failure', failure: { kind: 'network' } };
      }

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        return {
          kind: 'failure',
          failure: {
            kind: 'rate-limited',
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        };
      }
      // Adzuna documents 410 as "Authorisation failed"; 401/403 are the
      // conventional codes and are treated the same way.
      if (res.status === 410 || res.status === 401 || res.status === 403) {
        return { kind: 'failure', failure: { kind: 'unauthenticated', status: res.status } };
      }
      // 400 "Incorrect parameters" / 404 "Resource could not be found".
      if (res.status === 400 || res.status === 404) {
        return { kind: 'failure', failure: { kind: 'provider-rejected', status: res.status } };
      }
      if (res.status >= 500) {
        return { kind: 'failure', failure: { kind: 'server', status: res.status } };
      }
      if (!res.ok) {
        return { kind: 'failure', failure: { kind: 'http', status: res.status } };
      }

      try {
        const raw: unknown = await res.json();
        return { kind: 'response', raw };
      } catch {
        // Aborted while reading the body = our timeout; otherwise unreadable JSON.
        if (ctx.signal.aborted) return { kind: 'failure', failure: { kind: 'timeout' } };
        return { kind: 'failure', failure: { kind: 'malformed' } };
      }
    },
  };
}
