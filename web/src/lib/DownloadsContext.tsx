import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type DownloadTask, type DoujinSource } from './api';
import { useDownloadEvents } from './useDownloadEvents';
import { toast } from './toast';

export interface StartDownloadInput {
  source: DoujinSource;
  galleryId: string;
  title?: string;
  format?: 'cbz' | 'folder';
  /** Merged download: shared folder name so all chapters land in one Kavita series. */
  mergeFolder?: string;
  /** Merged download: manual chapter number written to ComicInfo.Number. */
  chapter?: number;
}

type StartResult = { id: number; status: string };

export interface DownloadsApi {
  tasks: DownloadTask[];
  active: DownloadTask[];
  liveConnected: boolean;
  startDownload: (input: StartDownloadInput) => Promise<StartResult>;
  pause: (id: number) => void;
  resume: (id: number) => void;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  removeTask: (id: number) => void;
  clearCompleted: () => void;
}

const Ctx = React.createContext<DownloadsApi | null>(null);

/**
 * App-wide download state. Lifts the downloads query + SSE subscription out of
 * the Downloader page so progress is live on every screen, and surfaces
 * completion/failure toasts as tasks change status.
 */
export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const liveConnected = useDownloadEvents();

  // Polling is a lightweight fallback; the SSE stream above drives live updates.
  const { data } = useQuery({ queryKey: ['downloads'], queryFn: api.downloads, refetchInterval: 5000 });
  const tasks = React.useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const invalidate = React.useCallback(() => qc.invalidateQueries({ queryKey: ['downloads'] }), [qc]);

  const start = useMutation({ mutationFn: (input: StartDownloadInput) => api.startDownload(input), onSuccess: invalidate });
  const action = useMutation({
    mutationFn: ({ id, op }: { id: number; op: 'pause' | 'resume' | 'cancel' | 'retry' }) => api.downloadAction(id, op),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteDownload(id), onSuccess: invalidate });
  const clear = useMutation({ mutationFn: api.clearCompletedDownloads, onSuccess: invalidate });

  // Toast on status transitions to completed/failed.
  const prevStatuses = React.useRef<Map<number, string>>(new Map());
  const hasPrev = React.useRef(false);
  React.useEffect(() => {
    if (!hasPrev.current) {
      tasks.forEach((t) => prevStatuses.current.set(t.id, t.status));
      hasPrev.current = true;
      return;
    }
    for (const t of tasks) {
      const prev = prevStatuses.current.get(t.id);
      if (prev === undefined || prev === t.status) continue;
      prevStatuses.current.set(t.id, t.status);
      const title = t.title ?? `Gallery ${t.galleryId}`;
      if (t.status === 'completed') {
        toast({ tone: 'success', title: 'Download complete', description: title });
      } else if (t.status === 'failed' && prev !== 'downloading' && prev !== 'queued') {
        // Only surface genuine failures (not an in-flight cancel that lands as failed).
        toast({ tone: 'danger', title: 'Download failed', description: t.errorMessage ?? title });
      }
    }
  }, [tasks]);

  const value = React.useMemo<DownloadsApi>(
    () => ({
      tasks,
      active: tasks.filter((t) => t.status === 'downloading' || t.status === 'queued'),
      liveConnected,
      startDownload: (input) => start.mutateAsync(input),
      pause: (id) => action.mutate({ id, op: 'pause' }),
      resume: (id) => action.mutate({ id, op: 'resume' }),
      cancel: (id) => action.mutate({ id, op: 'cancel' }),
      retry: (id) => action.mutate({ id, op: 'retry' }),
      removeTask: (id) => remove.mutate(id),
      clearCompleted: () => clear.mutate(),
    }),
    [tasks, liveConnected, start, action, remove, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadsApi {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useDownloads must be used within a DownloadsProvider');
  return ctx;
}