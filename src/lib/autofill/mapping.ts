/**
 * AI-assisted semantic field mapping (Prompt 17) — a NARROW suggestion layer.
 *
 * It maps an ELIGIBLE, non-sensitive form field (one the deterministic
 * classifier could not confidently recognise) to an EXISTING supported saved
 * answer category. It never produces an answer, never fills a field, and never
 * touches the DOM directly.
 *
 * Safety invariants (enforced here, not just documented):
 * - AI stays OFF by default: `requestMappingProposal()` checks
 *   `settings.aiEnabled` first and makes ZERO provider calls when it is false.
 * - The request carries only the minimum: an opaque field id, a short
 *   normalized label, the control kind, and the fixed list of answer categories
 *   the user actually has saved answers for. NO field values, no profile/job
 *   text, no DOM/HTML, no URLs, no employer content, no sensitive data.
 * - Exclusions win: password/auth, OTP, payment/bank, CAPTCHA, EEO/voluntary,
 *   compensation, legal/consent, work-authorization/sponsorship, multi-select,
 *   hidden/disabled/read-only, and already-recognised fields are NEVER sent.
 * - Strict zod schemas (`.strict()`) reject unknown/oversized payloads, unknown
 *   categories, duplicate/unknown field ids and malformed confidence.
 * - Suggestions below a conservative confidence threshold stay manual.
 * - Approved mappings flow through the EXISTING deterministic planner
 *   (`buildFillPlan` `categoryOverrides`) and the existing executor — AI never
 *   calls the executor, chooses a DOM element, or alters a confirmed plan.
 * - Reuses the existing provider transport + `AiError` types; it does NOT
 *   introduce another AI client, endpoint or credential.
 */
import { z } from 'zod';
import type { AiError } from '../ai/errors';
import type { AiProvider } from '../ai/provider';
import { callProviderOnce, mapProviderFailure } from '../ai/run';
import { profileSchema } from '../profile';
import { sensitiveProfileSchema } from '../sensitive';
import type { Settings } from '../settings';
import { classifyField, isCustomSelectionWidget, normalizeText } from './classify';
import {
  fieldDescriptorsSchema,
  formatIssues,
  type FieldCategory,
  type FieldDescriptor,
} from './schemas';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const MAPPING_SCHEMA_VERSION = '1';
export const MAPPING_TASK = 'map-fields' as const;

/** Cap on fields in one request/proposal. */
export const MAX_MAPPING_FIELDS = 25;
/** Cap on a single field label sent to the provider. */
export const MAX_MAPPING_LABEL_CHARS = 120;
/** Conservative: suggestions at/above this are proposed; below stay manual. */
export const MAPPING_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_MAPPING_TIMEOUT_MS = 15_000;

/**
 * Categories the AI may suggest. Deliberately EXCLUDES legal status
 * (workAuthorization, sponsorship — the model must never infer the applicant's
 * legal status) and state/country (no saved source in the current schemas).
 * A suggestion is only ever a pointer to a saved answer category.
 */
export const AI_MAPPABLE_CATEGORIES = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'city',
  'linkedin',
  'portfolio',
  'skills',
  'summary',
] as const;
export type AiMappableCategory = (typeof AI_MAPPABLE_CATEGORIES)[number];

/** Control kinds an eligible field can have (mirrors the autofill descriptor). */
export const MAPPING_INPUT_KINDS = ['text', 'textarea', 'select', 'radio', 'checkbox'] as const;
export type MappingInputKind = (typeof MAPPING_INPUT_KINDS)[number];

/** Fixed reason codes the provider may return (short, bounded, non-executable). */
export const MAPPING_REASONS = ['label-match', 'synonym', 'context', 'other'] as const;
export type MappingReason = (typeof MAPPING_REASONS)[number];

/* ------------------------------------------------------------------ */
/* Strict request schema (the ONLY thing sent)                         */
/* ------------------------------------------------------------------ */

export const mappingRequestFieldSchema = z
  .object({
    /** Opaque id assigned by the scan; maps back locally, never a selector. */
    fieldId: z.string().min(1).max(80),
    /** Short normalized label/accessible name — no values, no page content. */
    label: z.string().trim().min(1).max(MAX_MAPPING_LABEL_CHARS),
    kind: z.enum(MAPPING_INPUT_KINDS),
  })
  .strict();
export type MappingRequestField = z.infer<typeof mappingRequestFieldSchema>;

export const mappingRequestSchema = z
  .object({
    schemaVersion: z.literal(MAPPING_SCHEMA_VERSION),
    task: z.literal(MAPPING_TASK),
    /** The fixed set of categories the user actually has saved answers for. */
    allowedCategories: z.array(z.enum(AI_MAPPABLE_CATEGORIES)).min(1).max(AI_MAPPABLE_CATEGORIES.length),
    fields: z.array(mappingRequestFieldSchema).min(1).max(MAX_MAPPING_FIELDS),
  })
  .strict();
export type MappingRequest = z.infer<typeof mappingRequestSchema>;

/* ------------------------------------------------------------------ */
/* Strict response schema                                              */
/* ------------------------------------------------------------------ */

export const mappingSuggestionSchema = z
  .object({
    fieldId: z.string().min(1).max(80),
    category: z.enum(AI_MAPPABLE_CATEGORIES),
    confidence: z.number().min(0).max(1),
    reason: z.enum(MAPPING_REASONS),
  })
  .strict();
export type MappingSuggestion = z.infer<typeof mappingSuggestionSchema>;

export const mappingResponseSchema = z
  .object({
    schemaVersion: z.literal(MAPPING_SCHEMA_VERSION),
    task: z.literal(MAPPING_TASK),
    mappings: z.array(mappingSuggestionSchema).max(MAX_MAPPING_FIELDS),
  })
  .strict();
export type MappingResponse = z.infer<typeof mappingResponseSchema>;

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

/**
 * Defense-in-depth local gate: even a field the deterministic classifier
 * leaves 'ambiguous' is never sent if its label carries a sensitive indicator.
 */
const SENSITIVE_LABEL_INDICATORS =
  /\b(password|passcode|passphrase|pin|username|login|sign in|authenticat|otp|one time|two factor|2fa|verification code|security code|credit card|card number|cvv|cvc|billing|iban|bank|routing|payment|paypal|salary|compensation|pay rate|expected pay|desired pay|hourly rate|remuneration|gender|race|ethnic|veteran|disabilit|religion|sexual orientation|marital|ssn|social security|passport|date of birth|dob|work authoriz|sponsor|visa|immigration|citizen|permanent resident|legal|attest|certif|declar|consent|terms|agree|background check|drug test|opt in|opt out)\b/;

/** Short normalized label for a descriptor (never a value). */
function mappingLabel(descriptor: FieldDescriptor): string | undefined {
  const raw = descriptor.labelText ?? descriptor.ariaLabel ?? descriptor.placeholder;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_MAPPING_LABEL_CHARS);
}

export interface EligibleField {
  fieldId: string;
  label: string;
  kind: MappingInputKind;
  classificationKind: 'ambiguous' | 'unsupported';
}

/**
 * The ONLY fields that may be offered to the AI: those the deterministic
 * classifier left ambiguous/unsupported, that are interactable and
 * single-valued, that carry a usable non-sensitive label, and that are not
 * custom selection widgets (which the engine cannot fill reliably).
 */
export function eligibleMappingFields(descriptors: unknown): EligibleField[] {
  const parsed = fieldDescriptorsSchema.safeParse(descriptors);
  if (!parsed.success) return [];
  const out: EligibleField[] = [];
  for (const d of parsed.data) {
    if (out.length >= MAX_MAPPING_FIELDS) break;
    if (d.multiple === true || d.disabled === true || d.readOnly === true || d.hidden === true) continue;
    if (isCustomSelectionWidget(d)) continue;
    const classification = classifyField(d);
    if (classification.kind !== 'ambiguous' && classification.kind !== 'unsupported') continue;
    const label = mappingLabel(d);
    if (label === undefined) continue;
    if (SENSITIVE_LABEL_INDICATORS.test(normalizeText(label))) continue;
    out.push({
      fieldId: d.fieldId,
      label,
      kind: d.kind,
      classificationKind: classification.kind,
    });
  }
  return out;
}

/**
 * Categories the user actually has a saved answer for — derived from the LOCAL
 * profile/sensitive records without sending them. A category with no saved
 * answer is never requested (test: missing answers stay manual).
 */
export function availableMappingCategories(profile: unknown, sensitive: unknown): AiMappableCategory[] {
  const p = profileSchema.safeParse(profile);
  const s = sensitiveProfileSchema.safeParse(sensitive);
  const contact = s.success ? s.data.contact : undefined;
  const prof = p.success ? p.data : undefined;
  const cats: AiMappableCategory[] = [];
  if (contact !== undefined) {
    if (contact.firstName.trim().length > 0) cats.push('firstName');
    if (contact.lastName.trim().length > 0) cats.push('lastName');
    if (contact.email.trim().length > 0) cats.push('email');
    if (contact.phone.trim().length > 0) cats.push('phone');
    if (contact.cityLabel !== undefined && contact.cityLabel.trim().length > 0) cats.push('city');
  }
  if (prof !== undefined) {
    if (prof.linkedin !== undefined) cats.push('linkedin');
    if (prof.portfolio !== undefined) cats.push('portfolio');
    if (prof.skills.length > 0) cats.push('skills');
    if (prof.summary !== undefined) cats.push('summary');
  }
  return cats;
}

/* ------------------------------------------------------------------ */
/* Request building                                                    */
/* ------------------------------------------------------------------ */

export type BuildMappingRequestResult =
  | { kind: 'ok'; request: MappingRequest; fields: EligibleField[] }
  | { kind: 'none'; reason: 'no-eligible-fields' | 'no-saved-answers' }
  | { kind: 'invalid'; issues: string[] };

/**
 * Build the minimal, strictly-validated provider request. If no safe minimal
 * request can be formed, returns a typed `none`/`invalid` result so the caller
 * never calls the provider.
 */
export function buildMappingRequest(
  descriptors: unknown,
  profile: unknown,
  sensitive: unknown,
): BuildMappingRequestResult {
  const fields = eligibleMappingFields(descriptors);
  if (fields.length === 0) return { kind: 'none', reason: 'no-eligible-fields' };

  const allowed = availableMappingCategories(profile, sensitive);
  if (allowed.length === 0) return { kind: 'none', reason: 'no-saved-answers' };

  const candidate = {
    schemaVersion: MAPPING_SCHEMA_VERSION,
    task: MAPPING_TASK,
    allowedCategories: allowed,
    fields: fields.map((f) => ({ fieldId: f.fieldId, label: f.label, kind: f.kind })),
  };
  const parsed = mappingRequestSchema.safeParse(candidate);
  if (!parsed.success) return { kind: 'invalid', issues: formatIssues(parsed.error) };
  return { kind: 'ok', request: parsed.data, fields };
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

export type MappingResponseValidation =
  | { ok: true; response: MappingResponse }
  | { ok: false; issues: string[] };

/**
 * Validate an untrusted provider response against the strict schema AND the
 * originating request: unknown categories, unknown/duplicate field ids and
 * malformed values are rejected. Issues are path-only (never values).
 */
export function validateMappingResponse(
  raw: unknown,
  request: MappingRequest,
): MappingResponseValidation {
  const parsed = mappingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: formatIssues(parsed.error).map((i) => `response.${i}`) };
  }
  const knownIds = new Set(request.fields.map((f) => f.fieldId));
  const allowed = new Set<string>(request.allowedCategories);
  const seen = new Set<string>();
  const issues: string[] = [];
  parsed.data.mappings.forEach((m, index) => {
    if (!knownIds.has(m.fieldId)) issues.push(`response.mappings.${index}.fieldId: unknown field`);
    if (seen.has(m.fieldId)) issues.push(`response.mappings.${index}.fieldId: duplicate field`);
    seen.add(m.fieldId);
    if (!allowed.has(m.category)) issues.push(`response.mappings.${index}.category: category not requested`);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, response: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Proposal (reviewable, value-free)                                   */
/* ------------------------------------------------------------------ */

const REASON_TEXT: Record<MappingReason, string> = {
  'label-match': 'The field label matches this saved answer category.',
  synonym: 'The field label is a recognized synonym for this category.',
  context: 'The surrounding label wording indicates this category.',
  other: 'An assisted match — review before approving.',
};

export interface MappingSuggestionEntry {
  fieldId: string;
  displayLabel: string;
  decision: 'suggest' | 'manual';
  category: AiMappableCategory | null;
  confidence: number | null;
  /** Fixed human-readable text; never model-generated instructions. */
  reason: string;
}

export interface MappingProposal {
  /** Bound to the scan session that produced it; a re-scan invalidates it. */
  scanId: string;
  entries: MappingSuggestionEntry[];
  suggestedCount: number;
}

/** Turn a validated response into a reviewable proposal (no values, no auto-write). */
export function buildMappingProposal(
  scanId: string,
  request: MappingRequest,
  response: MappingResponse,
): MappingProposal {
  const byId = new Map(response.mappings.map((m) => [m.fieldId, m]));
  const entries: MappingSuggestionEntry[] = request.fields.map((f) => {
    const suggestion = byId.get(f.fieldId);
    if (suggestion === undefined) {
      return {
        fieldId: f.fieldId,
        displayLabel: f.label,
        decision: 'manual',
        category: null,
        confidence: null,
        reason: 'No suggestion returned — complete it manually.',
      };
    }
    if (suggestion.confidence < MAPPING_CONFIDENCE_THRESHOLD) {
      return {
        fieldId: f.fieldId,
        displayLabel: f.label,
        decision: 'manual',
        category: suggestion.category,
        confidence: suggestion.confidence,
        reason: 'Low-confidence suggestion — left for manual completion.',
      };
    }
    return {
      fieldId: f.fieldId,
      displayLabel: f.label,
      decision: 'suggest',
      category: suggestion.category,
      confidence: suggestion.confidence,
      reason: REASON_TEXT[suggestion.reason],
    };
  });
  return { scanId, entries, suggestedCount: entries.filter((e) => e.decision === 'suggest').length };
}

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

export type ApproveMappingsResult =
  | { ok: true; categoryOverrides: Record<string, FieldCategory>; approvedCount: number }
  | { ok: false; reason: 'stale-session' };

/**
 * Convert explicit per-field user approvals into the planner's
 * `categoryOverrides`. Rejects a stale proposal (scan changed). Only entries
 * the model suggested AND the user approved are included — nothing is inferred.
 */
export function approveMappings(
  proposal: MappingProposal,
  approvedFieldIds: readonly string[],
  currentScanId: string,
): ApproveMappingsResult {
  if (proposal.scanId !== currentScanId) return { ok: false, reason: 'stale-session' };
  const approved = new Set(approvedFieldIds);
  const categoryOverrides: Record<string, FieldCategory> = {};
  for (const entry of proposal.entries) {
    if (entry.decision !== 'suggest' || entry.category === null) continue;
    if (!approved.has(entry.fieldId)) continue;
    categoryOverrides[entry.fieldId] = entry.category;
  }
  return { ok: true, categoryOverrides, approvedCount: Object.keys(categoryOverrides).length };
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export type MappingRunResult =
  /** `settings.aiEnabled` was false — the provider was NEVER called. */
  | { kind: 'ai-disabled' }
  /** No provider configured/available — nothing was called. */
  | { kind: 'provider-unavailable' }
  | { kind: 'no-eligible-fields' }
  | { kind: 'no-saved-answers' }
  | { kind: 'error'; error: AiError }
  | { kind: 'ok'; request: MappingRequest; proposal: MappingProposal };

export interface MappingProposalInput {
  descriptors: unknown;
  profile: unknown;
  sensitive: unknown;
  /** Only `aiEnabled` is read, locally. Settings are NEVER sent. */
  settings: Settings;
  /** Session token from the scan; the proposal is bound to it. */
  scanId: string;
  provider: AiProvider<MappingRequest> | null;
}

export interface MappingRunOptions {
  timeoutMs?: number;
}

/**
 * Run ONE mapping attempt. Order is deliberate: AI-disabled and
 * provider-unavailable short-circuit BEFORE any request is built or sent, so
 * the default configuration makes zero provider calls. Never throws for
 * expected failures — every outcome is a typed result.
 */
export async function requestMappingProposal(
  input: MappingProposalInput,
  options: MappingRunOptions = {},
): Promise<MappingRunResult> {
  if (!input.settings.aiEnabled) return { kind: 'ai-disabled' };
  if (input.provider === null) return { kind: 'provider-unavailable' };

  const built = buildMappingRequest(input.descriptors, input.profile, input.sensitive);
  if (built.kind === 'none') return { kind: built.reason };
  if (built.kind === 'invalid') {
    return { kind: 'error', error: { kind: 'invalid-request', issues: built.issues } };
  }

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_MAPPING_TIMEOUT_MS));
  const { outcome, fault } = await callProviderOnce(input.provider, built.request, 1, timeoutMs);

  if (outcome.kind === 'response') {
    const validated = validateMappingResponse(outcome.raw, built.request);
    if (!validated.ok) {
      return { kind: 'error', error: { kind: 'invalid-response', issues: validated.issues } };
    }
    return {
      kind: 'ok',
      request: built.request,
      proposal: buildMappingProposal(input.scanId, built.request, validated.response),
    };
  }
  if (fault !== undefined) {
    return { kind: 'error', error: { kind: 'provider-fault', errorName: fault.errorName } };
  }
  return { kind: 'error', error: mapProviderFailure(outcome.failure).error };
}
