/**
 * Kavita v0.9.0.22 REST API DTOs used by H-Tosho.
 * Source: https://raw.githubusercontent.com/Kareadita/Kavita/develop/openapi.json
 *
 * Keep the wire DTOs separate from H-Tosho's normalized view. Kavita's
 * metadata update endpoint expects a complete SeriesMetadataDto, so the
 * client reads the current DTO and merges our patch before writing it back.
 */

/** Minimum Kavita *server* version H-Tosho can talk to (the v0.9 REST API). */
export const KAVITA_MIN_SERVER_VERSION = "0.9.0";

/** Reference OpenAPI contract the DTOs were generated from (not a server version). */
export const KAVITA_OPENAPI_VERSION = "0.9.0.22";

export enum KavitaLibraryType {
  Manga = 0,
  Comic = 1,
  Book = 2,
  Image = 3,
  LightNovel = 4,
  ComicVine = 5,
}

export enum KavitaPublicationStatus {
  Ongoing = 0,
  Hiatus = 1,
  Completed = 2,
  Cancelled = 3,
  Ended = 4,
}

export enum KavitaAgeRating {
  NotApplicable = -1,
  Unknown = 0,
  RatingPending = 1,
  EarlyChildhood = 2,
  Everyone = 3,
  G = 4,
  Everyone10Plus = 5,
  PG = 6,
  KidsToAdults = 7,
  Teen = 8,
  Mature15Plus = 9,
  Mature17Plus = 10,
  Mature = 11,
  R18Plus = 12,
  AdultsOnly = 13,
  X18Plus = 14,
}

export interface KavitaServerInfoDto {
  kavitaVersion: string;
  installId?: string | null;
  isDocker?: boolean;
  firstInstallDate?: string | null;
  firstInstallVersion?: string | null;
}

export interface KavitaUserDto {
  id: number;
  username?: string | null;
  roles?: string[] | null;
}

export interface KavitaLibraryDto {
  id: number;
  name?: string | null;
  type: KavitaLibraryType;
  folders?: string[] | null;
  folderWatching?: boolean;
  lastScanned?: string;
}

export interface KavitaSeriesDto {
  id: number;
  libraryId: number;
  libraryName?: string | null;
  name?: string | null;
  originalName?: string | null;
  localizedName?: string | null;
  sortName?: string | null;
  pages?: number;
  pagesRead?: number;
  coverImage?: string | null;
  coverImageLocked?: boolean;
  lastChapterAdded?: string;
  lastChapterAddedUtc?: string;
  /** When the series was added to Kavita (series creation date). */
  created?: string;
  totalReads?: number;
  userRating?: number;
  hasUserRated?: boolean;
  nameLocked?: boolean;
  sortNameLocked?: boolean;
  localizedNameLocked?: boolean;
  metadataProviderOverride?: number | null;
  aniListId?: number | null;
  malId?: number | null;
  hardcoverId?: number | null;
  metronId?: number | null;
  comicVineId?: string | null;
  mangaBakaId?: number | null;
  cbrId?: number | null;
  /** Series folder as seen by Kavita (container path under Docker). */
  folderPath?: string | null;
}

export interface KavitaTagDto {
  id: number;
  title: string | null;
}

export interface KavitaPersonDto {
  id: number;
  name: string | null;
  coverImageLocked?: boolean;
}

/** A single file inside a Kavita chapter (book). */
export interface KavitaChapterFileDto {
  id?: number;
  filePath?: string | null;
}

/** One book of a series as returned by /api/Search/chapters-by-series. */
export interface KavitaChapterDto {
  id: number;
  /** Chapter number Kavita parsed for this book (e.g. "3", "4.5"). */
  number?: string | null;
  files?: KavitaChapterFileDto[] | null;
}

export interface KavitaSeriesMetadataDto {
  id: number;
  seriesId: number;
  summary: string | null;
  genres: KavitaTagDto[] | null;
  tags: KavitaTagDto[] | null;
  writers: KavitaPersonDto[] | null;
  coverArtists: KavitaPersonDto[] | null;
  publishers: KavitaPersonDto[] | null;
  characters: KavitaPersonDto[] | null;
  pencillers: KavitaPersonDto[] | null;
  inkers: KavitaPersonDto[] | null;
  imprints: KavitaPersonDto[] | null;
  colorists: KavitaPersonDto[] | null;
  letterers: KavitaPersonDto[] | null;
  editors: KavitaPersonDto[] | null;
  translators: KavitaPersonDto[] | null;
  teams: KavitaPersonDto[] | null;
  locations: KavitaPersonDto[] | null;
  ageRating: KavitaAgeRating;
  releaseYear: number;
  language: string | null;
  maxCount: number;
  totalCount: number;
  publicationStatus: KavitaPublicationStatus;
  webLinks: string | null;
  languageLocked: boolean;
  summaryLocked: boolean;
  ageRatingLocked: boolean;
  publicationStatusLocked: boolean;
  genresLocked: boolean;
  tagsLocked: boolean;
  writerLocked: boolean;
  characterLocked: boolean;
  coloristLocked: boolean;
  editorLocked: boolean;
  inkerLocked: boolean;
  imprintLocked: boolean;
  lettererLocked: boolean;
  pencillerLocked: boolean;
  publisherLocked: boolean;
  translatorLocked: boolean;
  teamLocked: boolean;
  locationLocked: boolean;
  coverArtistLocked: boolean;
  releaseYearLocked: boolean;
}

export interface KavitaUpdateSeriesDto {
  id: number;
  name: string | null;
  localizedName: string | null;
  sortName: string | null;
  coverImageLocked: boolean;
  nameLocked: boolean;
  sortNameLocked: boolean;
  localizedNameLocked: boolean;
  metadataProviderOverride: number | null;
  aniListId: number | null;
  malId: number | null;
  hardcoverId: number | null;
  metronId: number | null;
  comicVineId: string | null;
  mangaBakaId: number | null;
  cbrId: number | null;
}

export interface KavitaUpdateSeriesMetadataDto {
  seriesMetadata: KavitaSeriesMetadataDto;
}

/**
 * Body for POST /api/Upload/series. `url` carries the base64-encoded image —
 * the payload shape accepted across Kavita v0.9 builds (newer builds also
 * accept a staged temp `fileName`, but base64 works everywhere, including
 * 0.9.0.x servers that lack /Upload/upload-by-file).
 */
export interface KavitaUploadCoverFileDto {
  id: number;
  url: string;
  lockCover: boolean;
}

export type MediaFormat = "manga" | "comic" | "book" | "image" | "other";

export interface KavitaServerInfo {
  version: string;
  installId?: string;
  isDocker?: boolean;
  firstInstallDate?: string;
  firstInstallVersion?: string;
}

export interface KavitaLibrary {
  id: number;
  name: string;
  path?: string;
  paths?: string[];
  monitor: boolean;
  mediaFormat: MediaFormat;
  lastModified?: string;
}

export interface KavitaSeries {
  id: number;
  libraryId: number;
  name: string;
  slug: string;
  bookCount: number;
  /** Total page count across the series' chapters, as tracked by Kavita. */
  pages?: number;
  pagesRead?: number;
  totalReads?: number;
  userRating?: number;
  hasUserRated?: boolean;
  totalChapterCount?: number;
  lastAdded?: string;
  /** When the series was added to Kavita (series creation date). */
  created?: string;
  cover?: string;
  /** Series folder as seen by Kavita (container path under Docker). */
  folderPath?: string;
}
/** Volume as returned by GET /api/Series/volumes (only consumed fields). */
export interface KavitaVolumeDto {
  id: number;
  /** Volume number (or range start); e.g. 3 for "Vol. 3". */
  minNumber?: number;
  maxNumber?: number;
  name?: string | null;
  /** @deprecated int volume number, kept as fallback for older servers. */
  number?: number;
}

/** H-Tosho's mapped volume model. */
export interface KavitaVolume {
  id: number;
  name?: string | null;
  minNumber?: number;
  maxNumber?: number;
  /** Effective volume number (minNumber, falling back to the deprecated field). */
  number?: number;
}

export interface KavitaCoverImage {
  data: Buffer;
  contentType: string;
}
export interface KavitaVolumeCoverDto {
  id: number;
  seriesId: number;
  name: string | null;
  coverImage: string | null;
  coverImageLocked?: boolean;
  createdUtc: string;
  chapters: { id: number; files: { id?: number; filePath: string }[] }[];
}

export function parseVolumeCoverDto(value: unknown): KavitaVolumeCoverDto {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !("seriesId" in value) ||
    typeof value.seriesId !== "number" ||
    !Number.isSafeInteger(value.seriesId) ||
    value.seriesId <= 0 ||
    !("createdUtc" in value) ||
    typeof value.createdUtc !== "string" ||
    !Number.isFinite(Date.parse(value.createdUtc)) ||
    !("coverImage" in value) ||
    (value.coverImage !== null && typeof value.coverImage !== "string") ||
    !("chapters" in value) ||
    !Array.isArray(value.chapters) ||
    value.chapters.length > 2000 ||
    ("coverImageLocked" in value &&
      value.coverImageLocked !== undefined &&
      typeof value.coverImageLocked !== "boolean") ||
    ("name" in value &&
      value.name !== null &&
      value.name !== undefined &&
      typeof value.name !== "string")
  )
    throw new Error("Kavita volume-cover identity is unavailable or malformed");
  const chapters: KavitaVolumeCoverDto["chapters"] = [];
  let fileCount = 0;
  for (const chapter of value.chapters as unknown[]) {
    if (
      !chapter ||
      typeof chapter !== "object" ||
      Array.isArray(chapter) ||
      !("id" in chapter) ||
      typeof chapter.id !== "number" ||
      !Number.isSafeInteger(chapter.id) ||
      chapter.id <= 0 ||
      !("files" in chapter) ||
      !Array.isArray(chapter.files)
    )
      throw new Error("Kavita volume chapter identity is malformed");
    const files: { id?: number; filePath: string }[] = [];
    for (const file of chapter.files as unknown[]) {
      if (
        ++fileCount > 10000 ||
        !file ||
        typeof file !== "object" ||
        Array.isArray(file) ||
        !("filePath" in file) ||
        typeof file.filePath !== "string" ||
        !file.filePath ||
        ("id" in file &&
          file.id !== undefined &&
          (typeof file.id !== "number" ||
            !Number.isSafeInteger(file.id) ||
            file.id < 0))
      )
        throw new Error(
          "Kavita volume file identity is malformed or exceeds the cover identity budget"
        );
      files.push({
        filePath: file.filePath,
        ...("id" in file && typeof file.id === "number" ? { id: file.id } : {}),
      });
    }
    chapters.push({ id: chapter.id, files });
  }
  return {
    id: value.id,
    seriesId: value.seriesId,
    createdUtc: value.createdUtc,
    coverImage: value.coverImage,
    name: "name" in value && typeof value.name === "string" ? value.name : null,
    ...("coverImageLocked" in value &&
    typeof value.coverImageLocked === "boolean"
      ? { coverImageLocked: value.coverImageLocked }
      : {}),
    chapters,
  };
}

/** H-Tosho's patch model; the client merges it into Kavita's current DTOs. */
export interface SeriesMetadataPayload {
  name?: string;
  summary?: string;
  genres?: string[];
  tags?: string[];
  writers?: string[];
  artists?: string[];
  releaseYear?: number;
  language?: string;
  publicationStatus?: KavitaPublicationStatus;
  webLinks?: string;
}
