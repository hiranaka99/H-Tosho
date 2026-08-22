/**
 * Unified doujinshi model for the downloader module. Both providers normalize
 * their raw API/HTML responses into `DoujinGallery` and `DoujinPage` objects;
 * the queue engine only ever consumes these shapes.
 */

export type DoujinSource = 'hitomi' | 'nhentai';

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
  /** Optional group/circle name. */
  groups?: string[];
  /** Optional ComicInfo.xsd `Tags`/`Genres` already split. */
  genres?: string[];
  /** Optional Manga (Doujin) rating value (0-10). */
  rating?: number;
  /**
   * Extra HTTP headers the engine must send when fetching `pages`/`pageFallbacks`.
   * Some CDNs (e.g. Hitomi) reject requests that lack a matching Referer.
   */
  requestHeaders?: Record<string, string>;
}

/** Progress payload persisted in the queue row's resultJson during a run. */
export interface DownloadProgress {
  downloaded: number;
  total: number;
  bytesPerSecond: number;
  currentFile: string | null;
}

export interface DownloadEnqueueResult {
  id: number;
  status: string;
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
  /** Keyword/tag/artist search. */
  search(query: string, limit?: number): Promise<DoujinSearchResult[]>;
  /** Optional tag/artist autocomplete suggestions for a query prefix. */
  suggest?(query: string, limit?: number): Promise<DoujinSuggestion[]>;
}
