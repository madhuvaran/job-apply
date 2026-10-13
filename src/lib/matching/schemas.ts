/**
 * Result contract for the deterministic job match estimate (Prompt 09).
 *
 * Every object is `.strict()` so the result can never smuggle extra data
 * (contact details, compensation, legal answers) through a loose field, and
 * every human-facing string is length-bounded. Labels may quote the posting's
 * own requirement text (bounded to 120 chars); explanations are fixed-shape
 * templates over counts and labels — never full job-description content,
 * never candidate contact data.
 *
 * This module is pure (no DOM, no network, no storage, no clock).
 */
import { z } from 'zod';

export const MATCH_SCHEMA_VERSION = '1';

export const MATCH_CATEGORIES = [
  'skill',
  'experience',
  'education',
  'certification',
  'location',
  'work-arrangement',
  'employment-type',
  'experience-range',
] as const;
export type MatchCategory = (typeof MATCH_CATEGORIES)[number];

export const MATCH_STATUSES = ['matched', 'partial', 'missing', 'unknown'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const REQUIREDNESS = ['required', 'preferred', 'unknown'] as const;
export type Requiredness = (typeof REQUIREDNESS)[number];

export const ISSUE_SEVERITIES = ['confirmed', 'potential', 'unknown'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const MATCH_FACTORS = [
  'requiredSkills',
  'preferredSkills',
  'experience',
  'roleAlignment',
  'preferences',
] as const;
export type MatchFactor = (typeof MATCH_FACTORS)[number];

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const THRESHOLD_DECISIONS = ['pass', 'below', 'disabled', 'insufficient-data'] as const;
export type ThresholdDecision = (typeof THRESHOLD_DECISIONS)[number];

/* ------------------------------------------------------------------ */
/* Sub-schemas                                                         */
/* ------------------------------------------------------------------ */

/**
 * A pointer to existing profile (or settings) evidence by ID — never a copy
 * of candidate data. The matcher's output contains references only.
 */
export const matchEvidenceSchema = z
  .object({
    kind: z.enum(['skill', 'experience', 'education', 'certification', 'settings']),
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();
export type MatchEvidence = z.infer<typeof matchEvidenceSchema>;

/** One assessed requirement with an explainable match status. */
export const matchRequirementSchema = z
  .object({
    /** Stable slug, e.g. `skill:kubernetes`, `education:master`, `pref:location`. */
    id: z.string().min(1).max(80),
    /** Bounded display label (requirement text or canonical name). */
    label: z.string().min(1).max(120),
    category: z.enum(MATCH_CATEGORIES),
    requiredness: z.enum(REQUIREDNESS),
    status: z.enum(MATCH_STATUSES),
    evidence: z.array(matchEvidenceSchema).max(5).default([]),
    /** Short, fixed-shape explanation of the decision. */
    explanation: z.string().min(1).max(300),
  })
  .strict();
export type MatchRequirement = z.infer<typeof matchRequirementSchema>;

/** Per-factor score and weight; `score: null` = factor could not be assessed. */
export const matchFactorSchema = z
  .object({
    factor: z.enum(MATCH_FACTORS),
    weight: z.number().min(0).max(100),
    score: z.number().min(0).max(100).nullable(),
    explanation: z.string().min(1).max(300),
  })
  .strict();
export type MatchFactorResult = z.infer<typeof matchFactorSchema>;

/** Hard-requirement issue, reported SEPARATELY from the numeric estimate. */
export const hardIssueSchema = z
  .object({
    requirementId: z.string().min(1).max(80),
    severity: z.enum(ISSUE_SEVERITIES),
    category: z.enum(MATCH_CATEGORIES),
    label: z.string().min(1).max(120),
    explanation: z.string().min(1).max(300),
  })
  .strict();
export type HardIssue = z.infer<typeof hardIssueSchema>;

const factorListSchema = z.array(matchFactorSchema).max(MATCH_FACTORS.length);

/**
 * The estimate itself. A numeric score is produced ONLY when enough factor
 * weight is assessable; otherwise an explicit `insufficient-data` outcome.
 */
export const matchEstimateSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('score'),
      score: z.number().int().min(0).max(100),
      factors: factorListSchema,
      /** Sum of factor weights that could actually be assessed (0–100). */
      availableWeight: z.number().min(0).max(100),
      explanation: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('insufficient-data'),
      reason: z.string().min(1).max(300),
      factors: factorListSchema,
      availableWeight: z.number().min(0).max(100),
      explanation: z.string().min(1).max(300),
    })
    .strict(),
]);
export type MatchEstimate = z.infer<typeof matchEstimateSchema>;

/** Confidence = data completeness, NOT a statistical probability. */
export const matchConfidenceSchema = z
  .object({
    level: z.enum(CONFIDENCE_LEVELS),
    /** Percent of assessed (decisive) requirement items, rounded. */
    completeness: z.number().int().min(0).max(100),
    counts: z
      .object({
        total: z.number().int().min(0),
        assessed: z.number().int().min(0),
        matched: z.number().int().min(0),
        partial: z.number().int().min(0),
        missing: z.number().int().min(0),
        unknown: z.number().int().min(0),
      })
      .strict(),
    explanation: z.string().min(1).max(300),
  })
  .strict();
export type MatchConfidence = z.infer<typeof matchConfidenceSchema>;

/** Threshold decision, independent of the score itself. */
export const matchThresholdSchema = z
  .object({
    configured: z.number().int().min(0).max(100),
    /** False when `minMatchThreshold` is 0 (filtering disabled). */
    filtering: z.boolean(),
    /** null when filtering is disabled or no score could be computed. */
    meets: z.boolean().nullable(),
    decision: z.enum(THRESHOLD_DECISIONS),
  })
  .strict();
export type MatchThresholdResult = z.infer<typeof matchThresholdSchema>;

/** Full deterministic match-estimate result. */
export const matchResultSchema = z
  .object({
    schemaVersion: z.literal(MATCH_SCHEMA_VERSION),
    estimate: matchEstimateSchema,
    /** Every assessed requirement, including unknowns (full evidence visible). */
    requirements: z.array(matchRequirementSchema).max(120),
    /** Hard-requirement issues, separate from the aggregate score. */
    hardIssues: z.array(hardIssueSchema).max(60),
    confidence: matchConfidenceSchema,
    threshold: matchThresholdSchema,
    /** Concise, evidence-based summary for the decision-maker. */
    summary: z.string().min(1).max(400),
  })
  .strict();
export type JobMatchResult = z.infer<typeof matchResultSchema>;

export type MatchValidationResult =
  | { ok: true; result: JobMatchResult }
  | { ok: false; issues: string[] };

/** Validate an untrusted object against the strict result schema. */
export function validateMatchResult(payload: unknown): MatchValidationResult {
  const parsed = matchResultSchema.safeParse(payload);
  if (parsed.success) return { ok: true, result: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.code}`,
    ),
  };
}
