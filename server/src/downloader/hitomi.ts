import crypto from 'node:crypto';
import { fetchBuffer } from '../lib/http.js';
import { extractGalleryId, stripTags } from './util.js';
import type { DoujinGallery, DoujinProvider, DoujinSearchResult } from './types.js';

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
 *   - Search: a B-tree over `/galleriesindex/galleries.{version}.index`
 *     (node tree) + `.data` (values), keyed by the first 4 bytes of
 *     SHA-256(term). Nodes are fetched with HTTP Range requests.
 *
 * `gg.js` is re-fetched (and cached briefly) so its rotating base path and
 * routing table stay in sync with the live site. Image requests must carry a
 * hitomi.la Referer header, which the provider attaches via `requestHeaders`.
 */

const BASE = 'https://hitomi.la';
const CDN = 'gold-usergeneratedcontent.net';
const API_BASE = `https://ltn.${CDN}`;
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
// B-tree search (mirrors live search.js get_galleryids_for_query)
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

/** Resolve the gallery ids that exactly match a single search term. */
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

/**
 * Search gallery ids for a query. A single term is hashed directly; multi-word
 * queries are split and each term's id set is unioned (so "one piece" returns
 * galleries matching either word).
 */
async function searchGalleryIds(query: string, version: string): Promise<number[]> {
  // Normalize the query into tag terms. Hitomi uses '_' for spaces in tags and
  // ':' is not part of any tag (e.g. "re:zero" is tagged "rezero"), so colons
  // are removed and underscores become term separators.
  const terms = query.replace(/_/g, ' ').replace(/:/g, '').trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  if (terms.length === 1) return getGalleryIdsForTerm(terms[0], version);

  const sets = await Promise.all(terms.map((t) => getGalleryIdsForTerm(t, version)));
  const merged: number[] = [];
  for (const set of sets) {
    if (!set.length) continue;
    if (!merged.length) {
      merged.push(...set);
      continue;
    }
    // Union while keeping the most-recent-first order of each set.
    const seen = new Set<number>(merged);
    for (const id of set) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
  }
  return merged;
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
      // The image CDN rejects requests that lack a hitomi.la Referer.
      requestHeaders: { Referer: `${BASE}/` },
      url: `${BASE}/${id}`,
    };
  },
};
