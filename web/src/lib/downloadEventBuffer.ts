import type { DownloadTask } from './api';
import { mergeDownloadPoll, newerDownload } from './downloadPoll';

/** Fields that move on every byte-level SSE tick; nothing else depends on them. */
const PROGRESS_FIELDS: ReadonlySet<string> = new Set(['progressCurrent', 'progressTotal', 'speed', 'currentFile', 'bytesCurrent', 'bytesTotal', 'revision']);

function sameState(a: DownloadTask['state'] | undefined, b: DownloadTask['state'] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'retry-wait' && b.type === 'retry-wait') return a.retryAt === b.retryAt && a.retryCount === b.retryCount;
  return true;
}

/**
 * True when `next` differs from `previous` only in progress counters, so the
 * update can be coalesced. Anything else (status, phase, state, errors, new
 * tasks) is a state change that must reach the UI immediately.
 */
export function isProgressOnlyUpdate(previous: DownloadTask | undefined, next: DownloadTask): boolean {
  if (!previous) return false;
  for (const key of Object.keys(next) as (keyof DownloadTask)[]) {
    if (PROGRESS_FIELDS.has(key) || previous[key] === next[key]) continue;
    if (key === 'state' && sameState(previous.state, next.state)) continue;
    return false;
  }
  return true;
}

/**
 * Fold task updates into the cached list, copy-on-write. Returns `undefined`
 * when no task actually changed (stale revisions only), so callers can skip
 * the cache write and every observer notification.
 */
export function applyTaskUpdates(list: readonly DownloadTask[] | undefined, updates: Iterable<DownloadTask>): DownloadTask[] | undefined {
  let current: DownloadTask[] = Array.isArray(list) ? (list as DownloadTask[]) : [];
  let changed = false;
  for (const task of updates) {
    const idx = current.findIndex((t) => t.id === task.id);
    if (idx === -1) {
      current = [task, ...current];
      changed = true;
      continue;
    }
    const merged = newerDownload(current[idx], task);
    if (merged === current[idx]) continue;
    if (!changed) current = [...current];
    current[idx] = merged;
    changed = true;
  }
  return changed ? current : undefined;
}

function sameList(a: readonly DownloadTask[], b: readonly DownloadTask[]): boolean {
  return a.length === b.length && a.every((task, index) => task === b[index]);
}

/** Merge a full snapshot (SSE or poll) into the cache; returns `previous` itself when nothing changed. */
export function mergeDownloadSnapshot(previous: readonly DownloadTask[] | undefined, fresh: readonly DownloadTask[]): DownloadTask[] {
  if (!previous) return [...fresh];
  const merged = mergeDownloadPoll(previous, fresh);
  return sameList(previous, merged) ? (previous as DownloadTask[]) : merged;
}
