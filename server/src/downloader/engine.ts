import { pathContains } from '../lib/paths.js';
import { archiveMutations, archiveResource, libraryMutations } from '../lib/mutations.js';
import { downloadPages } from './transfer.js';
import { wakePaused, type RunContext, type LiveFields } from './runtime.js';
import { isTransientError, retryTransient, classifyDownloadError } from './requests.js';
export { isTransientError, retryTransient } from './requests.js';
import { downloadState, type DownloadTask, type DownloadStatus, type DownloadErrorCode } from '../contracts/downloads.js';
export type { DownloadTask, DownloadStatus } from '../contracts/downloads.js';
import { queueDownloadedMatchDiscovery } from '../services/downloadDiscovery.js';
import { recordGalleryIdentity, invalidateDuplicateLibrary, resolveDuplicateGallery } from '../services/galleryDuplicates.js';
import { and, asc, desc, eq, inArray, or, isNotNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getTmpDir, schema } from '../db/index.js';
import { mapLimit } from '../lib/http.js';
import { generateComicInfoXml } from './comicinfo.js';
import { buildZipFromFiles } from './zip.js';
import { galleryFilesystemName, sanitizeFilename } from './util.js';
import { getDoujinProvider } from './providers.js';
import type { DoujinGallery } from './types.js';
import type { DoujinSource } from '../contracts/doujin.js';
import { getDownloaderSettings, type DownloaderSettings } from '../services/settings.js';
import { recordGalleryTags } from '../services/recommendations.js';
import { jobQueue } from '../jobs/queue.js';
import { KavitaClient } from '../kavita/client.js';
import { getKavitaConnection } from '../services/settings.js';
import { resolveMergeProtection, requireMergeProtection } from '../services/mergeProtection.js';

/**
 * Doujinshi download queue engine.
 *
 * Manages gallery download jobs with a small state machine
 * (queued -> downloading -> completed | failed | paused), bounded concurrency,
 * per-request rate limiting, and live progress tracking at both the page and
 * byte level (streaming each image so speed/bytes update in real time). Output
 * is written into a per-doujin subfolder of the configured download location —
 * either a `.cbz` archive or a raw image folder + ComicInfo.xml.
 *
 * Live updates are fanned out to in-process subscribers (used by the SSE
 * endpoint) while being persisted to SQLite on a throttled cadence so REST
 * polling clients stay fresh without hammering the database.
 */

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 60_000;

/**
 * Replace a published file with a staged file without relying on POSIX rename
 * semantics. Windows refuses `rename(staged, destination)` when destination
 * already exists, which made retries and re-downloads fail at the final
 * publish step. Keep the previous file until the staged replacement has been
 * put in place, and restore it if that step fails.
 */
async function replacePublishedFile(staged: string, destination: string): Promise<void> {
  let backup: string | null = null;
  try {
    try {
      await fs.promises.access(destination);
      backup = path.join(path.dirname(destination), `.${path.basename(destination)}.htosho-backup-${randomUUID()}`);
      await fs.promises.rename(destination, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.promises.rename(staged, destination);
    } catch (error) {
      if (backup) await fs.promises.rename(backup, destination).catch(() => {});
      throw error;
    }
    if (backup) await fs.promises.rm(backup, { force: true }).catch(() => {});
  } catch (error) {
    throw error;
  }
}

interface DownloadRow {
  id: number;
  source: string;
  galleryId: string;
  sourceUrl: string | null;
  title: string | null;
  status: string;
  progressCurrent: number;
  progressTotal: number;
  speed: number | null;
  currentFile: string | null;
  bytesCurrent: number;
  bytesTotal: number;
  outputFormat: string;
  outputPath: string | null;
  mergeFolder: string | null;
  chapterNumber: number | null;
  mergeJobId?: number | null;
  priority: number;
  errorMessage: string | null;
  phase: string | null;
  errorCode: string | null;
  retryAt: string | null;
  retryCount: number;
  attempt: number;
  revision: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function rowToTask(row: DownloadRow): DownloadTask {
  return {
    id: row.id,
    source: row.source as DoujinSource,
    galleryId: row.galleryId,
    sourceUrl: row.sourceUrl ?? null,
    title: row.title,
    status: row.status as DownloadStatus,
    progressCurrent: row.progressCurrent,
    progressTotal: row.progressTotal,
    speed: row.speed,
    currentFile: row.currentFile,
    bytesCurrent: row.bytesCurrent ?? 0,
    bytesTotal: row.bytesTotal ?? 0,
    outputFormat: (row.outputFormat as 'cbz' | 'folder') ?? 'cbz',
    outputPath: row.outputPath,
    mergeFolder: row.mergeFolder ?? null,
    chapterNumber: row.chapterNumber ?? null,
    mergeJobId: row.mergeJobId ?? null,
    priority: row.priority ?? 0,
    phase: row.phase === 'resolving' || row.phase === 'downloading' || row.phase === 'packing' ? row.phase : null,
    errorMessage: row.errorMessage,
    errorCode: row.errorCode as DownloadErrorCode | null,
    retryAt: row.retryAt,
    retryCount: row.retryCount,
    attempt: row.attempt,
    revision: row.revision,
    state: downloadState({ status: row.status as DownloadStatus, errorCode: row.errorCode as DownloadErrorCode | null, retryAt: row.retryAt, retryCount: row.retryCount, phase: row.phase }),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

export class DownloadQueue {
  private running = 0;
  private pumping = false;
  /** id -> live run context (used for cancel/pause of in-flight jobs). */
  private activeRuns = new Map<number, RunContext>();
  /** id -> freshest in-memory task snapshot (source of truth while a run is active). */
  private live = new Map<number, DownloadTask>();
  /** id -> last SSE broadcast timestamp (ms) for throttling. */
  private lastBroadcast = new Map<number, number>();
  /** id -> last DB persist timestamp (ms) for throttling. */
  private lastWrite = new Map<number, number>();
  /** id -> number of automatic retries scheduled for a transient failure. */
  /** id -> pending cooldown timer that will re-queue the task. */
  private retryTimers = new Map<number, NodeJS.Timeout>();
  private listeners = new Set<(task: DownloadTask) => void>();
  private removalListeners = new Set<(ids: number[]) => void>();
  private started = false;
  private settingsProvider: () => DownloaderSettings;

  constructor(settingsProvider: () => DownloaderSettings) {
    this.settingsProvider = settingsProvider;
  }
  /** Recover persistent queue state after process startup, then run queued work. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // A previous process may have died mid-download. Its partial page files are
    // still in the task's tmpDir, so re-queue instead of failing — the run
    // resumes from the first missing page file.
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'queued', speed: null, currentFile: null, errorMessage: null, errorCode: null, retryAt: null, startedAt: null })
      .where(eq(schema.downloadQueue.status, 'downloading'))
      .run();
    // Cooldowns are durable; restart does not strand retryable failures.
    for (const row of getDb().select().from(schema.downloadQueue).where(eq(schema.downloadQueue.status, 'failed')).all()) {
      if (row.retryAt) this.armRetry(row.id, Math.max(0, Date.parse(row.retryAt) - Date.now()));
    }
    void this.pump();
  }


  // ---------------- Live update fan-out (SSE) ----------------

  /** Subscribe to live task updates. Returns an unsubscribe function. */
  subscribe(listener: (task: DownloadTask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(task: DownloadTask): void {
    if (this.listeners.size === 0) return;
    for (const l of this.listeners) {
      try {
        l(task);
      } catch {
        /* a misbehaving listener must never break the pipeline */
      }
    }
  }

  /** Subscribe to removed task ids, including bulk history clears. */
  subscribeRemovals(listener: (ids: number[]) => void): () => void {
    this.removalListeners.add(listener);
    return () => this.removalListeners.delete(listener);
  }

  private broadcastRemovals(ids: number[]): void {
    if (ids.length === 0) return;
    for (const listener of this.removalListeners) {
      try {
        listener(ids);
      } catch {
        /* subscribers cannot interrupt queue mutations */
      }
    }
  }

  // ---------------- CRUD / state machine ----------------

  enqueue(
    source: DoujinSource,
    galleryId: string,
    title: string | null,
    outputFormat?: 'cbz' | 'folder',
    mergeFolder?: string,
    chapterNumber?: number,
    priority?: number,
    mergeJobId?: number,
    sourceUrl?: string,
  ): number {
    const db = getDb();
    const res = db
      .insert(schema.downloadQueue)
      .values({
        source,
        galleryId,
        title,
        status: 'queued',
        progressCurrent: 0,
        progressTotal: 0,
        outputFormat: outputFormat ?? this.settingsProvider().format,
        mergeFolder: mergeFolder ?? null,
        chapterNumber: chapterNumber ?? null,
        priority: priority ?? 0,
        mergeJobId: mergeJobId ?? null,
        sourceUrl: sourceUrl ?? null,
      })
      .run();
    const id = Number(res.lastInsertRowid);
    void this.pump();
    return id;
  }

  /** Raw read from SQLite (no live overlay). */
  private readRow(id: number): DownloadTask | null {
    const row = getDb().select().from(schema.downloadQueue).where(eq(schema.downloadQueue.id, id)).get();
    return row ? rowToTask(row) : null;
  }

  private overlayLive(base: DownloadTask): DownloadTask {
    const live = this.live.get(base.id);
    if (!live) return base;
    const task = { ...base, ...pickLiveFields(live) };
    return { ...task, state: downloadState(task) };
  }

  /** Task with any fresher in-memory progress fields overlaid on the DB row. */
  get(id: number): DownloadTask | null {
    const base = this.readRow(id);
    return base ? this.overlayLive(base) : null;
  }

  list(limit = 100): DownloadTask[] {
    const rows = getDb()
      .select()
      .from(schema.downloadQueue)
      .orderBy(desc(schema.downloadQueue.id))
      .limit(limit)
      .all();
    return rows.map((row) => this.overlayLive(rowToTask(row)));
  }

  /** Count of currently in-flight (downloading) tasks. */
  activeCount(): number {
    return this.running;
  }

  /** True while this process still owns network or filesystem work for a task. */
  isRunning(id: number): boolean {
    return this.activeRuns.has(id);
  }

  private setStatus(id: number, status: DownloadStatus): void {
    const db = getDb();
    if (status === 'downloading') {
      db.update(schema.downloadQueue).set({ status, startedAt: new Date().toISOString(), attempt: this.activeRuns.has(id) ? (this.get(id)?.attempt ?? 0) : (this.get(id)?.attempt ?? 0) + 1 }).where(eq(schema.downloadQueue.id, id)).run();
    } else if (status === 'completed' || status === 'failed') {
      db.update(schema.downloadQueue).set({ status, finishedAt: new Date().toISOString() }).where(eq(schema.downloadQueue.id, id)).run();
    } else {
      db.update(schema.downloadQueue).set({ status }).where(eq(schema.downloadQueue.id, id)).run();
    }
    this.syncLive(id);
  }

  /** Reload a task from the DB into the live snapshot and force-broadcast it. */
  private syncLive(id: number): void {
    const t = this.readRow(id);
    if (t) {
      const previous = this.live.get(id);
      if (previous) Object.assign(t, pickLiveFields(previous));
      t.state = downloadState(t);
      t.revision = Math.max(t.revision, previous?.revision ?? 0) + 1;
      this.live.set(id, t);
      this.persistProgress(id, t);
      this.lastWrite.set(id, Date.now());
    }
    else this.live.delete(id);
    if (t) this.broadcast(t);
  }

  /**
   * Merge volatile progress fields into the in-memory snapshot, then fan out to
   * subscribers and persist to SQLite — each on its own throttle so high-frequency
   * byte-level updates stay smooth without overloading the database.
   */
  private updateProgress(id: number, patch: LiveFields, opts?: { force?: boolean; forceBroadcast?: boolean }): void {
    let snap = this.live.get(id);
    if (!snap) {
      const base = this.readRow(id);
      if (!base) return;
      snap = { ...base };
    }
    const merged = { ...snap, ...patch, revision: snap.revision + 1 };
    merged.state = downloadState(merged);
    this.live.set(id, merged);

    const now = Date.now();
    const lastB = this.lastBroadcast.get(id) ?? 0;
    if (opts?.force || opts?.forceBroadcast || now - lastB >= 80) {
      this.broadcast(merged);
      this.lastBroadcast.set(id, now);
    }
    const lastW = this.lastWrite.get(id) ?? 0;
    if (opts?.force || now - lastW >= 500) {
      this.persistProgress(id, merged);
      this.lastWrite.set(id, now);
    }
  }

  private persistProgress(id: number, p: DownloadTask): void {
    getDb()
      .update(schema.downloadQueue)
      .set({
        progressCurrent: p.progressCurrent,
        progressTotal: p.progressTotal,
        speed: p.speed,
        currentFile: p.currentFile,
        bytesCurrent: p.bytesCurrent,
        bytesTotal: p.bytesTotal,
        revision: p.revision,
        phase: p.phase,
      })
      .where(eq(schema.downloadQueue.id, id))
      .run();
  }

  /** Pause an in-flight download (stops after the current page) or a queued one. */
  pause(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status === 'queued' || task.status === 'downloading') {
      this.setStatus(id, 'paused');
      const run = this.activeRuns.get(id);
      if (run) run.pauseSignal.paused = true;
      return true;
    }
    return false;
  }

  /** Resume a paused task, or retry a settled failed task. */
  resume(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status === 'paused') {
      const run = this.activeRuns.get(id);
      if (run) {
        run.pauseSignal.paused = false;
        wakePaused(run);
        this.setStatus(id, 'downloading');
        return true;
      }
      this.setStatus(id, 'queued');
      void this.pump();
      return true;
    }
    if (task.status === 'failed') return this.retry(id);
    return false;
  }

  /** A failed task may still be waiting for its automatic retry timer. */
  hasPendingRetry(id: number): boolean {
    return this.get(id)?.state.type === 'retry-wait';
  }

  /** Cancel: stop an in-flight job and mark it failed/cancelled. */
  cancel(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    const retryTimer = this.retryTimers.get(id);
    if (retryTimer && task.status === 'failed') {
      clearTimeout(retryTimer);
      this.retryTimers.delete(id);
      getDb().update(schema.downloadQueue).set({ errorMessage: 'Cancelled by user', errorCode: 'cancelled', retryAt: null }).where(eq(schema.downloadQueue.id, id)).run();
      this.syncLive(id);
      this.discoverCompletedDownload(id);
      return true;
    }
    if (this.activeRuns.get(id)?.committing) return false;
    if (task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') {
      const run = this.activeRuns.get(id);
      if (run) {
        run.cancelled = true;
        run.controller.abort(new Error('Cancelled by user'));
        // A worker parked on the pause gate must exit promptly.
        wakePaused(run);
      }
      getDb().update(schema.downloadQueue).set({ errorMessage: 'Cancelled by user', errorCode: 'cancelled', retryAt: null }).where(eq(schema.downloadQueue.id, id)).run();
      this.setStatus(id, 'failed');
      if (!run) this.discoverCompletedDownload(id);
      return true;
    }
    return false;
  }

  /**
   * Re-queue a task that failed on a transient error (CDN 503/timeout) after a
   * cooldown, up to MAX_AUTO_RETRIES times. The row stays visible as "failed"
   * with an explicit retry deadline until the timer flips it back to "queued"; a manual
   * retry or delete supersedes the pending timer via status guards.
   */
  private scheduleAutoRetry(id: number, message: string): void {
    const count = (this.get(id)?.retryCount ?? 0) + 1;
    if (count > MAX_AUTO_RETRIES) {
      this.setStatus(id, 'failed');
      return;
    }
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'failed', finishedAt: new Date().toISOString(), errorMessage: message, retryAt: new Date(Date.now() + AUTO_RETRY_DELAY_MS).toISOString(), retryCount: count })
      .where(eq(schema.downloadQueue.id, id))
      .run();
    this.syncLive(id);
    this.armRetry(id, AUTO_RETRY_DELAY_MS);
  }

  private armRetry(id: number, delay: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      const t = this.readRow(id);
      if (!t || t.state.type !== 'retry-wait') return; // user retried or deleted meanwhile
      getDb()
        .update(schema.downloadQueue)
        .set({ status: 'queued', speed: null, currentFile: null, errorMessage: null, errorCode: null, retryAt: null, startedAt: null, finishedAt: null })
        .where(eq(schema.downloadQueue.id, id))
        .run();
      this.syncLive(id);
      void this.pump();
    }, delay);
    timer.unref();
    this.retryTimers.set(id, timer);
  }

  /** Re-queue a settled failed/completed task, resuming from partial page files. */
  retry(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status !== 'failed' && task.status !== 'completed') return false;
    // A cancelled run can remain in-flight until its current request unwinds.
    // Starting another writer against the same scratch directory would race it.
    if (this.activeRuns.has(id) || (task.outputPath && archiveMutations.isBusy(archiveResource(task.outputPath)))) return false;
    const pending = this.retryTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.retryTimers.delete(id);
    }
    this.live.delete(id);
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'queued', speed: null, currentFile: null, errorMessage: null, errorCode: null, retryAt: null, retryCount: 0, startedAt: null, finishedAt: null })
      .where(eq(schema.downloadQueue.id, id))
      .run();
    void this.pump();
    return true;
  }

  /** Delete a task and its scratch directory. Active callers must cancel first. */
  remove(id: number): boolean {
    const task = this.get(id);
    if (!task || this.isRunning(id) || ['queued', 'downloading', 'paused'].includes(task.status)) return false;
    getDb().delete(schema.downloadQueue).where(eq(schema.downloadQueue.id, id)).run();
    this.live.delete(id);
    const pending = this.retryTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.retryTimers.delete(id);
    }
    void fs.promises
      .rm(path.join(getTmpDir(), 'downloads', String(id)), { recursive: true, force: true })
      .catch((err) => console.warn('[h-tosho] failed to remove download scratch dir:', err));
    this.broadcastRemovals([id]);
    return true;
  }

  /** Delete all completed tasks. */
  clearCompleted(): number {
    const db = getDb();
    const removed = db.delete(schema.downloadQueue).where(eq(schema.downloadQueue.status, 'completed'))
      .returning({ id: schema.downloadQueue.id }).all();
    for (const { id } of removed) this.live.delete(id);
    this.broadcastRemovals(removed.map((row) => row.id));
    return removed.length;
  }
  /** Most recent completed task for a gallery (duplicate-download guard). */
  findCompleted(source: DoujinSource, galleryId: string): DownloadTask | null {
    const row = getDb()
      .select()
      .from(schema.downloadQueue)
      .where(and(eq(schema.downloadQueue.source, source), eq(schema.downloadQueue.galleryId, galleryId), eq(schema.downloadQueue.status, 'completed')))
      .orderBy(desc(schema.downloadQueue.id))
      .limit(1)
      .get();
    return row ? this.overlayLive(rowToTask(row)) : null;
  }

  /**
   * Most recent queued/downloading/paused task for a gallery — blocks duplicate
   * enqueues of work that is already in flight or waiting.
   */
  findActive(source: DoujinSource, galleryId: string): DownloadTask | null {
    const row = getDb()
      .select()
      .from(schema.downloadQueue)
      .where(
        and(
          eq(schema.downloadQueue.source, source),
          eq(schema.downloadQueue.galleryId, galleryId),
          or(inArray(schema.downloadQueue.status, ['queued', 'downloading', 'paused']), and(eq(schema.downloadQueue.status, 'failed'), isNotNull(schema.downloadQueue.retryAt))),
        ),
      )
      .orderBy(desc(schema.downloadQueue.id))
      .limit(1)
      .get();
    return row ? this.overlayLive(rowToTask(row)) : null;
  }

  /** Every completed gallery (newest first) — powers the "already downloaded" badges. */
  completedGalleries(): { source: string; galleryId: string; title: string | null; finishedAt: string | null }[] {
    return getDb()
      .select({
        source: schema.downloadQueue.source,
        galleryId: schema.downloadQueue.galleryId,
        title: schema.downloadQueue.title,
        finishedAt: schema.downloadQueue.finishedAt,
      })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, 'completed'))
      .orderBy(desc(schema.downloadQueue.id))
      .all();
  }

  // ---------------- Pump / concurrency ----------------

  private claimNext(): DownloadRow | null {
    const db = getDb();
    for (;;) {
      const row = db
        .select()
        .from(schema.downloadQueue)
        .where(eq(schema.downloadQueue.status, 'queued'))
        .orderBy(desc(schema.downloadQueue.priority), asc(schema.downloadQueue.id))
        .limit(1)
        .get();
      if (!row) return null;
      if (this.activeRuns.has(row.id)) {
        // A live run already owns this task (a pause/resume race re-queued it);
        // restore its status and claim the next queued row instead of starting
        // a second process for the same gallery.
        this.setStatus(row.id, 'downloading');
        continue;
      }
      this.setStatus(row.id, 'downloading');
      return row;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const maxConcurrent = Math.max(1, this.settingsProvider().maxConcurrentDownloads || 1);
      while (this.running < maxConcurrent) {
        const next = this.claimNext();
        if (!next) break;
        this.running++;
        void this.process(next).finally(() => {
          this.running--;
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---------------- Execution ----------------

  /** Discover a merged series only once every sibling has settled. */
  private discoverCompletedDownload(id: number, seriesName?: string): void {
    const task = this.readRow(id);
    if (!task || task.mergeJobId != null) return;
    let outputPath = task.status === 'completed' ? task.outputPath : null;
    if (task.mergeFolder) {
      const siblings = getDb().select().from(schema.downloadQueue).where(eq(schema.downloadQueue.mergeFolder, task.mergeFolder)).all();
      if (siblings.some(sibling => ['queued', 'downloading', 'paused'].includes(sibling.status)
        || sibling.retryAt || this.activeRuns.has(sibling.id))) return;
      outputPath ??= siblings.find(sibling => sibling.status === 'completed' && sibling.outputPath)?.outputPath ?? null;
    }
    if (!outputPath) return;
    try { queueDownloadedMatchDiscovery(task.mergeFolder ? path.dirname(outputPath) : outputPath, task.mergeFolder ?? seriesName ?? task.title ?? undefined); }
    catch (error) { console.warn('[h-tosho] Could not queue download match discovery:', error instanceof Error ? error.message : error); }
  }

  private async process(row: DownloadRow): Promise<void> {
    const ctx: RunContext = { cancelled: false, controller: new AbortController(), stopped: false, committing: false, pauseSignal: { paused: false, waiters: [] } };
    this.activeRuns.set(row.id, ctx);
    // Per-task scratch space: pages stream to disk here so only the in-flight
    // images (bounded by maxImageConcurrency) live in RAM.
    const tmpDir = path.join(getTmpDir(), 'downloads', String(row.id));
    let discoverySeriesName: string | undefined;
    const perform = async () => {
      try {
        const settings = this.settingsProvider();
        if (!settings.downloadDirectory) {
          throw new Error('No download directory configured. Set an output folder in Settings first.');
        }
        const provider = getDoujinProvider(row.source);
        if (!provider) throw new Error(`Unknown source: ${row.source}`);

        // Resolve the full gallery (metadata + image list).
        this.updateProgress(row.id, { phase: 'resolving', progressCurrent: 0, progressTotal: 0, speed: 0, currentFile: 'Resolving gallery…', bytesCurrent: 0, bytesTotal: 0 }, { force: true });
        // The frozen canonical URL (sourceUrl) wins over re-derivation from
        // the current account/site settings: a site cutover must not rewrite
        // queued work.
        const idOrUrl = row.sourceUrl ?? row.galleryId;
        const gallery = await retryTransient(() => resolveDuplicateGallery(row.source as DoujinSource, idOrUrl, true), 4, [2000, 10000, 30000]);
        discoverySeriesName = gallery.series ?? gallery.title;
        if (ctx.cancelled) throw new Error('Cancelled by user');
        recordGalleryIdentity(gallery);
        const total = gallery.pages.length;
        if (!total) throw new Error('Gallery has no downloadable pages.');
        this.updateProgress(row.id, { phase: 'downloading', progressCurrent: 0, progressTotal: total, speed: 0, currentFile: null, bytesCurrent: 0, bytesTotal: 0 }, { force: true });

        const destination = this.outputDestination(row, gallery, settings);
        const publish = async () => {
          // Download all pages with bounded concurrency + rate limiting (streamed for live progress).
          const images = await downloadPages(gallery, row.id, settings, ctx, tmpDir, (id, patch, options) => this.updateProgress(id, patch, options));

          // Write to disk (cbz or folder) and record the output path.
          this.updateProgress(row.id, { phase: 'packing', currentFile: 'Packing archive…' }, { force: true });
          const outputPath = await this.writeOutput(row, gallery, images, settings, ctx);
          getDb().update(schema.downloadQueue).set({ outputPath }).where(eq(schema.downloadQueue.id, row.id)).run();

          // The output is final: the scratch pages are no longer needed. On failure
          // the tmpDir is deliberately kept so a retry can resume from partial data.
          // Cleanup completes before the 'completed' status is published so nothing
          // observes a completed task whose scratch dir is still on disk.
          await fs.promises.rm(tmpDir, { recursive: true, force: true });

          invalidateDuplicateLibrary();
          this.setStatus(row.id, 'completed');
          // Only completed downloads are taste signals. Failed or cancelled work
          // must not permanently bias the recommendation profile.
          recordGalleryTags(row.source as DoujinSource, gallery);
          this.updateProgress(row.id, { progressCurrent: total, progressTotal: total, speed: 0, currentFile: null }, { force: true });
        };
        const old = row.outputPath ? archiveResource(row.outputPath) : null;
        const next = archiveResource(destination);
        // Existing folder reservations already conflict with overlapping folder operations.
        if (row.mergeFolder || old && (pathContains(old, next) || pathContains(next, old))) await publish();
        else await archiveMutations.run([next], publish, ctx.controller.signal);

      } catch (e) {
        ctx.stopped = true;
        wakePaused(ctx);
        const message = ctx.cancelled ? 'Cancelled by user' : e instanceof Error ? e.message : String(e);
        getDb().update(schema.downloadQueue).set({ errorMessage: message, errorCode: classifyDownloadError(e, ctx.cancelled), retryAt: null, speed: 0 }).where(eq(schema.downloadQueue.id, row.id)).run();
        if (!ctx.cancelled) {
          if (isTransientError(e)) this.scheduleAutoRetry(row.id, message);
          else this.setStatus(row.id, 'failed');
        }
      } finally {
        // NOTE: the tmpDir intentionally survives a failed run (resume-from-partial);
        // it is removed here only implicitly by success above or by an explicit remove().
        // Drop the in-memory snapshot so subsequent reads reflect the authoritative DB state.
        this.live.delete(row.id);
        this.lastBroadcast.delete(row.id);
        this.lastWrite.delete(row.id);
        // Defensive: no worker may stay parked on the pause gate after the run ends.
        wakePaused(ctx);
        this.activeRuns.delete(row.id);
        this.discoverCompletedDownload(row.id, discoverySeriesName);
        const final = this.readRow(row.id);
        if (final) this.broadcast(final);
      }
    };
    const previous = row.outputPath ? archiveResource(row.outputPath) : null;
    try {
      if (previous && !row.mergeFolder) await archiveMutations.run([previous], perform, ctx.controller.signal);
      else await perform();
    } catch (error) {
      // Cancellation can reject a reservation before perform() enters its cleanup block.
      this.activeRuns.delete(row.id);
      this.live.delete(row.id);
      if (!ctx.cancelled) throw error;
    }
  }


  /**
   * Write the finished gallery under the configured download location. By default
   * each gallery gets its own subfolder; merged downloads (mergeFolder set) share
   * one folder so Kavita groups them into a single series:
   *   <downloadLocation>/<Doujin Name>/Doujin Name.cbz      (cbz)
   *   <downloadLocation>/<Merged Series>/ch01 <Chapter>.cbz  (merged cbz)
   *   <downloadLocation>/<Doujin Name>/001.jpg, …           (folder)
   */
  private outputDestination(row: DownloadRow, gallery: DoujinGallery, settings: DownloaderSettings): string {
    if (row.mergeFolder && row.outputFormat === 'folder') throw new Error('Merged downloads require CBZ output');
    const base = path.resolve(settings.downloadDirectory);
    const name = galleryFilesystemName(gallery.title, row.source, gallery.galleryId);
    const dir = row.mergeFolder ? path.join(base, sanitizeFilename(row.mergeFolder, 'merged')) : path.join(base, name);
    if (row.outputFormat === 'folder') return dir;
    const prefix = row.chapterNumber != null ? `ch${String(row.chapterNumber).padStart(2, '0')} ` : '';
    return path.join(dir, `${prefix}${name}.cbz`);
  }

  private async writeOutput(
    row: DownloadRow,
    gallery: DoujinGallery,
    images: { name: string; path: string }[],
    settings: DownloaderSettings,
    ctx: RunContext,
  ): Promise<string> {
    if (row.mergeFolder && row.outputFormat === 'folder') {
      throw new Error('Merged downloads require CBZ output');
    }
    const base = path.resolve(settings.downloadDirectory);
    const destination = this.outputDestination(row, gallery, settings);
    const dir = row.outputFormat === 'folder' ? destination : path.dirname(destination);
    if (ctx.cancelled) throw new Error('Cancelled by user');
    fs.mkdirSync(base, { recursive: true });
    // Stage on the destination volume; cancellation never touches published files.
    const stagingDir = await fs.promises.mkdtemp(path.join(base, '.htosho-download-'));
    const comicInfo = generateComicInfoXml(gallery, this.mergeOptions(row));
    try {
      if (row.outputFormat === 'folder') {
        await mapLimit(images, 4, (img) => fs.promises.copyFile(img.path, path.join(stagingDir, img.name)));
        await fs.promises.writeFile(path.join(stagingDir, 'ComicInfo.xml'), comicInfo);
        if (ctx.cancelled) throw new Error('Cancelled by user');
        ctx.committing = true;
        fs.mkdirSync(dir, { recursive: true });
        // Preserve unrelated files in an existing gallery folder.
        for (const name of [...images.map((img) => img.name), 'ComicInfo.xml']) {
          await replacePublishedFile(path.join(stagingDir, name), path.join(dir, name));
        }
        return dir;
      }

      const file = destination;
      const stagedFile = path.join(stagingDir, 'archive.cbz');
      await buildZipFromFiles(images, stagedFile, [{ name: 'ComicInfo.xml', data: Buffer.from(comicInfo, 'utf8') }]);
      if (ctx.cancelled) throw new Error('Cancelled by user');
      const publish = async () => {
        const current = this.readRow(row.id);
        const mergeJob = current?.mergeJobId != null ? jobQueue.get(current.mergeJobId) : null;
        if (mergeJob && (mergeJob.validationError || mergeJob.status==='failed' || mergeJob.status==='cancelled')) throw new Error(mergeJob.status==='cancelled' ? 'Cancelled by user' : 'Merge job cannot authorize this download publication; retry the merge after reviewing its failure');
        if (row.mergeFolder || mergeJob) {
          const conn = getKavitaConnection();
          if (!conn.baseUrl || !conn.apiKey) throw new Error('Kavita is required to verify merged download protection');
          const client = new KavitaClient(conn.baseUrl,conn.apiKey);
          const request = mergeJob ? {seriesId:mergeJob.payload.seriesId,targetDir:mergeJob.payload.targetDir,sourceFiles:mergeJob.payload.sourceFiles,sourceSeriesIds:mergeJob.payload.sourceSeriesIds,seriesName:mergeJob.payload.seriesName}
            : {targetDir:dir,seriesName:row.mergeFolder!};
          const checked = await resolveMergeProtection(client,request,mergeJob?.payload.mergeProtection);
          requireMergeProtection(checked.preview);
          if (mergeJob) jobQueue.updateMergeState(mergeJob.id,{mergeProtection:checked.state});
        }
        if (ctx.cancelled) throw new Error('Cancelled by user');
        ctx.committing = true;
        fs.mkdirSync(dir, { recursive: true });
        await replacePublishedFile(stagedFile, file);
        return file;
      };
      // Legacy direct-merge tasks acquire library BEFORE archive ownership and
      // only after pages/packing finish. New jobs publish protected targets in
      // the executor; their downloads only publish independent staging files.
      if (row.mergeFolder) return await libraryMutations.run(['*'],()=>archiveMutations.run([archiveResource(dir),...(row.outputPath ? [archiveResource(row.outputPath)] : [])],publish,ctx.controller.signal),ctx.controller.signal);
      return await publish();
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
    }
  }

  /** ComicInfo overrides for merged downloads: shared series name + manual chapter number. */
  private mergeOptions(row: DownloadRow): { seriesName?: string; number?: string } | undefined {
    if (!row.mergeFolder && row.chapterNumber == null) return undefined;
    return {
      ...(row.mergeFolder ? { seriesName: row.mergeFolder } : {}),
      ...(row.chapterNumber != null ? { number: String(row.chapterNumber) } : {}),
    };
  }

}


function pickLiveFields(t: DownloadTask): LiveFields {
  return {
    progressCurrent: t.progressCurrent,
    progressTotal: t.progressTotal,
    speed: t.speed,
    currentFile: t.currentFile,
    bytesCurrent: t.bytesCurrent,
    bytesTotal: t.bytesTotal,
    revision: t.revision,
    phase: t.phase,
  };
}

/** Shared singleton wired to live settings at construction time. */
export const downloadQueue = new DownloadQueue(() => getDownloaderSettings());

jobQueue.registerMergeDownloadCanceller(jobId=>{
  for (const task of getDb().select({id:schema.downloadQueue.id}).from(schema.downloadQueue).where(eq(schema.downloadQueue.mergeJobId,jobId)).all()) downloadQueue.cancel(task.id);
});
