/**
 * Public surface of the deterministic job match estimate (Prompt 09).
 *
 * `calculateJobMatch(profile, job, settings)` compares the posting's
 * structured requirements against the AI-safe profile and job settings —
 * offline, deterministic, explainable. It never calls the AI layer, never
 * reads the sensitive profile, and never touches the network or storage.
 */
export * from './schemas';
export * from './vocabulary';
export {
  assessRequirements,
  collectWantedSkills,
  observedCareerSpan,
  type AssessmentItem,
  type CareerSpan,
} from './requirements';
export {
  computeFactors,
  MATCH_WEIGHTS,
  MIN_SCORE_WEIGHT,
  type FactorComputation,
} from './factors';
export {
  calculateJobMatch,
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MEDIUM_MIN,
  type JobMatchOutcome,
} from './estimate';
export {
  buildMatchSummaryView,
  missingJobView,
  missingProfileView,
  matchSummaryFromResult,
  settingsUnavailableView,
  CATEGORY_LABELS,
  REQUIREDNESS_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  type FactorView,
  type HardIssueView,
  type MatchSummaryStatus,
  type MatchSummaryView,
  type RequirementGroupView,
  type RequirementView,
} from './presenter';
