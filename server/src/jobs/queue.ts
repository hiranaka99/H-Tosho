import { asc, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

/** Types of background jobs the queue can run. */
export type JobType =
  | 'scan-new'
  | 'match-unmatched'
  | 'match-library'
  | 'match-series'
  | 'sync-series'
  | 'clear-overrides';

export interface JobPayload {
  libraryId?: number;
  seriesId?: number;
  seriesIds?: number[];
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

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    payload: safeParse(row.payloadJson, {}),
    status: row.status as JobStatus,
    progressCurrent: row.progressCurrent,
    progressTotal: row.progressTotal,
    result: row.resultJson ? safeParse(row.resultJson, null) : null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
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

  /** Register the function that actually performs each job. */
  registerHandler(h: JobHandler): void {
    this.handler = h;
    void this.pump();
  }

  /** Insert a new job and return its id. */
  enqueue(type: JobType, payload: JobPayload = {}): number {
    const db = getDb();
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
    return row ? rowToJob(row) : null;
  }

  list(limit = 100): Job[] {
    const rows = getDb().select().from(schema.jobs).orderBy(desc(schema.jobs.id)).limit(limit).all();
    return rows.map(rowToJob);
  }

  /** Jobs that are queued or currently running. */
  active(): Job[] {
    const rows = getDb().select().from(schema.jobs).where(eq(schema.jobs.status, 'running')).all();
    return rows.map(rowToJob);
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
      getDb().update(schema.jobs).set({ status: 'cancelled', finishedAt: new Date().toISOString() }).where(eq(schema.jobs.id, id)).run();
      this.log(id, 'info', 'Job cancelled before start');
      return true;
    }
    if (job.status === 'running') {
      this.cancelRequested.add(id);
      this.log(id, 'info', 'Cancellation requested; stopping at next checkpoint');
      return true;
    }
    return false;
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
    return rowToJob({ ...row, status: 'running' });
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
          progressTotal: job.progressTotal,
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