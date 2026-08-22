import crypto from 'node:crypto';
import { fetchBuffer } from '../lib/http.js';
import { extractGalleryId, stripTags, toIsoDate } from './util.js';
import type { DoujinGallery, DoujinProvider, DoujinSearchResult, DoujinSuggestion } from './types.js';

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
// the cache short to avoid building URLs against a stale prefix mid-download.
const GG_CACHE_TTL_MS = 90 * 1000;

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

async function loadGG(): Promise<GG> {
  if (ggCache && Date.now() - ggCache.at < GG_CACHE_TTL_MS) return ggCache.value;
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

function subdomainPrefix(gg: GG, hash: string, dir: 'avif' | 'webp'): string {
  // The image CDN host is a single letter ('a' for avif, 'w' for webp) followed
  // by (1 + gg.m(g)) where g is the last 3 hex chars of the hash as an int.
  const letter = dir === 'avif' ? 'a' : 'w';
  // Match the last three hex chars of the bare 64-char hash. (The live client
  // runs this against the full image URL, which has a leading '/'; here we pass
  // just the hash, so no slash is required.)
  const m = /[0-9a-f]{61}([0-9a-f]{2})([0-9a-f])/.exec(hash);
  if (!m) return letter;
  const g = parseInt(m[2] + m[1], 16);
  if (Number.isNaN(g)) return letter;
  return `${letter}${1 + gg.m(g)}`;
}

function imageUrl(gg: GG, hash: string, ext: 'avif' | 'webp'): string {
  const prefix = subdomainPrefix(gg, hash, ext);
  return `https://${prefix}.${CDN}/${gg.b}${gg.s(hash)}/${hash}.${ext}`;
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

function tagValue(t: any): string {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object') return String(t.tag ?? t.artist ?? t.character ?? '');
  return '';
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

/** Resolve the gallery ids that exactly match a single keyword term. */
async function getGalleryIdsForTerm(term: string, version: string): Promise<number[]> {
  const key = hashTerm(term);
  const indexUrl = `${API_BASE}/galleriesindex/galleries.${version}.index`;
  const dataUrl = `${API_BASE}/galleriesindex/galleries.${version}.data`;

  let addr = 0n;
  for (let depth = 0; depth < 12; depth++) {
    const buf = await rangeFetch(indexUrl, Number(addr), Number(addr) + MAX_NODE_SIZE - 1);
    const node = decodeNode(buf);
    if (!node.keys.length) return [];

    let there = false;
    let where = 0;
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

/** Fetch the big-endian int32 gallery-id list from a nozomi filter. */
async function fetchNozomiIds(f: NozomiFilter): Promise<number[]> {
  try {
    const r = await fetch(nozomiUrl(f), { headers: { ...headers() } });
    if (r.status !== 200) return [];
    const buf = Buffer.from(await r.arrayBuffer());
    const count = Math.floor(buf.byteLength / 4);
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(buf.readInt32BE(i * 4));
    return ids;
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

/** Union a list of id sets, preserving first-seen (newest-first) order. */
function unionIds(sets: number[][]): number[] {
  const merged: number[] = [];
  const seen = new Set<number>();
  for (const set of sets) {
    for (const id of set) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
  }
  return merged;
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
 */
async function searchGalleryIds(query: string, version: string): Promise<number[]> {
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];

  // Hitomi's keyword index is built from lowercased terms, so the B-tree lookup
  // is case-sensitive. Lowercase bare keywords (e.g. "Chibikko" → "chibikko") so
  // a naturally-capitalized title still matches.
  const btreeTerm = (t: { val: string }) => getGalleryIdsForTerm(t.val.toLowerCase(), version);

  // No namespaced term → plain keyword search (union of per-term lookups, so
  // "one piece" returns galleries matching either word).
  if (!terms.some((t) => t.ns)) {
    const sets = await Promise.all(terms.map(btreeTerm));
    return unionIds(sets);
  }

  // Filtered search: AND-intersect every term (nozomi for namespaced terms,
  // B-tree for bare keywords).
  const sets = await Promise.all(
    terms.map(async (t) => {
      if (t.ns) {
        const f = nozomiFilterFromTerm(`${t.ns}:${t.val}`);
        return f ? fetchNozomiIds(f) : [];
      }
      return btreeTerm(t);
    })
  );
  return intersectIds(sets);
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

export const hitomiProvider: DoujinProvider = {
  id: 'hitomi',
  name: 'Hitomi.la',
  color: '#ff5722',

  async search(query: string, limit = 24): Promise<DoujinSearchResult[]> {
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
    const ids = await searchGalleryIds(q, version);
    if (!ids.length) return [];

    // Hydrate the top N results with metadata (one request each), in bounded
    // batches so a large result set doesn't open thousands of concurrent
    // connections. `ids` is newest-first, so batching preserves recency order.
    const target = Math.max(limit, 1);
    const candidates = ids.slice(0, target);
    const out: DoujinSearchResult[] = [];
    const BATCH = 25;
    for (let i = 0; i < candidates.length && out.length < target; i += BATCH) {
      await Promise.all(
        candidates.slice(i, i + BATCH).map(async (id) => {
          if (out.length >= target) return;
          try {
            const info = parseGalleryInfo(await fetchText(`${API_BASE}/galleries/${id}.js`));
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
              url: `${BASE}/${id}`,
              uploadedAt: toIsoDate(info.date),
            });
          } catch {
            /* skip failed lookups */
          }
        }),
      );
    }

    // Preserve recency order (ids are newest-first).
    const byId = new Map(out.map((r) => [r.galleryId, r]));
    return ids.map((id) => byId.get(String(id))).filter((r): r is DoujinSearchResult => !!r).slice(0, target);
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

    const info = parseGalleryInfo(await fetchText(`${API_BASE}/galleries/${id}.js`));
    const files: HitomiFile[] = info.files ?? [];
    if (!files.length) throw new Error(`Could not find any images for Hitomi gallery ${id}.`);

    const gg = await loadGG();

    // Primary pages: AVIF when available (best compression/quality), else WEBP,
    // else a constructed original URL. Fallbacks give the engine a second path.
    const pages: string[] = [];
    const pageFallbacks: (string | null)[] = [];
    for (const f of files) {
      if (!f?.hash) continue;
      let primary: string | null = null;
      let fallback: string | null = null;
      if (f.hasavif) {
        primary = imageUrl(gg, f.hash, 'avif');
        if (f.haswebp) fallback = imageUrl(gg, f.hash, 'webp');
      } else if (f.haswebp) {
        primary = imageUrl(gg, f.hash, 'webp');
      } else {
        // Original format — best-effort path without a known extension.
        const ext = f.name.split('.').pop()?.toLowerCase() ?? 'jpg';
        primary = `https://a.${CDN}/${gg.b}${gg.s(f.hash)}/${f.hash}.${ext}`;
      }
      pages.push(primary);
      pageFallbacks.push(fallback);
    }

    const title = stripTags(info.title) || `Gallery ${id}`;
    const artists = (info.artists ?? []).map(tagValue).filter(Boolean);
    const characters = (info.characters ?? []).map(tagValue).filter(Boolean);
    const groups = (info.groups ?? []).map(tagValue).filter(Boolean);
    const parodies = (info.parodys ?? info.parody ?? []).map(tagValue).filter(Boolean);
    const series = parodies[0] ?? undefined;
    const language = typeof info.language === 'string' && info.language ? info.language : undefined;
    const tags = (info.tags ?? []).map(tagValue).filter(Boolean).slice(0, 40);
    const uploadedAt = toIsoDate(info.date);

    return {
      source: 'hitomi',
      galleryId: id,
      title,
      coverUrl: coverUrlFor(gg, files),
      language,
      series,
      artists,
      tags,
      groups,
      genres: characters.slice(0, 12),
      pageCount: files.length,
      pages,
      pageFallbacks,
      uploadedAt,
      // The image CDN rejects requests that lack a hitomi.la Referer.
      requestHeaders: { Referer: `${BASE}/` },
      url: `${BASE}/${id}`,
    };
  },
};
