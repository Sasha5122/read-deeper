export interface Anchor {
  char_start: number;
  char_end: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface ResolvedAnchor {
  start: number;
  end: number;
  /** true when offsets no longer matched and the quote had to be re-found */
  reanchored: boolean;
}

export const CONTEXT_CHARS = 30;

/** Build an anchor from a selection over the document's full text. */
export function makeAnchor(fullText: string, start: number, end: number): Anchor {
  return {
    char_start: start,
    char_end: end,
    quote: fullText.slice(start, end),
    prefix: fullText.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: fullText.slice(end, end + CONTEXT_CHARS),
  };
}

/**
 * Resolve an anchor against (possibly reprocessed) document text.
 * 1. If the stored offsets still contain the exact quote, use them.
 * 2. Otherwise find every occurrence of the quote and score each by how well
 *    its surrounding text matches the stored prefix/suffix, breaking ties by
 *    distance from the original offset.
 * Returns null when the quote no longer exists in the document.
 */
export function resolveAnchor(fullText: string, anchor: Anchor): ResolvedAnchor | null {
  const { char_start, char_end, quote } = anchor;
  if (quote.length === 0) return null;

  if (fullText.slice(char_start, char_end) === quote) {
    return { start: char_start, end: char_end, reanchored: false };
  }

  const candidates: number[] = [];
  let idx = fullText.indexOf(quote);
  while (idx !== -1 && candidates.length < 200) {
    candidates.push(idx);
    idx = fullText.indexOf(quote, idx + 1);
  }
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const before = fullText.slice(Math.max(0, c - anchor.prefix.length), c);
    const after = fullText.slice(c + quote.length, c + quote.length + anchor.suffix.length);
    const score =
      overlapScore(before, anchor.prefix, true) +
      overlapScore(after, anchor.suffix, false) -
      Math.abs(c - char_start) / Math.max(fullText.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { start: best, end: best + quote.length, reanchored: true };
}

/** Count matching characters walking from the boundary outwards. */
function overlapScore(actual: string, expected: string, fromEnd: boolean): number {
  if (expected.length === 0) return 0;
  let matches = 0;
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = fromEnd ? actual[actual.length - 1 - i] : actual[i];
    const e = fromEnd ? expected[expected.length - 1 - i] : expected[i];
    if (a === e) matches++;
    else break;
  }
  return matches / expected.length;
}
