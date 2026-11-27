import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getDownloaderSettings } from "../services/settings.js";
import { fetchJson, sleep } from "../lib/http.js";
import { extractGalleryId, toIsoDate } from "./util.js";
import {
  nhentaiArtistSearch,
  nhentaiAutocompleteQuery,
  nhentaiBannedTerm,
  nhentaiSearchQuery,
} from "./nhentaiSearch.js";
import {
  type DoujinGallery,
  type DoujinProvider,
  type DoujinSearchResult,
  type DoujinSort,
  type DoujinSuggestion,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * nHentai (nhentai.net) provider — uses the official v2 JSON API.
 *
 * Endpoints (see https://nhentai.net/api/v2/docs, spec: /api/v2/openapi.json):
 *   - `GET /api/v2/search?query=<q>&page=<n>`   -> PaginatedResponse<GalleryListItem>
 *   - `GET /api/v2/tags/artist/{slug}`          -> exact artist tag
 *   - `GET /api/v2/galleries/tagged?tag_id=...` -> exact artist's galleries
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
   * artist listings (30/min), gallery detail + CDN config (45/min), /api/v2/tags/ids batch lookups
   * (15/min, public), tag autocomplete (30/min, public).
   */
  intervalMs: {
    search: 3_200,
    listing: 2_200,
    gallery: 2_200,
    tags: 4_200,
    suggest: 2_200,
  } as Record<RateClass, number>,
  /**
   * Anonymous-tier minimum interval (ms): search 10/min, gallery detail
   * 20/min, artist listings 15/min. Tags/autocomplete endpoints are public (no key tiers), so the
   * key-tier intervals already satisfy them.
   */
  anonIntervalMs: {
    search: 6_200,
    listing: 4_200,
    gallery: 3_100,
    tags: 0,
    suggest: 0,
  } as Record<RateClass, number>,
  /** Base delay for the first 429/5xx retry; doubles per attempt. */
  backoffBaseMs: 800,
  /** Max retries per request on 429/5xx before surfacing the failure. */
  maxRetries: 3,
};

type RateClass = "search" | "listing" | "gallery" | "tags" | "suggest";

// Shared throttle state. Calls are serialized per RateClass so a long
// search/listing backoff never blocks gallery/tags/suggest lookups; the global
// minimum gap and the adaptive multiplier still apply across every class.
const throttleTails = new Map<RateClass, Promise<void>>();
let lastAnyAt = 0;
const lastByClass = new Map<RateClass, number>();
let throttleMultiplier = 1;
let last429At = 0;
/** After this long without a 429, the adaptive slowdown decays back to 1x. */
const THROTTLE_DECAY_MS = 5 * 60_000;
const THROTTLE_MULTIPLIER_MAX = 6;
/** Minimum gap between any two requests, regardless of endpoint class. */
const MIN_ANY_GAP_MS = 250;

async function acquireSlot(
  cls: RateClass,
  signal?: AbortSignal
): Promise<void> {
  const run = (throttleTails.get(cls) ?? Promise.resolve()).then(async () => {
    // A caller that gave up while queued must not consume a slot.
    signal?.throwIfAborted();
    // Re-check after every sleep: another RateClass may have fired meanwhile,
    // and the global gap must hold across classes. The final check and the
    // timestamp update run synchronously, so lanes cannot violate MIN_ANY_GAP_MS.
    for (;;) {
      if (
        throttleMultiplier > 1 &&
        Date.now() - last429At > THROTTLE_DECAY_MS
      ) {
        throttleMultiplier = 1;
      }
      const now = Date.now();
      const intervalMs = getApiKey()
        ? nhentaiRateLimits.intervalMs[cls]
        : Math.max(
            nhentaiRateLimits.intervalMs[cls],
            nhentaiRateLimits.anonIntervalMs[cls]
          );
      const waitMs = Math.max(
        lastAnyAt + MIN_ANY_GAP_MS - now,
        (lastByClass.get(cls) ?? 0) + intervalMs * throttleMultiplier - now
      );
      if (waitMs <= 0) break;
      await sleep(waitMs, signal);
    }
    const at = Date.now();
    lastAnyAt = at;
    lastByClass.set(cls, at);
  });
  throttleTails.set(
    cls,
    run.then(
      () => undefined,
      () => undefined
    )
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
  timeoutMs = 15_000
): Promise<{ status: number; data: T | null }> {
  const signal = init.signal ?? undefined;
  for (let attempt = 0; ; attempt++) {
    await acquireSlot(cls, signal);
    const res = await fetchJson<T>(url, init, timeoutMs, { raw: true });
    if (
      (res.status !== 429 && res.status < 500) ||
      attempt >= nhentaiRateLimits.maxRetries
    ) {
      return { status: res.status, data: (res.data ?? null) as T | null };
    }
    if (res.status === 429) {
      last429At = Date.now();
      throttleMultiplier = Math.min(
        throttleMultiplier * 1.5,
        THROTTLE_MULTIPLIER_MAX
      );
    }
    await sleep(nhentaiRateLimits.backoffBaseMs * 2 ** attempt, signal);
  }
}

const BASE = "https://nhentai.net";
// nHentai asks clients to send a descriptive User-Agent ("AppName/version") so
// they can identify the traffic and reach out if needed — this also lowers the
// chance of being throttled.
const UA =
  "H-Tosho/1.0 (doujin downloader; https://github.com/hiranaka99/H-Tosho)";
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
  return process.env.NHENTAI_API_KEY?.trim() || "";
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
    return "";
  }
  if (!Array.isArray(tags)) return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of tags) {
    const exclusion = nhentaiBannedTerm(String(raw ?? ""));
    if (!exclusion) continue;
    const key = exclusion.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(exclusion);
  }
  return parts.join(" ");
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE}/`,
  };
  const key = getApiKey();
  if (key) h.Authorization = `Key ${key}`;
  return h;
}

/** curl header args, mirroring headers() for the subprocess path. */
function curlAuthArgs(): string[] {
  const key = getApiKey();
  return key ? ["-H", `Authorization: Key ${key}`] : [];
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
  if (!forceRefresh && cdnCache && Date.now() - cdnCacheAt < CDN_TTL_MS)
    return cdnCache;
  if (cdnLoading) return cdnLoading;
  cdnLoading = fetchCdn();
  try {
    return await cdnLoading;
  } finally {
    cdnLoading = null;
  }
}

async function fetchCdn(): Promise<CdnConfig> {
  const res = await throttledFetchJson<{
    image_servers: string[];
    thumb_servers: string[];
  }>("gallery", `${BASE}/api/v2/cdn`, { headers: headers() });
  if (res.status !== 200 || !res.data?.image_servers?.length) {
    throw new Error("nHentai CDN config fetch failed");
  }
  cdnCache = {
    imageServers: res.data.image_servers,
    thumbServers: res.data.thumb_servers,
  };
  cdnCacheAt = Date.now();
  return cdnCache;
}

function joinServer(server: string | undefined, relPath: string): string {
  if (!server) return relPath.startsWith("http") ? relPath : "";
  const base = server.replace(/\/$/, "");
  return `${base}/${relPath.replace(/^\/+/, "")}`;
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

/** Insert into a bounded cache, evicting only the oldest entry when full
 *  (never the whole cache, which would stampede the tag endpoints). */
function boundedSet<K, V>(
  cache: Map<K, V>,
  max: number,
  key: K,
  value: V
): void {
  cache.delete(key);
  while (cache.size >= max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, value);
}

function rememberTag(id: number, tag: ApiTag): void {
  boundedSet(tagCache, TAG_CACHE_MAX, id, tag);
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

async function resolveTags(
  ids: number[],
  signal?: AbortSignal
): Promise<Map<number, ApiTag>> {
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
      "tags",
      `${BASE}/api/v2/tags/ids?ids=${chunk.join(",")}`,
      { headers: headers(), ...(signal ? { signal } : {}) }
    );
    if (res.status !== 200 || !Array.isArray(res.data)) continue;
    for (const t of res.data) {
      if (typeof t?.id !== "number" || !t.name) continue;
      rememberTag(t.id, t);
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
    if (category === "artist") out.artists.push(t.name);
    else if (category === "character") out.characters.push(t.name);
    else if (category === "language") out.langTags.push(t.name);
    else if (category === "group") out.groups.push(t.name);
    else if (category === "parody" || category === "series")
      out.parodies.push(t.name);
  }
  return out;
}

// ---- tag taxonomy (type mapping) --------------------------------------------

/** Map an nHentai v2 tag `type` onto our normalized tag category. */
function mapTagType(type: string): string {
  const t = (type || "").trim().toLowerCase();
  if (!t) return "other";
  if (t === "artist" || t === "artists") return "artist";
  if (t === "character") return "character";
  if (t === "parody") return "parody";
  if (t === "group") return "group";
  if (t === "language") return "language";
  if (t === "series") return "series";
  if (t === "category") return "category";
  return t;
}

const KNOWN_LANGUAGES = [
  "english",
  "japanese",
  "chinese",
  "korean",
  "spanish",
  "german",
  "french",
  "italian",
  "russian",
  "polish",
  "portuguese",
  "dutch",
  "turkish",
  "vietnamese",
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
async function fetchTagsViaCurl(
  body: string,
  signal?: AbortSignal
): Promise<ApiTag[] | null> {
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  for (let attempt = 0; attempt < 2; attempt++) {
    // The server counts subprocess requests the same as in-process ones, so
    // the curl path goes through the shared throttle too.
    await acquireSlot("suggest", signal);
    try {
      const { stdout } = await execFileAsync(
        bin,
        [
          "-s",
          "-X",
          "POST",
          `${BASE}/api/v2/tags/search`,
          "-H",
          `User-Agent: ${UA}`,
          "-H",
          "Content-Type: application/json",
          "-H",
          "Accept: application/json",
          ...curlAuthArgs(),
          "--data",
          body,
        ],
        // `signal` kills the subprocess when the caller (a superseded
        // keystroke) gives up.
        { timeout: 8_000, signal }
      );
      const parsed: unknown = JSON.parse(stdout);
      if (Array.isArray(parsed)) return parsed as ApiTag[];
    } catch {
      // curl missing / non-zero exit / non-JSON (Cloudflare challenge) -> retry.
      signal?.throwIfAborted();
    }
    await sleep(300 * (attempt + 1), signal);
  }
  return null;
}

/**
 * Direct in-process POST to /api/v2/tags/search (Cloudflare usually waves
 * authenticated requests through). Returns the parsed tag array, or null when
 * the endpoint is unreachable/challenged — callers fall back to curl.
 */
async function postTagSearch(
  body: string,
  signal?: AbortSignal
): Promise<ApiTag[] | null> {
  const res = await throttledFetchJson<ApiTag[]>(
    "suggest",
    `${BASE}/api/v2/tags/search`,
    {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body,
      ...(signal ? { signal } : {}),
    }
  );
  return res.status === 200 && Array.isArray(res.data) ? res.data : null;
}

/**
 * Short-lived autocomplete cache keyed by the exact request body: typing,
 * deleting, and retyping a prefix (or several open tabs) must not each cost a
 * rate-limited request or curl subprocess. Only successful lookups are cached.
 */
const SUGGEST_CACHE_TTL_MS = 5 * 60_000;
const SUGGEST_CACHE_MAX = 256;
const suggestCache = new Map<string, { at: number; tags: ApiTag[] }>();
interface SuggestInflight {
  promise: Promise<ApiTag[] | null>;
  ac: AbortController;
  waiters: number;
}
const suggestInflight = new Map<string, SuggestInflight>();

function awaitInflightSuggest(
  entry: SuggestInflight,
  signal?: AbortSignal
): Promise<ApiTag[] | null> {
  entry.waiters++;
  if (signal?.aborted) {
    if (--entry.waiters === 0) entry.ac.abort();
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Aborted")
    );
  }
  return new Promise<ApiTag[] | null>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (--entry.waiters === 0) entry.ac.abort();
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted")
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        entry.waiters--;
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        entry.waiters--;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function searchTagsCached(
  body: string,
  signal?: AbortSignal
): Promise<ApiTag[] | null> {
  signal?.throwIfAborted();
  const hit = suggestCache.get(body);
  if (hit && Date.now() - hit.at < SUGGEST_CACHE_TTL_MS) {
    suggestCache.delete(body);
    suggestCache.set(body, hit);
    return hit.tags;
  }
  let entry = suggestInflight.get(body);
  if (!entry) {
    const ac = new AbortController();
    const promise = (async () => {
      // With an API key, go straight through the official POST endpoint
      // (authenticated requests are usually waved through Cloudflare); without
      // one, Node's fetch() on POST endpoints gets challenged, so curl goes
      // first and the in-process POST is only the last resort.
      const tags: ApiTag[] | null = getApiKey()
        ? ((await postTagSearch(body, ac.signal)) ??
          (await fetchTagsViaCurl(body, ac.signal)))
        : ((await fetchTagsViaCurl(body, ac.signal)) ??
          (await postTagSearch(body, ac.signal)));
      if (tags)
        boundedSet(suggestCache, SUGGEST_CACHE_MAX, body, {
          at: Date.now(),
          tags,
        });
      else suggestCache.delete(body);
      return tags;
    })().finally(() => {
      if (suggestInflight.get(body) === entry) suggestInflight.delete(body);
    });
    entry = { promise, ac, waiters: 0 };
    suggestInflight.set(body, entry);
  }
  return awaitInflightSuggest(entry, signal);
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
  title?: {
    english?: string | null;
    japanese?: string | null;
    pretty?: string | null;
  };
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
  return (
    /^(?:https?:\/\/(?:www\.)?nhentai\.net)?\/(?:g|gallery)\/(\d+)\/?(?:[?#].*)?$/i.exec(
      q
    )?.[1] ?? null
  );
}

async function fetchSearchPage(
  query: string,
  page: number,
  sort?: DoujinSort,
  signal?: AbortSignal
): Promise<ApiSearchResponse> {
  const params = new URLSearchParams({ query, page: String(page) });
  if (
    sort &&
    ["popular", "popular-week", "popular-today", "popular-month"].includes(sort)
  )
    params.set("sort", sort);
  const res = await throttledFetchJson<ApiSearchResponse>(
    "search",
    `${BASE}/api/v2/search?${params.toString()}`,
    { headers: headers(), ...(signal ? { signal } : {}) }
  );
  if (res.status === 429)
    throw new Error(
      "nHentai is rate-limiting this search. Set a valid nHentai API key in Settings to raise the limit, then try again."
    );
  if (
    res.status !== 200 ||
    !Array.isArray(res.data?.result) ||
    !Number.isSafeInteger(res.data.num_pages) ||
    res.data.num_pages! < 0
  ) {
    throw new Error(`nHentai search failed (HTTP ${res.status})`);
  }
  return res.data;
}

const slugTags = new Map<string, ApiTag>();
async function tagBySlug(
  type: string,
  slug: string,
  signal?: AbortSignal
): Promise<ApiTag | null> {
  const key = `${type}/${slug}`;
  if (slugTags.has(key)) return slugTags.get(key)!;
  const res = await throttledFetchJson<ApiTag>(
    "tags",
    `${BASE}/api/v2/tags/${type}/${encodeURIComponent(slug)}`,
    { headers: headers(), ...(signal ? { signal } : {}) }
  );
  if (res.status === 404) return null;
  if (
    res.status !== 200 ||
    !Number.isSafeInteger(res.data?.id) ||
    res.data!.id! < 1 ||
    mapTagType(res.data!.type) !== type ||
    res.data!.slug !== slug
  ) {
    throw new Error(`nHentai ${type} lookup failed (HTTP ${res.status})`);
  }
  boundedSet(slugTags, 2048, key, res.data!);
  rememberTag(res.data!.id!, res.data!);
  return res.data!;
}

// Artist pages have no language/exclusion parameters. Cache their native rows
// briefly, then filter before slicing so page offsets and totals stay exact.
// Pages are fetched lazily: a capped search() stops as soon as it has enough
// rows, while searchPage() (which reports an exact total) reads to the end.
interface ArtistListing {
  until: number;
  rows: ApiGalleryListItem[];
  seen: Set<number>;
  nextPage: number;
  done: boolean;
  loading: Promise<void> | null;
}
const artistListings = new Map<string, ArtistListing>();

async function fetchArtistListingPage(
  entry: ArtistListing,
  artist: ApiTag,
  order: string
): Promise<void> {
  const page = entry.nextPage;
  const params = new URLSearchParams({
    tag_id: String(artist.id),
    sort: order,
    page: String(page),
    per_page: "100",
  });
  const res = await throttledFetchJson<ApiSearchResponse>(
    "listing",
    `${BASE}/api/v2/galleries/tagged?${params.toString()}`,
    { headers: headers() }
  );
  if (
    res.status !== 200 ||
    !Array.isArray(res.data?.result) ||
    !Number.isSafeInteger(res.data.num_pages) ||
    res.data.num_pages! < 0
  ) {
    throw new Error(`nHentai artist listing failed (HTTP ${res.status})`);
  }
  const fresh: ApiGalleryListItem[] = [];
  for (const row of res.data.result) {
    if (!Number.isSafeInteger(row.id) || !Array.isArray(row.tag_ids))
      throw new Error("nHentai artist listing contained invalid metadata.");
    if (row.tag_ids.includes(artist.id!) && !entry.seen.has(row.id)) {
      fresh.push(row);
      entry.seen.add(row.id);
    }
  }
  const done = page >= res.data.num_pages!;
  if (!done && !res.data.result.length)
    throw new Error("nHentai artist listing was incomplete. Please retry.");
  // Commit only after the whole page validated, so a failure never leaves a
  // half-applied page behind.
  entry.rows.push(...fresh);
  entry.nextPage = page + 1;
  entry.done = done;
}

/** The artist's native rows, read until `enough(rows)` holds or the listing ends. */
async function artistRows(
  artist: ApiTag,
  sort?: DoujinSort,
  enough?: (rows: readonly ApiGalleryListItem[]) => boolean,
  signal?: AbortSignal
): Promise<{ rows: ApiGalleryListItem[]; done: boolean }> {
  const order =
    sort &&
    ["popular", "popular-week", "popular-today", "popular-month"].includes(sort)
      ? sort
      : "date";
  const key = JSON.stringify([artist.id, order, getApiKey()]);
  let entry = artistListings.get(key);
  if (!entry || entry.until <= Date.now()) {
    entry = {
      until: Date.now() + 60_000,
      rows: [],
      seen: new Set(),
      nextPage: 1,
      done: false,
      loading: null,
    };
    artistListings.set(key, entry);
    while (artistListings.size > 8)
      artistListings.delete(artistListings.keys().next().value!);
  }
  const current = entry;
  try {
    while (!current.done && !enough?.(current.rows)) {
      signal?.throwIfAborted();
      current.loading ??= fetchArtistListingPage(
        current,
        artist,
        order
      ).finally(() => {
        current.loading = null;
      });
      await raceAbort(current.loading, signal);
    }
  } catch (error) {
    if (!signal?.aborted && artistListings.get(key) === current)
      artistListings.delete(key);
    throw error;
  }
  return { rows: current.rows, done: current.done };
}

interface BannedExclusion {
  ns?: string;
  name: string;
}

function parseBannedExclusions(): BannedExclusion[] {
  const exclusions = buildBannedExclusions().match(/-([a-z]+:)?"[^"]*"/g) ?? [];
  const out: BannedExclusion[] = [];
  for (const exclusion of exclusions) {
    const match = /^-(?:([a-z]+):)?"([^"]*)"$/.exec(exclusion);
    if (!match) continue;
    out.push({
      ...(match[1] ? { ns: match[1] } : {}),
      name: match[2].toLowerCase(),
    });
  }
  return out;
}

/**
 * The artist's rows after language and ban filtering. With `need`, listing
 * pages are only fetched until at least that many rows survive the filters
 * (or the listing ends); without it, the whole catalog is read.
 */
async function exactArtistRows(
  lookup: NonNullable<ReturnType<typeof nhentaiArtistSearch>>,
  sort?: DoujinSort,
  need = Infinity,
  signal?: AbortSignal
): Promise<{ rows: ApiGalleryListItem[]; done: boolean }> {
  const artist = await tagBySlug("artist", lookup.slug, signal);
  if (!artist) return { rows: [], done: true };
  const language =
    lookup.language === "all"
      ? null
      : await tagBySlug("language", lookup.language, signal);
  if (lookup.language !== "all" && !language) return { rows: [], done: true };
  const exclusions = parseBannedExclusions();
  let minRows = Number.isFinite(need) ? need : Infinity;
  let processed = 0;
  const kept: ApiGalleryListItem[] = [];
  for (;;) {
    const listing = await artistRows(
      artist,
      sort,
      Number.isFinite(minRows) ? (rows) => rows.length >= minRows : undefined,
      signal
    );
    const batch = listing.rows.slice(processed);
    processed = listing.rows.length;
    if (batch.length) {
      kept.push(
        ...(await filterArtistRows(batch, language, exclusions, signal))
      );
    }
    if (listing.done || kept.length >= need)
      return { rows: kept, done: listing.done };
    minRows = listing.rows.length + 1; // filters dropped rows: read one more page
  }
}

async function filterArtistRows(
  all: readonly ApiGalleryListItem[],
  language: ApiTag | null,
  exclusions: readonly BannedExclusion[],
  signal?: AbortSignal
): Promise<ApiGalleryListItem[]> {
  let rows = language
    ? all.filter((row) => row.tag_ids!.includes(language.id!))
    : [...all];
  if (exclusions.length && rows.length) {
    const tags = await resolveTags(
      rows.flatMap((row) => row.tag_ids!),
      signal
    );
    if (rows.some((row) => row.tag_ids!.some((id) => !tags.has(id))))
      throw new Error(
        "nHentai tag metadata could not be loaded to apply banned tags. Please retry."
      );
    rows = rows.filter(
      (row) =>
        !exclusions.some((exclusion) => {
          const name = exclusion.name;
          return (
            (!exclusion.ns &&
              [row.english_title, row.japanese_title].some((title) =>
                title?.toLowerCase().includes(name)
              )) ||
            row.tag_ids!.some((id) => {
              const tag = tags.get(id)!;
              return (
                (!exclusion.ns || mapTagType(tag.type) === exclusion.ns) &&
                tag.name.toLowerCase().includes(name)
              );
            })
          );
        })
    );
  }
  return rows;
}

/**
 * Search rows only carry `thumbnail` (galleries/{media}/thumb.{ext}, about
 * 500px wide). Every gallery also serves the detail endpoint's dedicated
 * cover beside it (cover.{ext}, about 700px wide) under the same extension,
 * so cards use that instead of a blurry upscaled thumbnail.
 */
function searchCoverPath(thumbnail: string): string {
  return thumbnail.replace(/(^|\/)thumb(\.[^/]+)$/, "$1cover$2");
}

async function mapSearchRows(
  items: ApiGalleryListItem[],
  signal?: AbortSignal
): Promise<NhentaiSearchRow[]> {
  if (!items.length) return [];
  const tagIds = items.flatMap((item) =>
    Array.isArray(item?.tag_ids) ? item.tag_ids : []
  );
  const [cdn, tagsById] = await Promise.all([
    raceAbort(getCdn(), signal),
    resolveTags(tagIds, signal),
  ]);
  return items
    .filter((item) => item && typeof item.id === "number")
    .map((item) => {
      const id = String(item.id);
      const title =
        item.english_title || item.japanese_title || `Gallery ${id}`;
      const resolved = (item.tag_ids ?? [])
        .map((id) => tagsById.get(id))
        .filter((tag): tag is ApiTag => !!tag);
      const split = splitTags(resolved);
      return {
        source: "nhentai",
        galleryId: id,
        title,
        coverUrl: item.thumbnail
          ? joinServer(cdn.thumbServers[0], searchCoverPath(item.thumbnail))
          : undefined,
        tags: split.tags,
        tagNamespaces: split.tagNamespaces,
        artists: split.artists,
        series: split.parodies[0],
        parodies: split.parodies,
        groups: split.groups,
        characters: split.characters,
        language: detectLanguage(split.langTags, title),
        pageCount: item.num_pages ?? undefined,
        url: `${BASE}/g/${id}/`,
      };
    });
}

export const nhentaiProvider: DoujinProvider = {
  id: "nhentai",
  name: "nHentai",
  color: "#e91e63",
  meta: {
    sorts: [
      "default",
      "popular",
      "popular-week",
      "popular-today",
      "popular-month",
    ],
    paging: "offset",
  },

  async search(
    query: string,
    limit = 24,
    sort?: DoujinSort
  ): Promise<DoujinSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    // A bare gallery id / URL should resolve to that single gallery. The full
    // DoujinGallery doubles as a search row (it extends DoujinSearchResult).
    const id = directGalleryId(q);
    if (id) return [await this.getGallery(id)];
    const artist = nhentaiArtistSearch(q);
    if (artist) {
      const cap = Math.min(Math.max(1, limit), 250);
      return mapSearchRows(
        (await exactArtistRows(artist, sort, cap)).rows.slice(0, cap)
      );
    }

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

    const maxPages = Math.ceil(MAX_RESULTS / SEARCH_PAGE_SIZE);
    let page = 1;
    while (page <= maxPages) {
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
      if (page > totalPages) break;
      // Page spacing is enforced by the shared throttle — no extra pause needed.
    }

    return out.slice(0, want);
  },

  async searchPage(
    query: string,
    offset: number,
    limit: number,
    sort?: DoujinSort,
    opts?: { exactTotal?: boolean; signal?: AbortSignal }
  ) {
    const q = query.trim();
    if (!q) return { items: [], total: 0 };
    const signal = opts?.signal;
    const id = directGalleryId(q);
    if (id) {
      const gallery = await this.getGallery(id);
      return { items: offset ? [] : [gallery], total: 1 };
    }
    const artist = nhentaiArtistSearch(q);
    if (artist) {
      const need = opts?.exactTotal === false ? offset + limit : Infinity;
      const { rows, done } = await exactArtistRows(artist, sort, need, signal);
      const slice = rows.slice(offset, offset + limit);
      const total = !done
        ? Math.max(rows.length, offset + slice.length + 1)
        : rows.length;
      return { items: await mapSearchRows(slice, signal), total };
    }
    const searchQuery = nhentaiSearchQuery(q, buildBannedExclusions());
    const fetched = new Map<number, ApiSearchResponse>();
    const getPage = async (page: number) => {
      if (!fetched.has(page))
        fetched.set(
          page,
          await fetchSearchPage(searchQuery, page, sort, signal)
        );
      return fetched.get(page)!;
    };
    let page = Math.floor(offset / SEARCH_PAGE_SIZE) + 1;
    let response = await getPage(page);
    const perPage =
      Number.isSafeInteger(response.per_page) && response.per_page! > 0
        ? response.per_page!
        : SEARCH_PAGE_SIZE;
    const correctPage = Math.floor(offset / perPage) + 1;
    if (correctPage !== page) {
      page = correctPage;
      response = await getPage(page);
    }
    const numPages = response.num_pages ?? 0;
    let total = response.total;
    // The public schema permits a null total; skip fetching the last page when
    // exact totals aren't requested unless we're already reading it.
    if (!Number.isSafeInteger(total) || total! < 0) {
      if (opts?.exactTotal === false && page < numPages) {
        total = numPages * perPage;
      } else {
        total = numPages
          ? (numPages - 1) * perPage + (await getPage(numPages)).result.length
          : 0;
      }
    }
    const rows = response.result.slice(
      offset % perPage,
      (offset % perPage) + limit
    );
    if (offset < total! && !rows.length)
      throw new Error(
        "Could not load this nHentai results page. Please retry."
      );
    while (
      rows.length < limit &&
      page < numPages &&
      offset + rows.length < total!
    ) {
      page++;
      const next = (await getPage(page)).result;
      if (!next.length) break;
      rows.push(...next.slice(0, limit - rows.length));
    }
    return { items: await mapSearchRows(rows, signal), total: total! };
  },

  /**
   * Tag/artist autocomplete, mirroring the live site's search dropdown.
   * Backed by `POST /api/v2/tags/search` (name-prefix search across all tag
   * types). Results are returned most-popular-first with their gallery count.
   */
  async suggest(
    query: string,
    limit = 10,
    _context?: string,
    signal?: AbortSignal
  ): Promise<DoujinSuggestion[]> {
    const lookup = nhentaiAutocompleteQuery(query);
    if (!lookup) return [];
    const body = JSON.stringify({
      ...lookup,
      limit: Math.min(Math.max(limit, 1), 50),
    });
    const data = await searchTagsCached(body, signal);
    if (!data) return [];

    const out: DoujinSuggestion[] = [];
    for (const t of data) {
      if (!t?.name) continue;
      // Quote the name in the filter so names with spaces/specials survive.
      const filter = `${mapTagType(t.type)}:"${t.name}"`;
      out.push({
        source: "nhentai",
        type: mapTagType(t.type),
        name: t.name,
        count: typeof t.count === "number" ? t.count : undefined,
        filter,
        url: t.url ? `${BASE}${t.url}` : undefined,
      });
    }
    return out;
  },

  async getGallery(idOrUrl: string): Promise<DoujinGallery> {
    const id = extractGalleryId(idOrUrl, GALLERY_URL_RE);
    if (!id)
      throw new Error("Could not parse an nHentai gallery ID from the input.");

    const res = await throttledFetchJson<ApiGalleryDetail>(
      "gallery",
      `${BASE}/api/v2/galleries/${id}`,
      { headers: headers() }
    );
    if (res.status !== 200 || !res.data) {
      throw new Error(`nHentai gallery fetch failed (HTTP ${res.status})`);
    }
    const g = res.data;

    const title =
      g.title?.pretty ||
      g.title?.english ||
      g.title?.japanese ||
      `Gallery ${id}`;
    // Original-language (Japanese) title for metadata sync; display title stays
    // in `title`.
    const titleAlt =
      g.title?.japanese ||
      (g.title?.english && g.title.english !== g.title?.pretty
        ? g.title.english
        : undefined) ||
      undefined;

    // Pages: prefer the explicit pages[] list, else synthesize from num_pages.
    const cdn = await getCdn();
    const imageServers = cdn.imageServers;
    const thumbServer = cdn.thumbServers[0];
    const mediaId = g.media_id != null ? String(g.media_id) : "";

    const apiPages: ApiPage[] =
      Array.isArray(g.pages) && g.pages.length ? g.pages : [];
    // Index the page list once: both the URL build below and resolvePageUrl
    // look pages up by number, and a per-page find() is O(n²) across a gallery.
    // First entry wins so duplicate `number` fields keep the old find() match.
    const pageByNumber = new Map<number, ApiPage>();
    for (const ap of apiPages) {
      if (!pageByNumber.has(ap.number)) pageByNumber.set(ap.number, ap);
    }
    const pageCount = apiPages.length || g.num_pages || 0;
    if (!pageCount)
      throw new Error(
        `Could not determine the page count for nHentai gallery ${id}.`
      );

    const pages: string[] = [];
    const pageFallbacks: (string | null)[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const p = pageByNumber.get(n);
      let relPath = "";
      if (p?.path) {
        relPath = p.path;
      } else if (mediaId) {
        // Synthesize the canonical path: galleries/<mediaId>/<n>.<ext>
        const ext = apiPages[0]?.path?.split(".").pop() ?? "jpg";
        relPath = `galleries/${mediaId}/${n}.${ext}`;
      }
      if (!relPath)
        throw new Error(
          `Could not resolve image URLs for nHentai gallery ${id} (page ${n}).`
        );
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
        const thumbUrl = p?.thumbnail
          ? joinServer(thumbServer, p.thumbnail)
          : null;
        if (thumbUrl && thumbUrl !== primary) fallback = thumbUrl;
      }
      pages.push(primary);
      pageFallbacks.push(fallback);
    }

    // Tags: typed tags[] -> artists, characters, parodies, groups + flat list.
    const split = splitTags(g.tags ?? []);
    const language = detectLanguage(split.langTags, title);

    // Cover: prefer the dedicated cover, else the first thumbnail.
    const coverRel = typeof g.cover === "string" ? g.cover : g.cover?.path;
    const coverUrl = coverRel
      ? joinServer(thumbServer, coverRel)
      : (pageFallbacks[0] ?? undefined);

    return {
      source: "nhentai",
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
        let relPath = p?.path ?? "";
        if (!relPath && mediaId) {
          const ext = apiPages[0]?.path?.split(".").pop() ?? "jpg";
          relPath = `galleries/${mediaId}/${index + 1}.${ext}`;
        }
        if (!relPath) return null;
        const url2 = joinServer(cdnNow.imageServers[0], relPath);
        if (!url2) return null;
        const alts: string[] = [];
        for (let s = 1; s < cdnNow.imageServers.length; s++) {
          const alt = joinServer(cdnNow.imageServers[s], relPath);
          if (alt && alt !== url2 && !alts.includes(alt)) alts.push(alt);
        }
        const thumbUrl = p?.thumbnail
          ? joinServer(cdnNow.thumbServers[0], p.thumbnail)
          : null;
        if (!alts.length && thumbUrl && thumbUrl !== url2) alts.push(thumbUrl);
        return alts.length > 1
          ? { url: url2, fallback: alts[0], fallbacks: alts }
          : { url: url2, fallback: alts[0] ?? null };
      },
    };
  },
};
