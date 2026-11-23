import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, keepPreviousData } from '@tanstack/react-query';
import { Download as DownloadIcon, Pause, Play, XCircle, RotateCcw, Trash2, CheckCircle2, FileArchive, FolderOpen, FileText, Copy, AlertTriangle, Library, ImageOff } from 'lucide-react';
import { MAX_AUTO_RETRIES } from '../../../../server/src/contracts/downloads';
import { api, type DownloadTask, type DownloadLibraryState } from '../../lib/api';
import { useDownloads, needsAttention } from '../../lib/DownloadsContext';
import { retryWaitReason } from '../../lib/downloadErrors';
import { toast } from '../../lib/toast';
import { cn, timeAgo, toIsoUtc } from '../../lib/utils';
import { formatBytes, formatSpeed } from '../../lib/format';
import { Button, Badge, EmptyState, ProgressBar, ErrorState, Skeleton, Spinner, SegmentedControl, InlineConfirm } from '../../components/ui';
import { ComicInfoModal } from '../../components/ComicInfoModal';
import { DownloadFailure } from './DownloadSetup';
import { DownloadStatusBadge, SourceBadge } from './GalleryCard';
import { SOURCE_LABELS } from './state';
import { useDownloaderTransitions } from './motion';

/** Completed rows shown before "Show all" in the combined view. */
const HISTORY_PREVIEW = 5;
const HISTORY_PAGE = 50;
const touch = 'max-lg:min-h-11 pointer-coarse:min-h-11';

type Filter = 'all' | 'active' | 'failed' | 'completed';
type RowAction = 'pause' | 'resume' | 'cancel' | 'retry';
type Confirmable = 'cancel' | 'remove';

const titleOf = (task: DownloadTask) => task.title ?? `Gallery ${task.galleryId}`;
const time = (iso: string | null | undefined) => (iso ? new Date(toIsoUtc(iso)).getTime() || 0 : 0);
const isCancelled = (task: DownloadTask) => task.status === 'failed' && task.state?.type === 'cancelled';
const isRetryWait = (task: DownloadTask) => task.state?.type === 'retry-wait';
const isRunning = (task: DownloadTask) => task.status === 'downloading';

/** The order work actually happens in: moving now, retrying, the queue as the worker claims it, then paused. */
function activeRank(task: DownloadTask): number {
  return isRunning(task) ? 0 : isRetryWait(task) ? 1 : task.status === 'queued' ? 2 : 3;
}
function sortActive(tasks: DownloadTask[]): DownloadTask[] {
  return [...tasks].sort((a, b) => activeRank(a) - activeRank(b)
    || (a.status === 'queued' && b.status === 'queued' ? (b.priority ?? 0) - (a.priority ?? 0) : 0)
    || a.id - b.id);
}
const byFinished = (a: DownloadTask, b: DownloadTask) => time(b.finishedAt) - time(a.finishedAt) || b.id - a.id;

function fileName(outputPath: string): string {
  return outputPath.split(/[\\/]/).filter(Boolean).pop() ?? outputPath;
}

const coverClass = 'aspect-[3/4] w-12 shrink-0 self-start rounded-sm border border-border sm:w-14';

/** A finished row always keeps its cover column, so titles in the list stay aligned. */
function TaskCover({ id, folder }: { id: number; folder: boolean }) {
  const [failed, setFailed] = React.useState(false);
  if (failed || folder) {
    return <div aria-hidden="true" className={cn(coverClass, 'flex items-center justify-center bg-surface-2 text-muted')}>{folder ? <FolderOpen className="h-4 w-4" /> : <ImageOff className="h-4 w-4" />}</div>;
  }
  return (
    <img
      src={`/api/downloads/${id}/cover`}
      alt=""
      width={56}
      height={75}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn(coverClass, 'object-cover')}
    />
  );
}

/** Seconds tick only inside this span, so a waiting retry never re-renders its row. */
function RetryCountdown({ at }: { at: string }) {
  const target = time(at);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((target - now) / 1000));
  return <span className="tabular-nums">{seconds <= 0 ? 'any moment now' : seconds < 60 ? `in ${seconds}s` : `in ${Math.ceil(seconds / 60)} min`}</span>;
}

function LibraryLine({ state }: { state: DownloadLibraryState }) {
  if (state.state === 'importing') {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <Spinner /> Importing into Kavita…
        <Link className={cn('inline-flex min-h-9 items-center text-primary underline underline-offset-4', touch)} to={`/jobs?job=${state.jobId}`}>View task</Link>
      </p>
    );
  }
  if (state.state === 'failed') {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
        <span title={state.message ?? undefined}>Kavita import didn’t finish.</span>
        <Link className={cn('inline-flex min-h-9 items-center text-primary underline underline-offset-4', touch)} to={`/jobs?job=${state.jobId}`}>View task</Link>
      </p>
    );
  }
  const [series, ...others] = state.series;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Library aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />
        <span className="shrink-0">In Kavita</span>
        {series && <>
          <span aria-hidden="true" className="text-muted">·</span>
          <Link className={cn('inline-flex min-h-9 min-w-0 items-center truncate font-medium text-primary underline-offset-4 hover:underline', touch)} to={`/libraries?series=${series.id}`}>{series.name}</Link>
          {others.length > 0 && <span className="shrink-0 text-muted">+{others.length}</span>}
        </>}
      </span>
      {state.review && series && (
        <Button asChild size="sm" variant="outline" className={touch}>
          <Link to={`/libraries?series=${series.id}&action=identify`}>Review metadata</Link>
        </Button>
      )}
    </div>
  );
}

function copyPath(value: string) {
  void navigator.clipboard.writeText(value).then(
    () => toast({ tone: 'success', title: 'Path copied' }),
    () => toast({ tone: 'danger', title: 'Could not copy the path' }),
  );
}

interface RowProps {
  task: DownloadTask;
  library?: DownloadLibraryState;
  /** "Next up" / "3rd in queue" for queued rows. */
  queueLabel?: string;
  confirming: Confirmable | null;
  onAction: (id: number, action: RowAction) => void;
  onRequest: (id: number, action: Confirmable) => void;
  onKeep: () => void;
  onConfirm: (id: number, action: Confirmable) => void;
  onEditComicInfo: (path: string) => void;
}

const DownloadRow = React.memo(function DownloadRow({ task, library, queueLabel, confirming, onAction, onRequest, onKeep, onConfirm, onEditComicInfo }: RowProps) {
  const title = titleOf(task);
  const source = SOURCE_LABELS[task.source] ?? task.source;
  const state = task.state?.type ?? task.status;
  const resolving = isRunning(task) && task.phase === 'resolving';
  const packing = state === 'packing';
  const pct = task.progressTotal > 0 ? Math.round((task.progressCurrent / task.progressTotal) * 100) : 0;
  const completed = task.status === 'completed' && !!task.outputPath;
  const cancelled = isCancelled(task);
  const retryWait = isRetryWait(task);
  const failed = needsAttention(task);
  const when = completed ? `Finished ${timeAgo(task.finishedAt ?? task.createdAt)}`
    : cancelled ? `Cancelled ${timeAgo(task.finishedAt ?? task.createdAt)}`
      : failed ? `Failed ${timeAgo(task.finishedAt ?? task.createdAt)}`
        : isRunning(task) && task.startedAt ? `Started ${timeAgo(task.startedAt)}`
          : `Added ${timeAgo(task.createdAt)}`;
  const icon = (label: string, action: () => void, glyph: React.ReactNode) => (
    <Button size="icon" variant="ghost" aria-label={`${label}: ${title}`} title={label} onClick={action}>{glyph}</Button>
  );

  return (
    <li data-download-id={task.id} className={cn('flex min-w-0 gap-3 p-3 sm:p-4', cancelled && 'bg-surface-2/40')}>
      {completed && <TaskCover id={task.id} folder={task.outputFormat === 'folder'} />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          {/* A 15rem floor lets the actions drop below the title on narrow rows instead of squeezing it. */}
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1.5">
            <span className={cn('min-w-0 break-words text-sm font-medium line-clamp-2', cancelled && 'text-muted')} title={title}>{title}</span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              {/* The Completed heading and the Kavita line already say it finished. */}
              {!completed && <DownloadStatusBadge status={resolving ? 'resolving' : state} />}
              <SourceBadge source={task.source} />
              {queueLabel && <span className="font-medium text-foreground">{queueLabel}</span>}
              <span>{when}</span>
              {task.outputFormat === 'folder' && <Badge tone="muted">Image folder</Badge>}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {(isRunning(task) || task.status === 'queued') && !packing && icon('Pause', () => onAction(task.id, 'pause'), <Pause className="h-4 w-4" />)}
            {task.status === 'paused' && icon('Resume', () => onAction(task.id, 'resume'), <Play className="h-4 w-4" />)}
            {retryWait && <Button size="sm" variant="outline" className={touch} onClick={() => onAction(task.id, 'retry')}><RotateCcw className="h-4 w-4" /> Retry now</Button>}
            {failed && <Button size="sm" className={touch} aria-label={`Retry ${title}`} onClick={() => onAction(task.id, 'retry')}><RotateCcw className="h-4 w-4" /> Retry</Button>}
            {completed && task.outputFormat === 'cbz' && (
              <Button size="sm" variant="ghost" className={touch} aria-label={`Edit ComicInfo for ${title}`} title="Edit the ComicInfo.xml inside this archive" onClick={() => onEditComicInfo(task.outputPath!)}>
                <FileText className="h-4 w-4" /> ComicInfo
              </Button>
            )}
            {(completed || cancelled) && icon('Download again', () => onAction(task.id, 'retry'), <DownloadIcon className="h-4 w-4" />)}
            {(isRunning(task) || task.status === 'queued' || task.status === 'paused' || retryWait) && !packing && icon('Cancel download', () => onRequest(task.id, 'cancel'), <XCircle className="h-4 w-4" />)}
            {(completed || cancelled || failed || (task.status === 'completed' && !task.outputPath)) && icon('Remove from history', () => onRequest(task.id, 'remove'), <Trash2 className="h-4 w-4" />)}
          </div>
        </div>

        {isRunning(task) && (
          <>
            <ProgressBar active={!resolving && !packing} value={packing ? 1 : task.progressCurrent} max={packing ? 1 : task.progressTotal} label={`Download progress for ${title}`} />
            {resolving || packing || task.progressTotal === 0 ? (
              <p className="text-xs text-muted">{packing ? 'Packing archive…' : 'Resolving gallery…'}</p>
            ) : (
              <div className="flex flex-col gap-1 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 truncate">{task.currentFile ? `Saving ${task.currentFile}` : 'Starting…'}</span>
                <span className="min-w-0 break-words tabular-nums sm:text-right">
                  {`${task.progressCurrent} of ${task.progressTotal} pages (${pct}%)`}
                  {typeof task.bytesCurrent === 'number' && (task.bytesCurrent > 0 || (task.bytesTotal ?? 0) > 0) && (` · ${formatBytes(task.bytesCurrent)}${(task.bytesTotal ?? 0) > 0 ? ` of ${formatBytes(task.bytesTotal)}` : ''}`)}
                  {formatSpeed(task.speed) && ` · ${formatSpeed(task.speed)}`}
                </span>
              </div>
            )}
          </>
        )}

        {task.status === 'paused' && task.progressTotal > 0 && (
          <>
            <ProgressBar value={task.progressCurrent} max={task.progressTotal} label={`Download progress for ${title}`} />
            <p className="text-xs tabular-nums text-muted">Paused at {task.progressCurrent} of {task.progressTotal} pages ({pct}%)</p>
          </>
        )}

        {retryWait && task.state?.type === 'retry-wait' && (
          <p className="text-pretty text-sm">
            {retryWaitReason(task.errorMessage, task.errorCode, source)}{' '}
            <span className="text-muted">H-Tosho retries automatically <RetryCountdown at={task.state.retryAt} /> (attempt {task.state.retryCount} of {MAX_AUTO_RETRIES}).</span>
          </p>
        )}

        {failed && task.errorMessage && <DownloadFailure message={task.errorMessage} code={task.errorCode} source={source} />}

        {cancelled && task.progressCurrent > 0 && (
          <p className="text-xs tabular-nums text-muted">{task.progressCurrent} of {task.progressTotal || '?'} pages kept. Download again resumes from there.</p>
        )}

        {completed && (
          <div className="flex flex-col gap-1">
            {library && <LibraryLine state={library} />}
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              {task.outputFormat === 'cbz' ? <FileArchive aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 truncate" title={task.outputPath!}>{fileName(task.outputPath!)}</span>
              {typeof navigator !== 'undefined' && navigator.clipboard && (
                <Button size="icon" variant="ghost" className="shrink-0" aria-label={`Copy the full path of ${title}`} title="Copy full path" onClick={() => copyPath(task.outputPath!)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        )}

        {confirming && <RowConfirm task={task} action={confirming} onKeep={onKeep} onConfirm={onConfirm} />}
      </div>
    </li>
  );
});

function RowConfirm({ task, action, onKeep, onConfirm }: { task: DownloadTask; action: Confirmable; onKeep: () => void; onConfirm: (id: number, action: Confirmable) => void }) {
  if (action === 'cancel') {
    const kept = task.progressCurrent > 0;
    const keepLabel = isRetryWait(task) ? 'Keep retrying' : task.status === 'queued' ? 'Keep in queue' : task.status === 'paused' ? 'Keep paused' : 'Keep downloading';
    return (
      <InlineConfirm label="Confirm cancelling this download" keepLabel={keepLabel} confirmLabel="Cancel download" icon={<XCircle className="h-4 w-4" />} onKeep={onKeep} onConfirm={() => onConfirm(task.id, 'cancel')} controlClassName={touch}>
        <span className="font-semibold">Cancel this download?</span>{' '}
        {kept ? `The ${task.progressCurrent} pages already saved are kept, so Download again resumes from there.` : 'It hasn’t saved any pages yet, so nothing is lost.'}
      </InlineConfirm>
    );
  }
  const completed = task.status === 'completed';
  return (
    <InlineConfirm label="Confirm removing this download from history" keepLabel="Keep" confirmLabel="Remove" icon={<Trash2 className="h-4 w-4" />} onKeep={onKeep} onConfirm={() => onConfirm(task.id, 'remove')} controlClassName={touch}>
      <span className="font-semibold">Remove from history?</span>{' '}
      {completed
        ? 'The file stays on disk and in Kavita. Discover may stop marking this gallery as downloaded.'
        : 'Its partly downloaded pages are deleted. Nothing in your library changes.'}
    </InlineConfirm>
  );
}

function Section({ id, title, count, countTone = 'muted', description, actions, children }: { id: string; title: string; count: number; countTone?: 'muted' | 'danger'; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby={id}>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 id={id} className="flex items-center gap-2 text-base font-semibold tracking-tight">
            {title}<Badge tone={countTone} className="tabular-nums" aria-hidden="true">{count}</Badge><span className="sr-only">, {count} {count === 1 ? 'download' : 'downloads'}</span>
          </h2>
          {description && <p className="mt-0.5 text-pretty text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function RowList({ children }: { children: React.ReactNode }) {
  return <ul className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">{children}</ul>;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function ManagerTab() {
  const { tasks, loading: downloadsLoading, error: downloadsError, refetch: refetchDownloads, pause, resume, cancel, retry, removeTask, clearCompleted } = useDownloads();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('status');
  const filter: Filter = requested === 'failed' || requested === 'active' || requested === 'completed' ? requested : 'all';
  const setFilter = (next: Filter) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('tab', 'downloads');
      if (next === 'all') params.delete('status');
      else params.set('status', next);
      return params;
    }, { replace: true });
  };

  const [confirm, setConfirm] = React.useState<{ id: number; action: Confirmable } | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [showAllHistory, setShowAllHistory] = React.useState(false);
  const [wantOlder, setWantOlder] = React.useState(false);
  const [comicInfo, setComicInfo] = React.useState<{ path?: string } | null>(null);

  const attention = React.useMemo(() => tasks.filter(needsAttention).sort((a, b) => b.id - a.id), [tasks]);
  const active = React.useMemo(() => sortActive(tasks.filter((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'paused' || isRetryWait(t))), [tasks]);
  const cancelledTasks = React.useMemo(() => tasks.filter(isCancelled).sort((a, b) => b.id - a.id), [tasks]);
  const liveCompleted = React.useMemo(() => tasks.filter((t) => t.status === 'completed'), [tasks]);

  // Every completed gallery (also powers Discover's Downloaded badges): its length is the true history size.
  const completedIndex = useQuery({ queryKey: ['downloads-completed'], queryFn: api.downloadsCompleted, staleTime: 30_000 });
  const completedTotal = Math.max(completedIndex.data?.length ?? 0, liveCompleted.length);
  const older = useInfiniteQuery({
    queryKey: ['downloads-history'],
    queryFn: ({ pageParam }) => api.downloadHistory(pageParam, HISTORY_PAGE),
    initialPageParam: liveCompleted.length,
    getNextPageParam: (last, _pages, lastParam) => (lastParam + last.items.length < last.total && last.items.length > 0 ? lastParam + last.items.length : undefined),
    enabled: wantOlder,
  });
  const completed = React.useMemo(() => {
    const byId = new Map(liveCompleted.map((task) => [task.id, task]));
    for (const page of older.data?.pages ?? []) for (const task of page.items) if (!byId.has(task.id) && task.status === 'completed') byId.set(task.id, task);
    return [...byId.values()].sort(byFinished);
  }, [liveCompleted, older.data]);

  const fullHistory = filter === 'completed' || showAllHistory;
  const shownCompleted = fullHistory ? completed : completed.slice(0, HISTORY_PREVIEW);
  const moreToLoad = fullHistory && completed.length < completedTotal;

  const libraryIds = React.useMemo(() => shownCompleted.map((task) => task.id), [shownCompleted]);
  const libraryQuery = useQuery({
    queryKey: ['downloads-library', libraryIds.join(',')],
    queryFn: () => api.downloadLibrary(libraryIds),
    enabled: libraryIds.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (Object.values(query.state.data ?? {}).some((entry) => entry.state === 'importing') ? 4000 : false),
  });
  const library = libraryQuery.data;

  const queueLabels = React.useMemo(() => {
    const labels = new Map<number, string>();
    active.filter((task) => task.status === 'queued').forEach((task, index) => labels.set(task.id, index === 0 ? 'Next up' : `${ordinal(index + 1)} in queue`));
    return labels;
  }, [active]);

  const queueMotionRef = useDownloaderTransitions(`${filter}:${fullHistory}:${completed.length}:${tasks.map((task) => `${task.id}:${task.status}:${task.state?.type}`).join(',')}`);

  const act = React.useCallback((id: number, a: RowAction) => {
    if (a === 'pause') pause(id);
    else if (a === 'resume') resume(id);
    else if (a === 'cancel') cancel(id);
    else retry(id);
  }, [pause, resume, cancel, retry]);
  const request = React.useCallback((id: number, action: Confirmable) => { setConfirmClear(false); setConfirm({ id, action }); }, []);
  const keep = React.useCallback(() => setConfirm(null), []);
  const confirmAction = React.useCallback((id: number, action: Confirmable) => {
    setConfirm(null);
    if (action === 'cancel') cancel(id);
    else removeTask(id);
  }, [cancel, removeTask]);
  const openComicInfo = React.useCallback((path: string) => setComicInfo({ path }), []);

  const running = active.filter((task) => isRunning(task) || task.status === 'queued');
  const paused = active.filter((task) => task.status === 'paused');
  const retrying = active.filter(isRetryWait);
  const activeSummary = [
    active.filter(isRunning).length && `${active.filter(isRunning).length} downloading`,
    retrying.length && `${retrying.length} retrying`,
    active.filter((task) => task.status === 'queued').length && `${active.filter((task) => task.status === 'queued').length} queued`,
    paused.length && `${paused.length} paused`,
  ].filter(Boolean).join(' · ');

  const renderRow = (task: DownloadTask) => (
    <DownloadRow
      key={task.id}
      task={task}
      library={library?.[task.id]}
      queueLabel={queueLabels.get(task.id)}
      confirming={confirm?.id === task.id ? confirm.action : null}
      onAction={act}
      onRequest={request}
      onKeep={keep}
      onConfirm={confirmAction}
      onEditComicInfo={openComicInfo}
    />
  );

  const filters = [
    { id: 'all' as const, label: 'All', count: tasks.length - liveCompleted.length + completedTotal },
    { id: 'active' as const, label: 'Active', count: active.length },
    { id: 'failed' as const, label: 'Failed', count: attention.length, alert: attention.length > 0 },
    { id: 'completed' as const, label: 'Completed', count: completedTotal },
  ];
  const statusText = `${active.length} active, ${attention.length} failed, ${completedTotal} completed`;
  const filterEmpty = (filter === 'failed' && attention.length === 0) || (filter === 'active' && active.length === 0) || (filter === 'completed' && completedTotal === 0);

  return (
    <>
      <div ref={queueMotionRef} className="flex min-w-0 flex-col gap-6">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span aria-hidden="true" className="text-sm font-medium text-muted">Show</span>
          <SegmentedControl items={filters} value={filter} onChange={setFilter} label="Show downloads" className="max-w-full" itemClassName={cn('min-h-9 px-2.5 text-xs sm:px-3 sm:text-sm', touch)} />
          <span role="status" className="sr-only">{downloadsLoading ? '' : statusText}</span>
        </div>

        {downloadsError ? (
          <ErrorState title="Could not load downloads" description={downloadsError.message} onRetry={() => void refetchDownloads()} />
        ) : downloadsLoading ? (
          <div role="status" aria-label="Loading downloads" className="flex flex-col gap-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><span className="sr-only">Loading downloads…</span></div>
        ) : tasks.length === 0 && completedTotal === 0 ? (
          <EmptyState icon={<DownloadIcon className="h-8 w-8" />} title="No downloads yet" description="Choose Download on any gallery in Search, For you or Following to queue it here. Set the output folder in Settings first." />
        ) : filterEmpty ? (
          <EmptyState
            icon={filter === 'failed' ? <CheckCircle2 className="h-8 w-8" /> : <DownloadIcon className="h-8 w-8" />}
            title={filter === 'failed' ? 'No failed downloads' : filter === 'active' ? 'Nothing downloading' : 'No completed downloads'}
            description={filter === 'failed' && retrying.length > 0 ? `${retrying.length === 1 ? 'One download is' : `${retrying.length} downloads are`} retrying automatically under Active.` : 'Choose All to see the rest of your queue and history.'}
          />
        ) : (
          <>
            {(filter === 'all' || filter === 'failed') && attention.length > 0 && (
              <Section
                id="downloads-attention"
                title="Needs attention"
                count={attention.length}
                countTone="danger"
                description="These stopped and need you. Fix the cause, then retry."
                actions={attention.length > 1 && <Button size="sm" variant="outline" className={touch} onClick={() => attention.forEach((task) => retry(task.id))}><RotateCcw className="h-4 w-4" /> Retry all {attention.length}</Button>}
              >
                <RowList>{attention.map(renderRow)}</RowList>
              </Section>
            )}

            {(filter === 'all' || filter === 'active') && active.length > 0 && (
              <Section
                id="downloads-active"
                title="Active"
                count={active.length}
                description={activeSummary}
                actions={running.length > 0
                  ? <Button size="sm" variant="outline" className={touch} onClick={() => running.forEach((task) => pause(task.id))}><Pause className="h-4 w-4" /> Pause all</Button>
                  : paused.length > 0 && <Button size="sm" variant="outline" className={touch} onClick={() => paused.forEach((task) => resume(task.id))}><Play className="h-4 w-4" /> Resume all</Button>}
              >
                <RowList>{active.map(renderRow)}</RowList>
              </Section>
            )}

            {(filter === 'all' || filter === 'completed') && completedTotal > 0 && (
              <Section
                id="downloads-completed"
                title="Completed"
                count={completedTotal}
                description="Newest first."
                actions={!confirmClear && <Button size="sm" variant="ghost" className={touch} onClick={() => { setConfirm(null); setConfirmClear(true); }}><Trash2 className="h-4 w-4" /> Clear completed</Button>}
              >
                {confirmClear && (
                  <InlineConfirm label="Confirm clearing completed downloads" keepLabel="Keep history" confirmLabel="Clear completed" icon={<Trash2 className="h-4 w-4" />} onKeep={() => setConfirmClear(false)} onConfirm={() => { clearCompleted(); setConfirmClear(false); }} controlClassName={touch}>
                    <span className="font-semibold">Clear {completedTotal === 1 ? 'the completed download' : `all ${completedTotal} completed downloads`} from history?</span>{' '}
                    Files stay on disk and in Kavita. Discover may stop marking these galleries as downloaded.
                  </InlineConfirm>
                )}
                <RowList>{shownCompleted.map(renderRow)}</RowList>
                {(filter === 'all' && completed.length > HISTORY_PREVIEW) || moreToLoad ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {filter === 'all' && completed.length > HISTORY_PREVIEW && (
                      <Button size="sm" variant="ghost" className={touch} onClick={() => setShowAllHistory((value) => !value)}>{showAllHistory ? 'Show fewer' : `Show all ${completedTotal}`}</Button>
                    )}
                    {moreToLoad && (
                      <Button size="sm" variant="outline" className={touch} disabled={older.isFetching} onClick={() => { if (!wantOlder) setWantOlder(true); else void older.fetchNextPage(); }}>
                        {older.isFetching && <Spinner />} Load older downloads ({completedTotal - completed.length} more)
                      </Button>
                    )}
                    {older.isError && <span className="text-xs text-danger">Could not load older downloads. Try again.</span>}
                  </div>
                ) : null}
              </Section>
            )}

            {filter === 'all' && cancelledTasks.length > 0 && (
              <Section id="downloads-cancelled" title="Cancelled" count={cancelledTasks.length} description="You stopped these. Saved pages are kept until you remove them.">
                <RowList>{cancelledTasks.map(renderRow)}</RowList>
              </Section>
            )}
          </>
        )}
      </div>
      {comicInfo && (
        <ComicInfoModal initialPath={comicInfo.path} onClose={() => setComicInfo(null)} />
      )}
    </>
  );
}
