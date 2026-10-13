/**
 * Public entry point for the deterministic job match estimate (Prompt 09).
 *
 * `calculateJobMatch(profile, job, settings)`:
 * - validates all three inputs with the EXISTING zod schemas (invalid input
 *   returns a typed `invalid` result with path+code issues — never PII and
 *   never job-description content);
 * - assesses requirements (see requirements.ts) and scores the documented
 *   weighted factors (see factors.ts);
 * - reports hard-requirement issues SEPARATELY from the score;
 * - reports confidence/data completeness (NOT a statistical probability);
 * - evaluates the existing `settings.minMatchThreshold` without ever
 *   changing the score to force a threshold outcome (0 = filtering off;
 *   insufficient data never counts as a pass).
 *
 * This module is deterministic and OFFLINE: no network, no AI/LLM calls, no
 * storage access, no clock (the posting's own `capturedAt` is the as-of
 * date), no mutation of inputs, and it never touches the sensitive profile,
 * contact details, legal/voluntary answers or compensation values.
 */
import { profileSchema, type Profile } from '../profile';
import { jobPostingSchema, type JobPosting } from '../job-posting';
import { settingsSchema, type Settings } from '../settings';
import { computeFactors, MATCH_WEIGHTS, MIN_SCORE_WEIGHT, type FactorComputation } from './factors';
import { assessRequirements, type AssessmentItem } from './requirements';
import {
  matchResultSchema,
  MATCH_SCHEMA_VERSION,
  type HardIssue,
  type JobMatchResult,
  type MatchConfidence,
  type MatchEstimate,
  type MatchRequirement,
  type MatchThresholdResult,
} from './schemas';

export type JobMatchOutcome =
  | { kind: 'valid'; result: JobMatchResult }
  | { kind: 'invalid'; issues: string[] };

/** Confidence banding thresholds (documented completeness percentages). */
export const CONFIDENCE_HIGH_MIN = 75;
export const CONFIDENCE_MEDIUM_MIN = 40;

function formatIssues(prefix: string, issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>): string[] {
  // Path + zod issue CODE only — values and messages are deliberately dropped
  // so an error can never quote personal information.
  return issues.map((i) => `${prefix}.${i.path.map(String).join('.') || '(root)'}: ${i.code}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildEstimate(factors: FactorComputation[]): MatchEstimate {
  const available = factors.filter((f) => f.score !== null);
  const availableWeight = available.reduce((sum, f) => sum + f.weight, 0);
  const explanationOf = (f: FactorComputation): string =>
    `${f.factor} (${f.weight}%): ${f.score === null ? 'not assessable' : `${Math.round(f.score)}/100`} — ${f.explanation}`;

  if (availableWeight >= MIN_SCORE_WEIGHT) {
    const weighted = available.reduce(
      (sum, f) => sum + (f.score ?? 0) * f.weight,
      0,
    );
    const score = clamp(Math.round(weighted / availableWeight), 0, 100);
    return {
      outcome: 'score',
      score,
      factors,
      availableWeight,
      explanation: `Score is the weighted average of ${available.length} assessable factor(s) (${availableWeight}% of total weight). ${available.map(explanationOf).join(' ')}`.slice(0, 300),
    };
  }
  return {
    outcome: 'insufficient-data',
    reason: `Only ${availableWeight}% of the scoring weight could be assessed (minimum ${MIN_SCORE_WEIGHT}%) — a numeric score would be misleading.`,
    factors,
    availableWeight,
    explanation: `Too little of the posting and profile can be compared to produce a score. ${available.map(explanationOf).join(' ')}`.slice(0, 300),
  };
}

function buildConfidence(items: AssessmentItem[]): MatchConfidence {
  const counts = { total: 0, assessed: 0, matched: 0, partial: 0, missing: 0, unknown: 0 };
  for (const item of items) {
    counts.total += 1;
    switch (item.status) {
      case 'matched':
        counts.matched += 1;
        counts.assessed += 1;
        break;
      case 'partial':
        counts.partial += 1;
        counts.assessed += 1;
        break;
      case 'missing':
        counts.missing += 1;
        counts.assessed += 1;
        break;
      default:
        counts.unknown += 1;
    }
  }
  const completeness =
    counts.total === 0 ? 0 : clamp(Math.round((counts.assessed / counts.total) * 100), 0, 100);
  const level = completeness >= CONFIDENCE_HIGH_MIN ? 'high' : completeness >= CONFIDENCE_MEDIUM_MIN ? 'medium' : 'low';
  return {
    level,
    completeness,
    counts,
    explanation: `${counts.assessed} of ${counts.total} requirement item(s) could be decided from real data (${completeness}% completeness, ${level} confidence). This measures data availability, not probability of success.`,
  };
}

function buildThreshold(
  settings: Settings,
  estimate: MatchEstimate,
): MatchThresholdResult {
  const configured = settings.minMatchThreshold;
  if (configured === 0) {
    return {
      configured,
      filtering: false,
      meets: null,
      decision: 'disabled',
    };
  }
  if (estimate.outcome === 'insufficient-data') {
    // Insufficient data must NEVER be silently treated as a successful match.
    return {
      configured,
      filtering: true,
      meets: false,
      decision: 'insufficient-data',
    };
  }
  const meets = estimate.score >= configured;
  return {
    configured,
    filtering: true,
    meets,
    decision: meets ? 'pass' : 'below',
  };
}

function buildSummary(
  estimate: MatchEstimate,
  confidence: MatchConfidence,
  hardIssues: HardIssue[],
  threshold: MatchThresholdResult,
): string {
  const counts = confidence.counts;
  const scorePart =
    estimate.outcome === 'score'
      ? `Match estimate ${estimate.score}/100.`
      : 'No match estimate — insufficient comparable data.';
  const issuePart =
    hardIssues.length === 0
      ? 'No hard-requirement issues found.'
      : `${hardIssues.length} hard-requirement issue(s): ${hardIssues
          .slice(0, 3)
          .map((i) => `${i.label} (${i.severity})`)
          .join('; ')}.`;
  const thresholdPart =
    threshold.decision === 'disabled'
      ? 'Threshold filtering is off.'
      : threshold.decision === 'pass'
        ? `Meets your ${threshold.configured} threshold.`
        : threshold.decision === 'below'
          ? `Below your ${threshold.configured} threshold.`
          : `Cannot confirm against your ${threshold.configured} threshold (insufficient data).`;
  return `${scorePart} ${counts.matched} matched, ${counts.partial} partial, ${counts.missing} confirmed gap(s), ${counts.unknown} unverifiable. ${issuePart} ${thresholdPart} This is our own transparent estimate, not an employer ATS score.`.slice(0, 400);
}

/**
 * Deterministic, offline job match estimate. Identical validated inputs
 * always produce identical output. Never throws for expected failures.
 */
export function calculateJobMatch(
  profile: Profile,
  job: JobPosting,
  settings: Settings,
): JobMatchOutcome {
  const profileCheck = profileSchema.safeParse(profile);
  if (!profileCheck.success) {
    return { kind: 'invalid', issues: formatIssues('profile', profileCheck.error.issues) };
  }
  const jobCheck = jobPostingSchema.safeParse(job);
  if (!jobCheck.success) {
    return { kind: 'invalid', issues: formatIssues('job', jobCheck.error.issues) };
  }
  const settingsCheck = settingsSchema.safeParse(settings);
  if (!settingsCheck.success) {
    return { kind: 'invalid', issues: formatIssues('settings', settingsCheck.error.issues) };
  }

  // Inputs are re-ordered through their schemas so key order and defaults are
  // canonical: identical data always scores identically.
  const p = profileCheck.data;
  const j = jobCheck.data;
  const s = settingsCheck.data;

  const items = assessRequirements(p, j, s);
  const factors = computeFactors(items, p, j);
  const estimate = buildEstimate(factors);
  const requirements: MatchRequirement[] = items.map(({ issue: _issue, ...item }) => ({
    ...item,
    evidence: item.evidence ?? [],
  }));
  const hardIssues: HardIssue[] = items
    .filter((i) => i.issue !== undefined)
    .map((i) => ({
      requirementId: i.id,
      severity: i.issue?.severity ?? 'unknown',
      category: i.category,
      label: i.label,
      explanation: i.issue?.explanation ?? '',
    }));
  const confidence = buildConfidence(items);
  const threshold = buildThreshold(s, estimate);
  const summary = buildSummary(estimate, confidence, hardIssues, threshold);

  // Invariant: our own construction must satisfy the strict result schema.
  const result = matchResultSchema.parse({
    schemaVersion: MATCH_SCHEMA_VERSION,
    estimate,
    requirements,
    hardIssues,
    confidence,
    threshold,
    summary,
  });
  return { kind: 'valid', result };
}
