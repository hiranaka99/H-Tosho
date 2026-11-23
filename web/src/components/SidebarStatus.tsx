import * as React from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Clock, Download, Pause, Play, XCircle, Ban } from 'lucide-react';
import { api, type Job, type DownloadTask } from '../lib/api';
import { toast } from '../lib/toast';
import { useDownloads, needsAttention as downloadNeedsAttention } from '../lib/DownloadsContext';
import { formatBytes, formatSpeed } from '../lib/format';
import { jobLabel } from '../lib/utils';
import { needsAttention } from '../lib/jobStatus';
import { ProgressBar } from './ui';

function JobRow({ job }: { job: Job }) {
  const qc = useQueryClient();
  const running = job.status === 'running';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={jobLabel(job.type, job.payload)}>
          {jobLabel(job.type, job.payload)}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => void api.cancelJob(job.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] })).catch((error) => toast({ tone: 'danger', title: 'Could not cancel job', description: error instanceof Error ? error.message : String(error) }))}
            aria-label={`Cancel ${jobLabel(job.type, job.payload)}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-danger"
          >
            <Ban className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {running &&
        (job.progressTotal > 0 ? (
          <>
            <ProgressBar value={job.progressCurrent} max={job.progressTotal} className="h-1.5" />
            <span className="text-xs leading-none text-muted">
              {job.progressCurrent}/{job.progressTotal}
            </span>
          </>
        ) : (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="animate-indeterminate h-full w-1/3 rounded-full bg-primary" />
          </div>
        ))}
    </div>
  );
}

function TaskIcon({ status }: { status: DownloadTask['status'] }) {
  if (status === 'downloading') return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" />;
  if (status === 'queued') return <Clock className="h-3.5 w-3.5 shrink-0 text-muted" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />;
  return <Pause className="h-3.5 w-3.5 shrink-0 text-warning" />;
}

function DownloadRow({ task, onAction }: { task: DownloadTask; onAction: (op: 'pause' | 'resume' | 'cancel', id: number) => void }) {
  const busy = task.status === 'downloading';
  const pct = task.progressTotal > 0 ? Math.round((task.progressCurrent / task.progressTotal) * 100) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <TaskIcon status={task.status} />
        <span className="min-w-0 flex-1 truncate text-xs" title={task.title ?? ''}>
          {task.title ?? `Gallery ${task.galleryId}`}
        </span>
        {busy && (
          <button type="button" onClick={() => onAction('pause', task.id)} aria-label={`Pause ${task.title ?? `Gallery ${task.galleryId}`}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground">
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
        {task.status === 'paused' && (
          <button type="button" onClick={() => onAction('resume', task.id)} aria-label={`Resume ${task.title ?? `Gallery ${task.galleryId}`}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground">
            <Play className="h-3.5 w-3.5" />
          </button>
        )}
        {(busy || task.status === 'queued') && (
          <button type="button" onClick={() => onAction('cancel', task.id)} aria-label={`Cancel ${task.title ?? `Gallery ${task.galleryId}`}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-danger">
            <XCircle className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {busy && (
        <>
          <ProgressBar value={task.progressCurrent} max={task.progressTotal} className="h-1.5" />
          <span className="text-xs leading-none text-muted">
            {pct !== null ? `${pct}%` : ''}
            {typeof task.bytesCurrent === 'number' && (task.bytesCurrent > 0 || (task.bytesTotal ?? 0) > 0) && ` · ${formatBytes(task.bytesCurrent)}`}
            {formatSpeed(task.speed) && ` · ${formatSpeed(task.speed)}`}
          </span>
        </>
      )}
    </div>
  );
}

/** Sidebar footer tracker for active background jobs and download controls. */
export function SidebarStatus() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 2500 });
  const { tasks, pause, resume, cancel } = useDownloads();
  const activeJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const previousJobs = React.useRef<Map<number, string> | null>(null);
  React.useEffect(() => {
    // A short apply can finish between polls without ever appearing as active.
    // Refresh on newly observed terminal states too, so its approval is visible.
    const previous = previousJobs.current;
    const current = new Map(jobs.map((j) => [j.id, j.status]));
    if (previous && (jobs.some((j) =>
      ['completed', 'failed', 'cancelled'].includes(j.status) && previous.get(j.id) !== j.status,
    ) || [...previous].some(([id, status]) =>
      (status === 'running' || status === 'queued') && !current.has(id),
    ))) {
      void qc.invalidateQueries({ queryKey: ['library-series'] });
      void qc.invalidateQueries({ queryKey: ['libraries'] });
      void qc.invalidateQueries({ queryKey: ['low-confidence'] });
      void qc.invalidateQueries({ queryKey: ['home-matches'] });
      void qc.invalidateQueries({ queryKey: ['home-activity'] });
      void qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
      void qc.invalidateQueries({ queryKey: ['downloads-library'] });
    }
    previousJobs.current = current;
  }, [jobs, qc]);
  const shownTasks = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'paused');
  const attentionJobs = jobs.filter(needsAttention);
  const failedDownloads = tasks.filter(downloadNeedsAttention);
  if (activeJobs.length === 0 && shownTasks.length === 0 && attentionJobs.length === 0 && failedDownloads.length === 0) return null;

  const onTaskAction = (op: 'pause' | 'resume' | 'cancel', id: number) => {
    if (op === 'pause') pause(id);
    else if (op === 'resume') resume(id);
    else cancel(id);
  };

  return (
    <div className="flex max-h-1/2 min-h-0 flex-col gap-3 overflow-y-auto border-t border-border p-3">
      <nav aria-label="Activity shortcuts" className="flex flex-col gap-1">
        {activeJobs.length > 0 && <button type="button" onClick={() => navigate('/jobs?filter=active')} className="flex items-center justify-between rounded-md px-2 py-2 text-left text-xs font-medium text-primary hover:bg-surface-2">Active tasks · {activeJobs.length}</button>}
        {attentionJobs.length > 0 && <button type="button" onClick={() => navigate('/jobs?filter=failed')} className="flex items-center justify-between rounded-md px-2 py-2 text-left text-xs font-medium text-danger hover:bg-surface-2">Needs attention · {attentionJobs.length}</button>}
        {failedDownloads.length > 0 && <button type="button" onClick={() => navigate('/downloader?tab=downloads&status=failed')} className="flex items-center justify-between rounded-md px-2 py-2 text-left text-xs font-medium text-danger hover:bg-surface-2">Failed downloads · {failedDownloads.length}</button>}
      </nav>
      {activeJobs.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Running & queued</span>
          {activeJobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}
      {shownTasks.length > 0 && (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => navigate('/downloader?tab=downloads&status=active')} title="Open active downloads" className="group flex items-center gap-1.5 text-left">
            {shownTasks.some((t) => t.status === 'downloading') ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" />
            ) : (
              <Download className="h-3.5 w-3.5 shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-muted group-hover:text-foreground">
              Downloads{shownTasks.length > 1 ? ` · ${shownTasks.length}` : ''}
            </span>
          </button>
          {shownTasks.slice(0, 6).map((task) => (
            <DownloadRow key={task.id} task={task} onAction={onTaskAction} />
          ))}
        </div>
      )}
    </div>
  );
}
