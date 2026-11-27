import { pathContains } from "../lib/paths.js";
import { archiveMutations, archiveResource } from "../lib/mutations.js";
import { downloadPages } from "./transfer.js";
import {
  DownloadPausedError,
  DownloadShutdownError,
  wakePaused,
  type RunContext,
  type LiveFields,
} from "./runtime.js";
import {
  isTransientError,
  retryTransient,
  classifyDownloadError,
  errorRetryAfterMs,
} from "./requests.js";
import {
  downloadState,
  MAX_AUTO_RETRIES,
  type DownloadTask,
  type DownloadStatus,
  type DownloadErrorCode,
} from "../contracts/downloads.js";
export type { DownloadTask, DownloadStatus } from "../contracts/downloads.js";
import { queueDownloadedMatchDiscovery } from "../services/downloadDiscovery.js";
import {
  recordGalleryIdentity,
  invalidateDuplicateLibrary,
  noteDownloadedArchive,
  resolveDuplicateGallery,
} from "../services/galleryDuplicates.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, getTmpDir, schema } from "../db/index.js";
import { mapLimit } from "../lib/http.js";
import { generateComicInfoXml } from "./comicinfo.js";
import { buildZipFromFiles } from "./zip.js";
import { galleryFilesystemName, sanitizeFilename } from "./util.js";
import { getDoujinProvider } from "./providers.js";
import type { DoujinGallery } from "./types.js";
import type { DoujinSource } from "../contracts/doujin.js";
import {
  getDownloaderSettings,
  type DownloaderSettings,
} from "../services/settings.js";
import { recordGalleryTags } from "../services/recommendations.js";
import { guardDownloadPublication } from "./publishGuard.js";

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

/** Progressive task-level auto-retry delays (ms) for transient failures. */
const AUTO_RETRY_DELAYS_MS = [30_000, 60_000, 180_000];

const SQLITE_ID_CHUNK = 500;

function runIdChunks<T>(ids: number[], fn: (chunk: number[]) => T[]): T[] {
  if (ids.length <= SQLITE_ID_CHUNK) return fn(ids);
  return getDb().transaction(() => {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_ID_CHUNK) {
      out.push(...fn(ids.slice(i, i + SQLITE_ID_CHUNK)));
    }
    return out;
  });
}
const MAX_AUTO_RETRY_DELAY_MS = 5 * 60_000;
/** Age margin before a staging dir is treated as left by a previous process. */
const STAGING_MTIME_MARGIN_MS = 10_000;

/**
 * Replace a published file with a staged file without relying on POSIX rename
 * semantics. Windows refuses `rename(staged, destination)` when destination
 * already exists, which made retries and re-downloads fail at the final
 * publish step. Keep the previous file until the staged replacement has been
 * put in place, and restore it if that step fails.
 */
async function replacePublishedFile(
  staged: string,
  destination: string
): Promise<void> {
  let backup: string | null = null;
  try {
    await fs.promises.access(destination);
    backup = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.htosho-backup-${randomUUID()}`
    );
    await fs.promises.rename(destination, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.promises.rename(staged, destination);
  } catch (error) {
    if (backup) await fs.promises.rename(backup, destination).catch(() => {});
    throw error;
  }
  if (backup) await fs.promises.rm(backup, { force: true }).catch(() => {});
}

/** Live task subscriber; `serialized()` is the shared, memoized JSON of `task`. */
export type TaskListener = (
  task: DownloadTask,
  serialized: () => string
) => void;

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
    outputFormat: (row.outputFormat as "cbz" | "folder") ?? "cbz",
    outputPath: row.outputPath,
    mergeFolder: row.mergeFolder ?? null,
    chapterNumber: row.chapterNumber ?? null,
    mergeJobId: row.mergeJobId ?? null,
    priority: row.priority ?? 0,
    phase:
      row.phase === "resolving" ||
      row.phase === "downloading" ||
      row.phase === "packing"
        ? row.phase
        : null,
    errorMessage: row.errorMessage,
    errorCode: row.errorCode as DownloadErrorCode | null,
    retryAt: row.retryAt,
    retryCount: row.retryCount,
    attempt: row.attempt,
    revision: row.revision,
    state: downloadState({
      status: row.status as DownloadStatus,
      errorCode: row.errorCode as DownloadErrorCode | null,
      retryAt: row.retryAt,
      retryCount: row.retryCount,
      phase: row.phase,
    }),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

export class DownloadQueue {
  private running = 0;
  private pumping = false;
  private shuttingDown = false;
  /** id -> live run context (used for cancel/pause/shutdown of in-flight jobs). */
  private activeRuns = new Map<number, RunContext>();
  /** In-flight process() promises tracked for graceful shutdown. */
  private runPromises = new Set<Promise<void>>();
  /** id -> freshest in-memory task snapshot (source of truth while a run is active). */
  private live = new Map<number, DownloadTask>();
  /** id -> last SSE broadcast timestamp (ms) for throttling. */
  private lastBroadcast = new Map<number, number>();
  /** id -> last DB persist timestamp (ms) for throttling. */
  private lastWrite = new Map<number, number>();
  /** id -> pending cooldown timer that will re-queue the task. */
  private retryTimers = new Map<number, NodeJS.Timeout>();
  private listeners = new Set<TaskListener>();
  private removalListeners = new Set<(ids: number[]) => void>();
  private started = false;
  /** Process start (ms): staging dirs older than this belong to a dead process. */
  private startedAt = 0;
  private settingsProvider: () => DownloaderSettings;

  constructor(settingsProvider: () => DownloaderSettings) {
    this.settingsProvider = settingsProvider;
  }
  /** Recover persistent queue state after process startup, clean orphans, then run queued work. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.shuttingDown = false;
    // A previous process may have died mid-download. Its partial page files are
    // still in the task's tmpDir, so re-queue instead of failing — the run
    // resumes from the first missing page file.
    getDb()
      .update(schema.downloadQueue)
      .set({
        status: "queued",
        speed: null,
        currentFile: null,
        phase: null,
        errorMessage: null,
        errorCode: null,
        retryAt: null,
        startedAt: null,
        revision: sql`${schema.downloadQueue.revision} + 1`,
      })
      .where(eq(schema.downloadQueue.status, "downloading"))
      .run();
    // Cooldowns are durable; restart does not strand retryable failures.
    for (const row of getDb()
      .select()
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "failed"))
      .all()) {
      if (row.retryAt)
        this.armRetry(
          row.id,
          Math.max(0, Date.parse(row.retryAt) - Date.now())
        );
    }
    void this.cleanupOrphanedWork();
    void this.pump();
  }

  /** Respond to updated downloader settings (e.g. increased maxConcurrentDownloads). */
  onSettingsChanged(): void {
    if (this.shuttingDown) return;
    void this.pump();
  }

  /**
   * Gracefully wind down active downloads on process shutdown: stop claiming new
   * work, cancel retry timers, and abort non-committing runs so partial page files
   * and `page-names.json` flush cleanly while rows return to `queued` for the next boot.
   */
  async shutdown(timeoutMs = 1500): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const run of this.activeRuns.values()) {
      if (run.committing) continue;
      run.shuttingDown = true;
      run.stopped = true;
      run.controller.abort(new DownloadShutdownError());
      wakePaused(run);
    }
    if (this.runPromises.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(this.runPromises),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Best-effort startup sweep for leftover staging dirs and scratch folders from crashed runs. */
  private async cleanupOrphanedWork(): Promise<void> {
    try {
      const db = getDb();
      const keptIds = new Set(
        db
          .select({ id: schema.downloadQueue.id })
          .from(schema.downloadQueue)
          .where(ne(schema.downloadQueue.status, "completed"))
          .all()
          .map((row) => String(row.id))
      );
      const downloadsTmp = path.join(getTmpDir(), "downloads");
      try {
        const entries = await fs.promises.readdir(downloadsTmp, {
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
          if (
            keptIds.has(entry.name) ||
            this.activeRuns.has(Number(entry.name))
          )
            continue;
          await fs.promises
            .rm(path.join(downloadsTmp, entry.name), {
              recursive: true,
              force: true,
            })
            .catch(() => {});
        }
      } catch {
        /* tmp dir may not exist yet */
      }
      const downloadDir = this.settingsProvider().downloadDirectory?.trim();
      if (downloadDir) {
        const base = path.resolve(downloadDir);
        try {
          const entries = await fs.promises.readdir(base, {
            withFileTypes: true,
          });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (
              !entry.name.startsWith(".htosho-download-") &&
              !entry.name.startsWith(".htosho-zip-")
            )
              continue;
            // Downloads resumed at startup stage here concurrently. With no
            // run active nothing can be live; otherwise only a directory last
            // modified clearly before this process started (margin covers
            // coarse filesystem timestamps, e.g. FAT's 2 s) is a dead one.
            const full = path.join(base, entry.name);
            if (this.activeRuns.size > 0) {
              const st = await fs.promises.stat(full).catch(() => null);
              if (!st || st.mtimeMs >= this.startedAt - STAGING_MTIME_MARGIN_MS)
                continue;
            }
            await fs.promises
              .rm(full, { recursive: true, force: true })
              .catch(() => {});
          }
        } catch {
          /* output dir may not exist yet */
        }
      }
    } catch {
      /* orphan cleanup is strictly best-effort */
    }
  }

  // ---------------- Live update fan-out (SSE) ----------------

  /**
   * Subscribe to live task updates. Returns an unsubscribe function. The
   * second argument returns `JSON.stringify(task)`, computed at most once per
   * broadcast and shared by every subscriber (e.g. one per SSE client).
   */
  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(task: DownloadTask): void {
    if (this.listeners.size === 0) return;
    let json: string | undefined;
    const serialized = (): string => (json ??= JSON.stringify(task));
    for (const l of this.listeners) {
      try {
        l(task, serialized);
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
    outputFormat?: "cbz" | "folder",
    mergeFolder?: string,
    chapterNumber?: number,
    priority?: number,
    mergeJobId?: number,
    sourceUrl?: string
  ): number {
    const db = getDb();
    const createdRow = db
      .insert(schema.downloadQueue)
      .values({
        source,
        galleryId,
        title,
        status: "queued",
        progressCurrent: 0,
        progressTotal: 0,
        outputFormat: outputFormat ?? this.settingsProvider().format,
        mergeFolder: mergeFolder ?? null,
        chapterNumber: chapterNumber ?? null,
        priority: priority ?? 0,
        mergeJobId: mergeJobId ?? null,
        sourceUrl: sourceUrl ?? null,
        revision: 1,
      })
      .returning()
      .get();
    const id = createdRow.id;
    this.broadcast(rowToTask(createdRow));
    void this.pump();
    return id;
  }

  /** Raw read from SQLite (no live overlay). */
  private readRow(id: number): DownloadTask | null {
    const row = getDb()
      .select()
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.id, id))
      .get();
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

  /**
   * The manager's working set: every unsettled or failed task (they need the
   * user or are still moving, so a history cap must never hide them) plus the
   * most recently finished completed tasks. Older completed rows are paged
   * through {@link completedHistory}.
   */
  listForManager(completedLimit = 100): DownloadTask[] {
    const db = getDb();
    const open = db
      .select()
      .from(schema.downloadQueue)
      .where(
        inArray(schema.downloadQueue.status, [
          "queued",
          "downloading",
          "paused",
          "failed",
        ])
      )
      .orderBy(desc(schema.downloadQueue.id))
      .limit(2000)
      .all();
    const completed = db
      .select()
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "completed"))
      .orderBy(
        desc(schema.downloadQueue.finishedAt),
        desc(schema.downloadQueue.id)
      )
      .limit(completedLimit)
      .all();
    return [...open, ...completed]
      .sort((a, b) => b.id - a.id)
      .map((row) => this.overlayLive(rowToTask(row)));
  }

  /** One page of completed history, newest finish first, with the full count. */
  completedHistory(
    offset: number,
    limit: number
  ): { items: DownloadTask[]; total: number } {
    const db = getDb();
    const items = db
      .select()
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "completed"))
      .orderBy(
        desc(schema.downloadQueue.finishedAt),
        desc(schema.downloadQueue.id)
      )
      .limit(limit)
      .offset(offset)
      .all()
      .map((row) => this.overlayLive(rowToTask(row)));
    const total =
      db
        .select({ n: count() })
        .from(schema.downloadQueue)
        .where(eq(schema.downloadQueue.status, "completed"))
        .get()?.n ?? 0;
    return { items, total };
  }

  /** Count of currently in-flight (downloading) tasks. */
  activeCount(): number {
    return this.running;
  }

  /** True while this process still owns network or filesystem work for a task. */
  isRunning(id: number): boolean {
    return this.activeRuns.has(id);
  }

  /** Atomic monotonic revision expression across both persisted DB and in-memory live snapshots. */
  private revisionExpr(id: number) {
    const liveRev = this.live.get(id)?.revision ?? 0;
    return sql<number>`max(COALESCE(${schema.downloadQueue.revision}, 0), ${liveRev}) + 1`;
  }

  /** Capture the freshest page/byte counts (without stale speed/phase) before leaving a live run. */
  private snapshotProgress(id: number):
    | {
        progressCurrent: number;
        progressTotal: number;
        bytesCurrent: number;
        bytesTotal: number;
      }
    | undefined {
    const live = this.live.get(id);
    if (!live) return undefined;
    return {
      progressCurrent: live.progressCurrent,
      progressTotal: live.progressTotal,
      bytesCurrent: live.bytesCurrent,
      bytesTotal: live.bytesTotal,
    };
  }

  private setStatus(
    id: number,
    status: DownloadStatus,
    knownAttempt?: number,
    extraSet: Partial<typeof schema.downloadQueue.$inferInsert> = {}
  ): DownloadTask | null {
    const db = getDb();
    const rev = this.revisionExpr(id);
    const progress =
      status !== "downloading" ? this.snapshotProgress(id) : undefined;
    let updatedRow: DownloadRow | undefined;
    if (status === "downloading") {
      const currentAttempt = knownAttempt ?? this.get(id)?.attempt ?? 0;
      updatedRow = db
        .update(schema.downloadQueue)
        .set({
          status,
          startedAt: new Date().toISOString(),
          attempt: this.activeRuns.has(id)
            ? currentAttempt
            : currentAttempt + 1,
          ...extraSet,
          revision: rev,
        })
        .where(eq(schema.downloadQueue.id, id))
        .returning()
        .get();
    } else if (status === "completed" || status === "failed") {
      updatedRow = db
        .update(schema.downloadQueue)
        .set({
          status,
          finishedAt: new Date().toISOString(),
          speed: 0,
          currentFile: null,
          phase: null,
          ...progress,
          ...extraSet,
          revision: rev,
        })
        .where(eq(schema.downloadQueue.id, id))
        .returning()
        .get();
    } else {
      updatedRow = db
        .update(schema.downloadQueue)
        .set({
          status,
          speed: status === "paused" ? 0 : null,
          currentFile: null,
          phase: null,
          ...progress,
          ...extraSet,
          revision: rev,
        })
        .where(eq(schema.downloadQueue.id, id))
        .returning()
        .get();
    }
    const task = updatedRow ? rowToTask(updatedRow) : null;
    this.syncLive(id, status === "downloading", task);
    return task;
  }

  /** Reload a task from the DB, update the in-memory cache only for active runs, and broadcast it. */
  private syncLive(
    id: number,
    keepLive = false,
    preloadedTask?: DownloadTask | null
  ): void {
    const t = preloadedTask !== undefined ? preloadedTask : this.readRow(id);
    if (t) {
      if (keepLive) {
        const previous = this.live.get(id);
        if (previous) {
          Object.assign(t, pickLiveFields(previous), {
            revision: Math.max(t.revision, previous.revision + 1),
          });
          this.persistProgress(id, t);
        }
        t.state = downloadState(t);
        this.live.set(id, t);
        this.lastWrite.set(id, Date.now());
      } else {
        this.live.delete(id);
        this.lastBroadcast.delete(id);
        this.lastWrite.delete(id);
      }
      this.broadcast(t);
    } else {
      this.live.delete(id);
      this.lastBroadcast.delete(id);
      this.lastWrite.delete(id);
    }
  }

  /**
   * Merge volatile progress fields into the in-memory snapshot, then fan out to
   * subscribers and persist to SQLite — each on its own throttle so high-frequency
   * byte-level updates stay smooth without overloading the database.
   */
  private updateProgress(
    id: number,
    patch: LiveFields,
    opts?: { force?: boolean; forceBroadcast?: boolean }
  ): void {
    const run = this.activeRuns.get(id);
    if (run && (run.cancelled || run.paused || run.shuttingDown || run.stopped))
      return;
    let snap = this.live.get(id);
    if (!snap) {
      const base = this.readRow(id);
      if (!base || base.status !== "downloading") return;
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

  /** Pause an in-flight download (aborts active transfer, preserves saved pages, frees concurrency slot) or a queued one. */
  pause(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    const run = this.activeRuns.get(id);
    if (run?.committing) return false;
    if (task.status === "queued" || task.status === "downloading") {
      if (run) {
        run.paused = true;
        run.stopped = true;
        run.pauseSignal.paused = true;
        run.controller.abort(new DownloadPausedError());
        wakePaused(run);
      }
      this.setStatus(id, "paused");
      return true;
    }
    return false;
  }

  /** Resume a paused task (re-queues it for the next available slot), or retry a settled failed task. */
  resume(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status === "paused") {
      this.setStatus(id, "queued");
      void this.pump();
      return true;
    }
    if (task.status === "failed") return this.retry(id);
    return false;
  }

  /** Pause all queued and non-committing active downloads atomically (queued first so no slot refills mid-sweep). */
  pauseAll(): number {
    const db = getDb();
    const queuedRows = db
      .select({ id: schema.downloadQueue.id })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "queued"))
      .all();
    let count = 0;
    if (queuedRows.length > 0) {
      const ids = queuedRows.map((row) => row.id);
      // RETURNING yields exactly the rows this sweep paused — no per-row re-read.
      const paused = runIdChunks(ids, (chunk) =>
        db
          .update(schema.downloadQueue)
          .set({
            status: "paused",
            speed: 0,
            currentFile: null,
            phase: null,
            revision: sql`${schema.downloadQueue.revision} + 1`,
          })
          .where(
            and(
              inArray(schema.downloadQueue.id, chunk),
              eq(schema.downloadQueue.status, "queued")
            )
          )
          .returning()
          .all()
      );
      for (const id of ids) {
        this.live.delete(id);
        this.lastBroadcast.delete(id);
        this.lastWrite.delete(id);
      }
      for (const row of paused) {
        this.broadcast(rowToTask(row));
        count++;
      }
    }
    const downloadingRows = db
      .select({ id: schema.downloadQueue.id })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "downloading"))
      .all();
    for (const { id } of downloadingRows) {
      if (this.pause(id)) count++;
    }
    return count;
  }

  /** Resume every paused download and pump once. */
  resumeAll(): number {
    const db = getDb();
    const pausedRows = db
      .select({ id: schema.downloadQueue.id })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "paused"))
      .all();
    if (!pausedRows.length) return 0;
    const ids = pausedRows.map((row) => row.id);
    const queued = runIdChunks(ids, (chunk) =>
      db
        .update(schema.downloadQueue)
        .set({
          status: "queued",
          speed: null,
          currentFile: null,
          phase: null,
          revision: sql`${schema.downloadQueue.revision} + 1`,
        })
        .where(
          and(
            inArray(schema.downloadQueue.id, chunk),
            eq(schema.downloadQueue.status, "paused")
          )
        )
        .returning()
        .all()
    );
    for (const id of ids) this.live.delete(id);
    for (const row of queued) this.broadcast(rowToTask(row));
    if (queued.length > 0) void this.pump();
    return queued.length;
  }

  /** Retry all permanently failed (non-cancelled, non-retry-wait) downloads and pump once. */
  retryFailed(): number {
    const db = getDb();
    const rows = db
      .select({
        id: schema.downloadQueue.id,
        outputPath: schema.downloadQueue.outputPath,
      })
      .from(schema.downloadQueue)
      .where(
        and(
          eq(schema.downloadQueue.status, "failed"),
          isNull(schema.downloadQueue.retryAt),
          or(
            isNull(schema.downloadQueue.errorCode),
            ne(schema.downloadQueue.errorCode, "cancelled")
          )
        )
      )
      .all();
    const eligible = rows.filter(
      (row) =>
        !this.activeRuns.has(row.id) &&
        !(
          row.outputPath &&
          archiveMutations.isBusy(archiveResource(row.outputPath))
        )
    );
    if (!eligible.length) return 0;
    const ids = eligible.map((row) => row.id);
    for (const id of ids) {
      const pending = this.retryTimers.get(id);
      if (pending) {
        clearTimeout(pending);
        this.retryTimers.delete(id);
      }
      this.live.delete(id);
    }
    const requeued = runIdChunks(ids, (chunk) =>
      db
        .update(schema.downloadQueue)
        .set({
          status: "queued",
          speed: null,
          currentFile: null,
          phase: null,
          errorMessage: null,
          errorCode: null,
          retryAt: null,
          retryCount: 0,
          startedAt: null,
          finishedAt: null,
          revision: sql`${schema.downloadQueue.revision} + 1`,
        })
        .where(inArray(schema.downloadQueue.id, chunk))
        .returning()
        .all()
    );
    for (const row of requeued) this.broadcast(rowToTask(row));
    void this.pump();
    return ids.length;
  }

  /** Move a queued task ahead of every other queued download. */
  prioritize(id: number): boolean {
    const task = this.get(id);
    if (!task || task.status !== "queued") return false;
    const db = getDb();
    const top = db
      .select({ priority: schema.downloadQueue.priority })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "queued"))
      .orderBy(desc(schema.downloadQueue.priority))
      .limit(1)
      .get();
    const nextPriority = Math.max(
      (top?.priority ?? 0) + 1,
      (task.priority ?? 0) + 1
    );
    const updated = db
      .update(schema.downloadQueue)
      .set({ priority: nextPriority, revision: this.revisionExpr(id) })
      .where(
        and(
          eq(schema.downloadQueue.id, id),
          eq(schema.downloadQueue.status, "queued")
        )
      )
      .returning()
      .get();
    if (updated) this.broadcast(rowToTask(updated));
    return true;
  }

  /** A failed task may still be waiting for its automatic retry timer. */
  hasPendingRetry(id: number): boolean {
    return this.get(id)?.state.type === "retry-wait";
  }

  /** Cancel: stop an in-flight job and mark it failed/cancelled. */
  cancel(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    const retryTimer = this.retryTimers.get(id);
    // A durable retry deadline counts even before start() re-arms its timer
    // (startup recovery cancels interrupted merge downloads that early).
    if (
      task.status === "failed" &&
      (retryTimer || task.state.type === "retry-wait")
    ) {
      if (retryTimer) clearTimeout(retryTimer);
      this.retryTimers.delete(id);
      const updated = getDb()
        .update(schema.downloadQueue)
        .set({
          errorMessage: "Cancelled by user",
          errorCode: "cancelled",
          retryAt: null,
          speed: 0,
          currentFile: null,
          phase: null,
          revision: this.revisionExpr(id),
        })
        .where(eq(schema.downloadQueue.id, id))
        .returning()
        .get();
      const updatedTask = updated ? rowToTask(updated) : null;
      this.syncLive(id, false, updatedTask);
      this.discoverCompletedDownload(id, undefined, updatedTask);
      return true;
    }
    if (this.activeRuns.get(id)?.committing) return false;
    if (
      task.status === "queued" ||
      task.status === "downloading" ||
      task.status === "paused"
    ) {
      const run = this.activeRuns.get(id);
      if (run) {
        run.cancelled = true;
        run.paused = false;
        run.stopped = true;
        run.controller.abort(new Error("Cancelled by user"));
        // A worker parked on the pause gate must exit promptly.
        wakePaused(run);
      }
      const progress = this.snapshotProgress(id);
      const updated = getDb()
        .update(schema.downloadQueue)
        .set({
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: "Cancelled by user",
          errorCode: "cancelled",
          retryAt: null,
          speed: 0,
          currentFile: null,
          phase: null,
          ...progress,
          revision: this.revisionExpr(id),
        })
        .where(eq(schema.downloadQueue.id, id))
        .returning()
        .get();
      const updatedTask = updated ? rowToTask(updated) : null;
      this.syncLive(id, false, updatedTask);
      if (!run) this.discoverCompletedDownload(id, undefined, updatedTask);
      return true;
    }
    return false;
  }

  /**
   * Re-queue a task that failed on a transient error (CDN 503/timeout) after a
   * progressive cooldown, up to MAX_AUTO_RETRIES times. The row stays visible as
   * "failed" with an explicit retry deadline until the timer flips it back to
   * "queued"; a manual retry or delete supersedes the pending timer via status guards.
   */
  private scheduleAutoRetry(
    id: number,
    message: string,
    retryAfterMs: number | null = null,
    extraSet: Partial<typeof schema.downloadQueue.$inferInsert> = {}
  ): DownloadTask | null {
    const count = (this.get(id)?.retryCount ?? 0) + 1;
    if (count > MAX_AUTO_RETRIES) {
      return this.setStatus(id, "failed", undefined, {
        errorMessage: message,
        retryAt: null,
        ...extraSet,
      });
    }
    const baseDelay =
      AUTO_RETRY_DELAYS_MS[count - 1] ??
      AUTO_RETRY_DELAYS_MS[AUTO_RETRY_DELAYS_MS.length - 1];
    const delayMs =
      retryAfterMs !== null
        ? Math.min(Math.max(baseDelay, retryAfterMs), MAX_AUTO_RETRY_DELAY_MS)
        : baseDelay;
    const progress = this.snapshotProgress(id);
    const updated = getDb()
      .update(schema.downloadQueue)
      .set({
        status: "failed",
        finishedAt: new Date().toISOString(),
        errorMessage: message,
        retryAt: new Date(Date.now() + delayMs).toISOString(),
        retryCount: count,
        speed: 0,
        currentFile: null,
        phase: null,
        ...progress,
        ...extraSet,
        revision: this.revisionExpr(id),
      })
      .where(eq(schema.downloadQueue.id, id))
      .returning()
      .get();
    const updatedTask = updated ? rowToTask(updated) : null;
    this.syncLive(id, false, updatedTask);
    this.armRetry(id, delayMs);
    return updatedTask;
  }

  private armRetry(id: number, delay: number): void {
    const existing = this.retryTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      if (this.shuttingDown) return;
      const t = this.readRow(id);
      if (!t || t.state.type !== "retry-wait") return; // user retried or deleted meanwhile
      const updated = getDb()
        .update(schema.downloadQueue)
        .set({
          status: "queued",
          speed: null,
          currentFile: null,
          phase: null,
          errorMessage: null,
          errorCode: null,
          retryAt: null,
          startedAt: null,
          finishedAt: null,
          revision: this.revisionExpr(id),
        })
        .where(eq(schema.downloadQueue.id, id))
        .returning()
        .get();
      this.syncLive(id, false, updated ? rowToTask(updated) : null);
      void this.pump();
    }, delay);
    timer.unref();
    this.retryTimers.set(id, timer);
  }

  /** Re-queue a settled failed/completed task, resuming from partial page files. */
  retry(id: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.status !== "failed" && task.status !== "completed") return false;
    // A cancelled run can remain in-flight until its current request unwinds.
    // Starting another writer against the same scratch directory would race it.
    if (
      this.activeRuns.has(id) ||
      (task.outputPath &&
        archiveMutations.isBusy(archiveResource(task.outputPath)))
    )
      return false;
    const pending = this.retryTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.retryTimers.delete(id);
    }
    const rev = this.revisionExpr(id);
    this.live.delete(id);
    const updated = getDb()
      .update(schema.downloadQueue)
      .set({
        status: "queued",
        speed: null,
        currentFile: null,
        phase: null,
        errorMessage: null,
        errorCode: null,
        retryAt: null,
        retryCount: 0,
        startedAt: null,
        finishedAt: null,
        revision: rev,
      })
      .where(eq(schema.downloadQueue.id, id))
      .returning()
      .get();
    if (updated) this.broadcast(rowToTask(updated));
    void this.pump();
    return true;
  }

  /** Delete a task and its scratch directory. Active callers must cancel first. */
  remove(id: number): boolean {
    const task = this.get(id);
    if (
      !task ||
      this.isRunning(id) ||
      ["queued", "downloading", "paused"].includes(task.status)
    )
      return false;
    getDb()
      .delete(schema.downloadQueue)
      .where(eq(schema.downloadQueue.id, id))
      .run();
    this.live.delete(id);
    this.lastBroadcast.delete(id);
    this.lastWrite.delete(id);
    const pending = this.retryTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.retryTimers.delete(id);
    }
    void fs.promises
      .rm(path.join(getTmpDir(), "downloads", String(id)), {
        recursive: true,
        force: true,
      })
      .catch((err) =>
        console.warn("[h-tosho] failed to remove download scratch dir:", err)
      );
    this.broadcastRemovals([id]);
    return true;
  }

  /** Delete all completed tasks. */
  clearCompleted(): number {
    const db = getDb();
    const removed = db
      .delete(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "completed"))
      .returning({ id: schema.downloadQueue.id })
      .all();
    for (const { id } of removed) {
      this.live.delete(id);
      this.lastBroadcast.delete(id);
      this.lastWrite.delete(id);
    }
    this.broadcastRemovals(removed.map((row) => row.id));
    return removed.length;
  }

  /** Delete all settled cancelled tasks and clean their leftover partial scratch dirs. */
  clearCancelled(): number {
    const db = getDb();
    const candidates = db
      .select({ id: schema.downloadQueue.id })
      .from(schema.downloadQueue)
      .where(
        and(
          eq(schema.downloadQueue.status, "failed"),
          eq(schema.downloadQueue.errorCode, "cancelled")
        )
      )
      .all()
      .filter((row) => !this.activeRuns.has(row.id));
    if (!candidates.length) return 0;
    const ids = candidates.map((row) => row.id);
    const removed = runIdChunks(ids, (chunk) =>
      db
        .delete(schema.downloadQueue)
        .where(inArray(schema.downloadQueue.id, chunk))
        .returning({ id: schema.downloadQueue.id })
        .all()
    );
    for (const { id } of removed) {
      this.live.delete(id);
      this.lastBroadcast.delete(id);
      this.lastWrite.delete(id);
      const pending = this.retryTimers.get(id);
      if (pending) {
        clearTimeout(pending);
        this.retryTimers.delete(id);
      }
      void fs.promises
        .rm(path.join(getTmpDir(), "downloads", String(id)), {
          recursive: true,
          force: true,
        })
        .catch((err) =>
          console.warn("[h-tosho] failed to remove download scratch dir:", err)
        );
    }
    this.broadcastRemovals(removed.map((row) => row.id));
    return removed.length;
  }
  /** Most recent completed task for a gallery (duplicate-download guard). */
  findCompleted(source: DoujinSource, galleryId: string): DownloadTask | null {
    const row = getDb()
      .select()
      .from(schema.downloadQueue)
      .where(
        and(
          eq(schema.downloadQueue.source, source),
          eq(schema.downloadQueue.galleryId, galleryId),
          eq(schema.downloadQueue.status, "completed")
        )
      )
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
          or(
            inArray(schema.downloadQueue.status, [
              "queued",
              "downloading",
              "paused",
            ]),
            and(
              eq(schema.downloadQueue.status, "failed"),
              isNotNull(schema.downloadQueue.retryAt)
            )
          )
        )
      )
      .orderBy(desc(schema.downloadQueue.id))
      .limit(1)
      .get();
    return row ? this.overlayLive(rowToTask(row)) : null;
  }

  /** Every completed gallery (newest first) — powers the "already downloaded" badges. */
  completedGalleries(): {
    source: string;
    galleryId: string;
    title: string | null;
    finishedAt: string | null;
  }[] {
    return getDb()
      .select({
        source: schema.downloadQueue.source,
        galleryId: schema.downloadQueue.galleryId,
        title: schema.downloadQueue.title,
        finishedAt: schema.downloadQueue.finishedAt,
      })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.status, "completed"))
      .orderBy(desc(schema.downloadQueue.id))
      .all();
  }

  // ---------------- Pump / concurrency ----------------

  private claimNext(): DownloadRow | null {
    if (this.shuttingDown) return null;
    const db = getDb();
    const activeIds = [...this.activeRuns.keys()];
    const row = db
      .select()
      .from(schema.downloadQueue)
      .where(
        activeIds.length > 0
          ? and(
              eq(schema.downloadQueue.status, "queued"),
              notInArray(schema.downloadQueue.id, activeIds)
            )
          : eq(schema.downloadQueue.status, "queued")
      )
      .orderBy(
        desc(schema.downloadQueue.priority),
        asc(schema.downloadQueue.id)
      )
      .limit(1)
      .get();
    if (!row) return null;
    this.setStatus(row.id, "downloading", row.attempt);
    return row;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    try {
      const maxConcurrent = Math.max(
        1,
        this.settingsProvider().maxConcurrentDownloads || 1
      );
      while (!this.shuttingDown && this.running < maxConcurrent) {
        const next = this.claimNext();
        if (!next) break;
        this.running++;
        const runPromise = this.process(next)
          .catch((error) => {
            console.warn(
              `[h-tosho] unexpected error in download worker #${next.id}:`,
              error
            );
          })
          .finally(() => {
            this.runPromises.delete(runPromise);
            this.running--;
            void this.pump();
          });
        this.runPromises.add(runPromise);
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---------------- Execution ----------------

  /** Discover a merged series only once every sibling has settled. */
  private discoverCompletedDownload(
    id: number,
    seriesName?: string,
    knownTask?: DownloadTask | null
  ): void {
    const task = knownTask !== undefined ? knownTask : this.readRow(id);
    if (!task || task.mergeJobId != null) return;
    let outputPath = task.status === "completed" ? task.outputPath : null;
    if (task.mergeFolder) {
      const siblings = getDb()
        .select()
        .from(schema.downloadQueue)
        .where(eq(schema.downloadQueue.mergeFolder, task.mergeFolder))
        .all();
      if (
        siblings.some(
          (sibling) =>
            ["queued", "downloading", "paused"].includes(sibling.status) ||
            sibling.retryAt ||
            this.activeRuns.has(sibling.id)
        )
      )
        return;
      outputPath ??=
        siblings.find(
          (sibling) => sibling.status === "completed" && sibling.outputPath
        )?.outputPath ?? null;
    }
    if (!outputPath) return;
    try {
      queueDownloadedMatchDiscovery(
        task.mergeFolder ? path.dirname(outputPath) : outputPath,
        task.mergeFolder ?? seriesName ?? task.title ?? undefined
      );
    } catch (error) {
      console.warn(
        "[h-tosho] Could not queue download match discovery:",
        error instanceof Error ? error.message : error
      );
    }
  }

  private async process(row: DownloadRow): Promise<void> {
    const ctx: RunContext = {
      cancelled: false,
      paused: false,
      shuttingDown: false,
      controller: new AbortController(),
      stopped: false,
      committing: false,
      pauseSignal: { paused: false, waiters: [] },
    };
    this.activeRuns.set(row.id, ctx);
    // Per-task scratch space: pages stream to disk here so only the in-flight
    // images (bounded by maxImageConcurrency) live in RAM.
    const tmpDir = path.join(getTmpDir(), "downloads", String(row.id));
    let discoverySeriesName: string | undefined;
    let finalTask: DownloadTask | null | undefined;
    const checkRunStop = (): void => {
      if (ctx.cancelled) throw new Error("Cancelled by user");
      if (ctx.paused) throw new DownloadPausedError();
      if (ctx.shuttingDown) throw new DownloadShutdownError();
    };
    const perform = async () => {
      try {
        checkRunStop();
        const settings = this.settingsProvider();
        if (!settings.downloadDirectory) {
          throw new Error(
            "No download directory configured. Set an output folder in Settings first."
          );
        }
        const provider = getDoujinProvider(row.source);
        if (!provider) throw new Error(`Unknown source: ${row.source}`);

        // Resolve the full gallery (metadata + image list).
        this.updateProgress(
          row.id,
          {
            phase: "resolving",
            progressCurrent: 0,
            progressTotal: 0,
            speed: 0,
            currentFile: "Resolving gallery…",
            bytesCurrent: 0,
            bytesTotal: 0,
          },
          { force: true }
        );
        // The frozen canonical URL (sourceUrl) wins over re-derivation from
        // the current account/site settings: a site cutover must not rewrite
        // queued work.
        const idOrUrl = row.sourceUrl ?? row.galleryId;
        const gallery = await retryTransient(
          () =>
            resolveDuplicateGallery(row.source as DoujinSource, idOrUrl, true),
          4,
          [2000, 10000, 30000],
          ctx.controller.signal
        );
        discoverySeriesName = gallery.series ?? gallery.title;
        checkRunStop();
        recordGalleryIdentity(gallery);
        const total = gallery.pages.length;
        if (!total) throw new Error("Gallery has no downloadable pages.");
        this.updateProgress(
          row.id,
          {
            phase: "downloading",
            progressCurrent: 0,
            progressTotal: total,
            speed: 0,
            currentFile: null,
            bytesCurrent: 0,
            bytesTotal: 0,
          },
          { force: true }
        );

        const destination = this.outputDestination(row, gallery, settings);
        const publish = async () => {
          checkRunStop();
          // Download all pages with bounded concurrency + rate limiting (streamed for live progress).
          const images = await downloadPages(
            gallery,
            row.id,
            settings,
            ctx,
            tmpDir,
            (id, patch, options) => this.updateProgress(id, patch, options)
          );
          checkRunStop();

          // Write to disk (cbz or folder) and record the output path.
          this.updateProgress(
            row.id,
            { phase: "packing", currentFile: "Packing archive…" },
            { force: true }
          );
          const outputPath = await this.writeOutput(
            row,
            gallery,
            images,
            settings,
            ctx
          );

          // The output is final: the scratch pages are no longer needed. On failure
          // or pause the tmpDir is deliberately kept so a retry/resume continues from partial data.
          // Cleanup completes before the 'completed' status is published so nothing
          // observes a completed task whose scratch dir is still on disk.
          await fs.promises.rm(tmpDir, { recursive: true, force: true });

          if (row.outputFormat !== "folder")
            await noteDownloadedArchive(outputPath, gallery);
          else invalidateDuplicateLibrary();
          const finalBytes = this.live.get(row.id)?.bytesCurrent ?? 0;
          const completedRow = getDb()
            .update(schema.downloadQueue)
            .set({
              outputPath,
              status: "completed",
              finishedAt: new Date().toISOString(),
              progressCurrent: total,
              progressTotal: total,
              bytesCurrent: finalBytes,
              bytesTotal: finalBytes,
              speed: 0,
              currentFile: null,
              phase: null,
              errorMessage: null,
              errorCode: null,
              retryAt: null,
              revision: this.revisionExpr(row.id),
            })
            .where(eq(schema.downloadQueue.id, row.id))
            .returning()
            .get();
          finalTask = completedRow ? rowToTask(completedRow) : null;
          this.syncLive(row.id, false, finalTask);
          // Only completed downloads are taste signals. Failed or cancelled work
          // must not permanently bias the recommendation profile.
          recordGalleryTags(row.source as DoujinSource, gallery);
        };
        const old = row.outputPath ? archiveResource(row.outputPath) : null;
        const next = archiveResource(destination);
        // Existing folder reservations already conflict with overlapping folder operations.
        if (
          row.mergeFolder ||
          (old && (pathContains(old, next) || pathContains(next, old)))
        )
          await publish();
        else await archiveMutations.run([next], publish, ctx.controller.signal);
      } catch (e) {
        ctx.stopped = true;
        wakePaused(ctx);
        if (ctx.paused || e instanceof DownloadPausedError) {
          // Pause already set DB status to 'paused' (or a rapid resume flipped it to 'queued').
          // Persist any final progress counts while preserving partial files for resume.
          const progress = this.snapshotProgress(row.id);
          if (progress) {
            const pausedRow = getDb()
              .update(schema.downloadQueue)
              .set({
                ...progress,
                speed: 0,
                currentFile: null,
                phase: null,
                revision: this.revisionExpr(row.id),
              })
              .where(eq(schema.downloadQueue.id, row.id))
              .returning()
              .get();
            finalTask = pausedRow ? rowToTask(pausedRow) : null;
          }
        } else if (ctx.shuttingDown || e instanceof DownloadShutdownError) {
          // Server shutdown: return to 'queued' so the next startup resumes from saved pages.
          const progress = this.snapshotProgress(row.id);
          const shutdownRow = getDb()
            .update(schema.downloadQueue)
            .set({
              status: "queued",
              speed: null,
              currentFile: null,
              phase: null,
              startedAt: null,
              ...progress,
              revision: this.revisionExpr(row.id),
            })
            .where(eq(schema.downloadQueue.id, row.id))
            .returning()
            .get();
          finalTask = shutdownRow ? rowToTask(shutdownRow) : null;
        } else if (!ctx.cancelled) {
          const message = e instanceof Error ? e.message : String(e);
          const errorCode = classifyDownloadError(e, false);
          const progress = this.snapshotProgress(row.id);
          if (isTransientError(e)) {
            finalTask = this.scheduleAutoRetry(
              row.id,
              message,
              errorRetryAfterMs(e),
              {
                errorCode,
                ...progress,
              }
            );
          } else {
            finalTask = this.setStatus(row.id, "failed", undefined, {
              errorMessage: message,
              errorCode,
              retryAt: null,
              ...progress,
            });
          }
        }
      } finally {
        // NOTE: the tmpDir intentionally survives a failed/paused run (resume-from-partial);
        // it is removed here only implicitly by success above or by an explicit remove().
        // Drop the in-memory snapshot so subsequent reads reflect the authoritative DB state.
        this.live.delete(row.id);
        this.lastBroadcast.delete(row.id);
        this.lastWrite.delete(row.id);
        // Defensive: no worker may stay parked on the pause gate after the run ends.
        wakePaused(ctx);
        this.activeRuns.delete(row.id);
        if (!ctx.paused && !ctx.shuttingDown)
          this.discoverCompletedDownload(
            row.id,
            discoverySeriesName,
            finalTask
          );
        const final =
          finalTask !== undefined ? finalTask : this.readRow(row.id);
        if (final) this.broadcast(final);
      }
    };
    const previous = row.outputPath ? archiveResource(row.outputPath) : null;
    try {
      if (previous && !row.mergeFolder)
        await archiveMutations.run([previous], perform, ctx.controller.signal);
      else await perform();
    } catch (error) {
      // Cancellation/pause/shutdown can reject a reservation before perform() enters its cleanup block.
      this.live.delete(row.id);
      this.lastBroadcast.delete(row.id);
      this.lastWrite.delete(row.id);
      wakePaused(ctx);
      this.activeRuns.delete(row.id);
      const final = this.readRow(row.id);
      if (final) this.broadcast(final);
      if (!ctx.cancelled && !ctx.paused && !ctx.shuttingDown) throw error;
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
  private outputDestination(
    row: DownloadRow,
    gallery: DoujinGallery,
    settings: DownloaderSettings
  ): string {
    if (row.mergeFolder && row.outputFormat === "folder")
      throw new Error("Merged downloads require CBZ output");
    const base = path.resolve(settings.downloadDirectory);
    const name = galleryFilesystemName(
      gallery.title,
      row.source,
      gallery.galleryId
    );
    const dir = row.mergeFolder
      ? path.join(base, sanitizeFilename(row.mergeFolder, "merged"))
      : path.join(base, name);
    if (row.outputFormat === "folder") return dir;
    const prefix =
      row.chapterNumber != null
        ? `ch${String(row.chapterNumber).padStart(2, "0")} `
        : "";
    return path.join(dir, `${prefix}${name}.cbz`);
  }

  private async writeOutput(
    row: DownloadRow,
    gallery: DoujinGallery,
    images: { name: string; path: string }[],
    settings: DownloaderSettings,
    ctx: RunContext
  ): Promise<string> {
    if (row.mergeFolder && row.outputFormat === "folder") {
      throw new Error("Merged downloads require CBZ output");
    }
    const base = path.resolve(settings.downloadDirectory);
    const destination = this.outputDestination(row, gallery, settings);
    const dir =
      row.outputFormat === "folder" ? destination : path.dirname(destination);
    if (ctx.cancelled) throw new Error("Cancelled by user");
    if (ctx.paused) throw new DownloadPausedError();
    if (ctx.shuttingDown) throw new DownloadShutdownError();
    await fs.promises.mkdir(base, { recursive: true });
    // Stage on the destination volume; cancellation never touches published files.
    const stagingDir = await fs.promises.mkdtemp(
      path.join(base, ".htosho-download-")
    );
    const comicInfo = generateComicInfoXml(gallery, this.mergeOptions(row));
    try {
      if (row.outputFormat === "folder") {
        await mapLimit(images, 4, (img) => {
          if (ctx.cancelled) throw new Error("Cancelled by user");
          if (ctx.paused) throw new DownloadPausedError();
          if (ctx.shuttingDown) throw new DownloadShutdownError();
          return fs.promises.copyFile(
            img.path,
            path.join(stagingDir, img.name)
          );
        });
        await fs.promises.writeFile(
          path.join(stagingDir, "ComicInfo.xml"),
          comicInfo
        );
        if (ctx.cancelled) throw new Error("Cancelled by user");
        if (ctx.paused) throw new DownloadPausedError();
        if (ctx.shuttingDown) throw new DownloadShutdownError();
        ctx.committing = true;
        await fs.promises.mkdir(dir, { recursive: true });
        // Preserve unrelated files in an existing gallery folder. Each name is
        // distinct, so replacements are independent; a little parallelism
        // keeps large galleries from paying hundreds of serial rename trips.
        await mapLimit(
          [...images.map((img) => img.name), "ComicInfo.xml"],
          4,
          (name) =>
            replacePublishedFile(
              path.join(stagingDir, name),
              path.join(dir, name)
            )
        );
        return dir;
      }

      const file = destination;
      const stagedFile = path.join(stagingDir, "archive.cbz");
      await buildZipFromFiles(
        images,
        stagedFile,
        [{ name: "ComicInfo.xml", data: Buffer.from(comicInfo, "utf8") }],
        ctx.controller.signal
      );
      if (ctx.cancelled) throw new Error("Cancelled by user");
      if (ctx.paused) throw new DownloadPausedError();
      if (ctx.shuttingDown) throw new DownloadShutdownError();
      return await guardDownloadPublication(
        {
          downloadId: row.id,
          targetDir: dir,
          previousOutputPath: row.outputPath,
          legacyMergeFolder: row.mergeFolder,
        },
        async () => {
          if (ctx.cancelled) throw new Error("Cancelled by user");
          if (ctx.paused) throw new DownloadPausedError();
          if (ctx.shuttingDown) throw new DownloadShutdownError();
          ctx.committing = true;
          await fs.promises.mkdir(dir, { recursive: true });
          await replacePublishedFile(stagedFile, file);
          return file;
        },
        ctx.controller.signal
      );
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
    }
  }

  /** ComicInfo overrides for merged downloads: shared series name + manual chapter number. */
  private mergeOptions(
    row: DownloadRow
  ): { seriesName?: string; number?: string } | undefined {
    if (!row.mergeFolder && row.chapterNumber == null) return undefined;
    return {
      ...(row.mergeFolder ? { seriesName: row.mergeFolder } : {}),
      ...(row.chapterNumber != null
        ? { number: String(row.chapterNumber) }
        : {}),
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
