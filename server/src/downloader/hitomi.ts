import crypto from "node:crypto";
import vm from "node:vm";
import {
  hitomiNozomiPath,
  hitomiStateForTerm,
  normalizeHitomiQuery,
  parseHitomiSearch,
} from "./hitomiSearch.js";
import { fetchBuffer, mapLimit } from "../lib/http.js";
import { getDownloaderSettings } from "../services/settings.js";
import { stripTags, toIsoDate } from "./util.js";
import type {
  DoujinGallery,
  DoujinProvider,
  DoujinSearchOptions,
  DoujinSearchResult,
  DoujinSuggestion,
  DoujinSort,
} from "./types.js";

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

const BASE = "https://hitomi.la";
const CDN = "gold-usergeneratedcontent.net";
const API_BASE = `https://ltn.${CDN}`;
// Tag-autocomplete index. GET {TAG_INDEX}/{field}/{c1}/{c2}...json returns an
// array of [name, count, namespace] triples for the character-prefix query — this
// is exactly what powers the live site's search dropdown (see search.js).
const TAG_INDEX = "https://tagindex.hitomi.la";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0";
/** Accept the site's reader, gallery, and title-slug URLs, with an exact host. */
function galleryIdFromInput(input: string): string | null {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      url.hostname !== "hitomi.la" ||
      !["https:", "http:"].includes(url.protocol)
    )
      return null;
    return (
      url.pathname.match(/^\/(?:reader|galleries)\/(\d+)\.html$/)?.[1] ??
      url.pathname.match(/^\/[^/]+\/[^/]+-(\d+)\.html$/)?.[1] ??
      url.pathname.match(/^\/(\d+)\/?$/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

const MAX_NODE_SIZE = 464;
const B = 16;
// gg.js rotates its base path (gg.b) and routing table every few minutes, so keep
// the cache short to avoid building URLs against a stale prefix mid-download. The
// CDN answers 404 for any base path older than the current one, so this must be
// well under the rotation cadence (~1-2 min observed).
const GG_CACHE_TTL_MS = 20 * 1000;

function headers(): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
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
let ggLoading: Promise<GG> | null = null;

/** Load the live CDN routing table, honoring a short cache unless `force`. */
async function loadGG(force = false): Promise<GG> {
  if (!force && ggCache && Date.now() - ggCache.at < GG_CACHE_TTL_MS)
    return ggCache.value;
  if (ggLoading) return ggLoading;
  ggLoading = loadFreshGG();
  try {
    return await ggLoading;
  } finally {
    ggLoading = null;
  }
}

async function loadFreshGG(): Promise<GG> {
  const code = await fetchText(`${API_BASE}/gg.js`);
  // gg.js begins with 'use strict'; and assigns to a bare `gg`. Run in an
  // isolated VM context with `gg` pre-defined so Node globals stay unreachable.
  const context = vm.createContext({ gg: {} as Partial<GG> });
  vm.runInContext(code, context, { timeout: 500 });
  const gg = context.gg as GG;
  if (
    typeof gg.m !== "function" ||
    typeof gg.s !== "function" ||
    typeof gg.b !== "string"
  ) {
    throw new Error("Failed to parse Hitomi gg.js CDN routing table.");
  }
  ggCache = { value: gg, at: Date.now() };
  return gg;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const buf = await fetchBuffer(url, {
    headers: headers(),
    ...(signal ? { signal } : {}),
  });
  return buf.toString("utf8");
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
function subdomainPrefix(gg: GG, hash: string, dir: "avif" | "webp"): string {
  const letter = dir === "avif" ? "a" : "w";
  const n = subdomainNumber(gg, hash);
  return n === null ? letter : `${letter}${n}`;
}

function imageUrl(gg: GG, hash: string, ext: "avif" | "webp"): string {
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
  const host = n === null ? "a" : String(n);
  return `https://${host}.${CDN}/${gg.b}${gg.s(hash)}/${hash}.${ext}`;
}

/** Per-page source metadata needed to rebuild a fresh image URL on demand. */
export interface HitomiPageRef {
  hash: string;
  /** Preferred compressed extension ('avif' | 'webp'), when the file has one. */
  ext?: "avif" | "webp";
  /** Fallback compressed extension (used when the primary fails to download). */
  fallbackExt?: "avif" | "webp";
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
  opts?: { forceGgRefresh?: boolean; preloadedGg?: GG }
): Promise<string> {
  const gg = opts?.preloadedGg ?? (await loadGG(opts?.forceGgRefresh));
  if (ref.ext) return imageUrl(gg, ref.hash, ref.ext);
  // Original format — no compressed rendition; bare numeric subdomain.
  return originalUrl(gg, ref.hash, ref.origExt ?? "jpg");
}

/** Rebuild a cached Hitomi image URL against the current rotating CDN route. */
export async function refreshHitomiImageUrl(
  url: string
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith(".gold-usergeneratedcontent.net")) return null;
  const match = /\/([0-9a-f]{64})\.(avif|webp)$/i.exec(parsed.pathname);
  if (!match) return null;
  return buildHitomiPageUrl(
    {
      hash: match[1].toLowerCase(),
      ext: match[2].toLowerCase() as "avif" | "webp",
    },
    { forceGgRefresh: true }
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

interface HitomiGalleryInfo {
  type?: string;
  title?: string;
  language?: string | null;
  date?: string | number;
  galleryurl?: string;
  files?: HitomiFile[];
  tags?: (HitomiTagEntry | string)[];
  artists?: (HitomiTagEntry | string)[];
  characters?: (HitomiTagEntry | string)[];
  groups?: (HitomiTagEntry | string)[];
  parodys?: (HitomiTagEntry | string)[];
  parody?: (HitomiTagEntry | string)[];
}

function parseGalleryInfo(text: string): HitomiGalleryInfo {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("Could not locate galleryinfo object.");
  // Find the matching closing brace (balanced, string-aware).
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0)
        return JSON.parse(text.slice(start, i + 1)) as HitomiGalleryInfo;
    }
  }
  throw new Error("Could not parse galleryinfo object.");
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
  if (typeof t === "string") return t;
  return String(t.tag ?? t.artist ?? t.character ?? t.group ?? "");
}

/**
 * Search area for a gallery tag. Hitomi's galleryinfo tags carry `female`/`male`
 * flags ("1" when the tag belongs to that area); unflagged tags (e.g. "digital")
 * have no area and are searched as plain keywords.
 */
function tagNamespace(t: HitomiTagEntry | string): string | undefined {
  if (typeof t === "string") return undefined;
  if (t.female) return "female";
  if (t.male) return "male";
  return undefined;
}

/**
 * Canonical human-facing page URL for a gallery, e.g.
 * `/doujinshi/nozokare-roshutsu-shoujo-ii-english-4114741.html`. The bare
 * `/{id}` path 404s on the live site, so prefer the API's `galleryurl` field.
 */
function galleryUrlFor(info: { galleryurl?: unknown }, id: string): string {
  const path =
    typeof info.galleryurl === "string" && info.galleryurl
      ? info.galleryurl
      : `/${id}`;
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function coverUrlFor(gg: GG, files: HitomiFile[]): string | undefined {
  const f = files?.[0];
  if (!f) return undefined;
  if (f.haswebp) return imageUrl(gg, f.hash, "webp");
  if (f.hasavif) return imageUrl(gg, f.hash, "avif");
  return undefined;
}

// ---------------------------------------------------------------------------
// B-tree keyword search (mirrors live search.js get_galleryids_for_query)
// ---------------------------------------------------------------------------

function hashTerm(term: string): Uint8Array {
  return new Uint8Array(
    crypto.createHash("sha256").update(term, "utf8").digest().subarray(0, 4)
  );
}

/** Per-request upper bounds so a stalled CDN connection cannot pin a search forever. */
const RANGE_TIMEOUT_MS = 15_000;
const NOZOMI_TIMEOUT_MS = 30_000;
const SUGGEST_TIMEOUT_MS = 10_000;

/** A request timeout, combined with an optional caller cancellation signal. */
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** Release an unread response body so undici can reuse the socket. */
function discardBody(r: Response): void {
  void r.body?.cancel().catch(() => undefined);
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Aborted")
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Aborted")
      );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function rangeFetch(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const r = await fetch(url, {
    headers: { ...headers(), Range: `bytes=${start}-${end}` },
    signal: requestSignal(RANGE_TIMEOUT_MS, signal),
  });
  if (r.status !== 200 && r.status !== 206) {
    discardBody(r);
    throw new Error(`Hitomi range request failed (HTTP ${r.status})`);
  }
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
    if (!ks || ks > 32)
      throw new Error("Malformed Hitomi B-tree node key size.");
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

let galleriesIndexVersion: { value: string; at: number } | null = null;
let versionInflight: Promise<string> | null = null;

async function getGalleriesIndexVersion(signal?: AbortSignal): Promise<string> {
  if (galleriesIndexVersion && Date.now() - galleriesIndexVersion.at < 30_000)
    return galleriesIndexVersion.value;
  if (!versionInflight) {
    versionInflight = fetchText(
      `${API_BASE}/galleriesindex/version?_=${Date.now()}`
    )
      .then((v) => {
        const value = v.trim();
        galleriesIndexVersion = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        versionInflight = null;
      });
  }
  return raceAbort(versionInflight, signal);
}

/**
 * Decoded B-tree node LRU, keyed `${indexVersion}:${addr}`. Index nodes are
 * immutable for a given galleriesindex version, so caching them removes the up
 * to 12 sequential range reads per term on repeat lookups; the version in the
 * key makes a version change miss every entry (implicit invalidation). The
 * final gallery-id data fetch stays uncached — it is one read per exact match.
 */
const btreeNodeCache = new Map<string, BTreeNode>();
const btreeNodeInflight = new Map<string, Promise<BTreeNode>>();
const BTREE_NODE_CACHE_MAX = 256;

async function loadBTreeNode(
  indexUrl: string,
  version: string,
  addr: bigint,
  signal?: AbortSignal
): Promise<BTreeNode> {
  const nodeKey = `${version}:${addr}`;
  const cached = btreeNodeCache.get(nodeKey);
  if (cached) {
    btreeNodeCache.delete(nodeKey);
    btreeNodeCache.set(nodeKey, cached);
    return cached;
  }
  let pending = btreeNodeInflight.get(nodeKey);
  if (!pending) {
    pending = rangeFetch(
      indexUrl,
      Number(addr),
      Number(addr) + MAX_NODE_SIZE - 1
    )
      .then((buf) => {
        const node = decodeNode(buf);
        if (btreeNodeCache.size >= BTREE_NODE_CACHE_MAX) {
          const oldest = btreeNodeCache.keys().next().value;
          if (oldest !== undefined) btreeNodeCache.delete(oldest);
        }
        btreeNodeCache.set(nodeKey, node);
        return node;
      })
      .finally(() => {
        if (btreeNodeInflight.get(nodeKey) === pending)
          btreeNodeInflight.delete(nodeKey);
      });
    btreeNodeInflight.set(nodeKey, pending);
  }
  return raceAbort(pending, signal);
}

/** Resolve the gallery ids that exactly match a single keyword term. */
async function getGalleryIdsForTerm(
  term: string,
  version: string,
  signal?: AbortSignal
): Promise<number[]> {
  const key = hashTerm(term);
  const indexUrl = `${API_BASE}/galleriesindex/galleries.${version}.index`;
  const dataUrl = `${API_BASE}/galleriesindex/galleries.${version}.data`;

  let addr = 0n;
  for (let depth = 0; depth < 12; depth++) {
    const node = await loadBTreeNode(indexUrl, version, addr, signal);
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
      const d = await rangeFetch(dataUrl, offset, offset + length - 1, signal);
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const count = dv.getInt32(0, false);
      if (count <= 0 || count > 10_000_000) return [];
      const ids = Array.from<number>({ length: count });
      for (let i = 0; i < count; i++) ids[i] = dv.getInt32(4 + i * 4, false);
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
  return f.area
    ? `${API_BASE}/n/${f.area}/${tail}.nozomi`
    : `${API_BASE}/n/${tail}.nozomi`;
}

/** Parse a nozomi payload: big-endian int32 gallery-id list. */
function parseNozomiIds(buf: Buffer): number[] {
  const count = Math.floor(buf.byteLength / 4);
  const ids = Array.from<number>({ length: count });
  for (let i = 0; i < count; i++) ids[i] = buf.readInt32BE(i * 4);
  return ids;
}

/** Fetch the big-endian int32 gallery-id list from a nozomi filter. */
async function fetchNozomiIds(
  f: NozomiFilter,
  strict = false,
  signal?: AbortSignal
): Promise<number[]> {
  return fetchNozomiUrl(nozomiUrl(f), strict, signal);
}

/**
 * Short-lived cache of decoded `.nozomi` payloads (successful 200s only), with
 * in-flight dedupe. The ranking indexes are multi-megabyte and every keyword
 * search starts from one, so back-to-back searches would otherwise re-download
 * the same index. Entries are bounded by total id count, and the returned
 * arrays are shared: callers must never mutate them.
 */
const NOZOMI_CACHE_TTL_MS = 60_000;
const NOZOMI_CACHE_MAX_IDS = 3_000_000;
const nozomiCache = new Map<
  string,
  { at: number; ids: number[]; set?: Set<number> }
>();
const nozomiInflight = new Map<
  string,
  Promise<{ status: number; ids: number[] }>
>();
let nozomiCacheIds = 0;

function cacheNozomi(url: string, ids: number[]): void {
  if (ids.length > NOZOMI_CACHE_MAX_IDS) return;
  const existing = nozomiCache.get(url);
  if (existing) {
    nozomiCache.delete(url);
    nozomiCacheIds -= existing.ids.length;
  }
  while (
    nozomiCache.size &&
    nozomiCacheIds + ids.length > NOZOMI_CACHE_MAX_IDS
  ) {
    const [oldestKey, oldest] = nozomiCache.entries().next().value!;
    nozomiCache.delete(oldestKey);
    nozomiCacheIds -= oldest.ids.length;
  }
  nozomiCache.set(url, { at: Date.now(), ids });
  nozomiCacheIds += ids.length;
}

async function loadNozomi(
  url: string,
  signal?: AbortSignal
): Promise<{ status: number; ids: number[] }> {
  const cached = nozomiCache.get(url);
  if (cached) {
    if (Date.now() - cached.at < NOZOMI_CACHE_TTL_MS)
      return { status: 200, ids: cached.ids };
    nozomiCache.delete(url);
    nozomiCacheIds -= cached.ids.length;
  }
  let pending = nozomiInflight.get(url);
  if (!pending) {
    pending = (async () => {
      const r = await fetch(url, {
        headers: { ...headers() },
        signal: requestSignal(NOZOMI_TIMEOUT_MS),
      });
      if (r.status !== 200) {
        discardBody(r);
        return { status: r.status, ids: [] as number[] };
      }
      const ids = parseNozomiIds(Buffer.from(await r.arrayBuffer()));
      cacheNozomi(url, ids);
      return { status: 200, ids };
    })().finally(() => {
      if (nozomiInflight.get(url) === pending) nozomiInflight.delete(url);
    });
    nozomiInflight.set(url, pending);
  }
  return raceAbort(pending, signal);
}

/** The ids of one `.nozomi` index (a shared cached array — never mutate it). */
async function fetchNozomiUrl(
  url: string,
  strict = false,
  signal?: AbortSignal
): Promise<number[]> {
  try {
    const { status, ids } = await loadNozomi(url, signal);
    if (status !== 200) {
      if (strict && status !== 404)
        throw new Error(`Hitomi exclusion index HTTP ${status}`);
      return [];
    }
    return ids;
  } catch (error) {
    if (strict || signal?.aborted) throw error;
    return [];
  }
}

async function getNozomiSet(
  url: string,
  strict = false,
  signal?: AbortSignal
): Promise<Set<number>> {
  const ids = await fetchNozomiUrl(url, strict, signal);
  const entry = nozomiCache.get(url);
  if (entry && entry.ids === ids) {
    return (entry.set ??= new Set(ids));
  }
  return new Set(ids);
}

/** In-place Fisher-Yates shuffle (non-cryptographic: this is display order only). */
function shuffleInPlace(ids: number[]): void {
  for (let index = ids.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    const value = ids[index];
    ids[index] = ids[other];
    ids[other] = value;
  }
}

/**
 * Build a nozomi filter from a single `ns:tag` term, mirroring the live
 * client's `get_galleryids_for_query`. Handles artist:/character:/series:/
 * group:/parody:/type:, plus the special female:/male: (area "tag") and
 * language: (no area, tag "index") cases.
 */
function nozomiFilterFromTerm(term: string): NozomiFilter | null {
  const [ns, ...rest] = term.split(":");
  // The `.nozomi` endpoint is case-sensitive (its indices are built from
  // lowercased tags), so normalize the area and tag value to lowercase.
  const val = rest.join(":").toLowerCase();
  if (!val) return null;
  const area = ns.toLowerCase();
  if (area === "female" || area === "male")
    return { area: "tag", tag: term.toLowerCase(), language: "all" };
  if (area === "language")
    return { area: undefined, tag: "index", language: val };
  return { area, tag: val, language: "all" };
}

/** AND-intersect a list of id sets (empty result if any set is empty). */
function intersectIds(sets: number[][]): number[] {
  if (!sets.length) return [];
  const ordered = [...sets].sort((a, b) => a.length - b.length);
  if (!ordered[0].length) return [];
  let current = new Set(ordered[0]);
  for (let i = 1; i < ordered.length; i++) {
    const next = new Set<number>();
    for (const id of ordered[i]) {
      if (current.has(id)) next.add(id);
    }
    if (!next.size) return [];
    current = next;
  }
  return [...current];
}

/**
 * Split a query into terms the way hitomi.la's results.js does: whitespace is
 * the term separator, and underscores act as escaped spaces *inside* a term
 * ("To enter a tag name with spaces, use the _ character"). So
 * `female:schoolgirl_uniform` stays one namespaced term whose value is
 * "schoolgirl uniform", while bare keywords are de-underscored for the B-tree.
 */
function tokenizeQuery(query: string): { ns?: string; val: string }[] {
  return normalizeHitomiQuery(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const ci = t.indexOf(":");
      if (ci <= 0) return { val: t.replace(/_/g, " ") };
      // Keep the namespace intact; de-underscore only the tag value.
      return { ns: t.slice(0, ci), val: t.slice(ci + 1).replace(/_/g, " ") };
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
 * Resolve date/popularity ordering through the same first positive namespace
 * and scoped ranking indexes as the live site. OR groups form unions; separate
 * groups and positive terms intersect, then negative terms subtract.
 *
 * Configured banned tags are subtracted from the final id set on both paths.
 * A query that names a banned tag verbatim is an explicit request and skips
 * that tag's exclusion, so searching a banned tag still returns results (a
 * bare gallery-id lookup never reaches this function at all).
 */
async function searchGalleryIds(
  query: string,
  version: string,
  sort?: DoujinSort,
  strictExclusions = false,
  defaultLanguage?: string,
  signal?: AbortSignal
): Promise<number[]> {
  const { state, positive, negative, groups } = parseHitomiSearch(
    query,
    sort,
    defaultLanguage
  );
  const resolveList = (term: string) =>
    term.includes(":")
      ? fetchNozomiUrl(
          `${API_BASE}${hitomiNozomiPath(hitomiStateForTerm(term, state))}`,
          false,
          signal
        )
      : getGalleryIdsForTerm(term, version, signal);
  const resolveSet = (term: string) =>
    term.includes(":")
      ? getNozomiSet(
          `${API_BASE}${hitomiNozomiPath(hitomiStateForTerm(term, state))}`,
          false,
          signal
        )
      : getGalleryIdsForTerm(term, version, signal).then(
          (list) => new Set(list)
        );
  // The first positive namespace determines the ranking index on the website.
  // May be a shared cached array: never reorder it in place (the filter loop
  // always builds a fresh array, which is what gets reversed/shuffled).
  const useIndexRanking =
    !positive.length ||
    (!positive[0].includes(":") && state.orderbykey !== "added");
  const basePromise = useIndexRanking
    ? fetchNozomiUrl(`${API_BASE}${hitomiNozomiPath(state)}`, false, signal)
    : resolveList(positive[0]);
  const remainingPositive = useIndexRanking ? positive : positive.slice(1);
  const [ids, allowed, alternatives, excludedSets, banned] = await Promise.all([
    basePromise,
    Promise.all(remainingPositive.map(resolveSet)),
    Promise.all(
      groups.map(async (group) => {
        const lists = await Promise.all(group.map(resolveList));
        const union = new Set<number>();
        for (const list of lists) {
          for (const id of list) union.add(id);
        }
        return union;
      })
    ),
    Promise.all(negative.map(resolveSet)),
    raceAbort(
      bannedIdSet(strictExclusions ? "" : query, version, strictExclusions),
      signal
    ),
  ]);
  if (!ids.length) return [];
  for (let i = 0; i < allowed.length; i++) if (!allowed[i].size) return [];
  for (let i = 0; i < alternatives.length; i++)
    if (!alternatives[i].size) return [];

  const nonEmptyExcluded = excludedSets.filter((s) => s.size > 0);
  const kept: number[] = [];
  outer: for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (banned?.has(id)) continue;
    for (let j = 0; j < allowed.length; j++)
      if (!allowed[j].has(id)) continue outer;
    for (let j = 0; j < alternatives.length; j++)
      if (!alternatives[j].has(id)) continue outer;
    for (let j = 0; j < nonEmptyExcluded.length; j++)
      if (nonEmptyExcluded[j].has(id)) continue outer;
    kept.push(id);
  }
  // Order only the survivors: filtering preserves order, so reversing or
  // shuffling afterwards gives the same distribution as doing it on the full
  // index, without touching the (often hundreds of thousands of) discarded ids.
  if (state.direction === "asc" || state.direction === "ascending")
    kept.reverse();
  else if (state.direction === "random" || state.direction === "rand")
    shuffleInPlace(kept);
  return kept;
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
async function resolveBannedEntry(
  entry: string,
  version: string,
  strict = false
): Promise<number[]> {
  const terms = tokenizeQuery(entry);
  if (!terms.length) return [];
  const sets = await Promise.all(
    terms.map(async (t) => {
      const f = t.ns ? nozomiFilterFromTerm(`${t.ns}:${t.val}`) : null;
      return f
        ? fetchNozomiIds(f, strict)
        : getGalleryIdsForTerm(t.val.toLowerCase(), version);
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
let bannedCache: { version: string; entries: Map<string, number[]> } | null =
  null;
/**
 * Merged exclusion sets for the current index version, keyed by the exact list
 * of applicable entries. Rebuilding a Set over up to ~1M ids on every search is
 * expensive, so it is memoized — but only when every applicable entry resolved
 * to a cached (non-empty) id list, so a transient failure is never frozen in.
 * Callers treat the returned set as read-only.
 */
let bannedMerged: { version: string; sets: Map<string, Set<number>> } | null =
  null;
const BANNED_MERGED_MAX = 2;
const BANNED_RESOLVE_CONCURRENCY = 4;

async function bannedIdSet(
  query: string,
  version: string,
  strict = false
): Promise<Set<number> | null> {
  let rawTags: unknown;
  try {
    rawTags = getDownloaderSettings().hitomiBannedTags;
  } catch {
    return null; // DB not ready yet — fail open.
  }
  if (!Array.isArray(rawTags) || !rawTags.length) return null;

  const termKey = (t: { ns?: string; val: string }) =>
    t.ns ? `${t.ns.toLowerCase()}:${t.val}` : t.val.toLowerCase();
  const queryTerms = new Set(tokenizeQuery(query).map(termKey));

  if (!bannedCache || bannedCache.version !== version) {
    bannedCache = { version, entries: new Map() };
  }
  if (!bannedMerged || bannedMerged.version !== version) {
    bannedMerged = { version, sets: new Map() };
  }
  const entries = bannedCache.entries;
  const merged = bannedMerged.sets;
  const active: string[] = [];
  for (const raw of rawTags) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    const terms = tokenizeQuery(entry);
    // Explicitly searched (every term of the entry appears verbatim) — this
    // ban doesn't apply to the current query.
    if (
      !strict &&
      terms.length &&
      terms.every((t) => queryTerms.has(termKey(t)))
    )
      continue;
    active.push(entry);
  }
  if (!active.length) return null;

  const activeKey = JSON.stringify(active);
  const memo = merged.get(activeKey);
  if (memo) {
    merged.delete(activeKey);
    merged.set(activeKey, memo);
    return memo;
  }

  // Resolve cold entries with bounded parallelism (each one is a few CDN
  // range reads or a nozomi fetch).
  const cold = [...new Set(active.filter((entry) => !entries.has(entry)))];
  let firstError: unknown = null;
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(BANNED_RESOLVE_CONCURRENCY, cold.length) },
      async () => {
        while (next < cold.length && !(strict && firstError)) {
          const entry = cold[next++];
          try {
            const ids = await resolveBannedEntry(entry, version, strict);
            if (ids.length) entries.set(entry, ids);
          } catch (error) {
            // Strict callers fail closed; manual search can still fail open.
            if (strict) firstError ??= error;
          }
        }
      }
    )
  );
  if (strict && firstError)
    throw firstError instanceof Error
      ? firstError
      : new Error(
          typeof firstError === "string"
            ? firstError
            : (JSON.stringify(firstError) ?? "Unknown error")
        );

  const banned = new Set<number>();
  let complete = true;
  for (const entry of active) {
    const ids = entries.get(entry);
    if (!ids) {
      complete = false;
      continue;
    }
    for (const id of ids) banned.add(id);
  }
  if (!banned.size) return null;
  if (complete) {
    while (merged.size >= BANNED_MERGED_MAX)
      merged.delete(merged.keys().next().value!);
    merged.set(activeKey, banned);
  }
  return banned;
}

// ---------------------------------------------------------------------------
// Tag suggestions (mirrors live search.js get_suggestions_for_query)
// ---------------------------------------------------------------------------

interface TagSuggestion {
  name: string;
  count: number;
  ns: string;
}

const TAG_SUGGEST_CACHE_TTL_MS = 5 * 60_000;
const TAG_SUGGEST_CACHE_MAX = 256;
const tagSuggestCache = new Map<
  string,
  { at: number; items: TagSuggestion[] }
>();
const tagSuggestInflight = new Map<string, Promise<TagSuggestion[] | null>>();

/**
 * Fetch tag suggestions from the tag index. Mirrors the live site's
 * `get_suggestions_for_query`: each character of the (lowercased) term becomes a
 * path segment under `{field}`, yielding `[name, count, namespace]` triples.
 */
async function fetchTagSuggestions(
  field: string,
  term: string,
  signal?: AbortSignal
): Promise<TagSuggestion[]> {
  const encoded = term.toLowerCase().replace(/_/g, " ");
  const chars = encoded
    .split("")
    .map((c) =>
      c === " " ? "_" : c === "/" ? "slash" : c === "." ? "dot" : c
    );

  let url = `${TAG_INDEX}/${field}`;
  if (chars.length > 0) url += "/" + chars.join("/");
  url += ".json";

  const cached = tagSuggestCache.get(url);
  if (cached && Date.now() - cached.at < TAG_SUGGEST_CACHE_TTL_MS) {
    tagSuggestCache.delete(url);
    tagSuggestCache.set(url, cached);
    return cached.items;
  }
  if (cached) tagSuggestCache.delete(url);

  let pending = tagSuggestInflight.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const r = await fetch(url, {
          headers: { ...headers() },
          signal: requestSignal(SUGGEST_TIMEOUT_MS),
        });
        if (r.status !== 200) {
          discardBody(r);
          return null;
        }
        const data: unknown = await r.json();
        if (!Array.isArray(data)) return null;
        const out: TagSuggestion[] = [];
        for (const item of data) {
          if (!Array.isArray(item) || item.length < 3) continue;
          const [name, count, ns] = item as [string, number, string];
          if (typeof name !== "string") continue;
          out.push({
            name,
            count: typeof count === "number" ? count : 0,
            ns: String(ns),
          });
        }
        if (tagSuggestCache.size >= TAG_SUGGEST_CACHE_MAX) {
          const oldest = tagSuggestCache.keys().next().value;
          if (oldest !== undefined) tagSuggestCache.delete(oldest);
        }
        tagSuggestCache.set(url, { at: Date.now(), items: out });
        return out;
      } catch {
        return null;
      }
    })().finally(() => {
      if (tagSuggestInflight.get(url) === pending)
        tagSuggestInflight.delete(url);
    });
    tagSuggestInflight.set(url, pending);
  }
  try {
    return (await raceAbort(pending, signal)) ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Gallery types omitted from every hitomi search result (hitomi's "image set"). */
const EXCLUDED_GALLERY_TYPES: Record<string, true> = { imageset: true };

let imageSetIndex: { version: string; ids: Promise<Set<number>> } | null = null;
async function imageSetIds(version: string): Promise<Set<number>> {
  if (imageSetIndex?.version === version) return imageSetIndex.ids;
  const ids = fetchNozomiIds(
    { area: "type", tag: "imageset", language: "all" },
    true
  ).then((list) => new Set(list));
  imageSetIndex = { version, ids };
  try {
    return await ids;
  } catch (error) {
    if (imageSetIndex?.ids === ids) imageSetIndex = null;
    throw error;
  }
}

// Keep one ranking snapshot across page requests, including a random shuffle.
// Match the frontend's five-minute search cache and bound retained catalog IDs.
const searchPageCache = new Map<
  string,
  { expiresAt: number; ids: Promise<number[]>; count: number }
>();
async function pagedSearchIds(
  query: string,
  sort?: DoujinSort,
  signal?: AbortSignal
): Promise<number[]> {
  const key = JSON.stringify([
    normalizeHitomiQuery(query),
    sort ?? "default",
    getDownloaderSettings().hitomiBannedTags,
  ]);
  const cached = searchPageCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    searchPageCache.delete(key);
    searchPageCache.set(key, cached);
    return raceAbort(cached.ids, signal);
  }
  searchPageCache.delete(key);
  while (searchPageCache.size >= 4)
    searchPageCache.delete(searchPageCache.keys().next().value!);
  const ids = (async () => {
    const version = await getGalleriesIndexVersion();
    const [ranked, imageSets] = await Promise.all([
      searchGalleryIds(query, version, sort),
      imageSetIds(version),
    ]);
    return ranked.filter((id) => !imageSets.has(id));
  })();
  const entry = { expiresAt: Date.now() + 5 * 60_000, ids, count: 0 };
  searchPageCache.set(key, entry);
  try {
    const result = await raceAbort(ids, signal);
    entry.count = result.length;
    while (
      searchPageCache.size > 1 &&
      [...searchPageCache.values()].reduce((sum, item) => sum + item.count, 0) >
        2_000_000
    ) {
      searchPageCache.delete(searchPageCache.keys().next().value!);
    }
    return result;
  } catch (error) {
    if (!signal?.aborted && searchPageCache.get(key) === entry)
      searchPageCache.delete(key);
    throw error;
  }
}

const tagInfoCache = new Map<
  string,
  { name: string; ns: string; count: number } | null
>();
const TAG_INFO_CACHE_MAX = 1024;

async function resolveHitomiTagInfo(
  rawName: string
): Promise<{ name: string; ns: string; count: number } | null> {
  const key = rawName
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
  if (!key) return null;
  if (tagInfoCache.has(key)) return tagInfoCache.get(key) ?? null;
  const suggestions = await fetchTagSuggestions("global", key);
  const tagMatches = suggestions.filter(
    (s) =>
      s.name.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ") ===
        key &&
      (s.ns === "female" || s.ns === "male" || s.ns === "tag")
  );
  // Prefer highest gallery count when a tag exists in multiple areas (e.g. female vs male).
  tagMatches.sort((a, b) => b.count - a.count);
  const match = tagMatches[0] ?? null;
  const resolved = match
    ? { name: match.name, ns: match.ns, count: match.count }
    : null;
  if (tagInfoCache.size >= TAG_INFO_CACHE_MAX) {
    const oldest = tagInfoCache.keys().next().value;
    if (oldest !== undefined) tagInfoCache.delete(oldest);
  }
  tagInfoCache.set(key, resolved);
  return resolved;
}

const HITOMI_HYDRATE_CONCURRENCY = 12;
const galleryInfoInflight = new Map<string, Promise<HitomiGalleryInfo>>();

async function loadGalleryInfo(
  id: number | string,
  signal?: AbortSignal
): Promise<HitomiGalleryInfo> {
  const key = String(id);
  let pending = galleryInfoInflight.get(key);
  if (!pending) {
    pending = fetchText(`${API_BASE}/galleries/${key}.js`)
      .then(parseGalleryInfo)
      .finally(() => {
        if (galleryInfoInflight.get(key) === pending)
          galleryInfoInflight.delete(key);
      });
    galleryInfoInflight.set(key, pending);
  }
  return raceAbort(pending, signal);
}

async function hydrateSearchIds(
  ids: number[],
  limit: number,
  opts?: DoujinSearchOptions,
  signal?: AbortSignal
): Promise<DoujinSearchResult[]> {
  const target = Math.max(limit, 1);
  const rawSkip = Math.max(opts?.skip ?? 0, 0);
  const start =
    opts?.wrapSkip && ids.length > 0
      ? ids.length > target
        ? rawSkip % (ids.length - target + 1)
        : 0
      : Math.min(rawSkip, ids.length);
  const scanLimit = Math.min(ids.length - start, target * 4);
  const excludedTypes = new Set(Object.keys(EXCLUDED_GALLERY_TYPES));
  for (const type of opts?.excludeTypes ?? [])
    excludedTypes.add(type.toLowerCase().replace(/[^a-z]/g, ""));
  const out: DoujinSearchResult[] = [];
  let ggPromise: ReturnType<typeof loadGG> | null = null;
  const getGG = () => (ggPromise ??= loadGG());
  for (let index = 0; index < scanLimit && out.length < target;) {
    signal?.throwIfAborted();
    const waveSize = Math.min(
      scanLimit - index,
      Math.min(25, Math.max(4, Math.ceil((target - out.length) * 1.25)))
    );
    const batch = ids.slice(start + index, start + index + waveSize);
    index += waveSize;
    await mapLimit(batch, HITOMI_HYDRATE_CONCURRENCY, async (id) => {
      if (signal?.aborted) return;
      try {
        const info = await loadGalleryInfo(id, signal);
        const type =
          typeof info.type === "string"
            ? info.type.toLowerCase().replace(/[^a-z]/g, "")
            : "";
        if (excludedTypes.has(type)) return;
        const gg = await getGG();
        const files: HitomiFile[] = info.files ?? [];
        const tags: string[] = [];
        const tagNamespaces: (string | undefined)[] = [];
        for (const t of info.tags ?? []) {
          if (tags.length >= 24) break;
          const name = tagValue(t);
          if (!name) continue;
          tags.push(name);
          tagNamespaces.push(tagNamespace(t));
        }
        const parodies = (info.parodys ?? info.parody ?? [])
          .map(tagValue)
          .filter(Boolean)
          .slice(0, 8);
        const groups = (info.groups ?? [])
          .map(tagValue)
          .filter(Boolean)
          .slice(0, 8);
        out.push({
          source: "hitomi",
          galleryId: String(id),
          title: stripTags(info.title ?? "") || `Gallery ${id}`,
          coverUrl: coverUrlFor(gg, files),
          language:
            typeof info.language === "string" && info.language
              ? info.language
              : undefined,
          tags,
          ...(tagNamespaces.some((ns) => ns !== undefined)
            ? { tagNamespaces }
            : {}),
          artists: (info.artists ?? [])
            .map(tagValue)
            .filter(Boolean)
            .slice(0, 8),
          ...(parodies.length ? { parodies } : {}),
          ...(groups.length ? { groups } : {}),
          pageCount: files.length || undefined,
          url: galleryUrlFor(info, String(id)),
          uploadedAt: toIsoDate(info.date),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        /* Preserve partial results when an individual metadata lookup fails. */
      }
    });
  }
  const byId = new Map(out.map((result) => [result.galleryId, result]));
  return ids
    .slice(start, start + scanLimit)
    .map((id) => byId.get(String(id)))
    .filter((result): result is DoujinSearchResult => !!result)
    .slice(0, target);
}

export const hitomiProvider: DoujinProvider = {
  id: "hitomi",
  name: "Hitomi.la",
  color: "#ff5722",
  meta: {
    sorts: [
      "default",
      "popular",
      "popular-today",
      "popular-week",
      "popular-year",
      "date-published",
      "random",
    ],
    paging: "offset",
  },

  async search(
    query: string,
    limit = 24,
    sort?: DoujinSort,
    opts?: DoujinSearchOptions
  ): Promise<DoujinSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    // A bare gallery id / URL resolves to that single gallery.
    const directId = galleryIdFromInput(q);
    if (directId) {
      const g = await this.getGallery(directId);
      return [
        {
          source: "hitomi",
          galleryId: g.galleryId,
          title: g.title,
          coverUrl: g.coverUrl,
          language: g.language,
          tags: g.tags,
          ...(g.tagNamespaces?.some((ns) => ns !== undefined)
            ? { tagNamespaces: g.tagNamespaces }
            : {}),
          artists: g.artists,
          ...(g.parodies?.length ? { parodies: g.parodies } : {}),
          ...(g.groups?.length ? { groups: g.groups } : {}),
          pageCount: g.pageCount,
          url: g.url,
          uploadedAt: g.uploadedAt,
        },
      ];
    }

    const version = await getGalleriesIndexVersion();
    let ids = await searchGalleryIds(
      q,
      version,
      sort,
      opts?.strictExclusions,
      opts?.language
    );
    if (opts?.excludeIds?.size)
      ids = ids.filter((id) => !opts.excludeIds!.has(id));
    if (!ids.length) return [];

    return hydrateSearchIds(ids, limit, opts);
  },

  async searchPage(
    query: string,
    offset: number,
    limit: number,
    sort?: DoujinSort,
    opts?: { exactTotal?: boolean; signal?: AbortSignal }
  ) {
    if (galleryIdFromInput(query)) {
      const items = await this.search(query, 1, sort);
      return { items: offset ? [] : items, total: items.length };
    }
    const ids = await pagedSearchIds(query, sort, opts?.signal);
    const items = await hydrateSearchIds(
      ids.slice(offset, offset + limit),
      limit,
      undefined,
      opts?.signal
    );
    if (offset < ids.length && !items.length)
      throw new Error("Could not load this Hitomi results page. Please retry.");
    return { items, total: ids.length };
  },

  async filterRecommendations(
    items: DoujinSearchResult[]
  ): Promise<DoujinSearchResult[]> {
    if (!getDownloaderSettings().hitomiBannedTags.length) return items;
    const version = await getGalleriesIndexVersion();
    const banned = await bannedIdSet("", version, true);
    return items.filter((item) => !banned?.has(Number(item.galleryId)));
  },

  resolveTagInfo(
    name: string
  ): Promise<{ name: string; ns: string; count: number } | null> {
    return resolveHitomiTagInfo(name);
  },

  /**
   * Tag/artist autocomplete, mirroring the live site's search dropdown. Backed
   * by `tagindex.hitomi.la`, which returns [name, count, namespace] triples for
   * a character-prefix query. If the seed contains a colon (e.g. "artist:charu"),
   * the part before it scopes the lookup to that namespace; otherwise 'global'.
   */
  async suggest(
    query: string,
    limit = 10,
    context?: string,
    signal?: AbortSignal
  ): Promise<DoujinSuggestion[]> {
    const q = normalizeHitomiQuery(query).replace(/^-/, "");
    if (!q) return [];

    let field = "global";
    let term = q;
    if (q.includes(":")) {
      const [ns, ...rest] = q.split(":");
      if (ns) field = ns;
      term = rest.join(":");
    }
    if (/^(?:sort|order)by(?:key|direction)?:/.test(q)) {
      const values = /^(?:sort|order)by:$/.test(`${field}:`)
        ? ["date", "datepublished", "popular", "random"]
        : field.endsWith("bydirection")
          ? ["asc", "desc", "random"]
          : /\b(?:sort|order)by:popular/i.test(context ?? "")
            ? ["today", "week", "month", "year"]
            : ["added", "published"];
      return values.slice(0, limit).map((name) => ({
        source: "hitomi",
        type: field,
        name,
        filter: `${field}:${name}`,
      }));
    }

    const suggestions = await fetchTagSuggestions(field, term, signal);
    const out: DoujinSuggestion[] = [];
    for (const s of suggestions.slice(0, Math.max(limit, 1))) {
      // Filter fragment is `ns:tag_name` with spaces as underscores, which the
      // search() nozomi path understands (e.g. "artist:charu", "language:english").
      const filter = `${s.ns}:${s.name.replace(/\s/g, "_")}`;
      out.push({
        source: "hitomi",
        type: s.ns,
        name: s.name,
        count: s.count,
        filter,
      });
    }
    return out;
  },

  async getGallery(idOrUrl: string): Promise<DoujinGallery> {
    const id = galleryIdFromInput(idOrUrl);
    if (!id)
      throw new Error("Could not parse a Hitomi gallery ID from the input.");

    // The gallery JSON and the gg.js routing table are independent fetches (gg
    // is only consumed after the files list is parsed), so load them in
    // parallel; both must succeed for the gallery to resolve.
    const [info, gg] = await Promise.all([loadGalleryInfo(id), loadGG()]);
    const files: HitomiFile[] = info.files ?? [];
    if (!files.length)
      throw new Error(`Could not find any images for Hitomi gallery ${id}.`);

    // Per-page refs capture just enough (hash + renditions) to rebuild a fresh
    // image URL at download time. The static `pages`/`pageFallbacks` below are
    // built once for compatibility, but the engine re-resolves via
    // `resolvePageUrl` so long downloads survive CDN base-path rotation.
    const refs: HitomiPageRef[] = [];
    for (const f of files) {
      if (!f?.hash) continue;
      const ref: HitomiPageRef = { hash: f.hash };
      if (f.hasavif) {
        ref.ext = "avif";
        if (f.haswebp) ref.fallbackExt = "webp";
      } else if (f.haswebp) {
        ref.ext = "webp";
      } else {
        // Original format — no compressed rendition; keep the original extension.
        ref.origExt = f.name.split(".").pop()?.toLowerCase() ?? "jpg";
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
        pageFallbacks.push(
          ref.fallbackExt && ref.fallbackExt !== ref.ext
            ? imageUrl(gg, ref.hash, ref.fallbackExt)
            : null
        );
      } else {
        // Original format — bare numeric subdomain (no letter prefix).
        pages.push(originalUrl(gg, ref.hash, ref.origExt ?? "jpg"));
        pageFallbacks.push(null);
      }
    }

    const title = stripTags(info.title ?? "") || `Gallery ${id}`;
    const artists = (info.artists ?? []).map(tagValue).filter(Boolean);
    const characters = (info.characters ?? []).map(tagValue).filter(Boolean);
    const groups = (info.groups ?? []).map(tagValue).filter(Boolean);
    const parodies = (info.parodys ?? info.parody ?? [])
      .map(tagValue)
      .filter(Boolean);
    const series = parodies[0] ?? undefined;
    const language =
      typeof info.language === "string" && info.language
        ? info.language
        : undefined;
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
      source: "hitomi",
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
  opts?: { forceGgRefresh?: boolean; preloadedGg?: GG }
): Promise<string | null> {
  if (!ref.fallbackExt || ref.fallbackExt === ref.ext) return null;
  const gg = opts?.preloadedGg ?? (await loadGG(opts?.forceGgRefresh));
  return imageUrl(gg, ref.hash, ref.fallbackExt);
}
