// Typed client for the H-Tosho REST API.

export interface KavitaConnection {
  baseUrl: string;
  apiKey: string;
}

export interface KavitaLibrary {
  id: number;
  name: string;
  path?: string;
  mediaFormat?: string;
  monitor?: boolean;
  seriesCount?: number;
  matchedCount?: number;
}

export interface SeriesRow {
  id: number;
  name: string;
  slug?: string;
  bookCount?: number;
  cover?: string | null;
  status: string;
  providerId?: string | null;
  matchScore?: number | null;
  lastSyncedAt?: string | null;
  errorMessage?: string | null;
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
  sortName?: string;
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
}

export interface Settings {
  priorities: string[];
  aggregation: { mergeTags: boolean; mergeGenres: boolean; replaceCover: boolean; replaceVolumeCovers: boolean; lockCovers: boolean };
  fieldConfig: Record<string, string | null>;
  fields: string[];
  notifications: {
    discord: { enabled: boolean; webhookUrl: string };
    apprise: { enabled: boolean; url: string };
  };
  pollInterval: number;
}

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  progressCurrent: number;
  progressTotal: number;
  /** Arbitrary JSON summary stored by the job executor (often an object). */
  result: unknown;
  errorMessage: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface JobLog {
  id: number;
  jobId: number;
  level: string;
  message: string;
  createdAt: string;
}

export interface Stats {
  totalSeries: number;
  byStatus: Record<string, number>;
  activeJobs: number;
  recentJobs: Job[];
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
  sortTitle?: string;
  type: string;
  year?: number;
  releaseDate?: string;
  summary?: string;
  coverUrl?: string;
  genres: string[];
  tags: string[];
  writers: string[];
  artists: string[];
  publishers: string[];
  imprints: string[];
  ageRating?: number;
  rating?: number;
  language?: string;
  status?: string;
  url?: string;
}

export interface MatchOutcome {
  matched: boolean;
  best?: {
    providerId: string;
    providerSeriesId: string;
    score: number;
    title: string;
  };
  candidates: SearchResult[];
}

// ---------------- Doujinshi downloader types ----------------

export type DoujinSource = 'hitomi' | 'nhentai';

/** Result ordering for a source search (only nHentai supports popularity sorts). */
export type DoujinSort = 'default' | 'popular' | 'popular-week' | 'popular-today';

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
  /** Group/circle names (Hitomi). */
  groups?: string[];
  /** Characters / genres (Hitomi maps characters here). */
  genres?: string[];
  pageCount: number;
  url?: string;
  /** When the gallery was uploaded/published (ISO 8601 date string). */
  uploadedAt?: string | null;
}

export interface DownloaderSettings {
  downloadDirectory: string;
  format: 'cbz' | 'folder';
  maxConcurrentDownloads: number;
  maxImageConcurrency: number;
  requestDelayMs: number;
  autoSyncKavita: boolean;
  nhentaiApiKey: string;
  /** Tag names to exclude from all nHentai searches (e.g. "loli", "big breasts"). */
  nhentaiBannedTags: string[];
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
  | { type: 'task'; task: DownloadTask };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  kavitaStatus: () => request<{
    configured: boolean;
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
    request<{ libraryId: number; priority: string[]; autoMatch: boolean; fieldConfig: Record<string, string | null> }>(`/libraries/${id}/override`),
  saveLibraryOverride: (id: number, patch: Partial<Omit<{ priority: string[]; autoMatch: boolean; fieldConfig: Record<string, string | null> }, 'libraryId'>>) =>
    request<{ ok: boolean }>(`/libraries/${id}/override`, { method: 'PUT', body: JSON.stringify(patch) }),

  series: (id: number) =>
    request<{
      series: KavitaSeriesView;
      match: Record<string, unknown> | null;
      metadata: SeriesMetadata | null;
      kavita: KavitaSeriesMetadata | null;
    }>(`/series/${id}`),
  identify: (id: number) => request<MatchOutcome>(`/series/${id}/identify`),
  apply: (id: number, providerId: string, providerSeriesId: string) =>
    request<{ pushed: string[]; errors: string[] }>(`/series/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ providerId, providerSeriesId }),
    }),

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
  saveAggregation: (aggregation: Settings['aggregation']) =>
    request<{ ok: boolean }>('/settings/aggregation', { method: 'PUT', body: JSON.stringify({ aggregation }) }),
  saveNotifications: (notifications: Settings['notifications']) =>
    request<{ ok: boolean }>('/settings/notifications', {
      method: 'PUT',
      body: JSON.stringify({ notifications }),
    }),
  testNotifications: () => request<{ discord: string; apprise: string }>('/settings/notifications/test', {
    method: 'PUT',
  }),
  savePollInterval: (minutes: number) =>
    request<{ ok: boolean }>('/settings/poll-interval', { method: 'PUT', body: JSON.stringify({ minutes }) }),

  enqueue: (type: string, payload: Record<string, unknown> = {}) =>
    request<{ id: number }>('/jobs', { method: 'POST', body: JSON.stringify({ type, ...payload }) }),
  jobs: () => request<Job[]>('/jobs'),
  job: (id: number) => request<{ job: Job; logs: JobLog[] }>(`/jobs/${id}`),
  cancelJob: (id: number) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  logs: () => request<JobLog[]>('/logs'),
  stats: () => request<Stats>('/stats'),

  // ---------------- Doujinshi downloader ----------------
  downloaderSettings: () => request<DownloaderSettings>('/settings/downloader'),
  saveDownloaderSettings: (s: DownloaderSettings) =>
    request<{ ok: boolean; settings: DownloaderSettings }>('/settings/downloader', {
      method: 'PUT',
      body: JSON.stringify(s),
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
  startDownload: (body: { source: DoujinSource; galleryId: string; title?: string; format?: 'cbz' | 'folder' }) =>
    request<{ id: number; status: string }>('/downloads', { method: 'POST', body: JSON.stringify(body) }),
  downloads: () => request<DownloadTask[]>('/downloads'),
  download: (id: number) => request<DownloadTask>(`/downloads/${id}`),
  downloadAction: (id: number, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    request<{ ok: boolean }>(`/downloads/${id}/${action}`, { method: 'POST' }),
  deleteDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}`, { method: 'DELETE' }),
  clearCompletedDownloads: () => request<{ ok: boolean; removed: number }>('/downloads/clear-completed', { method: 'POST' }),
};
