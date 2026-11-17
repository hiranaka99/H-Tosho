/**
 * Unified-search common query: parse the user's provider-agnostic input once,
 * then compile it to each provider's actual syntax.
 *
 * Rules (plan P2.1):
 * - Keywords, quoted phrases, and the shared filters (artist, group, parody,
 *   character, language) with `-` exclusions are the supported surface.
 * - A filter that a provider cannot represent WITHOUT widening its query
 *   yields a per-lane `unsupported` state — never a silent drop.
 * - Provider-native operators (tag namespaces, gender scopes, sort directives,
 *   gallery IDs/URLs) belong to native Search, not unified search.
 */

import type { CommonSearchQuery } from '../contracts/doujin.js';

export const SHARED_FILTERS = ['artist', 'group', 'parody', 'character', 'language'] as const;
type SharedFilter = (typeof SHARED_FILTERS)[number];

/** Plural/alias spellings mapped onto the shared filter names. */
const FILTER_ALIASES_TO_CANONICAL: Record<string, SharedFilter> = {
  artists: 'artist',
  groups: 'group',
  circles: 'group',
  circle: 'group',
  parodies: 'parody',
  characters: 'character',
  languages: 'language',
};

/** Language names in the shared vocabulary (lowercase). Each lane validates
 *  against its own subset; unknown names surface as per-lane guidance. */
export const COMMON_LANGUAGE_NAMES = new Set([
  'all', 'afrikaans', 'arabic', 'bulgarian', 'catalan', 'chinese', 'czech', 'danish',
  'dutch', 'english', 'estonian', 'finnish', 'french', 'german', 'greek', 'hebrew',
  'hindi', 'hungarian', 'indonesian', 'italian', 'japanese', 'korean', 'lithuanian',
  'latvian', 'mongolian', 'norwegian', 'persian', 'polish', 'portuguese', 'romanian',
  'russian', 'serbian', 'slovak', 'slovenian', 'spanish', 'swedish', 'thai', 'turkish',
  'ukrainian', 'ukranian', 'vietnamese',
]);

/** nHentai's language codes, per its API. */
const NHENTAI_LANGUAGE_CODES: Record<string, string> = {
  all: '', // nHentai has no "all" filter; the lane treats it as no language filter
  afrikaans: 'af', arabic: 'ar', bulgarian: 'bg', catalan: 'ca', chinese: 'zh',
  czech: 'cs', danish: 'da', dutch: 'nl', english: 'en', estonian: 'et',
  finnish: 'fi', french: 'fr', german: 'de', greek: 'el', hebrew: 'he', hindi: 'hi',
  hungarian: 'hu', indonesian: 'id', italian: 'it', japanese: 'ja', korean: 'ko',
  lithuanian: 'lt', latvian: 'lv', mongolian: 'mn', norwegian: 'no', persian: 'fa',
  polish: 'pl', portuguese: 'pt', romanian: 'ro', russian: 'ru', serbian: 'sr',
  slovak: 'sk', slovenian: 'sl', spanish: 'es', swedish: 'sv', thai: 'th',
  turkish: 'tr', ukrainian: 'uk', ukranian: 'uk', vietnamese: 'vi',
};

export const MAX_QUERY_LENGTH = 400;

export interface ParsedCommonQuery {
  query?: CommonSearchQuery;
  error?: string;
}

interface ParsedTerm {
  excluded: boolean;
  kind: 'keyword' | 'phrase' | 'filter';
  namespace?: SharedFilter;
  value: string;
}

/** Tokenize raw input into plain terms, quoted phrases, and namespace filters.
 *  Rejects unmatched quotes, unknown namespace filters, and over-long input. */
export function parseCommonQuery(raw: string): ParsedCommonQuery {
  const input = raw.trim();
  if (!input) return { error: 'Enter a search query.' };
  if (input.length > MAX_QUERY_LENGTH) return { error: `The query is too long (max ${MAX_QUERY_LENGTH} characters).` };

  const terms: ParsedTerm[] = [];
  let i = 0;
  let quoted = false;
  let buffer = '';
  let pendingExclusion = false;

  const pushBuffer = () => {
    const value = buffer;
    buffer = '';
    if (!value.trim()) return;
    const field = /^([a-z_]+):(.*)$/is.exec(value);
    if (field) {
      const alias = field[1].toLowerCase();
      const canonical = alias in FILTER_ALIASES_TO_CANONICAL ? FILTER_ALIASES_TO_CANONICAL[alias] : SHARED_FILTERS.includes(alias as SharedFilter) ? alias as SharedFilter : null;
      if (canonical) {
        if (!canonicalFilterValue(canonical, field[2])) return;
        terms.push({ excluded: pendingExclusion, kind: 'filter', namespace: canonical, value: field[2].trim() });
      } else {
        terms.push({ __unsupportedFilter: alias } as unknown as ParsedTerm);
      }
    } else {
      terms.push({ excluded: pendingExclusion, kind: 'keyword', value: value.trim() });
    }
    pendingExclusion = false;
  };

  const canonicalFilterValue = (namespace: SharedFilter, value: string): boolean => {
    if (!value.trim()) return false;
    if (namespace === 'language') {
      const name = value.trim().toLowerCase().replace(/\s+/g, '');
      if (!COMMON_LANGUAGE_NAMES.has(name)) {
        terms.push({ __unsupportedFilter: 'language' } as unknown as ParsedTerm);
        return false;
      }
    }
    return true;
  };

  for (; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted) {
        // Closing quote: a phrase is always a keyword-position term.
        const value = buffer.trim();
        buffer = '';
        if (value) terms.push({ excluded: pendingExclusion, kind: 'phrase', value });
        quoted = false;
        pendingExclusion = false;
      } else {
        pushBuffer();
        quoted = true;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (!quoted) pushBuffer();
      else buffer += ch;
      continue;
    }
    if (ch === '-' && !quoted && !buffer && input[i + 1] !== '-' ) {
      pendingExclusion = true;
      continue;
    }
    buffer += ch;
  }
  if (quoted) return { error: 'The query has an unfinished quote. Close it with a matching quote.' };
  pushBuffer();

  if (!terms.length) return { error: 'Enter a search query.' };

  // Validate: sentinel terms mark unsupported filters/language values.
  for (const term of terms) {
    const alias = (term as { __unsupportedFilter?: string }).__unsupportedFilter;
    if (alias) {
      return { error: alias === 'language'
        ? 'That language is not a supported unified-search language. Try one like english, japanese, chinese, korean, or all.'
        : `Filter "${alias}" is not available in unified search. Use the native Search tab for provider-specific filters.` };
    }
  }

  const keywords = terms.filter((t) => t.kind === 'keyword' && !t.excluded).map((t) => t.value);
  const phrases = terms.filter((t) => t.kind === 'phrase' && !t.excluded).map((t) => t.value);
  const filters = terms.filter((t) => t.kind === 'filter' && !t.excluded).map((t) => ({ namespace: t.namespace!, value: t.value }));
  const exclusions = terms
    .filter((t) => t.excluded)
    .map((t) => (t.kind === 'filter' ? { namespace: t.namespace as string, value: t.value } : { namespace: null as string | null, value: t.value }));

  if (!keywords.length && !phrases.length && !filters.length && !exclusions.length) return { error: 'Enter a search query.' };

  return { query: { raw: input, keywords, phrases, filters, exclusions } };
}

export interface CompiledLaneQuery {
  /** The provider query text, ready for the provider's search seam. */
  query: string;
  /** Lane-level option (e.g. E-Hentai language via its own f_lang parameter). */
  language?: string;
  /** Set when a shared element cannot be represented without widening. */
  unsupported?: string;
}

/** Quote a value for providers whose syntax needs it. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Hitomi: namespace filters use underscored lowercase values; it has no
 *  parody namespace and no exact-phrase search (both are lane-level gaps). */
export function compileHitomi(q: CommonSearchQuery): CompiledLaneQuery {
  const out: string[] = [];
  let unsupported: string | undefined;
  const nsValue = (value: string) => value.toLowerCase().replace(/\s+/g, '_');
  for (const f of q.filters) {
    if (f.namespace === 'parody') {
      unsupported ??= 'Hitomi has no parody filter, so this search was not run there.';
      continue;
    }
    out.push(`${f.namespace}:${f.namespace === 'language' ? f.value.toLowerCase() : nsValue(f.value)}`);
  }
  for (const ex of q.exclusions) {
    if (ex.namespace === 'parody') {
      unsupported ??= 'Hitomi has no parody filter, so this exclusion was not applied there.';
      continue;
    }
    out.push(ex.namespace
      ? `-${ex.namespace}:${ex.namespace === 'language' ? ex.value.toLowerCase() : nsValue(ex.value)}`
      : `-${ex.value.replace(/\s+/g, '_')}`);
  }
  if (q.phrases.length && !unsupported) {
    unsupported = 'Hitomi cannot search exact phrases, so this search was not run there.';
  }
  for (const kw of q.keywords) out.push(kw);
  return { query: out.join(' '), unsupported };
}

/** nHentai: namespaced filters are quoted; languages map to API codes. */
export function compileNhentai(q: CommonSearchQuery): CompiledLaneQuery {
  const out: string[] = [];
  let unsupported: string | undefined;
  for (const f of q.filters) {
    if (f.namespace === 'language') {
      const code = NHENTAI_LANGUAGE_CODES[f.value.toLowerCase().replace(/\s+/g, '')];
      if (code === undefined) {
        unsupported ??= `nHentai does not know the language "${f.value}".`;
        continue;
      }
      if (code) out.push(`language:${quote(code)}`);
      // 'all' → no language filter (nHentai default).
      continue;
    }
    out.push(`${f.namespace}:${quote(f.value)}`);
  }
  for (const ex of q.exclusions) {
    if (ex.namespace === 'language') {
      const code = NHENTAI_LANGUAGE_CODES[ex.value.toLowerCase().replace(/\s+/g, '')];
      if (code) out.push(`-language:${quote(code)}`);
      continue;
    }
    out.push(ex.namespace ? `-${ex.namespace}:${quote(ex.value)}` : `-${ex.value}`);
  }
  for (const phrase of q.phrases) out.push(quote(phrase));
  for (const kw of q.keywords) out.push(kw);
  return { query: out.join(' '), unsupported };
}

/** E-Hentai: plain namespace:value pairs, quoted phrases, `-` exclusions.
 *  The language filter travels as a lane option (f_lang), not query text. */
export function compileEhentai(q: CommonSearchQuery): CompiledLaneQuery {
  const out: string[] = [];
  let language: string | undefined;
  let unsupported: string | undefined;
  for (const f of q.filters) {
    if (f.namespace === 'language') {
      language = f.value.toLowerCase().replace(/\s+/g, '');
      continue;
    }
    out.push(`${f.namespace}:${f.value}`);
  }
  for (const ex of q.exclusions) {
    if (ex.namespace === 'language') continue; // language exclusions are not expressible; see unsupported note
    if (ex.namespace) {
      out.push(`-${ex.namespace}:${ex.value.includes(' ') ? `"` + ex.value.replace(/"/g, '') + '"' : ex.value}`);
    } else {
      out.push(`-${ex.value.includes(' ') ? `"` + ex.value.replace(/"/g, '') + '"' : ex.value}`);
    }
  }
  for (const phrase of q.phrases) out.push(`"${phrase.replace(/"/g, '')}"`);
  for (const kw of q.keywords) out.push(kw);
  if (q.exclusions.some((ex) => ex.namespace === 'language')) {
    unsupported = 'E-Hentai/ExHentai cannot exclude a language from a search.';
  }
  return { query: out.join(' '), language, unsupported };
}
