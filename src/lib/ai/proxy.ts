/**
 * Backend-proxy provider (Prompt 06) — the ONLY production transport.
 *
 * PATTERN (documented in README): the extension never talks to Anthropic /
 * OpenAI / etc. directly and stores NO API keys. It POSTs the validated
 * `AiRequest` as JSON to the project's own backend endpoint; that server holds
 * the provider credential, forwards the prompt, and returns a JSON body
 * matching `aiResponseSchema`. Because the request goes to our own origin,
 * the extension needs no host permission for a third-party API, and a
 * compromised extension bundle still contains no secret.
 *
 * The options schema is `.strict()` and has NO credential field on purpose:
 * there is nowhere to put an API key, and passing one fails at construction.
 *
 * HTTP mapping:
 * - 429            -> rate-limited (+ `Retry-After` parsed to ms)
 * - 5xx            -> http, retryable
 * - other non-2xx  -> http, not retryable
 * - fetch/network   -> network (abort by our signal -> timeout)
 * - invalid JSON    -> malformed (typed `invalid-response` upstream)
 */
import { z } from 'zod';
import type { AiProvider, AiProviderCallContext, AiProviderOutcome } from './provider';
import type { AiRequest } from './schemas';

export const proxyProviderOptionsSchema = z
  .object({
    /** Absolute http(s) URL of the extension's OWN backend AI endpoint. */
    endpoint: z
      .url()
      .max(2048)
      .refine((u) => /^https?:\/\//i.test(u), {
        message: 'only http:// or https:// URLs are supported',
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

export type ProxyProviderOptions = z.infer<typeof proxyProviderOptionsSchema>;

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to milliseconds. */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function isAbortLike(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

/**
 * Create the production provider. Throws on INVALID OPTIONS only (programmer
 * error at wiring time — never during a request; requests return typed
 * results via `runAiRequest`).
 */
export function createProxyProvider(options: ProxyProviderOptions): AiProvider {
  const parsedOptions = proxyProviderOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    const issues = parsedOptions.error.issues
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    // Deliberately throws: misconfiguration is a wiring bug, not a runtime
    // AI failure. Contains field paths only (no values echoed back).
    throw new Error(`invalid proxy provider options: ${issues}`);
  }
  const { endpoint } = parsedOptions.data;
  const fetchImpl =
    parsedOptions.data.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));

  return {
    id: 'proxy',
    async send(request: AiRequest, ctx: AiProviderCallContext): Promise<AiProviderOutcome> {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          // NOTE: no Authorization / x-api-key header exists here — by design.
          body: JSON.stringify(request),
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
      if (res.status >= 500) {
        return { kind: 'failure', failure: { kind: 'http', status: res.status, retryable: true } };
      }
      if (!res.ok) {
        return { kind: 'failure', failure: { kind: 'http', status: res.status, retryable: false } };
      }

      try {
        const raw: unknown = await res.json();
        return { kind: 'response', raw };
      } catch {
        // Aborted while reading the body = our timeout; otherwise bad JSON.
        if (ctx.signal.aborted) return { kind: 'failure', failure: { kind: 'timeout' } };
        return { kind: 'failure', failure: { kind: 'malformed' } };
      }
    },
  };
}
