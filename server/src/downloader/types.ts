/**
 * Unified doujinshi model for the downloader module. Both providers normalize
 * their raw API/HTML responses into `DoujinGallery` and `DoujinPage` objects;
 * the queue engine only ever consumes these shapes.
 */

export type DoujinSource = 'hitomi' | 'nhentai';

/**
 * Optional result ordering for a source search. nHentai mirrors nhentai.net's
 * `sort=popular[-week|-today]`; Hitomi mirrors hitomi.la's
 * `orderby:popular orderbykey:<period>` (today/week/year), resolved
 * server-side against the popularity index and never appended to the user's
 * query text. Each provider ignores values it does not support.
 */
export type DoujinSort = 'default' | 'popular' | 'popular-week' | 'popular-today' | 'popular-year';

export const DOUJIN_SORTS: DoujinSort[] = ['default', 'popular', 'popular-week', 'popular-today', 'popular-year'];

/** A tag/artist/group autocomplete suggestion (as shown by the source's own search box). */
export interface DoujinSuggestion {
  source: DoujinSource;
  /** Tag category, e.g. artist, group, character, series, tag, language… */
  type: string;
  name: string;
  /** Gallery count for this tag (when the source exposes it). */
  count?: number;
  /** Query fragment that filters to this tag on the source, e.g. `artist:konboi`. */
  filter?: string;
  url?: string;
}

export interface DoujinSearchResult {
  source: DoujinSource;
  galleryId: string;
  title: string;
  coverUrl?: string;
  language?: string;
  tags: string[];
  artists: string[];
  pageCount?: number;
  /** Original gallery URL (for user reference). */
  url?: string;
  /** When the gallery was uploaded/published, as an ISO 8601 date string. */
  uploadedAt?: string;
}

/** Full gallery metadata + image list resolved by a provider fetcher. */
export interface DoujinGallery extends DoujinSearchResult {
  /** Ordered list of full-resolution (or best available) image URLs. */
  pages: string[];
  /**
   * Optional per-page fallback URLs (same length as `pages`). When a primary
   * page URL fails to download, the engine tries the corresponding fallback.
   */
  pageFallbacks?: (string | null)[];
  series?: string;
  /** Original-language title when the source exposes one (display title stays in `title`). */
  titleAlt?: string;
  groups?: string[];
  /** Scanlation group credited by the source, when exposed. */
  scanlator?: string;
  /** Optional character names from the gallery. */
  characters?: string[];
  /** Optional parody/series the gallery is a fan work of (all values, not just the primary). */
  parodies?: string[];
  /**
   * Search namespace for each entry in `tags` (parallel array, same order and
   * length). Hitomi tags carry a `female`/`male` area; nHentai tags carry their
   * tag type (`tag`, `artist`, ...). Undefined where the tag is searched as a
   * plain keyword. Serialized over JSON as null in those slots.
   */
  tagNamespaces?: (string | undefined)[];
  /** Optional ComicInfo.xsd `Tags`/`Genres` already split. */
  genres?: string[];
  /** Optional Manga (Doujin) rating value (0-10). */
  rating?: number;
  /**
   * Extra HTTP headers the engine must send when fetching `pages`/`pageFallbacks`.
   * Some CDNs (e.g. Hitomi) reject requests that lack a matching Referer.
   */
  requestHeaders?: Record<string, string>;
  /**
   * Optional live URL resolver. When present, the engine calls this to rebuild a
   * page's primary + fallback URLs against the provider's *current* routing/CDN
   * state immediately before fetching (and again after a failure, with
   * `forceRefresh`), so long downloads survive CDN base-path rotation that would
   * otherwise 404 stale pre-built URLs. Returns null if the index is unknown.
   */
  resolvePageUrl?: (index: number, opts?: { forceRefresh?: boolean }) => Promise<{ url: string; fallback?: string | null } | null>;
}

/** Progress payload persisted on the queue row during a run. */
export interface DownloadProgress {
  /** Pages (or items) fully downloaded. */
  downloaded: number;
  /** Total pages (or items) to download. */
  total: number;
  /** Estimated transfer speed in bytes/second (EMA). */
  bytesPerSecond: number;
  /** Filename of the item currently being written, if any. */
  currentFile: string | null;
  /** Total image bytes received so far this run. */
  bytesCurrent?: number;
  /** Total image bytes expected for the run (0/undefined until known). */
  bytesTotal?: number;
  /** Coarse phase label for UI display, e.g. 'resolving' | 'downloading' | 'packing'. */
  phase?: string | null;
}

export interface DownloadEnqueueResult {
  id: number;
  status: string;
}

/**
 * Optional search modifiers. Like `sort`, providers ignore values they do not
 * support.
 */
export interface DoujinSearchOptions {
  /** Gallery types to omit from the results (provider-specific type names, e.g. hitomi's `artistcg`). */
  excludeTypes?: string[];
  /**
   * Number of leading results to skip before collecting up to `limit` — a
   * seeded window into a static ranking so repeated rolls sample different
   * slices instead of the same top N. Providers that cannot skip ignore it.
   */
  skip?: number;
  /** Automatic recommendations never override configured bans. */
  strictExclusions?: boolean;
}

/**
 * The provider contract each doujin source implements. Analogous to the
 * metadata `MetadataProvider`, but focused on gallery fetch + image list
 * resolution rather than series metadata.
 */
export interface DoujinProvider {
  id: DoujinSource;
  name: string;
  color: string;
  /** Lookup by gallery id or URL string. */
  getGallery(idOrUrl: string): Promise<DoujinGallery>;
  /** Keyword/tag/artist search. `sort` is only honored by providers that support it. */
  search(query: string, limit?: number, sort?: DoujinSort, opts?: DoujinSearchOptions): Promise<DoujinSearchResult[]>;
  /** Optional tag/artist autocomplete suggestions for a query prefix. */
  suggest?(query: string, limit?: number): Promise<DoujinSuggestion[]>;
  /** Recheck cached/history candidates against current provider exclusions. */
  filterRecommendations?(items: DoujinSearchResult[]): Promise<DoujinSearchResult[]>;
}
