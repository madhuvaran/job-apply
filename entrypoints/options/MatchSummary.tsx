/**
 * Match summary (Prompt 10) — renders the deterministic estimate for the
 * selected saved job inside Options → Jobs.
 *
 * - All numbers/explanations come from `calculateJobMatch` via the pure
 *   presenter (`src/lib/matching/presenter.ts`); this component adds no
 *   scoring logic and invents no explanations.
 * - Offline only: no network, no AI provider, no sensitive profile — props
 *   are the AI-safe profile, the selected posting, and job settings.
 * - The score is labelled an estimate (never an employer ATS score), and
 *   confidence/completeness + assessable weight are shown as separate
 *   badges. Unknown requirements render in their own group with a distinct
 *   label and dashed styling — never as "missing".
 * - Recalculates via useMemo whenever profile/job/settings props change.
 */
import { useMemo } from 'react';
import { calculateJobMatch } from '../../src/lib/matching';
import {
  buildMatchSummaryView,
  missingJobView,
  missingProfileView,
  settingsUnavailableView,
  type MatchSummaryView,
} from '../../src/lib/matching/presenter';
import type { Profile } from '../../src/lib/profile';
import type { JobPosting } from '../../src/lib/job-posting';
import type { Settings } from '../../src/lib/settings';

export interface MatchSummaryProps {
  /** AI-safe master profile (never the sensitive record). null = missing/unusable. */
  profile: Profile | null;
  /** Selected saved posting. null = nothing selected. */
  job: JobPosting | null;
  /** Loaded settings. null = unavailable (threshold comparison not trusted). */
  settings: Settings | null;
}

export function resolveMatchView(
  profile: Profile | null,
  job: JobPosting | null,
  settings: Settings | null,
): MatchSummaryView {
  if (job === null) return missingJobView();
  if (profile === null) return missingProfileView();
  if (settings === null) return settingsUnavailableView();
  return buildMatchSummaryView(calculateJobMatch(profile, job, settings));
}

export default function MatchSummary({ profile, job, settings }: MatchSummaryProps) {
  const view = useMemo(
    () => resolveMatchView(profile, job, settings),
    [profile, job, settings],
  );

  const hasBadges =
    view.confidenceLabel !== null ||
    view.completenessLabel !== null ||
    view.availableWeightLabel !== null ||
    view.thresholdLabel !== null;

  return (
    <section className="match-summary" aria-label="Match estimate" data-status={view.status}>
      <h3>Match estimate</h3>
      <p className="hint">{view.estimateCaption}</p>

      {view.messages.map((message) => (
        <p className="match-message" role="status" key={message}>
          {message}
        </p>
      ))}

      {view.score !== null && (
        <div className="match-headline">
          <span className="match-score" aria-label={`Estimate ${view.score} out of 100`}>
            {view.scoreLabel}
          </span>
          <span className="match-score-tag">estimate</span>
        </div>
      )}

      {hasBadges && (
        <div className="match-badges">
          {view.confidenceLabel !== null && (
            <span className="match-badge" data-field="confidence">
              Confidence: {view.confidenceLabel}
            </span>
          )}
          {view.completenessLabel !== null && (
            <span className="match-badge" data-field="completeness">
              {view.completenessLabel}
            </span>
          )}
          {view.availableWeightLabel !== null && (
            <span className="match-badge" data-field="available-weight">
              {view.availableWeightLabel}
            </span>
          )}
          {view.thresholdLabel !== null && (
            <span className="match-badge" data-field="threshold">{view.thresholdLabel}</span>
          )}
        </div>
      )}

      {view.hardIssues.length > 0 && (
        <div className="match-issues" data-field="hard-issues">
          <h4>Hard-requirement checks</h4>
          <ul>
            {view.hardIssues.map((issue, i) => (
              <li key={`${issue.label}-${i}`} data-severity={issue.severity}>
                <span className={`match-severity match-severity-${issue.severity}`}>
                  {issue.severityLabel}
                </span>
                <strong>{issue.label}</strong>
                <span className="hint">{issue.explanation}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.groups.map((group) => (
        <div className="match-group" data-status={group.status} key={group.status}>
          <h4>
            {group.label} ({group.items.length})
          </h4>
          <p className="hint">{group.description}</p>
          {group.items.length > 0 && (
            <ul className="match-requirements">
              {group.items.map((item) => (
                <li key={item.id} data-status={item.status}>
                  <span className={`match-status match-status-${item.status}`}>
                    {item.statusLabel}
                  </span>
                  <strong className="match-req-label">{item.label}</strong>
                  {item.requirednessLabel !== '' && (
                    <span className="match-requiredness">{item.requirednessLabel}</span>
                  )}
                  <span className="match-category">{item.categoryLabel}</span>
                  <p className="hint">{item.explanation}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {view.factors.length > 0 && (
        <div className="match-factors" data-field="factors">
          <h4>Scoring factors</h4>
          <table className="match-factor-table">
            <caption className="hint">
              Weights are our own documented heuristic and sum to 100; they do not reflect any
              employer&rsquo;s algorithm.
            </caption>
            <thead>
              <tr>
                <th scope="col">Factor</th>
                <th scope="col">Weight</th>
                <th scope="col">Score</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {view.factors.map((factor) => (
                <tr key={factor.factor} data-factor={factor.factor}>
                  <th scope="row">{factor.label}</th>
                  <td data-field="weight">{factor.weightLabel}</td>
                  <td data-field="factor-score">{factor.scoreLabel}</td>
                  <td className="hint">{factor.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view.summary !== '' && <p className="match-summary-text">{view.summary}</p>}
    </section>
  );
}
