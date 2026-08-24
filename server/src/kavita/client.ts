import { fetchBuffer, fetchJson } from '../lib/http.js';
import {
  KAVITA_MIN_SERVER_VERSION,
  KavitaLibraryType,
  type KavitaLibrary,
  type KavitaLibraryDto,
  type KavitaPersonDto,
  type KavitaSeries,
  type KavitaSeriesDto,
  type KavitaVolume,
  type KavitaVolumeDto,
  type KavitaSeriesMetadataDto,
  type KavitaServerInfo,
  type KavitaServerInfoDto,
  type KavitaTagDto,
  type KavitaUpdateSeriesDto,
  type KavitaUpdateSeriesMetadataDto,
  type KavitaUploadCoverFileDto,
  type KavitaUserDto,
  type MediaFormat,
  type SeriesMetadataPayload,
} from './types.js';

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = (actual.match(/\d+/g) ?? []).map(Number);
  const minimumParts = (minimum.match(/\d+/g) ?? []).map(Number);
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index++) {
    const delta = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

const LIBRARY_MEDIA_FORMATS: Record<KavitaLibraryType, MediaFormat> = {
  [KavitaLibraryType.Manga]: 'manga',
  [KavitaLibraryType.Comic]: 'comic',
  [KavitaLibraryType.Book]: 'book',
  [KavitaLibraryType.Image]: 'image',
  [KavitaLibraryType.LightNovel]: 'book',
  [KavitaLibraryType.ComicVine]: 'comic',
};

/** Options for updateSeriesMetadata. */
export interface UpdateMetadataOptions {
  /** When false, pushed fields are written without setting Kavita's field-lock flags. */
  lockMetadata?: boolean;
}

/** Thin typed wrapper over the Kavita v0.9.0.22 REST API. */
export class KavitaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
    this.apiKey = apiKey.trim();
  }

  private get headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, Accept: 'application/json' };
  }

  private url(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  private requestError(action: string, path: string, status: number, data?: unknown): Error {
    const detail =
      typeof data === 'string'
        ? data.trim()
        : data && typeof data === 'object'
          ? JSON.stringify(data)
          : '';
    const hint =
      status === 401 || status === 403
        ? ' Check that the Kavita Auth Key is valid and belongs to an admin user.'
        : status === 404
          ? ' Check that the Base URL points to the Kavita server root (do not include /api).'
          : '';
    // Strip any query string before displaying: image endpoints carry the API
    // key as ?apiKey= and must never leak it into error messages.
    const displayUrl = `${this.baseUrl}/api${path.split('?')[0]}`;
    return new Error(
      `${action} failed at ${displayUrl}: HTTP ${status}${detail ? ` - ${detail}` : ''}.${hint}`,
    );
  }

  private async getJson<T>(path: string, action: string): Promise<T> {
    const res = await fetchJson<T>(this.url(path), { headers: this.headers }, 15_000, { raw: true });
    if (res.status !== 200) throw this.requestError(action, path, res.status, res.data);
    return res.data;
  }

  private async postJson<T = unknown>(path: string, body: unknown, action: string): Promise<T> {
    const res = await fetchJson<T>(this.url(path), {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15_000, { raw: true });
    if (res.status < 200 || res.status >= 300) {
      throw this.requestError(action, path, res.status, res.data);
    }
    return res.data;
  }

  /** GET /api/Server/server-info-slim */
  async getServerInfo(): Promise<KavitaServerInfo> {
    const path = '/Server/server-info-slim';
    const data = await this.getJson<KavitaServerInfoDto>(path, 'Kavita server info');
    if (!data?.kavitaVersion) {
      throw new Error(`Kavita server info at ${this.url(path)} did not include kavitaVersion.`);
    }
    return {
      version: data.kavitaVersion,
      installId: data.installId ?? undefined,
      isDocker: data.isDocker,
      firstInstallDate: data.firstInstallDate ?? undefined,
      firstInstallVersion: data.firstInstallVersion ?? undefined,
    };
  }

  /** GET /api/Account */
  async getCurrentUser(): Promise<KavitaUserDto> {
    return this.getJson<KavitaUserDto>('/Account', 'Kavita account');
  }

  /** Validate reachability, the Auth Key, and the admin access needed for writes. */
  async testConnection(): Promise<KavitaServerInfo> {
    const info = await this.getServerInfo();
    if (!isVersionAtLeast(info.version, KAVITA_MIN_SERVER_VERSION)) {
      throw new Error(
        `Kavita ${info.version} is not supported. H-Tosho requires Kavita ${KAVITA_MIN_SERVER_VERSION} or newer.`,
      );
    }
    const user = await this.getCurrentUser();
    if (!user.roles?.some((role) => role.toLowerCase() === 'admin')) {
      throw new Error('The Kavita Auth Key is valid, but H-Tosho requires an admin user to update metadata and covers.');
    }
    return info;
  }

  /** GET /api/Library/libraries */
  async getLibraries(): Promise<KavitaLibrary[]> {
    const libraries = await this.getJson<KavitaLibraryDto[]>('/Library/libraries', 'Get libraries');
    return libraries.map((library) => ({
      id: library.id,
      name: library.name?.trim() || `Library ${library.id}`,
      path: library.folders?.[0] ?? undefined,
      monitor: library.folderWatching ?? false,
      mediaFormat: LIBRARY_MEDIA_FORMATS[library.type] ?? 'other',
      lastModified: library.lastScanned,
    }));
  }

  /** POST /api/Series/all-v2, filtered to one library. */
  async getSeries(libraryId: number): Promise<KavitaSeries[]> {
    const path = '/Series/all-v2?PageNumber=1&PageSize=0';
    const series = await this.postJson<KavitaSeriesDto[]>(
      path,
      {
        statements: [{ comparison: 5, field: 19, value: String(libraryId) }],
        combination: 0,
        entityType: 0,
        limitTo: 0,
      },
      'Get series',
    );
    return series.map((item) => this.mapSeries(item));
  }

  private mapSeries(series: KavitaSeriesDto): KavitaSeries {
    return {
      id: series.id,
      libraryId: series.libraryId,
      name: series.name?.trim() || `Series ${series.id}`,
      sortName: series.sortName ?? undefined,
      slug: String(series.id),
      bookCount: 0,
      totalChapterCount: 0,
      lastAdded: series.lastChapterAddedUtc ?? series.lastChapterAdded,
      // The filename is not a public URL; its presence enables our proxy.
      cover: series.coverImage ?? undefined,
      folderPath: series.folderPath ?? undefined,
    };
  }

  /** GET /api/Series/{seriesId} */
  async getSeriesById(seriesId: number): Promise<KavitaSeries> {
    return this.mapSeries(await this.getSeriesDto(seriesId));
  }

  private async getSeriesDto(seriesId: number): Promise<KavitaSeriesDto> {
    return this.getJson<KavitaSeriesDto>(`/Series/${seriesId}`, `Get series ${seriesId}`);
  }

  /** GET /api/Series/metadata?seriesId={seriesId} */
  async getSeriesMetadata(seriesId: number): Promise<KavitaSeriesMetadataDto> {
    return this.getJson<KavitaSeriesMetadataDto>(
      `/Series/metadata?seriesId=${encodeURIComponent(seriesId)}`,
      `Get series ${seriesId} metadata`,
    );
  }

  /** Read, merge, and write using Kavita's split v0.9 update endpoints. */
  async updateSeriesMetadata(seriesId: number, patch: SeriesMetadataPayload, opts: UpdateMetadataOptions = {}): Promise<void> {
    const lock = opts.lockMetadata !== false;
    if (patch.name !== undefined || patch.sortName !== undefined) {
      const current = await this.getSeriesDto(seriesId);
      const update: KavitaUpdateSeriesDto = {
        id: seriesId,
        name: patch.name ?? current.name ?? null,
        localizedName: current.localizedName ?? null,
        sortName: patch.sortName ?? current.sortName ?? null,
        coverImageLocked: current.coverImageLocked ?? false,
        nameLocked: patch.name !== undefined && lock ? true : (current.nameLocked ?? false),
        sortNameLocked: patch.sortName !== undefined && lock ? true : (current.sortNameLocked ?? false),
        localizedNameLocked: current.localizedNameLocked ?? false,
        metadataProviderOverride: current.metadataProviderOverride ?? null,
        aniListId: current.aniListId ?? null,
        malId: current.malId ?? null,
        hardcoverId: current.hardcoverId ?? null,
        metronId: current.metronId ?? null,
        comicVineId: current.comicVineId ?? null,
        mangaBakaId: current.mangaBakaId ?? null,
        cbrId: current.cbrId ?? null,
      };
      await this.postJson('/Series/update', update, `Update series ${seriesId}`);
    }

    if (this.hasMetadataPatch(patch)) {
      const metadata = this.normalizeMetadata(await this.getSeriesMetadata(seriesId), seriesId);
      this.mergeMetadataPatch(metadata, patch, lock);
      const body: KavitaUpdateSeriesMetadataDto = { seriesMetadata: metadata };
      await this.postJson('/Series/metadata', body, `Update series ${seriesId} metadata`);
    }
  }

  private hasMetadataPatch(patch: SeriesMetadataPayload): boolean {
    return [
      patch.summary,
      patch.genres,
      patch.tags,
      patch.writers,
      patch.artists,
      patch.releaseYear,
      patch.language,
      patch.publicationStatus,
      patch.webLinks,
    ].some((value) => value !== undefined);
  }

  private normalizeMetadata(metadata: KavitaSeriesMetadataDto, seriesId: number): KavitaSeriesMetadataDto {
    return {
      ...metadata,
      id: metadata.id ?? 0,
      seriesId,
      summary: metadata.summary ?? '',
      language: metadata.language ?? '',
      webLinks: metadata.webLinks ?? '',
      genres: metadata.genres ?? [],
      tags: metadata.tags ?? [],
      writers: metadata.writers ?? [],
      coverArtists: metadata.coverArtists ?? [],
      publishers: metadata.publishers ?? [],
      characters: metadata.characters ?? [],
      pencillers: metadata.pencillers ?? [],
      inkers: metadata.inkers ?? [],
      imprints: metadata.imprints ?? [],
      colorists: metadata.colorists ?? [],
      letterers: metadata.letterers ?? [],
      editors: metadata.editors ?? [],
      translators: metadata.translators ?? [],
      teams: metadata.teams ?? [],
      locations: metadata.locations ?? [],
    };
  }

  private mergeMetadataPatch(metadata: KavitaSeriesMetadataDto, patch: SeriesMetadataPayload, lock = true): void {
    const tags = (values: string[]): KavitaTagDto[] => values.map((title) => ({ id: 0, title }));
    const people = (values: string[]): KavitaPersonDto[] => values.map((name) => ({ id: 0, name }));

    if (patch.summary !== undefined) {
      metadata.summary = patch.summary;
      if (lock) metadata.summaryLocked = true;
    }
    if (patch.genres !== undefined) {
      metadata.genres = tags(patch.genres);
      if (lock) metadata.genresLocked = true;
    }
    if (patch.tags !== undefined) {
      metadata.tags = tags(patch.tags);
      if (lock) metadata.tagsLocked = true;
    }
    if (patch.writers !== undefined) {
      metadata.writers = people(patch.writers);
      if (lock) metadata.writerLocked = true;
    }
    if (patch.artists !== undefined) {
      // The unified provider model has one generic artist role. Penciller is
      // Kavita's closest series-level equivalent and remains independently
      // editable from cover artist, inker, and colorist roles.
      metadata.pencillers = people(patch.artists);
      if (lock) metadata.pencillerLocked = true;
    }
    if (patch.releaseYear !== undefined) {
      metadata.releaseYear = patch.releaseYear;
      if (lock) metadata.releaseYearLocked = true;
    }
    if (patch.language !== undefined) {
      metadata.language = patch.language;
      if (lock) metadata.languageLocked = true;
    }
    if (patch.publicationStatus !== undefined) {
      metadata.publicationStatus = patch.publicationStatus;
      if (lock) metadata.publicationStatusLocked = true;
    }
    if (patch.webLinks !== undefined) metadata.webLinks = patch.webLinks;
  }

  /**
   * POST /api/Upload/series with a base64 image payload. This is the cover
   * replacement shape accepted across Kavita v0.9 builds; newer versions also
   * support staging via /Upload/upload-by-file, but that endpoint does not
   * exist on 0.9.0.x servers (it 404s), so we always send the payload inline.
   */
  async updateSeriesCover(seriesId: number, image: Buffer, lockCover: boolean): Promise<void> {
    const body: KavitaUploadCoverFileDto = { id: seriesId, url: image.toString('base64'), lockCover };
    await this.postJson('/Upload/series', body, `Update series ${seriesId} cover`);
  }

  /** GET /api/Series/volumes?seriesId={seriesId} */
  async getVolumes(seriesId: number): Promise<KavitaVolume[]> {
    const path = `/Series/volumes?seriesId=${encodeURIComponent(seriesId)}`;
    const volumes = await this.getJson<KavitaVolumeDto[]>(path, `Get series ${seriesId} volumes`);
    return (volumes ?? []).map((volume) => ({
      id: volume.id,
      name: volume.name ?? undefined,
      minNumber: volume.minNumber,
      maxNumber: volume.maxNumber,
      number: Number.isFinite(volume.minNumber) ? volume.minNumber : volume.number,
    }));
  }

  /** POST /api/Upload/volume — same base64 payload shape as the series cover endpoint. */
  async updateVolumeCover(volumeId: number, image: Buffer, lockCover: boolean): Promise<void> {
    const body: KavitaUploadCoverFileDto = { id: volumeId, url: image.toString('base64'), lockCover };
    await this.postJson('/Upload/volume', body, `Update volume ${volumeId} cover`);
  }

  /**
   * GET /api/Image/series-cover?seriesId={seriesId}&apiKey={key}
   *
   * Kavita's image endpoints (unlike JSON endpoints) require the API key to be
   * passed as a `?apiKey=` query parameter; sending it only via the `x-api-key`
   * header is rejected with HTTP 400 ("The apiKey field is required.").
   */
  async getSeriesCover(seriesId: number): Promise<{ data: Buffer; contentType: string }> {
    const path = `/Image/series-cover?seriesId=${encodeURIComponent(seriesId)}&apiKey=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(this.url(path), {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw this.requestError(`Get series ${seriesId} cover`, path, response.status);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async downloadImage(url: string): Promise<Buffer> {
    return fetchBuffer(url, { headers: { 'User-Agent': 'H-Tosho/1.0' } });
  }

  /** POST /api/Library/scan?libraryId={id} - rescan a single library for new media. */
  async scanLibrary(libraryId: number): Promise<void> {
    await this.postJson(`/Library/scan?libraryId=${encodeURIComponent(libraryId)}`, {}, `Scan library ${libraryId}`);
  }

  /** POST /api/Library/scan-all - rescan all libraries for new media. */
  async scanAllLibraries(): Promise<void> {
    await this.postJson('/Library/scan-all', {}, 'Scan all libraries');
  }
}

export function createKavitaClient(baseUrl: string, apiKey: string): KavitaClient {
  return new KavitaClient(baseUrl, apiKey);
}