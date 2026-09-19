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

/** Stable surface: mutations + connection state. Changes rarely, so components
 * that only *start* downloads don't re-render on every progress tick. */
export interface DownloadActionsApi {
  liveConnected: boolean;
  startDownload: (input: StartDownloadInput) => Promise<StartResult>;
  pause: (id: number) => void;
  resume: (id: number) => void;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  removeTask: (id: number) => void;
  clearCompleted: () => void;
}

/** Churny surface: the task list itself, replaced on every SSE tick / poll. */
export interface DownloadTasksApi {
  tasks: DownloadTask[];
  active: DownloadTask[];
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface DownloadsApi extends DownloadActionsApi, DownloadTasksApi {}

const ActionsCtx = React.createContext<DownloadActionsApi | null>(null);
const TasksCtx = React.createContext<DownloadTasksApi | null>(null);

const PAGE_LABEL = /^Page (\d+)\/(\d+)$/;

/** Rank of a "Page X/Y" label for monotonic comparison (0 for phase markers). */
function pageRank(label: string | null | undefined): number {
  if (!label) return 0;
  const m = PAGE_LABEL.exec(label);
  return m ? Number(m[1]) : 0;
}

/**
 * A poll reads the DB, which lags the live SSE snapshot by up to ~250ms. While
 * both sides show a task as downloading, progress fields only ever move forward —
 * keep the higher value so a stale poll can't make the UI jump backwards.
 */
function mergePolledTask(prevList: DownloadTask[], fresh: DownloadTask): DownloadTask {
  const prev = prevList.find((t) => t.id === fresh.id);
  if (!prev) return fresh;
  if (prev.status !== 'downloading' || fresh.status !== 'downloading') return fresh;
  const better =
    fresh.progressCurrent > prev.progressCurrent ||
    fresh.progressCurrent === prev.progressCurrent && pageRank(fresh.currentFile) >= pageRank(prev.currentFile) && (fresh.speed ?? 0) > 0;
  return better ? fresh : prev;
}

/**
 * App-wide download state. Lifts the downloads query + SSE subscription out of
 * the Downloader page so progress is live on every screen, and surfaces
 * completion/failure toasts as tasks change status.
 *
 * The two context surfaces are split on update frequency: actions only change
 * when the connection flips, tasks change on every SSE tick — so a component
 * that merely starts downloads (Search tab) subscribes to actions and never
 * re-renders during progress streaming.
 */
export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const liveConnected = useDownloadEvents();

  // Polling is a lightweight fallback for when the SSE stream is down; while
  // the stream is connected it already folds every snapshot/task event into
  // this same cache, so a concurrent poll would only double the traffic.
  const downloadsQuery = useQuery({
    queryKey: ['downloads'],
    queryFn: async () => {
      const fresh = await api.downloads();
      const prev = qc.getQueryData<DownloadTask[]>(['downloads']);
      if (!prev) return fresh;
      return fresh.map((f) => mergePolledTask(prev, f));
    },
    refetchInterval: liveConnected ? false : 5000,
  });
  const data = downloadsQuery.data;
  const tasks = React.useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const active = React.useMemo(
    () => tasks.filter((t) => t.status === 'downloading' || t.status === 'queued'),
    [tasks],
  );

  const invalidate = React.useCallback(() => qc.invalidateQueries({ queryKey: ['downloads'] }), [qc]);
  const invalidateCompleted = React.useCallback(() => qc.invalidateQueries({ queryKey: ['downloads-completed'] }), [qc]);

  const mutationError = (title: string) => (error: unknown) => toast({ tone: 'danger', title, description: error instanceof Error ? error.message : String(error) });
  const start = useMutation({ mutationFn: (input: StartDownloadInput) => api.startDownload(input), onSuccess: invalidate });
  const action = useMutation({
    mutationFn: ({ id, op }: { id: number; op: 'pause' | 'resume' | 'cancel' | 'retry' }) => api.downloadAction(id, op),
    onSuccess: (_result, { op }) => {
      void invalidate();
      if (op === 'retry') void invalidateCompleted();
    },
    onError: mutationError('Download action failed'),
  });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteDownload(id), onSuccess: () => { void invalidate(); void invalidateCompleted(); toast({ tone: 'info', title: 'Removed from download history' }); }, onError: mutationError('Could not remove download') });
  const clear = useMutation({ mutationFn: api.clearCompletedDownloads, onSuccess: () => { void invalidate(); void invalidateCompleted(); }, onError: mutationError('Could not clear completed downloads') });

  // Toast on status transitions to completed/failed. A completion also makes
  // the Downloaded badges stale, so refresh that query directly instead of
  // polling it on a timer.
  const prevStatuses = React.useRef<Map<number, string>>(new Map());
  const hasPrev = React.useRef(false);
  React.useEffect(() => {
    if (!hasPrev.current) {
      tasks.forEach((t) => prevStatuses.current.set(t.id, t.status));
      hasPrev.current = true;
      return;
    }
    let completed = false;
    for (const t of tasks) {
      const prev = prevStatuses.current.get(t.id);
      prevStatuses.current.set(t.id, t.status);
      if (prev === undefined || prev === t.status) continue;
      if (t.status === 'completed') completed = true;
      const title = t.title ?? `Gallery ${t.galleryId}`;
      if (t.status === 'completed') {
        toast({ tone: 'success', title: 'Download complete', description: title });
      } else if (t.status === 'failed' && t.errorMessage !== 'Cancelled by user') {
        // Surface genuine failures; a user cancel also lands as "failed" but carries a distinct message.
        toast({ tone: 'danger', title: 'Download failed', description: t.errorMessage ?? title });
      }
    }
    if (completed) void qc.invalidateQueries({ queryKey: ['downloads-completed'] });
  }, [tasks, qc]);

  // mutate/mutateAsync are stable references, so this value only changes when
  // the SSE connection state flips.
  const { mutateAsync: startMutate } = start;
  const { mutate: actionMutate } = action;
  const { mutate: removeMutate } = remove;
  const { mutate: clearMutate } = clear;
  const actionsValue = React.useMemo<DownloadActionsApi>(
    () => ({
      liveConnected,
      startDownload: (input) => startMutate(input),
      pause: (id) => actionMutate({ id, op: 'pause' }),
      resume: (id) => actionMutate({ id, op: 'resume' }),
      cancel: (id) => actionMutate({ id, op: 'cancel' }),
      retry: (id) => actionMutate({ id, op: 'retry' }),
      removeTask: (id) => removeMutate(id),
      clearCompleted: () => clearMutate(),
    }),
    [liveConnected, startMutate, actionMutate, removeMutate, clearMutate],
  );

  const tasksValue = React.useMemo<DownloadTasksApi>(
    () => ({
      error: downloadsQuery.error instanceof Error ? downloadsQuery.error : null,
      refetch: downloadsQuery.refetch,
      tasks,
      active,
    }),
    [tasks, active, downloadsQuery.error, downloadsQuery.refetch],
  );

  return (
    <ActionsCtx.Provider value={actionsValue}>
      <TasksCtx.Provider value={tasksValue}>{children}</TasksCtx.Provider>
    </ActionsCtx.Provider>
  );
}

/** Stable actions + connection state — safe to use in components that must not
 * re-render on every download progress tick. */
export function useDownloadActions(): DownloadActionsApi {
  const ctx = React.useContext(ActionsCtx);
  if (!ctx) throw new Error('useDownloadActions must be used within a DownloadsProvider');
  return ctx;
}

/** Live task list — changes on every SSE tick / poll. Use where progress is
 * actually displayed. */
export function useDownloadTasks(): DownloadTasksApi {
  const ctx = React.useContext(TasksCtx);
  if (!ctx) throw new Error('useDownloadTasks must be used within a DownloadsProvider');
  return ctx;
}

/** Everything at once — for components that display task state (sidebar queue,
 * download manager). */
export function useDownloads(): DownloadsApi {
  return { ...useDownloadActions(), ...useDownloadTasks() };
}
