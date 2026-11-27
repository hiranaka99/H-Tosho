/**
 * E-Hentai / ExHentai provider.
 *
 * - Search: the site's own tagged search form (f_search), parsed from
 *   compact HTML list pages; bounded gdata batches hydrate language,
 *   dates, page counts, and namespaced tags.
 * - Metadata: the gallery's own info page (authenticated for ExHentai), with
 *   ordered lazy /s/ page references resolved just before transfer.
 * - The whole provider shares the family pacing gate and the stored account.
 */

import {
  ehentaiFetchText, ehentaiApiPost, ehentaiTagSuggestions, approveGalleryImageRefs, fetchEhentaiImage, fetchEhentaiImageBuffer, EhentaiUpstreamError,
  type EhentaiTextResponse, type ImageFormat,
} from './ehentaiClient.js';
import { parseEhentaiGdata, gdataNumber } from './ehentaiGdata.js';
import {
  parseEhentaiGalleryId, parseEhentaiGalleryUrl, ehentaiGalleryUrl, ehentaiHost,
  type EhentaiSite, type SearchCursor,
} from '../contracts/doujin.js';
import type { EhentaiSessionInput } from '../contracts/ehentai.js';
import { getEhentaiAccountSnapshot, EhentaiAccountCryptoError } from '../services/ehentaiAccount.js';
import { getDownloaderSettings } from '../services/settings.js';
import type {
  DoujinProvider, DoujinSearchResult, DoujinGallery, DoujinSort, DoujinSearchOptions,
  DoujinSuggestion,
} from './types.js';
import type { EhentaiGdataEntry } from './ehentaiGdata.js';

const LIST_PAGE_LIMIT = 50; // the site's max per-list-page rendering
// f_cats excludes categories: enable only Doujinshi (2), Manga (4), Artist CG (8).
const SEARCH_CATEGORY_MASK = '1009'; // 1023 & ~(2 | 4 | 8)

// ---------------- account/session ----------------

interface ResolvedSession {
  site: EhentaiSite;
  revision: number;
  session: EhentaiSessionInput | null;
}

/** Resolve the family site + session for a request. A stored-but-undecryptable
 *  session is an explicit configuration error, never an anonymous fallback:
 *  silently degrading to public E-Hentai would surface a subset of the catalog
 *  the user paid for. */
function currentSession(): ResolvedSession {
  // One record read per call (site, revision, and envelope come from the same
  // snapshot, so they can never straddle a concurrent save).
  let account: ReturnType<typeof getEhentaiAccountSnapshot>;
  try {
    account = getEhentaiAccountSnapshot();
  } catch {
    throw new EhentaiUpstreamError('The E-Hentai account cannot be read. Re-save your account in Settings.', 'denied');
  }
  const { site, revision } = account;
  let session: ResolvedSession['session'];
  try {
    session = account.readSession();
  } catch (error) {
    if (error instanceof EhentaiAccountCryptoError) {
      throw new EhentaiUpstreamError('The stored E-Hentai session cannot be decrypted. Re-save your account cookies in Settings.', 'denied');
    }
    throw error;
  }
  if (!session) {
    // An explicit configuration error, never an anonymous fallback: silent
    // public-site access would surface a subset of the account catalog.
    throw new EhentaiUpstreamError('No E-Hentai account is saved. Add your account under Settings → Downloader → E-Hentai account.', 'denied');
  }
  return { site, revision, session };
}

// ---------------- query construction ----------------

/** Supported language names; the site filters through language tags. */
export const EHENTAI_LANGUAGES = new Set([
  'all', 'japanese', 'english', 'chinese', 'korean', 'french', 'german',
  'italian', 'spanish', 'indonesian', 'polish', 'russian', 'thai', 'ukrainian',
  'vietnamese', 'danish', 'dutch', 'portuguese', 'catalan', 'finnish',
  'hungarian', 'norwegian', 'swedish',
]);

function ehentaiBannedTerms(): string[] {
  let raw: unknown;
  try {
    raw = getDownloaderSettings().ehentaiBannedTags;
  } catch {
    return []; // DB not ready yet — fail open (the ban UI is the source of truth)
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of raw) {
    const tag = String(entry ?? '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // E-Hentai negates a term with a leading '-'; quote multi-word tags so the
    // whole tag is negated, not one of its words.
    terms.push(tag.includes(' ') ? `-"${tag.replace(/"/g, '')}"` : `-${tag}`);
  }
  return terms;
}

interface CompiledSearch {
  /** The site's own query text (f_search). */
  queryText: string;
  /** Requested language, including the English default; null means unrestricted. */
  language: string | null;
  sort: DoujinSort;
  /** Stable identity of the search inputs; cursors are bound to this. */
  fingerprint: string;
}

function compileSearch(query: string, sort: DoujinSort | undefined, opts: DoujinSearchOptions | undefined): CompiledSearch {
  // E-Hentai's long artist namespace needs a quoted value (artist:mana
  // returns no matches where artist:"mana" and a:mana both match).
  const quoteArtists = (text: string): string => text.replace(
    /"[^"]*"|(^|\s)((?:[-~])?(?:weak:)?(?:artist|a)):([^\s"]+)/gi,
    (whole, space: string, namespace: string, value: string) => namespace ? `${space}${namespace}:"${value}"` : whole,
  );
  const base = quoteArtists((query ?? '').trim());
  const terms = ehentaiBannedTerms();
  const languageName = typeof opts?.language === 'string' ? opts.language.trim().toLowerCase() : '';
  // Preserve explicit native language searches; normal searches default to
  // English. E-Hentai has no f_lang parameter.
  const languageTerms = (base.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [])
    .filter((term) => /^(?:~)?(?:weak:)?(?:language|lang|l):/i.test(term));
  const language = languageName || (languageTerms.length ? 'all' : 'english');
  if (!EHENTAI_LANGUAGES.has(language)) throw new EhentaiUpstreamError('This E-Hentai search language is not supported.', 'parse');
  const nativeLanguage = languageTerms.length === 1 && !languageTerms[0].startsWith('~')
    ? languageTerms[0].replace(/^(?:weak:)?(?:language|lang|l):/i, '').replace(/["$]/g, '').toLowerCase()
    : null;
  const preferredLanguage = language !== 'all' ? language
    : nativeLanguage && nativeLanguage !== 'all' && EHENTAI_LANGUAGES.has(nativeLanguage) ? nativeLanguage : null;
  const queryText = [base, ...terms.map(quoteArtists), ...(language === 'all' ? [] : [`language:${language}$`])].filter(Boolean).join(' ');
  const fingerprint = JSON.stringify({ q: queryText, language: preferredLanguage, categories: SEARCH_CATEGORY_MASK, sort: sort ?? 'default', skip: opts?.skip ?? null });
  return { queryText, language: preferredLanguage, sort: sort ?? 'default', fingerprint };
}

function buildListUrl(site: EhentaiSite, compiled: CompiledSearch): URL {
  const url = new URL('https://e-hentai.org/');
  url.hostname = ehentaiHost(site);
  const params = url.searchParams;
  params.set('f_search', compiled.queryText);
  params.set('f_cats', SEARCH_CATEGORY_MASK);
  // A saved account may prefer a different display mode. Request a known
  // table layout so the response is independent of that preference.
  params.set('inline_set', 'dm_l');
  return url;
}

// ---------------- list page parsing ----------------

export interface EhentaiListGallery {
  gid: string;
  token: string;
  title: string;
  coverUrl: string | null;
  language: string | null;
  pageCount: number | null;
  uploadedAt: string | null;
}

export interface EhentaiListPage {
  galleries: EhentaiListGallery[];
  /** Absolute URL of the "Next" continuation, when the list has more pages. */
  nextUrl: string | null;
}

const decodeEntities = (text: string): string => text
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code: string) => {
    const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  })
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ''));

// Attribute and element patterns are compiled once per name, not per call:
// a gallery page runs these thousands of times. Attribute patterns are
// non-global (stateless exec); element patterns are global but only used
// synchronously with an explicit lastIndex reset.
const attributePatterns = new Map<string, RegExp>();
const elementTagPatterns = new Map<string, RegExp>();

function htmlAttribute(tag: string, name: string): string | null {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    attributePatterns.set(name, pattern);
  }
  const match = pattern.exec(tag);
  return match ? decodeEntities(match[1] ?? match[2]) : null;
}

function parseUploadedAt(raw: string | null): string | null {
  if (!raw) return null;
  // "2026-11-15 12:34 +0900" or "... -0500"; site-local time with offset.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*([+-])(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, oh, omi] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? '0')));
  date.setUTCMinutes(date.getUTCMinutes() - (sign === '+' ? 1 : -1) * (+oh * 60 + +omi));
  return date.toISOString();
}

/** Parse the site's compact table (.itg), explicitly requested by buildListUrl.
 * A known empty-search message is required when there is no table: a search
 * form alone must not hide upstream errors or future markup changes. */
export function parseEhentaiListPage(html: string, baseUrl: string, preferredLanguage: string | null = null): EhentaiListPage {
  let nextUrl: string | null = null;
  for (const anchor of html.matchAll(/<a\b[^>]*>/gi)) {
    if (!['unext', 'dnext'].includes(htmlAttribute(anchor[0], 'id') ?? '')) continue;
    const href = htmlAttribute(anchor[0], 'href');
    if (href) {
      nextUrl = new URL(href, baseUrl).toString();
      break;
    }
  }
  const table = /<table\b[^>]*\bclass\s*=\s*(["'])[^"']*\bitg\b[^"']*\1[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) {
    const hasSearch = /<input\b[^>]*\bname\s*=\s*["']f_search["']/i.test(html);
    if (hasSearch && /No hits found|No unfiltered results|No matches were found/i.test(stripTags(html))) return { galleries: [], nextUrl: null };
    throw new EhentaiUpstreamError('The E-Hentai list response did not contain a gallery table.', 'parse');
  }

  const galleries: EhentaiListGallery[] = [];
  const seen = new Set<string>();
  for (const row of table[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = row[1];
    if (!/<td\b/i.test(cells)) continue; // header row
    const titleMatch = /<(?:div|span)\b[^>]*\bclass\s*=\s*(["'])[^"']*\bglink\b[^"']*\1[^>]*>([\s\S]*?)<\/(?:div|span)>/i.exec(cells);
    // Public list pages insert advertising rows between gallery rows.
    if (!titleMatch && /<td\b[^>]*\bclass\s*=\s*(["'])[^"']*\bitd\b[^"']*\1/i.test(cells)) continue;
    let identity: ReturnType<typeof parseEhentaiGalleryUrl> = null;
    for (const anchor of cells.matchAll(/<a\b[^>]*>/gi)) {
      const href = htmlAttribute(anchor[0], 'href');
      if (href) identity = parseEhentaiGalleryUrl(new URL(href, baseUrl).toString());
      if (identity) break;
    }
    if (!identity || !titleMatch || !stripTags(titleMatch[2]).trim()) {
      throw new EhentaiUpstreamError('The E-Hentai gallery table contained an unrecognized result.', 'parse');
    }
    if (seen.has(identity.canonicalId)) continue;
    seen.add(identity.canonicalId);
    let coverUrl: string | null = null;
    for (const image of cells.matchAll(/<img\b[^>]*>/gi)) {
      const src = htmlAttribute(image[0], 'data-src') ?? htmlAttribute(image[0], 'src');
      if (src && /^https:\/\//i.test(src)) { coverUrl = src; break; }
    }
    const languages = [...cells.matchAll(/\btitle\s*=\s*["']language:([^"']+)["']/gi)]
      .map((m) => m[1].trim()).filter((value) => EHENTAI_LANGUAGES.has(value.toLowerCase()));
    const language = languages.find((value) => value.toLowerCase() === preferredLanguage) ?? languages[0] ?? null;
    const pages = />\s*(\d+) pages\s*</i.exec(cells)?.[1];
    const posted = /\bid\s*=\s*["']posted_\d+["'][^>]*>([^<]+)/i.exec(cells)?.[1];
    galleries.push({
      gid: identity.gid,
      token: identity.token,
      title: stripTags(titleMatch[2]).trim(),
      coverUrl,
      language: language ? decodeEntities(language).trim() : null,
      pageCount: pages ? Number(pages) : null,
      // List timestamps are UTC and omit the explicit offset.
      uploadedAt: posted ? parseUploadedAt(`${posted.trim()} +0000`) : null,
    });
  }

  return { galleries, nextUrl };
}

// ---------------- gdata hydration ----------------

interface GdataHydration {
  language: string | null;
  pageCount: number | null;
  uploadedAt: string | null;
  tags: string[];
  tagNamespaces: (string | undefined)[];
  artists: string[];
  groups: string[];
  parodies: string[];
  characters: string[];
}

function hydrateFromGdata(entries: EhentaiGdataEntry[] | null, gid: string, token: string, preferredLanguage: string | null): GdataHydration | null {
  if (!entries) return null;
  const entry = entries.find((e) => e.gid === gid && e.token === token.toLowerCase());
  if (!entry || entry.error) return null;
  const tags: string[] = [];
  const tagNamespaces: (string | undefined)[] = [];
  const artists: string[] = [];
  const groups: string[] = [];
  const parodies: string[] = [];
  const characters: string[] = [];
  for (const { namespace, value } of entry.tags) {
    const name = value.trim();
    if (!name) continue;
    tags.push(name);
    tagNamespaces.push(namespace);
    if (namespace === 'artist') artists.push(name);
    else if (namespace === 'group') groups.push(name);
    else if (namespace === 'parody') parodies.push(name);
    else if (namespace === 'character') characters.push(name);
  }
  const uploadedTs = gdataNumber(entry, 'posted');
  const uploadedDate = uploadedTs === null ? null : new Date(uploadedTs * 1000);
  const uploadedAt = uploadedDate && Number.isFinite(uploadedDate.getTime()) ? uploadedDate.toISOString() : null;
  const languages = entry.tags.filter((t) => t.namespace === 'language' && EHENTAI_LANGUAGES.has(t.value.trim().toLowerCase()));
  return {
    language: languages.find((t) => t.value.trim().toLowerCase() === preferredLanguage)?.value ?? languages[0]?.value ?? null,
    pageCount: gdataNumber(entry, 'filecount'),
    uploadedAt,
    tags,
    tagNamespaces,
    artists,
    groups,
    parodies,
    characters,
  };
}

/** Bounded gdata batches (namespace=1 = namespaced tags). Missing or failed
 *  entries fall back to list-page metadata without dropping galleries. */
async function fetchGdataBatch(
  items: Array<{ gid: string; token: string }>,
  signal?: AbortSignal,
): Promise<EhentaiGdataEntry[] | null> {
  if (!items.length) return null;
  const entries: EhentaiGdataEntry[] = [];
  for (let start = 0; start < items.length; start += 25) {
    try {
      const response = await ehentaiApiPost({
        method: 'gdata',
        gidlist: items.slice(start, start + 25).map((i) => [Number(i.gid), i.token]),
        namespace: 1,
      }, { signal });
      if (response.status === 200) entries.push(...(parseEhentaiGdata(response.body) ?? []));
    } catch (error) {
      if (error instanceof EhentaiUpstreamError && ['timeout', 'unavailable', 'rate-limited'].includes(error.kind)) continue;
      throw error;
    }
  }
  return entries;
}

// ---------------- search result assembly ----------------

function bannedTagSet(): Set<string> {
  let raw: unknown;
  try {
    raw = getDownloaderSettings().ehentaiBannedTags;
  } catch {
    return new Set();
  }
  const set = new Set<string>();
  if (!Array.isArray(raw)) return set;
  for (const entry of raw) {
    const tag = String(entry ?? '').trim().toLowerCase();
    if (!tag) continue;
    set.add(tag);
    if (tag.includes(':')) set.add(tag.slice(tag.indexOf(':') + 1).trim()); // also match the bare name
  }
  return set;
}

/** Drop results whose tags (any namespace) match a configured ban. */
function applyBans<T extends { tags: string[]; tagNamespaces?: (string | undefined)[] }>(items: T[]): T[] {
  const bans = bannedTagSet();
  if (!bans.size) return items;
  return items.filter((item) => {
    for (let i = 0; i < item.tags.length; i++) {
      const tag = item.tags[i].toLowerCase();
      const namespace = item.tagNamespaces?.[i];
      if (bans.has(tag) || (namespace && bans.has(`${namespace}:${tag}`))) return false;
    }
    return true;
  });
}

async function buildSearchResults(
  page: EhentaiListPage,
  site: EhentaiSite,
  limit: number,
  language: string | null,
  signal?: AbortSignal,
): Promise<DoujinSearchResult[]> {
  const chunk = page.galleries.slice(0, limit);
  if (!chunk.length) return [];
  const hydration = await fetchGdataBatch(chunk.map((g) => ({ gid: g.gid, token: g.token })), signal);
  const results: DoujinSearchResult[] = chunk.map((g) => {
    const hyd = hydrateFromGdata(hydration, g.gid, g.token, language);
    const tags = hyd?.tags?.length ? hyd.tags : [];
    const artists = hyd?.artists?.length ? hyd.artists : [];
    return {
      source: 'ehentai',
      site,
      galleryId: `${g.gid}-${g.token}`,
      title: g.title,
      coverUrl: g.coverUrl ?? undefined,
      language: hyd?.language ?? g.language ?? undefined,
      tags,
      artists,
      tagNamespaces: tags.length ? hyd!.tagNamespaces : undefined,
      pageCount: hyd?.pageCount ?? g.pageCount ?? undefined,
      url: ehentaiGalleryUrl(site, g.gid, g.token),
      uploadedAt: hyd?.uploadedAt ?? g.uploadedAt ?? undefined,
    };
  });
  // The upstream query applies the language restriction. Also reject known
  // mismatches in the response, while retaining results with unavailable metadata.
  return applyBans(results.filter((result) => !language || !result.language || result.language.trim().toLowerCase() === language));
}

// ---------------- cursor state ----------------

interface CursorState {
  v: 1;
  fp: string; // compiled-search fingerprint
  site: EhentaiSite;
  acctRev: number;
  nextUrl: string | null;
  /** Items parsed from the current list page that later chunks must serve
   *  before fetching the next one (no numeric offsets are invented). */
  buffer: EhentaiListGallery[];
}

function encodeCursor(state: CursorState): SearchCursor {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: SearchCursor | null, expected: CompiledSearch, site: EhentaiSite, acctRev: number): CursorState | null {
  if (cursor === null) return { v: 1, fp: expected.fingerprint, site, acctRev, nextUrl: null, buffer: [] };
  if (typeof cursor !== 'string' || cursor.length > 16384) return null;
  try {
    const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
    if (state?.v !== 1 || typeof state.fp !== 'string' || state.fp !== expected.fingerprint) return null;
    if (state.site !== site || state.acctRev !== acctRev) return null; // account/site cutover invalidates the sequence
    if (state.nextUrl !== null && !state.nextUrl.startsWith('https://')) return null;
    if (!Array.isArray(state.buffer)) return null;
    return state;
  } catch {
    return null;
  }
}

/** Validate that a continued list URL is still the same search on the same
 *  family host — never follow a foreign continuation. */
function validateContinuationUrl(nextUrl: string, site: EhentaiSite, compiled: CompiledSearch): boolean {
  try {
    const url = new URL(nextUrl);
    if (url.protocol !== 'https:' || url.hostname !== ehentaiHost(site)) return false;
    if (url.port || url.username || url.password || url.pathname !== '/' || url.hash) return false;
    if (url.searchParams.get('f_search') !== compiled.queryText) return false;
    // The site omits inline_set in its Next link; restore the display mode on
    // fetch instead of requiring a parameter it does not return.
    return true;
  } catch {
    return false;
  }
}

async function fetchListPage(
  site: EhentaiSite,
  url: string,
  session: ResolvedSession['session'],
  compiled: CompiledSearch,
  signal?: AbortSignal,
): Promise<EhentaiListPage> {
  if (!validateContinuationUrl(url, site, compiled)) {
    throw new EhentaiUpstreamError('The E-Hentai continuation link no longer matches this search.', 'parse');
  }
  let response: EhentaiTextResponse;
  try {
    const requestUrl = new URL(url);
    // Keep the restriction even if an upstream continuation omits the mask.
    requestUrl.searchParams.set('f_cats', SEARCH_CATEGORY_MASK);
    requestUrl.searchParams.set('inline_set', 'dm_l');
    response = await ehentaiFetchText(requestUrl.toString(), 'html', { site, session, signal, headers: { Referer: `https://${ehentaiHost(site)}/` } });
  } catch (error) {
    if (error instanceof EhentaiUpstreamError) {
      if (error.kind === 'denied') throw error;
      throw new EhentaiUpstreamError('The E-Hentai search host is unavailable right now.', error.kind === 'timeout' ? 'timeout' : 'unavailable');
    }
    throw error;
  }
  if (response.status === 429) throw new EhentaiUpstreamError('E-Hentai is rate-limiting searches. Try again in a few minutes.', 'rate-limited', 429);
  if (response.status === 509) throw new EhentaiUpstreamError('The E-Hentai quota is exhausted for this account.', 'quota', 509);
  if (response.status === 401 || response.status === 403 || /login\.php/.test(response.finalUrl)) {
    throw new EhentaiUpstreamError('The E-Hentai session was rejected. Re-test or re-save the account in Settings.', 'denied', response.status);
  }
  if (response.status !== 200) throw new EhentaiUpstreamError('The E-Hentai search host returned an unexpected response.', 'unavailable', response.status);
  return parseEhentaiListPage(response.body, url, compiled.language);
}

// ---------------- getGallery: info page + lazy page refs ----------------

interface ParsedGalleryInfo {
  title: string;
  titleAlt: string | null;
  series: string | null;
  language: string | null;
  category: string | null;
  uploadedAt: string | null;
  tags: string[];
  tagNamespaces: (string | undefined)[];
  artists: string[];
  groups: string[];
  parodies: string[];
  characters: string[];
  /** Total image count reported by the gallery, across thumbnail pages. */
  pageCount: number;
  /** Ordered viewer-page references (/s/<page-token>/<gid>-<page-number>). */
  pageRefs: string[];
  nextUrl: string | null;
  /** Ordered preview thumbnail URLs (public static hosts). */
  coverUrl: string | null;
}

/** Extract a known element while retaining nested elements with the same tag. */
function htmlElementById(html: string, id: string): { inner: string; tag: string } | null {
  for (const open of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid\s*=[^>]*>/gi)) {
    if (htmlAttribute(open[0], 'id') !== id) continue;
    const tagName = open[1].toLowerCase();
    let tags = elementTagPatterns.get(tagName);
    if (!tags) {
      tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
      if (elementTagPatterns.size < 64) elementTagPatterns.set(tagName, tags);
    }
    tags.lastIndex = open.index + open[0].length;
    let depth = 1;
    let tag: RegExpExecArray | null;
    while ((tag = tags.exec(html))) {
      if (tag[0].startsWith('</')) depth--;
      else if (!tag[0].endsWith('/>')) depth++;
      if (depth === 0) return { inner: html.slice(open.index + open[0].length, tag.index), tag: open[0] };
    }
    return null;
  }
  return null;
}

const VIEWER_PATH_RE = /^\/s\/([0-9a-f]{10})\/([1-9]\d{0,9})-([1-9]\d{0,5})$/i;

function viewerReference(raw: string, baseUrl: string): { url: string; gid: string; page: number; token: string } | null {
  try {
    const url = new URL(raw, baseUrl);
    if (!isEhentaiViewerUrl(url)) return null;
    const [, token, gid, page] = VIEWER_PATH_RE.exec(url.pathname)!;
    return { url: url.toString(), gid, page: Number(page), token };
  } catch {
    return null;
  }
}

export function parseEhentaiGalleryPage(html: string, baseUrl: string, thumbsOnly = false): ParsedGalleryInfo {
  const title = htmlElementById(html, 'gn');
  if (!title || !stripTags(title.inner).trim()) throw new EhentaiUpstreamError('The E-Hentai gallery page did not contain gallery metadata (unavailable or expunged?).', 'parse');
  const info: ParsedGalleryInfo = {
    title: stripTags(title.inner).trim(),
    titleAlt: null,
    series: null,
    language: null,
    category: null,
    uploadedAt: null,
    tags: [],
    tagNamespaces: [],
    artists: [],
    groups: [],
    parodies: [],
    characters: [],
    pageCount: 0,
    pageRefs: [],
    nextUrl: null,
    coverUrl: null,
  };

  const details = htmlElementById(html, 'gdd');
  const fields = new Map<string, string>();
  for (const row of (details?.inner ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length === 2) fields.set(stripTags(cells[0][1]).trim().replace(/:$/, ''), stripTags(cells[1][1]).trim());
  }
  info.pageCount = Number(/^(\d+) pages?$/.exec(fields.get('Length') ?? '')?.[1] ?? 0);
  if (!Number.isSafeInteger(info.pageCount) || info.pageCount < 1) throw new EhentaiUpstreamError('The E-Hentai gallery did not report a valid page count.', 'parse');

  if (!thumbsOnly) {
    const alt = htmlElementById(html, 'gj');
    if (alt) info.titleAlt = stripTags(alt.inner).trim() || null;
    const category = htmlElementById(html, 'gdc');
    if (category) info.category = stripTags(category.inner).trim() || null;
    info.language = fields.get('Language')?.replace(/\s+(?:TR|RW)\b.*$/, '').trim() || null;
    const posted = fields.get('Posted');
    info.uploadedAt = posted ? parseUploadedAt(`${posted} +0000`) : null;

    const tagBlock = htmlElementById(html, 'taglist');
    if (tagBlock) {
      for (const anchor of tagBlock.inner.matchAll(/<a\b([^>]*)>[\s\S]*?<\/a>/gi)) {
        const href = htmlAttribute(anchor[0].slice(0, anchor[0].indexOf('>') + 1), 'href');
        if (!href || !htmlAttribute(anchor[1], 'id')?.startsWith('ta_')) continue;
        let value: string;
        try {
          const url = new URL(href, baseUrl);
          if (!url.pathname.startsWith('/tag/')) continue;
          value = decodeURIComponent(url.pathname.slice(5).replace(/\+/g, ' '));
        } catch { continue; }
        const colon = value.indexOf(':');
        if (colon < 1) continue;
        const namespace = value.slice(0, colon);
        const name = value.slice(colon + 1).trim();
        if (!name) continue;
        info.tags.push(name);
        info.tagNamespaces.push(namespace);
        if (namespace === 'artist') info.artists.push(name);
        else if (namespace === 'group') info.groups.push(name);
        else if (namespace === 'parody') info.parodies.push(name);
        else if (namespace === 'character') info.characters.push(name);
      }
    }
    info.series = info.parodies[0] ?? null;
    const cover = htmlElementById(html, 'gd1');
    const coverUrl = cover ? /url\(\s*['"]?(https:\/\/[^\s)'"<>]+)/i.exec(cover.inner)?.[1] : null;
    if (coverUrl) info.coverUrl = decodeEntities(coverUrl);
  }

  // Thumbnails can be CSS sprites: the viewer href identifies each page;
  // the sprite itself must never become a full-page preview image.
  const thumbBlock = htmlElementById(html, 'gdt');
  if (!thumbBlock) throw new EhentaiUpstreamError('The E-Hentai gallery page did not contain the image list.', 'parse');
  let lastNumber = 0;
  for (const anchor of thumbBlock.inner.matchAll(/<a\b[^>]*>/gi)) {
    const href = htmlAttribute(anchor[0], 'href');
    const ref = href ? viewerReference(href, baseUrl) : null;
    if (!ref || (lastNumber > 0 && ref.page !== lastNumber + 1) || ref.page > info.pageCount) {
      throw new EhentaiUpstreamError('The E-Hentai image list is incomplete or out of order; the gallery cannot be resolved safely.', 'parse');
    }
    lastNumber = ref.page;
    info.pageRefs.push(ref.url);
  }
  if (!info.pageRefs.length) throw new EhentaiUpstreamError('The E-Hentai gallery has no resolvable image pages.', 'parse');
  for (const table of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    if (!htmlAttribute(table[1], 'class')?.split(/\s+/).some((c) => c === 'ptt' || c === 'ptb')) continue;
    for (const anchor of table[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (stripTags(anchor[2]).trim() !== '>') continue;
      const href = htmlAttribute(anchor[1], 'href');
      if (href) info.nextUrl = new URL(href, baseUrl).toString();
    }
    if (info.nextUrl) break;
  }
  return info;
}

// ---------------- provider ----------------

export const ehentaiProvider: DoujinProvider = {
  id: 'ehentai',
  name: 'E-Hentai',
  color: '#00a1d6',
  meta: {
    sorts: ['default'],
    paging: 'cursor',
  },

  async suggest(query, limit = 10, _context, signal) {
    const aliases: Record<string, string> = { artists: 'artist', a: 'artist', groups: 'group', g: 'group', parodies: 'parody', p: 'parody', characters: 'character', c: 'character', languages: 'language', l: 'language', lang: 'language', f: 'female', m: 'male', x: 'mixed', o: 'other' };
    const namespaces = new Set(['artist', 'group', 'parody', 'character', 'language', 'female', 'male', 'mixed', 'other', 'cosplayer', 'reclass', 'tag']);
    const raw = query.trim().replace(/^[-~]/, '');
    const field = /^([a-z]+):(.*)$/is.exec(raw);
    const namespace = field ? aliases[field[1].toLowerCase()] ?? field[1].toLowerCase() : null;
    if (namespace && !namespaces.has(namespace)) return [];
    const prefix = (field ? field[2] : raw).replace(/^"|"$/g, '').trim();
    if (!namespace && prefix.length < 2) return [];
    const { site, session } = currentSession();
    const response = await ehentaiTagSuggestions(namespace ? `${namespace}:${prefix}` : prefix, { site, session, signal, maxWaitMs: 2500 });
    let data: unknown;
    try { data = JSON.parse(response.body); } catch { throw new EhentaiUpstreamError('E-Hentai tag suggestions could not be read.', 'parse'); }
    if (!data || typeof data !== 'object' || !('tags' in data) || !data.tags || typeof data.tags !== 'object') return [];
    const out: DoujinSuggestion[] = [];
    for (const rawTag of Object.values(data.tags)) {
      if (!rawTag || typeof rawTag !== 'object') continue;
      const tag = rawTag as Record<string, unknown>;
      if (typeof tag.ns !== 'string' || typeof tag.tn !== 'string' || !tag.tn.trim() || tag.tn.includes('"')) continue;
      if (namespace && namespace !== 'tag' && tag.ns !== namespace) continue;
      out.push({ source: 'ehentai', type: tag.ns, name: tag.tn, filter: `${tag.ns}:"${tag.tn}$"` });
      if (out.length >= Math.min(25, Math.max(1, limit))) break;
    }
    return out;
  },

  async search(query, limit = 25, sort, opts) {
    const { site, session } = currentSession();
    const compiled = compileSearch(query, sort, opts);
    const url = buildListUrl(site, compiled).toString();
    const page = await fetchListPage(site, url, session, compiled);
    return buildSearchResults(page, site, Math.min(Math.max(1, limit), LIST_PAGE_LIMIT), compiled.language);
  },

  async searchChunk(query, cursor, limit, sort, opts, signal) {
    const { site, revision: acctRev, session } = currentSession();
    const compiled = compileSearch(query, sort, opts);
    const wanted = Math.min(Math.max(1, limit), LIST_PAGE_LIMIT);
    const state = decodeCursor(cursor, compiled, site, acctRev);
    if (state === null) {
      throw new EhentaiUpstreamError('This E-Hentai search continuation is no longer valid. Start a new search.', 'parse');
    }
    let galleries = state.buffer;
    let nextUrl = state.nextUrl;
    if (!galleries.length) {
      // Fresh sequence: start from the site's search page. (A stored cursor
      // with an empty buffer always carries a valid continuation URL.)
      if (nextUrl === null) nextUrl = buildListUrl(site, compiled).toString();
      const page = await fetchListPage(site, nextUrl, session, compiled, signal);
      galleries = page.galleries;
      nextUrl = page.nextUrl;
    }
    const chunk = galleries.slice(0, wanted);
    const remaining = galleries.slice(wanted);
    const exhausted = remaining.length === 0 && (nextUrl === null || !validateContinuationUrl(nextUrl, site, compiled));
    const items = await buildSearchResults({ galleries: chunk, nextUrl }, site, chunk.length, compiled.language, signal);
    return {
      items, // buildSearchResults already applied the configured bans
      nextCursor: exhausted ? null : encodeCursor({ v: 1, fp: compiled.fingerprint, site, acctRev, nextUrl, buffer: remaining }),
      exhausted,
    };
  },

  async getGallery(idOrUrl) {
    const { site: accountSite, session } = currentSession();
    const fromUrl = typeof idOrUrl === 'string' ? parseEhentaiGalleryUrl(idOrUrl) : null;
    const fromId = typeof idOrUrl === 'string' ? parseEhentaiGalleryId(idOrUrl) : null;
    const identity = fromUrl ?? fromId;
    if (!identity) throw new EhentaiUpstreamError('Not a valid E-Hentai gallery URL or id.', 'parse');
    const site: EhentaiSite = fromUrl?.site ?? accountSite;
    const url = `https://${ehentaiHost(site)}/g/${identity.gid}/${identity.token}/`;

    const fetchPage = async (pageUrl: string, thumbsOnly = false): Promise<ParsedGalleryInfo> => {
      let response: EhentaiTextResponse;
      try {
        response = await ehentaiFetchText(pageUrl, 'html', { site, session, headers: { Referer: url } });
      } catch (error) {
        if (error instanceof EhentaiUpstreamError) {
          if (error.status === 404) {
            throw new EhentaiUpstreamError('The E-Hentai gallery is unavailable or was removed.', 'unavailable', 404);
          }
          if (error.kind === 'denied') {
            throw new EhentaiUpstreamError('The E-Hentai session could not open this gallery. Re-test the account in Settings.', 'denied', error.status);
          }
        }
        throw error;
      }
      if (response.status === 401 || response.status === 403 || /login\.php/.test(response.finalUrl)) {
        throw new EhentaiUpstreamError('The E-Hentai session could not open this gallery. Re-test the account in Settings.', 'denied', response.status);
      }
      if (response.status !== 200) throw new EhentaiUpstreamError('The E-Hentai gallery host returned an unexpected response.', 'unavailable', response.status);
      return parseEhentaiGalleryPage(response.body, pageUrl, thumbsOnly);
    };

    const info = await fetchPage(url);
    let page = info;
    let thumbnailPage = 0;
    const refs: string[] = [];
    for (;;) {
      if (page.pageCount !== info.pageCount) throw new EhentaiUpstreamError('The E-Hentai gallery changed while its image list was loading. Try again.', 'parse');
      for (const raw of page.pageRefs) {
        const ref = viewerReference(raw, url)!;
        if (ref.gid !== identity.gid || new URL(ref.url).hostname !== ehentaiHost(site) || ref.page !== refs.length + 1) {
          throw new EhentaiUpstreamError('The E-Hentai image list is incomplete or out of order; the gallery cannot be resolved safely.', 'parse');
        }
        refs.push(ref.url);
      }
      if (refs.length === info.pageCount) break;
      if (!page.nextUrl) throw new EhentaiUpstreamError('The E-Hentai image list is incomplete; the gallery cannot be resolved safely.', 'parse');
      const next = new URL(page.nextUrl);
      const canonical = new URL(url);
      thumbnailPage++;
      if (next.origin !== canonical.origin || next.pathname !== canonical.pathname || next.username || next.password || next.hash
        || next.searchParams.get('p') !== String(thumbnailPage) || [...next.searchParams.keys()].some((key) => key !== 'p')) {
        throw new EhentaiUpstreamError('The E-Hentai thumbnail continuation does not match this gallery.', 'parse');
      }
      page = await fetchPage(next.toString(), true);
    }
    info.pageRefs = refs;

    const reloadTokens = new Map<number, string>();
    const resolveViewerPage = async (index: number, opts?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<{ viewerUrl: string; imageUrl: string } | null> => {
      const ref = info.pageRefs[index];
      if (!ref) return null;
      let viewerUrl = ref;
      if (opts?.forceRefresh) {
        const nl = reloadTokens.get(index);
        if (nl) viewerUrl = `${ref}?nl=${encodeURIComponent(nl)}`;
      }
      let viewer: EhentaiTextResponse;
      try {
        viewer = await ehentaiFetchText(viewerUrl, 'html', {
          site,
          session,
          signal: opts?.signal,
          headers: { Referer: `https://${ehentaiHost(site)}/g/${identity.gid}/${identity.token}/` },
        });
      } catch (error) {
        if (error instanceof EhentaiUpstreamError && error.status === 404) {
          throw new EhentaiUpstreamError('The E-Hentai image page is unavailable (the gallery page no longer exists).', 'unavailable', 404);
        }
        throw error;
      }
      if (viewer.status === 401 || viewer.status === 403 || /login\.php/.test(viewer.finalUrl)) {
        throw new EhentaiUpstreamError('The E-Hentai session was rejected. Re-test or re-save the account in Settings.', 'denied', viewer.status);
      }
      if (viewer.status === 509) {
        throw new EhentaiUpstreamError('The E-Hentai image quota is exhausted for this account.', 'quota', 509);
      }
      if (viewer.status !== 200) throw new EhentaiUpstreamError('The E-Hentai image page is unavailable.', 'unavailable', viewer.status);
      const imageUrl = parseEhentaiViewerImage(viewer.body, viewerUrl);
      const nextNl = parseEhentaiReloadToken(viewer.body);
      if (nextNl) reloadTokens.set(index, nextNl);
      return { viewerUrl, imageUrl };
    };

    const galleryKey = `${site}/${identity.canonicalId}`;
    const gallery: DoujinGallery = {
      source: 'ehentai',
      site,
      galleryId: identity.canonicalId,
      title: info.title,
      titleAlt: info.titleAlt ?? undefined,
      series: info.series ?? undefined,
      coverUrl: info.coverUrl ?? undefined,
      language: info.language ?? undefined,
      tags: info.tags,
      tagNamespaces: info.tagNamespaces,
      artists: info.artists,
      groups: info.groups,
      parodies: info.parodies ?? undefined,
      characters: info.characters ?? undefined,
      pageCount: info.pageRefs.length,
      url: ehentaiGalleryUrl(site, identity.gid, identity.token),
      uploadedAt: info.uploadedAt ?? undefined,
      pages: info.pageRefs,
      requestHeaders: { Referer: `https://${ehentaiHost(site)}/g/${identity.gid}/${identity.token}/` },
      // Static pages are viewer HTML, never images: failures must propagate,
      // never fall back to the /s/ URL.
      strictPageResolver: true,
      resolvePageUrl: async (index, opts) => {
        const resolved = await resolveViewerPage(index, opts);
        return resolved ? { url: resolved.imageUrl } : null;
      },
      downloadPage: async (index, destPath, opts) => {
        const resolved = await resolveViewerPage(index, { forceRefresh: opts.forceRefresh, signal: opts.signal });
        if (!resolved) throw new EhentaiUpstreamError(`Page ${index + 1} could not be resolved to a downloadable URL.`, 'parse');
        const pageKey = `${galleryKey}/p${index}`;
        approveGalleryImageRefs(pageKey, [resolved.imageUrl]);
        const { format, bytes } = await fetchEhentaiImage(resolved.imageUrl, {
          site,
          galleryKey: pageKey,
          destPath,
          referer: resolved.viewerUrl,
          signal: opts.signal,
          onAttemptStart: opts.onAttemptStart,
          onBytes: opts.onProgress,
        });
        return { bytes, ext: format };
      },
    };
    return gallery;
  },
};

// ---------------- media proxy lane ----------------
//
// The /media route never fetches E-Hentai hosts generically: viewer refs are
// resolved server-side through the same gated, session-aware client the
// downloader uses, and the image bytes come only from the URL the viewer page
// itself exposed (per-request approval + magic-byte validation, no cookies on
// image hosts). Quota/denial HTML can therefore never be published as an image.

const IMAGE_CONTENT_TYPES: Record<ImageFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** True for an exact family-host viewer reference (`/s/<page-token>/<gid>-N`). */
export function isEhentaiViewerUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash
    && (url.hostname === 'e-hentai.org' || url.hostname === 'exhentai.org') && VIEWER_PATH_RE.test(url.pathname);
}

/** Only the primary viewer image is downloadable; navigation icons and the
 * original-image purchase link are deliberately excluded. */
export function parseEhentaiViewerImage(html: string, viewerUrl: string): string {
  if (/exceeded your image viewing limits|image limit has been reached|quota exceeded/i.test(stripTags(html))) {
    throw new EhentaiUpstreamError('The E-Hentai image quota is exhausted for this account.', 'quota', 509);
  }
  for (const image of html.matchAll(/<img\b[^>]*\bid\s*=[^>]*>/gi)) {
    if (htmlAttribute(image[0], 'id') !== 'img') continue;
    const src = htmlAttribute(image[0], 'src');
    if (!src) break;
    let url: URL;
    try { url = new URL(src, viewerUrl); } catch { break; }
    if (url.hostname === 'ehgt.org' && url.pathname === '/g/509.gif') {
      throw new EhentaiUpstreamError('The E-Hentai image quota is exhausted for this account.', 'quota', 509);
    }
    if (url.protocol !== 'https:' || url.username || url.password) break;
    return url.toString();
  }
  throw new EhentaiUpstreamError('The E-Hentai viewer page did not expose its primary image (quota or error page?).', 'parse');
}

/** Extract the viewer's H@H node-switch token from `nl('<token>')`, if present. */
export function parseEhentaiReloadToken(html: string): string | null {
  const match = /\bnl\(\s*['"]([0-9a-zA-Z-]{1,64})['"]\s*\)/.exec(html);
  return match ? match[1] : null;
}

/** Resolve one viewer reference to validated image bytes (media proxy only).
 *  Throws EhentaiUpstreamError with a user-safe message on any failure. */
export async function ehentaiPreviewBytes(viewerUrl: string): Promise<{ buf: Buffer; type: string }> {
  const url = new URL(viewerUrl);
  if (url.protocol !== 'https:' || !isEhentaiViewerUrl(url)) {
    throw new EhentaiUpstreamError('Not a valid E-Hentai viewer reference.', 'parse');
  }
  const [, token, gid] = VIEWER_PATH_RE.exec(url.pathname)!;
  const { session } = currentSession();
  const site: EhentaiSite = url.hostname === 'exhentai.org' ? 'exhentai' : 'e-hentai';
  const referer = `https://${ehentaiHost(site)}/`;
  const viewer = await ehentaiFetchText(viewerUrl, 'html', { site, session, headers: { Referer: referer } });
  if (viewer.status !== 200) throw new EhentaiUpstreamError('The E-Hentai image page is unavailable.', 'unavailable', viewer.status);
  const imageUrl = parseEhentaiViewerImage(viewer.body, viewerUrl);
  const galleryKey = `${site}/${gid}-${token}`;
  approveGalleryImageRefs(galleryKey, [imageUrl]);
  // Previews are small: validate and return them straight from memory (the
  // media route owns the only on-disk copy, its L2 cache).
  const { format, buf } = await fetchEhentaiImageBuffer(imageUrl, {
    site,
    galleryKey,
    referer: viewerUrl,
    maxBytes: PREVIEW_MAX_BYTES,
  });
  return { buf, type: IMAGE_CONTENT_TYPES[format] };
}

/** Matches the media proxy's per-response cap. */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
