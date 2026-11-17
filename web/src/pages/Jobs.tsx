import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
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
    if (/^(warnings?|errors?|failed|notificationFailed|notificationUnknown|unknown)$/i.test(key)) {
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
  if (series.length > 1) return `${job.context?.libraryName ? `${job.context.libraryName} · ` : ''}${series.length} series`;
  if (job.context?.libraryName) return job.context.libraryName;
  const payload = job.payload;
  if (job.type === 'scan-downloaded' && typeof payload.seriesName === 'string') return payload.seriesName;
  const name = payload.title ?? payload.name ?? payload.path ?? payload.targetDir ?? payload.target ?? payload.query;
  if (name !== undefined && name !== null) return readableValue(name);
  if (payload.seriesId !== undefined) return `Series #${payload.seriesId} · name not recorded`;
  if (Array.isArray(payload.seriesIds) && payload.seriesIds.length) return `${payload.seriesIds.length} series · names not recorded`;
  if (payload.libraryId !== undefined) return `Library #${payload.libraryId} · name not recorded`;
  return job.type === 'check-watched-searches' ? 'All watched searches' : 'All libraries';
}

function jobSeries(job: Job): { id: number; name: string }[] {
  const targets = job.context?.series ?? [];
  const ids = [job.payload.seriesId, ...(Array.isArray(job.payload.seriesIds) ? job.payload.seriesIds : [])];
  const series = new Map(targets.map((target) => [target.id, target]));
  for (const id of ids) {
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && !series.has(id)) {
      series.set(id, { id, name: `Series #${id}` });
    }
  }
  return [...series.values()];
}

/** Reuse Kavita's authenticated image proxy; polling never remounts images. */
function SeriesCover({ series, version, className }: { series?: { id: number; name: string }; version: string; className?: string }) {
  const src = series ? `/api/kavita/series/${series.id}/cover?v=${encodeURIComponent(version)}` : undefined;
  const [failedSrc, setFailedSrc] = React.useState<string>();
  return (
    <div aria-hidden="true" className={cn('aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-md bg-surface-2 sm:w-24', className)}>
      {src && failedSrc !== src ? (
        <img src={src} alt="" width={96} height={128} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailedSrc(src)} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-semibold text-muted">
          {series ? series.name.charAt(0).toUpperCase() : <ListChecks className="h-5 w-5" />}
        </div>
      )}
    </div>
  );
}

function JobCover({ job, className }: { job: Job; className?: string }) {
  const series = jobSeries(job);
  return (
    <div className="relative shrink-0" title={series.length > 1 ? `${series.length} affected series` : series[0]?.name}>
      <SeriesCover series={series[0]} version={job.finishedAt ?? job.startedAt ?? job.createdAt} className={className} />
      {series.length > 1 && <span aria-hidden="true" className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-2xs font-medium tabular-nums text-white">+{series.length - 1}</span>}
    </div>
  );
}

function AffectedSeries({ job }: { job: Job }) {
  const series = jobSeries(job);
  if (!series.length) return null;
  return (
    <ul className="space-y-2 py-2 text-sm">
      {series.map((target) => (
        <li key={target.id} className="flex min-w-0 items-center gap-2">
          <SeriesCover series={target} version={job.finishedAt ?? job.startedAt ?? job.createdAt} className="w-10 rounded sm:w-12" />
          <span className="min-w-0 break-words">{target.name} <span className="text-xs text-muted">· Series #{target.id}</span></span>
        </li>
      ))}
    </ul>
  );
}

const JOB_PURPOSE: Record<string, string> = {
  'scan-matchable': 'Find metadata candidates for unmatched galleries to review on Home',
  'scan-downloaded': 'Import the completed download into Kavita and find metadata candidates to review on Home',
  'scan-new': 'Refresh Kavita libraries and match newly discovered series',
  'match-unmatched': 'Find and apply metadata matches for unmatched series',
  'match-library': 'Find and apply metadata matches for every series in the library',
  'match-series': 'Find and apply metadata matches for the selected series',
  'sync-series': 'Re-match and update series metadata and covers',
  'apply-series': 'Apply the reviewed metadata candidate and selected fields',
    'restore-metadata': 'Restore the reviewed historical metadata and selected ComicInfo values',
  'clear-overrides': 'Remove library-specific settings overrides',
  'check-watched-searches': 'Check saved searches for new galleries',
  'edit-comicinfo': 'Rewrite ComicInfo.xml in the selected archive',
  'merge-series': 'Move archives into one series folder and update chapter metadata',
  'delete-series': 'Delete the series folder and request a Kavita rescan',
};

function jobOutcome(job: Job): string {
  if (job.type === 'restore-metadata' && job.status === 'failed') return 'Review required. Inspect metadata history for observed changes, then create and review a fresh restore preview. This task cannot be retried directly.';
  if (job.type === 'restore-metadata' && job.status === 'cancelled') return 'Restore cancelled. A write may already have occurred; inspect the linked metadata history before creating a new preview.';
  if (job.status === 'queued') return 'Waiting to start. No work has been performed yet.';
  if (job.status === 'running') return job.progressTotal > 0 ? `${job.progressCurrent} of ${job.progressTotal} items processed so far.` : 'Work is in progress; no item count reported yet.';
  if (job.status === 'cancelled') return 'Cancelled. Work already performed is not undone.';
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return job.status === 'failed' ? 'Stopped with an error. Check logs for any work performed before the failure.' : 'Finished. No outcome summary was recorded; check the logs.';
  const result = job.result as Record<string, unknown>;
  const parts: string[] = [];
  if (job.type === 'restore-metadata') {
    if (Array.isArray(result.restored) && result.restored.length) parts.push(`Verified restored fields: ${result.restored.map(field => fieldLabel(String(field))).join(', ')}`);
    if (typeof result.restoredArchives === 'number' && result.restoredArchives > 0) parts.push(`ComicInfo.xml verified in ${result.restoredArchives} ${result.restoredArchives === 1 ? 'archive' : 'archives'}`);
    if (typeof result.restoredCovers === 'number' && result.restoredCovers > 0) parts.push(`${result.restoredCovers} ${result.restoredCovers === 1 ? 'cover restored' : 'covers restored'} through Kavita's supported API with reviewed resize/re-encoding`);
    if (typeof result.unverifiedCoverLocks === 'number' && result.unverifiedCoverLocks > 0) parts.push(`Native lock readback unavailable for ${result.unverifiedCoverLocks} ${result.unverifiedCoverLocks === 1 ? 'cover' : 'covers'}; the explicitly reviewed lock choice was submitted, not verified`);
    return `${parts.length ? parts.join('. ') : 'Restore completed'}. Inspect linked history for metadata and archive results.`;
  }
  if (job.type === 'scan-matchable' || job.type === 'scan-downloaded') {
    for (const [key, label] of [['processed', 'galleries checked'], ['matchable', 'galleries with candidates'], ['failed', 'galleries with provider errors']]) if (typeof result[key] === 'number') parts.push(`${result[key]} ${label}`);
  } else if (job.type === 'check-watched-searches') {
    for (const [key, label] of [['processed', 'saved searches checked'], ['newGalleries', 'new galleries found'], ['failed', 'provider checks failed'], ['notified', 'Discord notifications sent'], ['notificationFailed', 'Discord sends failed'], ['notificationUnknown', 'Discord sends unconfirmed'], ['notificationIntents', 'notification contributions committed']]) if (typeof result[key] === 'number') parts.push(`${result[key]} ${label}`);
    const archived = result.notificationDeliveryHistory;
    if (archived && typeof archived === 'object' && !Array.isArray(archived)) {
      const history = archived as Record<string, number>;
      parts.push(`Archived notification outcomes: ${history.delivered ?? 0} acknowledged · ${history.pending ?? 0} previously pending · ${(history.failed ?? 0) + (history.unknown ?? 0)} delivery issues`);
    }
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

/** Only surface outcomes that add something beyond the action and status. */
function jobSummary(job: Job): string | null {
  if (job.status === 'failed') return job.recovery?.explanation ?? job.errorMessage?.split('\n')[0] ?? 'Open details for the error.';
  if (job.status !== 'completed' || !job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return null;
  const result = job.result as Record<string, unknown>;
  if (job.type === 'restore-metadata') {
    const restored=Array.isArray(result.restored)?result.restored.map(field=>fieldLabel(String(field))):[];
    if(typeof result.restoredArchives==='number' && result.restoredArchives>0)restored.push(`${result.restoredArchives} ${result.restoredArchives===1?'archive':'archives'}`);
    if (typeof result.restoredCovers === 'number' && result.restoredCovers > 0) restored.push(`${result.restoredCovers} ${result.restoredCovers === 1 ? 'cover' : 'covers'} (API resize/re-encoding)`);
    if (typeof result.unverifiedCoverLocks === 'number' && result.unverifiedCoverLocks > 0) restored.push(`native lock readback unavailable for ${result.unverifiedCoverLocks}`);
    return restored.length?`Restored: ${restored.join(', ')}`:'Restore completed; inspect history';
  }
  if (job.type === 'check-watched-searches' && typeof result.newGalleries === 'number') {
    return result.newGalleries ? `${result.newGalleries} new ${result.newGalleries === 1 ? 'gallery' : 'galleries'}` : 'No new galleries';
  }
  if (job.type === 'delete-series' && typeof result.deleted === 'number') return `${result.deleted} ${result.deleted === 1 ? 'archive' : 'archives'} deleted`;
  if (job.type === 'merge-series' && typeof result.processed === 'number') {
    return `${result.processed} ${result.processed === 1 ? 'archive' : 'archives'} merged${typeof result.failed === 'number' && result.failed > 0 ? ` · ${result.failed} failed` : ''}`;
  }
  const parts: string[] = [];
  const batch = jobSeries(job).length > 1 || (typeof result.processed === 'number' && result.processed > 1);
  if (batch && typeof result.matched === 'number') parts.push(`${result.matched} matched`);
  if (typeof result.failed === 'number' && result.failed > 0) parts.push(`${result.failed} failed`);
  if (!parts.length && batch && typeof result.processed === 'number') parts.push(`${result.processed} processed`);
  return parts.length ? parts.join(' · ') : null;
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
      <div ref={ref} tabIndex={0} aria-label="Scrollable task log entries" onScroll={(event) => {
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
      setAnnouncement(transitions.map((job) => `Task #${job.id}, ${jobTarget(job)}, ${job.status === 'completed' && hasWarnings(job.result) ? 'completed with warnings' : job.status}.`).join(' '));
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
      return job ? isActive(job) || job.type === 'check-watched-searches' ? 1500 : false : query.state.status === 'error' ? false : 1500;
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
    onError: (error) => toast({ tone: 'danger', title: 'Could not cancel task', description: error.message }),
  });
  const retryMutation = useMutation({
    mutationFn: api.retryJob,
    onSuccess: async (result, id) => {
      setSearch('');
      setType('all');
      updateUrl({ filter: 'active', job: result.id });
      await Promise.all([qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job', id] }), qc.invalidateQueries({ queryKey: ['job', result.id] })]);
      toast({ tone: 'success', title: `Retry queued as task #${result.id}` });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not retry task', description: error.message }),
  });
  const clearMutation = useMutation({
    mutationFn: (target: number | 'all') => target === 'all' ? api.clearFailedJobs() : api.removeFailedJob(target),
    onSuccess: async (result, target) => {
      setClearTarget(null);
      if (selectedId === target || (target === 'all' && selectedJob?.status === 'failed')) updateUrl({ job: null });
      await qc.cancelQueries({ queryKey: ['jobs'] });
      qc.setQueryData<Job[]>(['jobs'], (previous) => previous?.filter((job) => target === 'all' ? job.status !== 'failed' : job.id !== target));
      await Promise.all([qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job'] }), qc.invalidateQueries({ queryKey: ['logs'] })]);
      toast({ tone: 'success', title: result.removed === 1 ? 'Failed task cleared' : `${result.removed} failed tasks cleared` });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not clear failed tasks', description: error.message }),
  });
  const actions = (job: Job, compact = false) => (
    <>
      {job.status === 'failed' && <>
        {job.type !== 'restore-metadata' && <Button className={controlClass} size={compact ? 'sm' : 'default'} variant="outline" disabled={retryMutation.isPending || clearMutation.isPending} onClick={() => retryMutation.mutate(job.id)}>{retryMutation.isPending && retryMutation.variables === job.id ? <Spinner /> : <RotateCcw className="h-4 w-4" />}{retryMutation.isPending && retryMutation.variables === job.id ? 'Retrying…' : compact ? 'Retry' : 'Retry task'}</Button>}
        {!compact && <Button className={controlClass} variant="outline" disabled={retryMutation.isPending || clearMutation.isPending} onClick={() => setClearTarget(job.id)}><Trash2 className="h-4 w-4" /> Clear task</Button>}
      </>}
      {isActive(job) && <Button className={controlClass} size={compact ? 'sm' : 'default'} variant="outline" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate(job.id)}>{cancelMutation.isPending && cancelMutation.variables === job.id ? <Spinner /> : <Ban className="h-4 w-4" />}{cancelMutation.isPending && cancelMutation.variables === job.id ? 'Cancelling…' : compact ? 'Cancel' : 'Cancel task'}</Button>}
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
      <PageHeader icon={<ListChecks className="h-5 w-5" />} title="Tasks" subtitle="Background work and recent results.">
        {jobs.some((job) => job.status === 'failed') && <Button variant="outline" className={controlClass} disabled={clearMutation.isPending || retryMutation.isPending} onClick={() => setClearTarget('all')}><Trash2 className="h-4 w-4" /> Clear failed tasks</Button>}
      </PageHeader>
      <Card className="min-w-0">
        <div className="space-y-3 border-b border-border p-3 sm:p-4">
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div className="space-y-1"><Label htmlFor="jobs-status">Status</Label><Select id="jobs-status" value={filter} onChange={(event) => updateUrl({ filter: event.target.value as JobFilter })} className={controlClass}>{FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label} ({jobsQuery.isPending || (jobsQuery.isError && !jobsQuery.data) ? '—' : statusCounts[item.id]})</option>)}</Select></div>
            <div className="space-y-1"><Label htmlFor="jobs-search">Search activity</Label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><Input id="jobs-search" type="search" placeholder="Task, target, result, or ID…" value={search} onChange={(event) => setSearch(event.target.value)} className="max-lg:min-h-11 pointer-coarse:min-h-11 pl-9" /></div></div>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-2 text-xs text-muted">
            <p className="py-2">{visibleJobs.length} of {jobs.length} tasks</p>
            <Disclosure label={type === 'all' ? 'Task type' : `Task type: ${jobLabel(type)}`} className="max-w-full" summaryClassName="px-0 text-xs">
              <div className="pb-1 pt-2"><Select aria-label="Task type" value={type} onChange={(event) => setType(event.target.value)} className={cn(controlClass, 'w-full sm:w-48')}><option value="all">All task types</option>{types.map((value) => <option key={value} value={value}>{jobLabel(value)}</option>)}</Select></div>
            </Disclosure>
          </div>
        </div>
        <CardContent className="!p-0 divide-y divide-border">
          {jobsQuery.isError && <ErrorState title="Could not load activity" description={jobsQuery.error.message} onRetry={() => void jobsQuery.refetch()} />}
          {jobsQuery.isPending ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted" role="status"><Spinner /> Loading activity…</div> : !visibleJobs.length && !jobsQuery.isError ? <div><EmptyState icon={<ListChecks className="h-8 w-8" />} title={jobs.length ? 'No matching tasks' : 'No activity yet'} description={jobs.length ? 'Try another status, task type, or search.' : 'Scans, matching, and other background work appear here.'} />{jobs.length > 0 && <div className="flex justify-center"><Button variant="outline" className={controlClass} onClick={() => { setSearch(''); setType('all'); updateUrl({ filter: 'all' }); }}>Clear filters</Button></div>}</div> : visibleJobs.map((job) => (
            <article key={job.id} className={cn('min-w-0 px-3 py-3 sm:px-4', job.id === selectedId ? 'bg-primary/5' : job.status === 'failed' ? 'bg-danger/5' : undefined)}>
              <div className="flex min-w-0 items-start gap-3">
                <JobCover job={job} />
                <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{jobTarget(job)}</h2>
                      <p className="mt-1 break-words text-xs text-muted">
                        {jobLabel(job.type, job.payload)} · <time dateTime={toIsoUtc(job.createdAt)} title={timestamp(job.createdAt)}>{timeAgo(job.createdAt)}</time>{job.startedAt && <> · {duration(job)}</>}
                      </p>
                      {jobSummary(job) && <p className={cn('mt-1 text-sm', job.status === 'failed' ? 'line-clamp-2 text-danger' : 'text-muted')} title={job.status === 'failed' ? job.errorMessage ?? undefined : undefined}>{jobSummary(job)}</p>}
                      {job.status === 'running' && <div className="mt-2 flex items-center gap-2"><ProgressBar value={job.progressCurrent} max={job.progressTotal} active label={`Progress for ${jobTarget(job)}`} className="max-w-xs" />{job.progressTotal > 0 && <span className="shrink-0 text-xs tabular-nums text-muted">{job.progressCurrent} / {job.progressTotal}</span>}</div>}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
                      <JobStatus job={job} />
                      {actions(job, true)}
                      <Button variant="ghost" size="sm" className={controlClass} aria-label={`View details for task #${job.id}: ${jobTarget(job)}`} onClick={() => updateUrl({ job: job.id })}>Details</Button>
                    </div>
                </div>
              </div>
            </article>
          ))}
        </CardContent>
      </Card>
      <Dialog open={selectedId !== null} onOpenChange={(open) => { if (!open) updateUrl({ job: null }); }}>
        <DialogContent className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 !animate-none !rounded-none border-y-0 border-r-0 sm:!w-full lg:!w-[min(640px,55vw)]">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="flex shrink-0 items-start gap-3 border-b border-border p-4 pr-16 sm:p-5 sm:pr-16">
              {selectedJob && <JobCover job={selectedJob} className="w-20 sm:w-28" />}
              <div className="min-w-0 flex-1">
                <DialogTitle>{selectedJob ? jobTarget(selectedJob) : 'Task details'}</DialogTitle>
                <DialogDescription className="mt-1 break-words">{selectedJob ? `${jobLabel(selectedJob.type, selectedJob.payload)} · ` : ''}Task #{selectedId}</DialogDescription>
                {selectedJob && <div className="mt-3"><JobStatus job={selectedJob} /></div>}
              </div>
            </div>
            <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 sm:p-5">
              {detailQuery.isError && <ErrorState title="Could not load task details" description={detailQuery.error.message} onRetry={() => void detailQuery.refetch()} />}
              {detailQuery.isPending && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading task details…</div>}
              {selectedJob && <>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Summary</h3>
                  <p className="text-sm">{jobOutcome(selectedJob)}</p>
                  {selectedJob.type === 'apply-series' && typeof selectedJob.payload.selectedTitle === 'string' && <p className="text-sm">Selected title: {selectedJob.payload.selectedTitle}</p>}
                  {selectedJob.context?.libraryName && <p className="text-sm">Library: {selectedJob.context.libraryName}</p>}
                  {jobSeries(selectedJob).length > 1 && <Disclosure label={`Affected series (${jobSeries(selectedJob).length})`} summaryClassName="px-0"><AffectedSeries job={selectedJob} /></Disclosure>}
                </section>
                {isActive(selectedJob) && <section className="space-y-2" aria-label="Task progress"><ProgressBar value={selectedJob.progressCurrent} max={selectedJob.progressTotal} active /><p className="text-xs text-muted">{duration(selectedJob)}</p></section>}
                {(isActive(selectedJob) || selectedJob.status === 'failed') && <div className="flex flex-wrap gap-2">{actions(selectedJob)}</div>}
                {selectedJob.errorMessage && <section role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3"><h3 className="mb-2 text-sm font-semibold text-danger">Failure</h3><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{selectedJob.errorMessage}</p></section>}
                <RecoveryActions job={selectedJob} />
                {selectedJob.type === 'restore-metadata' && typeof selectedJob.payload.seriesId === 'number' && <section className="space-y-2"><h3 className="text-sm font-semibold">Metadata history</h3><p className="text-sm text-muted">Inspect the observed before-and-after values. Failed or interrupted restores require a fresh reviewed preview, never a blind retry.</p><Button asChild variant="outline" className="min-h-11"><Link to={`/libraries?series=${selectedJob.payload.seriesId}&action=identify`}>Open series metadata history</Link></Button></section>}
                {selectedJob.result !== null && selectedJob.result !== undefined && <Disclosure label="Recorded result" summaryClassName="px-0"><div className="pt-3"><StructuredValue value={selectedJob.result} /></div></Disclosure>}
                <Disclosure label="Timing" summaryClassName="px-0"><p className="mt-2 text-sm">{duration(selectedJob)}</p><dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">{[['Created', selectedJob.createdAt], ['Started', selectedJob.startedAt], ['Finished', selectedJob.finishedAt]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 break-words">{timestamp(value)}</dd></div>)}</dl></Disclosure>
                <Disclosure label="Technical details" summaryClassName="px-0"><p className="py-3 font-mono text-xs text-muted">{selectedJob.type} · Task #{selectedJob.id}</p><StructuredValue value={selectedJob.payload} /></Disclosure>
              </>}
              {detailQuery.data && <Disclosure key={selectedId} label={`Logs (${detailQuery.data.logs.length})`} open={selectedJob?.status === 'failed'} summaryClassName="px-0"><div className="pt-3"><LogConsole jobId={selectedId!} logs={detailQuery.data.logs} /></div></Disclosure>}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={clearTarget !== null}
        title={clearTarget === 'all' ? 'Clear all failed tasks?' : `Clear failed task #${clearTarget}?`}
        description={clearTarget === 'all'
          ? 'Permanently remove all failed tasks and their logs, including those outside the current filters or loaded history. Active, completed, and cancelled tasks are kept. This cannot be undone.'
          : 'Permanently remove this failed task and its logs from history. This does not change your library or files and cannot be undone.'}
        confirmLabel={clearMutation.isPending ? 'Clearing…' : clearTarget === 'all' ? 'Clear failed tasks' : 'Clear task'}
        danger
        pending={clearMutation.isPending}
        onOpenChange={(open) => { if (!open && !clearMutation.isPending) setClearTarget(null); }}
        onConfirm={() => { if (clearTarget !== null) clearMutation.mutate(clearTarget); }}
      />
    </div>
  );
}
