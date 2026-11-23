import type { DoujinSource } from './doujin.js';
export type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'failed' | 'paused';

export interface DownloadTask {
  id: number;
  source: DoujinSource;
  galleryId: string;
  /**
   * Provider-resolved canonical gallery URL, frozen at enqueue time.
   * Null for sources without a canonical URL and all pre-existing rows.
   */
  sourceUrl: string | null;
  title: string | null;
  status: DownloadStatus;
  progressCurrent: number;
  progressTotal: number;
  speed: number | null;
  currentFile: string | null;
  /** Total image bytes received so far this run. */
  bytesCurrent: number;
  /** Total image bytes expected for the run (0 until known). */
  bytesTotal: number;
  outputFormat: 'cbz' | 'folder';
  outputPath: string | null;
  /** When set, the task writes into this shared folder (series merge) instead of its own per-gallery folder. */
  mergeFolder: string | null;
  /** Manual chapter number written to ComicInfo.Number for merged downloads. */
  chapterNumber: number | null;
  mergeJobId?: number | null;
  /** Queue priority: higher values are claimed first (ties break on id ASC). */
  priority: number;
  phase: 'resolving' | 'downloading' | 'packing' | null;
  errorMessage: string | null;
  errorCode: DownloadErrorCode | null;
  retryAt: string | null;
  retryCount: number;
  attempt: number;
  revision: number;
  state: DownloadState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Transient failures re-queue themselves this many times before settling as failed. */
export const MAX_AUTO_RETRIES = 3;

/** Where a completed download stands in Kavita, from the import task it queued. */
export type DownloadLibraryState =
  | { state: 'importing'; jobId: number }
  | { state: 'imported'; jobId: number; series: { id: number; name: string }[]; review: boolean }
  | { state: 'failed'; jobId: number; message: string | null };

/** One page of completed download history, newest finish first. */
export interface DownloadHistoryPage { items: DownloadTask[]; total: number }

export type DownloadErrorCode = 'cancelled' | 'network' | 'rate-limit' | 'upstream' | 'access-denied' | 'quota' | 'disk-full' | 'output-missing' | 'permissions' | 'download-failed';
export type DownloadState = { type: 'retry-wait'; retryAt: string; retryCount: number }
  | { type: 'cancelled' }
  | { type: 'packing' }
  | { type: DownloadStatus };

export function downloadState(task: { status: DownloadStatus; errorCode: DownloadErrorCode | null; retryAt: string | null; retryCount: number; phase?: string | null }): DownloadState {
  if (task.status === 'downloading' && task.phase === 'packing') return { type: 'packing' };
  if (task.status === 'failed' && task.errorCode === 'cancelled') return { type: 'cancelled' };
  if (task.status === 'failed' && task.retryAt) return { type: 'retry-wait', retryAt: task.retryAt, retryCount: task.retryCount };
  return { type: task.status };
}
