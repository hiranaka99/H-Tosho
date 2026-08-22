import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getDownloaderSettings } from '../services/settings.js';
import { fetchJson } from '../lib/http.js';
import { extractGalleryId } from './util.js';
import type { DoujinGallery, DoujinProvider, DoujinSearchResult, DoujinSuggestion } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * NHentai (nhentai.net) provider — uses the official v2 JSON API.
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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
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

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${BASE}/`,
  };
  const key = getApiKey();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

/** curl header args, mirroring headers() for the subprocess path. */
function curlAuthArgs(): string[] {
  const key = getApiKey();
  return key ? ['-H', `Authorization: Bearer ${key}`] : [];
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
  const res = await fetchJson<{ image_servers: string[]; thumb_servers: string[] }>(`${BASE}/api/v2/cdn`, { headers: headers() });
  if (res.status !== 200 || !res.data?.image_servers?.length) {
    throw new Error('NHentai CDN config fetch failed');
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

/** Map an NHentai v2 tag `type` onto our normalized tag category. */
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
}

export const nhentaiProvider: DoujinProvider = {
  id: 'nhentai',
  name: 'NHentai',
  color: '#e91e63',

  async search(query: string, limit = 24): Promise<DoujinSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

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

    const cdn = await getCdn();
    const want = Math.max(limit, 1);
    // The API caps `limit` at 50 per request and paginates via `page`. Walk the
    // pages until we've collected `want` results or run out of pages, so callers
    // receive the full result set rather than just the first page. A hard cap
    // keeps open-ended queries (e.g. a single common tag) from issuing hundreds
    // of requests and stalling the UI.
    const MAX_RESULTS = 1000;
    const target = Math.min(want, MAX_RESULTS);
    const out: DoujinSearchResult[] = [];
    const seen = new Set<string>();

    let page = 1;
    do {
      const url = `${BASE}/api/v2/search?query=${encodeURIComponent(q)}&limit=50&page=${page}`;
      // Retry transient rate limits (429) / server errors with backoff so a
      // multi-page search doesn't fail on a single throttled request.
      interface SearchFetchResult { status: number; data: ApiSearchResponse | null }
      let res: SearchFetchResult = await fetchJson<ApiSearchResponse>(url, { headers: headers() });
      for (let attempt = 0; res.status === 429 || res.status >= 500 && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        res = await fetchJson<ApiSearchResponse>(url, { headers: headers() });
      }
      if (res.status !== 200 || !Array.isArray(res.data?.result)) {
        throw new Error(`NHentai search failed (HTTP ${res.status})`);
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
      });
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
    if (!id) throw new Error('Could not parse an NHentai gallery ID from the input.');

    const res = await fetchJson<ApiGalleryDetail>(`${BASE}/api/v2/galleries/${id}`, { headers: headers() });
    if (res.status !== 200 || !res.data) {
      throw new Error(`NHentai gallery fetch failed (HTTP ${res.status})`);
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
    if (!pageCount) throw new Error(`Could not determine the page count for NHentai gallery ${id}.`);

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
      if (!fullUrl) throw new Error(`Could not resolve image URLs for NHentai gallery ${id} (page ${n}).`);
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
      url: `${BASE}/g/${id}/`,
    };
  },
};