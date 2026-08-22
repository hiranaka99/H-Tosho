import { desc, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, schema } from '../db/index.js';
import { fetchBuffer, sleep } from '../lib/http.js';
import { generateComicInfoXml } from './comicinfo.js';
import { buildZip } from './zip.js';
import { extFromUrl, padPage, sanitizeFilename } from './util.js';
import { getDoujinProvider } from './providers.js';
import type { DownloadProgress, DoujinGallery, DoujinSource } from './types.js';
import { getDownloaderSettings, getKavitaConnection, type DownloaderSettings } from '../services/settings.js';
import { KavitaClient } from '../kavita/client.js';

/**
 * Doujinshi download queue engine.
 *
 * Manages gallery download jobs with a small state machine
 * (queued -> downloading -> completed | failed | paused), bounded concurrency,
 * per-request rate limiting, progress tracking (pages / speed / current file),
 * and writes either a .cbz archive or a raw image folder + ComicInfo.xml.
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

/** Fetch a URL, retrying transient errors (rate limits / 5xx) with backoff. */
async function fetchWithRetry(url: string, headers: Record<string, string>, maxAttempts = 5): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchBuffer(url, { headers });
    } catch (err) {
      lastErr = err;
      const transient = isTransientError(err);
      if (!transient || attempt === maxAttempts - 1) throw err;
      // Back off longer when the CDN explicitly rate-limits us (429/503).
      const rateLimited = /HTTP (429|503)/.test(String((err as Error).message));
      await sleep((rateLimited ? 1500 : 500) * 2 ** attempt);
    }
  }
  throw lastErr;
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
  outputFormat: 'cbz' | 'folder';
  outputPath: string | null;
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
  outputFormat: string;
  outputPath: string | null;
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
    outputFormat: (row.outputFormat as 'cbz' | 'folder') ?? 'cbz',
    outputPath: row.outputPath,
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

class DownloadQueue {
  private running = 0;
  private pumping = false;
  /** id -> live run context (used for cancel/pause of in-flight jobs). */
  private activeRuns = new Map<number, RunContext>();
  private settingsProvider: () => DownloaderSettings;

  constructor(settingsProvider: () => DownloaderSettings) {
    this.settingsProvider = settingsProvider;
  }

  // ---------------- CRUD / state machine ----------------

  enqueue(source: DoujinSource, galleryId: string, title: string | null, outputFormat?: 'cbz' | 'folder'): number {
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
      })
      .run();
    const id = Number(res.lastInsertRowid);
    void this.pump();
    return id;
  }

  get(id: number): DownloadTask | null {
    const row = getDb().select().from(schema.downloadQueue).where(eq(schema.downloadQueue.id, id)).get();
    return row ? rowToTask(row) : null;
  }

  list(limit = 100): DownloadTask[] {
    const rows = getDb()
      .select()
      .from(schema.downloadQueue)
      .orderBy(desc(schema.downloadQueue.id))
      .limit(limit)
      .all();
    return rows.map(rowToTask);
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
  }

  private setProgress(id: number, p: DownloadProgress): void {
    getDb()
      .update(schema.downloadQueue)
      .set({
        progressCurrent: p.downloaded,
        progressTotal: p.total,
        speed: p.bytesPerSecond,
        currentFile: p.currentFile,
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
    if (task.status === 'queued' || task.status === 'downloading') {
      const run = this.activeRuns.get(id);
      if (run) run.cancelled = true;
      this.setStatus(id, 'failed');
      getDb().update(schema.downloadQueue).set({ errorMessage: 'Cancelled by user' }).where(eq(schema.downloadQueue.id, id)).run();
      return true;
    }
    return false;
  }

  /** Re-run a failed/completed task from scratch. */
  retry(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    getDb()
      .update(schema.downloadQueue)
      .set({ status: 'queued', progressCurrent: 0, speed: null, currentFile: null, errorMessage: null, startedAt: null, finishedAt: null })
      .where(eq(schema.downloadQueue.id, id))
      .run();
    void this.pump();
    return true;
  }

  remove(id: number): boolean {
    getDb().delete(schema.downloadQueue).where(eq(schema.downloadQueue.id, id)).run();
    return true;
  }

  /** Delete all completed tasks. */
  clearCompleted(): number {
    const db = getDb();
    const res = db.delete(schema.downloadQueue).where(eq(schema.downloadQueue.status, 'completed')).run();
    return Number(res.changes ?? 0);
  }

  // ---------------- Pump / concurrency ----------------

  private claimNext(): DownloadRow | null {
    const db = getDb();
    const row = db
      .select()
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, 'queued'))
      .orderBy(desc(schema.downloadQueue.id))
      .limit(1)
      .get();
    if (!row) return null;
    this.setStatus(row.id, 'downloading');
    return row;
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
    try {
      const settings = this.settingsProvider();
      if (!settings.downloadDirectory) {
        throw new Error('No download directory configured. Set an output folder in Settings first.');
      }
      const provider = getDoujinProvider(row.source);
      if (!provider) throw new Error(`Unknown source: ${row.source}`);

      // Resolve the full gallery (metadata + image list).
      const gallery = await provider.getGallery(row.galleryId);
      const total = gallery.pages.length;
      if (!total) throw new Error('Gallery has no downloadable pages.');
      this.setProgress(row.id, { downloaded: 0, total, bytesPerSecond: 0, currentFile: null });

      // Download all pages with bounded concurrency + rate limiting.
      const images = await this.downloadPages(gallery, row.id, settings, ctx);

      // Write to disk (cbz or folder) and record the output path.
      const outputPath = await this.writeOutput(row.id, gallery, images, settings);
      getDb().update(schema.downloadQueue).set({ outputPath }).where(eq(schema.downloadQueue.id, row.id)).run();

      this.setStatus(row.id, 'completed');
      this.setProgress(row.id, { downloaded: total, total, bytesPerSecond: 0, currentFile: null });

      // Optional Kavita auto-sync.
      if (settings.autoSyncKavita) await this.triggerKavitaScan(outputPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      getDb().update(schema.downloadQueue).set({ errorMessage: message }).where(eq(schema.downloadQueue.id, row.id)).run();
      if (!ctx.cancelled) this.setStatus(row.id, 'failed');
    } finally {
      this.activeRuns.delete(row.id);
    }
  }

  private async downloadPages(
    gallery: DoujinGallery,
    taskId: number,
    settings: DownloaderSettings,
    ctx: RunContext,
  ): Promise<{ name: string; data: Buffer }[]> {
    const pages = gallery.pages;
    const fallbacks = gallery.pageFallbacks ?? [];
    const total = pages.length;
    const concurrency = Math.max(1, settings.maxImageConcurrency || 1);
    const delay = Math.max(0, settings.requestDelayMs || 0);
    const pageHeaders: Record<string, string> = { 'User-Agent': UA, ...gallery.requestHeaders };
    const out: { name: string; data: Buffer }[] = new Array(total);
    let downloaded = 0;
    let lastTick = Date.now();

    const report = (currentFile: string) => {
      const now = Date.now();
      const elapsedSec = Math.max(0.25, (now - lastTick) / 1000);
      // Rough speed estimate: bytes for the latest page over the tick window.
      const bps = downloaded > 0 ? Math.round(((out[downloaded - 1]?.data.length ?? 0) / elapsedSec)) : 0;
      lastTick = now;
      this.setProgress(taskId, { downloaded, total, bytesPerSecond: bps, currentFile });
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
        // Try the primary URL, then any per-page fallbacks before giving up.
        const candidates = [pages[i], fallbacks[i]].filter((u): u is string => typeof u === 'string' && u.length > 0);
        let data: Buffer | null = null;
        let usedUrl: string | null = null;
        let lastErr: unknown = null;
        for (const url of candidates) {
          try {
            data = await fetchWithRetry(url, pageHeaders);
            usedUrl = url;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!data) throw lastErr instanceof Error ? lastErr : new Error(`Failed to download page ${i + 1}`);
        const name = `${padPage(i + 1, total)}.${extFromUrl(usedUrl ?? pages[i])}`;
        out[i] = { name, data };
        downloaded++;
        report(name);
        if (delay > 0) await sleep(delay);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);
    return out;
  }

  private async writeOutput(
    taskId: number,
    gallery: DoujinGallery,
    images: { name: string; data: Buffer }[],
    settings: DownloaderSettings,
  ): Promise<string> {
    const base = path.resolve(settings.downloadDirectory);
    fs.mkdirSync(base, { recursive: true });
    const folderName = sanitizeFilename(gallery.title || `Gallery ${gallery.galleryId}`, `Gallery-${gallery.galleryId}`);

    if (settings.format === 'folder') {
      const dir = path.join(base, folderName);
      fs.mkdirSync(dir, { recursive: true });
      for (const img of images) {
        fs.writeFileSync(path.join(dir, img.name), img.data);
      }
      fs.writeFileSync(path.join(dir, 'ComicInfo.xml'), generateComicInfoXml(gallery));
      return dir;
    }

    // cbz: pack all images + ComicInfo.xml into a single archive.
    const entries = [
      ...images.map((img) => ({ name: img.name, data: img.data })),
      { name: 'ComicInfo.xml', data: Buffer.from(generateComicInfoXml(gallery), 'utf8') },
    ];
    const zipBuf = buildZip(entries);
    const file = path.join(base, `${folderName}.cbz`);
    fs.writeFileSync(file, zipBuf);
    return file;
  }

  /** Best-effort Kavita rescan so newly written media appears immediately. */
  private async triggerKavitaScan(_outputPath: string): Promise<void> {
    try {
      const { getKavitaConnection } = await import('../services/settings.js');
      const conn = getKavitaConnection();
      if (!conn.baseUrl || !conn.apiKey) return;
      const { KavitaClient } = await import('../kavita/client.js');
      const client = new KavitaClient(conn.baseUrl, conn.apiKey);
      // If a specific library path contains our output, scan just that one.
      const libraries = await client.getLibraries();
      const matched = libraries.find((l) => l.path && _outputPath.startsWith(l.path));
      if (matched) await client.scanLibrary(matched.id);
      else await client.scanAllLibraries();
    } catch {
      // Auto-sync is best-effort; never fail the download over it.
    }
  }
}

/** Shared singleton wired to live settings at construction time. */
export const downloadQueue = new DownloadQueue(() => getDownloaderSettings());
