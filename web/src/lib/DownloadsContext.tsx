import * as React from 'react';
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type DownloadTask, type DoujinSource } from './api';
import { useDownloadEvents } from './useDownloadEvents';
import { toast } from './toast';
import { downloadErrorHelp } from './downloadErrors';
import { mergeDownloadPoll } from './downloadPoll';
import { SOURCE_LABELS } from '../pages/downloader/state';

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
    const prev = qc.getQueryData<DownloadTask[]>(['downloads']);
    if (!prev) return fresh;
    return mergeDownloadPoll(prev, fresh);
  };
}

export type GalleryDownloadStatus = 'queued' | 'downloading' | 'paused' | 'retry-wait';

interface GalleryStatusStore {
  subscribe: (key: string, listener: () => void) => () => void;
  get: (key: string) => GalleryDownloadStatus | undefined;
  sync: (tasks: DownloadTask[]) => void;
}

const ActionsCtx = React.createContext<DownloadActionsApi | null>(null);
const TasksCtx = React.createContext<DownloadTasksApi | null>(null);
const GalleryStatusCtx = React.createContext<GalleryStatusStore | null>(null);

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
  const [statusStore] = React.useState(createGalleryStatusStore);
  const queryFn = React.useMemo(() => downloadsQueryFn(qc), [qc]);

  // Polling is a lightweight fallback for when the SSE stream is down; while
  // the stream is connected it already folds every snapshot/task event into
  // this same cache, so a concurrent poll would only double the traffic.
  const downloadsQuery = useQuery({
    queryKey: ['downloads'],
    queryFn,
    refetchInterval: liveConnected ? false : 5000,
  });
  const data = downloadsQuery.data;
  const tasks = React.useMemo(() => (Array.isArray(data) ? data : []), [data]);
  React.useEffect(() => { statusStore.sync(tasks); }, [statusStore, tasks]);
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
      loading: downloadsQuery.isPending,
      refetch: downloadsQuery.refetch,
      tasks,
      active,
    }),
    [tasks, active, downloadsQuery.error, downloadsQuery.isPending, downloadsQuery.refetch],
  );

  return (
    <GalleryStatusCtx.Provider value={statusStore}>
      <ActionsCtx.Provider value={actionsValue}>
        <TasksCtx.Provider value={tasksValue}>{children}</TasksCtx.Provider>
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

/** Two counts for tab labels; the selected numbers are stable, so progress ticks never re-render. */
export function useDownloadSummary(): { active: number; failed: number } {
  const select = React.useCallback((tasks: DownloadTask[]) => ({
    active: tasks.filter(isActiveDownload).length,
    failed: tasks.filter(needsAttention).length,
  }), []);
  const qc = useQueryClient();
  return useQuery({ queryKey: ['downloads'], queryFn: downloadsQueryFn(qc), enabled: false, select }).data ?? { active: 0, failed: 0 };
}
