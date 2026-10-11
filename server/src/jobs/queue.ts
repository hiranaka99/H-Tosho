import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { getDb, schema, type Db } from '../db/index.js';
import { jobRecovery, type JobRecovery } from './recovery.js';
import type { DoujinSource } from '../downloader/types.js';

/** Types of background jobs the queue can run. */
export const JOB_TYPES = [
  'scan-new',
  'match-unmatched',
  'match-library',
  'match-series',
  'sync-series',
  'apply-series',
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

export interface JobPayload {
  libraryId?: number;
  seriesId?: number;
  seriesIds?: number[];
  /** Original targets, retained even after series are renamed or deleted. */
  context?: JobContext;
  /** Internal provenance: local-history/fallback names may be upgraded once live targets resolve. */
  contextPendingSeriesIds?: number[];
  /** edit-comicinfo: absolute path of the .cbz to rewrite. */
  path?: string;
  /** edit-comicinfo: pre-rendered ComicInfo.xml (raw-XML mode) — used verbatim. */
  xml?: string;
  /** edit-comicinfo: edited field values (merged over the file's current entry). */
  fields?: Record<string, string>;
  /** merge-series: absolute paths of the .cbz files to move together. */
  sourceFiles?: string[];
  /** merge-series: absolute target folder (becomes the Kavita series name). */
  targetDir?: string;
  /** merge-series: chapter numbers keyed by source path, written to ComicInfo.Number. */
  chapters?: Record<string, string>;
  /** merge-series: staged chapter edits for archives already in the target folder. */
  existingChapters?: Record<string, string>;
  /** merge-series: galleries to download after the user commits the merge. */
  downloads?: { source: DoujinSource; galleryId: string; title: string; chapter: string; allowDuplicate?: boolean }[];
  /** Internal checkpoint: reuse the same download tasks after a job retry. */
  mergeDownloadIds?: Record<string, number>;
  /** apply-series: provider of the candidate chosen in the identify dialog. */
  providerId?: string;
  /** apply-series: provider-side series id of the chosen candidate. */
  providerSeriesId?: string;
  /** apply-series: ComicInfo.Series value to write (one of the provider's titleOptions). */
  selectedTitle?: string;
  /** apply-series: sync fields deselected in the dialog. */
  excludedFields?: string[];
  /** apply-series: push series + volume covers (default true). */
  cover?: boolean;
  /** apply-series: candidate match score, kept on the match row. */
  score?: number;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: number;
  type: JobType;
  payload: JobPayload;
  status: JobStatus;
  progressCurrent: number;
  progressTotal: number;
  result: unknown;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recovery?: JobRecovery;
  context?: JobContext;
}

export interface JobLog {
  id: number;
  jobId: number;
  level: string;
  message: string;
  createdAt: string;
}

export type LogFn = (level: 'info' | 'warn' | 'error' | 'success', message: string) => void;
export type JobHandler = (job: Job, log: LogFn) => Promise<unknown>;

/** Thrown by the executor when a running job observes a cancellation request. */
export class JobCancelled extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelled';
  }
}

const CONCURRENCY = 2;

interface JobRow {
  id: number;
  type: string;
  payloadJson: string;
  status: string;
  progressCurrent: number;
  progressTotal: number;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function rowToJob(row: JobRow, payload: JobPayload): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    payload,
    status: row.status as JobStatus,
    progressCurrent: row.progressCurrent,
    progressTotal: row.progressTotal,
    result: row.resultJson ? safeParse(row.resultJson, null) : null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    recovery: jobRecovery({ status: row.status, type: row.type, payload: { ...payload }, errorMessage: row.errorMessage }),
    context: payload.context,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * A small persistent job queue backed by the SQLite `jobs` / `job_logs`
 * tables. Jobs survive restarts (queued/running are re-pumped on boot) and
 * execute with a bounded concurrency.
 */
class JobQueue {
  private handler: JobHandler | null = null;
  private running = 0;
  private pumping = false;
  private cancelRequested = new Set<number>();
  private historyDb: Db | null = null;
  private historyId = 0;
  private historyNames = new Map<number, string>();

  /** Read only newly appended history, never the full history table on every poll. */
  private refreshHistoryNames(): void {
    const db = getDb();
    if (this.historyDb !== db) {
      this.historyDb = db;
      this.historyId = 0;
      this.historyNames.clear();
    }
    const latest = db.select({ id: schema.syncHistory.id }).from(schema.syncHistory)
      .orderBy(desc(schema.syncHistory.id)).limit(1).get();
    if (!latest || latest.id <= this.historyId) return;
    const rows = db.select({ id: schema.syncHistory.id, seriesId: schema.syncHistory.kavitaSeriesId, name: schema.syncHistory.seriesTitle })
      .from(schema.syncHistory).where(gt(schema.syncHistory.id, this.historyId)).orderBy(asc(schema.syncHistory.id)).all();
    for (const row of rows) {
      if (row.name?.trim()) this.historyNames.set(row.seriesId, row.name.trim());
      this.historyId = row.id;
    }
  }

  /** Local-only recovery for legacy rows and unresolved explicit targets. */
  contextForPayload(payload: JobPayload): JobContext | undefined {
    const ids = [...new Set([...(payload.seriesId !== undefined ? [payload.seriesId] : []), ...(payload.seriesIds ?? [])])];
    if (!payload.context && !ids.length && payload.libraryId === undefined) return undefined;
    const series = new Map((payload.context?.series ?? []).map((target) => [target.id, { ...target }]));
    for (const id of ids) if (!series.has(id)) series.set(id, { id, name: `Series #${id}` });
    if ([...series.values()].some((target) => !target.name.trim() || target.name === `Series #${target.id}`)) {
      this.refreshHistoryNames();
      for (const target of series.values()) {
        if (!target.name.trim() || target.name === `Series #${target.id}`) {
          target.name = this.historyNames.get(target.id) ?? `Series #${target.id}`;
        }
      }
    }
    return {
      ...payload.context,
      series: [...series.values()],
      libraryId: payload.context?.libraryId ?? payload.libraryId,
    };
  }

  private hydrate(row: JobRow): Job {
    const payload = safeParse<JobPayload>(row.payloadJson, {});
    const context = this.contextForPayload(payload);
    const previousIds = new Set((payload.context?.series ?? []).filter((target) => target.name !== `Series #${target.id}`).map((target) => target.id));
    if (context && payload.contextPendingSeriesIds === undefined) {
      payload.contextPendingSeriesIds = context.series.filter((target) => !previousIds.has(target.id)).map((target) => target.id);
    }
    if (context) {
      payload.context = context;
      const payloadJson = JSON.stringify(payload);
      if (payloadJson !== row.payloadJson) getDb().update(schema.jobs).set({ payloadJson }).where(eq(schema.jobs.id, row.id)).run();
    }
    return rowToJob(row, payload);
  }

  /** Append discovered targets, upgrading placeholders but retaining original known names. */
  updateContext(jobId: number, context: JobContext): JobContext | undefined {
    const db = getDb();
    const row = db.select({ payloadJson: schema.jobs.payloadJson }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    if (!row) return undefined;
    const payload = safeParse<JobPayload>(row.payloadJson, {});
    const previous = payload.context;
    const series = new Map((previous?.series ?? []).map((target) => [target.id, target]));
    const pendingIds = new Set(payload.contextPendingSeriesIds ?? []);
    for (const target of context.series) {
      const known = series.get(target.id);
      if (pendingIds.has(target.id) || !known?.name.trim() || known.name === `Series #${target.id}`) series.set(target.id, target);
      pendingIds.delete(target.id);
    }
    const libraryId = previous?.libraryId ?? context.libraryId ?? payload.libraryId;
    payload.context = this.contextForPayload({
      ...payload,
      context: {
        series: [...series.values()],
        libraryId,
        libraryName: previous?.libraryName ?? (libraryId === context.libraryId ? context.libraryName : undefined),
      },
    });
    payload.contextPendingSeriesIds = [...pendingIds];
    const payloadJson = JSON.stringify(payload);
    if (payloadJson !== row.payloadJson) db.update(schema.jobs).set({ payloadJson }).where(eq(schema.jobs.id, jobId)).run();
    return payload.context;
  }

  /** Persist merge progress without overwriting independently resolved context. */
  updateMergeState(jobId: number, state: Pick<JobPayload, 'mergeDownloadIds' | 'sourceFiles' | 'chapters'>): void {
    const db = getDb();
    const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    if (!row || row.type !== 'merge-series') return;
    const payload = safeParse<JobPayload>(row.payloadJson, {});
    db.update(schema.jobs).set({ payloadJson: JSON.stringify({ ...payload, ...state }) }).where(eq(schema.jobs.id, jobId)).run();
  }

  /** Register the function that actually performs each job. */
  registerHandler(h: JobHandler): void {
    this.handler = h;
    void this.pump();
  }

  /** Insert a new job and return its id. */
  enqueue(type: JobType, payload: JobPayload = {}): number {
    const db = getDb();
    const context = this.contextForPayload(payload);
    if (context) {
      const knownIds = new Set((payload.context?.series ?? []).filter((target) => target.name !== `Series #${target.id}`).map((target) => target.id));
      payload = { ...payload, context, contextPendingSeriesIds: payload.contextPendingSeriesIds ?? context.series.filter((target) => !knownIds.has(target.id)).map((target) => target.id) };
    }
    const res = db
      .insert(schema.jobs)
      .values({ type, payloadJson: JSON.stringify(payload), status: 'queued' })
      .run();
    const id = Number(res.lastInsertRowid);
    this.log(id, 'info', `Job enqueued: ${type}`);
    void this.pump();
    return id;
  }

  get(id: number): Job | null {
    const row = getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    return row ? this.hydrate(row) : null;
  }

  list(limit = 100): Job[] {
    const rows = getDb().select().from(schema.jobs).orderBy(desc(schema.jobs.id)).limit(limit).all();
    return rows.map((row) => this.hydrate(row));
  }

  /** Jobs that are queued or currently running. */
  active(): Job[] {
    const rows = getDb().select().from(schema.jobs).where(inArray(schema.jobs.status, ['queued', 'running'])).all();
    return rows.map((row) => this.hydrate(row));
  }

  /**
   * Request cancellation of an active job. Queued jobs are cancelled
   * immediately; running jobs stop at their next checkpoint. Returns false if
   * the job does not exist or is already finished.
   */
  cancel(id: number): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      // Conditional update: the job may be claimed as running between the read
      // and the write — in that case fall through to the checkpoint path.
      const res = getDb()
        .update(schema.jobs)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, 'queued')))
        .run();
      if (Number(res.changes ?? 0) > 0) {
        this.log(id, 'info', 'Job cancelled before start');
        return true;
      }
    }
    const current = this.get(id);
    if (current?.status === 'running') {
      this.cancelRequested.add(id);
      this.log(id, 'info', 'Cancellation requested; stopping at next checkpoint');
      return true;
    }
    return false;
  }

  /**
   * Retry a failed job by copying its type + payload into a NEW queued
   * job row; the original stays as history. Returns the new id, or null when
   * the job is missing or not in a failed state.
   */
  retryJob(id: number): number | null {
    const job = this.get(id);
    if (!job || job.status !== 'failed') return null;
    const newId = this.enqueue(job.type, job.payload);
    this.log(id, 'info', `Retried as job #${newId}`);
    return newId;
  }

  /** Remove failed history and its logs atomically; never delete active or successful work. */
  clearFailed(id?: number): number {
    const failed = id === undefined
      ? eq(schema.jobs.status, 'failed')
      : and(eq(schema.jobs.id, id), eq(schema.jobs.status, 'failed'));
    return getDb().transaction((tx) => {
      const failedIds = tx.select({ id: schema.jobs.id }).from(schema.jobs).where(failed);
      tx.delete(schema.jobLogs).where(inArray(schema.jobLogs.jobId, failedIds)).run();
      return tx.delete(schema.jobs).where(failed).run().changes;
    });
  }

  /** Whether cancellation has been requested for a running job. */
  isCancelRequested(id: number): boolean {
    return this.cancelRequested.has(id);
  }

  setProgress(jobId: number, current: number, total: number): void {
    getDb().update(schema.jobs).set({ progressCurrent: current, progressTotal: total }).where(eq(schema.jobs.id, jobId)).run();
  }

  logs(jobId: number): JobLog[] {
    return getDb().select().from(schema.jobLogs).where(eq(schema.jobLogs.jobId, jobId)).orderBy(asc(schema.jobLogs.id)).all();
  }

  recentLogs(limit = 300): JobLog[] {
    return getDb().select().from(schema.jobLogs).orderBy(desc(schema.jobLogs.id)).limit(limit).all().reverse();
  }

  log(jobId: number, level: string, message: string): void {
    getDb().insert(schema.jobLogs).values({ jobId, level, message }).run();
  }

  private claimNext(): Job | null {
    const db = getDb();
    const row = db.select().from(schema.jobs).where(eq(schema.jobs.status, 'queued')).orderBy(asc(schema.jobs.id)).limit(1).get();
    if (!row) return null;
    db.update(schema.jobs).set({ status: 'running', startedAt: new Date().toISOString() }).where(eq(schema.jobs.id, row.id)).run();
    return this.hydrate({ ...row, status: 'running' });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running < CONCURRENCY) {
        const next = this.claimNext();
        if (!next) break;
        this.running++;
        void this.process(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async process(job: Job): Promise<void> {
    const db = getDb();
    const log: LogFn = (level, message) => this.log(job.id, level, message);
    try {
      if (!this.handler) throw new Error('No job handler registered');
      log('info', `Starting ${job.type}`);
      const result = await this.handler(job, log);
      db.update(schema.jobs)
        .set({
          status: 'completed',
          resultJson: result === undefined ? null : JSON.stringify(result),
          finishedAt: new Date().toISOString(),
        })
        .where(eq(schema.jobs.id, job.id))
        .run();
      this.log(job.id, 'success', `Completed ${job.type}`);
    } catch (e) {
      if (e instanceof JobCancelled) {
        db.update(schema.jobs).set({ status: 'cancelled', finishedAt: new Date().toISOString() }).where(eq(schema.jobs.id, job.id)).run();
        this.log(job.id, 'info', `Cancelled ${job.type}`);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        db.update(schema.jobs)
          .set({ status: 'failed', errorMessage: message, finishedAt: new Date().toISOString() })
          .where(eq(schema.jobs.id, job.id))
          .run();
        this.log(job.id, 'error', message);
      }
    } finally {
      this.cancelRequested.delete(job.id);
      this.running--;
      void this.pump();
    }
  }
}

export const jobQueue = new JobQueue();
