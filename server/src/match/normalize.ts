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
 * Classic Levenshtein edit distance (single Int32Array row with prefix/suffix trimming).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let start = 0;
  let aEnd = a.length;
  let bEnd = b.length;
  while (start < aEnd && start < bEnd && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  while (aEnd > start && bEnd > start && a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)) {
    aEnd--;
    bEnd--;
  }
  let aLen = aEnd - start;
  let bLen = bEnd - start;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let s1 = a;
  let s2 = b;
  if (aLen < bLen) {
    s1 = b;
    s2 = a;
    [aLen, bLen] = [bLen, aLen];
  }

  const row = new Int32Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) row[j] = j;
  for (let i = 1; i <= aLen; i++) {
    let prevDiag = i - 1;
    row[0] = i;
    const ch1 = s1.charCodeAt(start + i - 1);
    for (let j = 1; j <= bLen; j++) {
      const temp = row[j];
      if (ch1 === s2.charCodeAt(start + j - 1)) {
        row[j] = prevDiag;
      } else {
        let min = temp < row[j - 1] ? temp : row[j - 1];
        if (prevDiag < min) min = prevDiag;
        row[j] = min + 1;
      }
      prevDiag = temp;
    }
  }
  return row[bLen];
}

/** 0..1 similarity (1 = identical). */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

const CANONICAL_CACHE_MAX = 2048;
const canonicalCache = new Map<string, string>();

/**
 * Strip volume markers, normalize and canonicalize a title into its
 * comparable form.
 */
export function canonicalTitle(raw: string): string {
  const hit = canonicalCache.get(raw);
  if (hit !== undefined) {
    canonicalCache.delete(raw);
    canonicalCache.set(raw, hit);
    return hit;
  }
  const value = canonicalize(normalizeTitle(stripVolumeMarkers(raw)));
  if (canonicalCache.size >= CANONICAL_CACHE_MAX) {
    const oldest = canonicalCache.keys().next().value;
    if (oldest !== undefined) canonicalCache.delete(oldest);
  }
  canonicalCache.set(raw, value);
  return value;
}

/**
 * Separator-delimited parts of a series name, for fallback provider searches.
 * Kavita names often concatenate title + subtitle ("Aizome - Fill With LOVE")
 * and provider title search matches per title field — the compound string
 * matches nothing while each part does. Returns trimmed unique parts (>= 3
 * chars, max 3); empty when the name has no separator to split on.
 */
export function titleSearchParts(raw: string): string[] {
  const stripped = stripVolumeMarkers(raw).trim();
  const parts = stripped
    .split(/\s+[-–—]+\s*|\s*[:|]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);
  return [...new Set(parts)].slice(0, 3);
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
  let inter = 0;
  for (const w of small) {
    if (large.has(w)) inter++;
  }
  if (inter === small.size) return 0.92;

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

/** Minimum combined score to accept an automatic match. */
export const AUTO_MATCH_THRESHOLD = 0.72;
