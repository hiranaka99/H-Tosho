import * as React from 'react';
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type DownloadTask, type DoujinSource } from './api';
import { useDownloadEvents, type DownloadStreamState } from './useDownloadEvents';
import { toast } from './toast';
import { downloadErrorHelp } from './downloadErrors';
import { mergeDownloadSnapshot } from './downloadEventBuffer';
import { SOURCE_LABELS } from '../pages/downloader/state';
import { DownloadActionsContext as ActionsCtx, DownloadTasksContext as TasksCtx, GalleryStatusContext as GalleryStatusCtx } from './appContexts';

export interface StartDownloadInput {
  source: DoujinSource;
  galleryId: string;
  /** Canonical gallery URL; frozen as the queued task's origin. */
  url?: string;
  title?: string;
  format?: 'cbz' | 'folder';
  /** Merged download: shared folder name so all chapters land in one Kavita series. */
  mergeFolder?: string;
  /** Merged download: manual chapter number written to ComicInfo.Number. */
  chapter?: number;
  allowDuplicate?: boolean;
}

type StartResult = { id: number; status: string };

/** Stable surface: mutations only. Never changes after mount, so components
 * that only *start* downloads (and memoized gallery cards) don't re-render on
 * progress ticks or SSE reconnects. */
export interface DownloadActionsApi {
  startDownload: (input: StartDownloadInput) => Promise<StartResult>;
  pause: (id: number) => void;
  resume: (id: number) => void;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  prioritize: (id: number) => void;
  pauseAll: () => void;
  resumeAll: () => void;
  retryFailed: () => void;
  removeTask: (id: number) => void;
  clearCompleted: () => void;
  clearCancelled: () => void;
}

/** Churny surface: the task list itself, replaced on every SSE tick / poll. */
export interface DownloadTasksApi {
  tasks: DownloadTask[];
  active: DownloadTask[];
  error: Error | null;
  /** True until the first task list arrives, so views can tell loading from empty. */
  loading: boolean;
  refetch: () => Promise<unknown>;
}

export interface DownloadsApi extends DownloadActionsApi, DownloadTasksApi {}

/** Shared by every observer of ['downloads']: a refetch runs the most recently
 * attached observer's queryFn, so per-card observers must carry one too. */
function downloadsQueryFn(qc: QueryClient) {
  return async () => {
    const fresh = await api.downloads();
    return mergeDownloadSnapshot(qc.getQueryData<DownloadTask[]>(['downloads']), fresh);
  };
}

export type GalleryDownloadStatus = 'queued' | 'downloading' | 'paused' | 'retry-wait';

export interface GalleryStatusStore {
  subscribe: (key: string, listener: () => void) => () => void;
  get: (key: string) => GalleryDownloadStatus | undefined;
  sync: (tasks: DownloadTask[]) => void;
}


function createGalleryStatusStore(): GalleryStatusStore {
  let statuses = new Map<string, GalleryDownloadStatus>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    subscribe: (key, listener) => {
      let set = listeners.get(key);
      if (!set) { set = new Set(); listeners.set(key, set); }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(key);
      };
    },
    get: (key) => statuses.get(key),
    sync: (tasks) => {
      const next = new Map<string, GalleryDownloadStatus>();
      for (const task of tasks) {
        const key = `${task.source}:${task.galleryId}`;
        if (next.has(key)) continue;
        if (task.state?.type === 'retry-wait') next.set(key, 'retry-wait');
        else if (task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') next.set(key, task.status);
      }
      const changed = new Set<string>();
      for (const [key, val] of next) if (statuses.get(key) !== val) changed.add(key);
      for (const key of statuses.keys()) if (!next.has(key)) changed.add(key);
      statuses = next;
      for (const key of changed) listeners.get(key)?.forEach((listener) => listener());
    },
  };
}

function DownloadTasksProvider({
  stream,
  onPollSync,
  children,
}: {
  stream: DownloadStreamState;
  onPollSync: (tasks: DownloadTask[]) => void;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const liveConnected = stream === 'live';
  const queryFn = React.useMemo(() => downloadsQueryFn(qc), [qc]);

  // The SSE stream opens with a full snapshot and then folds every task change
  // into this cache, so REST is only the fallback: no initial GET while the
  // stream is connecting, and polling only while it is down.
  const downloadsQuery = useQuery({
    queryKey: ['downloads'],
    queryFn,
    enabled: stream !== 'connecting',
    refetchInterval: liveConnected ? false : 5000,
  });
  const data = downloadsQuery.data;
  const tasks = React.useMemo(() => (Array.isArray(data) ? data : []), [data]);
  React.useEffect(() => {
    if (!liveConnected && Array.isArray(data)) onPollSync(tasks);
  }, [liveConnected, data, tasks, onPollSync]);
  const active = React.useMemo(
    () => tasks.filter((t) => t.status === 'downloading' || t.status === 'queued'),
    [tasks],
  );
  const tasksValue = React.useMemo<DownloadTasksApi>(
    () => ({
      error: downloadsQuery.error instanceof Error ? downloadsQuery.error : null,
      loading: downloadsQuery.isPending,
      refetch: downloadsQuery.refetch,
      tasks,
      active,
    }),
    [tasks, active, downloadsQuery.error, downloadsQuery.isPending, downloadsQuery.refetch],
  );
  return <TasksCtx.Provider value={tasksValue}>{children}</TasksCtx.Provider>;
}

/**
 * App-wide download state. Lifts the downloads query + SSE subscription out of
 * the Downloader page so progress is live on every screen, and surfaces
 * completion/failure toasts as tasks change status.
 *
 * The context surfaces are split on update frequency: actions and coarse
 * per-gallery status only update on state changes, while live tasks live in
 * `DownloadTasksProvider` so progress ticks never re-render `DownloadsProvider`
 * or unrelated gallery grids.
 */
export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [statusStore] = React.useState(createGalleryStatusStore);

  // Toast on status transitions to completed/failed and keep coarse gallery status synced.
  // A completion also makes Downloaded badges stale, so refresh directly without polling.
  const prevStatuses = React.useRef<Map<number, string>>(new Map());
  const hasPrev = React.useRef(false);
  const handleStateChange = React.useCallback((tasks: DownloadTask[]) => {
    statusStore.sync(tasks);
    if (!hasPrev.current) {
      tasks.forEach((t) => prevStatuses.current.set(t.id, t.status));
      hasPrev.current = true;
      return;
    }
    let completed = false;
    const currentIds = new Set<number>();
    for (const t of tasks) {
      currentIds.add(t.id);
      const prev = prevStatuses.current.get(t.id);
      prevStatuses.current.set(t.id, t.status);
      if (prev === undefined || prev === t.status) continue;
      if (t.status === 'completed') completed = true;
      const title = t.title ?? `Gallery ${t.galleryId}`;
      if (t.status === 'completed') {
        toast({ tone: 'success', title: 'Download complete', description: title });
      } else if (t.status === 'failed' && t.state?.type !== 'cancelled') {
        // Surface genuine failures; a user cancel also lands as "failed" but carries a distinct message.
        // A scheduled automatic retry is H-Tosho's job, not the user's: no failure toast.
        if (t.state?.type !== 'retry-wait') toast({ tone: 'danger', title: 'Download failed', description: t.errorMessage ? `${title}: ${downloadErrorHelp(t.errorMessage, t.errorCode, SOURCE_LABELS[t.source]).message}` : title });
      }
    }
    for (const id of prevStatuses.current.keys()) {
      if (!currentIds.has(id)) prevStatuses.current.delete(id);
    }
    if (completed) {
      void qc.invalidateQueries({ queryKey: ['downloads-completed'] });
      void qc.invalidateQueries({ queryKey: ['home-activity'] });
      void qc.invalidateQueries({ queryKey: ['home-matches'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['downloads-library'] });
      void qc.invalidateQueries({ queryKey: ['downloads-history'] });
    }
  }, [statusStore, qc]);

  const stream = useDownloadEvents(handleStateChange);
  const liveConnected = stream === 'live';
  // Mutation callbacks read this ref so they stay stable across reconnects.
  const liveRef = React.useRef(liveConnected);
  liveRef.current = liveConnected;

  // Every queue mutation is broadcast on the stream, so refetching the list
  // after one is only needed while the stream is down.
  const invalidate = React.useCallback(() => liveRef.current ? Promise.resolve() : qc.invalidateQueries({ queryKey: ['downloads'] }), [qc]);
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
  const prioritize = useMutation({
    mutationFn: (id: number) => api.prioritizeDownload(id),
    onSuccess: invalidate,
    onError: mutationError('Could not prioritize download'),
  });
  const pauseAll = useMutation({
    mutationFn: api.pauseAllDownloads,
    onSuccess: invalidate,
    onError: mutationError('Could not pause downloads'),
  });
  const resumeAll = useMutation({
    mutationFn: api.resumeAllDownloads,
    onSuccess: invalidate,
    onError: mutationError('Could not resume downloads'),
  });
  const retryFailed = useMutation({
    mutationFn: api.retryFailedDownloads,
    onSuccess: () => {
      void invalidate();
      void invalidateCompleted();
    },
    onError: mutationError('Could not retry failed downloads'),
  });
  const invalidateHistory = React.useCallback(() => qc.invalidateQueries({ queryKey: ['downloads-history'] }), [qc]);
  const remove = useMutation({ mutationFn: (id: number) => api.deleteDownload(id), onSuccess: () => { void invalidate(); void invalidateCompleted(); void invalidateHistory(); toast({ tone: 'info', title: 'Removed from download history', description: 'The downloaded files were not touched.' }); }, onError: mutationError('Could not remove download') });
  const clear = useMutation({
    mutationFn: api.clearCompletedDownloads,
    onSuccess: ({ removed }) => {
      void invalidate(); void invalidateCompleted(); void invalidateHistory();
      toast({ tone: 'info', title: removed === 1 ? 'Cleared 1 completed download' : `Cleared ${removed} completed downloads`, description: 'The downloaded files were not touched.' });
    },
    onError: mutationError('Could not clear completed downloads'),
  });
  const clearCancelled = useMutation({
    mutationFn: api.clearCancelledDownloads,
    onSuccess: ({ removed }) => {
      void invalidate();
      toast({ tone: 'info', title: removed === 1 ? 'Cleared 1 cancelled download' : `Cleared ${removed} cancelled downloads`, description: 'Saved partial pages were removed.' });
    },
    onError: mutationError('Could not clear cancelled downloads'),
  });

  // mutate/mutateAsync are stable references, so this value never changes.
  const { mutateAsync: startMutate } = start;
  const { mutate: actionMutate } = action;
  const { mutate: prioritizeMutate } = prioritize;
  const { mutate: pauseAllMutate } = pauseAll;
  const { mutate: resumeAllMutate } = resumeAll;
  const { mutate: retryFailedMutate } = retryFailed;
  const { mutate: removeMutate } = remove;
  const { mutate: clearMutate } = clear;
  const { mutate: clearCancelledMutate } = clearCancelled;
  const actionsValue = React.useMemo<DownloadActionsApi>(
    () => ({
      startDownload: (input) => startMutate(input),
      pause: (id) => actionMutate({ id, op: 'pause' }),
      resume: (id) => actionMutate({ id, op: 'resume' }),
      cancel: (id) => actionMutate({ id, op: 'cancel' }),
      retry: (id) => actionMutate({ id, op: 'retry' }),
      prioritize: (id) => prioritizeMutate(id),
      pauseAll: () => pauseAllMutate(),
      resumeAll: () => resumeAllMutate(),
      retryFailed: () => retryFailedMutate(),
      removeTask: (id) => removeMutate(id),
      clearCompleted: () => clearMutate(),
      clearCancelled: () => clearCancelledMutate(),
    }),
    [startMutate, actionMutate, prioritizeMutate, pauseAllMutate, resumeAllMutate, retryFailedMutate, removeMutate, clearMutate, clearCancelledMutate],
  );

  return (
    <GalleryStatusCtx.Provider value={statusStore}>
      <ActionsCtx.Provider value={actionsValue}>
        <DownloadTasksProvider stream={stream} onPollSync={handleStateChange}>{children}</DownloadTasksProvider>
      </ActionsCtx.Provider>
    </GalleryStatusCtx.Provider>
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

/** O(1) coarse status subscription: gallery cards never re-render on byte/speed SSE ticks. */
export function useGalleryDownloadStatus(source: DoujinSource, galleryId: string): GalleryDownloadStatus | undefined {
  const store = React.useContext(GalleryStatusCtx);
  const key = `${source}:${galleryId}`;
  const subscribe = React.useCallback((listener: () => void) => store ? store.subscribe(key, listener) : () => {}, [store, key]);
  const getSnapshot = React.useCallback(() => store?.get(key), [store, key]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Observe only this gallery; unrelated SSE ticks retain the selected task reference. */
export function useGalleryDownloadTask(source: DoujinSource, galleryId: string): DownloadTask | undefined {
  const select = React.useCallback((tasks: DownloadTask[]) => tasks.find(task => task.source === source && task.galleryId === galleryId &&
    (task.status === 'queued' || task.status === 'downloading' || task.status === 'paused' || task.state?.type === 'retry-wait')), [source, galleryId]);
  const qc = useQueryClient();
  const queryFn = React.useMemo(() => downloadsQueryFn(qc), [qc]);
  return useQuery({ queryKey: ['downloads'], queryFn, enabled: false, select }).data;
}

/** Tasks the user should look at: real failures, never cancels or scheduled retries. */
export function needsAttention(task: DownloadTask): boolean {
  return task.status === 'failed' && task.state?.type !== 'retry-wait' && task.state?.type !== 'cancelled';
}

/** Moving or waiting to move, including automatic retries; paused waits on the user. */
export function isActiveDownload(task: DownloadTask): boolean {
  return task.status === 'downloading' || task.status === 'queued' || task.state?.type === 'retry-wait';
}

/**
 * Targeted read of the task list: the component re-renders only when the
 * selected value changes (react-query structurally shares `select` output),
 * not on every progress tick. Keep `select` referentially stable
 * (module-level or useCallback). Returns undefined until the first list arrives.
 */
export function useDownloadsSelector<T>(select: (tasks: DownloadTask[]) => T): T | undefined {
  const qc = useQueryClient();
  const queryFn = React.useMemo(() => downloadsQueryFn(qc), [qc]);
  return useQuery({ queryKey: ['downloads'], queryFn, enabled: false, select }).data;
}

const selectDownloadSummary = (tasks: DownloadTask[]) => ({
  active: tasks.filter(isActiveDownload).length,
  failed: tasks.filter(needsAttention).length,
});

/** Two counts for tab labels; the selected numbers are stable, so progress ticks never re-render. */
export function useDownloadSummary(): { active: number; failed: number } {
  return useDownloadsSelector(selectDownloadSummary) ?? { active: 0, failed: 0 };
}
