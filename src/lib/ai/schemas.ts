/**
 * AI request/response contract (Prompt 06) — provider-agnostic and
 * zod-validated on BOTH sides.
 *
 * Design rules honored here (knowledge.md + Prompt 06):
 * - `.strict()` EVERYWHERE: unknown keys are rejected in the request, the
 *   job input, the embedded settings, the embedded profile, the response and
 *   the response `usage` block. A `salary`, `contact`, `apiKey` or cookie
 *   field can never ride along unnoticed.
 * - ONE CHOKEPOINT FOR OUTGOING DATA: `buildAiRequest()` (src/lib/ai/run.ts)
 *   is the only way requests are constructed and it projects settings through
 *   `settingsForProvider()` from src/lib/settings.ts, which strips `salary`.
 *   The embedded `providerSafeSettingsSchema` is strict, so a payload that
 *   still contains `salary` fails validation instead of being sent.
 * - AI-SAFE PROFILE ONLY: the embedded profile is `profileSchema` (the
 *   `job-profile.v2` record). Contact details, legal/EEO answers and
 *   documents live in a SEPARATE schema (src/lib/sensitive.ts) with no shared
 *   data keys, so they are structurally unable to appear here — and `.strict()`
 *   rejects them if someone passes the wrong record anyway.
 * - NO SECRETS: this contract carries no credential field of any kind.
 *   Provider authentication happens server-side (backend proxy, see README);
 *   the extension stores no API keys.
 *
 * This module is pure (no DOM, no network) and fully unit-testable.
 */
import { z } from 'zod';
import { profileSchema } from '../profile';
import { settingsSchema } from '../settings';
import {
  MAX_RAW_DESCRIPTION_CHARS,
  MAX_TEXT_FIELD_CHARS,
  MAX_TITLE_CHARS,
} from '../job-posting';

/** Version of the request/response wire contract between extension and provider. */
export const AI_SCHEMA_VERSION = '1';

/**
 * Machine-readable task ids. Extended only when a roadmap feature needs a new
 * task; providers switch on this value to pick their prompt template.
 * - `tailor-resume`: select/reorder/reword EXISTING profile content for a job.
 * - `draft-answer`: propose an application answer FROM the saved profile
 *   content only (legal/EEO questions are never sent to a model).
 */
export const AI_TASKS = ['tailor-resume', 'draft-answer'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Cap on provider-produced content (matches the description cap's order of magnitude). */
export const MAX_AI_RESPONSE_CONTENT_CHARS = 50_000;
/** Cap on the embedded settings payload (defensive; settings are small). */
export const MAX_AI_SETTINGS_JSON_CHARS = 20_000;

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

/**
 * The job the AI should work on. Uses the same conservative caps as the
 * JobPosting model (title 200, short fields 200, description 100k) and
 * rejects whitespace-only descriptions. Extra keys (cookies, tokens, parsed
 * garbage) are rejected by `.strict()`.
 */
export const aiJobInputSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
    company: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    location: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    /** Verbatim description text as stored (`rawDescription`). Never normalized. */
    description: z
      .string()
      .max(MAX_RAW_DESCRIPTION_CHARS)
      .refine((s) => s.trim().length > 0, { message: 'description must not be empty' }),
  })
  .strict();

export type AiJobInput = z.infer<typeof aiJobInputSchema>;

/**
 * Settings as they may appear in an outgoing payload: the `settingsSchema`
 * shape MINUS `salary` (compensation never goes to an LLM), strict — so a
 * `salary` key that somehow bypassed `settingsForProvider()` still fails
 * validation. Mirrors `ProviderSafeSettings` in src/lib/settings.ts.
 */
export const providerSafeSettingsSchema = settingsSchema.omit({ salary: true }).strict();

/**
 * The complete provider-agnostic request. Every provider receives exactly
 * this object (serialized as JSON by the backend-proxy provider).
 */
export const aiRequestSchema = z
  .object({
    schemaVersion: z.literal(AI_SCHEMA_VERSION),
    task: z.enum(AI_TASKS),
    job: aiJobInputSchema,
    /** The AI-safe professional profile (`job-profile.v2`) — never the sensitive record. */
    profile: profileSchema,
    /** Output of `settingsForProvider()`; `salary` absent by construction AND by schema. */
    settings: providerSafeSettingsSchema,
  })
  .strict();

export type AiRequest = z.infer<typeof aiRequestSchema>;

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

/**
 * The provider's response. Strict — a backend that injects extra fields
 * (debug dumps, raw provider payloads, echoed credentials) fails validation
 * and surfaces as a typed `invalid-response` error instead of leaking through.
 */
export const aiResponseSchema = z
  .object({
    schemaVersion: z.literal(AI_SCHEMA_VERSION),
    /** Must echo the request's task. */
    task: z.enum(AI_TASKS),
    /** Model-produced (or local-fallback) content. */
    content: z
      .string()
      .max(MAX_AI_RESPONSE_CONTENT_CHARS)
      .refine((s) => s.trim().length > 0, { message: 'content must not be empty' }),
    /** Which backend produced it (e.g. 'proxy', 'mock', 'local'). Never a credential. */
    provider: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(120).optional(),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).max(10_000_000),
        outputTokens: z.number().int().min(0).max(10_000_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AiResponse = z.infer<typeof aiResponseSchema>;
export type AiUsage = NonNullable<AiResponse['usage']>;

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * PII-safe issue strings for typed error results: field path + zod issue
 * message (the same shape `validateSettings()` uses). Request payloads are
 * AI-safe-only by construction, so no sensitive value can be quoted here.
 */
export function formatZodIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map((iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.message}`);
}

export type AiValidationResult =
  | { ok: true; request: AiRequest }
  | { ok: false; issues: string[] };

/** Validate an untrusted object against the strict request schema. */
export function validateAiRequest(payload: unknown): AiValidationResult {
  const parsed = aiRequestSchema.safeParse(payload);
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, issues: formatZodIssues(parsed.error.issues) };
}

export type AiResponseValidationResult =
  | { ok: true; response: AiResponse }
  | { ok: false; issues: string[] };

/** Validate an untrusted object against the strict response schema. */
export function validateAiResponse(payload: unknown): AiResponseValidationResult {
  const parsed = aiResponseSchema.safeParse(payload);
  if (parsed.success) return { ok: true, response: parsed.data };
  return { ok: false, issues: formatZodIssues(parsed.error.issues) };
}
