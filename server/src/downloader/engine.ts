import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getTmpDir, schema } from '../db/index.js';
import { pathContains } from '../lib/cbz.js';
import { fetchToFileStreaming, mapLimit, sleep, type StreamProgressHandlers } from '../lib/http.js';
import { generateComicInfoXml } from './comicinfo.js';
import { buildZipFromFiles } from './zip.js';
import { extFromUrl, galleryFilesystemName, padPage, sanitizeFilename } from './util.js';
import { getDoujinProvider } from './providers.js';
import type { DoujinGallery, DoujinSource } from './types.js';
import { getDownloaderSettings, type DownloaderSettings } from '../services/settings.js';
import { recordGalleryTags } from '../services/recommendations.js';

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0';

/** How many times a transiently-failed download is re-queued automatically. */
const MAX_AUTO_RETRIES = 3;
/** Cooldown before an automatic retry starts, giving the CDN time to recover. */
const AUTO_RETRY_DELAY_MS = 60_000;
/** Bounds for waiting on a Kavita scan task to finish before diffing series. */
const SCAN_COMPLETION_TIMEOUT_MS = 120_000;
const SCAN_COMPLETION_POLL_MS = 2_000;

/** True when a fetch error is transient (worth retrying with backoff). */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = /HTTP (\d{3})/.exec(err.message);
  if (m) {
    const code = parseInt(m[1], 10);
    // Rate-limit and server-side errors are transient.
    return code === 429 || (code >= 500 && code <= 504);
  }
  return /fetch failed|ECONNRESET|socket hang up|network|aborted|timeout|ENOTFOUND/i.test(err.message);
}

/**
 * Stream a URL straight to a file, retrying transient failures (429/5xx/network)
 * with growing backoff. Non-transient errors are rethrown immediately so the
 * caller can fall through to a per-page fallback without needless retries.
 * The schedule (~63s of waiting total) is long enough to ride out typical CDN
 * 503 storms, which clear within seconds to a couple of minutes. Pages land
 * complete-or-absent (`.part` + atomic rename), so a crash never leaves a
 * truncated file under the bare name the resume scan stats.
 */
async function fetchPageToFileWithRetry(
  url: string,
  headers: Record<string, string>,
  destPath: string,
  handlers: StreamProgressHandlers,
): Promise<number> {
  const attempts = 5;
  const delays = [2000, 6000, 15000, 40000];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchToFileStreaming(url, { headers }, destPath, handlers);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) throw err;
      if (i < attempts - 1) await sleep(delays[i] ?? delays[delays.length - 1]);
    }
  }
  throw lastErr;
}

/**
 * Run an async operation, retrying transient failures with the given delays.
 * Non-transient errors are rethrown immediately. Used for gallery resolution
 * and anywhere a single request can hit a CDN blip.
 */
export async function retryTransient<T>(fn: () => Promise<T>, attempts: number, delays: number[]): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i >= attempts - 1) throw err;
      await sleep(delays[i] ?? delays[delays.length - 1]);
    }
  }
  throw lastErr;
}

/**
 * Build the ordered list of candidate URLs for a page, re-resolving them against
 * the provider's *current* CDN routing state when it supports a live resolver
 * (Hitomi). Providers without one fall back to the static URL captured at
 * resolve time. `forceRefresh` asks the provider to re-fetch its routing table
 * first — used after a failure that may be caused by a rotated/stale base path.
 */
async function resolvePageCandidates(
  gallery: DoujinGallery,
  i: number,
  forceRefresh = false,
): Promise<string[]> {
  if (gallery.resolvePageUrl) {
    try {
      const r = await gallery.resolvePageUrl(i, { forceRefresh });
      if (r && typeof r.url === 'string' && r.url.length > 0) {
        return [r.url, ...(typeof r.fallback === 'string' && r.fallback ? [r.fallback] : [])];
      }
    } catch {
      /* fall through to the static URLs */
    }
  }
  const primary = gallery.pages[i];
  const fallback = gallery.pageFallbacks?.[i];
  return [primary, fallback].filter((u): u is string => typeof u === 'string' && u.length > 0);
}

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
  bytesCurrent: number;
  /** Total image bytes expected for the run (0 until known). */
  bytesTotal: number;
  outputFormat: 'cbz' | 'folder';
  outputPath: string | null;
  /** When set, the task writes into this shared folder (series merge) instead of its own per-gallery folder. */
  mergeFolder: string | null;
  /** Manual chapter number written to ComicInfo.Number for merged downloads. */
  chapterNumber: number | null;
  /** Queue priority: higher values are claimed first (ties break on id ASC). */
  priority: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface DownloadRow {
  id: number;
  source: string;
  galleryId: string;
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
  priority: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function rowToTask(row: DownloadRow): DownloadTask {
  return {
    id: row.id,
    source: row.source as DoujinSource,
    galleryId: row.galleryId,
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
    priority: row.priority ?? 0,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

/** A cancellation token checked between each image request. */
interface RunContext {
  cancelled: boolean;
  stopped: boolean;
  committing: boolean;
  pauseSignal: {
    paused: boolean;
    /** Resolvers of workers parked on the pause gate; resume()/cancel() settle them. */
    waiters: (() => void)[];
  };
}

/** Wake every worker parked on the pause gate (resume, cancel, and run teardown). */
function wakePaused(run: RunContext): void {
  for (const w of run.pauseSignal.waiters.splice(0)) w();
}

/** Volatile progress fields that update faster than the throttled DB write. */
type LiveFieldKeys = 'progressCurrent' | 'progressTotal' | 'speed' | 'currentFile' | 'bytesCurrent' | 'bytesTotal';
type LiveFields = Partial<Pick<DownloadTask, LiveFieldKeys>>;

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
  private autoRetries = new Map<number, number>();
  /** id -> pending cooldown timer that will re-queue the task. */
  private retryTimers = new Map<number, NodeJS.Timeout>();
  private listeners = new Set<(task: DownloadTask) => void>();
  private removalListeners = new Set<(ids: number[]) => void>();
  private settingsProvider: () => DownloaderSettings;

  constructor(settingsProvider: () => DownloaderSettings) {
    this.settingsProvider = settingsProvider;
  }
  /** Recover persistent queue state after process startup, then run queued work. */
  start(): void {
    // A previous process may have died mid-download. Its partial page files are
    // still in the task's tmpDir, so re-queue instead of failing — the run
    // resumes from the first missing page file.
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'queued', speed: null, currentFile: null, errorMessage: null, startedAt: null })
      .where(eq(schema.downloadQueue.status, 'downloading'))
      .run();
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

  /** Task with any fresher in-memory progress fields overlaid on the DB row. */
  get(id: number): DownloadTask | null {
    const base = this.readRow(id);
    if (!base) return null;
    const live = this.live.get(id);
    if (!live) return base;
    return { ...base, ...pickLiveFields(live) };
  }

  list(limit = 100): DownloadTask[] {
    const rows = getDb()
      .select()
      .from(schema.downloadQueue)
      .orderBy(desc(schema.downloadQueue.id))
      .limit(limit)
      .all();
    return rows.map((row) => {
      const task = rowToTask(row);
      const live = this.live.get(task.id);
      return live ? { ...task, ...pickLiveFields(live) } : task;
    });
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
      db.update(schema.downloadQueue).set({ status, startedAt: new Date().toISOString() }).where(eq(schema.downloadQueue.id, id)).run();
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
    if (t) this.live.set(id, t);
    else this.live.delete(id);
    if (t) this.broadcast(t);
  }

  /**
   * Merge volatile progress fields into the in-memory snapshot, then fan out to
   * subscribers and persist to SQLite — each on its own throttle so high-frequency
   * byte-level updates stay smooth without overloading the database.
   */
  private updateProgress(id: number, patch: LiveFields, opts?: { force?: boolean }): void {
    let snap = this.live.get(id);
    if (!snap) {
      const base = this.readRow(id);
      if (!base) return;
      snap = { ...base };
    }
    const merged = { ...snap, ...patch };
    this.live.set(id, merged);

    const now = Date.now();
    const lastB = this.lastBroadcast.get(id) ?? 0;
    if (opts?.force || now - lastB >= 80) {
      this.broadcast(merged);
      this.lastBroadcast.set(id, now);
    }
    const lastW = this.lastWrite.get(id) ?? 0;
    if (opts?.force || now - lastW >= 250) {
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

  /** Cancel: stop an in-flight job and mark it failed/cancelled. */
  cancel(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (this.activeRuns.get(id)?.committing) return false;
    if (task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') {
      const run = this.activeRuns.get(id);
      if (run) {
        run.cancelled = true;
        // A worker parked on the pause gate must exit promptly.
        wakePaused(run);
      }
      getDb().update(schema.downloadQueue).set({ errorMessage: 'Cancelled by user' }).where(eq(schema.downloadQueue.id, id)).run();
      this.setStatus(id, 'failed');
      return true;
    }
    return false;
  }

  /**
   * Re-queue a task that failed on a transient error (CDN 503/timeout) after a
   * cooldown, up to MAX_AUTO_RETRIES times. The row stays visible as "failed"
   * with an auto-retry note until the timer flips it back to "queued"; a manual
   * retry or delete supersedes the pending timer via status guards.
   */
  private scheduleAutoRetry(id: number, message: string): void {
    const count = (this.autoRetries.get(id) ?? 0) + 1;
    if (count > MAX_AUTO_RETRIES) {
      this.setStatus(id, 'failed');
      return;
    }
    this.autoRetries.set(id, count);
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'failed', finishedAt: new Date().toISOString(), errorMessage: `${message} (auto-retry ${count}/${MAX_AUTO_RETRIES} in ~1 min)` })
      .where(eq(schema.downloadQueue.id, id))
      .run();
    this.syncLive(id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      const t = this.readRow(id);
      if (!t || t.status !== 'failed') return; // user retried or deleted meanwhile
      getDb()
        .update(schema.downloadQueue)
        .set({ status: 'queued', speed: null, currentFile: null, errorMessage: null, startedAt: null, finishedAt: null })
        .where(eq(schema.downloadQueue.id, id))
        .run();
      this.syncLive(id);
      void this.pump();
    }, AUTO_RETRY_DELAY_MS);
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
    if (this.activeRuns.has(id)) return false;
    this.autoRetries.delete(id);
    const pending = this.retryTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.retryTimers.delete(id);
    }
    this.live.delete(id);
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'queued', speed: null, currentFile: null, errorMessage: null, startedAt: null, finishedAt: null })
      .where(eq(schema.downloadQueue.id, id))
      .run();
    void this.pump();
    return true;
  }

  /** Delete a task and its scratch directory. Active callers must cancel first. */
  remove(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    getDb().delete(schema.downloadQueue).where(eq(schema.downloadQueue.id, id)).run();
    this.live.delete(id);
    this.autoRetries.delete(id);
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
    return row ? this.get(row.id) : null;
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
          inArray(schema.downloadQueue.status, ['queued', 'downloading', 'paused']),
        ),
      )
      .orderBy(desc(schema.downloadQueue.id))
      .limit(1)
      .get();
    return row ? this.get(row.id) : null;
  }

  /** Every completed gallery (newest first) — powers the "already downloaded" badges. */
  completedGalleries(): { source: string; galleryId: string; title: string | null; finishedAt: string | null }[] {
    return getDb()
      .select()
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, 'completed'))
      .orderBy(desc(schema.downloadQueue.id))
      .all()
      .map((r) => ({ source: r.source, galleryId: r.galleryId, title: r.title, finishedAt: r.finishedAt }));
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

  private async process(row: DownloadRow): Promise<void> {
    const ctx: RunContext = { cancelled: false, stopped: false, committing: false, pauseSignal: { paused: false, waiters: [] } };
    this.activeRuns.set(row.id, ctx);
    // Per-task scratch space: pages stream to disk here so only the in-flight
    // images (bounded by maxImageConcurrency) live in RAM.
    const tmpDir = path.join(getTmpDir(), 'downloads', String(row.id));
    try {
      const settings = this.settingsProvider();
      if (!settings.downloadDirectory) {
        throw new Error('No download directory configured. Set an output folder in Settings first.');
      }
      const provider = getDoujinProvider(row.source);
      if (!provider) throw new Error(`Unknown source: ${row.source}`);

      // Resolve the full gallery (metadata + image list).
      this.updateProgress(row.id, { progressCurrent: 0, progressTotal: 0, speed: 0, currentFile: 'Resolving gallery…', bytesCurrent: 0, bytesTotal: 0 }, { force: true });
      const gallery = await retryTransient(() => provider.getGallery(row.galleryId), 4, [2000, 10000, 30000]);
      if (ctx.cancelled) throw new Error('Cancelled by user');
      const total = gallery.pages.length;
      if (!total) throw new Error('Gallery has no downloadable pages.');
      this.updateProgress(row.id, { progressCurrent: 0, progressTotal: total, speed: 0, currentFile: null, bytesCurrent: 0, bytesTotal: 0 }, { force: true });

      // Download all pages with bounded concurrency + rate limiting (streamed for live progress).
      const images = await this.downloadPages(gallery, row.id, settings, ctx, tmpDir);

      // Write to disk (cbz or folder) and record the output path.
      this.updateProgress(row.id, { currentFile: 'Packing archive…' }, { force: true });
      const outputPath = await this.writeOutput(row, gallery, images, settings, ctx);
      getDb().update(schema.downloadQueue).set({ outputPath }).where(eq(schema.downloadQueue.id, row.id)).run();

      // The output is final: the scratch pages are no longer needed. On failure
      // the tmpDir is deliberately kept so a retry can resume from partial data.
      // Cleanup completes before the 'completed' status is published so nothing
      // observes a completed task whose scratch dir is still on disk.
      await fs.promises.rm(tmpDir, { recursive: true, force: true });

      this.setStatus(row.id, 'completed');
      // Only completed downloads are taste signals. Failed or cancelled work
      // must not permanently bias the recommendation profile.
      recordGalleryTags(row.source as DoujinSource, gallery);
      this.updateProgress(row.id, { progressCurrent: total, progressTotal: total, speed: 0, currentFile: null }, { force: true });

      // Optional Kavita auto-sync.
      if (settings.autoSyncKavita) await this.triggerKavitaScan(outputPath);
    } catch (e) {
      ctx.stopped = true;
      wakePaused(ctx);
      const message = ctx.cancelled ? 'Cancelled by user' : e instanceof Error ? e.message : String(e);
      getDb().update(schema.downloadQueue).set({ errorMessage: message, speed: 0 }).where(eq(schema.downloadQueue.id, row.id)).run();
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
      const final = this.readRow(row.id);
      if (final) this.broadcast(final);
    }
  }

  private async downloadPages(
    gallery: DoujinGallery,
    taskId: number,
    settings: DownloaderSettings,
    ctx: RunContext,
    tmpDir: string,
  ): Promise<{ name: string; path: string }[]> {
    const pages = gallery.pages;
    const total = pages.length;
    const concurrency = Math.max(1, settings.maxImageConcurrency || 1);
    const delay = Math.max(0, settings.requestDelayMs || 0);
    const pageHeaders: Record<string, string> = { 'User-Agent': UA, ...gallery.requestHeaders };
    fs.mkdirSync(tmpDir, { recursive: true });
    const out: { name: string; path: string }[] = new Array(total);

    // Resume-from-partial: page files from an earlier attempt live in tmpDir as
    // bare index names ("0", "1", …). Trust only a consecutive prefix starting
    // at index 0 — parallel workers can leave interior holes, so anything past
    // the first missing file is re-downloaded (overwriting a stale extra file
    // is harmless). Valid files become part of the result without a re-fetch.
    // Pages land complete-or-absent (fetch writes to `i.part`, atomic rename to
    // `i`), so an interrupted fetch never shows up here — leftover `.part`
    // files are simply never counted.
    const resumedSizes = new Map<number, number>();
    for (let i = 0; i < total; i++) {
      try {
        const st = await fs.promises.stat(path.join(tmpDir, String(i)));
        if (!st.isFile() || st.size <= 0) break;
        resumedSizes.set(i, st.size);
      } catch {
        break;
      }
    }
    for (const [i] of resumedSizes) {
      out[i] = { name: `${padPage(i + 1, total)}.${extFromUrl(pages[i])}`, path: path.join(tmpDir, String(i)) };
    }

    // Per-run byte-level accounting used to derive a live bytes-current/total.
    const bs = {
      actual: new Map<number, number>(), // index -> final page size
      inflight: new Map<number, number>(), // index -> partial bytes received
      known: new Map<number, number>(), // index -> content-length (when the server reports it)
      completed: new Set<number>(),
      lastT: Date.now(),
      lastBytes: 0,
      ema: 0,
    };
    // Seed the byte accounting with the resumed pages so speed/bytes never
    // report a spurious re-download of data already on disk.
    for (const [i, size] of resumedSizes) {
      bs.actual.set(i, size);
      bs.completed.add(i);
    }
    const currentBytes = (): number => {
      let sum = 0;
      for (const v of bs.actual.values()) sum += v;
      for (const [i, v] of bs.inflight) {
        const cap = bs.known.get(i);
        sum += cap ? Math.min(v, cap) : v;
      }
      return sum;
    };
    // Baseline the speed window at the resumed byte total so the EMA does not
    // spike on the first tick after a resume.
    bs.lastBytes = currentBytes();

    const estimateTotal = (): number => {
      const completedCount = bs.completed.size;
      let completedBytes = 0;
      for (const v of bs.actual.values()) completedBytes += v;
      const avg = completedCount > 0 ? completedBytes / completedCount : 0;
      let est = 0;
      for (let i = 0; i < total; i++) {
        if (bs.completed.has(i)) est += bs.actual.get(i) ?? 0;
        else if (bs.known.has(i)) est += bs.known.get(i) ?? 0;
        else est += avg;
      }
      return Math.max(Math.round(est), Math.round(currentBytes()));
    };

    const speed = (): number => {
      const now = Date.now();
      const dt = (now - bs.lastT) / 1000;
      if (dt > 0.05) {
        const cur = currentBytes();
        const inst = Math.max(0, (cur - bs.lastBytes) / dt);
        bs.ema = bs.ema === 0 ? inst : bs.ema * 0.6 + inst * 0.4;
        bs.lastT = now;
        bs.lastBytes = cur;
      }
      return Math.round(bs.ema);
    };

    let lastFileName: string | null = null;
    // Pages download concurrently, so the raw "last network event" would make
    // the label bounce backwards within the in-flight window (e.g. a late chunk
    // from page 83 after page 87). Track the frontier — the highest page index
    // touched so far — which only ever moves forward.
    let frontier = resumedSizes.size;
    let lastReport = 0;
    const touchPage = (i: number): void => {
      if (i + 1 > frontier) frontier = i + 1;
      lastFileName = `Page ${frontier}/${total}`;
    };
    const report = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastReport < 100) return;
      lastReport = now;
      this.updateProgress(
        taskId,
        {
          progressCurrent: bs.completed.size,
          progressTotal: total,
          speed: speed(),
          currentFile: lastFileName,
          bytesCurrent: Math.round(currentBytes()),
          bytesTotal: estimateTotal(),
        },
        { force },
      );
    };

    const onChunk = (i: number, received: number, totalBytes: number | null): void => {
      if (totalBytes && totalBytes > 0) bs.known.set(i, totalBytes);
      bs.inflight.set(i, received);
      touchPage(i);
      report(false);
    };

    const onPageDone = (i: number, size: number): void => {
      bs.actual.set(i, size);
      bs.completed.add(i);
      bs.inflight.delete(i);
      touchPage(i);
      report(true);
    };

    let nextIndex = resumedSizes.size;
    const worker = async (): Promise<void> => {
      while (true) {
        if (ctx.cancelled) throw new Error('Cancelled by user');
        if (ctx.stopped) return;
        if (ctx.pauseSignal.paused) {
          // Park until resume()/cancel() settles the pause gate — event-driven,
          // so a paused run costs no polling timers and wakes the instant it
          // is resumed or cancelled.
          await new Promise<void>((resolve) => ctx.pauseSignal.waiters.push(resolve));
          if (ctx.cancelled) throw new Error('Cancelled by user');
          if (ctx.stopped) return;
          continue;
        }
        const i = nextIndex++;
        if (i >= total) break;
        // Re-resolve the page URL against the provider's *current* CDN routing
        // state right before fetching, so long downloads survive base-path
        // rotation. If both primary and fallback fail, force a routing-table
        // refresh (the CDN may have rotated) and try once more before giving up.
        // Each candidate streams straight to the page's final temp name via
        // `.part` + atomic rename, so only `concurrency` images transit RAM and
        // the resume scan never sees a truncated page.
        const filePath = path.join(tmpDir, String(i));
        let size: number | null = null;
        let usedUrl: string | null = null;
        let lastErr: unknown = null;
        for (const force of [false, true]) {
          if (ctx.cancelled) throw new Error('Cancelled by user');
          if (ctx.stopped) return;
          if (force) await sleep(30_000); // let a CDN storm clear before re-resolving URLs
          if (ctx.cancelled) throw new Error('Cancelled by user');
          if (ctx.stopped) return;
          const candidates = await resolvePageCandidates(gallery, i, force);
          for (const url of candidates) {
            if (ctx.cancelled) throw new Error('Cancelled by user');
            if (ctx.stopped) return;
            try {
              size = await fetchPageToFileWithRetry(url, pageHeaders, filePath, {
                onAttemptStart: () => {
                  bs.inflight.set(i, 0);
                },
                onProgress: (received, totalBytes) => onChunk(i, received, totalBytes),
              });
              usedUrl = url;
              break;
            } catch (err) {
              lastErr = err;
            }
          }
          if (size != null) break;
        }
        if (size == null) throw lastErr instanceof Error ? lastErr : new Error(`Failed to download page ${i + 1}`);
        const name = `${padPage(i + 1, total)}.${extFromUrl(usedUrl ?? pages[i])}`;
        out[i] = { name, path: filePath };
        onPageDone(i, size);
        if (delay > 0) await sleep(delay);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker().catch((error) => {
      ctx.stopped = true;
      wakePaused(ctx);
      throw error;
    }));
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    this.updateProgress(
      taskId,
      {
        progressCurrent: bs.completed.size,
        progressTotal: total,
        speed: 0,
        currentFile: null,
        bytesCurrent: Math.round(currentBytes()),
        bytesTotal: estimateTotal(),
      },
      { force: true },
    );
    return out;
  }

  /**
   * Write the finished gallery under the configured download location. By default
   * each gallery gets its own subfolder; merged downloads (mergeFolder set) share
   * one folder so Kavita groups them into a single series:
   *   <downloadLocation>/<Doujin Name>/Doujin Name.cbz      (cbz)
   *   <downloadLocation>/<Merged Series>/ch01 <Chapter>.cbz  (merged cbz)
   *   <downloadLocation>/<Doujin Name>/001.jpg, …           (folder)
   */
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
    const galleryName = galleryFilesystemName(gallery.title, row.source, gallery.galleryId);
    const dir = row.mergeFolder
      ? path.join(base, sanitizeFilename(row.mergeFolder, 'merged'))
      : path.join(base, galleryName);
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

      const chapterPrefix = row.chapterNumber != null ? `ch${String(row.chapterNumber).padStart(2, '0')} ` : '';
      const file = path.join(dir, `${chapterPrefix}${galleryName}.cbz`);
      const stagedFile = path.join(stagingDir, 'archive.cbz');
      await buildZipFromFiles(images, stagedFile, [{ name: 'ComicInfo.xml', data: Buffer.from(comicInfo, 'utf8') }]);
      if (ctx.cancelled) throw new Error('Cancelled by user');
      ctx.committing = true;
      fs.mkdirSync(dir, { recursive: true });
      await replacePublishedFile(stagedFile, file);
      return file;
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

  /**
   * Best-effort Kavita rescan so newly written media appears immediately, then
   * match exactly the series the rescan registered (existing ones untouched).
   */
  private async triggerKavitaScan(outputPath: string): Promise<void> {
    try {
      // Lazy imports: the Kavita client and sync services are only needed when
      // auto-sync is on; static imports would drag settings/job deps into every
      // engine import (and their module side effects into tests).
      const { getKavitaConnection } = await import('../services/settings.js');
      const conn = getKavitaConnection();
      if (!conn.baseUrl || !conn.apiKey) return;
      const { KavitaClient } = await import('../kavita/client.js');
      const client = new KavitaClient(conn.baseUrl, conn.apiKey);
      // If a specific library path contains our output, scan just that one.
      const libraries = await client.getLibraries();
      const matched = libraries.find((l) => l.path && pathContains(l.path, outputPath));
      if (!matched) {
        await client.scanAllLibraries();
        return; // Library unknown — the periodic scan picks up whatever appears.
      }
      // Snapshot current series so only what this rescan adds gets matched.
      const seen = new Set((await client.getSeries(matched.id)).map((s) => s.id));
      // Scan just the folder this download wrote into (the .cbz's parent folder
      // for archive output) — far cheaper than a whole-library scan.
      const outputDir = outputPath.toLowerCase().endsWith('.cbz') ? path.dirname(outputPath) : outputPath;
      await client.scanFolder(matched.id, outputDir);
      // Kavita runs scans as background tasks; wait for the task queue to drain
      // before diffing the series list, otherwise the new entry is not visible yet.
      const deadline = Date.now() + SCAN_COMPLETION_TIMEOUT_MS;
      for (;;) {
        let running: boolean;
        try {
          running = await client.isTaskRunning();
        } catch {
          break; // status endpoint unreachable — proceed best-effort
        }
        if (!running || Date.now() >= deadline) break;
        await sleep(SCAN_COMPLETION_POLL_MS);
      }
      const { enqueueMatchForNewSeries } = await import('../services/sync.js');
      const fresh = await enqueueMatchForNewSeries(client, matched.id, seen);
      if (fresh.length > 0) console.log(`[h-tosho] auto-matching ${fresh.length} new series in "${matched.name}"`);
    } catch {
      // Auto-sync is best-effort; never fail the download over it.
    }
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
  };
}

/** Shared singleton wired to live settings at construction time. */
export const downloadQueue = new DownloadQueue(() => getDownloaderSettings());
