import type { DownloadTask } from './api';

/** Attempt + revision order every snapshot; display labels never control freshness. */
export function newerDownload(previous: DownloadTask, fresh: DownloadTask): DownloadTask {
  if (fresh.attempt !== undefined && previous.attempt !== undefined && fresh.attempt !== previous.attempt) return fresh.attempt > previous.attempt ? fresh : previous;
  if (fresh.revision !== undefined && previous.revision !== undefined) return fresh.revision > previous.revision ? fresh : previous;
  return fresh; // Legacy servers and browser fixtures have no version.
}

export function mergeDownloadPoll(previous: readonly DownloadTask[], fresh: readonly DownloadTask[]): DownloadTask[] {
  const byId = new Map(previous.map(task => [task.id, task]));
  return fresh.map(task => {
    const prior = byId.get(task.id);
    return prior ? newerDownload(prior, task) : task;
  });
}
