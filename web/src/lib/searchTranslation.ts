import type { DoujinSort, DoujinSource } from './api';

export interface ProviderSearch {
  query: string;
  searchKey: string | null;
  sort: DoujinSort;
}

export interface SearchTranslation {
  query: string;
  sort: DoujinSort;
  /** Differences that require review before automatically running a search. */
  issues: string[];
}

export interface TranslationLink {
  from: DoujinSource;
  to: DoujinSource;
  input: ProviderSearch;
  output: ProviderSearch;
  issues: string[];
}

const aliases: Record<string, string> = {
  tags: 'tag', artists: 'artist', parodies: 'parody', characters: 'character',
  groups: 'group', languages: 'language', categories: 'category',
};
const sharedFields = new Set(['artist', 'group', 'parody', 'character', 'language']);
const categories = new Set(['doujinshi', 'manga', 'artistcg', 'gamecg', 'western', 'non-h']);
const sharedSorts = new Set<DoujinSort>(['default', 'popular-today', 'popular-week']);
const sortLabels: Record<DoujinSort, string> = {
  default: 'newest', popular: 'all-time popularity', 'popular-today': 'today’s popularity',
  'popular-week': 'weekly popularity', 'popular-month': 'monthly popularity',
  'popular-year': 'yearly popularity', 'date-published': 'publication date', random: 'random order',
};

function tokenize(query: string) {
  const terms: string[] = [];
  let term = '', quoted = false, escaped = false;
  for (const char of query) {
    if (escaped) { term += char; escaped = false; continue; }
    if (char === '\\') { term += char; escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (/\s/.test(char) && !quoted) {
      if (term) terms.push(term);
      term = '';
    } else term += char;
  }
  if (term) terms.push(term);
  return { terms, incomplete: quoted || escaped };
}

function unquote(value: string) {
  const inner = value.startsWith('"') ? value.slice(1).replace(/"$/, '') : value;
  return inner.replace(/\\(["\\])/g, '$1');
}

function quote(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Convert supported syntax; never guess a gender or silently discard a filter. */
export function translateSearch(query: string, from: DoujinSource, to: DoujinSource, sort: DoujinSort = 'default'): SearchTranslation {
  if (from === to) return { query, sort, issues: [] };
  const issues: string[] = [];
  const addIssue = (issue: string) => { if (!issues.includes(issue)) issues.push(issue); };
  const sourceName = to === 'hitomi' ? 'Hitomi.la' : to === 'ehentai' ? 'E-Hentai / ExHentai' : 'nHentai';
  const trimmed = query.trim();
  // Catalog IDs are unrelated: copying one can open a different gallery.
  if (/^(?:#\s*)?\d+$/.test(trimmed) || /^(?:https?:\/\/)?(?:www\.)?(?:nhentai\.net|hitomi\.la|e-hentai\.(?:org|com)|exhentai\.(?:org|com))\//i.test(trimmed)
    || /^\/(?:g|gallery|galleries|doujinshi|manga|cg)\//i.test(trimmed)) {
    return { query: '', sort: sharedSorts.has(sort) ? sort : 'default', issues: [`Gallery IDs and URLs cannot be transferred between providers. Search by title or artist instead.`] };
  }
  const punctuation: Record<string, string> = { '“': '"', '”': '"', '–': '-', '—': '-' };
  const normalized = query.replace(/[“”–—]/g, char => punctuation[char]);
  const { terms, incomplete } = tokenize(normalized);
  if (incomplete) addIssue('The query has an unfinished quote or escape. Check the translated text.');
  const out: string[] = [];
  const addKeywords = (value: string, prefix: string) => {
    for (const word of value.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (word.includes(':') || word.startsWith('-') || word === 'or') {
        addIssue(`The literal keyword ${quote(word)} would become an operator in Hitomi.la and was left out.`);
      } else out.push(`${prefix}${word}`);
    }
  };
  let ordering = sort.startsWith('popular') ? 'popular' : 'date';
  let orderKey = sort.startsWith('popular-') ? sort.slice(8) : sort === 'popular' ? 'year' : sort === 'date-published' ? 'published' : 'added';
  let direction = sort === 'random' ? 'random' : 'desc';

  for (const raw of terms) {
    if (from === 'hitomi' && raw.toLowerCase() === 'or') {
      addIssue('nHentai has no equivalent for OR. The translated terms require all matches.');
      continue;
    }
    if (from === 'ehentai' && raw.toLowerCase() === 'or') {
      if (to === 'nhentai') {
        addIssue('nHentai has no equivalent for OR. The translated terms require all matches.');
        continue;
      }
      out.push('or');
      continue;
    }
    const excluded = raw.startsWith('-');
    const term = excluded ? raw.slice(1) : raw;
    const field = /^([a-z_]+):(.*)$/is.exec(term);
    const namespace = field ? aliases[field[1].toLowerCase()] ?? field[1].toLowerCase() : null;
    let value = unquote(field ? field[2] : term);
    if (from === 'hitomi') value = value.replace(/_/g, ' ');
    const prefix = excluded ? '-' : '';
    if (from === 'hitomi' && field && /^(?:sort|order)by(?:key|direction)?$/.test(namespace!)) {
      if (excluded) { addIssue(`The excluded sort directive ${raw} has no equivalent.`); continue; }
      const v = value.toLowerCase().replace(/[^0-9a-z]/g, '');
      if (namespace!.endsWith('key')) orderKey = v;
      else if (namespace!.endsWith('direction')) direction = v;
      else if (v === 'popular' || v === 'popularity') ordering = 'popular';
      else if (v === 'date') ordering = 'date';
      else if (v === 'datepublished') { ordering = 'date'; orderKey = 'published'; }
      else if (v === 'random' || v === 'rand') direction = 'random';
      continue;
    }
    if (!value || value.includes(':') && to === 'hitomi' && namespace) {
      addIssue(`${raw} cannot be represented in ${sourceName} and was left out.`);
      continue;
    }
    if (namespace && sharedFields.has(namespace)) {
      if (namespace === 'language' && value.toLowerCase() === 'all' && to === 'nhentai') {
        addIssue('The all-languages filter cannot be transferred to nHentai with the app’s English default and was left out.');
      } else if (namespace === 'language' && value.toLowerCase() === 'all' && to === 'ehentai') {
        addIssue(`The all-languages filter cannot be represented in ${sourceName} and was left out.`);
      } else if (to === 'hitomi' && /["\\]/.test(value)) {
        addIssue(`${raw} contains characters Hitomi.la cannot represent and was left out.`);
      } else out.push(`${prefix}${namespace}:${to === 'hitomi' ? value.toLowerCase().replace(/\s+/g, '_') : quote(value)}`);
    } else if ((from === 'hitomi' && namespace === 'type') || (from === 'nhentai' && namespace === 'category')) {
      if (to === 'ehentai') {
        addIssue(`${raw} has no matching category in ${sourceName} and was left out.`);
      } else if (categories.has(value.toLowerCase())) out.push(`${prefix}${to === 'hitomi' ? 'type' : 'category'}:${to === 'hitomi' ? value.toLowerCase() : quote(value)}`);
      else addIssue(`${raw} has no matching category in ${sourceName} and was left out.`);
    } else if (to === 'nhentai' && ['female', 'male', 'mixed', 'other', 'tag'].includes(namespace ?? '')) {
      out.push(`${prefix}tag:${quote(value)}`);
      if (namespace !== 'tag') addIssue(`nHentai does not distinguish ${namespace} tags. Their tag names are preserved without gender scope.`);
    } else if (to === 'ehentai' && ['tag', 'male', 'female', 'mixed', 'other'].includes(namespace ?? '')) {
      if (namespace === 'tag') {
        out.push(prefix + value);
        addIssue(`Tag filters become keywords in ${sourceName}; their scope cannot be preserved.`);
      } else out.push(`${prefix}${namespace}:${value}`);
    } else if (to === 'hitomi' && (namespace === 'tag' || ['male', 'female', 'mixed', 'other', 'title', 'jtitle', 'japanese_title'].includes(namespace ?? ''))) {
      addKeywords(value, prefix);
      addIssue(`${namespace} filters become keywords in Hitomi.la; their scope and exact phrase matching cannot be preserved.`);
    } else if (namespace) {
      addIssue(`${raw} is unsupported by ${sourceName} and was left out.`);
    } else if (to === 'hitomi') {
      addKeywords(value, prefix);
      if (term.includes('"')) addIssue('Hitomi.la has no equivalent for exact quoted phrases. The translated words are separate keywords.');
    } else {
      // Ordinary keywords stay ordinary: quoting every word changes matching.
      out.push(...value.split(/\s+/).filter(Boolean).map(word => `${prefix}${word}`));
    }
  }

  let effectiveSort = sort;
  if (from === 'hitomi') {
    if (direction === 'random' || direction === 'rand') effectiveSort = 'random';
    else if (ordering === 'popular') {
      const popularity: Record<string, DoujinSort> = { today: 'popular-today', week: 'popular-week', month: 'popular-month', year: 'popular-year' };
      effectiveSort = popularity[orderKey] ?? 'popular-year';
    } else effectiveSort = orderKey === 'published' ? 'date-published' : 'default';
    if (direction === 'asc' || direction === 'ascending') addIssue('nHentai does not offer ascending order. Results use descending order.');
  }
  if (!sharedSorts.has(effectiveSort)) {
    addIssue(`${sourceName} has no matching ${sortLabels[effectiveSort]} sort. Sorting was reset to newest.`);
    effectiveSort = 'default';
  }
  return { query: out.join(' '), sort: effectiveSort, issues };
}

/** Preserve drafts and restore the exact original on an unchanged round trip. */
export function switchProviderSearch(current: ProviderSearch, from: DoujinSource, to: DoujinSource, previous?: TranslationLink | null) {
  if (previous?.from === to && previous.to === from && previous.output.query === current.query && previous.output.sort === current.sort) {
    return { search: previous.input, issues: [] as string[], link: null };
  }
  const translated = translateSearch(current.query, from, to, current.sort);
  const committed = current.searchKey === current.query.trim();
  const search: ProviderSearch = {
    query: translated.query, sort: translated.sort,
    searchKey: committed && !translated.issues.length ? translated.query.trim() || null : null,
  };
  return { search, issues: translated.issues, link: { from, to, input: current, output: search, issues: translated.issues } satisfies TranslationLink };
}
