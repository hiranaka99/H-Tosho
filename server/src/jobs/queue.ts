import { classifyJobError, type JobErrorCode } from './errors.js';
import { onSettingChange } from '../services/settings.js';
import { settleMetadataRestoreJob } from '../services/metadataRestore.js';
import { readJobPayload } from './storage.js';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { getDb, schema, type Db } from '../db/index.js';
import { jobRecovery, type JobRecovery } from './recovery.js';

export { JOB_TYPES, isJobType } from '../contracts/jobs.js';
export type { JobType, JobContext, JobPayload, JobCommand } from '../contracts/jobs.js';
import { parseJobCommand, type JobType, type JobContext, type JobPayload, type JobCommand, type JobPayloads, type JobExecutionState } from '../contracts/jobs.js';
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
  errorCode?: JobErrorCode | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recovery?: JobRecovery;
  context?: JobContext;
  validationError?: string;
}

export interface JobLog {
  id: number;
  jobId: number;
  level: string;
  message: string;
  createdAt: string;
}

export type LogFn = (level: 'info' | 'warn' | 'error' | 'success', message: string) => void;
export type JobHandler = (job: Job, log: LogFn, signal?: AbortSignal) => Promise<unknown>;

/** Thrown by the executor when a running job observes a cancellation request. */
export class JobCancelled extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelled';
  }
}

export class JobConflict extends Error {
  constructor() { super('A sync is already running for this series'); }
}

const CONCURRENCY = 2;

interface JobRow {
  id: number;
  type: string;
  payloadJson: string;
  stateJson?: string;
  status: string;
  progressCurrent: number;
  progressTotal: number;
  resultJson: string | null;
  errorMessage: string | null;
  errorCode?: string | null;
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
    errorCode: row.errorCode as JobErrorCode | null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    recovery: jobRecovery({ status: row.status, type: row.type, payload: { ...payload }, errorMessage: row.errorMessage, errorCode: row.errorCode as JobErrorCode | null }),
    context: payload.context,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(json);
    if (fallback && typeof fallback === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) return fallback;
    return parsed as T;
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
  clearContextCache(): void {
    this.legacyContexts.clear();
    this.historyNames.clear();
    this.historyId = 0;
  }
  private handler: JobHandler | null = null;
  private running = 0;
  private pumping = false;
  private cancelRequested = new Set<number>();
  private controllers = new Map<number, AbortController>();
  private historyDb: Db | null = null;
  private historyId = 0;
  private historyNames = new Map<number, string>();
  private legacyContexts = new Map<number, JobPayload>();

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
    const decoded = readJobPayload(row.type, row.payloadJson, row.stateJson);
    const payload = structuredClone(this.legacyContexts.get(row.id) ?? decoded.payload);
    const context = this.contextForPayload(payload);
    const previousIds = new Set((payload.context?.series ?? []).filter((target) => target.name !== `Series #${target.id}`).map((target) => target.id));
    if (context && payload.contextPendingSeriesIds === undefined) {
      payload.contextPendingSeriesIds = context.series.filter((target) => !previousIds.has(target.id)).map((target) => target.id);
    }
    if (context) {
      payload.context = context;
      // Projection only: GET/list never write persistent job state.
      if (!safeParse<JobPayload>(row.stateJson ?? '{}', {}).context) {
        this.legacyContexts.set(row.id, payload);
        if (this.legacyContexts.size > 300) this.legacyContexts.delete(this.legacyContexts.keys().next().value!);
      }
    }
    return { ...rowToJob(row, payload), validationError: decoded.validationError };
  }

  /** Append discovered targets, upgrading placeholders but retaining original known names. */
  updateContext(jobId: number, context: JobContext): JobContext | undefined {
    const db = getDb();
    const row = db.select({ payloadJson: schema.jobs.payloadJson, stateJson: schema.jobs.stateJson }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    if (!row) return undefined;
    const payload = { ...safeParse<JobPayload>(row.payloadJson, {}), ...safeParse<JobPayload>(row.stateJson ?? '{}', {}) };
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
    this.legacyContexts.delete(jobId);
    const state = { ...safeParse<JobPayload>(row.stateJson ?? '{}', {}), context: payload.context, contextPendingSeriesIds: payload.contextPendingSeriesIds };
    db.update(schema.jobs).set({ stateJson: JSON.stringify(state) }).where(eq(schema.jobs.id, jobId)).run();
    return payload.context;
  }

  /** Persist merge progress without overwriting independently resolved context. */
  updateMergeState(jobId: number, state: Pick<JobPayload, 'mergeDownloadIds' | 'sourceFiles' | 'chapters'>): void {
    const db = getDb();
    const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    if (!row || row.type !== 'merge-series') return;
    this.legacyContexts.delete(jobId);
    db.update(schema.jobs).set({ stateJson: JSON.stringify({ ...safeParse<JobPayload>(row.stateJson ?? '{}', {}), ...state }) }).where(eq(schema.jobs.id, jobId)).run();
  }

  /** Register the function that actually performs each job. */
  registerHandler(h: JobHandler): void {
    this.handler = h;
    void this.pump();
  }

  /** Insert a new job and return its id. */
  enqueue<T extends JobType>(type: T, payload: JobPayloads[NoInfer<T>] & JobExecutionState): number {
    const command = parseJobCommand(type, payload);
    if (command.type === 'apply-series' && this.active().some(job => job.type === command.type && job.payload.seriesId === command.payload.seriesId)) throw new JobConflict();
    const db = getDb();
    const context = this.contextForPayload(payload);
    if (context) {
      const knownIds = new Set((payload.context?.series ?? []).filter((target) => target.name !== `Series #${target.id}`).map((target) => target.id));
      payload = { ...payload, context, contextPendingSeriesIds: payload.contextPendingSeriesIds ?? context.series.filter((target) => !knownIds.has(target.id)).map((target) => target.id) };
    }
    const res = db
      .insert(schema.jobs)
      .values({ type, payloadJson: JSON.stringify(command.payload), stateJson: JSON.stringify({ context: payload.context, contextPendingSeriesIds: payload.contextPendingSeriesIds, mergeDownloadIds: payload.mergeDownloadIds, sourceFiles: payload.mergeDownloadIds ? payload.sourceFiles : undefined, chapters: payload.mergeDownloadIds ? payload.chapters : undefined }), status: 'queued' })
      .run();
    const id = Number(res.lastInsertRowid);
    this.log(id, 'info', `Job enqueued: ${type}`);
    // Approved restore plans and their job must commit before execution starts.
    queueMicrotask(() => void this.pump());
    return id;
  }

  enqueueCommand(command: JobCommand, state: JobExecutionState = {}): number {
    return this.enqueue(command.type, { ...command.payload, ...state });
  }

  get(id: number): Job | null {
    const row = getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    return row ? this.hydrate(row) : null;
  }

  list(limit = 100): Job[] {
    const rows = getDb().select().from(schema.jobs).orderBy(desc(schema.jobs.id)).limit(limit).all();
    return rows.map((row) => this.hydrate(row));
  }

  latest(type: JobType): Job | null {
    const row = getDb().select().from(schema.jobs).where(eq(schema.jobs.type, type)).orderBy(desc(schema.jobs.id)).limit(1).get();
    return row ? this.hydrate(row) : null;
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
        if (job.type === 'restore-metadata') settleMetadataRestoreJob(id, 'cancelled', 'Cancelled before restore started');
        return true;
      }
    }
    const current = this.get(id);
    if (current?.status === 'running') {
      this.cancelRequested.add(id);
      this.controllers.get(id)?.abort(new JobCancelled());
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
    if (!job || job.status !== 'failed' || job.type === 'restore-metadata') return null;
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
    if (this.pumping || !this.handler) return;
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
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      if (!this.handler) throw new Error('No job handler registered');
      log('info', `Starting ${job.type}`);
      if (job.validationError) throw new Error(`Invalid persisted job command: ${job.validationError}`);
      parseJobCommand(job.type, job.payload);
      const result = await this.handler(job, log, controller.signal);
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
          .set({ status: 'failed', errorMessage: message, errorCode: classifyJobError(message), finishedAt: new Date().toISOString() })
          .where(eq(schema.jobs.id, job.id))
          .run();
        this.log(job.id, 'error', message);
      }
    } finally {
      if (job.type === 'restore-metadata') {
        const terminal = this.get(job.id);
        if (terminal) settleMetadataRestoreJob(job.id, terminal.status, terminal.errorMessage ?? undefined);
      }
      this.cancelRequested.delete(job.id);
      this.controllers.delete(job.id);
      this.running--;
      void this.pump();
    }
  }
}

export const jobQueue = new JobQueue();
onSettingChange('kavita-connection', () => jobQueue.clearContextCache());
