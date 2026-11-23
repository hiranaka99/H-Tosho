import path from 'node:path';
import { desc, inArray } from 'drizzle-orm';
import type { DownloadLibraryState } from '../contracts/downloads.js';
import { getDb, schema } from '../db/index.js';
import { jobQueue } from '../jobs/queue.js';
import { listMatchSuggestions } from './matchSuggestions.js';

/** Recent import jobs are enough: older downloads settled long ago and keep their newest job. */
const JOB_SCAN_LIMIT = 2000;

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  const byPath = new Map<string, number>();
  const jobRows = db.select({ id: schema.jobs.id, payloadJson: schema.jobs.payloadJson }).from(schema.jobs)
    .where(inArray(schema.jobs.type, ['scan-downloaded'])).orderBy(desc(schema.jobs.id)).limit(JOB_SCAN_LIMIT).all();
  const paths: { path: string; id: number }[] = [];
  for (const row of jobRows) {
    try {
      const payload = JSON.parse(row.payloadJson) as { path?: unknown };
      if (typeof payload.path === 'string') paths.push({ path: payload.path, id: row.id });
    } catch { /* a malformed payload has no path to match */ }
  }
  const jobFor = (target: string): number | undefined => {
    const key = path.resolve(target);
    const cached = byPath.get(key);
    if (cached !== undefined) return cached;
    const hit = paths.find((entry) => samePath(entry.path, key))?.id;
    if (hit !== undefined) byPath.set(key, hit);
    return hit;
  };

  let reviewIds: Set<number> | null = null;
  const pendingReview = (seriesIds: number[]): boolean => {
    if (!seriesIds.length) return false;
    try { reviewIds ??= new Set(listMatchSuggestions().map((item) => item.seriesId)); }
    catch { reviewIds = new Set(); }
    return seriesIds.some((id) => reviewIds!.has(id));
  };

  const result: Record<number, DownloadLibraryState> = {};
  for (const task of tasks) {
    const jobId = task.mergeJobId ?? jobFor(task.mergeFolder ? path.dirname(task.outputPath!) : task.outputPath!);
    if (jobId === undefined) continue;
    const job = jobQueue.get(jobId);
    if (!job) continue;
    if (job.status === 'queued' || job.status === 'running') {
      result[task.id] = { state: 'importing', jobId };
    } else if (job.status === 'completed') {
      const series = job.context?.series ?? [];
      result[task.id] = { state: 'imported', jobId, series, review: pendingReview(series.map((item) => item.id)) };
    } else {
      result[task.id] = { state: 'failed', jobId, message: job.status === 'cancelled' ? 'The import task was cancelled.' : job.errorMessage };
    }
  }
  return result;
}
