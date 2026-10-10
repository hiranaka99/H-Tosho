import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowDown, Ban, CheckCircle2, Circle, Copy, Download, ListChecks, RotateCcw, Search, Terminal, Trash2, XCircle } from 'lucide-react';
import { api, type Job, type JobLog } from '../lib/api';
import { Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle, EmptyState, ErrorState, Input, Label, PageHeader, ProgressBar, Select, Spinner, Disclosure } from '../components/ui';
import { cn, timeAgo, toIsoUtc, jobLabel } from '../lib/utils';
import { toast } from '../lib/toast';

type JobFilter = 'active' | 'failed' | 'done' | 'all';
type JobDetails = { job: Job; logs: JobLog[] };
const FILTERS: readonly { id: JobFilter; label: string }[] = [
  { id: 'all', label: 'All activity' },
  { id: 'active', label: 'Active' },
  { id: 'failed', label: 'Needs attention' },
  { id: 'done', label: 'Finished' },
];
const LOG_COLOR: Record<string, string> = { info: 'text-muted', warn: 'text-warning', warning: 'text-warning', error: 'text-danger', success: 'text-success' };
const controlClass = 'max-lg:min-h-11 pointer-coarse:min-h-11';

function isActive(job: Job): boolean {
  return job.status === 'running' || job.status === 'queued';
}

function hasWarnings(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return Object.entries(result).some(([key, value]) => {
    if (/^(warnings?|errors?|failed)$/i.test(key)) {
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
      return typeof value === 'number' ? value > 0 : Boolean(value);
    }
    return typeof value === 'object' && hasWarnings(value);
  });
}

function needsAttention(job: Job): boolean {
  return job.status === 'failed' || (job.status === 'completed' && hasWarnings(job.result));
}

function fieldLabel(key: string): string {
  return key.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function readableValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(readableValue).join('; ') || 'None';
  return Object.entries(value).map(([key, item]) => `${fieldLabel(key)}: ${readableValue(item)}`).join(' · ') || 'None';
}

function jobTarget(job: Job): string {
  const series = job.context?.series ?? [];
  if (series.length === 1) return series[0].name;
  if (series.length > 1) return `${series.length} series: ${series.slice(0, 3).map((item) => item.name).join(', ')}${series.length > 3 ? '…' : ''}`;
  if (job.context?.libraryName) return job.context.libraryName;
  const payload = job.payload;
  const name = payload.title ?? payload.name ?? payload.path ?? payload.targetDir ?? payload.target ?? payload.query;
  if (name !== undefined && name !== null) return readableValue(name);
  if (payload.seriesId !== undefined) return `Series #${payload.seriesId} · name not recorded`;
  if (Array.isArray(payload.seriesIds) && payload.seriesIds.length) return `${payload.seriesIds.length} series · names not recorded`;
  if (payload.libraryId !== undefined) return `Library #${payload.libraryId} · name not recorded`;
  return job.type === 'check-watched-searches' ? 'All watched searches' : 'All libraries';
}

const JOB_PURPOSE: Record<string, string> = {
  'scan-new': 'Refresh Kavita libraries and match newly discovered series',
  'match-unmatched': 'Find and apply metadata matches for unmatched series',
  'match-library': 'Find and apply metadata matches for every series in the library',
  'match-series': 'Find and apply metadata matches for the selected series',
  'sync-series': 'Re-match and update series metadata and covers',
  'apply-series': 'Apply the reviewed metadata candidate and selected fields',
  'clear-overrides': 'Remove library-specific settings overrides',
  'check-watched-searches': 'Check saved searches for new galleries',
  'edit-comicinfo': 'Rewrite ComicInfo.xml in the selected archive',
  'merge-series': 'Move archives into one series folder and update chapter metadata',
  'delete-series': 'Delete the series folder and request a Kavita rescan',
};

function jobOutcome(job: Job): string {
  if (job.status === 'queued') return 'Waiting to start. No work has been performed yet.';
  if (job.status === 'running') return job.progressTotal > 0 ? `${job.progressCurrent} of ${job.progressTotal} items processed so far.` : 'Work is in progress; no item count reported yet.';
  if (job.status === 'cancelled') return 'Cancelled. Work already performed is not undone.';
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return job.status === 'failed' ? 'Stopped with an error. Check logs for any work performed before the failure.' : 'Finished. No outcome summary was recorded; check the logs.';
  const result = job.result as Record<string, unknown>;
  const parts: string[] = [];
  if (job.type === 'check-watched-searches') {
    for (const [key, label] of [['processed', 'saved searches checked'], ['newGalleries', 'new galleries found'], ['notified', 'notifications sent']]) if (typeof result[key] === 'number') parts.push(`${result[key]} ${label}`);
  } else if (job.type === 'delete-series' && typeof result.deleted === 'number') {
    parts.push(`${result.deleted} archives deleted`);
  } else if (job.type === 'edit-comicinfo' && typeof result.processed === 'number') {
    parts.push(`ComicInfo.xml rewritten in ${result.processed} ${result.processed === 1 ? 'archive' : 'archives'}`);
  } else if (job.type === 'merge-series' && typeof result.processed === 'number') {
    parts.push(`${result.processed} archives moved into the destination series`);
    if (result.failed) parts.push(`${result.failed} archives could not be moved`);
  } else if (job.type === 'clear-overrides') {
    parts.push(result.cleared ? `${result.cleared} library overrides cleared` : 'Library settings overrides cleared');
  } else {
    for (const [key, label] of [['libraries', 'libraries scanned'], ['processed', 'series processed'], ['matched', 'metadata matches applied successfully'], ['failed', 'series needing attention'], ['pruned', 'stale series records removed']]) if (typeof result[key] === 'number' && (key !== 'failed' && key !== 'pruned' || result[key] > 0)) parts.push(`${result[key]} ${label}`);
  }
  if (Array.isArray(result.pushed) && result.pushed.length) parts.push(`Updated fields: ${result.pushed.map((field) => fieldLabel(String(field))).join(', ')}`);
  if (result.coverUpdated === true) parts.push('series cover updated');
  if (typeof result.volumeCoversUpdated === 'number' && result.volumeCoversUpdated > 0) parts.push(`${result.volumeCoversUpdated} volume covers updated`);
  if (typeof result.warnings === 'number' && result.warnings > 0) parts.push(`${result.warnings} warnings`);
  if (typeof result.titleFilesUpdated === 'number' && result.titleFilesUpdated > 0) parts.push(`${result.titleFilesUpdated} archive titles updated`);
  return parts.length ? `${parts.join(' · ')}.` : 'Finished. Open the recorded result for details.';
}

function duration(job: Job): string {
  if (!job.startedAt) return job.status === 'queued' ? 'Waiting to start' : 'Not started';
  const start = new Date(toIsoUtc(job.startedAt)).getTime();
  const end = job.finishedAt ? new Date(toIsoUtc(job.finishedAt)).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Duration unavailable';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const text = hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  return isActive(job) ? `${text} elapsed` : text;
}

function timestamp(value: string | null | undefined): string {
  return value ? new Date(toIsoUtc(value)).toLocaleString() : '—';
}

function JobStatus({ job }: { job: Job }) {
  if (job.status === 'running') return <Badge tone="info"><Activity className="h-3 w-3 animate-pulse-soft" /> Running</Badge>;
  if (job.status === 'queued') return <Badge tone="muted"><Circle className="h-3 w-3" /> Queued</Badge>;
  if (job.status === 'completed') return hasWarnings(job.result)
    ? <Badge tone="warning"><AlertTriangle className="h-3 w-3" /> Completed with warnings</Badge>
    : <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Completed</Badge>;
  if (job.status === 'cancelled') return <Badge tone="muted"><Ban className="h-3 w-3" /> Cancelled</Badge>;
  return <Badge tone="danger"><XCircle className="h-3 w-3" /> {fieldLabel(job.status)}</Badge>;
}

function RecoveryActions({ job }: { job: Job }) {
  if (!job.recovery) return null;
  return <div className="mt-3 space-y-2 rounded-md border border-border bg-surface/60 p-3">
    <p className="text-sm text-muted">{job.recovery.explanation}</p>
    <div className="flex flex-wrap gap-2">{job.recovery.actions.map(action => <Button asChild variant="outline" size="sm" className={controlClass} key={action.href}><Link to={action.href}>{action.label}</Link></Button>)}</div>
  </div>;
}

function StructuredValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="text-sm text-muted">None</p>;
  if (Array.isArray(value)) return value.length ? (
    <ul className="space-y-2">
      {value.map((item, index) => <li key={index} className="rounded-md border border-border p-2"><StructuredValue value={item} /></li>)}
    </ul>
  ) : <p className="text-sm text-muted">None</p>;
  if (typeof value === 'object') return Object.keys(value).length ? (
    <dl className="space-y-3">
      {Object.entries(value).map(([key, item]) => (
        <div key={key} className={cn('min-w-0', /warning|error/i.test(key) && 'rounded-md border border-warning/30 bg-warning/5 p-3')}>
          <dt className="mb-1 break-words text-xs font-medium text-muted">{fieldLabel(key)}</dt>
          <dd className="min-w-0"><StructuredValue value={item} /></dd>
        </div>
      ))}
    </dl>
  ) : <p className="text-sm text-muted">None</p>;
  return <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{readableValue(value)}</p>;
}

function LogConsole({ logs, jobId }: { logs: JobLog[]; jobId: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const nearBottom = React.useRef(true);
  const [follow, setFollow] = React.useState(true);
  const [severity, setSeverity] = React.useState('all');
  const visible = logs.filter((log) => severity === 'all' || (log.level === 'warning' ? 'warn' : log.level) === severity);
  const levels = Array.from(new Set(logs.map((log) => log.level === 'warning' ? 'warn' : log.level))).sort();
  const latestId = logs[logs.length - 1]?.id;
  const jumpToLatest = () => {
    nearBottom.current = true;
    setFollow(true);
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  React.useEffect(() => {
    const element = ref.current;
    if (element && follow && nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [latestId, severity, follow]);
  const logText = visible.map((log) => `${timestamp(log.createdAt)} [${log.level.toUpperCase()}] ${log.message}`).join('\n');
  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logText);
      toast({ tone: 'success', title: 'Logs copied' });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not copy logs', description: error instanceof Error ? error.message : String(error) });
    }
  };
  const downloadLogs = () => {
    const url = URL.createObjectURL(new Blob([logText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `job-${jobId}-logs.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="min-w-0 space-y-3" aria-label="Job logs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Terminal className="h-4 w-4" /> Logs <span className="text-xs font-normal text-muted">{visible.length} / {logs.length}</span></h3>
        <div className="flex flex-wrap gap-2">
          {navigator.clipboard && <Button variant="outline" size="sm" className={controlClass} disabled={!visible.length} onClick={() => void copyLogs()}><Copy className="h-4 w-4" /> Copy</Button>}
          <Button variant="outline" size="sm" className={controlClass} disabled={!visible.length} onClick={downloadLogs}><Download className="h-4 w-4" /> Download</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Label htmlFor={`severity-${jobId}`}>Severity</Label><Select id={`severity-${jobId}`} value={severity} onChange={(event) => setSeverity(event.target.value)} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-auto"><option value="all">All levels</option>{levels.map((level) => <option key={level} value={level}>{fieldLabel(level)}</option>)}</Select></div>
        <label className="flex max-lg:min-h-11 pointer-coarse:min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={follow} onChange={(event) => { if (event.target.checked) jumpToLatest(); else setFollow(false); }} className="h-4 w-4 accent-primary" /> Follow logs</label>
      </div>
      <div ref={ref} tabIndex={0} aria-label="Scrollable job log entries" onScroll={(event) => {
        const element = event.currentTarget;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
        if (!nearBottom.current) setFollow(false);
      }} className="h-72 overflow-y-auto overscroll-contain rounded-lg border border-border bg-background p-3 font-mono text-xs">
        {!visible.length ? <p className="text-muted">{logs.length ? 'No logs match this severity.' : 'No logs yet.'}</p> : visible.map((log) => (
          <div key={log.id} className="mb-2 min-w-0">
            <div className="mb-0.5 flex flex-wrap gap-x-2"><time className="text-muted/70" dateTime={toIsoUtc(log.createdAt)}>{new Date(toIsoUtc(log.createdAt)).toLocaleTimeString()}</time><span className={cn('uppercase', LOG_COLOR[log.level] ?? 'text-muted')}>{log.level}</span></div>
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{log.message}</p>
          </div>
        ))}
      </div>
      {!follow && <Button className={cn(controlClass, 'w-full')} variant="secondary" onClick={jumpToLatest}><ArrowDown className="h-4 w-4" /> Jump to latest and follow</Button>}
    </section>
  );
}

export function Jobs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = searchParams.get('filter');
  const filter: JobFilter = FILTERS.some((item) => item.id === rawFilter) ? rawFilter as JobFilter : 'all';
  const rawId = searchParams.get('job');
  const selectedId = rawId && /^\d+$/.test(rawId) && Number(rawId) > 0 && Number.isSafeInteger(Number(rawId)) ? Number(rawId) : null;
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('all');
  const [clearTarget, setClearTarget] = React.useState<number | 'all' | null>(null);
  const qc = useQueryClient();
  const jobsQuery = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 2500 });
  const jobs = jobsQuery.data ?? [];
  const previousStatuses = React.useRef<Map<number, string> | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  React.useEffect(() => {
    if (!jobsQuery.data) return;
    const previous = previousStatuses.current;
    const transitions = jobsQuery.data.filter((job) => previous?.has(job.id) && previous.get(job.id) !== job.status && ['completed', 'failed', 'cancelled'].includes(job.status));
    if (transitions.length) {
      setAnnouncement(transitions.map((job) => `Job #${job.id}, ${jobTarget(job)}, ${job.status === 'completed' && hasWarnings(job.result) ? 'completed with warnings' : job.status}.`).join(' '));
    }
    previousStatuses.current = new Map(jobsQuery.data.map((job) => [job.id, job.status]));
  }, [jobsQuery.data]);
  const selectedListJob = jobs.find((job) => job.id === selectedId);
  const detailQuery = useQuery<JobDetails>({
    queryKey: ['job', selectedId],
    queryFn: () => api.job(selectedId!),
    enabled: selectedId !== null,
    refetchInterval: (query) => {
      const job = query.state.data?.job ?? selectedListJob;
      return job ? isActive(job) ? 1500 : false : query.state.status === 'error' ? false : 1500;
    },
  });
  const selectedJob = detailQuery.data?.job ?? selectedListJob;
  const updateUrl = (updates: { filter?: JobFilter; job?: number | null }) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (updates.filter !== undefined) next.set('filter', updates.filter);
      if (updates.job !== undefined) {
        if (updates.job === null) next.delete('job');
        else next.set('job', String(updates.job));
      }
      return next;
    });
  };
  const cancelMutation = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: async (_, id) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job', id] })]);
      toast({ tone: 'success', title: 'Cancellation requested' });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not cancel job', description: error.message }),
  });
  const retryMutation = useMutation({
    mutationFn: api.retryJob,
    onSuccess: async (result, id) => {
      setSearch('');
      setType('all');
      updateUrl({ filter: 'active', job: result.id });
      await Promise.all([qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job', id] }), qc.invalidateQueries({ queryKey: ['job', result.id] })]);
      toast({ tone: 'success', title: `Retry queued as job #${result.id}` });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not retry job', description: error.message }),
  });
  const clearMutation = useMutation({
    mutationFn: (target: number | 'all') => target === 'all' ? api.clearFailedJobs() : api.removeFailedJob(target),
    onSuccess: async (result, target) => {
      setClearTarget(null);
      if (selectedId === target || (target === 'all' && selectedJob?.status === 'failed')) updateUrl({ job: null });
      await qc.cancelQueries({ queryKey: ['jobs'] });
      qc.setQueryData<Job[]>(['jobs'], (previous) => previous?.filter((job) => target === 'all' ? job.status !== 'failed' : job.id !== target));
      await Promise.all([qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job'] }), qc.invalidateQueries({ queryKey: ['logs'] })]);
      toast({ tone: 'success', title: result.removed === 1 ? 'Failed job cleared' : `${result.removed} failed jobs cleared` });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not clear failed jobs', description: error.message }),
  });
  const actions = (job: Job) => (
    <>
      {job.status === 'failed' && <>
        <Button className={controlClass} variant="outline" disabled={retryMutation.isPending || clearMutation.isPending} onClick={() => retryMutation.mutate(job.id)}>{retryMutation.isPending && retryMutation.variables === job.id ? <Spinner /> : <RotateCcw className="h-4 w-4" />}{retryMutation.isPending && retryMutation.variables === job.id ? 'Retrying…' : 'Retry job'}</Button>
        <Button className={controlClass} variant="outline" disabled={retryMutation.isPending || clearMutation.isPending} onClick={() => setClearTarget(job.id)}><Trash2 className="h-4 w-4" /> Clear job</Button>
      </>}
      {isActive(job) && <Button className={controlClass} variant="outline" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate(job.id)}>{cancelMutation.isPending && cancelMutation.variables === job.id ? <Spinner /> : <Ban className="h-4 w-4" />}{cancelMutation.isPending && cancelMutation.variables === job.id ? 'Cancelling…' : 'Cancel job'}</Button>}
    </>
  );
  const types = Array.from(new Set(jobs.map((job) => job.type))).sort();
  const query = search.trim().toLowerCase();
  const visibleJobs = jobs.filter((job) => {
    const matchesFilter = filter === 'all' || (filter === 'active' ? isActive(job) : filter === 'failed' ? needsAttention(job) : job.status === 'completed' || job.status === 'cancelled');
    return matchesFilter && (type === 'all' || job.type === type) && (!query || `${job.id} ${jobLabel(job.type, job.payload)} ${job.type} ${jobTarget(job)} ${job.context?.series.map((series) => series.name).join(' ') ?? ''} ${job.context?.libraryName ?? ''} ${JOB_PURPOSE[job.type] ?? ''} ${jobOutcome(job)} ${job.errorMessage ?? ''} ${readableValue(job.result)}`.toLowerCase().includes(query));
  }).sort((a, b) => {
    const priority = (job: Job) => job.status === 'running' ? 0 : job.status === 'queued' ? 1 : needsAttention(job) ? 2 : 3;
    return priority(a) - priority(b) || b.id - a.id;
  });
  const statusCounts: Record<JobFilter, number> = {
    all: jobs.length,
    active: jobs.filter(isActive).length,
    failed: jobs.filter(needsAttention).length,
    done: jobs.filter((job) => job.status === 'completed' || job.status === 'cancelled').length,
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      <PageHeader icon={<ListChecks className="h-5 w-5" />} title="Jobs" subtitle="Track active work, resolve failures, and inspect what happened.">
        {jobs.some((job) => job.status === 'failed') && <Button variant="outline" className={controlClass} disabled={clearMutation.isPending || retryMutation.isPending} onClick={() => setClearTarget('all')}><Trash2 className="h-4 w-4" /> Clear failed jobs</Button>}
      </PageHeader>
      <Card className="min-w-0">
        <div className="space-y-3 border-b border-border p-3 sm:p-4">
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[200px_1fr_200px]">
            <div className="space-y-1"><Label htmlFor="jobs-status">Status</Label><Select id="jobs-status" value={filter} onChange={(event) => updateUrl({ filter: event.target.value as JobFilter })} className={controlClass}>{FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label} ({jobsQuery.isPending || (jobsQuery.isError && !jobsQuery.data) ? '—' : statusCounts[item.id]})</option>)}</Select></div>
            <div className="space-y-1"><Label htmlFor="jobs-search">Search activity</Label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><Input id="jobs-search" type="search" placeholder="Job, target, result, or ID…" value={search} onChange={(event) => setSearch(event.target.value)} className="max-lg:min-h-11 pointer-coarse:min-h-11 pl-9" /></div></div>
            <Disclosure label={type === 'all' ? 'Job type' : `Job type: ${jobLabel(type)}`} className="sm:hidden"><div className="mt-2"><Select aria-label="Job type" value={type} onChange={(event) => setType(event.target.value)} className={controlClass}><option value="all">All job types</option>{types.map((value) => <option key={value} value={value}>{jobLabel(value)}</option>)}</Select></div></Disclosure>
            <div className="hidden space-y-1 sm:block"><Label htmlFor="jobs-type">Job type</Label><Select id="jobs-type" value={type} onChange={(event) => setType(event.target.value)} className={controlClass}><option value="all">All job types</option>{types.map((value) => <option key={value} value={value}>{jobLabel(value)}</option>)}</Select></div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><p>{visibleJobs.length} of {jobs.length} jobs</p>{filter !== 'all' && <Button variant="ghost" size="sm" className={controlClass} onClick={() => updateUrl({ filter: 'all' })}>View all history</Button>}</div>
        </div>
        <CardContent className="!p-0 divide-y divide-border">
          {jobsQuery.isError && <ErrorState title="Could not load activity" description={jobsQuery.error.message} onRetry={() => void jobsQuery.refetch()} />}
          {jobsQuery.isPending ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted" role="status"><Spinner /> Loading activity…</div> : !visibleJobs.length && !jobsQuery.isError ? <div><EmptyState icon={<ListChecks className="h-8 w-8" />} title={jobs.length ? 'No matching jobs' : 'No activity yet'} description={jobs.length ? 'Try another status, job type, or search.' : 'Scans, matching, and other background work appear here.'} />{jobs.length > 0 && <div className="flex justify-center"><Button variant="outline" className={controlClass} onClick={() => { setSearch(''); setType('all'); updateUrl({ filter: 'all' }); }}>Clear filters</Button></div>}</div> : visibleJobs.map((job) => (
            <article key={job.id} className={cn('min-w-0 px-3 py-3 sm:px-4', job.id === selectedId ? 'bg-primary/5' : job.status === 'failed' ? 'bg-danger/5' : undefined)}>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{jobTarget(job)}</h2>
                  <p className="mt-1 break-words text-xs text-muted">{jobLabel(job.type, job.payload)} · Job #{job.id}</p>
                  <p className="mt-2 text-sm text-muted">{JOB_PURPOSE[job.type] ?? jobLabel(job.type, job.payload)}</p>
                  <p className="mt-1 text-sm">{jobOutcome(job)}</p>
                  {job.context?.libraryName && job.context.series.length > 0 && <p className="mt-1 text-xs text-muted">Library: {job.context.libraryName}</p>}
                  {(job.context?.series.length ?? 0) > 1 && <Disclosure label={`Affected series (${job.context!.series.length})`} className="mt-1"><ul className="space-y-1 py-2 text-sm">{job.context!.series.map((series) => <li key={series.id} className="break-words">{series.name} <span className="text-xs text-muted">· #{series.id}</span></li>)}</ul></Disclosure>}
                </div>
                <JobStatus job={job} />
              </div>
              {isActive(job) && <div className="mt-2 flex items-center gap-3"><div className="min-w-0 flex-1"><ProgressBar value={job.progressCurrent} max={job.progressTotal} active /></div><p className="shrink-0 text-xs tabular-nums text-muted">{job.progressTotal > 0 ? `${job.progressCurrent} / ${job.progressTotal} · ${Math.min(100, Math.round(job.progressCurrent / job.progressTotal * 100))}%` : job.status === 'queued' ? 'Waiting for a worker' : 'Working…'}</p></div>}
              {job.errorMessage && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-danger [overflow-wrap:anywhere]">{job.errorMessage}</p>}
              {job.recovery && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"><p className="text-sm text-muted">{job.recovery.explanation}</p>{job.recovery.actions.map((action) => <Button asChild variant="ghost" size="sm" className={controlClass} key={action.href}><Link to={action.href}>{action.label}</Link></Button>)}</div>}
              {job.result !== null && job.result !== undefined && <Disclosure label="Recorded result" className="mt-2 text-sm"><p className="mt-1 break-words text-sm text-muted [overflow-wrap:anywhere]">{readableValue(job.result)}</p></Disclosure>}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted"><time dateTime={toIsoUtc(job.createdAt)} title={timestamp(job.createdAt)}>{timeAgo(job.createdAt)}</time> · {duration(job)}</p><div className="flex flex-wrap gap-2">{actions(job)}<Button variant="ghost" className={controlClass} aria-label={`View details for job #${job.id}: ${jobTarget(job)}`} onClick={() => updateUrl({ job: job.id })}>View details</Button></div></div>
            </article>
          ))}
        </CardContent>
      </Card>
      <Dialog open={selectedId !== null} onOpenChange={(open) => { if (!open) updateUrl({ job: null }); }}>
        <DialogContent className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 !animate-none !rounded-none border-y-0 border-r-0 sm:!w-full lg:!w-[min(640px,55vw)]">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="shrink-0 border-b border-border p-4 pr-16 sm:p-5 sm:pr-16"><DialogTitle>{selectedJob ? jobLabel(selectedJob.type, selectedJob.payload) : 'Job details'}</DialogTitle><DialogDescription className="mt-1 break-words">Job #{selectedId}{selectedJob ? ` · ${selectedJob.type}` : ''}</DialogDescription>{selectedJob && <div className="mt-3"><JobStatus job={selectedJob} /></div>}</div>
            <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 sm:p-5">
              {detailQuery.isError && <ErrorState title="Could not load job details" description={detailQuery.error.message} onRetry={() => void detailQuery.refetch()} />}
              {detailQuery.isPending && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading job details…</div>}
              {selectedJob && <>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">What this job does</h3>
                  <p className="text-sm text-muted">{JOB_PURPOSE[selectedJob.type] ?? jobLabel(selectedJob.type, selectedJob.payload)}</p>
                  <p className="text-sm">{jobOutcome(selectedJob)}</p>
                  {selectedJob.type === 'apply-series' && typeof selectedJob.payload.selectedTitle === 'string' && <p className="text-sm">Selected title: {selectedJob.payload.selectedTitle}</p>}
                  {selectedJob.context?.libraryName && <p className="text-sm">Library: {selectedJob.context.libraryName}</p>}
                  {(selectedJob.context?.series.length ?? 0) > 0 && <ul className="space-y-1 text-sm">{selectedJob.context!.series.map((series) => <li key={series.id} className="break-words">{series.name} <span className="text-xs text-muted">· Series #{series.id}</span></li>)}</ul>}
                </section>
                <section className="space-y-3"><h3 className="text-sm font-semibold">Target & progress</h3><p className="break-words text-sm [overflow-wrap:anywhere]">{jobTarget(selectedJob)}</p><ProgressBar value={selectedJob.progressCurrent} max={selectedJob.progressTotal} active={isActive(selectedJob)} /><p className="text-xs text-muted">{selectedJob.progressTotal > 0 ? `${selectedJob.progressCurrent} of ${selectedJob.progressTotal}` : isActive(selectedJob) ? 'Progress not yet reported' : 'No item count reported'} · {duration(selectedJob)}</p><dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">{[['Created', selectedJob.createdAt], ['Started', selectedJob.startedAt], ['Finished', selectedJob.finishedAt]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 break-words">{timestamp(value)}</dd></div>)}</dl><div className="flex flex-wrap gap-2">{actions(selectedJob)}</div></section>
                {selectedJob.errorMessage && <section role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3"><h3 className="mb-2 text-sm font-semibold text-danger">Failure</h3><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{selectedJob.errorMessage}</p></section>}
                <RecoveryActions job={selectedJob} />
                <section className="space-y-3"><h3 className="text-sm font-semibold">Result</h3>{selectedJob.result === null || selectedJob.result === undefined ? <p className="text-sm text-muted">{isActive(selectedJob) ? 'Results will appear when this job finishes.' : 'No result was reported.'}</p> : <StructuredValue value={selectedJob.result} />}</section>
                <Disclosure label={`Payload context · ${Object.keys(selectedJob.payload).length} fields`} className="rounded-lg border border-border"><div className="border-t border-border p-3"><StructuredValue value={selectedJob.payload} /></div></Disclosure>
              </>}
              {detailQuery.data && <LogConsole key={selectedId} jobId={selectedId!} logs={detailQuery.data.logs} />}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={clearTarget !== null}
        title={clearTarget === 'all' ? 'Clear all failed jobs?' : `Clear failed job #${clearTarget}?`}
        description={clearTarget === 'all'
          ? 'Permanently remove all failed jobs and their logs, including those outside the current filters or loaded history. Active, completed, and cancelled jobs are kept. This cannot be undone.'
          : 'Permanently remove this failed job and its logs from history. This does not change your library or files and cannot be undone.'}
        confirmLabel={clearMutation.isPending ? 'Clearing…' : clearTarget === 'all' ? 'Clear failed jobs' : 'Clear job'}
        danger
        pending={clearMutation.isPending}
        onOpenChange={(open) => { if (!open && !clearMutation.isPending) setClearTarget(null); }}
        onConfirm={() => { if (clearTarget !== null) clearMutation.mutate(clearTarget); }}
      />
    </div>
  );
}
