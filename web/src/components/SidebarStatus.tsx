import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Clock, Download, Pause, Play, XCircle, Ban } from 'lucide-react';
import { api, type Job, type DownloadTask } from '../lib/api';
import { useDownloads } from '../lib/DownloadsContext';
import { formatBytes, formatSpeed } from '../lib/format';
import { ProgressBar } from './ui';

const JOB_LABEL: Record<string, string> = {
  'scan-new': 'Scan new series',
  'match-unmatched': 'Match unmatched',
  'match-library': 'Match library',
  'match-series': 'Match series',
  'sync-series': 'Sync series',
  'clear-overrides': 'Clear overrides',
};

function jobLabel(job: Job): string {
  return JOB_LABEL[job.type] ?? job.type;
}

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
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={jobLabel(job)}>
          {jobLabel(job)}
        </span>
        {running && (
          <button
            onClick={() => void api.cancelJob(job.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] }))}
            title="Cancel job"
            className="shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-danger"
          >
            <Ban className="h-3 w-3" />
          </button>
        )}
      </div>
      {running &&
        (job.progressTotal > 0 ? (
          <>
            <ProgressBar value={job.progressCurrent} max={job.progressTotal} className="h-1.5" />
            <span className="text-[10px] leading-none text-muted">
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
  return <Pause className="h-3.5 w-3.5 shrink-0 text-warning" />; // paused
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
          <button onClick={() => onAction('pause', task.id)} title="Pause" className="shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground">
            <Pause className="h-3 w-3" />
          </button>
        )}
        {task.status === 'paused' && (
          <button onClick={() => onAction('resume', task.id)} title="Resume" className="shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground">
            <Play className="h-3 w-3" />
          </button>
        )}
        {(busy || task.status === 'queued') && (
          <button onClick={() => onAction('cancel', task.id)} title="Cancel" className="shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-danger">
            <XCircle className="h-3 w-3" />
          </button>
        )}
      </div>
      {busy && (
        <>
          <ProgressBar value={task.progressCurrent} max={task.progressTotal} className="h-1.5" />
          <span className="text-[10px] leading-none text-muted">
            {pct !== null ? `${pct}%` : ''}
            {typeof task.bytesCurrent === 'number' && (task.bytesCurrent > 0 || (task.bytesTotal ?? 0) > 0) && ` · ${formatBytes(task.bytesCurrent)}`}
            {formatSpeed(task.speed) && ` · ${formatSpeed(task.speed)}`}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Sidebar footer tracker. Shows live progress for active background jobs
 * (scan/match/sync) and downloads on every page. Jobs share the ['jobs'] query
 * with the Jobs page; downloads come from the app-wide DownloadsContext.
 */
export function SidebarStatus() {
  const navigate = useNavigate();
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 2500 });
  const { tasks, pause, resume, cancel } = useDownloads();

  const activeJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  // Paused tasks are excluded from the context's `active` list; include them here so
  // a paused download stays visible with its resume control.
  const shownTasks = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'paused');
  if (activeJobs.length === 0 && shownTasks.length === 0) return null;

  // Aggregate download progress across non-paused tasks (page-based, falls back to bytes).
  const running = shownTasks.filter((t) => t.status !== 'paused');
  const pageTotal = running.reduce((s, t) => s + (t.progressTotal || 0), 0);
  const pageDone = running.reduce((s, t) => s + (t.progressCurrent || 0), 0);
  const byteTotal = running.reduce((s, t) => s + (t.bytesTotal || 0), 0);
  const byteDone = running.reduce((s, t) => s + (t.bytesCurrent || 0), 0);
  const aggregatePct = pageTotal > 0 ? Math.round((pageDone / pageTotal) * 100) : byteTotal > 0 ? Math.round((byteDone / byteTotal) * 100) : null;
  const downloadingCount = running.filter((t) => t.status === 'downloading').length;

  const onTaskAction = (op: 'pause' | 'resume' | 'cancel', id: number) => {
    if (op === 'pause') pause(id);
    else if (op === 'resume') resume(id);
    else cancel(id);
  };

  return (
    <div className="flex max-h-1/2 min-h-0 flex-col gap-3 overflow-y-auto border-t border-border p-3">
      {activeJobs.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Jobs</span>
          {activeJobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}

      {shownTasks.length > 0 && (
        <div className="flex flex-col gap-2">
          <button onClick={() => navigate('/downloader')} title="Open downloader" className="group flex items-center gap-1.5 text-left">
            {downloadingCount > 0 ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" />
            ) : (
              <Download className="h-3.5 w-3.5 shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wide text-muted group-hover:text-foreground">
              Downloads{shownTasks.length > 1 ? ` · ${shownTasks.length}` : ''}
            </span>
            {aggregatePct !== null && <span className="shrink-0 text-[10px] text-muted">{aggregatePct}%</span>}
          </button>
          {aggregatePct !== null && <ProgressBar value={aggregatePct} max={100} className="h-1.5" />}
          {shownTasks.slice(0, 6).map((t) => (
            <DownloadRow key={t.id} task={t} onAction={onTaskAction} />
          ))}
        </div>
      )}
    </div>
  );
}
