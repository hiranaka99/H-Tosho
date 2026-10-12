import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getDownloaderSettings } from '../services/settings.js';
import { fetchJson, sleep } from '../lib/http.js';
import { extractGalleryId, toIsoDate } from './util.js';
import { nhentaiAutocompleteQuery, nhentaiBannedTerm, nhentaiSearchQuery } from './nhentaiSearch.js';
import { type DoujinGallery, type DoujinProvider, type DoujinSearchResult, type DoujinSort, type DoujinSuggestion } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * nHentai (nhentai.net) provider — uses the official v2 JSON API.
 *
 * Endpoints (see https://nhentai.net/api/v2/docs, spec: /api/v2/openapi.json):
 *   - `GET /api/v2/search?query=<q>&page=<n>`   -> PaginatedResponse<GalleryListItem>
 *   - `GET /api/v2/galleries/{id}`              -> GalleryDetailResponse
 *   - `GET /api/v2/cdn`                         -> { image_servers, thumb_servers }
 *   - `GET /api/v2/tags/ids?ids=<csv>`          -> TagResponse[] (max 100 ids)
 *   - `POST /api/v2/tags/search`                -> TagResponse[] (autocomplete)
 *
 * Auth: the optional API key is sent as `Authorization: Key <key>` (the only
 * documented mechanism — see the openapi.json info description). Search rows
 * carry numeric `tag_ids` only, so they are batch-resolved to named tags via
 * `/api/v2/tags/ids` (cached for the process lifetime) before being mapped.
 *
 * The detail response returns relative media paths (`galleries/<mediaId>/<n>.<ext>`)
 * plus a typed `tags[]` array. Full-resolution images live on the rotating
 * `image_servers` (i1..i4.nhentai.net) and thumbnails on `thumb_servers`. We
 * cache the CDN config briefly and prefix each relative path with the first
 * available server, keeping the remaining image servers (then the thumbnail) as
 * per-page fallbacks.
 *
 * Documented rate limits per IP: search 10/min anonymous / 20/min with key,
 * gallery detail 20/min / 45/min, galleries listing 15/min / 30/min, tag
 * lookups 15/min, tag autocomplete 30/min. Every outbound call is serialized
 * through a shared client-side throttle (per-endpoint-class minimum interval,
 * see `nhentaiRateLimits`) tuned to the key tier, with adaptive slowdown plus
 * bounded retry-with-backoff on 429/5xx.
 */

/**
 * Client-side rate-limit knobs, per endpoint class, kept just under the
 * documented per-IP caps. Exported so tests can tighten them; mutate before
 * exercising the provider in tests to keep them fast. Without an API key the
 * tighter anonymous tier applies (see `anonIntervalMs`); with one, the key tier.
 */
export const nhentaiRateLimits = {
  /**
   * Key-tier minimum interval (ms): /api/v2/search (documented 20/min),
   * gallery detail + CDN config (45/min), /api/v2/tags/ids batch lookups
   * (15/min, public), tag autocomplete (30/min, public).
   */
  intervalMs: {
    search: 3_200,
    gallery: 2_200,
    tags: 4_200,
    suggest: 2_200,
  } as Record<RateClass, number>,
  /**
   * Anonymous-tier minimum interval (ms): search 10/min, gallery detail
   * 20/min. Tags/autocomplete endpoints are public (no key tiers), so the
   * key-tier intervals already satisfy them.
   */
  anonIntervalMs: {
    search: 6_200,
    gallery: 3_100,
    tags: 0,
    suggest: 0,
  } as Record<RateClass, number>,
  /** Base delay for the first 429/5xx retry; doubles per attempt. */
  backoffBaseMs: 800,
  /** Max retries per request on 429/5xx before surfacing the failure. */
  maxRetries: 3,
};

type RateClass = 'search' | 'gallery' | 'tags' | 'suggest';

// Shared throttle state: one serialization queue across every call the
// provider makes, so a burst of watched-search/recommendation lookups cannot
// fire concurrently and trip an IP ban.
let throttleTail: Promise<void> = Promise.resolve();
let lastAnyAt = 0;
const lastByClass = new Map<RateClass, number>();
let throttleMultiplier = 1;
let last429At = 0;
/** After this long without a 429, the adaptive slowdown decays back to 1x. */
const THROTTLE_DECAY_MS = 5 * 60_000;
const THROTTLE_MULTIPLIER_MAX = 6;
/** Minimum gap between any two requests, regardless of endpoint class. */
const MIN_ANY_GAP_MS = 250;

async function acquireSlot(cls: RateClass): Promise<void> {
  const run = throttleTail.then(async () => {
    if (throttleMultiplier > 1 && Date.now() - last429At > THROTTLE_DECAY_MS) {
      throttleMultiplier = 1;
    }
    const now = Date.now();
    const intervalMs = getApiKey()
      ? nhentaiRateLimits.intervalMs[cls]
      : Math.max(nhentaiRateLimits.intervalMs[cls], nhentaiRateLimits.anonIntervalMs[cls]);
    const waitMs = Math.max(
      lastAnyAt + MIN_ANY_GAP_MS - now,
      (lastByClass.get(cls) ?? 0) + intervalMs * throttleMultiplier - now,
    );
    if (waitMs > 0) await sleep(waitMs);
    const at = Date.now();
    lastAnyAt = at;
    lastByClass.set(cls, at);
  });
  throttleTail = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

/**
 * fetchJson with the shared throttle applied plus bounded 429/5xx retry with
 * exponential backoff. Each 429 raises the adaptive multiplier (slowing every
 * subsequent call) so a sustained throttle backs off rather than hammering.
 * Non-2xx responses are returned as-is (raw mode) for callers to interpret.
 */
async function throttledFetchJson<T>(
  cls: RateClass,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ status: number; data: T | null }> {
  for (let attempt = 0; ; attempt++) {
    await acquireSlot(cls);
    const res = await fetchJson<T>(url, init, timeoutMs, { raw: true });
    if ((res.status !== 429 && res.status < 500) || attempt >= nhentaiRateLimits.maxRetries) {
      return { status: res.status, data: (res.data ?? null) as T | null };
    }
    if (res.status === 429) {
      last429At = Date.now();
      throttleMultiplier = Math.min(throttleMultiplier * 1.5, THROTTLE_MULTIPLIER_MAX);
    }
    await sleep(nhentaiRateLimits.backoffBaseMs * 2 ** attempt);
  }
}

const BASE = 'https://nhentai.net';
// nHentai asks clients to send a descriptive User-Agent ("AppName/version") so
// they can identify the traffic and reach out if needed — this also lowers the
// chance of being throttled.
const UA = 'H-Tosho/1.0 (doujin downloader; https://github.com/hiranaka99/H-Tosho)';
/** Accepts `/g/<id>/`, bare ids, or the legacy `/gallery/<id>` form. */
const GALLERY_URL_RE = /\/(?:g|gallery)\/(\d+)/;

/**
 * Resolve the optional nhentai.net API key (for higher rate limits) at request
 * time. The value configured in Settings wins; the NHENTAI_API_KEY env var is
 * used as a fallback so deployments can keep working without UI changes.
 */
function getApiKey(): string {
  try {
    const fromSettings = getDownloaderSettings().nhentaiApiKey?.trim();
    if (fromSettings) return fromSettings;
  } catch {
    // DB not ready yet — fall through to the env var.
  }
  return process.env.NHENTAI_API_KEY?.trim() || '';
}

/**
 * Build the nHentai query fragment that excludes every configured banned tag.
 * Returns a space-separated list of `-"<tag>"` terms (empty when nothing is set).
 *
 * nHentai's search grammar negates a term with a leading `-`. Quoting the name
 * makes multi-word tags (e.g. "big breasts") match as a single tag rather than
 * excluding anything containing either word. A direct gallery-ID lookup is an
 * explicit request, so banned tags only affect keyword/tag searches.
 */
function buildBannedExclusions(): string {
  let tags: unknown;
  try {
    tags = getDownloaderSettings().nhentaiBannedTags;
  } catch {
    return '';
  }
  if (!Array.isArray(tags)) return '';
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of tags) {
    const exclusion = nhentaiBannedTerm(String(raw ?? ''));
    if (!exclusion) continue;
    const key = exclusion.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(exclusion);
  }
  return parts.join(' ');
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${BASE}/`,
  };
  const key = getApiKey();
  if (key) h.Authorization = `Key ${key}`;
  return h;
}

/** curl header args, mirroring headers() for the subprocess path. */
function curlAuthArgs(): string[] {
  const key = getApiKey();
  return key ? ['-H', `Authorization: Key ${key}`] : [];
}

// ---- CDN config cache -------------------------------------------------------

interface CdnConfig {
  imageServers: string[];
  thumbServers: string[];
}

let cdnCache: CdnConfig | null = null;
let cdnCacheAt = 0;
let cdnLoading: Promise<CdnConfig> | null = null;
const CDN_TTL_MS = 10 * 60_000;

async function getCdn(forceRefresh = false): Promise<CdnConfig> {
  if (!forceRefresh && cdnCache && Date.now() - cdnCacheAt < CDN_TTL_MS) return cdnCache;
  if (cdnLoading) return cdnLoading;
  cdnLoading = fetchCdn();
  try { return await cdnLoading; }
  finally { cdnLoading = null; }
}

async function fetchCdn(): Promise<CdnConfig> {
  const res = await throttledFetchJson<{ image_servers: string[]; thumb_servers: string[] }>(
    'gallery',
    `${BASE}/api/v2/cdn`,
    { headers: headers() },
  );
  if (res.status !== 200 || !res.data?.image_servers?.length) {
    throw new Error('nHentai CDN config fetch failed');
  }
  cdnCache = { imageServers: res.data.image_servers, thumbServers: res.data.thumb_servers };
  cdnCacheAt = Date.now();
  return cdnCache;
}

function joinServer(server: string | undefined, relPath: string): string {
  if (!server) return relPath.startsWith('http') ? relPath : '';
  const base = server.replace(/\/$/, '');
  return `${base}/${relPath.replace(/^\/+/, '')}`;
}

/**
 * A search row enriched with the pre-hydration metadata recommendations and
 * watched searches filter on. `DoujinSearchResult` only declares the common
 * subset; the extra fields ride along on the returned objects.
 */
interface NhentaiSearchRow extends DoujinSearchResult {
  series?: string;
  parodies?: string[];
  groups?: string[];
  characters?: string[];
  tagNamespaces?: (string | undefined)[];
}

// ---- search-row tag resolution ----------------------------------------------

/**
 * Search rows carry numeric `tag_ids` only. Resolve them to named tags via
 * `/api/v2/tags/ids` (max 100 ids per request, documented 15/min). The taxonomy
 * is stable, so results are cached for the process lifetime — repeated searches
 * and recommendation bursts mostly hit the cache instead of the API.
 */
const tagCache = new Map<number, ApiTag>();
const TAG_CACHE_MAX = 100_000;

async function resolveTags(ids: number[]): Promise<Map<number, ApiTag>> {
  const out = new Map<number, ApiTag>();
  const missing: number[] = [];
  const queued = new Set<number>();
  for (const id of ids) {
    const cached = tagCache.get(id);
    if (cached) {
      out.set(id, cached);
    } else if (!queued.has(id)) {
      missing.push(id);
      queued.add(id);
    }
  }
  const CHUNK = 100;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const res = await throttledFetchJson<ApiTag[]>(
      'tags',
      `${BASE}/api/v2/tags/ids?ids=${chunk.join(',')}`,
      { headers: headers() },
    );
    if (res.status !== 200 || !Array.isArray(res.data)) continue;
    for (const t of res.data) {
      if (typeof t?.id !== 'number' || !t.name) continue;
      if (tagCache.size >= TAG_CACHE_MAX) tagCache.clear();
      tagCache.set(t.id, t);
      out.set(t.id, t);
    }
  }
  return out;
}

// ---- tag taxonomy -----------------------------------------------------------

interface SplitTags {
  tags: string[];
  /** Parallel to `tags`: each tag's own search namespace (its nHentai type). */
  tagNamespaces: (string | undefined)[];
  artists: string[];
  characters: string[];
  /** Parody/series values (nHentai models a series as a `parody` tag). */
  parodies: string[];
  groups: string[];
  langTags: string[];
}

/** Split a typed nHentai `tags[]` array into the per-category lists we expose. */
function splitTags(apiTags: ApiTag[]): SplitTags {
  const out: SplitTags = {
    tags: [],
    tagNamespaces: [],
    artists: [],
    characters: [],
    parodies: [],
    groups: [],
    langTags: [],
  };
  for (const t of apiTags) {
    if (!t?.name) continue;
    const category = mapTagType(t.type);
    // Cap the flat tag list (the ComicInfo Tags field stays bounded); category
    // lists stay uncapped — they are naturally small.
    if (out.tags.length < 40) {
      out.tags.push(t.name);
      out.tagNamespaces.push(category);
    }
    if (category === 'artist') out.artists.push(t.name);
    else if (category === 'character') out.characters.push(t.name);
    else if (category === 'language') out.langTags.push(t.name);
    else if (category === 'group') out.groups.push(t.name);
    else if (category === 'parody' || category === 'series') out.parodies.push(t.name);
  }
  return out;
}

// ---- tag taxonomy (type mapping) --------------------------------------------

/** Map an nHentai v2 tag `type` onto our normalized tag category. */
function mapTagType(type: string): string {
  const t = (type || '').trim().toLowerCase();
  if (!t) return 'other';
  if (t === 'artist' || t === 'artists') return 'artist';
  if (t === 'character') return 'character';
  if (t === 'parody') return 'parody';
  if (t === 'group') return 'group';
  if (t === 'language') return 'language';
  if (t === 'series') return 'series';
  if (t === 'category') return 'category';
  return t;
}

const KNOWN_LANGUAGES = [
  'english', 'japanese', 'chinese', 'korean', 'spanish', 'german', 'french',
  'italian', 'russian', 'polish', 'portuguese', 'dutch', 'turkish', 'vietnamese',
];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Pick a human language name from the gallery's typed tags. */
function detectLanguage(langTags: string[], title: string): string | undefined {
  for (const t of langTags) {
    const lower = t.toLowerCase();
    if (KNOWN_LANGUAGES.includes(lower)) return capitalize(lower);
  }
  // Fall back to a loose scan of the title.
  for (const lang of KNOWN_LANGUAGES) {
    if (title.toLowerCase().includes(lang)) return capitalize(lang);
  }
  return undefined;
}

/**
 * nhentai.net sits behind Cloudflare, which challenges Node's built-in fetch()
 * on POST endpoints ("Just a moment…" 403) but lets `curl` through. Run curl
 * directly to fetch tag autocomplete; returns a parsed tag array or null.
 */
async function fetchTagsViaCurl(body: string): Promise<ApiTag[] | null> {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  for (let attempt = 0; attempt < 2; attempt++) {
    // The server counts subprocess requests the same as in-process ones, so
    // the curl path goes through the shared throttle too.
    await acquireSlot('suggest');
    try {
      const { stdout } = await execFileAsync(
        bin,
        [
          '-s', '-X', 'POST', `${BASE}/api/v2/tags/search`,
          '-H', `User-Agent: ${UA}`,
          '-H', 'Content-Type: application/json',
          '-H', 'Accept: application/json',
          ...curlAuthArgs(),
          '--data', body,
        ],
        { timeout: 8_000 },
      );
      const parsed: unknown = JSON.parse(stdout);
      if (Array.isArray(parsed)) return parsed as ApiTag[];
    } catch {
      // curl missing / non-zero exit / non-JSON (Cloudflare challenge) -> retry.
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return null;
}

/**
 * Direct in-process POST to /api/v2/tags/search (Cloudflare usually waves
 * authenticated requests through). Returns the parsed tag array, or null when
 * the endpoint is unreachable/challenged — callers fall back to curl.
 */
async function postTagSearch(body: string): Promise<ApiTag[] | null> {
  const res = await throttledFetchJson<ApiTag[]>(
    'suggest',
    `${BASE}/api/v2/tags/search`,
    {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body,
    },
  );
  return res.status === 200 && Array.isArray(res.data) ? res.data : null;
}

// ---- API shapes -------------------------------------------------------------

interface ApiGalleryListItem {
  id: number;
  media_id?: string | number;
  english_title?: string | null;
  japanese_title?: string | null;
  thumbnail?: string | null;
  num_pages?: number;
  tag_ids?: number[];
}

interface ApiSearchResponse {
  result: ApiGalleryListItem[];
  /** Total number of pages for this query (1-based). */
  num_pages?: number;
  /** Fixed page size as served by the API (25 live-observed; the search endpoint has no `limit` parameter). */
  per_page?: number;
  /** Total matching galleries. */
  total?: number;
}

interface ApiTag {
  id?: number;
  type: string;
  name: string;
  slug?: string;
  url?: string;
  count?: number;
}

interface ApiPage {
  number: number;
  path: string;
  thumbnail?: string;
}

interface ApiGalleryDetail {
  id: number;
  media_id?: string | number;
  title?: { english?: string | null; japanese?: string | null; pretty?: string | null };
  cover?: { path?: string } | string | null;
  thumbnail?: { path?: string } | string | null;
  scanlator?: string | null;
  num_pages?: number;
  tags?: ApiTag[];
  pages?: ApiPage[];
  /** Upload date as unix seconds. */
  upload_date?: number;
}

const SEARCH_PAGE_SIZE = 25;

function directGalleryId(query: string): string | null {
  const q = query.trim();
  const bare = /^#?\s*(\d+)$/.exec(q);
  if (bare) return bare[1];
  return /^(?:https?:\/\/(?:www\.)?nhentai\.net)?\/(?:g|gallery)\/(\d+)\/?(?:[?#].*)?$/i.exec(q)?.[1] ?? null;
}

async function fetchSearchPage(query: string, page: number, sort?: DoujinSort): Promise<ApiSearchResponse> {
  const params = new URLSearchParams({ query, page: String(page) });
  if (sort && ['popular', 'popular-week', 'popular-today', 'popular-month'].includes(sort)) params.set('sort', sort);
  const res = await throttledFetchJson<ApiSearchResponse>('search', `${BASE}/api/v2/search?${params}`, { headers: headers() });
  if (res.status === 429) throw new Error('nHentai is rate-limiting this search. Set a valid nHentai API key in Settings to raise the limit, then try again.');
  if (res.status !== 200 || !Array.isArray(res.data?.result) || !Number.isSafeInteger(res.data.num_pages) || res.data.num_pages! < 0) {
    throw new Error(`nHentai search failed (HTTP ${res.status})`);
  }
  return res.data;
}

async function mapSearchRows(items: ApiGalleryListItem[]): Promise<NhentaiSearchRow[]> {
  if (!items.length) return [];
  const tagIds = items.flatMap(item => Array.isArray(item?.tag_ids) ? item.tag_ids : []);
  const [cdn, tagsById] = await Promise.all([getCdn(), resolveTags(tagIds)]);
  return items.filter(item => item && typeof item.id === 'number').map(item => {
    const id = String(item.id);
    const title = item.english_title || item.japanese_title || `Gallery ${id}`;
    const resolved = (item.tag_ids ?? []).map(id => tagsById.get(id)).filter((tag): tag is ApiTag => !!tag);
    const split = splitTags(resolved);
    return {
      source: 'nhentai', galleryId: id, title,
      coverUrl: item.thumbnail ? joinServer(cdn.thumbServers[0], item.thumbnail) : undefined,
      tags: split.tags, tagNamespaces: split.tagNamespaces, artists: split.artists,
      series: split.parodies[0], parodies: split.parodies, groups: split.groups,
      characters: split.characters, language: detectLanguage(split.langTags, title),
      pageCount: item.num_pages ?? undefined, url: `${BASE}/g/${id}/`,
    };
  });
}

export const nhentaiProvider: DoujinProvider = {
  id: 'nhentai',
  name: 'nHentai',
  color: '#e91e63',

  async search(query: string, limit = 24, sort?: DoujinSort): Promise<DoujinSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    // A bare gallery id / URL should resolve to that single gallery. The full
    // DoujinGallery doubles as a search row (it extends DoujinSearchResult).
    const id = directGalleryId(q);
    if (id) return [await this.getGallery(id)];

    // Append configured banned-tag exclusions so galleries carrying any of them
    // never show up in keyword/tag searches. (A bare gallery-ID lookup above is
    // an explicit request and intentionally skips this filter.)
    const searchQuery = nhentaiSearchQuery(q, buildBannedExclusions());
    const want = Math.max(limit, 1);
    // The API serves a fixed page size (`per_page`, 25 live-observed; there is
    // no `limit` parameter) and paginates via `page`. Walk the pages until
    // we've collected `want` results or run out of pages. A hard cap keeps
    // open-ended queries (e.g. a single common tag) from issuing dozens of
    // sequential page requests — which is slow and easily trips nHentai's rate
    // limits, especially without a valid API key.
    const MAX_RESULTS = 250;
    const target = Math.min(want, MAX_RESULTS);
    const out: NhentaiSearchRow[] = [];
    const seen = new Set<string>();

    let page = 1;
    do {
      // throttledFetchJson spaces pages through the shared throttle and retries
      // transient 429/5xx with capped exponential backoff, so a multi-page
      // search doesn't fail on a single throttled request.
      const res = await fetchSearchPage(searchQuery, page, sort);
      const items = res.result;
      if (!items.length) break;

      for (const item of await mapSearchRows(items)) {
        if (seen.has(item.galleryId)) continue;
        seen.add(item.galleryId);
        out.push(item);
        if (out.length >= target) return out;
      }

      const totalPages = res.num_pages ?? 0;
      page++;
      if (page > totalPages || page > Math.ceil(MAX_RESULTS / SEARCH_PAGE_SIZE)) break;
      // Page spacing is enforced by the shared throttle — no extra pause needed.
    } while (true);

    return out.slice(0, want);
  },

  async searchPage(query: string, offset: number, limit: number, sort?: DoujinSort) {
    const q = query.trim();
    if (!q) return { items: [], total: 0 };
    const id = directGalleryId(q);
    if (id) {
      const gallery = await this.getGallery(id);
      return { items: offset ? [] : [gallery], total: 1 };
    }
    const searchQuery = nhentaiSearchQuery(q, buildBannedExclusions());
    const fetched = new Map<number, ApiSearchResponse>();
    const getPage = async (page: number) => {
      if (!fetched.has(page)) fetched.set(page, await fetchSearchPage(searchQuery, page, sort));
      return fetched.get(page)!;
    };
    let page = Math.floor(offset / SEARCH_PAGE_SIZE) + 1;
    let response = await getPage(page);
    const perPage = Number.isSafeInteger(response.per_page) && response.per_page! > 0 ? response.per_page! : SEARCH_PAGE_SIZE;
    const correctPage = Math.floor(offset / perPage) + 1;
    if (correctPage !== page) { page = correctPage; response = await getPage(page); }
    const numPages = response.num_pages ?? 0;
    let total = response.total;
    // The public schema permits a null total; the last page gives an exact count.
    if (!Number.isSafeInteger(total) || total! < 0) {
      total = numPages ? (numPages - 1) * perPage + (await getPage(numPages)).result.length : 0;
    }
    const rows = response.result.slice(offset % perPage, offset % perPage + limit);
    if (offset < total! && !rows.length) throw new Error('Could not load this nHentai results page. Please retry.');
    while (rows.length < limit && page < numPages && offset + rows.length < total!) {
      page++;
      const next = (await getPage(page)).result;
      if (!next.length) break;
      rows.push(...next.slice(0, limit - rows.length));
    }
    return { items: await mapSearchRows(rows), total: total! };
  },

  /**
   * Tag/artist autocomplete, mirroring the live site's search dropdown.
   * Backed by `POST /api/v2/tags/search` (name-prefix search across all tag
   * types). Results are returned most-popular-first with their gallery count.
   */
  async suggest(query: string, limit = 10): Promise<DoujinSuggestion[]> {
    const lookup = nhentaiAutocompleteQuery(query);
    if (!lookup) return [];
    const body = JSON.stringify({ ...lookup, limit: Math.min(Math.max(limit, 1), 50) });
    // With an API key, go straight through the official POST endpoint
    // (authenticated requests are usually waved through Cloudflare); without
    // one, Node's fetch() on POST endpoints gets challenged, so curl goes
    // first and the in-process POST is only the last resort.
    const data: ApiTag[] | null = getApiKey()
      ? (await postTagSearch(body)) ?? (await fetchTagsViaCurl(body))
      : (await fetchTagsViaCurl(body)) ?? (await postTagSearch(body));
    if (!data) return [];

    const out: DoujinSuggestion[] = [];
    for (const t of data) {
      if (!t?.name) continue;
      // Quote the name in the filter so names with spaces/specials survive.
      const filter = `${mapTagType(t.type)}:"${t.name}"`;
      out.push({
        source: 'nhentai',
        type: mapTagType(t.type),
        name: t.name,
        count: typeof t.count === 'number' ? t.count : undefined,
        filter,
        url: t.url ? `${BASE}${t.url}` : undefined,
      });
    }
    return out;
  },

  async getGallery(idOrUrl: string): Promise<DoujinGallery> {
    const id = extractGalleryId(idOrUrl, GALLERY_URL_RE);
    if (!id) throw new Error('Could not parse an nHentai gallery ID from the input.');

    const res = await throttledFetchJson<ApiGalleryDetail>(
      'gallery',
      `${BASE}/api/v2/galleries/${id}`,
      { headers: headers() },
    );
    if (res.status !== 200 || !res.data) {
      throw new Error(`nHentai gallery fetch failed (HTTP ${res.status})`);
    }
    const g = res.data;

    const title = g.title?.pretty || g.title?.english || g.title?.japanese || `Gallery ${id}`;
    // Original-language (Japanese) title for metadata sync; display title stays
    // in `title`.
    const titleAlt =
      g.title?.japanese ||
      (g.title?.english && g.title.english !== g.title?.pretty ? g.title.english : undefined) ||
      undefined;

    // Pages: prefer the explicit pages[] list, else synthesize from num_pages.
    const cdn = await getCdn();
    const imageServers = cdn.imageServers;
    const thumbServer = cdn.thumbServers[0];
    const mediaId = g.media_id != null ? String(g.media_id) : '';

    const apiPages: ApiPage[] = Array.isArray(g.pages) && g.pages.length ? g.pages : [];
    // Index the page list once: both the URL build below and resolvePageUrl
    // look pages up by number, and a per-page find() is O(n²) across a gallery.
    // First entry wins so duplicate `number` fields keep the old find() match.
    const pageByNumber = new Map<number, ApiPage>();
    for (const ap of apiPages) {
      if (!pageByNumber.has(ap.number)) pageByNumber.set(ap.number, ap);
    }
    const pageCount = apiPages.length || g.num_pages || 0;
    if (!pageCount) throw new Error(`Could not determine the page count for nHentai gallery ${id}.`);

    const pages: string[] = [];
    const pageFallbacks: (string | null)[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const p = pageByNumber.get(n);
      let relPath = '';
      if (p?.path) {
        relPath = p.path;
      } else if (mediaId) {
        // Synthesize the canonical path: galleries/<mediaId>/<n>.<ext>
        const ext = apiPages[0]?.path?.split('.').pop() ?? 'jpg';
        relPath = `galleries/${mediaId}/${n}.${ext}`;
      }
      if (!relPath) throw new Error(`Could not resolve image URLs for nHentai gallery ${id} (page ${n}).`);
      const primary = joinServer(imageServers[0], relPath);
      // The engine keeps a single static fallback per page, so order the
      // alternates same-quality first: the other full-res image servers, then
      // the low-res thumbnail as the last resort. resolvePageUrl below
      // re-resolves against the current CDN config at download time anyway.
      let fallback: string | null = null;
      for (let s = 1; s < imageServers.length; s++) {
        const alt = joinServer(imageServers[s], relPath);
        if (alt && alt !== primary) {
          fallback = alt;
          break;
        }
      }
      if (!fallback) {
        const thumbUrl = p?.thumbnail ? joinServer(thumbServer, p.thumbnail) : null;
        if (thumbUrl && thumbUrl !== primary) fallback = thumbUrl;
      }
      pages.push(primary);
      pageFallbacks.push(fallback);
    }

    // Tags: typed tags[] -> artists, characters, parodies, groups + flat list.
    const split = splitTags(g.tags ?? []);
    const language = detectLanguage(split.langTags, title);

    // Cover: prefer the dedicated cover, else the first thumbnail.
    const coverRel = typeof g.cover === 'string' ? g.cover : g.cover?.path;
    const coverUrl = coverRel ? joinServer(thumbServer, coverRel) : pageFallbacks[0] ?? undefined;

    return {
      source: 'nhentai',
      galleryId: id,
      title,
      titleAlt,
      coverUrl,
      language,
      series: split.parodies[0],
      artists: split.artists,
      tags: split.tags,
      tagNamespaces: split.tagNamespaces,
      groups: split.groups,
      characters: split.characters,
      parodies: split.parodies,
      scanlator: g.scanlator?.trim() || undefined,
      pageCount,
      pages,
      pageFallbacks,
      uploadedAt: toIsoDate(g.upload_date),
      url: `${BASE}/g/${id}/`,
      // Rebuild a page's URLs against the *current* CDN config right before
      // fetching (and after a failure with forceRefresh), so long downloads
      // survive image-server rotation that would 404 stale pre-built URLs.
      resolvePageUrl: async (index, opts) => {
        if (index < 0 || index >= pageCount) return null;
        const cdnNow = await getCdn(opts?.forceRefresh === true);
        const p = pageByNumber.get(index + 1);
        let relPath = p?.path ?? '';
        if (!relPath && mediaId) {
          const ext = apiPages[0]?.path?.split('.').pop() ?? 'jpg';
          relPath = `galleries/${mediaId}/${index + 1}.${ext}`;
        }
        if (!relPath) return null;
        const url2 = joinServer(cdnNow.imageServers[0], relPath);
        if (!url2) return null;
        let fallback2: string | null = null;
        for (let s = 1; s < cdnNow.imageServers.length; s++) {
          const alt = joinServer(cdnNow.imageServers[s], relPath);
          if (alt && alt !== url2) {
            fallback2 = alt;
            break;
          }
        }
        if (!fallback2) {
          const thumbUrl = p?.thumbnail ? joinServer(cdnNow.thumbServers[0], p.thumbnail) : null;
          if (thumbUrl && thumbUrl !== url2) fallback2 = thumbUrl;
        }
        return { url: url2, fallback: fallback2 };
      },
    };
  },
};
