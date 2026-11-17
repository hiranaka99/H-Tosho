/**
 * E-Hentai / ExHentai provider.
 *
 * - Search: the site's own tagged search form (f_search/f_lang), parsed from
 *   the HTML list pages; one bounded gdata batch per chunk hydrates language,
 *   dates, page counts, and namespaced tags.
 * - Metadata: the gallery's own info page (authenticated for ExHentai), with
 *   ordered lazy /s/ page references resolved just before transfer.
 * - The whole provider shares the family pacing gate and the stored account;
 *   a missing account simply means the public E-Hentai subset.
 */

import {
  ehentaiFetchText, ehentaiApiPost, approveGalleryImageRefs, fetchEhentaiImage, EhentaiUpstreamError,
  type EhentaiTextResponse, type ImageFormat,
} from './ehentaiClient.js';
import { parseEhentaiGdata, gdataNumber } from './ehentaiXml.js';
import {
  parseEhentaiGalleryId, parseEhentaiGalleryUrl, ehentaiGalleryUrl, ehentaiHost,
  type EhentaiSite, type SearchCursor,
} from '../contracts/doujin.js';
import type { EhentaiSessionInput } from '../contracts/ehentai.js';
import { getStoredSession, getAccountRevision, getEhentaiAccountSite, EhentaiAccountCryptoError } from '../services/ehentaiAccount.js';
import { getDownloaderSettings } from '../services/settings.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DoujinProvider, DoujinSearchResult, DoujinGallery, DoujinSort, DoujinSearchOptions,
} from './types.js';
import type { EhentaiGdataEntry } from './ehentaiXml.js';

const LIST_PAGE_LIMIT = 50; // the site's max per-list-page rendering

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
  let site: EhentaiSite;
  let revision: number;
  try {
    site = getEhentaiAccountSite();
    revision = getAccountRevision();
  } catch (error) {
    throw new EhentaiUpstreamError('The E-Hentai account cannot be read. Re-save your account in Settings.', 'denied');
  }
  let session: ResolvedSession['session'];
  try {
    session = getStoredSession();
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

/** E-Hentai language filter ids, matching the site's own search form
 *  (f_lang) exactly. The aggregator validates against this map; unknown
 *  names are never guessed. 1 means "All" and is only used when the user
 *  explicitly clears the language filter. */
export const EHENTAI_LANGUAGE_IDS: Record<string, number> = {
  all: 1,
  japanese: 2,
  english: 3,
  chinese: 4,
  korean: 5,
  french: 6,
  german: 7,
  italian: 8,
  spanish: 9,
  indonesian: 10,
  polish: 11,
  russian: 12,
  thai: 13,
  ukrainian: 14,
  vietnamese: 15,
  danish: 16,
  dutch: 17,
  portuguese: 18,
  catalan: 19,
  finnish: 20,
  hungarian: 21,
  norwegian: 22,
  swedish: 23,
};

/** The plan's default-language convention: a normal search is English. */
export const EHENTAI_DEFAULT_LANGUAGE_ID = EHENTAI_LANGUAGE_IDS.english;

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
  languageId: number | null;
  sort: DoujinSort;
  /** Stable identity of the search inputs; cursors are bound to this. */
  fingerprint: string;
}

function compileSearch(query: string, sort: DoujinSort | undefined, opts: DoujinSearchOptions | undefined): CompiledSearch {
  const base = (query ?? '').trim();
  const terms = ehentaiBannedTerms();
  const queryText = terms.length ? `${base}${base ? ' ' : ''}${terms.join(' ')}`.trim() : base;
  const languageName = typeof opts?.language === 'string' ? opts.language.trim().toLowerCase() : '';
  const languageId = languageName ? (EHENTAI_LANGUAGE_IDS[languageName] ?? null) : EHENTAI_DEFAULT_LANGUAGE_ID;
  const fingerprint = JSON.stringify({ q: queryText, lang: languageId, sort: sort ?? 'default', skip: opts?.skip ?? null });
  return { queryText, languageId, sort: sort ?? 'default', fingerprint };
}

function buildListUrl(site: EhentaiSite, compiled: CompiledSearch): URL {
  const url = new URL('https://e-hentai.org/');
  url.hostname = ehentaiHost(site);
  const params = url.searchParams;
  params.set('f_search', compiled.queryText);
  if (compiled.languageId) params.set('f_lang', String(compiled.languageId));
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
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ''));

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

/** Parse one search/list HTML page. A search page with no gallery rows is a
 *  valid empty result (the site's search form is still present); any other
 *  page without the row tables is a parse error — an empty result and a
 *  broken parser are different outcomes (P1.3.9). */
export function parseEhentaiListPage(html: string, baseUrl: string): EhentaiListPage {
  const nextLink = (source: string): string | null => {
    const nextMatch = /<a class="pn" href="([^"]+)"/.exec(source);
    return nextMatch ? new URL(decodeEntities(nextMatch[1]), baseUrl).toString() : null;
  };
  const pageStart = html.indexOf('<table class="glt"');
  if (pageStart < 0) {
    if (/<form[^>]*name="s1"/.test(html)) {
      return { galleries: [], nextUrl: nextLink(html) };
    }
    throw new EhentaiUpstreamError('The E-Hentai list response did not contain a gallery table.', 'parse');
  }
  const pageEnd = html.indexOf('<div class="pc">', pageStart);
  const section = pageEnd > 0 ? html.slice(pageStart, pageEnd) : html.slice(pageStart);

  const galleries: EhentaiListGallery[] = [];
  const rowRe = /<table class="glt">([\s\S]*?)<\/table>/g;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(section)) !== null) {
    const cells = row[1];
    const link = /href="(https:\/\/(?:e-hentai|exhentai)\.org\/g\/(\d+)\/([0-9a-fA-F]{12})\/)"/.exec(cells);
    if (!link) continue;
    const titleMatch = /<span class="gdt_title"><a[^>]*>([\s\S]*?)<\/a><\/span>/.exec(cells);
    if (!titleMatch) continue;
    // gl2 cells in order: rating, category, pages, language, date.
    const tdMatches: string[] = [];
    let td: RegExpExecArray | null;
    const tdRe = /<td class="gl2">([\s\S]*?)<\/td>/g;
    while ((td = tdRe.exec(cells)) !== null) tdMatches.push(td[1]);
    const cover = /class="glth"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/.exec(cells);
    galleries.push({
      gid: link[2],
      token: link[3].toLowerCase(),
      title: stripTags(titleMatch[1]).trim(),
      coverUrl: cover ? decodeEntities(cover[1]) : null,
      language: tdMatches.length >= 4 ? (stripTags(tdMatches[3]).trim() || null) : null,
      pageCount: tdMatches.length >= 3 ? (Number.parseInt(stripTags(tdMatches[2]), 10) || null) : null,
      uploadedAt: tdMatches.length >= 5 ? parseUploadedAt(stripTags(tdMatches[4]).trim() || null) : null,
    });
  }

  return { galleries, nextUrl: nextLink(html) };
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

function hydrateFromGdata(entries: EhentaiGdataEntry[] | null, token: string): GdataHydration | null {
  if (!entries) return null;
  const entry = entries.find((e) => e.token !== null && e.token.toLowerCase() === token.toLowerCase());
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
  const uploadedTs = entry.fields.get('uploaded_ts');
  let uploadedAt: string | null = null;
  if (uploadedTs && /^\d+$/.test(uploadedTs)) uploadedAt = new Date(+uploadedTs * 1000).toISOString();
  if (!uploadedAt) uploadedAt = parseUploadedAt(entry.fields.get('uploaded') ?? null);
  return {
    language: entry.fields.get('language')?.trim() || null,
    pageCount: gdataNumber(entry, 'pages'),
    uploadedAt,
    tags,
    tagNamespaces,
    artists,
    groups,
    parodies,
    characters,
  };
}

/** One bounded gdata batch (namespace=1 = tags included). Returns null on any
 *  failure: callers fall back to list-page metadata and never drop galleries. */
async function fetchGdataBatch(
  items: Array<{ gid: string; token: string }>,
  signal?: AbortSignal,
): Promise<EhentaiGdataEntry[] | null> {
  if (!items.length) return null;
  let response: EhentaiTextResponse;
  try {
    response = await ehentaiApiPost(
      {
        t: 'gdata',
        'gid[]': items.map((i) => i.gid),
        'tok[]': items.map((i) => i.token),
        namespace: '1',
      },
      { signal },
    );
  } catch (error) {
    if (error instanceof EhentaiUpstreamError && (error.kind === 'timeout' || error.kind === 'unavailable' || error.kind === 'rate-limited')) {
      return null; // hydration is best-effort; the list page already answered
    }
    throw error;
  }
  if (response.status !== 200) return null;
  const entries = parseEhentaiGdata(response.body);
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
  signal?: AbortSignal,
): Promise<DoujinSearchResult[]> {
  const chunk = page.galleries.slice(0, limit);
  if (!chunk.length) return [];
  const hydration = await fetchGdataBatch(chunk.map((g) => ({ gid: g.gid, token: g.token })), signal);
  const results: DoujinSearchResult[] = chunk.map((g) => {
    const hyd = hydrateFromGdata(hydration, g.token);
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
  return applyBans(results);
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
    if (url.searchParams.get('f_search') !== compiled.queryText) return false;
    if (compiled.languageId && url.searchParams.get('f_lang') !== String(compiled.languageId)) return false;
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
  let response: EhentaiTextResponse;
  try {
    response = await ehentaiFetchText(url, 'html', { site, session, signal, headers: { Referer: `https://${ehentaiHost(site)}/` } });
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
  // A continued page must still answer the same query.
  if (url !== buildListUrl(site, compiled).toString() && !validateContinuationUrl(url, site, compiled)) {
    throw new EhentaiUpstreamError('The E-Hentai continuation link no longer matches this search.', 'parse');
  }
  return parseEhentaiListPage(response.body, url);
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
  /** Ordered viewer-page references (https://.../s/<token>/<gid>-<token>/N.ext). */
  pageRefs: string[];
  /** Ordered preview thumbnail URLs (public static hosts). */
  coverUrl: string | null;
}

const TAG_NAMESPACE_PARAMS: Record<string, string> = {
  f_doujin: 'doujin',
  f_manga: 'manga',
  f_artist: 'artist',
  f_group: 'group',
  f_parody: 'parody',
  f_character: 'character',
  f_male: 'male',
  f_female: 'female',
  f_other: 'other',
  f_language: 'language',
  f_cats: 'category',
};

export function parseEhentaiGalleryPage(html: string): ParsedGalleryInfo {
  const titleMatch = /<span class="gcname">([\s\S]*?)<\/span>/.exec(html);
  if (!titleMatch) throw new EhentaiUpstreamError('The E-Hentai gallery page did not contain gallery metadata (unavailable or expunged?).', 'parse');
  const info: ParsedGalleryInfo = {
    title: stripTags(titleMatch[1]).trim(),
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
    pageRefs: [],
    coverUrl: null,
  };

  const alt = /<span class="gdt_namealt">\s*\(?([\s\S]*?)\)?\s*<\/span>/.exec(html);
  if (alt) info.titleAlt = stripTags(alt[1]).trim() || null;
  const series = /<span class="gcpar"><a[^>]*>([\s\S]*?)<\/a><\/span>/.exec(html)
    ?? /<span class="gcpar">([\s\S]*?)<\/span>/.exec(html);
  if (series) info.series = stripTags(series[1]).trim() || null;

  const infoRow = (label: string): string | null => {
    const m = new RegExp(`<th>${label}:</th><td[^>]*>([\\s\\S]*?)<\\/td>`).exec(html);
    return m ? stripTags(m[1]).trim() || null : null;
  };
  info.language = infoRow('Language');
  info.category = infoRow('Category');
  info.uploadedAt = parseUploadedAt(infoRow('Uploaded'));

  // Tags: <table class="itgns"> rows; the namespace is the f_* param in the link.
  const tagBlock = /<table class="itgns">([\s\S]*?)<\/table>/.exec(html);
  if (tagBlock) {
    const tagRe = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(tagBlock[1])) !== null) {
      const name = stripTags(tag[2]).trim();
      if (!name) continue;
      // href attributes arrive entity-escaped (&amp;) - decode before matching.
      // The site prefixes every tag link with an empty f_search=; the
      // namespace is the first non-empty f_* param with a known mapping.
      const href = decodeEntities(tag[1]);
      const paramRe = /(?:^|[&?])(f_[a-z]+)=([^&]*)/g;
      let namespace: string | undefined;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRe.exec(href)) !== null) {
        const value = decodeEntities(paramMatch[2]);
        if (value) {
          namespace = TAG_NAMESPACE_PARAMS[paramMatch[1]];
          if (namespace) break;
        }
      }
      info.tags.push(name);
      info.tagNamespaces.push(namespace);
      if (namespace === 'artist') info.artists.push(name);
      else if (namespace === 'group') info.groups.push(name);
      else if (namespace === 'parody') info.parodies.push(name);
      else if (namespace === 'character') info.characters.push(name);
    }
  }

  // Thumbnail table: one row per image, ordered. The <a href="/s/..."> target
  // is the viewer page; the <img src> is the public preview thumbnail.
  const thumbBlock = /<table id="gdthumb">([\s\S]*?)<\/table>/.exec(html);
  if (!thumbBlock) throw new EhentaiUpstreamError('The E-Hentai gallery page did not contain the image list.', 'parse');
  const linkRe = /<a href="(https:\/\/[^"]+?\/s\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let link: RegExpExecArray | null;
  let lastNumber = 0;
  while ((link = linkRe.exec(thumbBlock[1])) !== null) {
    const ref = decodeEntities(link[1]);
    const img = /<img[^>]*src="([^"]+)"/.exec(link[2]);
    const num = /\/(\d+)\.\w+$/.exec(ref);
    const n = num ? Number.parseInt(num[1], 10) : null;
    if (n === null || n <= lastNumber) {
      // Repeated or out-of-order references mean truncated/unknown pagination:
      // refuse to package a partial gallery as complete.
      throw new EhentaiUpstreamError('The E-Hentai image list is incomplete or out of order; the gallery cannot be resolved safely.', 'parse');
    }
    lastNumber = n;
    info.pageRefs.push(ref);
    if (info.coverUrl === null && img) info.coverUrl = decodeEntities(img[1]);
  }
  if (!info.pageRefs.length) throw new EhentaiUpstreamError('The E-Hentai gallery has no resolvable image pages.', 'parse');
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

  async search(query, limit = 25, sort, opts) {
    const { site, session } = currentSession();
    const compiled = compileSearch(query, sort, opts);
    const url = buildListUrl(site, compiled).toString();
    const page = await fetchListPage(site, url, session, compiled);
    return buildSearchResults(page, site, Math.min(Math.max(1, limit), LIST_PAGE_LIMIT));
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
    const items = await buildSearchResults({ galleries: chunk, nextUrl }, site, chunk.length, signal);
    return {
      items: applyBans(items),
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

    let response: EhentaiTextResponse;
    try {
      response = await ehentaiFetchText(url, 'html', { site, session, headers: { Referer: `https://${ehentaiHost(site)}/` } });
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

    const info = parseEhentaiGalleryPage(response.body);
    // Approve the viewer-page hosts/URLs this gallery exposed, so the image
    // lane can fetch them without cookies (approval is per gallery identity).
    approveGalleryImageRefs(identity.canonicalId, info.pageRefs);

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
      resolvePageUrl: async (index) => {
        const ref = info.pageRefs[index];
        if (!ref) return null;
        let viewer: EhentaiTextResponse;
        try {
          viewer = await ehentaiFetchText(ref, 'html', { site, session, headers: { Referer: `https://${ehentaiHost(site)}/g/${identity.gid}/${identity.token}/` } });
        } catch (error) {
          if (error instanceof EhentaiUpstreamError && error.status === 404) {
            throw new EhentaiUpstreamError('The E-Hentai image page is unavailable (the gallery page no longer exists).', 'unavailable', 404);
          }
          throw error;
        }
        const img = /<img[^>]*id="image"[^>]*src="([^"]+)"/.exec(viewer.body)
          ?? /<img[^>]*src="(https:\/\/[^"]+\.(?:jpe?g|png|gif|webp))"/.exec(viewer.body);
        if (!img) {
          throw new EhentaiUpstreamError('The E-Hentai viewer page did not expose an image (quota or error page?).', 'unavailable', viewer.status);
        }
        return { url: decodeEntities(img[1]) };
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

const VIEWER_PATH_RE = /^\/s\/([0-9a-f]{12})\/(\d+)-([0-9a-f]{12})\/\d+\.jpg$/i;
const IMAGE_CONTENT_TYPES: Record<ImageFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** True for a family-host viewer reference (`/s/<tok>/<gid>-<tok>/N.jpg`). */
export function isEhentaiViewerUrl(url: URL): boolean {
  return (url.hostname === 'e-hentai.org' || url.hostname === 'exhentai.org') && VIEWER_PATH_RE.test(url.pathname);
}

/** Resolve one viewer reference to validated image bytes (media proxy only).
 *  Throws EhentaiUpstreamError with a user-safe message on any failure. */
export async function ehentaiPreviewBytes(viewerUrl: string): Promise<{ buf: Buffer; type: string }> {
  const url = new URL(viewerUrl);
  if (url.protocol !== 'https:' || !isEhentaiViewerUrl(url)) {
    throw new EhentaiUpstreamError('Not a valid E-Hentai viewer reference.', 'parse');
  }
  const [, token, gid] = VIEWER_PATH_RE.exec(url.pathname)!;
  const { site, session } = currentSession();
  const referer = `https://${ehentaiHost(site)}/`;
  const viewer = await ehentaiFetchText(viewerUrl, 'html', { site, session, headers: { Referer: referer } });
  const img = /<img[^>]*id="image"[^>]*src="([^"]+)"/.exec(viewer.body)
    ?? /<img[^>]*src="(https:\/\/[^"]+\.(?:jpe?g|png|gif|webp))"/.exec(viewer.body);
  if (!img) {
    throw new EhentaiUpstreamError('The E-Hentai viewer page did not expose an image (quota or error page?).', 'unavailable', viewer.status);
  }
  const imageUrl = decodeEntities(img[1]);
  const galleryKey = `${site}/${gid}-${token}`;
  approveGalleryImageRefs(galleryKey, [imageUrl]);
  const destPath = path.join(os.tmpdir(), `htosho-ehentai-preview-${randomUUID()}`);
  try {
    const format = await fetchEhentaiImage(imageUrl, {
      site,
      galleryKey,
      destPath,
      referer: viewerUrl,
    });
    const buf = await fs.readFile(destPath);
    return { buf, type: IMAGE_CONTENT_TYPES[format] };
  } finally {
    await fs.rm(destPath, { force: true }).catch(() => { /* already removed */ });
  }
}
