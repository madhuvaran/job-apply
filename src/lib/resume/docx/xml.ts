/**
 * XML safety helpers for the minimal WordprocessingML writer (Prompt 20).
 *
 * The DOCX builder never concatenates untrusted text into markup directly: it
 * routes every value through `escapeXmlText`, and it refuses to emit a document
 * whose text contains characters XML 1.0 cannot represent (control characters,
 * lone surrogates, noncharacters) rather than writing a corrupted package.
 *
 * Pure module — no DOM, no network, no storage.
 */

/**
 * Is `codePoint` legal in XML 1.0 content?
 * Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Code points in `text` that XML 1.0 cannot represent. Unique and ascending, so
 * the caller can report a stable, content-free list. Iterating with `for…of`
 * walks whole code points, so a valid surrogate PAIR (e.g. an emoji) passes,
 * while a lone surrogate is reported.
 */
export function findUnsupportedXmlCodePoints(text: string): number[] {
  const found = new Set<number>();
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (!isXmlChar(codePoint)) found.add(codePoint);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Escape a value for an XML text node or an attribute value. All five XML
 * predefined entities are escaped, so the result is safe in either position.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
