import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { Activity, AlertTriangle, ArrowDown, Ban, CheckCheck, CheckCircle2, Circle, Copy, Download, Eye, FilePen, ListChecks, Merge, RefreshCw, RotateCcw, ScanLine, Search, SlidersHorizontal, Trash2, X, XCircle, type LucideIcon } from 'lucide-react';
import { api, type Job, type JobLog } from '../lib/api';
import { Badge, Button, Card, CardContent, EmptyState, ErrorState, InlineConfirm, Input, Label, PageHeader, ProgressBar, SegmentedTabs, Select, Skeleton, Spinner, Disclosure } from '../components/ui';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/dialog';
import { cn, timeAgo, toIsoUtc, jobLabel } from '../lib/utils';
import { isActive, hasWarnings, needsAttention } from '../lib/jobStatus';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNow } from '../lib/useNow';
import { createdAgoIntervalMs, getJobHaystack } from '../lib/jobsPerf';
import { toast } from '../lib/toast';

type JobFilter = 'active' | 'failed' | 'done' | 'all';
type JobDetails = { job: Job; logs: JobLog[] };
type PanelMode = 'dialog' | 'inline';
// Filter ids stay stable because the sidebar and saved links use `?filter=failed`.
const FILTERS: readonly { id: JobFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'failed', label: 'Needs attention' },
  { id: 'done', label: 'Finished' },
];
const EMPTY_COPY: Record<JobFilter, { title: string; description: string }> = {
  failed: { title: 'All clear', description: 'Nothing needs attention. Recent tasks finished cleanly.' },
  active: { title: 'Nothing is running', description: 'Scans and matching you start from Libraries show up here.' },
  done: { title: 'No finished tasks yet', description: 'Completed and cancelled tasks are kept here for review.' },
  all: { title: 'No tasks yet', description: 'Scans, matching, and other background work appear here.' },
};
const LOG_COLOR: Record<string, string> = { info: 'text-muted', warn: 'text-warning', warning: 'text-warning', error: 'text-danger', success: 'text-success' };
const controlClass = 'max-lg:min-h-11 pointer-coarse:min-h-11';
const INSPECTOR_QUERY = '(min-width: 1280px)';
const EMPTY_JOBS: Job[] = [];

const JOB_GLYPH: Record<string, LucideIcon> = {
  'scan-matchable': ScanLine,
  'refresh-matched': RefreshCw,
  'scan-downloaded': ScanLine,
  'scan-new': ScanLine,
  'match-unmatched': RefreshCw,
  'match-library': RefreshCw,
  'match-series': RefreshCw,
  'sync-series': RefreshCw,
  'apply-series': CheckCheck,
  'restore-metadata': RotateCcw,
  'clear-overrides': SlidersHorizontal,
  'check-watched-searches': Eye,
  'edit-comicinfo': FilePen,
  'merge-series': Merge,
  'delete-series': Trash2,
};

function matchesFilter(job: Job, filter: JobFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return isActive(job);
  if (filter === 'failed') return needsAttention(job);
  return !isActive(job) && !needsAttention(job);
}

/** First visit: land on what needs a decision, else what is running, else everything. */
function defaultFilter(jobs: Job[]): JobFilter {
  return jobs.some(needsAttention) ? 'failed' : jobs.some(isActive) ? 'active' : 'all';
}

function fieldLabel(key: string): string {
  return key.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function readableValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '';
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
  if (typeof payload.seriesId === 'number' || typeof payload.seriesId === 'string') return `Series #${payload.seriesId} · name not recorded`;
  if (Array.isArray(payload.seriesIds) && payload.seriesIds.length) return `${payload.seriesIds.length} series · names not recorded`;
  if (typeof payload.libraryId === 'number' || typeof payload.libraryId === 'string') return `Library #${payload.libraryId} · name not recorded`;
  return job.type === 'check-watched-searches' ? 'All watched searches' : 'All libraries';
}

function jobSeries(job: Job): { id: number; name: string }[] {
  const targets = job.context?.series ?? [];
  const ids = [job.payload.seriesId, ...(Array.isArray(job.payload.seriesIds) ? (job.payload.seriesIds as unknown[]) : [])];
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
  // Skip leading brackets and punctuation so "[Circle (Artist)] Title" shows a letter, not "[".
  const initial = series ? (series.name.replace(/^[^\p{L}\p{N}]+/u, '').charAt(0) || series.name.charAt(0)).toUpperCase() : '';
  return (
    <div aria-hidden="true" className={cn('aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-md bg-surface-2 sm:w-24', className)}>
      {src && failedSrc !== src ? (
        <img src={src} alt="" width={96} height={128} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailedSrc(src)} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-semibold text-muted">
          {series ? initial : <ListChecks className="h-5 w-5" />}
        </div>
      )}
    </div>
  );
}

/** A cover when the task targets a series; otherwise a glyph for what kind of work it is. */
function JobCover({ job, className, chipClassName }: { job: Job; className?: string; chipClassName?: string }) {
  const series = jobSeries(job);
  if (!series.length) {
    const Glyph = JOB_GLYPH[job.type] ?? ListChecks;
    return (
      <div aria-hidden="true" className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted sm:h-10 sm:w-10', job.status === 'failed' && 'text-danger', job.status === 'running' && 'text-primary', chipClassName)}>
        <Glyph className="h-4 w-4 sm:h-5 sm:w-5" />
      </div>
    );
  }
  return (
    <div className="relative shrink-0" title={series.length > 1 ? `${series.length} affected series` : series[0]?.name}>
      <SeriesCover series={series[0]} version={job.finishedAt ?? job.startedAt ?? job.createdAt} className={cn('w-8 rounded sm:w-10', className)} />
      {series.length > 1 && <span aria-hidden="true" className="absolute -bottom-1 -right-1 rounded bg-black/70 px-1 text-2xs font-medium tabular-nums text-white">+{series.length - 1}</span>}
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
  'refresh-matched': 'Re-read each matched series from its exact provider entry and list changes to review on Home. Nothing is applied',
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
  } else if (job.type === 'refresh-matched') {
    for (const [key, label] of [['processed', 'matched series checked'], ['updates', 'with provider updates to review'], ['failed', 'could not be read'], ['skipped', 'skipped because their provider is disabled']]) if (typeof result[key] === 'number' && (key === 'processed' || key === 'updates' || result[key] > 0)) parts.push(`${result[key]} ${label}`);
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
    if (typeof result.failed === 'number' && result.failed > 0) parts.push(`${result.failed} archives could not be moved`);
  } else if (job.type === 'clear-overrides') {
    parts.push(typeof result.cleared === 'number' && result.cleared > 0 ? `${result.cleared} library overrides cleared` : 'Library settings overrides cleared');
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

// Built once: same output as Date#toLocaleString() / #toLocaleTimeString() with
// no arguments, without constructing a formatter for every rendered row.
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric' });

function timestamp(value: string | null | undefined): string {
  return value ? DATE_TIME_FORMAT.format(new Date(toIsoUtc(value))) : '—';
}

/** Relative creation time on an age-tiered shared clock, so old rows stop ticking cleanly. */
function CreatedAgo({ job }: { job: Job }) {
  const interval = createdAgoIntervalMs(job.createdAt);
  useNow(interval ?? 60_000, interval !== null);
  return <time className="text-xs tabular-nums text-muted" dateTime={toIsoUtc(job.createdAt)} title={`${timestamp(job.createdAt)}${job.startedAt ? ` · ${duration(job)}` : ''}`}>{timeAgo(job.createdAt)}</time>;
}

/** "Updated …s ago" for the open running task; ticks on its own. */
function UpdatedAgo({ updatedAt }: { updatedAt: number }) {
  const now = useNow(1000);
  if (!updatedAt) return <span aria-live="off">Updating…</span>;
  const seconds = Math.floor((now - updatedAt) / 1000);
  return <span aria-live="off">{`Updated ${Math.max(0, seconds) < 2 ? 'just now' : `${seconds}s ago`}`}</span>;
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
function StructuredValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="text-sm text-muted">None</p>;
  if (Array.isArray(value)) return value.length ? (
    <ul className="space-y-2">
      {(value as unknown[]).map((item, index) => <li key={index} className="rounded-md border border-border p-2"><StructuredValue value={item} /></li>)}
    </ul>
  ) : <p className="text-sm text-muted">None</p>;
  if (typeof value === 'object') return Object.keys(value).length ? (
    <dl className="space-y-3">
      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
        <div key={key} className={cn('min-w-0', /warning|error/i.test(key) && 'rounded-md border border-warning/30 bg-warning/5 p-3')}>
          <dt className="mb-1 break-words text-xs font-medium text-muted">{fieldLabel(key)}</dt>
          <dd className="min-w-0"><StructuredValue value={item} /></dd>
        </div>
      ))}
    </dl>
  ) : <p className="text-sm text-muted">None</p>;
  return <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{readableValue(value)}</p>;
}

/** Clean completions are quiet; pills are kept for the states that need a second look. */
function RowStatus({ job }: { job: Job }) {
  if (job.status === 'completed' && !hasWarnings(job.result)) {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Completed</span><span aria-hidden="true">Done</span></span>;
  }
  return <JobStatus job={job} />;
}

function formatRemaining(seconds: number): string {
  if (seconds < 60) return 'under 1 min';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function copyText(text: string, success: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast({ tone: 'success', title: success }),
    (error) => toast({ tone: 'danger', title: 'Could not copy', description: error instanceof Error ? error.message : String(error) }),
  );
}

interface FailureGuidance { headline: string; paragraphs: string[]; path?: string; retryAfter: number | null; rateLimited: boolean }

/** Turn what we know about a failure into one plain headline and a next step. */
function failureGuidance(job: Job): FailureGuidance {
  const message = job.errorMessage ?? '';
  const firstLine = message.split('\n')[0].trim();
  if (job.type === 'restore-metadata') return { headline: 'Review required before restoring again', paragraphs: [jobOutcome(job)], retryAfter: null, rateLimited: false };
  const retryAfterMatch = /Retry-After:\s*(\d+)/i.exec(message);
  const retryAfter = retryAfterMatch ? Number(retryAfterMatch[1]) : null;
  const rateLimited = retryAfter !== null || /\b429\b|rate.?limit/i.test(message);
  const denied = /EACCES|EPERM|permission denied/i.test(message);
  const path = denied ? /\b(?:open|access|mkdir|rename|unlink|write|copyfile)\s+'([^']+)'/i.exec(message)?.[1] : undefined;
  const paragraphs: string[] = [];
  if (rateLimited && retryAfter !== null) paragraphs.push(`It asked H-Tosho to wait ${retryAfter} seconds before the next request.`);
  if (job.recovery) paragraphs.push(job.recovery.explanation);
  else if (firstLine && !denied) paragraphs.push(firstLine);
  else if (!firstLine) paragraphs.push('No error message was recorded. The logs below may show what happened.');
  return {
    headline: rateLimited ? 'A metadata provider is rate-limiting H-Tosho.' : denied ? (path ? "H-Tosho can't write to this file." : "H-Tosho doesn't have permission to do that.") : 'This task failed.',
    paragraphs,
    path,
    retryAfter,
    rateLimited,
  };
}

interface RetryControl { onClick: () => void; pending: boolean; disabled: boolean }

/** What happened, what to do next, then (collapsed) the raw error. */
function FailureCard({ job, retry }: { job: Job; retry?: RetryControl }) {
  const guidance = failureGuidance(job);
  const finished = job.finishedAt ? new Date(toIsoUtc(job.finishedAt)).getTime() : NaN;
  const deadline = guidance.retryAfter !== null && Number.isFinite(finished)
    ? finished + guidance.retryAfter * 1000
    : null;
  const now = useNow(1000, deadline !== null && Date.now() < deadline);
  // Capped at the server's own Retry-After so a skewed clock can never lock Retry for long.
  const wait = guidance.retryAfter !== null && deadline !== null
    ? Math.min(guidance.retryAfter, Math.max(0, Math.ceil((deadline - now) / 1000)))
    : 0;
  const recoveryActions = job.type === 'restore-metadata' ? [] : job.recovery?.actions ?? [];
  const retryFirst = guidance.rateLimited || !recoveryActions.length;
  const retryLabel = wait > 0 ? `Retry in ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, '0')}` : 'Retry task';
  return (
    <>
      <section aria-labelledby={`failure-${job.id}`} className="space-y-3 rounded-xl border border-danger/35 bg-danger/5 p-4">
        <h3 id={`failure-${job.id}`} className="text-base font-semibold leading-snug tracking-tight">{guidance.headline}</h3>
        {guidance.path && <p className="break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere]">{guidance.path}</p>}
        {guidance.paragraphs.map((text) => <p key={text} className="text-sm text-muted">{text}</p>)}
        {(retry || recoveryActions.length > 0) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {retry && (
              <Button className={controlClass} variant={retryFirst ? 'default' : 'outline'} disabled={retry.disabled || retry.pending || wait > 0} onClick={retry.onClick}>
                {retry.pending ? <Spinner /> : <RotateCcw className="h-4 w-4" />}{retry.pending ? 'Retrying…' : retryLabel}
              </Button>
            )}
            {recoveryActions.map((action, index) => (
              <Button asChild variant={!retryFirst && index === 0 ? 'default' : 'outline'} className={controlClass} key={action.href}><Link to={action.href}>{action.label}</Link></Button>
            ))}
          </div>
        )}
      </section>
      {job.errorMessage && (
        <Disclosure label="Error details" summaryClassName="px-0">
          <div className="space-y-2 pb-1">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs [overflow-wrap:anywhere]">{job.errorMessage}</pre>
            {navigator.clipboard && <Button variant="ghost" size="sm" className={controlClass} onClick={() => copyText(job.errorMessage ?? '', 'Error copied')}><Copy className="h-4 w-4" /> Copy error</Button>}
          </div>
        </Disclosure>
      )}
    </>
  );
}

/** Two deliberate steps for an action the app itself says cannot be undone. */
function StopConfirm({ job, pending, onKeep, onStop }: { job: Job; pending: boolean; onKeep: () => void; onStop: () => void }) {
  const consequence = job.status === 'queued'
    ? "It hasn't started yet, so nothing will change."
    : job.progressTotal > 0
      ? `The ${job.progressCurrent} of ${job.progressTotal} items already processed keep their changes.`
      : 'Work already performed is not undone.';
  return (
    <InlineConfirm label="Confirm stopping this task" keepLabel="Keep running" confirmLabel="Stop task" icon={<Ban className="h-4 w-4" />} pending={pending} onKeep={onKeep} onConfirm={onStop} className="mt-2 max-w-xl" controlClassName={controlClass}>
      <span className="font-semibold">Stop this task?</span> {consequence}
    </InlineConfirm>
  );
}

function RunningFacts({ job }: { job: Job }) {
  const { progressCurrent: current, progressTotal: total } = job;
  const needsEta = job.status === 'running' && total > 0 && current > 0 && Boolean(job.startedAt);
  const now = useNow(1000, needsEta);
  const percent = total > 0 ? Math.round((current / total) * 100) : null;
  const started = job.startedAt ? new Date(toIsoUtc(job.startedAt)).getTime() : NaN;
  const remaining = total > 0 && current > 0 && Number.isFinite(started) ? ((total - current) / current) * Math.max(1, (now - started) / 1000) : null;
  if (job.status === 'queued') return <p className="text-sm text-muted">Waiting to start. No work has been performed yet.</p>;
  return (
    <section aria-label="Task progress" className="space-y-3">
      {total > 0 ? (
        <dl className="grid grid-cols-3 gap-3">
          <div className="min-w-0"><dt className="text-xs text-muted">Processed</dt><dd className="text-xl font-semibold tabular-nums tracking-tight">{current}<span className="text-xs font-medium text-muted"> of {total}</span></dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted">Done</dt><dd className="text-xl font-semibold tabular-nums tracking-tight">{percent}%</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted">Remaining</dt><dd className="text-sm font-semibold leading-8">{remaining === null ? '—' : formatRemaining(remaining)}</dd></div>
        </dl>
      ) : <p className="text-sm text-muted">Work is in progress; no item count reported yet.</p>}
      <ProgressBar value={current} max={total} active />
    </section>
  );
}

/** Rendered log lines are capped (newest kept); copy/download still include every entry. */
const LOG_RENDER_LIMIT = 1000;

const formattedLogTime = new WeakMap<JobLog, string>();
function formatLogTime(log: JobLog): string {
  let cached = formattedLogTime.get(log);
  if (cached === undefined) {
    cached = TIME_FORMAT.format(new Date(toIsoUtc(log.createdAt)));
    formattedLogTime.set(log, cached);
  }
  return cached;
}

const LogRow = React.memo(function LogRow({ log }: { log: JobLog }) {
  const level = log.level === 'warning' ? 'warn' : log.level;
  return (
    <div className={cn('cv-log flex min-w-0 gap-2 rounded px-1', level === 'error' && 'bg-danger/10', level === 'warn' && 'bg-warning/10')}>
      <time className="shrink-0 text-muted" dateTime={toIsoUtc(log.createdAt)}>{formatLogTime(log)}</time>
      <span className={cn('w-12 shrink-0 uppercase', LOG_COLOR[log.level] ?? 'text-muted')}>{log.level}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{log.message}</span>
    </div>
  );
});

const LogConsole = React.memo(function LogConsole({ logs, jobId }: { logs: JobLog[]; jobId: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const nearBottom = React.useRef(true);
  const [follow, setFollow] = React.useState(true);
  const [severity, setSeverity] = React.useState('all');
  const visible = React.useMemo(
    () => logs.filter((log) => severity === 'all' || (log.level === 'warning' ? 'warn' : log.level) === severity),
    [logs, severity],
  );
  const levels = React.useMemo(
    () => Array.from(new Set(logs.map((log) => log.level === 'warning' ? 'warn' : log.level))).sort(),
    [logs],
  );
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
  const formatLogs = () => visible.map((log) => `${timestamp(log.createdAt)} [${log.level.toUpperCase()}] ${log.message}`).join('\n');
  const downloadLogs = () => {
    const url = URL.createObjectURL(new Blob([formatLogs()], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `job-${jobId}-logs.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="min-w-0 space-y-3" aria-label="Job logs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted" aria-live="off">{visible.length} of {logs.length} entries</p>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`severity-${jobId}`} className="sr-only">Severity</Label>
          <Select id={`severity-${jobId}`} aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value)} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-auto"><option value="all">All levels</option>{levels.map((level) => <option key={level} value={level}>{fieldLabel(level)}</option>)}</Select>
          {navigator.clipboard && <Button variant="outline" size="sm" className={controlClass} disabled={!visible.length} onClick={() => copyText(formatLogs(), 'Logs copied')}><Copy className="h-4 w-4" /> Copy</Button>}
          <Button variant="outline" size="sm" className={controlClass} disabled={!visible.length} onClick={downloadLogs}><Download className="h-4 w-4" /> Download</Button>
        </div>
      </div>
      <label className="flex max-lg:min-h-11 pointer-coarse:min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={follow} onChange={(event) => { if (event.target.checked) jumpToLatest(); else setFollow(false); }} className="h-4 w-4 accent-primary" /> Follow logs</label>
      <div ref={ref} tabIndex={0} aria-label="Scrollable task log entries" onScroll={(event) => {
        const element = event.currentTarget;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
        if (!nearBottom.current) setFollow(false);
      }} className="h-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-background p-2 font-mono text-xs leading-relaxed">
        {visible.length > LOG_RENDER_LIMIT && <p className="p-1 text-muted">Showing the latest {LOG_RENDER_LIMIT.toLocaleString()} of {visible.length.toLocaleString()} entries. Copy or download for the full log.</p>}
        {!visible.length ? <p className="p-1 text-muted">{logs.length ? 'No logs match this severity.' : 'No logs yet.'}</p> : (visible.length > LOG_RENDER_LIMIT ? visible.slice(-LOG_RENDER_LIMIT) : visible).map((log) => <LogRow key={log.id} log={log} />)}
      </div>
      {!follow && <Button className={cn(controlClass, 'w-full')} variant="secondary" onClick={jumpToLatest}><ArrowDown className="h-4 w-4" /> Jump to latest and follow</Button>}
    </section>
  );
});

const PanelTitle = React.forwardRef<HTMLHeadingElement, { mode: PanelMode; children: React.ReactNode }>(({ mode, children }, ref) =>
  mode === 'dialog'
    ? <DialogTitle ref={ref} tabIndex={-1} className="outline-none">{children}</DialogTitle>
    : <h2 ref={ref} tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">{children}</h2>);
PanelTitle.displayName = 'PanelTitle';

function PanelDescription({ mode, children }: { mode: PanelMode; children: React.ReactNode }) {
  return mode === 'dialog'
    ? <DialogDescription className="mt-1 break-words">{children}</DialogDescription>
    : <p className="mt-1 break-words text-sm text-muted">{children}</p>;
}

interface JobRowActions {
  open: (id: number) => void;
  retry: (id: number) => void;
  requestStop: (id: number) => void;
  keep: () => void;
  stop: (id: number) => void;
}

/** One task in the list. Memoized: a poll re-renders only the rows whose job (or row state) changed. */
const JobListRow = React.memo(function JobListRow({ job, selected, confirmingStop, stopPending, retryPending, retryDisabled, actions }: {
  job: Job; selected: boolean; confirmingStop: boolean; stopPending: boolean; retryPending: boolean; retryDisabled: boolean; actions: JobRowActions;
}) {
  const summary = jobSummary(job);
  const retryable = job.status === 'failed' && job.type !== 'restore-metadata';
  return (
    <article
      className={cn('cv-row grid min-w-0 cursor-pointer grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 transition-colors duration-150 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:gap-y-0 sm:px-4', confirmingStop ? 'sm:items-start' : 'sm:items-center', selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/50' : job.status === 'failed' ? 'bg-danger/5 hover:bg-danger/10' : 'hover:bg-surface-2/50')}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, a, input, select, summary')) actions.open(job.id); }}
    >
      <JobCover job={job} />
      <div className="min-w-0">
        <h2 className="font-sans text-sm leading-snug [overflow-wrap:anywhere]">
          <button type="button" id={`task-open-${job.id}`} data-task-open={job.id} aria-current={selected ? 'true' : undefined} aria-label={`View details for task #${job.id}: ${jobTarget(job)}`} onClick={() => actions.open(job.id)} className="rounded text-left font-semibold underline-offset-4 hover:underline">{jobLabel(job.type, job.payload)}</button>{' '}
          <span className="text-muted">{jobTarget(job)}</span>
        </h2>
        {summary && <p className={cn('mt-0.5 text-sm', job.status === 'failed' ? 'line-clamp-2 text-danger' : 'text-muted')} title={job.status === 'failed' ? job.errorMessage ?? undefined : undefined}>{summary}</p>}
        {job.status === 'running' && <div className="mt-2 flex items-center gap-2"><ProgressBar value={job.progressCurrent} max={job.progressTotal} active label={`Progress for ${jobTarget(job)}`} className="h-1.5 max-w-xs" />{job.progressTotal > 0 && <span className="shrink-0 text-xs tabular-nums text-muted">{job.progressCurrent} / {job.progressTotal}</span>}</div>}
        {confirmingStop && isActive(job) && <StopConfirm job={job} pending={stopPending} onKeep={actions.keep} onStop={() => actions.stop(job.id)} />}
      </div>
      <div className="col-start-2 flex min-w-0 items-center justify-between gap-3 sm:col-start-auto sm:justify-end">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:min-w-24 sm:flex-col sm:items-end sm:gap-y-0.5">
          <RowStatus job={job} />
          <CreatedAgo job={job} />
        </div>
        {retryable && <Button className={controlClass} size="sm" variant="outline" disabled={retryDisabled || retryPending} onClick={() => actions.retry(job.id)}>{retryPending ? <Spinner /> : <RotateCcw className="h-4 w-4" />}{retryPending ? 'Retrying…' : 'Retry'}</Button>}
        {isActive(job) && !confirmingStop && <Button className={cn(controlClass, 'hover:bg-danger/10 hover:text-danger')} size="sm" variant="ghost" aria-label={`Stop task #${job.id}: ${jobTarget(job)}`} onClick={() => actions.requestStop(job.id)}>Stop</Button>}
      </div>
    </article>
  );
});

function buildJobHaystack(job: Job): string {
  return `${job.id} ${jobLabel(job.type, job.payload)} ${job.type} ${jobTarget(job)} ${job.context?.series.map((series) => series.name).join(' ') ?? ''} ${job.context?.libraryName ?? ''} ${JOB_PURPOSE[job.type] ?? ''} ${jobOutcome(job)} ${job.errorMessage ?? ''} ${readableValue(job.result)}`;
}

export function Jobs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = searchParams.get('filter');
  const urlFilter: JobFilter | null = FILTERS.some((item) => item.id === rawFilter) ? rawFilter as JobFilter : null;
  const rawId = searchParams.get('job');
  const selectedId = rawId && /^\d+$/.test(rawId) && Number(rawId) > 0 && Number.isSafeInteger(Number(rawId)) ? Number(rawId) : null;
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('all');
  const [typeOpen, setTypeOpen] = React.useState(false);
  const [clearTarget, setClearTarget] = React.useState<number | 'all' | null>(null);
  const [stopConfirmId, setStopConfirmId] = React.useState<number | null>(null);
  const [hovering, setHovering] = React.useState(false);
  const frozenOrder = React.useRef<number[] | null>(null);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const inspector = useMediaQuery(INSPECTOR_QUERY);
  const qc = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: ['jobs'],
    queryFn: api.jobs,
    // Polled by the always-mounted SidebarStatus (jobsPollInterval); a second
    // interval here would run its own timer and double the requests.
  });
  const jobs = jobsQuery.data ?? EMPTY_JOBS;
  // Resolved once from the first load so tabs never jump while a task finishes.
  const autoFilter = React.useRef<JobFilter | null>(null);
  if (autoFilter.current === null && jobsQuery.data) autoFilter.current = defaultFilter(jobsQuery.data);
  const filter: JobFilter = urlFilter ?? autoFilter.current ?? 'all';
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
      return job ? (isActive(job) ? 1500 : false) : query.state.status === 'error' ? false : 1500;
    },
  });
  const selectedJob = detailQuery.data?.job ?? selectedListJob;
  const updateUrl = (updates: { filter?: JobFilter; job?: number | null }, replace = false) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (updates.filter !== undefined) next.set('filter', updates.filter);
      if (updates.job !== undefined) {
        if (updates.job === null) next.delete('job');
        else next.set('job', String(updates.job));
      }
      return next;
    }, { replace });
  };
  const cancelMutation = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: async (_, id) => {
      setStopConfirmId(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: ['job', id] })]);
      toast({ tone: 'success', title: 'Stop requested' });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not stop task', description: error.message }),
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
      toast({ tone: 'success', title: result.removed === 1 ? 'Failed task removed' : `${result.removed} failed tasks removed` });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not remove failed tasks', description: error.message }),
  });

  // The open stop confirmation reverts on Escape and times out on its own (InlineConfirm).
  React.useEffect(() => {
    if (!inspector || selectedId === null || clearTarget !== null) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== 'Escape' || event.defaultPrevented || target?.closest('input, select, textarea, [role="dialog"], [role="alertdialog"]')) return;
      updateUrl({ job: null });
      document.getElementById(`task-open-${selectedId}`)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspector, selectedId, clearTarget]);

  const types = React.useMemo(() => Array.from(new Set(jobs.map((job) => job.type))).sort(), [jobs]);
  // Typing stays responsive: the list filters against the deferred value, and
  // each job's search text is built once per jobs update, not per keystroke.
  const deferredSearch = React.useDeferredValue(search);
  const query = deferredSearch.trim().toLowerCase();
  const searchActive = query !== '' || type !== 'all';
  const sorted = React.useMemo(() => jobs.filter((job) => {
    return matchesFilter(job, filter) && (type === 'all' || job.type === type) && (!query || getJobHaystack(job, buildJobHaystack).includes(query));
  }).sort((a, b) => {
    const priority = (job: Job) => job.status === 'running' ? 0 : job.status === 'queued' ? 1 : needsAttention(job) ? 2 : 3;
    return priority(a) - priority(b) || b.id - a.id;
  }), [jobs, filter, type, query]);
  // While the pointer is over the list, rows keep their place instead of re-sorting under it.
  const frozen = hovering ? frozenOrder.current : null;
  const visibleJobs = React.useMemo(() => {
    if (!frozen) return sorted;
    const position = new Map(frozen.map((id, index) => [id, index]));
    return [...sorted].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity) || b.id - a.id);
  }, [sorted, frozen]);
  const { statusCounts, failedCount, warningCount } = React.useMemo(() => {
    let activeCount = 0;
    let attentionCount = 0;
    let doneCount = 0;
    let failedOnly = 0;
    for (const job of jobs) {
      if (isActive(job)) activeCount++;
      else if (needsAttention(job)) attentionCount++;
      else doneCount++;
      if (job.status === 'failed') failedOnly++;
    }
    return {
      statusCounts: { all: jobs.length, active: activeCount, failed: attentionCount, done: doneCount },
      failedCount: failedOnly,
      warningCount: attentionCount - failedOnly,
    };
  }, [jobs]);
  const countsReady = !jobsQuery.isPending && !(jobsQuery.isError && !jobsQuery.data);
  const openJob = (id: number, replace = false) => updateUrl({ job: id }, replace);
  const retryFor = (job: Job): RetryControl | undefined => job.type === 'restore-metadata' ? undefined : {
    onClick: () => retryMutation.mutate(job.id),
    pending: retryMutation.isPending && retryMutation.variables === job.id,
    disabled: retryMutation.isPending || clearMutation.isPending,
  };
  const stopConfirm = (job: Job) => stopConfirmId === job.id && isActive(job) && (
    <StopConfirm job={job} pending={cancelMutation.isPending && cancelMutation.variables === job.id} onKeep={() => setStopConfirmId(null)} onStop={() => cancelMutation.mutate(job.id)} />
  );
  // Rows are memoized, so their callbacks must be stable; they read the latest render through a ref.
  const latestRowHandlers = React.useRef({ openJob, retry: (id: number) => retryMutation.mutate(id), stop: (id: number) => cancelMutation.mutate(id) });
  React.useLayoutEffect(() => { latestRowHandlers.current = { openJob, retry: (id: number) => retryMutation.mutate(id), stop: (id: number) => cancelMutation.mutate(id) }; });
  const rowActions = React.useMemo<JobRowActions>(() => ({
    open: (id) => latestRowHandlers.current.openJob(id),
    retry: (id) => latestRowHandlers.current.retry(id),
    requestStop: (id) => setStopConfirmId(id),
    keep: () => setStopConfirmId(null),
    stop: (id) => latestRowHandlers.current.stop(id),
  }), []);
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-task-open]');
    if (!current) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-task-open]'));
    const next = buttons[buttons.indexOf(current) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (inspector && selectedId !== null) openJob(Number(next.dataset.taskOpen), true);
  };

  const renderDetails = (mode: PanelMode) => {
    const job = selectedJob;
    const active = job !== undefined && isActive(job);
    const failed = job?.status === 'failed';
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="relative flex shrink-0 items-start gap-3 border-b border-border p-4 pr-16 sm:p-5 sm:pr-16">
          {job && <JobCover job={job} className="w-11 sm:w-14" chipClassName="h-11 w-11 sm:h-14 sm:w-14" />}
          <div className="min-w-0 flex-1">
            <PanelTitle ref={titleRef} mode={mode}>{job ? jobTarget(job) : 'Task details'}</PanelTitle>
            <PanelDescription mode={mode}>{job ? `${jobLabel(job.type, job.payload)} · ` : ''}Task #{selectedId}</PanelDescription>
            {job && <div className="mt-3"><JobStatus job={job} /></div>}
          </div>
          {mode === 'inline' && <button type="button" aria-label="Close task details" onClick={() => { updateUrl({ job: null }); document.getElementById(`task-open-${selectedId}`)?.focus(); }} className="ui-button ui-button-icon absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground"><X className="h-4 w-4" /></button>}
        </div>
        <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-5">
          {detailQuery.isError && <ErrorState title="Could not load task details" description={detailQuery.error.message} onRetry={() => void detailQuery.refetch()} />}
          {detailQuery.isPending && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading task details…</div>}
          {job && <>
            {active ? <>
              {stopConfirm(job)}
              <RunningFacts job={job} />
              <p className="text-sm text-muted">{JOB_PURPOSE[job.type] ?? jobOutcome(job)}.</p>
            </> : failed ? <>
              <FailureCard job={job} retry={retryFor(job)} />
              {job.type === 'restore-metadata' && typeof job.payload.seriesId === 'number' && <section className="space-y-2"><h3 className="text-sm font-semibold">Metadata history</h3><p className="text-sm text-muted">Inspect the observed before-and-after values. Failed or interrupted restores require a fresh reviewed preview, never a blind retry.</p><Button asChild variant="outline" className="min-h-11"><Link to={`/libraries?series=${job.payload.seriesId}&action=identify`}>Open series metadata history</Link></Button></section>}
            </> : <section className="space-y-2">
              <h3 className="text-sm font-semibold">Summary</h3>
              <p className="text-sm">{jobOutcome(job)}</p>
              {JOB_PURPOSE[job.type] && <p className="text-sm text-muted">{JOB_PURPOSE[job.type]}.</p>}
              {job.type === 'restore-metadata' && typeof job.payload.seriesId === 'number' && <div className="pt-2"><Button asChild variant="outline" className="min-h-11"><Link to={`/libraries?series=${job.payload.seriesId}&action=identify`}>Open series metadata history</Link></Button></div>}
            </section>}
            {(job.context?.libraryName || (job.type === 'apply-series' && typeof job.payload.selectedTitle === 'string') || jobSeries(job).length > 1) && <section className="space-y-2">
              {job.type === 'apply-series' && typeof job.payload.selectedTitle === 'string' && <p className="text-sm">Selected title: {job.payload.selectedTitle}</p>}
              {job.context?.libraryName && <p className="text-sm">Library: {job.context.libraryName}</p>}
              {jobSeries(job).length > 1 && <Disclosure label={`Affected series (${jobSeries(job).length})`} summaryClassName="px-0"><AffectedSeries job={job} /></Disclosure>}
            </section>}
            {job.result !== null && job.result !== undefined && <Disclosure label="Recorded result" summaryClassName="px-0"><div className="pt-3"><StructuredValue value={job.result} /></div></Disclosure>}
            <Disclosure label="Timing" summaryClassName="px-0"><p className="mt-2 text-sm">{duration(job)}</p><dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">{[['Created', job.createdAt], ['Started', job.startedAt], ['Finished', job.finishedAt]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 break-words">{timestamp(value)}</dd></div>)}</dl></Disclosure>
            <Disclosure label="Technical details" summaryClassName="px-0"><p className="py-3 font-mono text-xs text-muted">{job.type} · Task #{job.id}</p><StructuredValue value={job.payload} /></Disclosure>
          </>}
          {detailQuery.data && <Disclosure key={selectedId} label={`Logs (${detailQuery.data.logs.length})`} open={active || failed} summaryClassName="px-0"><div className="pt-3"><LogConsole jobId={selectedId!} logs={detailQuery.data.logs} /></div></Disclosure>}
        </div>
        {job && (failed || active) && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted sm:px-5">
            {failed ? <>
              <span>Remove this failed task and its logs from history.</span>
              <Button variant="ghost" size="sm" className={controlClass} disabled={retryMutation.isPending || clearMutation.isPending} onClick={() => setClearTarget(job.id)}><Trash2 className="h-4 w-4" /> Remove from history</Button>
            </> : <>
              <UpdatedAgo updatedAt={detailQuery.dataUpdatedAt} />
              {stopConfirmId !== job.id && <Button variant="ghost" size="sm" className={cn(controlClass, 'hover:bg-danger/10 hover:text-danger')} onClick={() => setStopConfirmId(job.id)}>Stop task</Button>}
            </>}
          </div>
        )}
      </div>
    );
  };

  const showInspector = inspector && selectedId !== null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      <PageHeader icon={<ListChecks className="h-5 w-5" />} title="Tasks" subtitle="Background work and recent results." />
      <div className={cn('grid min-w-0 gap-4', showInspector ? 'grid-cols-[minmax(0,1fr)_440px] items-start' : 'grid-cols-1')}>
        <Card className="min-w-0">
          <SegmentedTabs
            label="Task status"
            panelId="jobs-panel"
            value={filter}
            onChange={(id) => updateUrl({ filter: id })}
            items={FILTERS.map((item) => ({ id: item.id, label: item.label, count: countsReady ? statusCounts[item.id] : undefined, alert: item.id === 'failed' && countsReady && statusCounts.failed > 0 }))}
          />
          <div className="flex items-center gap-2 p-3 sm:p-4">
            <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><Input id="jobs-search" type="search" aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={(event) => setSearch(event.target.value)} className="max-lg:min-h-11 pointer-coarse:min-h-11 pl-9" /></div>
            <Button variant="outline" size="icon" className={cn(controlClass, 'relative max-lg:w-11 pointer-coarse:w-11')} aria-label="Filter by task type" aria-expanded={typeOpen} aria-controls="jobs-type-filter" onClick={() => setTypeOpen((open) => !open)}>
              <SlidersHorizontal className="h-4 w-4" />
              {type !== 'all' && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />}
            </Button>
          </div>
          {typeOpen && <div id="jobs-type-filter" className="px-3 pb-3 sm:px-4"><Select aria-label="Task type" value={type} onChange={(event) => setType(event.target.value)} className={cn(controlClass, 'w-full sm:w-64')}><option value="all">All task types</option>{types.map((value) => <option key={value} value={value}>{jobLabel(value)}</option>)}</Select></div>}
          {searchActive && countsReady && <p className="px-3 pb-2 text-xs text-muted sm:px-4" role="status">{visibleJobs.length} of {statusCounts[filter]} tasks</p>}
          {filter === 'failed' && failedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border bg-danger/5 px-3 py-1.5 text-sm sm:px-4">
              <span>{failedCount} failed{warningCount > 0 ? ` · ${warningCount} with warnings` : ''}</span>
              <Button variant="ghost" size="sm" className={controlClass} disabled={clearMutation.isPending || retryMutation.isPending} onClick={() => setClearTarget('all')}><Trash2 className="h-4 w-4" /> Clear {failedCount} failed</Button>
            </div>
          )}
          <CardContent id="jobs-panel" role="tabpanel" aria-labelledby={`jobs-panel-tab-${filter}`} className="!p-0 divide-y divide-border" onKeyDown={onListKeyDown} onPointerEnter={(event) => { if (event.pointerType === 'mouse') { frozenOrder.current = sorted.map((job) => job.id); setHovering(true); } }} onPointerLeave={() => { setHovering(false); frozenOrder.current = null; }}>
            {jobsQuery.isError && <ErrorState title="Could not load tasks" description={jobsQuery.error.message} onRetry={() => void jobsQuery.refetch()} />}
            {jobsQuery.isPending ? <div role="status" aria-label="Loading tasks" className="divide-y divide-border">{[0, 1, 2].map((index) => <div key={index} className="flex items-center gap-3 px-3 py-3 sm:px-4"><Skeleton className="h-10 w-10 shrink-0 rounded-lg" /><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-1/2" /></div></div>)}</div> : !visibleJobs.length && !jobsQuery.isError ? <div>{searchActive
              ? <EmptyState icon={<Search className="h-8 w-8" />} title="No matching tasks" description="Try another search or task type." />
              : <EmptyState icon={filter === 'failed' ? <CheckCircle2 className="h-8 w-8" /> : <ListChecks className="h-8 w-8" />} title={EMPTY_COPY[filter].title} description={EMPTY_COPY[filter].description} />}
              {searchActive && <div className="flex justify-center pb-6"><Button variant="outline" className={controlClass} onClick={() => { setSearch(''); setType('all'); }}>Clear search and type</Button></div>}
            </div> : visibleJobs.map((job) => <JobListRow
              key={job.id}
              job={job}
              selected={job.id === selectedId}
              confirmingStop={stopConfirmId === job.id}
              stopPending={cancelMutation.isPending && cancelMutation.variables === job.id}
              retryPending={retryMutation.isPending && retryMutation.variables === job.id}
              retryDisabled={retryMutation.isPending || clearMutation.isPending}
              actions={rowActions}
            />)}
          </CardContent>
        </Card>
        {showInspector && (
          <aside aria-label="Task details" className="ui-card sticky top-4 flex max-h-[calc(100dvh-2rem)] min-h-96 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
            {renderDetails('inline')}
          </aside>
        )}
      </div>
      <Dialog open={selectedId !== null && !inspector} onOpenChange={(open) => { if (!open) updateUrl({ job: null }); }}>
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus({ preventScroll: true }); }} className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 !animate-none !rounded-none border-y-0 border-r-0 sm:!w-full lg:!w-[min(640px,55vw)]">
          {/* Only build the details tree while the drawer is actually open. */}
          {selectedId !== null && !inspector && renderDetails('dialog')}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={clearTarget !== null}
        title={clearTarget === 'all' ? 'Clear all failed tasks?' : `Remove failed task #${clearTarget}?`}
        description={clearTarget === 'all'
          ? 'Permanently remove all failed tasks and their logs, including those outside the current filters or loaded history. Active, completed, and cancelled tasks are kept. This cannot be undone.'
          : 'Permanently remove this failed task and its logs from history. This does not change your library or files and cannot be undone.'}
        confirmLabel={clearMutation.isPending ? 'Removing…' : clearTarget === 'all' ? 'Clear failed tasks' : 'Remove task'}
        danger
        pending={clearMutation.isPending}
        onOpenChange={(open) => { if (!open && !clearMutation.isPending) setClearTarget(null); }}
        onConfirm={() => { if (clearTarget !== null) clearMutation.mutate(clearTarget); }}
      />
    </div>
  );
}
