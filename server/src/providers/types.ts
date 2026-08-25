/**
 * Unified metadata model shared across all H-Tosho providers.
 * This is the canonical shape that the aggregation engine and Kavita sync
 * layer operate on, decoupled from any provider's raw API schema.
 */

export type MediaType = 'MANGA' | 'NOVEL' | 'COMIC' | 'WEBTOON';

export interface SearchResult {
  providerId: string;
  providerSeriesId: string;
  title: string;
  /** Alternate/romanized titles for matching — the display title may miss the one a folder name uses. */
  altTitles?: string[];
  type: MediaType;
  year?: number;
  coverUrl?: string;
  summary?: string;
}

/** A single cover image for one volume of a series. */
export interface VolumeCover {
  /** 1-based volume number as published by the provider. */
  number: number;
  /** Resolved CDN URL of the cover image. */
  url: string;
}
/** Unified series-level metadata. All list fields are optional/emptyable. */
export interface SeriesMetadata {
  providerId: string;
  providerSeriesId: string;
  title: string;
  /** Provider-backed names offered when choosing the ComicInfo.Series value. */
  titleOptions?: string[];
  year?: number;
  releaseDate?: string;
  summary?: string;
  coverUrl?: string;
  genres: string[];
  tags: string[];
  /** Person roles: Writer / Artist / Illustrator / etc. */
  writers: string[];
  artists: string[];
  readingDirection?: 'LTR' | 'RTL' | 'TBR';
  language?: string;
  /** ONGOING | COMPLETED | HIATUS | CANCELLED | UNKNOWN */
  status?: 'ONGOING' | 'COMPLETED' | 'HIATUS' | 'CANCELLED' | 'UNKNOWN';
  url?: string;
  /** Per-volume cover art (MangaDex only), one entry per volume number. */
  volumeCovers?: VolumeCover[];
}

/** Unified book/chapter-level metadata (optional per provider). */
export interface BookMetadata {
  providerId: string;
  providerBookId: string;
  title: string;
  number?: string | number;
  releaseDate?: string;
  summary?: string;
  coverUrl?: string;
}

/** Credentials a provider may need (all optional strings). */
export type ProviderCredentials = Record<string, string>;

/** The contract every metadata provider must implement. */
export interface MetadataProvider {
  id: string;
  name: string;
  /** Human friendly accent color used in UI badges. */
  color: string;
  /** Docs/help URL shown in settings. */
  helpUrl?: string;
  supportedTypes: MediaType[];
  /** Whether this provider requires credentials to search. */
  requiresCredentials: boolean;
  /** Field names this provider is known to populate (for UI hints). */
  providesFields: string[];

  /** Inject credentials before search/metadata calls. */
  setCredentials(credentials: ProviderCredentials): void;
  /** Validate the currently-set credentials; throws on failure. */
  testConnection(): Promise<void>;
  search(query: string, type?: MediaType): Promise<SearchResult[]>;
  getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata>;
  getBookMetadata?(providerBookId: string): Promise<BookMetadata>;
}