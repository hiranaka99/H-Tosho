/** Title keys for grouping search cards, never replacements for source titles.
 * Remove recognized catalogue annotations rather than every bracketed phrase:
 * chapter numbers, translator names, and other edition information remain.
 * Censorship labels are retained as an independent part of the group key. */
const compact = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function releaseLabel(value: string): boolean {
  return /^(?:un[ -]?censored|de[ -]?censored|censored)(?:\s+(?:ver(?:sion)?\.?|edition|release))?(?:\s+by\s+.+)?$/i.test(value.trim())
    || /^(?:digital|digital edition|digital version)$/i.test(value.trim());
}

export function unifiedTitleKey(title: string, artists: string[], language: string): string {
  const censorship = new Set([...title.normalize('NFKC').matchAll(/\b(?:un[ -]?censored|de[ -]?censored|censored)\b/gi)]
    .map((match) => match[0].toLowerCase() === 'censored' ? 'censored' : 'uncensored'));
  // Absence of a label says nothing about censorship. Conflicting labels
  // likewise must not silently join either explicit edition.
  const edition = censorship.size > 1 ? 'mixed' : [...censorship][0] ?? 'unmarked';
  const names = new Set(artists.map(compact).filter(Boolean));
  const languageLabels = new Set([language]);
  if (language === 'english') languageLabels.add('en');
  const annotation = (value: string): boolean => {
    const text = value.trim().toLowerCase();
    return releaseLabel(text) || languageLabels.has(text.replace(/\s+(?:translation|translated)$/, ''));
  };
  let core = title.normalize('NFKC').replace(
    /\[([^\[\]]*)\]|\(([^()]*)\)|【([^【】]*)】/gu,
    (whole, square: string | undefined, round: string | undefined, corner: string | undefined) => annotation(square ?? round ?? corner ?? '') ? ' ' : whole,
  );
  // A known author prefix and a numbered Comiket event are catalogue labels.
  // Unknown brackets are part of the title until proven otherwise.
  for (;;) {
    const prefix = /^\s*(?:\[([^\[\]]+)\]|\(([^()]+)\)|【([^【】]+)】)\s*/u.exec(core);
    if (!prefix) break;
    const text = prefix[1] ?? prefix[2] ?? prefix[3];
    if (!names.has(compact(text)) && !/^(?:c|comiket|comic market)\s*\d+$/i.test(text.trim())) break;
    core = core.slice(prefix[0].length);
  }
  // Also recognize an explicitly separated edition suffix, not ordinary words
  // in titles such as "Uncensored Love".
  const suffix = /\s+[-–—|]\s+([^\[\]()【】]+)\s*$/u.exec(core);
  if (suffix && releaseLabel(suffix[1])) core = core.slice(0, suffix.index);
  const normalized = compact(core);
  return normalized ? `${edition}:${normalized}` : '';
}
