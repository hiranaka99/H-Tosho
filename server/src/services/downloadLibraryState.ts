import path from 'node:path';
import { desc, inArray } from 'drizzle-orm';
import type { DownloadLibraryState } from '../contracts/downloads.js';
import { getDb, schema } from '../db/index.js';
import { jobQueue } from '../jobs/queue.js';
import { readJobPayload } from '../jobs/storage.js';
import { listMatchSuggestions } from './matchSuggestions.js';

/** Recent import jobs are enough: older downloads settled long ago and keep their newest job. */
const JOB_SCAN_LIMIT = 2000;

/** Discovery paths compare case-insensitively on Windows, exactly elsewhere. */
function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Where each completed download stands in Kavita, read from the import task
 * that the download queued (`scan-downloaded`, or the `merge-series` task that
 * owns a merged batch). A download with no import task (Kavita not connected,
 * or history older than the task log) is simply absent from the result.
 */
export function downloadLibraryStates(taskIds: number[]): Record<number, DownloadLibraryState> {
  const ids = [...new Set(taskIds.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 200);
  if (!ids.length) return {};
  const db = getDb();
  const tasks = db.select({
    id: schema.downloadQueue.id,
    status: schema.downloadQueue.status,
    outputPath: schema.downloadQueue.outputPath,
    mergeFolder: schema.downloadQueue.mergeFolder,
    mergeJobId: schema.downloadQueue.mergeJobId,
  }).from(schema.downloadQueue).where(inArray(schema.downloadQueue.id, ids)).all()
    .filter((task) => task.status === 'completed' && task.outputPath);
  if (!tasks.length) return {};

  // Newest import job per discovery path: a retry supersedes the older attempt.
  // Indexed once, and only when some task is not owned by a merge job.
  let byPath: Map<string, number> | null = null;
  const jobFor = (target: string): number | undefined => {
    if (!byPath) {
      byPath = new Map();
      const jobRows = db.select({ id: schema.jobs.id, payloadJson: schema.jobs.payloadJson }).from(schema.jobs)
        .where(inArray(schema.jobs.type, ['scan-downloaded'])).orderBy(desc(schema.jobs.id)).limit(JOB_SCAN_LIMIT).all();
      for (const row of jobRows) {
        try {
          const payload = JSON.parse(row.payloadJson) as { path?: unknown };
          // Rows arrive newest first; the first job seen for a path wins.
          if (typeof payload.path === 'string' && !byPath.has(pathKey(payload.path))) byPath.set(pathKey(payload.path), row.id);
        } catch { /* a malformed payload has no path to match */ }
      }
    }
    return byPath.get(pathKey(path.resolve(target)));
  };

  const jobIdByTask = new Map<number, number>();
  for (const task of tasks) {
    const jobId = task.mergeJobId ?? jobFor(task.mergeFolder ? path.dirname(task.outputPath!) : task.outputPath!);
    if (jobId !== undefined) jobIdByTask.set(task.id, jobId);
  }
  if (!jobIdByTask.size) return {};
  // One query for every referenced job, projecting only what the states need.
  const jobs = new Map(db.select({
    id: schema.jobs.id,
    type: schema.jobs.type,
    status: schema.jobs.status,
    errorMessage: schema.jobs.errorMessage,
    payloadJson: schema.jobs.payloadJson,
    stateJson: schema.jobs.stateJson,
  }).from(schema.jobs).where(inArray(schema.jobs.id, [...new Set(jobIdByTask.values())])).all().map((row) => [row.id, row]));

  let reviewIds: Set<number> | null = null;
  const pendingReview = (seriesIds: number[]): boolean => {
    if (!seriesIds.length) return false;
    try { reviewIds ??= new Set(listMatchSuggestions().map((item) => item.seriesId)); }
    catch { reviewIds = new Set(); }
    return seriesIds.some((id) => reviewIds!.has(id));
  };

  const result: Record<number, DownloadLibraryState> = {};
  for (const task of tasks) {
    const jobId = jobIdByTask.get(task.id);
    if (jobId === undefined) continue;
    const job = jobs.get(jobId);
    if (!job) continue;
    if (job.status === 'queued' || job.status === 'running') {
      result[task.id] = { state: 'importing', jobId };
    } else if (job.status === 'completed') {
      // The same context projection jobQueue.get() exposes as `job.context`.
      const payload = readJobPayload(job.type, job.payloadJson, job.stateJson).payload;
      const series = jobQueue.contextForPayload(payload)?.series ?? [];
      result[task.id] = { state: 'imported', jobId, series, review: pendingReview(series.map((item) => item.id)) };
    } else {
      result[task.id] = { state: 'failed', jobId, message: job.status === 'cancelled' ? 'The import task was cancelled.' : job.errorMessage };
    }
  }
  return result;
}
