import crypto from 'node:crypto';
import { fetchBuffer } from '../lib/http.js';
import { getDownloaderSettings } from '../services/settings.js';
import { extractGalleryId, stripTags, toIsoDate } from './util.js';
import type { DoujinGallery, DoujinProvider, DoujinSearchOptions, DoujinSearchResult, DoujinSuggestion, DoujinSort } from './types.js';

/**
 * Hitomi.la provider.
 *
 * Hitomi is a JavaScript SPA backed by binary/JSON endpoints on its CDN
 * (`ltn.gold-usergeneratedcontent.net`). This implementation mirrors the live
 * site's own client logic (common.js / gg.js / searchlib.js / search.js):
 *
 *   - Image CDN routing: `gg.js` defines `m()` (a hash-bucket→shift table),
 *     `s(hash)` (path bucket = parseInt(last 2 hex chars, 16)) and `b`
 *     (a rotating base path prefix). The full image path is
 *     `b + s(hash) + '/' + hash`, served from host `{prefix}{1+m(g)}.CDN`
 *     where `g = parseInt(hash[61..63], 16)` and the prefix is
 *     'a' (avif), 'w' (webp), or '' (original). So an AVIF page is
 *     `https://a{1+m(g)}.gold-usergeneratedcontent.net/{b}{s}/{hash}.avif`.
 *   - Gallery metadata: `/galleries/{id}.js` returns `var galleryinfo = {...}`
 *     with title, language (string), artists/tags (objects), and a `files`
 *     array of `{name, hash, haswebp, hasavif, ...}`.
 *   - Keyword search: a B-tree over `/galleriesindex/galleries.{version}.index`
 *     (node tree) + `.data` (values), keyed by the first 4 bytes of
 *     SHA-256(term). Nodes are fetched with HTTP Range requests.
 *   - Filtered/namespaced search (e.g. `artist:charu`, `language:english`):
 *     resolved via the `.nozomi` binary endpoint, which ANDs all filters.
 *   - Tag suggestions: `tagindex.hitomi.la/{field}/{c1}/{c2}...json` returns
 *     `[["name", count, "namespace"], ...]` for a character-prefix query — the
 *     same endpoint the live site's search dropdown uses.
 *
 * `gg.js` is re-fetched (and cached briefly) so its rotating base path and
 * routing table stay in sync with the live site. Image requests must carry a
 * hitomi.la Referer header, which the provider attaches via `requestHeaders`.
 */

const BASE = 'https://hitomi.la';
const CDN = 'gold-usergeneratedcontent.net';
const API_BASE = `https://ltn.${CDN}`;
// Tag-autocomplete index. GET {TAG_INDEX}/{field}/{c1}/{c2}...json returns an
// array of [name, count, namespace] triples for the character-prefix query — this
// is exactly what powers the live site's search dropdown (see search.js).
const TAG_INDEX = 'https://tagindex.hitomi.la';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0';
const GALLERY_URL_RE = /\/(\d+)/;

const MAX_NODE_SIZE = 464;
const B = 16;
// gg.js rotates its base path (gg.b) and routing table every few minutes, so keep
// the cache short to avoid building URLs against a stale prefix mid-download. The
// CDN answers 404 for any base path older than the current one, so this must be
// well under the rotation cadence (~1-2 min observed).
const GG_CACHE_TTL_MS = 20 * 1000;

function headers(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    Referer: `${BASE}/`,
  };
}

// ---------------------------------------------------------------------------
// gg.js (CDN routing table) — loaded live and cached
// ---------------------------------------------------------------------------

interface GG {
  m: (g: number) => number;
  s: (hash: string) => string;
  b: string;
}

let ggCache: { value: GG; at: number } | null = null;

/** Load the live CDN routing table, honoring a short cache unless `force`. */
async function loadGG(force = false): Promise<GG> {
  if (!force && ggCache && Date.now() - ggCache.at < GG_CACHE_TTL_MS) return ggCache.value;
  const code = await fetchText(`${API_BASE}/gg.js`);
  // gg.js begins with 'use strict'; and assigns to a bare `gg`. Provide `gg`
  // as a parameter so that assignment is legal within the function scope.
  const gg: GG = new Function('gg', `${code}\nreturn gg;`)({});
  if (typeof gg.m !== 'function' || typeof gg.s !== 'function' || typeof gg.b !== 'string') {
    throw new Error('Failed to parse Hitomi gg.js CDN routing table.');
  }
  ggCache = { value: gg, at: Date.now() };
  return gg;
}

async function fetchText(url: string): Promise<string> {
  const buf = await fetchBuffer(url, { headers: headers() });
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// Image URL construction (mirrors live common.js)
// ---------------------------------------------------------------------------

/** The routing bucket number for a hash: 1 + gg.m(g), where g is the last 3 hex chars. */
function subdomainNumber(gg: GG, hash: string): number | null {
  // Match the last three hex chars of the bare 64-char hash. (The live client
  // runs this against the full image URL, which has a leading '/'; here we pass
  // just the hash, so no slash is required.)
  const m = /[0-9a-f]{61}([0-9a-f]{2})([0-9a-f])/.exec(hash);
  if (!m) return null;
  const g = parseInt(m[2] + m[1], 16);
  if (Number.isNaN(g)) return null;
  return 1 + gg.m(g);
}

/** Subdomain for a compressed rendition: 'a{n}' (avif) or 'w{n}' (webp). */
function subdomainPrefix(gg: GG, hash: string, dir: 'avif' | 'webp'): string {
  const letter = dir === 'avif' ? 'a' : 'w';
  const n = subdomainNumber(gg, hash);
  return n === null ? letter : `${letter}${n}`;
}

function imageUrl(gg: GG, hash: string, ext: 'avif' | 'webp'): string {
  const prefix = subdomainPrefix(gg, hash, ext);
  return `https://${prefix}.${CDN}/${gg.b}${gg.s(hash)}/${hash}.${ext}`;
}

/**
 * URL for an original-format file (no webp/avif rendition). Mirrors the live
 * client's `url_from_hash` when `dir` is None: the subdomain is the bare routing
 * bucket number `{n}` (no letter prefix), unlike compressed renditions.
 */
function originalUrl(gg: GG, hash: string, ext: string): string {
  const n = subdomainNumber(gg, hash);
  const host = n === null ? 'a' : String(n);
  return `https://${host}.${CDN}/${gg.b}${gg.s(hash)}/${hash}.${ext}`;
}

/** Per-page source metadata needed to rebuild a fresh image URL on demand. */
export interface HitomiPageRef {
  hash: string;
  /** Preferred compressed extension ('avif' | 'webp'), when the file has one. */
  ext?: 'avif' | 'webp';
  /** Fallback compressed extension (used when the primary fails to download). */
  fallbackExt?: 'avif' | 'webp';
  /** Original-format extension for files with no webp/avif rendition. */
  origExt?: string;
}

/**
 * Build a Hitomi image URL from a page ref using the *current* gg.js routing
 * table (freshly fetched when its cache has expired). Because the CDN only
 * serves the current base path, URLs must be constructed close to the moment of
 * the request — this is what lets downloads survive mid-run CDN rotation.
 */
export async function buildHitomiPageUrl(
  ref: HitomiPageRef,
  opts?: { forceGgRefresh?: boolean; preloadedGg?: GG },
): Promise<string> {
  const gg = opts?.preloadedGg ?? (await loadGG(opts?.forceGgRefresh));
  if (ref.ext) return imageUrl(gg, ref.hash, ref.ext);
  // Original format — no compressed rendition; bare numeric subdomain.
  return originalUrl(gg, ref.hash, ref.origExt ?? 'jpg');
}

/** Rebuild a cached Hitomi image URL against the current rotating CDN route. */
export async function refreshHitomiImageUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith('.gold-usergeneratedcontent.net')) return null;
  const match = /\/([0-9a-f]{64})\.(avif|webp)$/i.exec(parsed.pathname);
  if (!match) return null;
  return buildHitomiPageUrl(
    { hash: match[1].toLowerCase(), ext: match[2].toLowerCase() as 'avif' | 'webp' },
    { forceGgRefresh: true },
  );
}

// ---------------------------------------------------------------------------
// Gallery metadata
// ---------------------------------------------------------------------------

interface HitomiFile {
  name: string;
  hash: string;
  haswebp?: number;
  hasavif?: number;
  width?: number;
  height?: number;
}

function parseGalleryInfo(text: string): any {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Could not locate galleryinfo object.');
  // Find the matching closing brace (balanced, string-aware).
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('Could not parse galleryinfo object.');
}

/** A single entry from a galleryinfo tag list (tags/artists/characters/groups/parodys). */
interface HitomiTagEntry {
  tag?: string;
  artist?: string;
  character?: string;
  group?: string;
  /** "1" when the tag belongs to that area, "" or absent otherwise. */
  female?: string | number;
  male?: string | number;
}

function tagValue(t: HitomiTagEntry | string): string {
  if (typeof t === 'string') return t;
  return String(t.tag ?? t.artist ?? t.character ?? '');
}

/**
 * Search area for a gallery tag. Hitomi's galleryinfo tags carry `female`/`male`
 * flags ("1" when the tag belongs to that area); unflagged tags (e.g. "digital")
 * have no area and are searched as plain keywords.
 */
function tagNamespace(t: HitomiTagEntry | string): string | undefined {
  if (typeof t === 'string') return undefined;
  if (t.female) return 'female';
  if (t.male) return 'male';
  return undefined;
}

/**
 * Canonical human-facing page URL for a gallery, e.g.
 * `/doujinshi/nozokare-roshutsu-shoujo-ii-english-4114741.html`. The bare
 * `/{id}` path 404s on the live site, so prefer the API's `galleryurl` field.
 */
function galleryUrlFor(info: { galleryurl?: unknown }, id: string): string {
  const path = typeof info.galleryurl === 'string' && info.galleryurl ? info.galleryurl : `/${id}`;
  return `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

function coverUrlFor(gg: GG, files: HitomiFile[]): string | undefined {
  const f = files?.[0];
  if (!f) return undefined;
  if (f.haswebp) return imageUrl(gg, f.hash, 'webp');
  if (f.hasavif) return imageUrl(gg, f.hash, 'avif');
  return undefined;
}

// ---------------------------------------------------------------------------
// B-tree keyword search (mirrors live search.js get_galleryids_for_query)
// ---------------------------------------------------------------------------

function hashTerm(term: string): Uint8Array {
  return new Uint8Array(crypto.createHash('sha256').update(term, 'utf8').digest().subarray(0, 4));
}

async function rangeFetch(url: string, start: number, end: number): Promise<Buffer> {
  const r = await fetch(url, { headers: { ...headers(), Range: `bytes=${start}-${end}` } });
  if (r.status !== 200 && r.status !== 206) throw new Error(`Hitomi range request failed (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

interface BTreeNode {
  keys: Uint8Array[];
  datas: [number, number][];
  subnode_addresses: bigint[];
}

function decodeNode(data: Buffer): BTreeNode {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  const nKeys = dv.getInt32(pos, false);
  pos += 4;
  const keys: Uint8Array[] = [];
  for (let i = 0; i < nKeys; i++) {
    const ks = dv.getInt32(pos, false);
    pos += 4;
    if (!ks || ks > 32) throw new Error('Malformed Hitomi B-tree node key size.');
    keys.push(new Uint8Array(data.buffer, data.byteOffset + pos, ks));
    pos += ks;
  }
  const nData = dv.getInt32(pos, false);
  pos += 4;
  const datas: [number, number][] = [];
  for (let i = 0; i < nData; i++) {
    const off = Number(dv.getBigUint64(pos, false));
    pos += 8;
    const len = dv.getInt32(pos, false);
    pos += 4;
    datas.push([off, len]);
  }
  const subs: bigint[] = [];
  for (let i = 0; i < B + 1; i++) {
    subs.push(dv.getBigUint64(pos, false));
    pos += 8;
  }
  return { keys, datas, subnode_addresses: subs };
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  const top = Math.min(a.length, b.length);
  for (let i = 0; i < top; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

let galleriesIndexVersion: string | null = null;

async function getGalleriesIndexVersion(): Promise<string> {
  if (galleriesIndexVersion) return galleriesIndexVersion;
  const v = await fetchText(`${API_BASE}/galleriesindex/version?_=${Date.now()}`);
  galleriesIndexVersion = v.trim();
  return galleriesIndexVersion;
}

/**
 * Decoded B-tree node LRU, keyed `${indexVersion}:${addr}`. Index nodes are
 * immutable for a given galleriesindex version, so caching them removes the up
 * to 12 sequential range reads per term on repeat lookups; the version in the
 * key makes a version change miss every entry (implicit invalidation). The
 * final gallery-id data fetch stays uncached — it is one read per exact match.
 */
const btreeNodeCache = new Map<string, BTreeNode>();
const BTREE_NODE_CACHE_MAX = 256;

/** Resolve the gallery ids that exactly match a single keyword term. */
async function getGalleryIdsForTerm(term: string, version: string): Promise<number[]> {
  const key = hashTerm(term);
  const indexUrl = `${API_BASE}/galleriesindex/galleries.${version}.index`;
  const dataUrl = `${API_BASE}/galleriesindex/galleries.${version}.data`;

  let addr = 0n;
  for (let depth = 0; depth < 12; depth++) {
    const nodeKey = `${version}:${addr}`;
    let node = btreeNodeCache.get(nodeKey);
    if (!node) {
      const buf = await rangeFetch(indexUrl, Number(addr), Number(addr) + MAX_NODE_SIZE - 1);
      node = decodeNode(buf);
      // LRU: evict the stalest entry (Map insertion order) when over cap.
      if (btreeNodeCache.size >= BTREE_NODE_CACHE_MAX) {
        const oldest = btreeNodeCache.keys().next().value;
        if (oldest !== undefined) btreeNodeCache.delete(oldest);
      }
      btreeNodeCache.set(nodeKey, node);
    }
    if (!node.keys.length) return [];

    let there = false;
    // Default to the final subnode slot: when the key is greater than every
    // key in this node, locate_key falls off the end of the loop (mirrors the
    // live client), so the descent must target keys.length, not 0.
    let where = node.keys.length;
    for (let i = 0; i < node.keys.length; i++) {
      const c = cmp(key, node.keys[i]);
      if (c <= 0) {
        where = i;
        there = c === 0;
        break;
      }
    }

    if (there) {
      const [offset, length] = node.datas[where];
      if (!length || length <= 0) return [];
      const d = await rangeFetch(dataUrl, offset, offset + length - 1);
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const count = dv.getInt32(0, false);
      if (count <= 0 || count > 10_000_000) return [];
      const ids: number[] = [];
      for (let i = 0; i < count; i++) ids.push(dv.getInt32(4 + i * 4, false));
      return ids;
    }

    if (node.subnode_addresses[where] === 0n) return [];
    addr = node.subnode_addresses[where];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Nozomi-based filtered search (namespaced queries, e.g. artist:charu language:english)
// ---------------------------------------------------------------------------

/**
 * A parsed Hitomi filter query for the `.nozomi` endpoint. Mirrors the live
 * client's state object in `nozomi_address_from_state`: a single optional
 * tag/area pair plus an optional language, all ANDed together.
 */
interface NozomiFilter {
  /** The nozomi area, e.g. "artist", "character". Undefined for language-only. */
  area?: string;
  /** The tag to filter on (or "index" for a language-only filter). */
  tag: string;
  /** Language filter, e.g. "english" or "all". */
  language: string;
}

/** Build the `.nozomi` URL for a filter (mirrors get_galleryids_from_nozomi). */
function nozomiUrl(f: NozomiFilter): string {
  const tail = `${f.tag}-${f.language}`;
  return f.area ? `${API_BASE}/n/${f.area}/${tail}.nozomi` : `${API_BASE}/n/${tail}.nozomi`;
}

/** Parse a nozomi payload: big-endian int32 gallery-id list. */
function parseNozomiIds(buf: Buffer): number[] {
  const count = Math.floor(buf.byteLength / 4);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(buf.readInt32BE(i * 4));
  return ids;
}

/** Fetch the big-endian int32 gallery-id list from a nozomi filter. */
async function fetchNozomiIds(f: NozomiFilter): Promise<number[]> {
  try {
    const r = await fetch(nozomiUrl(f), { headers: { ...headers() } });
    if (r.status !== 200) return [];
    return parseNozomiIds(Buffer.from(await r.arrayBuffer()));
  } catch {
    return [];
  }
}

/**
 * Fetch the popularity-ranked id list for a period, mirroring the live site's
 * `orderby:popular orderbykey:<period>` sort, which resolves to
 * `/n/popular/<period>-<language>.nozomi`. The returned order is descending
 * popularity — callers must preserve it.
 */
async function fetchPopularIds(period: 'today' | 'week' | 'year', language: string): Promise<number[]> {
  try {
    const r = await fetch(`${API_BASE}/n/popular/${period}-${language}.nozomi`, { headers: { ...headers() } });
    if (r.status !== 200) return [];
    return parseNozomiIds(Buffer.from(await r.arrayBuffer()));
  } catch {
    return [];
  }
}

/**
 * Build a nozomi filter from a single `ns:tag` term, mirroring the live
 * client's `get_galleryids_for_query`. Handles artist:/character:/series:/
 * group:/parody:/type:, plus the special female:/male: (area "tag") and
 * language: (no area, tag "index") cases.
 */
function nozomiFilterFromTerm(term: string): NozomiFilter | null {
  const [ns, ...rest] = term.split(':');
  // The `.nozomi` endpoint is case-sensitive (its indices are built from
  // lowercased tags), so normalize the area and tag value to lowercase.
  const val = rest.join(':').toLowerCase();
  if (!val) return null;
  const area = ns.toLowerCase();
  if (area === 'female' || area === 'male') return { area: 'tag', tag: term.toLowerCase(), language: 'all' };
  if (area === 'language') return { area: undefined, tag: 'index', language: val };
  return { area, tag: val, language: 'all' };
}


/** AND-intersect a list of id sets (empty result if any set is empty). */
function intersectIds(sets: number[][]): number[] {
  let result: number[] | null = null;
  for (const set of sets) {
    const asSet = new Set(set);
    result = result === null ? [...set] : result.filter((id) => asSet.has(id));
    if (result.length === 0) return [];
  }
  return result ?? [];
}

/**
 * Split a query into terms the way hitomi.la's results.js does: whitespace is
 * the term separator, and underscores act as escaped spaces *inside* a term
 * ("To enter a tag name with spaces, use the _ character"). So
 * `female:schoolgirl_uniform` stays one namespaced term whose value is
 * "schoolgirl uniform", while bare keywords are de-underscored for the B-tree.
 */
function tokenizeQuery(query: string): { ns?: string; val: string }[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const ci = t.indexOf(':');
      if (ci <= 0) return { val: t.replace(/_/g, ' ') };
      // Keep the namespace intact; de-underscore only the tag value.
      return { ns: t.slice(0, ci), val: t.slice(ci + 1).replace(/_/g, ' ') };
    });
}

/**
 * Search gallery ids for a query. Plain keywords use the B-tree index; any
 * namespaced/filtered term (`ns:tag`) is resolved via the nozomi endpoint. When
 * the query mixes terms (e.g. `artist:charu language:english`), each term is
 * resolved independently and the id sets are AND-intersected, mirroring how the
 * live site combines filters. A term that matches nothing yields zero results.
 * Results are restricted to English by default (unless the query names an
 * explicit `language:`), so searches don't surface non-English galleries.
 *
 * With `popularPeriod` set, the base result set is instead the period's
 * popularity-ranked list and every term's id set is AND-filtered onto it, so
 * results keep descending-popularity order (the live site's
 * `orderby:popular orderbykey:<period>` behavior).
 *
 * Configured banned tags are subtracted from the final id set on both paths.
 * A query that names a banned tag verbatim is an explicit request and skips
 * that tag's exclusion, so searching a banned tag still returns results (a
 * bare gallery-id lookup never reaches this function at all).
 */
async function searchGalleryIds(query: string, version: string, popularPeriod?: 'today' | 'week' | 'year'): Promise<number[]> {
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];

  // Hitomi's keyword index is built from lowercased terms, so the B-tree lookup
  // is case-sensitive. Lowercase bare keywords (e.g. "Chibikko" → "chibikko") so
  // a naturally-capitalized title still matches. Plain keywords AND-intersect —
  // the live site filters the running result set by every positive term, so
  // "aoi kajitsu to shiroi hada" returns only galleries matching all of those
  // words, not the union, which would surface hundreds of unrelated galleries
  // sharing any single common word.
  const btreeTerm = (t: { val: string }) => getGalleryIdsForTerm(t.val.toLowerCase(), version);
  const sets = await Promise.all(
    terms.map(async (t) => {
      if (t.ns) {
        const f = nozomiFilterFromTerm(`${t.ns}:${t.val}`);
        return f ? fetchNozomiIds(f) : [];
      }
      return btreeTerm(t);
    })
  );

  const explicitLanguage = terms.find((t) => t.ns?.toLowerCase() === 'language')?.val;

  if (popularPeriod) {
    // The language rides on the popular list itself, so no separate English
    // intersection applies in this mode. An empty popularity index yields zero
    // results rather than falling back to index order.
    const popular = await fetchPopularIds(popularPeriod, explicitLanguage ?? 'english');
    if (!popular.length) return [];
    const setOf = sets.map((s) => new Set(s));
    const banned = await bannedIdSet(query, version);
    return popular.filter((id) => setOf.every((s) => s.has(id)) && !banned?.has(id));
  }

  let ids = intersectIds(sets);

  // Restrict results to English so plain keyword/tag searches don't surface
  // non-English galleries. An explicit `language:` term takes precedence, letting
  // users still search other languages. Fail open if the English index is
  // unavailable so a transient error doesn't blank out all results.
  if (ids.length && !explicitLanguage) {
    const english = await fetchNozomiIds({ tag: 'index', language: 'english' });
    if (english.length) ids = intersectIds([ids, english]);
  }

  // Drop galleries carrying any configured banned tag (see bannedIdSet).
  if (ids.length) {
    const banned = await bannedIdSet(query, version);
    if (banned) ids = ids.filter((id) => !banned.has(id));
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Banned-tag exclusion (mirrors the nHentai provider's buildBannedExclusions)
// ---------------------------------------------------------------------------

/**
 * Resolve one configured banned tag into the gallery ids carrying it. The
 * entry uses the same grammar as search queries: a plain keyword matches
 * anywhere in the index (like a bare search term), while `ns:tag` (e.g.
 * `artist:foo`) resolves through the nozomi endpoint, so namespaced bans are
 * scoped to that area instead of matching every field that mentions the name.
 * Multi-word entries AND-intersect their terms, mirroring how search combines
 * them — "aoi kajitsu" excludes galleries tagged with both, not either word.
 */
async function resolveBannedEntry(entry: string, version: string): Promise<number[]> {
  const terms = tokenizeQuery(entry);
  if (!terms.length) return [];
  const sets = await Promise.all(
    terms.map(async (t) => {
      const f = t.ns ? nozomiFilterFromTerm(`${t.ns}:${t.val}`) : null;
      return f ? fetchNozomiIds(f) : getGalleryIdsForTerm(t.val.toLowerCase(), version);
    })
  );
  return intersectIds(sets);
}

/**
 * The gallery ids carrying any configured banned tag, or null when nothing is
 * banned for this query. A banned entry whose terms all appear verbatim in the
 * query was explicitly requested and is skipped, so searching a banned tag
 * still returns results.
 *
 * Resolved entries are immutable for a given galleriesindex version, so they
 * are cached per version (an index rebuild bumps the version and misses every
 * entry). Empty resolutions are deliberately not cached: a transient CDN
 * failure must fail open on the next search instead of silently disabling a
 * ban until the index changes.
 */
let bannedCache: { version: string; entries: Map<string, number[]> } | null = null;

async function bannedIdSet(query: string, version: string): Promise<Set<number> | null> {
  let rawTags: unknown;
  try {
    rawTags = getDownloaderSettings().hitomiBannedTags;
  } catch {
    return null; // DB not ready yet — fail open.
  }
  if (!Array.isArray(rawTags) || !rawTags.length) return null;

  const termKey = (t: { ns?: string; val: string }) => (t.ns ? `${t.ns.toLowerCase()}:${t.val}` : t.val.toLowerCase());
  const queryTerms = new Set(tokenizeQuery(query).map(termKey));

  if (!bannedCache || bannedCache.version !== version) {
    bannedCache = { version, entries: new Map() };
  }
  const banned = new Set<number>();
  for (const raw of rawTags) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    const terms = tokenizeQuery(entry);
    // Explicitly searched (every term of the entry appears verbatim) — this
    // ban doesn't apply to the current query.
    if (terms.length && terms.every((t) => queryTerms.has(termKey(t)))) continue;
    let ids = bannedCache.entries.get(entry);
    if (ids === undefined) {
      try {
        ids = await resolveBannedEntry(entry, version);
      } catch {
        continue; // fail open — a lookup error must not blank the search.
      }
      if (ids.length) bannedCache.entries.set(entry, ids);
    }
    for (const id of ids) banned.add(id);
  }
  return banned.size ? banned : null;
}

// ---------------------------------------------------------------------------
// Tag suggestions (mirrors live search.js get_suggestions_for_query)
// ---------------------------------------------------------------------------

interface TagSuggestion {
  name: string;
  count: number;
  ns: string;
}

/**
 * Fetch tag suggestions from the tag index. Mirrors the live site's
 * `get_suggestions_for_query`: each character of the (lowercased) term becomes a
 * path segment under `{field}`, yielding `[name, count, namespace]` triples.
 */
async function fetchTagSuggestions(field: string, term: string): Promise<TagSuggestion[]> {
  if (!term) return [];

  const encoded = term.toLowerCase().replace(/_/g, ' ');
  const chars = encoded.split('').map((c) => (c === '/' ? 'slash' : c === '.' ? 'dot' : c));

  let url = `${TAG_INDEX}/${field}`;
  if (chars.length > 0) url += '/' + chars.join('/');
  url += '.json';

  try {
    const r = await fetch(url, { headers: { ...headers() } });
    if (r.status !== 200) return [];
    const data: unknown = await r.json();
    if (!Array.isArray(data)) return [];
    const out: TagSuggestion[] = [];
    for (const item of data) {
      if (!Array.isArray(item) || item.length < 3) continue;
      const [name, count, ns] = item as [string, number, string];
      if (typeof name !== 'string') continue;
      out.push({ name, count: typeof count === 'number' ? count : 0, ns: String(ns) });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Hitomi popularity periods behind the `orderby:popular orderbykey:<period>` sort. */
const HITOMI_POPULAR_PERIODS: Partial<Record<DoujinSort, 'today' | 'week' | 'year'>> = {
  'popular-today': 'today',
  'popular-week': 'week',
  'popular-year': 'year',
};
/** Gallery types omitted from every hitomi search result (hitomi's "image set"). */
const EXCLUDED_GALLERY_TYPES: Record<string, true> = { imageset: true };

export const hitomiProvider: DoujinProvider = {
  id: 'hitomi',
  name: 'Hitomi.la',
  color: '#ff5722',

  async search(query: string, limit = 24, sort?: DoujinSort, opts?: DoujinSearchOptions): Promise<DoujinSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    // A bare gallery id / URL resolves to that single gallery.
    const directId = extractGalleryId(q, GALLERY_URL_RE);
    if (directId && /^\d+$/.test(q)) {
      const g = await this.getGallery(directId);
      return [
        {
          source: 'hitomi',
          galleryId: g.galleryId,
          title: g.title,
          coverUrl: g.coverUrl,
          language: g.language,
          tags: g.tags,
          artists: g.artists,
          pageCount: g.pageCount,
          url: g.url,
          uploadedAt: g.uploadedAt,
        },
      ];
    }

    const version = await getGalleriesIndexVersion();
    const ids = await searchGalleryIds(q, version, HITOMI_POPULAR_PERIODS[sort ?? 'default']);
    if (!ids.length) return [];

    // Hydrate results with metadata (one request each), in bounded batches so a
    // large result set doesn't open thousands of concurrent connections. `ids`
    // keeps the ordering the index returned (popularity when a popular sort was
    // requested, otherwise newest-first), so batching preserves it. Excluded
    // types (image sets, plus any caller-specified types) are dropped during
    // hydration and backfilled from later candidates so results still fill to
    // `limit` where possible; the scan caps at 4x the target to bound lookups on type-heavy queries.
    // A `skip` option slides the hydration window down the ranking (recommendations
    // use it to rotate a static popularity list across refreshes).
    const target = Math.max(limit, 1);
    const start = Math.min(Math.max(opts?.skip ?? 0, 0), ids.length);
    const scanLimit = Math.min(ids.length - start, target * 4);
    // Base exclusions plus caller-specified types (recommendations drop artist CGs too).
    const excludedTypes = new Set(Object.keys(EXCLUDED_GALLERY_TYPES));
    for (const t of opts?.excludeTypes ?? []) excludedTypes.add(t.toLowerCase().replace(/[^a-z]/g, ''));
    const out: DoujinSearchResult[] = [];
    const BATCH = 25;
    for (let i = 0; i < scanLimit && out.length < target; i += BATCH) {
      await Promise.all(
        ids.slice(start + i, Math.min(start + i + BATCH, start + scanLimit)).map(async (id) => {
          if (out.length >= target) return;
          try {
            const info = parseGalleryInfo(await fetchText(`${API_BASE}/galleries/${id}.js`));
            const type = typeof info.type === 'string' ? info.type.toLowerCase().replace(/[^a-z]/g, '') : '';
            if (excludedTypes.has(type)) return;
            const gg = await loadGG();
            const files: HitomiFile[] = info.files ?? [];
            out.push({
              source: 'hitomi',
              galleryId: String(id),
              title: stripTags(info.title) || `Gallery ${id}`,
              coverUrl: coverUrlFor(gg, files),
              language: typeof info.language === 'string' && info.language ? info.language : undefined,
              tags: (info.tags ?? []).map(tagValue).filter(Boolean).slice(0, 24),
              artists: (info.artists ?? []).map(tagValue).filter(Boolean).slice(0, 8),
              pageCount: files.length || undefined,
              url: galleryUrlFor(info, String(id)),
              uploadedAt: toIsoDate(info.date),
            });
          } catch {
            /* skip failed lookups */
          }
        }),
      );
    }

    // Preserve ranking order (popularity when a popular sort was requested, otherwise newest-first).
    const byId = new Map(out.map((r) => [r.galleryId, r]));
    return ids.slice(start).map((id) => byId.get(String(id))).filter((r): r is DoujinSearchResult => !!r).slice(0, target);
  },

  /**
   * Tag/artist autocomplete, mirroring the live site's search dropdown. Backed
   * by `tagindex.hitomi.la`, which returns [name, count, namespace] triples for
   * a character-prefix query. If the seed contains a colon (e.g. "artist:charu"),
   * the part before it scopes the lookup to that namespace; otherwise 'global'.
   */
  async suggest(query: string, limit = 10): Promise<DoujinSuggestion[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    let field = 'global';
    let term = q;
    if (q.includes(':')) {
      const [ns, ...rest] = q.split(':');
      if (ns) field = ns;
      term = rest.join(':');
    }
    if (!term) return [];

    const suggestions = await fetchTagSuggestions(field, term);
    const out: DoujinSuggestion[] = [];
    for (const s of suggestions.slice(0, Math.max(limit, 1))) {
      // Filter fragment is `ns:tag_name` with spaces as underscores, which the
      // search() nozomi path understands (e.g. "artist:charu", "language:english").
      const filter = `${s.ns}:${s.name.replace(/\s/g, '_')}`;
      out.push({
        source: 'hitomi',
        type: s.ns,
        name: s.name,
        count: s.count,
        filter,
      });
    }
    return out;
  },

  async getGallery(idOrUrl: string): Promise<DoujinGallery> {
    const id = extractGalleryId(idOrUrl, GALLERY_URL_RE);
    if (!id) throw new Error('Could not parse a Hitomi gallery ID from the input.');

    // The gallery JSON and the gg.js routing table are independent fetches (gg
    // is only consumed after the files list is parsed), so load them in
    // parallel; both must succeed for the gallery to resolve.
    const [infoText, gg] = await Promise.all([fetchText(`${API_BASE}/galleries/${id}.js`), loadGG()]);
    const info = parseGalleryInfo(infoText);
    const files: HitomiFile[] = info.files ?? [];
    if (!files.length) throw new Error(`Could not find any images for Hitomi gallery ${id}.`);

    // Per-page refs capture just enough (hash + renditions) to rebuild a fresh
    // image URL at download time. The static `pages`/`pageFallbacks` below are
    // built once for compatibility, but the engine re-resolves via
    // `resolvePageUrl` so long downloads survive CDN base-path rotation.
    const refs: HitomiPageRef[] = [];
    for (const f of files) {
      if (!f?.hash) continue;
      const ref: HitomiPageRef = { hash: f.hash };
      if (f.hasavif) {
        ref.ext = 'avif';
        if (f.haswebp) ref.fallbackExt = 'webp';
      } else if (f.haswebp) {
        ref.ext = 'webp';
      } else {
        // Original format — no compressed rendition; keep the original extension.
        ref.origExt = f.name.split('.').pop()?.toLowerCase() ?? 'jpg';
      }
      refs.push(ref);
    }

    // Primary pages: AVIF when available (best compression/quality), else WEBP,
    // else a constructed original URL. Fallbacks give the engine a second path.
    const pages: string[] = [];
    const pageFallbacks: (string | null)[] = [];
    for (const ref of refs) {
      if (ref.ext) {
        pages.push(imageUrl(gg, ref.hash, ref.ext));
        pageFallbacks.push(ref.fallbackExt && ref.fallbackExt !== ref.ext ? imageUrl(gg, ref.hash, ref.fallbackExt) : null);
      } else {
        // Original format — bare numeric subdomain (no letter prefix).
        pages.push(originalUrl(gg, ref.hash, ref.origExt ?? 'jpg'));
        pageFallbacks.push(null);
      }
    }

    const title = stripTags(info.title) || `Gallery ${id}`;
    const artists = (info.artists ?? []).map(tagValue).filter(Boolean);
    const characters = (info.characters ?? []).map(tagValue).filter(Boolean);
    const groups = (info.groups ?? []).map(tagValue).filter(Boolean);
    const parodies = (info.parodys ?? info.parody ?? []).map(tagValue).filter(Boolean);
    const series = parodies[0] ?? undefined;
    const language = typeof info.language === 'string' && info.language ? info.language : undefined;
    // Tags keep their search area (female/male) so the UI can build a namespaced
    // query per tag; unflagged tags stay plain keywords.
    const tags: string[] = [];
    const tagNamespaces: (string | undefined)[] = [];
    for (const t of info.tags ?? []) {
      if (tags.length >= 40) break;
      const name = tagValue(t);
      if (!name) continue;
      tags.push(name);
      tagNamespaces.push(tagNamespace(t));
    }
    const uploadedAt = toIsoDate(info.date);

    return {
      source: 'hitomi',
      galleryId: id,
      title,
      coverUrl: coverUrlFor(gg, files),
      language,
      series,
      characters,
      parodies,
      artists,
      tags,
      tagNamespaces,
      groups,
      pageCount: files.length,
      pages,
      pageFallbacks,
      uploadedAt,
      // The image CDN rejects requests that lack a hitomi.la Referer.
      requestHeaders: { Referer: `${BASE}/` },
      url: galleryUrlFor(info, id),
      // Re-resolve a page's URL against the *current* gg.js routing table so the
      // engine can build it moments before the request (and force-refresh after a
      // 404, in case the CDN base path rotated mid-download).
      resolvePageUrl: async (index, opts) => {
        const ref = refs[index];
        if (!ref) return null;
        if (!opts?.forceRefresh) {
          // Normal path: both builders share the short-lived gg cache, so the
          // second lookup does not re-fetch.
          const url = await buildHitomiPageUrl(ref);
          const fallback = await buildHitomiPageFallbackUrlLive(ref);
          return { url, fallback };
        }
        // Force-refresh path: load the routing table ONCE and hand it to both
        // builders — letting each force-refresh would fetch gg.js twice for a
        // single page resolution.
        const shared = { preloadedGg: await loadGG(true) };
        const url = await buildHitomiPageUrl(ref, shared);
        const fallback = await buildHitomiPageFallbackUrlLive(ref, shared);
        return { url, fallback };
      },
    };
  },
};

/** Async fallback builder (fresh routing table) for the live resolver. */
async function buildHitomiPageFallbackUrlLive(
  ref: HitomiPageRef,
  opts?: { forceGgRefresh?: boolean; preloadedGg?: GG },
): Promise<string | null> {
  if (!ref.fallbackExt || ref.fallbackExt === ref.ext) return null;
  const gg = opts?.preloadedGg ?? (await loadGG(opts?.forceGgRefresh));
  return imageUrl(gg, ref.hash, ref.fallbackExt);
}
