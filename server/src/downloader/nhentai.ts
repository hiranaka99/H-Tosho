import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getDownloaderSettings } from '../services/settings.js';
import { fetchJson, sleep } from '../lib/http.js';
import { extractGalleryId, toIsoDate } from './util.js';
import { DOUJIN_SORTS, type DoujinGallery, type DoujinProvider, type DoujinSearchResult, type DoujinSort, type DoujinSuggestion } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * nHentai (nhentai.net) provider — uses the official v2 JSON API.
 *
 * Endpoints (see https://nhentai.net/api/v2/docs):
 *   - `GET /api/v2/search?query=<q>&limit=<n>`  -> { result: GalleryListItem[] }
 *   - `GET /api/v2/galleries/{id}`              -> GalleryDetailResponse
 *   - `GET /api/v2/cdn`                         -> { image_servers, thumb_servers }
 *
 * The detail response returns relative media paths (`galleries/<mediaId>/<n>.<ext>`)
 * plus a typed `tags[]` array. Full-resolution images live on the rotating
 * `image_servers` (i1..i4.nhentai.net) and thumbnails on `thumb_servers`. We
 * cache the CDN config briefly and prefix each relative path with the first
 * available server.
 */

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
    const name = String(raw ?? '').trim().replace(/"/g, '');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`-"${name}"`);
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
const CDN_TTL_MS = 10 * 60_000;

async function getCdn(): Promise<CdnConfig> {
  if (cdnCache && Date.now() - cdnCacheAt < CDN_TTL_MS) return cdnCache;
  const res = await fetchJson<{ image_servers: string[]; thumb_servers: string[] }>(`${BASE}/api/v2/cdn`, { headers: headers() }, 15_000, { raw: true });
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

// ---- tag taxonomy -----------------------------------------------------------

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
  /** Results per page as served by the API (25 without an API key, up to 50 with one). */
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

export const nhentaiProvider: DoujinProvider = {
  id: 'nhentai',
  name: 'nHentai',
  color: '#e91e63',

  async search(query: string, limit = 24, sort?: DoujinSort): Promise<DoujinSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    // Optional popularity ordering, mirroring nhentai.net's own sort controls
    // (`sort=popular` all time, `popular-week`, `popular-today`). Unknown or
    // omitted values fall back to the API's default (newest-first).
    const sortParam =
      sort && sort !== 'default' && DOUJIN_SORTS.includes(sort) ? `&sort=${sort}` : '';

    // A bare gallery id / URL should resolve to that single gallery.
    if (/^\d+$/.test(q)) {
      const g = await this.getGallery(q);
      return [
        {
          source: 'nhentai',
          galleryId: g.galleryId,
          title: g.title,
          coverUrl: g.coverUrl ?? undefined,
          tags: g.tags,
          artists: g.artists,
          language: g.language,
          pageCount: g.pageCount,
          url: g.url,
        },
      ];
    }

    // Append configured banned-tag exclusions so galleries carrying any of them
    // never show up in keyword/tag searches. (A bare gallery-ID lookup above is
    // an explicit request and intentionally skips this filter.)
    const banned = buildBannedExclusions();
    const searchQuery = banned ? `${q} ${banned}` : q;

    const cdn = await getCdn();
    const want = Math.max(limit, 1);
    // The API caps `limit` at 50 per request and paginates via `page`. Walk the
    // pages until we've collected `want` results or run out of pages. A hard cap
    // keeps open-ended queries (e.g. a single common tag) from issuing dozens of
    // sequential page requests — which is slow and easily trips nHentai's rate
    // limits, especially without a valid API key.
    const MAX_RESULTS = 250;
    const target = Math.min(want, MAX_RESULTS);
    const out: DoujinSearchResult[] = [];
    const seen = new Set<string>();

    let page = 1;
    do {
      const url = `${BASE}/api/v2/search?query=${encodeURIComponent(searchQuery)}&limit=50&page=${page}${sortParam}`;
      // Retry transient rate limits (429) / server errors with backoff so a
      // multi-page search doesn't fail on a single throttled request. Retries are
      // capped for BOTH 429 and 5xx — previously the 429 branch had no attempt
      // guard, so a sustained throttle retried forever (ever-growing backoff) and
      // hung the whole search well past a minute.
      interface SearchFetchResult { status: number; data: ApiSearchResponse | null }
      let res: SearchFetchResult = await fetchJson<ApiSearchResponse>(url, { headers: headers() }, 15_000, { raw: true });
      for (let attempt = 0; attempt < 3 && (res.status === 429 || res.status >= 500); attempt++) {
        await sleep(800 * (attempt + 1));
        res = await fetchJson<ApiSearchResponse>(url, { headers: headers() }, 15_000, { raw: true });
      }
      if (res.status === 429) {
        throw new Error(
          'nHentai is rate-limiting this search. Set a valid nHentai API key in Settings to raise the limit, then try again.',
        );
      }
      if (res.status !== 200 || !Array.isArray(res.data?.result)) {
        throw new Error(`nHentai search failed (HTTP ${res.status})`);
      }
      const items = res.data.result;
      if (!items.length) break;

      for (const item of items) {
        if (!item || typeof item.id !== 'number') continue;
        const id = String(item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          source: 'nhentai',
          galleryId: id,
          title: item.english_title || item.japanese_title || `Gallery ${id}`,
          coverUrl: joinServer(cdn.thumbServers[0], item.thumbnail ?? ''),
          tags: [],
          artists: [],
          pageCount: item.num_pages ?? undefined,
          url: `${BASE}/g/${id}/`,
        });
        if (out.length >= target) return out;
      }

      const totalPages = res.data.num_pages && res.data.num_pages > 0 ? res.data.num_pages : Infinity;
      page++;
      if (page > totalPages) break;
      // Small pause between pages to stay within the API's rate limits.
      await new Promise((r) => setTimeout(r, 250));
    } while (true);

    return out.slice(0, want);
  },

  /**
   * Tag/artist autocomplete, mirroring the live site's search dropdown.
   * Backed by `POST /api/v2/tags/search` (name-prefix search across all tag
   * types). Results are returned most-popular-first with their gallery count.
   */
  async suggest(query: string, limit = 10): Promise<DoujinSuggestion[]> {
    const q = query.trim();
    if (!q) return [];

    const body = JSON.stringify({ query: q, limit: Math.min(Math.max(limit, 1), 50) });
    // Prefer curl (Cloudflare lets it through); fall back to fetch().
    let data: ApiTag[] | null = await fetchTagsViaCurl(body);
    if (!data) {
      const res = await fetchJson<ApiTag[]>(`${BASE}/api/v2/tags/search`, {
        method: 'POST',
        headers: headers(),
        body,
      }, 15_000, { raw: true });
      if (res.status === 200 && Array.isArray(res.data)) data = res.data;
    }
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

    const res = await fetchJson<ApiGalleryDetail>(`${BASE}/api/v2/galleries/${id}`, { headers: headers() }, 15_000, { raw: true });
    if (res.status !== 200 || !res.data) {
      throw new Error(`nHentai gallery fetch failed (HTTP ${res.status})`);
    }
    const g = res.data;

    const title = g.title?.pretty || g.title?.english || g.title?.japanese || `Gallery ${id}`;

    // Pages: prefer the explicit pages[] list, else synthesize from num_pages.
    const cdn = await getCdn();
    const imageServer = cdn.imageServers[0];
    const thumbServer = cdn.thumbServers[0];
    const mediaId = g.media_id != null ? String(g.media_id) : '';

    const apiPages: ApiPage[] = Array.isArray(g.pages) && g.pages.length ? g.pages : [];
    const pageCount = apiPages.length || g.num_pages || 0;
    if (!pageCount) throw new Error(`Could not determine the page count for nHentai gallery ${id}.`);

    const pages: string[] = [];
    const pageFallbacks: (string | null)[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const p = apiPages.find((ap) => ap.number === n);
      let fullUrl = '';
      let thumbUrl: string | undefined;
      if (p?.path) {
        fullUrl = joinServer(imageServer, p.path);
        thumbUrl = p.thumbnail ? joinServer(thumbServer, p.thumbnail) : undefined;
      } else if (mediaId) {
        // Synthesize the canonical path: galleries/<mediaId>/<n>.<ext>
        const ext = apiPages[0]?.path?.split('.').pop() ?? 'jpg';
        fullUrl = joinServer(imageServer, `galleries/${mediaId}/${n}.${ext}`);
      }
      if (!fullUrl) throw new Error(`Could not resolve image URLs for nHentai gallery ${id} (page ${n}).`);
      pages.push(fullUrl);
      pageFallbacks.push(thumbUrl && thumbUrl !== fullUrl ? thumbUrl : null);
    }

    // Tags: typed tags[] -> artists, characters, language, series + flat list.
    const artists: string[] = [];
    const characters: string[] = [];
    const langTags: string[] = [];
    let series: string | undefined;
    const flatTags: string[] = [];
    for (const t of g.tags ?? []) {
      if (!t?.name) continue;
      const category = mapTagType(t.type);
      flatTags.push(t.name);
      if (category === 'artist') artists.push(t.name);
      else if (category === 'character') characters.push(t.name);
      else if (category === 'language') langTags.push(t.name);
      else if (category === 'series' && !series) series = t.name;
    }

    const language = detectLanguage(langTags, title);

    // Cover: prefer the dedicated cover, else the first thumbnail.
    const coverRel = typeof g.cover === 'string' ? g.cover : g.cover?.path;
    const coverUrl = coverRel ? joinServer(cdn.thumbServers[0], coverRel) : pageFallbacks[0] ?? undefined;

    return {
      source: 'nhentai',
      galleryId: id,
      title,
      coverUrl,
      language,
      series,
      artists,
      tags: flatTags.slice(0, 40),
      pageCount,
      pages,
      pageFallbacks,
      uploadedAt: toIsoDate(g.upload_date),
      url: `${BASE}/g/${id}/`,
    };
  },
};