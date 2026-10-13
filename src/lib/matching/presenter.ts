/**
 * Match summary presenter (Prompt 10) — pure view-model layer between the
 * deterministic matcher and the Options → Jobs UI.
 *
 * Turns a `JobMatchOutcome` (or a missing-input state) into a flat, fully
 * labeled view model the React component renders verbatim. Design rules:
 * - NO new scoring logic: every number and explanation comes straight from
 *   `calculateJobMatch`'s result contract. The presenter only labels/groups.
 * - UNKNOWN IS NEVER "MISSING": the four statuses are grouped separately with
 *   distinct labels and descriptions; unknown carries an explicit
 *   "not verified — never a confirmed gap" description.
 * - The numeric score is shown only when the outcome is a real score;
 *   insufficient-data and invalid outcomes get messages instead (never a
 *   misleading number).
 * - Only result fields reach the view: no contact details, no compensation,
 *   no legal answers can appear (they are not part of the result contract).
 * - Pure: no DOM, no network, no storage, no clock.
 */
import { MIN_SCORE_WEIGHT } from './factors';
import type { JobMatchOutcome } from './estimate';
import {
  MATCH_CATEGORIES,
  type HardIssue,
  type JobMatchResult,
  type MatchCategory,
  type MatchStatus,
  type Requiredness,
} from './schemas';

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export const CATEGORY_LABELS: Readonly<Record<MatchCategory, string>> = {
  skill: 'Skill',
  experience: 'Experience',
  education: 'Education',
  certification: 'Certification',
  location: 'Location',
  'work-arrangement': 'Work arrangement',
  'employment-type': 'Employment type',
  'experience-range': 'Experience range',
};

export const STATUS_LABELS: Readonly<Record<MatchStatus, string>> = {
  matched: 'Matched',
  partial: 'Partial',
  missing: 'Missing (confirmed gap)',
  unknown: 'Unknown (not verified)',
};

export const REQUIREDNESS_LABELS: Readonly<Record<Requiredness, string>> = {
  required: 'Required by posting',
  preferred: 'Preferred by posting',
  unknown: '',
};

export const SEVERITY_LABELS: Readonly<Record<HardIssue['severity'], string>> = {
  confirmed: 'Confirmed mismatch',
  potential: 'Potential mismatch',
  unknown: 'Unknown — evidence missing',
};

const FACTOR_LABELS: Readonly<Record<string, string>> = {
  requiredSkills: 'Required skills',
  preferredSkills: 'Preferred skills',
  experience: 'Relevant experience',
  roleAlignment: 'Role alignment',
  preferences: 'Your preferences',
};

const CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/* ------------------------------------------------------------------ */
/* View model types                                                    */
/* ------------------------------------------------------------------ */

export type MatchSummaryStatus =
  | 'ready'
  | 'insufficient-data'
  | 'invalid'
  | 'missing-profile'
  | 'missing-job'
  | 'settings-unavailable';

export interface RequirementView {
  id: string;
  label: string;
  categoryLabel: string;
  requirednessLabel: string;
  status: MatchStatus;
  statusLabel: string;
  explanation: string;
}

export interface RequirementGroupView {
  status: MatchStatus;
  label: string;
  description: string;
  items: RequirementView[];
}

export interface FactorView {
  factor: string;
  label: string;
  /** e.g. "35" (weight points out of 100). */
  weightLabel: string;
  /** e.g. "100" or "Not assessable" (null score). */
  scoreLabel: string;
  /** null when the factor could not be assessed. */
  score: number | null;
  explanation: string;
}

export interface HardIssueView {
  severity: HardIssue['severity'];
  severityLabel: string;
  label: string;
  explanation: string;
  categoryLabel: string;
}

export interface MatchSummaryView {
  status: MatchSummaryStatus;
  /** State-specific messages (missing inputs, invalid, insufficient data). */
  messages: string[];
  /** The headline estimate, or null when showing a number would mislead. */
  score: number | null;
  /** "72 / 100" when a score exists, otherwise "". */
  scoreLabel: string;
  /** Standard caption kept identical everywhere the estimate is shown. */
  estimateCaption: string;
  confidenceLabel: string | null;
  completenessLabel: string | null;
  /** Assessable scoring weight, e.g. "90 of 100 points". */
  availableWeightLabel: string | null;
  thresholdLabel: string | null;
  /** Evidence-based one-line summary from the result contract. */
  summary: string;
  /** Always all four groups, in status order (empty groups included). */
  groups: RequirementGroupView[];
  factors: FactorView[];
  hardIssues: HardIssueView[];
}

/* ------------------------------------------------------------------ */
/* State views (missing inputs / failed validation)                    */
/* ------------------------------------------------------------------ */

const ESTIMATE_CAPTION =
  'Deterministic estimate computed offline from your saved profile and this posting — not an employer ATS score, interview probability, or guarantee.';

function stateView(status: MatchSummaryStatus, message: string): MatchSummaryView {
  return {
    status,
    messages: [message],
    score: null,
    scoreLabel: '',
    estimateCaption: ESTIMATE_CAPTION,
    confidenceLabel: null,
    completenessLabel: null,
    availableWeightLabel: null,
    thresholdLabel: null,
    summary: '',
    groups: [],
    factors: [],
    hardIssues: [],
  };
}

export function missingProfileView(): MatchSummaryView {
  return stateView(
    'missing-profile',
    'No usable master profile yet — the estimate needs your AI-safe profile. Add or repair it on the Profile tab, then return here.',
  );
}

export function missingJobView(): MatchSummaryView {
  return stateView(
    'missing-job',
    'Select a saved job to see its match estimate.',
  );
}

export function settingsUnavailableView(): MatchSummaryView {
  return stateView(
    'settings-unavailable',
    'Settings could not be loaded, so no estimate is shown (the threshold comparison would be unreliable). Fix them on the Settings & privacy tab.',
  );
}

/* ------------------------------------------------------------------ */
/* Result views                                                        */
/* ------------------------------------------------------------------ */

function toRequirementView(item: JobMatchResult['requirements'][number]): RequirementView {
  return {
    id: item.id,
    label: item.label,
    categoryLabel: CATEGORY_LABELS[item.category] ?? item.category,
    requirednessLabel: REQUIREDNESS_LABELS[item.requiredness] ?? '',
    status: item.status,
    statusLabel: STATUS_LABELS[item.status] ?? item.status,
    explanation: item.explanation,
  };
}

const GROUP_META: Readonly<Record<MatchStatus, { label: string; description: string }>> = {
  matched: {
    label: 'Matched',
    description: 'Verified against evidence already in your profile or settings.',
  },
  partial: {
    label: 'Partial',
    description: 'Related but not exact evidence, or a fit with caveats.',
  },
  missing: {
    label: 'Missing (confirmed)',
    description: 'Confirmed gaps: your profile or settings actively conflict with the requirement.',
  },
  unknown: {
    label: 'Unknown (not verified)',
    description:
      'Insufficient information to decide — NOT a confirmed gap. Absence of evidence never counts against you as a missing qualification.',
  },
};

function buildGroups(requirements: JobMatchResult['requirements']): RequirementGroupView[] {
  const order: MatchStatus[] = ['matched', 'partial', 'missing', 'unknown'];
  return order.map((status) => ({
    status,
    label: GROUP_META[status].label,
    description: GROUP_META[status].description,
    items: requirements.filter((r) => r.status === status).map(toRequirementView),
  }));
}

function thresholdLabelFor(result: JobMatchResult): string | null {
  const t = result.threshold;
  if (t.decision === 'disabled') return `Threshold: off (your minimum is 0)`;
  if (t.decision === 'insufficient-data') {
    return `Threshold: not evaluated — insufficient data (your minimum is ${t.configured})`;
  }
  return t.meets
    ? `Threshold: meets your minimum of ${t.configured}`
    : `Threshold: below your minimum of ${t.configured}`;
}

/** View for a completed `calculateJobMatch` result (score OR insufficient-data). */
export function matchSummaryFromResult(result: JobMatchResult): MatchSummaryView {
  const hasScore = result.estimate.outcome === 'score';
  const messages: string[] = [];
  if (result.estimate.outcome === 'insufficient-data') {
    messages.push(result.estimate.reason);
    messages.push(
      `No numeric score is shown: fewer than ${MIN_SCORE_WEIGHT}% of the scoring weight could be assessed.`,
    );
  }

  return {
    status: hasScore ? 'ready' : 'insufficient-data',
    messages,
    score: hasScore && result.estimate.outcome === 'score' ? result.estimate.score : null,
    scoreLabel:
      hasScore && result.estimate.outcome === 'score' ? `${result.estimate.score} / 100` : '',
    estimateCaption: ESTIMATE_CAPTION,
    confidenceLabel: `${CONFIDENCE_LABELS[result.confidence.level] ?? result.confidence.level} confidence`,
    completenessLabel: `${result.confidence.completeness}% completeness (${result.confidence.counts.assessed} of ${result.confidence.counts.total} items decidable)`,
    availableWeightLabel: `${result.estimate.availableWeight} of 100 points assessable (a score needs at least ${MIN_SCORE_WEIGHT})`,
    thresholdLabel: thresholdLabelFor(result),
    summary: result.summary,
    groups: buildGroups(result.requirements),
    factors: result.estimate.factors.map((f) => ({
      factor: f.factor,
      label: FACTOR_LABELS[f.factor] ?? f.factor,
      weightLabel: `${f.weight}`,
      scoreLabel: f.score === null ? 'Not assessable' : `${Math.round(f.score)}`,
      score: f.score,
      explanation: f.explanation,
    })),
    hardIssues: result.hardIssues.map((i) => ({
      severity: i.severity,
      severityLabel: SEVERITY_LABELS[i.severity] ?? i.severity,
      label: i.label,
      explanation: i.explanation,
      categoryLabel: CATEGORY_LABELS[i.category] ?? i.category,
    })),
  };
}

/** View for a typed `calculateJobMatch` outcome (valid or invalid input). */
export function buildMatchSummaryView(outcome: JobMatchOutcome): MatchSummaryView {
  if (outcome.kind === 'invalid') {
    const shown = outcome.issues.slice(0, 5);
    return stateView(
      'invalid',
      `The inputs failed validation, so no estimate is shown: ${shown.join('; ')}${outcome.issues.length > shown.length ? ' …' : ''}`,
    );
  }
  return matchSummaryFromResult(outcome.result);
}
