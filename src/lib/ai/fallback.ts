/**
 * No-AI fallback (Prompt 06): what callers get when `aiEnabled` is false —
 * the default — instead of any provider call. ZERO network requests are made.
 *
 * Honesty rules (knowledge.md): the fallback NEVER generates, rewords or
 * invents anything. It renders only strings the candidate already stored in
 * the AI-safe profile, in stored order, so a caller that displays this content
 * shows the user's own material verbatim. Content is capped at the response
 * schema limit; an empty profile yields a fixed status literal (not invented
 * candidate data).
 */
import {
  aiResponseSchema,
  AI_SCHEMA_VERSION,
  MAX_AI_RESPONSE_CONTENT_CHARS,
  type AiRequest,
  type AiResponse,
} from './schemas';

/** Fixed literal for a profile with nothing stored yet (no data is invented). */
export const EMPTY_PROFILE_FALLBACK_TEXT = '(no saved profile content yet)';

const line = (text: string): string => `${text}\n`;

/** Plain-text rendering of resume-relevant profile sections, stored order only. */
export function renderProfilePlainText(request: AiRequest): string {
  const p = request.profile;
  const out: string[] = [];
  const push = (text: string): boolean => {
    // Respect the response content cap: stop cleanly instead of overflowing.
    const candidate = out.length === 0 ? text : `${out.join('')}${text}`;
    if (candidate.length > MAX_AI_RESPONSE_CONTENT_CHARS) return false;
    out.push(text);
    return true;
  };

  if (p.displayName) push(line(p.displayName));
  if (p.headline) push(line(p.headline));
  if (p.locationLabel) push(line(p.locationLabel));
  if (p.summary) push(line(p.summary));

  if (p.skills.length > 0) {
    if (!push('Skills\n')) return out.join('');
    for (const s of p.skills) if (!push(`- ${s.name}\n`)) return out.join('');
  }
  if (p.experience.length > 0) {
    if (!push('Experience\n')) return out.join('');
    for (const e of p.experience) {
      if (!push(`- ${e.title}, ${e.company} (${e.dates.start} – ${e.dates.end ?? 'ongoing'})\n`)) {
        return out.join('');
      }
      for (const b of e.bullets) if (!push(`  - ${b}\n`)) return out.join('');
    }
  }
  if (p.education.length > 0) {
    if (!push('Education\n')) return out.join('');
    for (const e of p.education) {
      const credential = e.credential ? `, ${e.credential}` : '';
      if (!push(`- ${e.institution}${credential}\n`)) return out.join('');
    }
  }
  if (p.certifications.length > 0) {
    if (!push('Certifications\n')) return out.join('');
    for (const c of p.certifications) if (!push(`- ${c.name}\n`)) return out.join('');
  }
  if (p.projects.length > 0) {
    if (!push('Projects\n')) return out.join('');
    for (const proj of p.projects) if (!push(`- ${proj.name}: ${proj.description}\n`)) return out.join('');
  }
  if (p.languages.length > 0) {
    if (!push('Languages\n')) return out.join('');
    for (const l of p.languages) if (!push(`- ${l.language} (${l.level})\n`)) return out.join('');
  }

  const text = out.join('').trim();
  return text.length > 0 ? text : EMPTY_PROFILE_FALLBACK_TEXT;
}

/** Plain-text rendering of the candidate's EXPLICITLY saved application answers. */
export function renderSavedAnswers(request: AiRequest): string {
  const answers = request.profile.preferences.applicationAnswers;
  if (answers.length === 0) return EMPTY_PROFILE_FALLBACK_TEXT;
  const text = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');
  return text.length > MAX_AI_RESPONSE_CONTENT_CHARS
    ? text.slice(0, MAX_AI_RESPONSE_CONTENT_CHARS)
    : text;
}

/**
 * Deterministic, schema-valid local response used when AI is disabled.
 * `provider: 'local'` marks it as NOT model-produced.
 */
export function localFallbackResponse(request: AiRequest): AiResponse {
  const content =
    request.task === 'draft-answer' ? renderSavedAnswers(request) : renderProfilePlainText(request);
  return aiResponseSchema.parse({
    schemaVersion: AI_SCHEMA_VERSION,
    task: request.task,
    content,
    provider: 'local',
  });
}
