import { and, desc, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getTmpDir, schema } from '../db/index.js';
import { fetchBufferStreaming, sleep, type StreamProgressHandlers } from '../lib/http.js';
import { generateComicInfoXml } from './comicinfo.js';
import { buildZipFromFiles } from './zip.js';
import { extFromUrl, padPage, sanitizeFilename } from './util.js';
import { getDoujinProvider } from './providers.js';
import type { DoujinGallery, DoujinSource } from './types.js';
import { getDownloaderSettings, type DownloaderSettings } from '../services/settings.js';

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

/** True when a fetch error is transient (worth retrying with backoff). */
function isTransientError(err: unknown): boolean {
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
 * Stream a URL into a Buffer, retrying transient failures (429/5xx/network)
 * with exponential backoff. Non-transient errors are rethrown immediately so the
 * caller can fall through to a per-page fallback without needless retries.
 */
async function fetchPageWithRetry(url: string, headers: Record<string, string>, handlers: StreamProgressHandlers): Promise<Buffer> {
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchBufferStreaming(url, { headers }, handlers);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) throw err;
      if (i < attempts - 1) await sleep(600 * 2 ** i);
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
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** A cancellation token checked between each image request. */
interface RunContext {
  cancelled: boolean;
  pauseSignal: { paused: boolean };
}

/** Volatile progress fields that update faster than the throttled DB write. */
type LiveFieldKeys = 'progressCurrent' | 'progressTotal' | 'speed' | 'currentFile' | 'bytesCurrent' | 'bytesTotal';
type LiveFields = Partial<Pick<DownloadTask, LiveFieldKeys>>;

class DownloadQueue {
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
  private listeners = new Set<(task: DownloadTask) => void>();
  private settingsProvider: () => DownloaderSettings;

  constructor(settingsProvider: () => DownloaderSettings) {
    this.settingsProvider = settingsProvider;
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

  // ---------------- CRUD / state machine ----------------

  enqueue(
    source: DoujinSource,
    galleryId: string,
    title: string | null,
    outputFormat?: 'cbz' | 'folder',
    mergeFolder?: string,
    chapterNumber?: number,
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

  /** Resume a paused/failed task back into the queue. */
  resume(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status === 'paused' || task.status === 'failed') {
      const run = this.activeRuns.get(id);
      if (run) {
        // The original worker is still alive, sleeping on the pause signal —
        // wake it in place instead of re-queueing (which would start a second
        // download of the same gallery and leak the first run's concurrency slot).
        run.pauseSignal.paused = false;
        this.setStatus(id, 'downloading');
        return true;
      }
      this.setStatus(id, 'queued');
      void this.pump();
      return true;
    }
    return false;
  }

  /** Cancel: stop an in-flight job and mark it failed/cancelled. */
  cancel(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') {
      const run = this.activeRuns.get(id);
      if (run) run.cancelled = true;
      getDb().update(schema.downloadQueue).set({ errorMessage: 'Cancelled by user' }).where(eq(schema.downloadQueue.id, id)).run();
      this.setStatus(id, 'failed');
      return true;
    }
    return false;
  }

  /** Re-run a failed/completed task from scratch. */
  retry(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status !== 'failed' && task.status !== 'completed') return false;
    this.live.delete(id);
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'queued', progressCurrent: 0, speed: null, currentFile: null, bytesCurrent: 0, bytesTotal: 0, errorMessage: null, startedAt: null, finishedAt: null })
      .where(eq(schema.downloadQueue.id, id))
      .run();
    void this.pump();
    return true;
  }

  remove(id: number): boolean {
    getDb().delete(schema.downloadQueue).where(eq(schema.downloadQueue.id, id)).run();
    this.live.delete(id);
    return true;
  }

  /** Delete all completed tasks. */
  clearCompleted(): number {
    const db = getDb();
    const res = db.delete(schema.downloadQueue).where(eq(schema.downloadQueue.status, 'completed')).run();
    return Number(res.changes ?? 0);
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
        .orderBy(desc(schema.downloadQueue.id))
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
    const ctx: RunContext = { cancelled: false, pauseSignal: { paused: false } };
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
      const gallery = await provider.getGallery(row.galleryId);
      const total = gallery.pages.length;
      if (!total) throw new Error('Gallery has no downloadable pages.');
      this.updateProgress(row.id, { progressCurrent: 0, progressTotal: total, speed: 0, currentFile: null, bytesCurrent: 0, bytesTotal: 0 }, { force: true });

      // Download all pages with bounded concurrency + rate limiting (streamed for live progress).
      const images = await this.downloadPages(gallery, row.id, settings, ctx, tmpDir);

      // Write to disk (cbz or folder) and record the output path.
      this.updateProgress(row.id, { currentFile: 'Packing archive…' }, { force: true });
      const outputPath = await this.writeOutput(row, gallery, images, settings);
      getDb().update(schema.downloadQueue).set({ outputPath }).where(eq(schema.downloadQueue.id, row.id)).run();

      this.setStatus(row.id, 'completed');
      this.updateProgress(row.id, { progressCurrent: total, progressTotal: total, speed: 0, currentFile: null }, { force: true });

      // Optional Kavita auto-sync.
      if (settings.autoSyncKavita) await this.triggerKavitaScan(outputPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      getDb().update(schema.downloadQueue).set({ errorMessage: message, speed: 0 }).where(eq(schema.downloadQueue.id, row.id)).run();
      if (!ctx.cancelled) this.setStatus(row.id, 'failed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // Drop the in-memory snapshot so subsequent reads reflect the authoritative DB state.
      this.live.delete(row.id);
      this.lastBroadcast.delete(row.id);
      this.lastWrite.delete(row.id);
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
    const fallbacks = gallery.pageFallbacks ?? [];
    const total = pages.length;
    const concurrency = Math.max(1, settings.maxImageConcurrency || 1);
    const delay = Math.max(0, settings.requestDelayMs || 0);
    const pageHeaders: Record<string, string> = { 'User-Agent': UA, ...gallery.requestHeaders };
    fs.mkdirSync(tmpDir, { recursive: true });
    const out: { name: string; path: string }[] = new Array(total);

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

    const currentBytes = (): number => {
      let sum = 0;
      for (const v of bs.actual.values()) sum += v;
      for (const [i, v] of bs.inflight) {
        const cap = bs.known.get(i);
        sum += cap ? Math.min(v, cap) : v;
      }
      return sum;
    };

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
    let frontier = 0;
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

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (ctx.cancelled) throw new Error('Cancelled by user');
        if (ctx.pauseSignal.paused) {
          // Wait until resumed or cancelled.
          await sleep(250);
          continue;
        }
        const i = nextIndex++;
        if (i >= total) break;
        // Re-resolve the page URL against the provider's *current* CDN routing
        // state right before fetching, so long downloads survive base-path
        // rotation. If both primary and fallback fail, force a routing-table
        // refresh (the CDN may have rotated) and try once more before giving up.
        let data: Buffer | null = null;
        let usedUrl: string | null = null;
        let lastErr: unknown = null;
        for (const force of [false, true]) {
          const candidates = await resolvePageCandidates(gallery, i, force);
          for (const url of candidates) {
            try {
              data = await fetchPageWithRetry(url, pageHeaders, {
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
          if (data) break;
        }
        if (!data) throw lastErr instanceof Error ? lastErr : new Error(`Failed to download page ${i + 1}`);
        const name = `${padPage(i + 1, total)}.${extFromUrl(usedUrl ?? pages[i])}`;
        // Persist the page immediately so only `concurrency` images live in RAM.
        const filePath = path.join(tmpDir, String(i));
        await fs.promises.writeFile(filePath, data);
        out[i] = { name, path: filePath };
        onPageDone(i, data.length);
        if (delay > 0) await sleep(delay);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);
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
  ): Promise<string> {
    const base = path.resolve(settings.downloadDirectory);
    const galleryName = sanitizeFilename(gallery.title || `Gallery ${gallery.galleryId}`, `Gallery-${gallery.galleryId}`);
    const dir = row.mergeFolder
      ? path.join(base, sanitizeFilename(row.mergeFolder, 'merged'))
      : path.join(base, galleryName);
    fs.mkdirSync(dir, { recursive: true });
    const comicInfo = generateComicInfoXml(gallery, this.mergeOptions(row));

    if (settings.format === 'folder') {
      for (const img of images) {
        await moveIntoPlace(img.path, path.join(dir, img.name));
      }
      fs.writeFileSync(path.join(dir, 'ComicInfo.xml'), comicInfo);
      return dir;
    }

    // cbz: stream all pages + ComicInfo.xml into a single archive inside the folder.
    const chapterPrefix = row.chapterNumber != null ? `ch${String(row.chapterNumber).padStart(2, '0')} ` : '';
    const file = path.join(dir, `${chapterPrefix}${galleryName}.cbz`);
    await buildZipFromFiles(images, file, [{ name: 'ComicInfo.xml', data: Buffer.from(comicInfo, 'utf8') }]);
    return file;
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
      const { getKavitaConnection } = await import('../services/settings.js');
      const conn = getKavitaConnection();
      if (!conn.baseUrl || !conn.apiKey) return;
      const { KavitaClient } = await import('../kavita/client.js');
      const client = new KavitaClient(conn.baseUrl, conn.apiKey);
      // If a specific library path contains our output, scan just that one.
      // Normalize separators first — Kavita reports '/' while Windows paths use '\\'.
      const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/');
      const libraries = await client.getLibraries();
      const matched = libraries.find((l) => l.path && norm(outputPath).startsWith(norm(l.path)));
      if (!matched) {
        await client.scanAllLibraries();
        return; // Library unknown — the periodic scan picks up whatever appears.
      }
      // Snapshot current series so only what this rescan adds gets matched.
      const seen = new Set((await client.getSeries(matched.id)).map((s) => s.id));
      await client.scanLibrary(matched.id);
      const { enqueueMatchForNewSeries } = await import('../services/sync.js');
      const fresh = await enqueueMatchForNewSeries(client, matched.id, seen);
      if (fresh.length > 0) console.log(`[h-tosho] auto-matching ${fresh.length} new series in "${matched.name}"`);
    } catch {
      // Auto-sync is best-effort; never fail the download over it.
    }
  }
}

/** Move a temp page into its final location, copying across volumes where rename cannot. */
async function moveIntoPlace(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch {
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
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