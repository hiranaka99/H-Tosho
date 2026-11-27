import type { DoujinSource } from "../contracts/doujin.js";
import type { DownloadTask } from "../contracts/downloads.js";
import type { JobContext, MergeSeriesCommand } from "../contracts/jobs.js";
import type { MergeProtectionPreview } from "../contracts/mergeProtection.js";
import type { DownloadPublicationTarget } from "../downloader/publishGuard.js";
import type { Job, JobTypeLifecycleHook, LogFn } from "../jobs/queue.js";
import type {
  KavitaChapterDto,
  KavitaLibrary,
  KavitaSeries,
  KavitaSeriesDto,
  KavitaSeriesMetadataDto,
} from "../kavita/types.js";

export type { DownloadPublicationTarget };

export type ProtectedMergeErrorStatus = 400 | 409 | 502 | 503;

/** Domain error with HTTP status semantics for route callers. */
export class ProtectedMergeError extends Error {
  constructor(
    message: string,
    readonly status: ProtectedMergeErrorStatus = 409
  ) {
    super(message);
    this.name = "ProtectedMergeError";
  }
}

export interface AttachedMergeDownload {
  downloadId: number;
  source: DoujinSource;
  galleryId: string;
  title: string;
  chapter: string;
  allowDuplicate: boolean;
  url?: string;
}

/** Rejects Promise-returning enqueue callbacks at compile time so no await can split inserts from linkage. */
export type SyncOnly<T> = T extends PromiseLike<unknown> ? never : T;

export interface MergedDownloadRegistration<TPrepared, TResult> {
  /** Async preflight (metadata / duplicate preparation) run between initial review and post-prepare recheck. */
  prepare: () => Promise<TPrepared>;
  /**
   * Synchronous commit step. Enqueues downloads and calls `attach(...)` for each accepted download
   * without awaiting; Protected Merge links the merge job and `merge_job_id` in the same turn.
   */
  enqueue: (
    prepared: TPrepared,
    attach: (entry: AttachedMergeDownload) => void
  ) => SyncOnly<TResult>;
}

export interface MergeJobResult {
  [key: string]: number | string | string[] | boolean | undefined;
  processed: number;
  matched: 0;
  failed: number;
  verificationSkipped?: true;
}

/** Remote Kavita seam: read/write operations needed by Protected Merge and its metadata history snapshot. */
export interface KavitaMergeClient {
  getLibraries(): Promise<KavitaLibrary[]>;
  getSeries(libraryId: number): Promise<KavitaSeries[]>;
  getSeriesById(seriesId: number): Promise<KavitaSeries>;
  getChaptersBySeries(seriesId: number): Promise<KavitaChapterDto[]>;
  scanLibrary(libraryId: number): Promise<void>;
  scanSeries(libraryId: number, seriesId: number): Promise<void>;
  deleteSeries(seriesId: number): Promise<void>;
  updateSeriesMetadata(
    seriesId: number,
    patch: { name: string }
  ): Promise<void>;
  isTaskRunning(): Promise<boolean>;
  getSeriesDto(seriesId: number): Promise<KavitaSeriesDto>;
  getSeriesMetadata(seriesId: number): Promise<KavitaSeriesMetadataDto>;
}

export interface KavitaMergeSession extends KavitaMergeClient {
  readonly connectionKey: string;
}

export interface KavitaMergePort {
  /** Returns a session bound to the live Kavita configuration, or null when unconfigured. */
  current(): KavitaMergeSession | null;
  /** Current normalized Kavita connection key (empty string when unconfigured). */
  connectionKey(): string;
}

export interface MergeSettingsPort {
  getDownloaderPaths(): {
    downloadDirectory: string;
    libraryPathMappings: { kavitaPath: string; localPath: string }[];
  };
}

export interface MergeDownloadPort {
  get(id: number): DownloadTask | null;
  findActive(source: DoujinSource, galleryId: string): DownloadTask | null;
  findCompleted(source: DoujinSource, galleryId: string): DownloadTask | null;
  hasPendingRetry(id: number): boolean;
  isRunning(id: number): boolean;
  enqueueForMerge(plan: {
    source: DoujinSource;
    galleryId: string;
    title: string;
    chapter?: number;
    mergeJobId: number;
    url?: string;
  }): number;
  retry(id: number): boolean;
  cancel(id: number): boolean;
  cancelByMergeJob(mergeJobId: number): void;
  attachToMergeJob(downloadIds: readonly number[], mergeJobId: number): void;
  reassignMergeJob(
    downloadId: number,
    fromMergeJobId: number,
    toMergeJobId: number
  ): void;
  markOutputPublished(oldPath: string, newPath: string): void;
  subscribe(listener: (task: DownloadTask) => void): () => void;
  subscribeRemovals(listener: (ids: number[]) => void): () => void;
}

export interface MergeJobPort {
  get(id: number): Job | null;
  enqueueMergeJob(
    command: MergeSeriesCommand,
    initialState: Record<string, unknown>
  ): number;
  setProgress(jobId: number, current: number, total: number): void;
  isCancelRequested(jobId: number): boolean;
  updateContext(jobId: number, context: JobContext): void;
  invalidateContextCache(jobIds: number | readonly number[]): void;
}

export interface MergeAuxPort {
  checkDownloadDuplicates(
    plans: { source: DoujinSource; galleryId: string; url?: string }[],
    sourceFiles?: string[]
  ): Promise<Set<string>>;
  invalidateDuplicateLibrary(): void;
  queueMatchDiscovery(targetDir: string, seriesName?: string): void;
}

export interface ProtectedMergeDeps {
  kavita: KavitaMergePort;
  settings: MergeSettingsPort;
  downloads: MergeDownloadPort;
  jobs: MergeJobPort;
  aux?: Partial<MergeAuxPort>;
}

export interface ProtectedMergeTiming {
  chapterCacheTtlMs?: number;
  downloadFallbackPollMs?: number;
  scanPollMs?: number;
  scanGraceMs?: number;
  mergeVerifyTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ResolvedMergeTiming {
  chapterCacheTtlMs: number;
  downloadFallbackPollMs: number;
  scanPollMs: number;
  scanGraceMs: number;
  mergeVerifyTimeoutMs: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProtectedMerge {
  /** Validate and evaluate a read-only Protected Merge preview. */
  preview(rawOrRequest: unknown): Promise<MergeProtectionPreview>;

  /** Review -> prepare -> recheck -> synchronous enqueue & atomic merge-job linkage. */
  registerMergedDownloads<TPrepared, TResult>(
    mergeFolder: string,
    steps: MergedDownloadRegistration<TPrepared, TResult>
  ): Promise<SyncOnly<TResult>>;

  /** Guard CBZ download publication for both job-backed and legacy direct-merge downloads. */
  guardDownloadPublication<T>(
    target: DownloadPublicationTarget,
    commit: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;

  /** Execute a `merge-series` job end-to-end across its two-phase lock bracket. */
  executeMergeJob(
    job: Job,
    log: LogFn,
    signal?: AbortSignal
  ): Promise<MergeJobResult>;

  /** Late-index Field Policy recovery for callers that do NOT hold `series:<id>` lock. */
  recoverSeries(seriesId: number): Promise<void>;

  /** Late-index Field Policy recovery for callers that ALREADY hold `series:<id>` lock (never reacquires locks). */
  recoverSeriesWithinLock(seriesId: number): Promise<void>;

  /** Narrow lifecycle hook registered on `jobQueue` for `'merge-series'`. */
  readonly jobLifecycleHook: JobTypeLifecycleHook;
}
