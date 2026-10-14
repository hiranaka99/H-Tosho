import { DownloadFailure } from './DownloadSetup';
import { useDownloaderTransitions } from './motion';
const HISTORY_PREVIEW = 5;
import * as React from 'react';
import { useSearchParams } from 'react-router';
import { Download as DownloadIcon, Pause, Play, XCircle, RotateCcw, Trash2, CheckCircle2, FileArchive, FolderOpen, FileText } from 'lucide-react';
import { type DownloadTask } from '../../lib/api';
import { useDownloads } from '../../lib/DownloadsContext';
import { timeAgo } from '../../lib/utils';
import { formatBytes, formatSpeed } from '../../lib/format';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Select, EmptyState, ProgressBar, ErrorState, ConfirmDialog } from '../../components/ui';
import { ComicInfoModal } from '../../components/ComicInfoModal';

import { DownloadStatusBadge } from './GalleryCard';
function TaskCover({ id }: { id: number }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <img
      src={`/api/downloads/${id}/cover`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="w-16 shrink-0 self-stretch rounded-sm border border-border object-cover"
    />
  );
}

const QueueRow = React.memo(function QueueRow({ task, onAction, onEditComicInfo, onDelete }: { task: DownloadTask; onAction: (id: number, a: 'pause' | 'resume' | 'cancel' | 'retry') => void; onEditComicInfo?: (path: string) => void; onDelete?: (id: number) => void }) {
  const pct = task.progressTotal > 0 ? Math.round((task.progressCurrent / task.progressTotal) * 100) : 0;
  const showCover = task.status === 'completed' && !!task.outputPath;
  return (
    <div data-download-id={task.id} className="flex min-w-0 gap-3 rounded-lg border border-border p-3 transition-colors duration-150 sm:p-4">
      {showCover && <TaskCover id={task.id} />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
            <DownloadStatusBadge status={task.state?.type ?? task.status} />
            <span className="min-w-0 break-words text-sm font-medium line-clamp-2 sm:flex-1" title={task.title ?? ''}>{task.title ?? `Gallery ${task.galleryId}`}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {task.status === 'downloading' && <Button size="icon" variant="ghost" aria-label={`Pause ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onAction(task.id, 'pause')}><Pause className="h-4 w-4" /></Button>}
            {task.status === 'paused' && <Button size="icon" variant="ghost" aria-label={`Resume ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onAction(task.id, 'resume')}><Play className="h-4 w-4" /></Button>}
            {task.status === 'failed' && <Button size="sm" variant="outline" aria-label={`Retry ${task.title ?? 'download'}`} onClick={() => onAction(task.id, 'retry')}><RotateCcw className="h-4 w-4" /> Retry</Button>}
            {task.status === 'completed' && <Button size="icon" variant="ghost" aria-label={`Download ${task.title ?? `Gallery ${task.galleryId}`} again`} onClick={() => onAction(task.id, 'retry')}><RotateCcw className="h-4 w-4" /></Button>}
            {(task.status === 'downloading' || task.status === 'queued' || task.state?.type === 'retry-wait') && <Button size="icon" variant="ghost" aria-label={`Cancel ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onAction(task.id, 'cancel')}><XCircle className="h-4 w-4" /></Button>}
            {onDelete && <Button size="icon" variant="ghost" aria-label={`Remove ${task.title ?? `Gallery ${task.galleryId}`} from history`} onClick={() => onDelete(task.id)}><Trash2 className="h-4 w-4" /></Button>}
          </div>
        </div>

        {task.status === 'downloading' && (
          <>
            <ProgressBar value={task.progressCurrent} max={task.progressTotal} label={`Download progress for ${task.title ?? `Gallery ${task.galleryId}`}`} />
            <div className="flex flex-col gap-1 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
              <span className="truncate">{task.currentFile ? `Saving ${task.currentFile}` : 'Starting…'}</span>
              <span className="min-w-0 break-words tabular-nums sm:text-right">
                {task.progressTotal > 0 ? `${task.progressCurrent}/${task.progressTotal} pages (${pct}%)` : 'Resolving gallery…'}
                {typeof task.bytesCurrent === 'number' && (task.bytesCurrent > 0 || (task.bytesTotal ?? 0) > 0) && (` · ${formatBytes(task.bytesCurrent)}${(task.bytesTotal ?? 0) > 0 ? ` / ${formatBytes(task.bytesTotal)}` : ''}`)}
                {formatSpeed(task.speed) && ` · ${formatSpeed(task.speed)}`}
              </span>
            </div>
          </>
        )}

        {task.status === 'completed' && task.outputPath && (
          <div className="flex items-center gap-2 text-xs">
            {task.outputFormat === 'cbz' ? <FileArchive className="h-3.5 w-3.5 text-success" /> : <FolderOpen className="h-3.5 w-3.5 text-success" />}
            <span className="min-w-0 break-all text-muted">{task.outputPath}</span>
            {task.outputFormat === 'cbz' && onEditComicInfo && (
              <Button size="icon" variant="ghost" className="ml-auto shrink-0" aria-label={`Edit ComicInfo.xml for ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onEditComicInfo(task.outputPath!)}>
                <FileText className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}

        {task.status === 'failed' && task.errorMessage && (
          <DownloadFailure message={task.errorMessage} code={task.errorCode} />
        )}

        <div className="flex items-center justify-between text-xs text-muted">
          <span>{timeAgo(task.createdAt)}</span>
          <Badge tone={task.outputFormat === 'cbz' ? 'default' : 'info'}>{task.outputFormat.toUpperCase()}</Badge>
        </div>
      </div>
    </div>
  );
});

// ---------------- Merged download dialog ----------------

/** Sanitize a gallery title into a usable folder name. */
export function ManagerTab() {
  const { tasks, error: downloadsError, refetch: refetchDownloads, pause, resume, cancel, retry, removeTask, clearCompleted } = useDownloads();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus = searchParams.get('status');
  const status = requestedStatus === 'failed' || requestedStatus === 'active' ? requestedStatus : 'all';
  const setStatus = (next: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('tab', 'downloads');
      params.set('status', next);
      return params;
    });
  };
  const [confirmClear, setConfirmClear] = React.useState(false);
  // The id (not the task row) is held so the delete callback stays stable for
  // memoized QueueRows; the row itself is resolved from the task list for the
  // dialog copy.
  const [removeTargetId, setRemoveTargetId] = React.useState<number | null>(null);
  // History collapse and the ComicInfo editor are reachable only from manager rows.
  const [showAllHistory, setShowAllHistory] = React.useState(false);
  const [comicInfo, setComicInfo] = React.useState<{ path?: string } | null>(null);

  const queueMotionRef = useDownloaderTransitions(`${status}:${showAllHistory}:${tasks.map((task) => `${task.id}:${task.status}`).join(',')}`);

  const currentTasks = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'paused');
  const failed = tasks.filter((t) => t.status === 'failed');
  const finished = tasks.filter((t) => t.status === 'completed');
  const removeTarget = removeTargetId !== null ? tasks.find((t) => t.id === removeTargetId) ?? null : null;

  const act = React.useCallback((id: number, a: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (a === 'pause') pause(id);
    else if (a === 'resume') resume(id);
    else if (a === 'cancel') cancel(id);
    else retry(id);
  }, [pause, resume, cancel, retry]);
  // Stable row callbacks so memoized QueueRows skip re-renders when untouched.
  const openComicInfo = React.useCallback((path: string) => setComicInfo({ path }), []);
  const removeFromHistory = React.useCallback((id: number) => setRemoveTargetId(id), []);

  return (
    <>
      <div ref={queueMotionRef}>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
            <DownloadIcon className="h-4 w-4" /> Downloads
            {currentTasks.length > 0 && <Badge tone="info">{currentTasks.length} active</Badge>}
          </CardTitle>
          {finished.some((task) => task.status === 'completed') && <Button size="sm" variant="outline" onClick={() => setConfirmClear(true)}><Trash2 className="h-3.5 w-3.5" /> Clear completed</Button>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="download-status" className="text-sm font-medium">Show</label>
            <Select id="download-status" value={status} onChange={(event) => setStatus(event.target.value)} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-full sm:w-64">
              <option value="all">All downloads ({tasks.length})</option>
              <option value="active">Active ({currentTasks.length})</option>
              <option value="failed">Failed ({failed.length})</option>
            </Select>
          </div>
          {downloadsError ? (
            <ErrorState title="Could not load downloads" description={downloadsError.message} onRetry={() => void refetchDownloads()} />
          ) : tasks.length === 0 ? (
            <EmptyState icon={<DownloadIcon className="h-8 w-8" />} title="No downloads yet" description="Click Download on a gallery to queue it. Set the output folder in Settings first." />
          ) : (status === 'failed' && failed.length === 0) || (status === 'active' && currentTasks.length === 0) ? (
            <EmptyState icon={status === 'failed' ? <CheckCircle2 className="h-8 w-8" /> : <DownloadIcon className="h-8 w-8" />} title={status === 'failed' ? 'No failed downloads' : 'No active downloads'} description="Choose All downloads to view the rest of your queue and history." />
          ) : (
            <>
              {status !== 'active' && failed.length > 0 && (
                <section className="flex flex-col gap-2" aria-labelledby="failed-downloads">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id="failed-downloads" className="text-sm font-semibold text-danger">Needs attention</h3>
                    <Badge tone="danger">{failed.length} failed</Badge>
                  </div>
                  {failed.map((task) => <QueueRow key={task.id} task={task} onAction={act} onDelete={removeFromHistory} />)}
                </section>
              )}
              {status !== 'failed' && currentTasks.length > 0 && (
                <section className="flex flex-col gap-2" aria-labelledby="current-downloads">
                  <h3 id="current-downloads" className="text-sm font-semibold">Active downloads</h3>
                  {currentTasks.map((task) => <QueueRow key={task.id} task={task} onAction={act} onEditComicInfo={openComicInfo} />)}
                </section>
              )}
              {status === 'all' && finished.length > 0 && (
                <section className="flex flex-col gap-2" aria-labelledby="download-history">
                  <div className="flex items-center justify-between">
                    <h3 id="download-history" className="text-sm font-semibold">Completed</h3>
                    {finished.length > HISTORY_PREVIEW && <Button size="sm" variant="ghost" onClick={() => setShowAllHistory((value) => !value)}>{showAllHistory ? 'Show less' : `Show all (${finished.length})`}</Button>}
                  </div>
                  {(showAllHistory ? finished : finished.slice(0, HISTORY_PREVIEW)).map((task) => <QueueRow key={task.id} task={task} onAction={act} onEditComicInfo={openComicInfo} onDelete={removeFromHistory} />)}
                </section>
              )}
            </>
          )}
        </CardContent>
      </Card>

      </div>
      {comicInfo && (
        <ComicInfoModal initialPath={comicInfo.path} onClose={() => setComicInfo(null)} />
      )}
      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove download from history?"
        description={removeTarget ? `This removes “${removeTarget.title ?? `Gallery ${removeTarget.galleryId}`}” from history. Downloaded files are not deleted.` : ''}
        confirmLabel="Remove"
        onOpenChange={(open) => { if (!open) setRemoveTargetId(null); }}
        onConfirm={() => { if (removeTarget) removeTask(removeTarget.id); setRemoveTargetId(null); }}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear completed downloads?"
        description="This removes every completed download from history. Downloaded files are not deleted."
        confirmLabel="Clear completed"
        danger
        onOpenChange={setConfirmClear}
        onConfirm={() => { clearCompleted(); setConfirmClear(false); }}
      />
    </>
  );
}

// ---------------- Page ----------------
