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
 *   any other change flushes the buffer immediately along with itself.
 * - `removed`: drops tasks by id.
 *
 * EventSource reconnects automatically on transient errors; while it is down
 * the state is `offline` so callers can fall back to polling.
 */
export function useDownloadEvents(): DownloadStreamState {
  const qc = useQueryClient();
  const [state, setState] = React.useState<DownloadStreamState>('connecting');

  React.useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/downloads/events');
    } catch {
      setState('offline'); // EventSource unsupported — rely on polling fallback.
      return;
    }

    const pending = new Map<number, DownloadTask>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (pending.size === 0) return;
      const updates = [...pending.values()];
      pending.clear();
      qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => applyTaskUpdates(prev, updates));
    };
    const scheduleFlush = () => {
      if (timer !== null || document.hidden) return; // Hidden tabs hold progress until visible.
      timer = setTimeout(flush, PROGRESS_FLUSH_MS);
    };
    const onVisibility = () => { if (!document.hidden) flush(); };
    document.addEventListener('visibilitychange', onVisibility);

    const connectTimeout = setTimeout(() => setState((current) => current === 'connecting' ? 'offline' : current), CONNECT_TIMEOUT_MS);

    es.onerror = () => setState('offline'); // EventSource auto-reconnects.

    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DownloadEvent;
        if (msg.type === 'snapshot') {
          flush();
          qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => mergeDownloadSnapshot(prev, msg.tasks));
          setState('live');
        } else if (msg.type === 'task') {
          const known = pending.get(msg.task.id) ?? qc.getQueryData<DownloadTask[]>(['downloads'])?.find((task) => task.id === msg.task.id);
          const buffered = pending.get(msg.task.id);
          pending.set(msg.task.id, buffered ? newerDownload(buffered, msg.task) : msg.task);
          if (isProgressOnlyUpdate(known, msg.task)) scheduleFlush();
          else flush();
        } else if (msg.type === 'removed') {
          const removed = new Set(msg.ids);
          for (const id of removed) pending.delete(id);
          flush();
          qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => {
            if (!prev?.some((task) => removed.has(task.id))) return undefined;
            return prev.filter((task) => !removed.has(task.id));
          });
          void qc.invalidateQueries({ queryKey: ['downloads-completed'] });
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    return () => {
      flush();
      clearTimeout(connectTimeout);
      document.removeEventListener('visibilitychange', onVisibility);
      es?.close();
    };
  }, [qc]);

  return state;
}
