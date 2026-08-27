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
  error: Error | null;
  refetch: () => Promise<unknown>;
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

const PAGE_LABEL = /^Page (\d+)\/(\d+)$/;

/** Rank of a "Page X/Y" label for monotonic comparison (0 for phase markers). */
function pageRank(label: string | null | undefined): number {
  const m = PAGE_LABEL.exec(label ?? '');
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * A poll reads the DB, which lags the live SSE snapshot by up to ~250ms. While
 * both sides show a task as downloading, progress fields only ever move forward —
 * keep the higher value so a stale poll can't make the UI jump backwards.
 */
function mergePolledTask(prevList: DownloadTask[], fresh: DownloadTask): DownloadTask {
  const p = prevList.find((t) => t.id === fresh.id);
  if (!p || p.status !== 'downloading' || fresh.status !== 'downloading') return fresh;
  return {
    ...fresh,
    progressCurrent: Math.max(p.progressCurrent, fresh.progressCurrent),
    bytesCurrent: Math.max(p.bytesCurrent ?? 0, fresh.bytesCurrent ?? 0),
    currentFile: pageRank(p.currentFile) > 0 && pageRank(p.currentFile) >= pageRank(fresh.currentFile) ? p.currentFile : fresh.currentFile,
  };
}

/**
 * App-wide download state. Lifts the downloads query + SSE subscription out of
 * the Downloader page so progress is live on every screen, and surfaces
 * completion/failure toasts as tasks change status.
 */
export function DownloadsProvider({ children }: { children: React.ReactNode }) {

  const qc = useQueryClient();
  const liveConnected = useDownloadEvents();

  // Polling is a lightweight fallback; the SSE stream above drives live updates.
  const downloadsQuery = useQuery({
    queryKey: ['downloads'],
    queryFn: async () => {
      const fresh = await api.downloads();
      const prev = qc.getQueryData<DownloadTask[]>(['downloads']);
      if (!prev) return fresh;
      return fresh.map((f) => mergePolledTask(prev, f));
    },
    refetchInterval: 5000,
  });
  const data = downloadsQuery.data;
  const tasks = React.useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const invalidate = React.useCallback(() => qc.invalidateQueries({ queryKey: ['downloads'] }), [qc]);

  const mutationError = (title: string) => (error: unknown) => toast({ tone: 'danger', title, description: error instanceof Error ? error.message : String(error) });
  const start = useMutation({ mutationFn: (input: StartDownloadInput) => api.startDownload(input), onSuccess: invalidate, onError: (error) => { const msg = error instanceof Error ? error.message : String(error); if (msg !== 'already-downloaded') toast({ tone: 'danger', title: 'Could not start download', description: msg }); } });
  const action = useMutation({
    mutationFn: ({ id, op }: { id: number; op: 'pause' | 'resume' | 'cancel' | 'retry' }) => api.downloadAction(id, op),
    onSuccess: invalidate,
    onError: mutationError('Download action failed'),
  });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteDownload(id), onSuccess: () => { invalidate(); toast({ tone: 'info', title: 'Removed from download history' }); }, onError: mutationError('Could not remove download') });
  const clear = useMutation({ mutationFn: api.clearCompletedDownloads, onSuccess: invalidate, onError: mutationError('Could not clear completed downloads') });

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
      error: downloadsQuery.error instanceof Error ? downloadsQuery.error : null,
      refetch: downloadsQuery.refetch,
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
    [tasks, liveConnected, downloadsQuery.error, downloadsQuery.refetch, start, action, remove, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadsApi {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useDownloads must be used within a DownloadsProvider');
  return ctx;
}