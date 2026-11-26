import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type DownloadEvent, type DownloadTask } from './api';
import { applyTaskUpdates, isProgressOnlyUpdate, mergeDownloadSnapshot } from './downloadEventBuffer';
import { newerDownload } from './downloadPoll';

/** Progress-only ticks (the server sends one per task every ~80ms) are folded
 * into the cache at most this often. */
const PROGRESS_FLUSH_MS = 200;
/** Give the stream this long to deliver its snapshot before polling instead. */
const CONNECT_TIMEOUT_MS = 4000;

/**
 * `connecting`: waiting for the stream's first snapshot (no REST fetch yet).
 * `live`: the stream delivered a snapshot and is folding updates into the cache.
 * `offline`: the stream is down or unsupported — callers poll instead.
 */
export type DownloadStreamState = 'connecting' | 'live' | 'offline';

/**
 * Subscribe to the download Server-Sent Events stream and fold updates straight
 * into the react-query `['downloads']` cache so the UI is live without polling.
 *
 * - `snapshot`: replaces the whole list (sent first on every connect).
 * - `task`: upserts a single task by id. Progress-only ticks are buffered and
 *   flushed every PROGRESS_FLUSH_MS (held entirely while the tab is hidden);
 *   any other change flushes the buffer immediately along with itself and
 *   triggers `onStateChange`.
 * - `removed`: drops tasks by id and triggers `onStateChange`.
 *
 * EventSource reconnects automatically on transient errors; while it is down
 * the state is `offline` so callers can fall back to polling.
 */
export function useDownloadEvents(onStateChange?: (tasks: DownloadTask[]) => void): DownloadStreamState {
  const qc = useQueryClient();
  const [state, setState] = React.useState<DownloadStreamState>('connecting');
  const onStateChangeRef = React.useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  React.useEffect(() => {
    let active = true;
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/downloads/events');
    } catch {
      setState('offline'); // EventSource unsupported — rely on polling fallback.
      return;
    }

    const pending = new Map<number, DownloadTask>();
    const knownById = new Map<number, DownloadTask>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const syncKnown = (tasks: readonly DownloadTask[]) => {
      knownById.clear();
      for (const task of tasks) knownById.set(task.id, task);
    };

    const flush = (notify = false) => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (pending.size === 0) return;
      const updates = [...pending.values()];
      pending.clear();
      let nextTasks: DownloadTask[] | undefined;
      qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => {
        const next = applyTaskUpdates(prev, updates);
        nextTasks = next;
        return next;
      });
      if (nextTasks) {
        syncKnown(nextTasks);
        if (notify && active) onStateChangeRef.current?.(nextTasks);
      }
    };
    const scheduleFlush = () => {
      if (timer !== null || document.hidden) return; // Hidden tabs hold progress until visible.
      timer = setTimeout(() => flush(false), PROGRESS_FLUSH_MS);
    };
    const onVisibility = () => { if (!document.hidden) flush(false); };
    document.addEventListener('visibilitychange', onVisibility);

    const connectTimeout = setTimeout(() => setState((current) => current === 'connecting' ? 'offline' : current), CONNECT_TIMEOUT_MS);

    es.onerror = () => setState('offline'); // EventSource auto-reconnects.

    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DownloadEvent;
        if (msg.type === 'snapshot') {
          flush(false);
          let nextTasks: DownloadTask[] | undefined;
          qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => {
            const next = mergeDownloadSnapshot(prev, msg.tasks);
            nextTasks = next;
            return next;
          });
          if (nextTasks) {
            syncKnown(nextTasks);
            if (active) onStateChangeRef.current?.(nextTasks);
          }
          setState('live');
        } else if (msg.type === 'task') {
          if (knownById.size === 0) {
            const cached = qc.getQueryData<DownloadTask[]>(['downloads']);
            if (cached) syncKnown(cached);
          }
          const buffered = pending.get(msg.task.id);
          const known = buffered ?? knownById.get(msg.task.id);
          const merged = buffered ? newerDownload(buffered, msg.task) : msg.task;
          pending.set(msg.task.id, merged);
          knownById.set(msg.task.id, merged);
          if (isProgressOnlyUpdate(known, msg.task)) scheduleFlush();
          else flush(true);
        } else if (msg.type === 'removed') {
          const removed = new Set(msg.ids);
          for (const id of removed) {
            pending.delete(id);
            knownById.delete(id);
          }
          flush(false);
          let nextTasks: DownloadTask[] | undefined;
          qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => {
            if (!prev?.some((task) => removed.has(task.id))) return undefined;
            const next = prev.filter((task) => !removed.has(task.id));
            nextTasks = next;
            return next;
          });
          if (nextTasks) {
            syncKnown(nextTasks);
            if (active) onStateChangeRef.current?.(nextTasks);
          }
          void qc.invalidateQueries({ queryKey: ['downloads-completed'] });
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    return () => {
      active = false;
      flush(false);
      clearTimeout(connectTimeout);
      document.removeEventListener('visibilitychange', onVisibility);
      es?.close();
    };
  }, [qc]);

  return state;
}
