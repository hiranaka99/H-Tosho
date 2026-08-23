/**
 * Title normalization utilities for the auto-matcher.
 * Converts arbitrary manga/comic series titles into a canonical comparable
 * form, plus a pure-JS Levenshtein implementation (no native deps).
 */

/** Remove trailing volume/chapter/issue markers: "Vol. 3", "Chapter 12", "#5", "12", "(12)", "Part 2" */
export function stripVolumeMarkers(title: string): string {
  return title
    .replace(/\s*(?:vol(?:ume)?\.?\s*\d+\.?|chapter\s*\d+\.?|ch\.?\s*\d+\.?|episode\s*\d+\.?|ep\.?\s*\d+\.?|part\s*\d+\.?|issue\s*\d+\.?|no\.\s*\d+\.?)\b.*$/i, '')
    .replace(/\s*\(\d{1,4}\)\s*$/, '')
    .replace(/\s*\[\d{1,4}\]\s*$/, '')
    .replace(/\s*#\s*\d+$/, '')
    .replace(/\s+\d{1,4}$/, '');
}

/** Lowercase, remove punctuation, collapse whitespace, strip quotes/brackets. */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/&/g, ' and ')
    .replace(/['"\u2018\u2019\u201c\u201d]/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common romanized-variant aliases for cross-provider equivalence. */
const ALIASES: Record<string, string> = {
  'no': '', 'the': '', 'a': '', 'an': '',
  'gaiden': 'side story',
  'monogatari': 'story',
  'denki': 'electric',
  'sai': '',
};

export function canonicalize(normalized: string): string {
  const words = normalized.split(' ')
    .map((w) => (ALIASES[w] !== undefined ? ALIASES[w] : w))
    .filter((w) => w.length > 0)
    .sort();
  return words.join(' ');
}

/**
 * Classic Levenshtein edit distance (iterative, two rows).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 0..1 similarity (1 = identical). */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Strip volume markers, normalize and canonicalize a title into its
 * comparable form.
 */
export function canonicalTitle(raw: string): string {
  return canonicalize(normalizeTitle(stripVolumeMarkers(raw)));
}

/** Score two already-canonicalized titles (see canonicalTitle). */
export function scoreCanonical(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));

  // Token containment: every token of the shorter title appears in the other.
  // (Substring containment is unsafe: titles that normalize to fragments like
  // "re" would match inside unrelated words such as "harem".)
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let contained = true;
  for (const w of small) {
    if (!large.has(w)) { contained = false; break; }
  }
  if (contained) return 0.92;

  let inter = 0;
  ta.forEach((w) => { if (tb.has(w)) inter++; });
  const jaccard = inter / (ta.size + tb.size - inter || 1);
  const lev = similarity(a, b);
  return Math.max(0.5 * lev + 0.5 * jaccard, Math.min(lev, jaccard) * 0.95);
}

/**
 * Combined title score combining:
 *  - exact canonical match (1.0)
 *  - containment (one title contained in the other)
 *  - token Jaccard
 *  - Levenshtein similarity
 */
export function titleScore(kavitaTitle: string, candidateTitle: string): number {
  return scoreCanonical(canonicalTitle(kavitaTitle), canonicalTitle(candidateTitle));
}

/** Year bonus/penalty for candidate matches. */
export function yearBonus(kavitaYear: number | undefined, candidateYear: number | undefined): number {
  if (kavitaYear && candidateYear) {
    const diff = Math.abs(kavitaYear - candidateYear);
    if (diff === 0) return 0.05;
    if (diff <= 2) return 0.02;
    if (diff > 10) return -0.1;
  }
  return 0;
}

/** Minimum combined score to accept an automatic match. */
export const AUTO_MATCH_THRESHOLD = 0.72;
