import type { DoujinSource } from '../downloader/types.js';
import type { RestoreMetadataCommand } from './metadataRestore.js';
/** Types of background jobs the queue can run. */
export const JOB_TYPES = [
  'scan-new',
  'scan-matchable',
  'scan-downloaded',
  'match-unmatched',
  'match-library',
  'match-series',
  'sync-series',
  'apply-series',
  'restore-metadata',
  'clear-overrides',
  'check-watched-searches',
  'edit-comicinfo',
  'merge-series',
  'delete-series',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && JOB_TYPES.some((type) => type === value);
}

export interface JobContext {
  series: { id: number; name: string }[];
  libraryId?: number;
  libraryName?: string;
}

export interface SeriesTargets { libraryId?: number; seriesId?: number; seriesIds?: number[] }
export interface DownloadDiscoveryCommand { path: string; connectionKey: string; seriesName?: string }
export interface ApplySeriesCommand {
  seriesId: number; providerId: string; providerSeriesId: string; selectedTitle?: string;
  excludedFields?: string[]; cover?: boolean; score?: number;
}
export interface EditComicInfoCommand { path: string; seriesId?: number; xml?: string; fields?: Record<string, string> }
export interface MergeSeriesCommand {
  seriesId?: number; targetDir?: string; sourceFiles?: string[]; chapters?: Record<string, string>;
  existingChapters?: Record<string, string>;
  /** Optional Series metadata and Kavita display name; the target folder is retained. */
  seriesName?: string;
  downloads?: { source: DoujinSource; galleryId: string; title: string; chapter: string; allowDuplicate?: boolean }[];
}
export interface JobExecutionState {
  context?: JobContext;
  contextPendingSeriesIds?: number[];
  mergeDownloadIds?: Record<string, number>;
  sourceFiles?: string[];
  chapters?: Record<string, string>;
}
/** Read-only transport projection for legacy history and shared target resolution. */
export type JobPayload = Partial<SeriesTargets & ApplySeriesCommand & EditComicInfoCommand & MergeSeriesCommand & DownloadDiscoveryCommand & RestoreMetadataCommand> & JobExecutionState;
export interface JobPayloads {
  'scan-matchable': Record<string, never>;
  'scan-downloaded': DownloadDiscoveryCommand;
  'scan-new': Pick<SeriesTargets, 'libraryId'>;
  'match-unmatched': Pick<SeriesTargets, 'libraryId'>;
  'match-library': { libraryId: number };
  'match-series': ({ seriesId: number; seriesIds?: number[] } | { seriesIds: number[]; seriesId?: number }) & { libraryId?: number };
  'sync-series': { libraryId: number; seriesIds?: number[] } | { seriesIds: number[]; libraryId?: number };
  'apply-series': ApplySeriesCommand;
  'restore-metadata': RestoreMetadataCommand;
  'clear-overrides': Pick<SeriesTargets, 'libraryId'>;
  'check-watched-searches': Record<string, never>;
  'edit-comicinfo': EditComicInfoCommand;
  'merge-series': MergeSeriesCommand;
  'delete-series': { seriesId: number };
}
export type JobCommand = { [T in JobType]: { type: T; payload: JobPayloads[T] } }[JobType];

const fieldsByType: Record<JobType, readonly string[]> = {
  'scan-matchable': [],
  'scan-downloaded': ['path', 'connectionKey', 'seriesName'],
  'scan-new': ['libraryId'], 'match-unmatched': ['libraryId'], 'match-library': ['libraryId'],
  'match-series': ['seriesId', 'seriesIds', 'libraryId'], 'sync-series': ['seriesIds', 'libraryId'],
  'apply-series': ['seriesId', 'providerId', 'providerSeriesId', 'selectedTitle', 'excludedFields', 'cover', 'score'],
  'restore-metadata': ['seriesId', 'connectionKey', 'planId'],
  'clear-overrides': ['libraryId'], 'check-watched-searches': [],
  'edit-comicinfo': ['seriesId', 'path', 'xml', 'fields'],
  'merge-series': ['seriesId', 'sourceFiles', 'targetDir', 'chapters', 'existingChapters', 'downloads', 'seriesName'],
  'delete-series': ['seriesId'],
};
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const stringMap = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string');

export function validMergeChapter(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return !trimmed || (/^\d+(?:\.\d+)?$/.test(trimmed) && Number(trimmed) > 0 && Number(trimmed) < Number.MAX_SAFE_INTEGER);
}

export function validateMergeDownloads(value: unknown): asserts value is MergeSeriesCommand['downloads'] {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('downloads must be a list of galleries');
  const keys = new Set<string>();
  for (const entry of value) {
    if (!entry || (entry.source !== 'hitomi' && entry.source !== 'nhentai') || typeof entry.galleryId !== 'string' || !entry.galleryId.trim() || typeof entry.title !== 'string') throw new Error('Each merge download needs a supported source, galleryId, and title');
    if (entry.allowDuplicate !== undefined && typeof entry.allowDuplicate !== 'boolean') throw new Error('allowDuplicate must be a boolean');
    if (!validMergeChapter(entry.chapter)) throw new Error('Download chapters must be positive numbers or blank');
    const key = `${entry.source}:${entry.galleryId}`;
    if (keys.has(key)) throw new Error('A gallery can only appear once in merge downloads');
    keys.add(key);
  }
}

/** Reject malformed commands before they become queued background failures. */
export function parseJobCommand(type: unknown, value: unknown): JobCommand {
  if (!isJobType(type)) throw new Error('Unsupported job type');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Job payload must be an object');
  const raw = value as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const field of fieldsByType[type]) if (raw[field] !== undefined) payload[field] = raw[field];
  for (const key of ['libraryId', 'seriesId']) if (payload[key] !== undefined && !id(payload[key])) throw new Error(`${key} must be a positive integer`);
  if (payload.seriesIds !== undefined && (!Array.isArray(payload.seriesIds) || !payload.seriesIds.every(id))) throw new Error('seriesIds must contain positive integers');
  if (Array.isArray(payload.seriesIds)) payload.seriesIds = [...new Set(payload.seriesIds)];
  if (payload.sourceFiles !== undefined && !strings(payload.sourceFiles)) throw new Error('sourceFiles must be a list of paths');
  for (const key of ['path', 'targetDir', 'providerId', 'providerSeriesId', 'selectedTitle', 'xml']) if (payload[key] !== undefined && typeof payload[key] !== 'string') throw new Error(`${key} must be a string`);
  for (const key of ['fields', 'chapters', 'existingChapters']) if (payload[key] !== undefined && !stringMap(payload[key])) throw new Error(`${key} must contain string values`);
  if (payload.cover !== undefined && typeof payload.cover !== 'boolean') throw new Error('cover must be a boolean');
  if (payload.score !== undefined && (typeof payload.score !== 'number' || !Number.isFinite(payload.score) || payload.score < 0 || payload.score > 1)) throw new Error('score must be between 0 and 1');
  if (payload.excludedFields !== undefined && !strings(payload.excludedFields)) throw new Error('excludedFields must be a list of strings');
  if (type === 'match-library' && !id(payload.libraryId)) throw new Error('libraryId required');
  if ((type === 'apply-series' || type === 'delete-series') && !id(payload.seriesId)) throw new Error('seriesId required');
  if (type === 'apply-series' && (!payload.providerId || !payload.providerSeriesId)) throw new Error('providerId and providerSeriesId required');
  if (type === 'restore-metadata') {
    if (!id(payload.seriesId)) throw new Error('seriesId required');
    if (typeof payload.connectionKey !== 'string' || !payload.connectionKey.trim() || payload.connectionKey.length > 2048) throw new Error('Kavita connection required');
    if (typeof payload.planId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.planId)) throw new Error('Approved restore plan required');
  }
  if (type === 'match-series' && !id(payload.seriesId) && !(payload.seriesIds as number[] | undefined)?.length) throw new Error('seriesId or seriesIds required');
  if (type === 'sync-series' && !id(payload.libraryId) && !(payload.seriesIds as number[] | undefined)?.length) throw new Error('seriesIds or libraryId required');
  if (type === 'edit-comicinfo' && !payload.path) throw new Error('path required');
  if (type === 'scan-downloaded') {
    if (typeof payload.path !== 'string' || !/^(?:[\\/]|[a-z]:[\\/])/i.test(payload.path) || payload.path.includes('\0')) throw new Error('An absolute download path is required');
    if (typeof payload.connectionKey !== 'string' || !payload.connectionKey.trim()) throw new Error('Kavita connection required');
    if (payload.seriesName !== undefined && (typeof payload.seriesName !== 'string' || !payload.seriesName.trim())) throw new Error('Series name must be non-empty text');
  }
  if (type === 'merge-series') {
    if (payload.seriesName !== undefined) {
      if (typeof payload.seriesName !== 'string' || !payload.seriesName.trim() || /[\u0000-\u001f\u007f]/.test(payload.seriesName)) throw new Error('Series name must be non-empty text without control characters');
      payload.seriesName = payload.seriesName.trim();
    }
    validateMergeDownloads(payload.downloads);
    for (const field of ['chapters', 'existingChapters']) if (payload[field] && !Object.values(payload[field] as Record<string, string>).every(validMergeChapter)) throw new Error('Chapter numbers must be positive numbers or blank');
  }
  if (type === 'merge-series' && (!payload.targetDir && !payload.seriesId || !(payload.sourceFiles as string[] | undefined)?.length && !(payload.downloads as unknown[] | undefined)?.length)) throw new Error('Merge requires a target and at least one archive or gallery');
  return { type, payload } as JobCommand;
}
