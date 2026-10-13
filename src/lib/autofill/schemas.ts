/**
 * Autofill foundation schemas (Prompt 14) — strict, AI-free, local-only.
 *
 * Three shapes, kept deliberately separate so classification, planning and
 * execution can be tested independently:
 *
 * 1. `fieldDescriptorSchema` — a VALUE-FREE description of one form control
 *    (kind, DOM metadata, label text). Existing field values are NEVER read or
 *    represented here.
 * 2. `fillPlanSchema` — the reviewed, validated set of instructions produced by
 *    the planner. Only instructions appear; nothing is executed during planning.
 * 3. `fillReportSchema` — per-field execution outcomes (fixed, value-free
 *    messages).
 *
 * All objects are `.strict()` so unknown keys are rejected at every boundary.
 */
import { z } from 'zod';

export const AUTOFILL_SCHEMA_VERSION = '1';

/** Hard cap on how many controls one page scan may return. */
export const MAX_SCAN_FIELDS = 200;
/** Cap on a single planned value (saved data, never page text). */
export const MAX_FILL_VALUE_CHARS = 2000;
/** Cap on one instruction list. */
export const MAX_FILL_INSTRUCTIONS = 200;

/* ------------------------------------------------------------------ */
/* Categories & element kinds                                          */
/* ------------------------------------------------------------------ */

/**
 * Field categories this foundation can recognise. State/region and country are
 * recognised for honest reporting but currently have NO saved source in the
 * profile schemas (they are reported as "no saved answer" rather than guessed).
 */
export const FIELD_CATEGORIES = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'city',
  'state',
  'country',
  'linkedin',
  'portfolio',
  'skills',
  'summary',
  'workAuthorization',
  'sponsorship',
] as const;
export type FieldCategory = (typeof FIELD_CATEGORIES)[number];

/** Element kinds the executor deliberately supports. */
export const FIELD_KINDS = ['text', 'textarea', 'select', 'radio', 'checkbox'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/* ------------------------------------------------------------------ */
/* 1. Field descriptor (value-free)                                    */
/* ------------------------------------------------------------------ */

export const fieldDescriptorSchema = z
  .object({
    /** Opaque id assigned by the page scan; maps to an element at fill time. */
    fieldId: z.string().min(1).max(80),
    kind: z.enum(FIELD_KINDS),
    /** `input.type` for text-like/checkbox/radio controls (e.g. 'email', 'tel'). */
    inputType: z.string().max(40).optional(),
    labelText: z.string().max(300).optional(),
    ariaLabel: z.string().max(300).optional(),
    /** `name` attribute (used for classification and radio grouping). */
    name: z.string().max(200).optional(),
    /** DOM `id` attribute (used for classification only). */
    elementId: z.string().max(200).optional(),
    autocomplete: z.string().max(200).optional(),
    placeholder: z.string().max(300).optional(),
  })
  .strict();
export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;

export const fieldDescriptorsSchema = z.array(fieldDescriptorSchema).max(MAX_SCAN_FIELDS);

/* ------------------------------------------------------------------ */
/* Classification result (typed, value-free)                           */
/* ------------------------------------------------------------------ */

export const CLASSIFICATION_KINDS = ['supported', 'unsupported', 'ambiguous', 'excluded'] as const;
export type ClassificationKind = (typeof CLASSIFICATION_KINDS)[number];

export type FieldClassification =
  /** A recognised, supported category with a saved source available. */
  | { kind: 'supported'; category: FieldCategory }
  /** Not a field we handle (e.g. a search box, a non-form control). */
  | { kind: 'unsupported'; reason: string }
  /** Looks like a form field but cannot be mapped unambiguously. */
  | { kind: 'ambiguous'; reason: string }
  /** A deliberately excluded category (password, payment, EEO, legal, …). */
  | { kind: 'excluded'; reason: string };

/* ------------------------------------------------------------------ */
/* 2. Fill plan (reviewed, validated)                                  */
/* ------------------------------------------------------------------ */

/** Where a planned value came from — sensitive data is never AI-safe. */
export const FILL_SOURCES = ['profile', 'sensitive'] as const;
export type FillSource = (typeof FILL_SOURCES)[number];

export const fillInstructionSchema = z
  .object({
    fieldId: z.string().min(1).max(80),
    category: z.enum(FIELD_CATEGORIES),
    value: z.string().min(1).max(MAX_FILL_VALUE_CHARS),
    source: z.enum(FILL_SOURCES),
    /** This foundation requires explicit user confirmation for every field. */
    requiresConfirmation: z.boolean(),
  })
  .strict();
export type FillInstruction = z.infer<typeof fillInstructionSchema>;

export const fillPlanSchema = z
  .object({
    schemaVersion: z.literal(AUTOFILL_SCHEMA_VERSION).default(AUTOFILL_SCHEMA_VERSION),
    instructions: z.array(fillInstructionSchema).max(MAX_FILL_INSTRUCTIONS),
  })
  .strict();
export type FillPlan = z.infer<typeof fillPlanSchema>;

/* ------------------------------------------------------------------ */
/* 3. Fill report (per-field outcomes, value-free)                     */
/* ------------------------------------------------------------------ */

/**
 * Per-field outcomes. `verify-failed` is returned when a write did not take
 * effect (the page rejected it, or a controlled input reverted it) — success is
 * never claimed without a verified post-fill state.
 */
export const FILL_STATUSES = [
  'filled',
  'not-found',
  'disconnected',
  'disabled',
  'read-only',
  'hidden',
  'unsupported-element',
  'no-match',
  'verify-failed',
  'error',
] as const;
export type FillStatus = (typeof FILL_STATUSES)[number];

export const fillFieldResultSchema = z
  .object({
    fieldId: z.string().min(1).max(80),
    status: z.enum(FILL_STATUSES),
    /** Fixed message; never contains the planned or page value. */
    message: z.string().min(1).max(200),
  })
  .strict();
export type FillFieldResult = z.infer<typeof fillFieldResultSchema>;

export const fillReportSchema = z
  .object({
    schemaVersion: z.literal(AUTOFILL_SCHEMA_VERSION).default(AUTOFILL_SCHEMA_VERSION),
    results: z.array(fillFieldResultSchema).max(MAX_FILL_INSTRUCTIONS),
    filledCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
  })
  .strict();
export type FillReport = z.infer<typeof fillReportSchema>;

/** Path+message issues for invalid payloads (never values). */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`);
}
