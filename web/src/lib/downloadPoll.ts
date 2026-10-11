import type { DownloadTask } from './api';

const PAGE_LABEL = /^Page (\d+)\/(\d+)$/;

function pageRank(label: string | null | undefined): number {
  if (!label) return 0;
  const match = PAGE_LABEL.exec(label);
  return match ? Number(match[1]) : 0;
}

/** Polls can lag SSE; retain newer live progress while accepting status changes. */
export function mergeDownloadPoll(previous: readonly DownloadTask[], fresh: readonly DownloadTask[]): DownloadTask[] {
  const byId = new Map<number, DownloadTask>();
  for (const task of previous) if (!byId.has(task.id)) byId.set(task.id, task);
  return fresh.map(task => {
    const prev = byId.get(task.id);
    if (!prev || prev.status !== 'downloading' || task.status !== 'downloading') return task;
    const better = task.progressCurrent > prev.progressCurrent ||
      task.progressCurrent === prev.progressCurrent && pageRank(task.currentFile) >= pageRank(prev.currentFile) && (task.speed ?? 0) > 0;
    return better ? task : prev;
  });
}
