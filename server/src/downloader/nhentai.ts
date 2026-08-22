import { fetchJson } from '../lib/http.js';
import { extractGalleryId } from './util.js';
import type { DoujinGallery, DoujinProvider, DoujinSearchResult } from './types.js';

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

function headers(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${BASE}/`,
  };
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

interface ApiTag {
  type: string;
  name: string;
  slug?: string;
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

    const res = await fetchJson<{ result: ApiGalleryListItem[] }>(
      `${BASE}/api/v2/search?query=${encodeURIComponent(q)}&limit=${Math.min(Math.max(limit, 1), 50)}`,
      { headers: headers() },
    );
    if (res.status !== 200 || !Array.isArray(res.data?.result)) {
      throw new Error(`NHentai search failed (HTTP ${res.status})`);
    }

    const cdn = await getCdn();
    const out: DoujinSearchResult[] = [];
    for (const item of res.data.result) {
      if (!item || typeof item.id !== 'number') continue;
      const id = String(item.id);
      const title = item.english_title || item.japanese_title || `Gallery ${id}`;
      out.push({
        source: 'nhentai',
        galleryId: id,
        title,
        coverUrl: joinServer(cdn.thumbServers[0], item.thumbnail ?? ''),
        tags: [],
        artists: [],
        pageCount: item.num_pages ?? undefined,
        url: `${BASE}/g/${id}/`,
      });
      if (out.length >= limit) break;
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