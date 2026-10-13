import { describe, expect, it } from 'vitest';
import { findUnsupportedCodePoints, formatCodePoints, normalizeForPdf } from './text';

describe('normalizeForPdf', () => {
  it('normalizes line endings and tabs', () => {
    expect(normalizeForPdf('a\r\nb\rc\td')).toBe('a\nb\nc d');
  });

  it('maps typographic punctuation to ASCII equivalents (meaning preserved)', () => {
    expect(normalizeForPdf('\u2018a\u2019 \u201Cb\u201D \u2013 \u2014 \u2015 \u2026')).toBe(
      "'a' \"b\" - - - ...",
    );
  });

  it('converts non-breaking spaces/hyphens and removes zero-width marks', () => {
    expect(normalizeForPdf('a\u00A0b\u2011c\u200Bd\uFEFFe')).toBe('a b-cde');
  });

  it('preserves accented Latin-1 letters and the middle dot verbatim', () => {
    expect(normalizeForPdf('Caf\u00E9 na\u00EFve \u00B7 \u00FCber')).toBe(
      'Caf\u00E9 na\u00EFve \u00B7 \u00FCber',
    );
  });

  it('collapses runs of spaces and is idempotent', () => {
    const once = normalizeForPdf('a   b');
    expect(once).toBe('a b');
    expect(normalizeForPdf(once)).toBe('a b');
  });
});

describe('findUnsupportedCodePoints', () => {
  it('reports only code points the probe rejects, uniquely and in order', () => {
    const canEncode = (c: string): boolean => c.charCodeAt(0) < 128;
    expect(findUnsupportedCodePoints('a\u00E9\u65E5\u65E5b', canEncode)).toEqual([0x00e9, 0x65e5]);
  });

  it('returns nothing when everything is encodable', () => {
    expect(findUnsupportedCodePoints('plain', () => true)).toEqual([]);
  });
});

describe('formatCodePoints', () => {
  it('formats as U+XXXX tokens without leaking the source text', () => {
    expect(formatCodePoints([0x65e5, 0x000a])).toEqual(['U+65E5', 'U+000A']);
  });
});
