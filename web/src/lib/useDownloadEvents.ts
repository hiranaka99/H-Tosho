import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type DownloadEvent, type DownloadTask } from './api';

/**
 * Subscribe to the download Server-Sent Events stream and fold updates straight
 * into the react-query `['downloads']` cache so the UI is live without polling.
 *
 * - `snapshot`: replaces the whole list (sent once on connect).
 * - `task`: upserts a single task by id.
 *
 * EventSource reconnects automatically on transient errors; when it drops we
 * report `connected=false` so callers can fall back to polling. Returns the
 * current connection state.
 */
export function useDownloadEvents(): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/downloads/events');
    } catch {
      return; // EventSource unsupported — rely on polling fallback.
    }

    const upsertTask = (task: DownloadTask) => {
      qc.setQueryData<DownloadTask[]>(['downloads'], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex((t) => t.id === task.id);
        if (idx === -1) return [task, ...list];
        const next = [...list];
        next[idx] = { ...next[idx], ...task };
        return next;
      });
    };

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource auto-reconnects.

    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DownloadEvent;
        if (msg.type === 'snapshot') {
          qc.setQueryData<DownloadTask[]>(['downloads'], msg.tasks);
        } else if (msg.type === 'task') {
          upsertTask(msg.task);
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    return () => {
      es?.close();
      setConnected(false);
    };
  }, [qc]);

  return connected;
}