import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Loader2, CheckCircle2, XCircle, Pause, Play, RotateCcw, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useDownloads } from '../lib/DownloadsContext';
import { formatBytes, formatSpeed } from '../lib/format';
import { ProgressBar } from './ui';
import type { DownloadTask } from '../lib/api';

/** A finished task counts as "recent" for this long so the tray can surface it. */
const RECENT_MS = 90_000;

function isRecentFinished(t: DownloadTask): boolean {
  if (t.status !== 'completed' && t.status !== 'failed') return false;
  if (!t.finishedAt) return true;
  const ts = Date.parse(t.finishedAt);
  return Number.isFinite(ts) ? Date.now() - ts <= RECENT_MS : true;
}

function TaskIcon({ status }: { status: DownloadTask['status'] }) {
  if (status === 'downloading') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />;
  if (status === 'queued') return <Download className="h-4 w-4 shrink-0 text-muted" />;
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-danger" />;
  return <Pause className="h-4 w-4 shrink-0 text-warning" />; // paused
}

function TrayRow({ task, onAction }: { task: DownloadTask; onAction: (op: 'pause' | 'resume' | 'cancel' | 'retry', id: number) => void }) {
  const pct = task.progressTotal > 0 ? Math.round((task.progressCurrent / task.progressTotal) * 100) : 0;
  const busy = task.status === 'downloading';
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2/40 p-2.5">
      <div className="flex items-center gap-2">
        <TaskIcon status={task.status} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={task.title ?? ''}>
          {task.title ?? `Gallery ${task.galleryId}`}
        </span>
        {busy && (
          <button onClick={() => onAction('pause', task.id)} title="Pause" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground">
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
        {(task.status === 'paused' || (task.status === 'failed' && task.errorMessage !== 'Cancelled by user')) && (
          <button onClick={() => onAction('resume', task.id)} title="Resume" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground">
            <Play className="h-3.5 w-3.5" />
          </button>
        )}
        {task.status === 'failed' && (
          <button onClick={() => onAction('retry', task.id)} title="Retry" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {(busy || task.status === 'queued') && (
          <button onClick={() => onAction('cancel', task.id)} title="Cancel" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger">
            <XCircle className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {busy && (
        <>
          <ProgressBar value={task.progressCurrent} max={task.progressTotal} />
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
            <span className="truncate">{task.currentFile ?? 'Starting…'}</span>
            <span className="shrink-0">
              {task.progressTotal > 0 ? `${pct}%` : ''}
              {typeof task.bytesCurrent === 'number' && (task.bytesCurrent > 0 || (task.bytesTotal ?? 0) > 0) && ` · ${formatBytes(task.bytesCurrent)}`}
              {formatSpeed(task.speed) && ` · ${formatSpeed(task.speed)}`}
            </span>
          </div>
        </>
      )}

      {task.status === 'failed' && task.errorMessage && (
        <p className="truncate text-[10px] text-danger" title={task.errorMessage}>{task.errorMessage}</p>
      )}
    </div>
  );
}

/**
 * Global floating download dock. Renders on every page so progress is always
 * visible even when the Download Manager (below a long results grid) is off-screen.
 * Collapsed to a compact pill with aggregate progress; expands into per-task detail.
 */
export function DownloadTray() {
  const { tasks, active, pause, resume, cancel, retry } = useDownloads();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);

  // Re-evaluate "recent finished" on a light interval so the tray auto-hides.
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const t = window.setInterval(tick, 5000);
    return () => window.clearInterval(t);
  }, []);

  const recentFinished = tasks.filter(isRecentFinished);
  const visible = active.length > 0 || recentFinished.length > 0;
  if (!visible) return null;

  // Aggregate progress across active tasks (page-based, falls back to bytes).
  const pageTotal = active.reduce((s, t) => s + (t.progressTotal || 0), 0);
  const pageDone = active.reduce((s, t) => s + (t.progressCurrent || 0), 0);
  const byteTotal = active.reduce((s, t) => s + (t.bytesTotal || 0), 0);
  const byteDone = active.reduce((s, t) => s + (t.bytesCurrent || 0), 0);
  const aggregatePct = pageTotal > 0 ? Math.round((pageDone / pageTotal) * 100) : byteTotal > 0 ? Math.round((byteDone / byteTotal) * 100) : null;

  const downloadingCount = active.filter((t) => t.status === 'downloading').length;
  const failedCount = recentFinished.filter((t) => t.status === 'failed').length;

  const onAction = (op: 'pause' | 'resume' | 'cancel' | 'retry', id: number) => {
    if (op === 'pause') pause(id);
    else if (op === 'resume') resume(id);
    else if (op === 'cancel') cancel(id);
    else retry(id);
  };

  const shown = [...active, ...recentFinished.filter((t) => t.status !== 'downloading' && t.status !== 'queued')].slice(0, 12);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col items-end">
      {open && (
        <div className="mb-2 w-full rounded-lg border border-border bg-surface shadow-2xl">
          <button
            onClick={() => navigate('/downloader')}
            className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left hover:bg-surface-2"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Download className="h-4 w-4" /> Downloads
              {downloadingCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">
                  <Loader2 className="h-3 w-3 animate-spin" /> {downloadingCount} active
                </span>
              )}
              {failedCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
                  <XCircle className="h-3 w-3" /> {failedCount} failed
                </span>
              )}
            </span>
            <ExternalLink className="h-4 w-4 shrink-0 text-muted" />
          </button>
          <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-3">
            {shown.map((t) => (
              <TrayRow key={t.id} task={t} onAction={onAction} />
            ))}
          </div>
        </div>
      )}

      {/* Collapsed pill */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-2xl transition-colors hover:bg-surface-2"
        title={open ? 'Collapse' : 'Expand downloads'}
      >
        {downloadingCount > 0 ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />
        ) : failedCount > 0 ? (
          <XCircle className="h-4 w-4 shrink-0 text-danger" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        )}
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">
              {downloadingCount > 0 ? `${downloadingCount} downloading` : failedCount > 0 ? 'Downloads finished' : 'Downloads complete'}
            </span>
            {aggregatePct !== null && <span className="shrink-0 text-xs text-muted">{aggregatePct}%</span>}
          </div>
          <ProgressBar value={aggregatePct ?? (downloadingCount > 0 ? 1 : 0)} max={100} className="mt-1 h-1.5" />
        </div>
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-muted" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted" />}
      </button>
    </div>
  );
}