import { classifyJobError, type JobErrorCode } from "./errors.js";
import { onSettingChange } from "../services/settings.js";
import { readJobPayload } from "./storage.js";
import {
  JobCancelled,
  getJobLifecycleHook,
  registerJobLifecycleHook,
  type JobStopReason,
  type JobTypeLifecycleHook,
} from "./lifecycle.js";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb, schema, type Db } from "../db/index.js";
import { jobRecovery, type JobRecovery } from "./recovery.js";

export { JobCancelled };
export type { JobStopReason, JobTypeLifecycleHook };

export { JOB_TYPES, isJobType } from "../contracts/jobs.js";
export type {
  JobType,
  JobContext,
  JobPayload,
  JobCommand,
} from "../contracts/jobs.js";
import {
  parseJobCommand,
  type JobType,
  type JobContext,
  type JobPayload,
  type JobCommand,
  type JobPayloads,
  type JobExecutionState,
} from "../contracts/jobs.js";
export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

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

export type LogFn = (
  level: "info" | "warn" | "error" | "success",
  message: string
) => void;
export type JobHandler = (
  job: Job,
  log: LogFn,
  signal?: AbortSignal
) => Promise<unknown>;

export class JobConflict extends Error {
  constructor(message = "A sync is already running for this series") {
    super(message);
  }
}

const CONCURRENCY = 2;
/** Newest log lines returned for one job; long library jobs can write many thousands. */
const JOB_LOG_LIMIT = 2000;
/** Ids per IN (...) list, well under SQLite's bound-variable limit. */
const ID_CHUNK = 500;
const chunks = <T>(values: T[]): T[][] =>
  Array.from({ length: Math.ceil(values.length / ID_CHUNK) }, (_, index) =>
    values.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK)
  );

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
    recovery: jobRecovery({
      status: row.status,
      type: row.type,
      payload: { ...payload },
      errorMessage: row.errorMessage,
      errorCode: row.errorCode as JobErrorCode | null,
    }),
    context: payload.context,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      fallback &&
      typeof fallback === "object" &&
      (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    )
      return fallback;
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
  private settledListeners = new Set<
    (event: { id: number; type: JobType; status: JobStatus }) => void
  >();
  private historyDb: Db | null = null;

  onSettled(
    listener: (event: { id: number; type: JobType; status: JobStatus }) => void
  ): () => void {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  }

  private emitSettled(event: {
    id: number;
    type: JobType;
    status: JobStatus;
  }): void {
    for (const listener of this.settledListeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not disrupt queue state */
      }
    }
  }
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
    const latest = db
      .select({ id: schema.syncHistory.id })
      .from(schema.syncHistory)
      .orderBy(desc(schema.syncHistory.id))
      .limit(1)
      .get();
    if (!latest || latest.id <= this.historyId) return;
    const rows = db
      .select({
        id: schema.syncHistory.id,
        seriesId: schema.syncHistory.kavitaSeriesId,
        name: schema.syncHistory.seriesTitle,
      })
      .from(schema.syncHistory)
      .where(gt(schema.syncHistory.id, this.historyId))
      .orderBy(asc(schema.syncHistory.id))
      .all();
    for (const row of rows) {
      if (row.name?.trim())
        this.historyNames.set(row.seriesId, row.name.trim());
      this.historyId = row.id;
    }
  }

  /** Local-only recovery for legacy rows and unresolved explicit targets. */
  contextForPayload(payload: JobPayload): JobContext | undefined {
    const ids = [
      ...new Set([
        ...(payload.seriesId !== undefined ? [payload.seriesId] : []),
        ...(payload.seriesIds ?? []),
      ]),
    ];
    if (!payload.context && !ids.length && payload.libraryId === undefined)
      return undefined;
    const series = new Map(
      (payload.context?.series ?? []).map((target) => [
        target.id,
        { ...target },
      ])
    );
    for (const id of ids)
      if (!series.has(id)) series.set(id, { id, name: `Series #${id}` });
    if (
      [...series.values()].some(
        (target) =>
          !target.name.trim() || target.name === `Series #${target.id}`
      )
    ) {
      this.refreshHistoryNames();
      for (const target of series.values()) {
        if (!target.name.trim() || target.name === `Series #${target.id}`) {
          target.name =
            this.historyNames.get(target.id) ?? `Series #${target.id}`;
        }
      }
    }
    return {
      ...payload.context,
      series: [...series.values()],
      libraryId: payload.context?.libraryId ?? payload.libraryId,
    };
  }

  /**
   * Whether the persisted state column carries a context. Answered from the
   * already-decoded payload where that is exact, so list polls do not parse
   * every state column a second time.
   */
  private stateHasContext(
    row: JobRow,
    decodedContext: JobContext | undefined
  ): boolean {
    const stateJson = row.stateJson ?? "{}";
    // A top-level "context" key always appears literally in the JSON text.
    if (!stateJson.includes('"context"')) return false;
    // With no context in the command JSON, a decoded context can only have come
    // from the state column, and a decoded context is always a truthy object.
    if (decodedContext && !row.payloadJson.includes('"context"')) return true;
    return !!safeParse<JobPayload>(stateJson, {}).context;
  }

  private hydrate(row: JobRow): Job {
    const hook = getJobLifecycleHook(row.type as JobType);
    const decoded = readJobPayload(
      row.type,
      row.payloadJson,
      row.stateJson,
      hook?.hydrateState
    );
    const decodedContext = decoded.payload.context;
    const legacy = this.legacyContexts.get(row.id);
    // decoded.payload is freshly parsed for this call; only the shared cached
    // projection needs a private copy before it is handed out and modified.
    const payload = legacy ? structuredClone(legacy) : decoded.payload;
    const context = this.contextForPayload(payload);
    const previousIds = new Set(
      (payload.context?.series ?? [])
        .filter((target) => target.name !== `Series #${target.id}`)
        .map((target) => target.id)
    );
    if (context && payload.contextPendingSeriesIds === undefined) {
      payload.contextPendingSeriesIds = context.series
        .filter((target) => !previousIds.has(target.id))
        .map((target) => target.id);
    }
    if (context) {
      payload.context = context;
      // Projection only: GET/list never write persistent job state.
      if (!this.stateHasContext(row, decodedContext)) {
        this.legacyContexts.set(row.id, payload);
        if (this.legacyContexts.size > 300)
          this.legacyContexts.delete(this.legacyContexts.keys().next().value!);
      }
    }
    return {
      ...rowToJob(row, payload),
      validationError: decoded.validationError,
    };
  }

  /** Append discovered targets, upgrading placeholders but retaining original known names. */
  updateContext(jobId: number, context: JobContext): JobContext | undefined {
    const db = getDb();
    const row = db
      .select({
        payloadJson: schema.jobs.payloadJson,
        stateJson: schema.jobs.stateJson,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .get();
    if (!row) return undefined;
    const parsedState = safeParse<JobPayload>(row.stateJson ?? "{}", {});
    const payload = {
      ...safeParse<JobPayload>(row.payloadJson, {}),
      ...parsedState,
    };
    const previous = payload.context;
    const series = new Map(
      (previous?.series ?? []).map((target) => [target.id, target])
    );
    const pendingIds = new Set(payload.contextPendingSeriesIds ?? []);
    for (const target of context.series) {
      const known = series.get(target.id);
      if (
        pendingIds.has(target.id) ||
        !known?.name.trim() ||
        known.name === `Series #${target.id}`
      )
        series.set(target.id, target);
      pendingIds.delete(target.id);
    }
    const libraryId =
      previous?.libraryId ?? context.libraryId ?? payload.libraryId;
    payload.context = this.contextForPayload({
      ...payload,
      context: {
        series: [...series.values()],
        libraryId,
        libraryName:
          previous?.libraryName ??
          (libraryId === context.libraryId ? context.libraryName : undefined),
      },
    });
    payload.contextPendingSeriesIds = [...pendingIds];
    this.legacyContexts.delete(jobId);
    const state = {
      ...parsedState,
      context: payload.context,
      contextPendingSeriesIds: payload.contextPendingSeriesIds,
    };
    db.update(schema.jobs)
      .set({ stateJson: JSON.stringify(state) })
      .where(eq(schema.jobs.id, jobId))
      .run();
    return payload.context;
  }

  /** Register domain-specific state hydration, retry, clear, and stop hooks for one job type. */
  registerLifecycleHook(type: JobType, hook: JobTypeLifecycleHook): void {
    registerJobLifecycleHook(type, hook);
  }

  /** Drop cached legacy projections after a job-type module updates `state_json` directly. */
  invalidateContextCache(jobIds: number | readonly number[]): void {
    if (typeof jobIds === "number") {
      this.legacyContexts.delete(jobIds);
      return;
    }
    for (const jobId of jobIds) this.legacyContexts.delete(jobId);
  }

  /** Register the function that actually performs each job. */
  registerHandler(h: JobHandler): void {
    this.handler = h;
    void this.pump();
  }

  /** Insert a new job and return its id. */
  enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[NoInfer<T>] & JobExecutionState,
    extraState?: Record<string, unknown>
  ): number {
    const command = parseJobCommand(type, payload);
    if (
      command.type === "apply-series" &&
      this.hasActiveSeriesJob(command.type, command.payload.seriesId)
    )
      throw new JobConflict();
    const db = getDb();
    const context = this.contextForPayload(payload);
    if (context) {
      const knownIds = new Set(
        (payload.context?.series ?? [])
          .filter((target) => target.name !== `Series #${target.id}`)
          .map((target) => target.id)
      );
      payload = {
        ...payload,
        context,
        contextPendingSeriesIds:
          payload.contextPendingSeriesIds ??
          context.series
            .filter((target) => !knownIds.has(target.id))
            .map((target) => target.id),
      };
    }
    const hookInitial = getJobLifecycleHook(type)?.initialState?.(
      payload,
      payload
    );
    const state = {
      context: payload.context,
      contextPendingSeriesIds: payload.contextPendingSeriesIds,
      ...hookInitial,
      ...extraState,
    };
    const res = db
      .insert(schema.jobs)
      .values({
        type,
        payloadJson: JSON.stringify(command.payload),
        stateJson: JSON.stringify(state),
        status: "queued",
      })
      .run();
    const id = Number(res.lastInsertRowid);
    this.log(id, "info", `Job enqueued: ${type}`);
    // Approved restore plans and their job must commit before execution starts.
    queueMicrotask(() => void this.pump());
    return id;
  }

  enqueueCommand(
    command: JobCommand,
    state: JobExecutionState = {},
    extraState?: Record<string, unknown>
  ): number {
    return this.enqueue(
      command.type,
      { ...command.payload, ...state },
      extraState
    );
  }

  get(id: number): Job | null {
    const row = getDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id))
      .get();
    return row ? this.hydrate(row) : null;
  }

  list(limit = 100): Job[] {
    const rows = getDb()
      .select()
      .from(schema.jobs)
      .orderBy(desc(schema.jobs.id))
      .limit(limit)
      .all();
    return rows.map((row) => this.hydrate(row));
  }

  latest(type: JobType): Job | null {
    const row = getDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, type))
      .orderBy(desc(schema.jobs.id))
      .limit(1)
      .get();
    return row ? this.hydrate(row) : null;
  }

  /** Timestamp of the newest job of a type without decoding payload/state blobs. */
  latestCreatedAt(type: JobType): string | null {
    const row = getDb()
      .select({ createdAt: schema.jobs.createdAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.type, type))
      .orderBy(desc(schema.jobs.id))
      .limit(1)
      .get();
    return row?.createdAt ?? null;
  }

  /** Queued or running jobs restricted to the given types (backed by idx_jobs_active). */
  activeByTypes(types: JobType[]): Job[] {
    if (!types.length) return [];
    const rows = getDb()
      .select()
      .from(schema.jobs)
      .where(
        and(
          inArray(schema.jobs.type, types),
          inArray(schema.jobs.status, ["queued", "running"])
        )
      )
      .all();
    return rows.map((row) => this.hydrate(row));
  }

  /** Whether any job of this type is queued or running, without hydrating rows. */
  hasActiveType(type: JobType): boolean {
    return !!getDb()
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, type),
          inArray(schema.jobs.status, ["queued", "running"])
        )
      )
      .limit(1)
      .get();
  }

  /** Active-job conflict check for one series, decoding only that type's payloads. */
  private hasActiveSeriesJob(
    type: JobType,
    seriesId: number | undefined
  ): boolean {
    return getDb()
      .select({
        type: schema.jobs.type,
        payloadJson: schema.jobs.payloadJson,
        stateJson: schema.jobs.stateJson,
      })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, type),
          inArray(schema.jobs.status, ["queued", "running"])
        )
      )
      .all()
      .some(
        (row) =>
          readJobPayload(row.type, row.payloadJson, row.stateJson).payload
            .seriesId === seriesId
      );
  }

  /** Jobs that are queued or currently running. */
  active(): Job[] {
    const rows = getDb()
      .select()
      .from(schema.jobs)
      .where(inArray(schema.jobs.status, ["queued", "running"]))
      .all();
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
    if (job.status === "queued") {
      // Conditional update: the job may be claimed as running between the read
      // and the write — in that case fall through to the checkpoint path.
      const res = getDb()
        .update(schema.jobs)
        .set({ status: "cancelled", finishedAt: new Date().toISOString() })
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, "queued")))
        .run();
      if (Number(res.changes ?? 0) > 0) {
        this.log(id, "info", "Job cancelled before start");
        const hook = getJobLifecycleHook(job.type);
        hook?.onSettled?.(id, "cancelled", "Cancelled before restore started");
        hook?.onStopped?.(id, "cancelled");
        this.emitSettled({ id, type: job.type, status: "cancelled" });
        return true;
      }
    }
    const current = this.get(id);
    if (current?.status === "running") {
      this.cancelRequested.add(id);
      this.controllers.get(id)?.abort(new JobCancelled());
      this.log(
        id,
        "info",
        "Cancellation requested; stopping at next checkpoint"
      );
      getJobLifecycleHook(current.type)?.onStopped?.(id, "cancelled");
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
    if (!job || job.status !== "failed" || job.type === "restore-metadata")
      return null;
    const carriedState = getJobLifecycleHook(job.type)?.stateForRetry?.(job);
    const newId = this.enqueue(job.type, job.payload, carriedState);
    this.log(id, "info", `Retried as job #${newId}`);
    return newId;
  }

  /** Remove failed history and its logs atomically; never delete active or successful work. */
  clearFailed(id?: number): number {
    const failed =
      id === undefined
        ? eq(schema.jobs.status, "failed")
        : and(eq(schema.jobs.id, id), eq(schema.jobs.status, "failed"));
    // Lifecycle checks run before the write transaction so it never holds the
    // database lock across disk I/O. Everything here is synchronous, so no job
    // can change state between the checks and the deletes; the status guard
    // below is kept regardless.
    const candidates = getDb()
      .select()
      .from(schema.jobs)
      .where(failed)
      .all()
      .filter((row) => {
        const hook = getJobLifecycleHook(row.type as JobType);
        return hook?.canClearFailed ? hook.canClearFailed(row) : true;
      })
      .map((row) => row.id);
    if (!candidates.length) return 0;
    return getDb().transaction((tx) => {
      let removed = 0;
      for (const chunk of chunks(candidates)) {
        const failedIds = tx
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(
            and(
              inArray(schema.jobs.id, chunk),
              eq(schema.jobs.status, "failed")
            )
          )
          .all()
          .map((row) => row.id);
        if (!failedIds.length) continue;
        tx.delete(schema.jobLogs)
          .where(inArray(schema.jobLogs.jobId, failedIds))
          .run();
        removed += tx
          .delete(schema.jobs)
          .where(inArray(schema.jobs.id, failedIds))
          .run().changes;
      }
      return removed;
    });
  }

  /**
   * Startup recovery: jobs still marked 'running' were orphaned by a crash or
   * restart (no process is executing them). Mark them failed so the UI shows
   * no ghosts and notify job-type hooks so owned resources are released.
   */
  interruptRunningJobs(): number {
    const db = getDb();
    const interrupted = db
      .update(schema.jobs)
      .set({
        status: "failed",
        errorMessage: "Interrupted by server restart",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.jobs.status, "running"))
      .returning({ id: schema.jobs.id, type: schema.jobs.type })
      .all();
    for (const job of interrupted) {
      getJobLifecycleHook(job.type as JobType)?.onStopped?.(
        job.id,
        "interrupted"
      );
    }
    return interrupted.length;
  }

  /** Whether cancellation has been requested for a running job. */
  isCancelRequested(id: number): boolean {
    return this.cancelRequested.has(id);
  }

  setProgress(jobId: number, current: number, total: number): void {
    getDb()
      .update(schema.jobs)
      .set({ progressCurrent: current, progressTotal: total })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }

  /** The newest `limit` log lines of one job, oldest first. */
  logs(jobId: number, limit = JOB_LOG_LIMIT): JobLog[] {
    return getDb()
      .select()
      .from(schema.jobLogs)
      .where(eq(schema.jobLogs.jobId, jobId))
      .orderBy(desc(schema.jobLogs.id))
      .limit(limit)
      .all()
      .reverse();
  }

  recentLogs(limit = 300): JobLog[] {
    return getDb()
      .select()
      .from(schema.jobLogs)
      .orderBy(desc(schema.jobLogs.id))
      .limit(limit)
      .all()
      .reverse();
  }

  log(jobId: number, level: string, message: string): void {
    getDb().insert(schema.jobLogs).values({ jobId, level, message }).run();
  }

  private claimNext(): Job | null {
    const db = getDb();
    const row = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "queued"))
      .orderBy(asc(schema.jobs.id))
      .limit(1)
      .get();
    if (!row) return null;
    db.update(schema.jobs)
      .set({ status: "running", startedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, row.id))
      .run();
    return this.hydrate({ ...row, status: "running" });
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
    let terminalStatus: "completed" | "cancelled" | "failed" = "failed";
    let terminalError: string | undefined;
    try {
      if (!this.handler) throw new Error("No job handler registered");
      log("info", `Starting ${job.type}`);
      if (job.validationError)
        throw new Error(
          `Invalid persisted job command: ${job.validationError}`
        );
      parseJobCommand(job.type, job.payload);
      const result = await this.handler(job, log, controller.signal);
      db.update(schema.jobs)
        .set({
          status: "completed",
          resultJson: result === undefined ? null : JSON.stringify(result),
          finishedAt: new Date().toISOString(),
        })
        .where(eq(schema.jobs.id, job.id))
        .run();
      terminalStatus = "completed";
      this.log(job.id, "success", `Completed ${job.type}`);
    } catch (e) {
      if (e instanceof JobCancelled) {
        db.update(schema.jobs)
          .set({ status: "cancelled", finishedAt: new Date().toISOString() })
          .where(eq(schema.jobs.id, job.id))
          .run();
        terminalStatus = "cancelled";
        this.log(job.id, "info", `Cancelled ${job.type}`);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        db.update(schema.jobs)
          .set({
            status: "failed",
            errorMessage: message,
            errorCode: classifyJobError(message),
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.jobs.id, job.id))
          .run();
        terminalStatus = "failed";
        terminalError = message;
        this.log(job.id, "error", message);
      }
    } finally {
      const hook = getJobLifecycleHook(job.type);
      hook?.onSettled?.(job.id, terminalStatus, terminalError);
      if (terminalStatus === "failed" || terminalStatus === "cancelled") {
        hook?.onStopped?.(job.id, terminalStatus);
      }
      this.cancelRequested.delete(job.id);
      this.controllers.delete(job.id);
      this.running--;
      this.emitSettled({ id: job.id, type: job.type, status: terminalStatus });
      void this.pump();
    }
  }
}

export const jobQueue = new JobQueue();
onSettingChange("kavita-connection", () => jobQueue.clearContextCache());
