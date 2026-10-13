/**
 * Deterministic text preparation for the ATS-friendly resume PDF renderer
 * (Prompt 12).
 *
 * Pure functions — no DOM, no network, no pdf-lib dependency. The renderer
 * runs every resume string through `normalizeForPdf` BEFORE layout so that:
 * - identical inputs always produce identical glyph content (determinism),
 * - meaning is preserved (only meaning-preserving glyph substitutions),
 * - the layout engine never sees control characters or hard breaks it
 *   cannot wrap.
 *
 * WHAT IS CHANGED (documented, meaning-preserving only):
 * - CRLF / lone CR -> LF (hard line breaks handled by the wrapper).
 * - Tabs -> a single space.
 * - Non-breaking space / narrow no-break space -> a normal space.
 * - Non-breaking hyphen -> '-'.
 * - Zero-width / directional marks (ZWSP, ZWNJ, ZWJ, BOM, LRM, RLM, ALM) -> removed.
 * - Typographic punctuation -> the conventional ASCII equivalent
 *   (curly quotes -> ' / ", en/em dash & minus sign -> '-', ellipsis -> '...',
 *   typographic bullet -> '-'). This is friendlier to ATS text extraction and
 *   to the built-in PDF fonts, and does not alter meaning.
 * - Unicode line/paragraph separators -> LF.
 *
 * WHAT IS NOT CHANGED: letters, digits, and other punctuation are preserved
 * verbatim. Accented Latin-1 letters (e.g. 'é') pass through unchanged and are
 * encoded by the WinAnsi PDF font; characters outside that repertoire are
 * reported by `findUnsupportedCodePoints` so the renderer can return an
 * explicit typed error instead of emitting a silently corrupted resume.
 */

/** Meaning-preserving substitutions, applied in order. */
const SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Line endings / separators -> LF.
  [/\r\n?/g, '\n'],
  [/[\u2028\u2029]/g, '\n'],
  // Whitespace.
  [/\t/g, ' '],
  [/[\u00A0\u202F\u2007]/g, ' '],
  // Zero-width & directional marks.
  [/[\u200B\u200C\u200D\u200E\u200F\u061C\uFEFF]/g, ''],
  // Dashes / hyphen variants.
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],
  // Quotes.
  [/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  // Ellipsis / bullet.
  [/\u2026/g, '...'],
  [/[\u2022\u2023\u25AA\u25CF]/g, '-'],
  // Collapse runs of spaces introduced above.
  [/ {2,}/g, ' '],
];

/** Normalize one string deterministically. Never throws. */
export function normalizeForPdf(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Code points in `text` that the supplied WinAnsi probe cannot represent.
 * `canEncode` is injected (the renderer binds it to the actual PDF font), so
 * this module stays dependency-free and testable without pdf-lib.
 * Returns unique code points in first-seen order.
 */
export function findUnsupportedCodePoints(
  text: string,
  canEncode: (char: string) => boolean,
): number[] {
  const found: number[] = [];
  const seen = new Set<number>();
  for (const char of text) {
    if (canEncode(char)) continue;
    const cp = char.codePointAt(0);
    if (cp === undefined || seen.has(cp)) continue;
    seen.add(cp);
    found.push(cp);
  }
  return found;
}

/** Render a code point list as `U+XXXX` tokens (no source text — no PII). */
export function formatCodePoints(codePoints: number[]): string[] {
  return codePoints.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
}
