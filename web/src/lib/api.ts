// Typed client for the H-Tosho REST API.

export interface KavitaConnection {
  baseUrl: string;
  apiKey: string;
}

export interface KavitaLibrary {
  id: number;
  name: string;
  path?: string;
  paths?: string[];
  mediaFormat?: string;
  monitor?: boolean;
  seriesCount?: number;
  matchedCount?: number;
}

export interface SeriesRow {
  id: number;
  libraryId?: number;
  libraryName?: string;
  name: string;
  slug?: string;
  bookCount?: number;
  /** Total page count across the series' chapters (Kavita-tracked). */
  pageCount?: number | null;
  cover?: string | null;
  status: string;
  providerId?: string | null;
  matchScore?: number | null;
  /** A user explicitly accepted this candidate. */
  confirmed?: boolean;
  lastSyncedAt?: string | null;
  /** When the series was added to Kavita (Kavita's series creation date). */
  dateAdded?: string | null;
  errorMessage?: string | null;
  /** Provider artist names from the stored match metadata (empty when unmatched or unknown). */
  artists?: string[];
}

/** Local match row for a Kavita series (server `series_matches` table). */
export interface SeriesMatch {
  id?: number;
  kavitaSeriesId: number;
  /** unmatched | matched | syncing | failed */
  status: string;
  providerId?: string | null;
  providerSeriesId?: string | null;
  matchScore?: number | null;
  /** A user explicitly accepted this candidate. */
  confirmed?: boolean;
  metadataJson?: string | null;
  errorMessage?: string | null;
  lastSyncedAt?: string | null;
}

export interface KavitaTag {
  id: number;
  title: string | null;
}

export interface KavitaPerson {
  id: number;
  name: string | null;
}

/** Subset of Kavita's series metadata DTO that H-Tosho displays and edits. */
export interface KavitaSeriesMetadata {
  summary: string | null;
  genres: KavitaTag[] | null;
  tags: KavitaTag[] | null;
  writers: KavitaPerson[] | null;
  coverArtists: KavitaPerson[] | null;
  publishers: KavitaPerson[] | null;
  /** H-Tosho writes provider "artists" into Kavita's penciller role. */
  pencillers: KavitaPerson[] | null;
  imprints: KavitaPerson[] | null;
  ageRating: number;
  releaseYear: number;
  language: string | null;
  publicationStatus: number;
  webLinks: string | null;
}

export interface KavitaSeriesView {
  id: number;
  libraryId: number;
  name: string;
  slug: string;
  bookCount: number;
  cover?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  color: string;
  helpUrl?: string | null;
  supportedTypes: string[];
  requiresCredentials: boolean;
  providesFields: string[];
  credentialFields: { key: string; label: string }[];
  enabled: boolean;
  hasCredentials: boolean;
  credentials: Record<string, string>;
}

export interface Settings {
  priorities: string[];
  notifications: {
    discord: { enabled: boolean; webhookUrl: string };
  };
  pollIntervalHours: number;
  watchedSearchIntervalMinutes: number;
}

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  context?: { series: { id: number; name: string }[]; libraryId?: number; libraryName?: string };
  status: string;
  progressCurrent: number;
  progressTotal: number;
  /** Arbitrary JSON summary stored by the job executor (often an object). */
  result: unknown;
  errorMessage: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  recovery?: { explanation: string; actions: { label: string; href: string }[] };
}

export interface JobLog {
  id: number;
  jobId: number;
  level: string;
  message: string;
  createdAt: string;
}

export interface SearchResult {
  providerId: string;
  providerSeriesId: string;
  title: string;
  type: string;
  year?: number;
  coverUrl?: string;
  summary?: string;
}

export interface SeriesMetadata {
  providerId: string;
  providerSeriesId: string;
  title: string;
  titleOptions?: string[];
  year?: number;
  releaseDate?: string;
  summary?: string;
  coverUrl?: string;
  genres: string[];
  tags: string[];
  writers: string[];
  artists: string[];
  language?: string;
  status?: string;
  url?: string;
}

/** A scored match candidate (mirrors the server's CandidateMatch). */
export interface MatchCandidate extends SearchResult {
  score: number;
}

export interface MatchOutcome {
  matched: boolean;
  best?: MatchCandidate;
  candidates: MatchCandidate[];
  /** Providers that were actually consulted, in evaluation order. */
  searchedProviders: string[];
  /** Per-provider search failures (providerId -> message), when a provider was enabled but errored. */
  errors?: Record<string, string>;
}

// ---------------- Doujinshi downloader types ----------------

export type DoujinSource = 'hitomi' | 'nhentai';

/** Result ordering for a source search (nHentai and Hitomi support popularity sorts). */
export type DoujinSort = 'default' | 'popular' | 'popular-week' | 'popular-today' | 'popular-year';

export interface DoujinProvider {
  id: DoujinSource;
  name: string;
  color: string;
}

export interface DoujinSearchResult {
  source: DoujinSource;
  galleryId: string;
  title: string;
  coverUrl?: string | null;
  tags: string[];
  artists: string[];
  language?: string | null;
  pageCount?: number | null;
  /** When the gallery was uploaded/published (ISO 8601 date string). */
  uploadedAt?: string | null;
}

export interface DoujinSuggestion {
  source: DoujinSource;
  type: string;
  name: string;
  count?: number;
  filter?: string;
  url?: string;
}

export interface DoujinGallery {
  source: DoujinSource;
  galleryId: string;
  title: string;
  coverUrl?: string | null;
  language?: string | null;
  series?: string | null;
  artists: string[];
  tags: string[];
  /** Search namespace per tag (parallel to `tags`; null = plain keyword). */
  tagNamespaces?: (string | null)[];
  /** Group/circle names. */
  groups?: string[];
  /** Character names from the gallery. */
  characters?: string[];
  /** All parody/series values the gallery is a fan work of. */
  parodies?: string[];
  /** Original-language title when the source exposes one. */
  titleAlt?: string;
  /** Legacy genres slot (Hitomi historically mapped characters here). */
  genres?: string[];
  pageCount: number;
  /** Ordered same-origin URLs for browsing the gallery before downloading. */
  previewPages: string[];
  /** Optional lower-quality or alternate rendition for each preview page. */
  previewFallbacks?: (string | null)[];
  url?: string;
  /** When the gallery was uploaded/published (ISO 8601 date string). */
  uploadedAt?: string | null;
}

export interface DownloaderSettings {
  downloadDirectory: string;
  libraryPathMappings?: LibraryPathMapping[];
  format: 'cbz' | 'folder';
  maxConcurrentDownloads: number;
  maxImageConcurrency: number;
  requestDelayMs: number;
  autoSyncKavita: boolean;
  nhentaiApiKey: string;
  /** Tag names to exclude from all nHentai searches (e.g. "loli", "big breasts"). */
  nhentaiBannedTags: string[];
  /** Tag names to exclude from all Hitomi searches (e.g. "loli", "artist:foo"). */
  hitomiBannedTags: string[];
}

export interface LibraryPathMapping {
  kavitaPath: string;
  localPath: string;
}

export type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'failed' | 'paused';

export interface DownloadTask {
  id: number;
  source: DoujinSource;
  galleryId: string;
  title: string | null;
  status: DownloadStatus;
  progressCurrent: number;
  progressTotal: number;
  speed: number | null;
  currentFile: string | null;
  /** Total image bytes received so far this run. */
  bytesCurrent?: number;
  /** Total image bytes expected for the run (0 until known). */
  bytesTotal?: number;
  outputFormat: 'cbz' | 'folder';
  outputPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** A single frame pushed over the download SSE stream. */
export type DownloadEvent =
  | { type: 'snapshot'; tasks: DownloadTask[] }
  | { type: 'task'; task: DownloadTask }
  | { type: 'removed'; ids: number[] };

/** A gallery with a completed download task (duplicate-download guard). */
export interface DownloadedGallery {
  source: DoujinSource;
  galleryId: string;
  title: string | null;
  finishedAt: string | null;
}

/** A saved doujin search that pings Discord when it finds new results. */
export interface WatchedSearch {
  id: number;
  source: DoujinSource;
  query: string;
  lastCheckedAt: string | null;
  lastResultCount: number | null;
  seenCount: number;
  /** New galleries from the last check that found something (empty otherwise). */
  lastResults: WatchedSearchResultItem[];
}

/** One gallery in a watch's "new since last check" list. */
export interface WatchedSearchResultItem {
  galleryId: string;
  title: string;
  url?: string;
  coverUrl?: string;
  pageCount?: number;
}

/** One gallery in the "recently added" feed (reported new by a watched search). */
export interface WatchedNewGallery {
  source: DoujinSource;
  galleryId: string;
  title: string;
  url?: string | null;
  coverUrl?: string | null;
  pageCount?: number;
  /** The watch query that found the gallery. */
  query: string;
  /** ISO 8601 timestamp of the check that first reported it. */
  foundAt: string;
}

/** One pick in a daily recommendation set (a search result plus why it matched). */
export interface RecommendationItem extends DoujinSearchResult {
  /** Human-readable profile terms that matched this gallery, e.g. ["artist konboi", "tag solo"]. */
  reasons: string[];
}

/** The day's recommendation set (cached server-side per local date). */
export interface RecommendationSet {
  date: string;
  generatedAt: string;
  /** Whether picks came from taste matches, popularity, or both. */
  mode: 'library' | 'mixed' | 'popular';
  profile: { artists: string[]; tags: string[]; series: string[]; language: string | null };
  items: RecommendationItem[];
  /** Number of least-recently-shown picks reused to keep the panel full. */
  repeatedCount: number;
  degradedReason: 'same-day-pool-exhausted' | 'insufficient-eligible' | null;
  /** Keys (`source:galleryId`) of every owned gallery — drives the owned badges. */
  ownedKeys: string[];
  /** Keys (`source:galleryId`) permanently excluded by recommendation feedback. */
  dismissedKeys: string[];
}

export interface RecommendationSettings {
  /** Kavita library ids excluded from the recommendation profile. */
  excludedLibraryIds: number[];
}

export interface RecommendationFeedback {
  liked: DoujinSearchResult[];
  mutedArtists: string[];
}
export interface FeedbackRequest {
  action: 'like' | 'unlike' | 'mute-artist' | 'unmute-artist';
  source: DoujinSource; galleryId: string; artist?: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
}

export class ApiError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown>, public readonly status: number) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('htosho:unauthorized'));
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let details: Record<string, unknown> = {};
    try {
      const body = await res.json();
      if (body && typeof body === 'object') details = body;
      if (body && body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, details, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),
  version: () => request<{ version: string | null }>('/version'),
  setup: (username: string, password: string) => request<{ authenticated: true; username: string }>('/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) => request<{ authenticated: true; username: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ authenticated: false }>('/auth/logout', { method: 'POST' }),
  changeCredentials: (currentPassword: string, username: string, password: string) => request<{ authenticated: true; username: string }>('/auth/credentials', { method: 'PUT', body: JSON.stringify({ currentPassword, username, password }) }),
  kavitaStatus: () => request<{
    configured: boolean;
    baseUrl?: string;
    hasApiKey?: boolean;
    version?: string | null;
    apiVersion?: string;
    error?: string | null;
  }>('/kavita/status'),
  saveConnection: (conn: KavitaConnection) =>
    request<{ saved: boolean; connected: boolean; test: string }>('/kavita/connection', {
      method: 'POST',
      body: JSON.stringify(conn),
    }),
  libraries: () => request<KavitaLibrary[]>('/kavita/libraries'),
  librarySeries: (libraryId: number) => request<SeriesRow[]>(`/kavita/libraries/${libraryId}/series`),
  libraryOverride: (id: number) =>
    request<{ libraryId: number; priority: string[]; autoMatch: boolean }>(`/libraries/${id}/override`),
  saveLibraryOverride: (id: number, patch: Partial<Omit<{ priority: string[]; autoMatch: boolean }, 'libraryId'>>) =>
    request<{ ok: boolean }>(`/libraries/${id}/override`, { method: 'PUT', body: JSON.stringify(patch) }),

  series: (id: number) =>
    request<{
      series: KavitaSeriesView;
      match: SeriesMatch | null;
      metadata: SeriesMetadata | null;
      kavita: KavitaSeriesMetadata | null;
    }>(`/series/${id}`),
  identify: (id: number) => request<MatchOutcome>(`/series/${id}/identify`),
  manualMatch: (id: number, url: string) => request<MatchCandidate>(`/series/${id}/manual-match`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  }),
  /** Queue Apply & Sync as a background job (the Kavita scan wait can take minutes). */
  apply: (id: number, providerId: string, providerSeriesId: string, opts?: { selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number }) =>
    request<{ id: number }>(`/series/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ providerId, providerSeriesId, ...opts }),
    }),
  /** Manually unmatch a series (drops the local match row). */
  unmatch: (id: number) => request<{ ok: boolean; removed: boolean }>(`/series/${id}/match`, { method: 'DELETE' }),
  /** Matched series whose confidence is below the review threshold (local DB only). */
  lowConfidenceCount: () => request<{ count: number; threshold: number }>('/series/low-confidence'),
  reviewSeries: () => request<SeriesRow[]>('/series/needs-review'),
  watchedSearches: () => request<WatchedSearch[]>('/watched-searches'),
  addWatchedSearch: (source: DoujinSource, query: string) =>
    request<WatchedSearch>('/watched-searches', { method: 'POST', body: JSON.stringify({ source, query }) }),
  removeWatchedSearch: (id: number) => request<{ ok: boolean }>(`/watched-searches/${id}`, { method: 'DELETE' }),
  checkWatchedSearches: () => request<{ id: number }>('/watched-searches/check', { method: 'POST' }),
  watchedSearchNew: (limit?: number) =>
    request<WatchedNewGallery[]>(`/watched-searches/new${limit ? `?limit=${limit}` : ''}`),

  // ---------------- Recommendations ----------------
  /** Today's recommendation set (cached per local date server-side). */
  recommendations: () => request<RecommendationSet>('/recommendations'),
  /** Re-roll today's picks with a fresh seed. */
  refreshRecommendations: () => request<RecommendationSet>('/recommendations/refresh', { method: 'POST' }),
  /** Exclude a gallery from recommendations without marking it owned. */
  dismissGallery: (body: { source: DoujinSource; galleryId: string }) =>
    request<RecommendationSet>('/recommendations/dismiss', { method: 'POST', body: JSON.stringify(body) }),
  /** Reallow a previously dismissed gallery. */
  undoDismissGallery: (body: { source: DoujinSource; galleryId: string }) =>
    request<RecommendationSet>('/recommendations/undo-dismiss', { method: 'POST', body: JSON.stringify(body) }),
  recommendationSettings: () => request<RecommendationSettings>('/recommendations/settings'),
  recommendationFeedback: () => request<RecommendationFeedback>('/recommendations/feedback'),
  saveRecommendationFeedback: (body: FeedbackRequest) => request<{ feedback: RecommendationFeedback; recommendations: RecommendationSet }>('/recommendations/feedback', { method: 'POST', body: JSON.stringify(body) }),
  saveRecommendationSettings: (body: RecommendationSettings) =>
    request<RecommendationSettings>('/recommendations/settings', { method: 'POST', body: JSON.stringify(body) }),
  /** Light Kavita library list (id + name) for the recommendation settings row. */
  recommendationLibraries: () => request<{ id: number; name: string }[]>('/recommendations/libraries'),

  /** Aggregated metadata a candidate would sync — same path as apply. */
  providerMetadata: (providerId: string, providerSeriesId: string) =>
    request<SeriesMetadata>(`/providers/${providerId}/series/${providerSeriesId}`),

  providers: () => request<ProviderInfo[]>('/providers'),
  saveProvider: (id: string, setting: { enabled?: boolean; credentials?: Record<string, string> }) =>
    request<{ ok: boolean }>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(setting) }),
  testProvider: (id: string) => request<{ ok: boolean; error?: string }>(`/providers/${id}/test`, { method: 'POST' }),
  settings: () => request<Settings>('/settings'),
  savePriorities: (priorities: string[]) =>
    request<{ ok: boolean }>('/settings/priorities', { method: 'PUT', body: JSON.stringify({ priorities }) }),
  saveNotifications: (notifications: Settings['notifications']) =>
    request<{ ok: boolean }>('/settings/notifications', {
      method: 'PUT',
      body: JSON.stringify({ notifications }),
    }),
  testNotifications: (notifications: Settings['notifications']) => request<{ discord: string }>('/settings/notifications/test', {
    method: 'PUT',
    body: JSON.stringify({ notifications }),
  }),
  savePollInterval: (hours: number) =>
    request<{ ok: boolean }>('/settings/poll-interval', { method: 'PUT', body: JSON.stringify({ hours }) }),
  saveWatchedSearchInterval: (minutes: number) =>
    request<{ ok: boolean }>('/settings/watched-search-interval', { method: 'PUT', body: JSON.stringify({ minutes }) }),

  enqueue: (type: string, payload: Record<string, unknown> = {}) =>
    request<{ id: number }>('/jobs', { method: 'POST', body: JSON.stringify({ type, ...payload }) }),
  jobs: () => request<Job[]>('/jobs'),
  job: (id: number) => request<{ job: Job; logs: JobLog[] }>(`/jobs/${id}`),
  cancelJob: (id: number) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: number) => request<{ ok: boolean; id: number }>(`/jobs/${id}/retry`, { method: 'POST' }),
  removeFailedJob: (id: number) => request<{ removed: number }>(`/jobs/${id}`, { method: 'DELETE' }),
  clearFailedJobs: () => request<{ removed: number }>('/jobs/failed', { method: 'DELETE' }),
  logs: () => request<JobLog[]>('/logs'),

  // ---------------- Doujinshi downloader ----------------
  downloaderSettings: () => request<DownloaderSettings>('/settings/downloader'),
  saveDownloaderSettings: ({ libraryPathMappings: _mappings, ...settings }: DownloaderSettings) =>
    request<{ ok: boolean; settings: DownloaderSettings }>('/settings/downloader', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  saveLibraryPathMappings: (libraryPathMappings: LibraryPathMapping[]) =>
    request<{ libraryPathMappings: LibraryPathMapping[] }>('/settings/library-path-mappings', {
      method: 'PUT',
      body: JSON.stringify({ libraryPathMappings }),
    }),
  doujinProviders: () => request<DoujinProvider[]>('/doujin/providers'),
  doujinSearch: (source: DoujinSource, query: string, sort?: DoujinSort) =>
    request<DoujinSearchResult[]>('/doujin/search', {
      method: 'POST',
      body: JSON.stringify({ source, query, ...(sort && sort !== 'default' ? { sort } : {}) }),
    }),
  doujinSuggestions: (source: DoujinSource, query: string) =>
    request<DoujinSuggestion[]>('/doujin/suggestions', {
      method: 'POST',
      body: JSON.stringify({ source, query }),
    }),
  doujinGallery: (source: DoujinSource, idOrUrl: string) =>
    request<DoujinGallery>('/doujin/gallery', {
      method: 'POST',
      body: JSON.stringify({ source, idOrUrl }),
    }),
  startDownload: (body: { source: DoujinSource; galleryId: string; title?: string; format?: 'cbz' | 'folder'; mergeFolder?: string; chapter?: number }) =>
    request<{ id: number; status: string }>('/downloads', { method: 'POST', body: JSON.stringify(body) }),
  downloads: () => request<DownloadTask[]>('/downloads'),
  /** Completed galleries for the duplicate-download badges. */
  downloadsCompleted: () => request<DownloadedGallery[]>('/downloads/completed'),
  /** .cbz files on disk for a gallery (completed task first, per-gallery folder as fallback). */
  galleryFiles: (source: DoujinSource, galleryId: string, title: string) =>
    request<{ files: string[] }>(`/downloads/gallery-files?source=${encodeURIComponent(source)}&galleryId=${encodeURIComponent(galleryId)}&title=${encodeURIComponent(title)}`),
  download: (id: number) => request<DownloadTask>(`/downloads/${id}`),
  downloadAction: (id: number, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    request<{ ok: boolean }>(`/downloads/${id}/${action}`, { method: 'POST' }),
  deleteDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}`, { method: 'DELETE' }),
  clearCompletedDownloads: () => request<{ ok: boolean; removed: number }>('/downloads/clear-completed', { method: 'POST' }),

  // ---------------- ComicInfo editor ----------------
  /** Browse roots for the file picker (download dir + Kavita library paths). */
  cbzRoots: () => request<{ roots: string[] }>('/cbz/roots'),
  /** List a directory's subdirectories and .cbz files. */
  cbzBrowse: (dir: string) =>
    request<{ path: string; parent: string | null; dirs: string[]; files: string[] }>(`/cbz/browse?path=${encodeURIComponent(dir)}`),
  /** Read + parse the ComicInfo.xml embedded in a .cbz. */
  cbzComicInfo: (file: string) =>
    request<{ path: string; hasEntry: boolean; fields: Record<string, string>; order: string[]; raw: string | null }>(
      `/cbz/comicinfo?path=${encodeURIComponent(file)}`,
    ),
  /** .cbz archives on disk for a Kavita series (resolved host-side). */
  cbzSeriesFiles: (seriesId: number) =>
    request<{ seriesId: number; name: string; dir: string | null; reason: string | null; files: string[]; chapterNumbers: Record<string, string> }>(`/cbz/series/${seriesId}`),
  /** Image entries (pages) of a .cbz, in reading order. */
  cbzImages: (file: string) =>
    request<{ path: string; images: string[] }>(`/cbz/images?path=${encodeURIComponent(file)}`),
  /** Same-origin URL serving one page image from a .cbz. */
  cbzPageUrl: (file: string, name: string) => `/api/cbz/page?path=${encodeURIComponent(file)}&name=${encodeURIComponent(name)}`,
};
