import * as React from 'react';
import { Search, Loader2, Download as DownloadIcon, Pause, XCircle, CheckCircle2, RotateCcw, Check, Circle, ImageOff, Bookmark, CheckSquare, EllipsisVertical } from 'lucide-react';
import { type DoujinSource, type DoujinSearchResult } from '../../lib/api';
import { useGalleryDownloadTask } from '../../lib/DownloadsContext';
import { cn, toIsoUtc } from '../../lib/utils';
import { Button, Badge } from '../../components/ui';
import { PageCountPill } from '../../components/PageCountPill';

import { SOURCE_COLORS, SOURCE_LABELS, type DownloadSetup } from './state';
function SourceBadge({ source }: { source: DoujinSource }) {
  const color = SOURCE_COLORS[source];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: color + '22', color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {SOURCE_LABELS[source]}
    </span>
  );
}

export function Cover({ url, title, className }: { url?: string | null; title: string; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  const size = className ?? 'h-40 w-full';
  if (!url || failed) {
    return (
      <div className={cn('flex items-center justify-center bg-surface-2 text-muted', size)}>
        <ImageOff className="h-6 w-6" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={title}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('object-cover', size)}
    />
  );
}

/** Galleries per page, matching both official search APIs. */
export function formatDate(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(toIsoUtc(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export function DownloadStatusBadge({ status }: { status: string }) {
  const map: Record<string, React.ReactNode> = {
    queued: <Badge tone="muted"><Circle className="h-3 w-3" /> Queued</Badge>,
    downloading: <Badge tone="info"><Loader2 className="h-3 w-3 animate-spin" /> Downloading</Badge>,
    completed: <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Completed</Badge>,
    failed: <Badge tone="danger"><XCircle className="h-3 w-3" /> Failed</Badge>,
    'retry-wait': <Badge tone="warning"><RotateCcw className="h-3 w-3" /> Retry scheduled</Badge>,
    cancelled: <Badge tone="muted"><XCircle className="h-3 w-3" /> Cancelled</Badge>,
    packing: <Badge tone="info"><Loader2 className="h-3 w-3 animate-spin" /> Packing archive</Badge>,
    paused: <Badge tone="warning"><Pause className="h-3 w-3" /> Paused</Badge> };
  return <span key={status} className="downloader-task-status inline-flex">{map[status] ?? <Badge>{status}</Badge>}</span>;
}

// ---------------- Gallery card ----------------
// Handlers take the item they act on (instead of per-card closures) so the
// memoized card only re-renders when its own data changes.
interface GalleryCardProps {
  item: DoujinSearchResult;
  onOpen: (item: DoujinSearchResult) => void;
  onDownload: (item: DoujinSearchResult) => void;
  downloadSetup: DownloadSetup['status'];
  starting?: boolean;
  ownership: { type: 'available' | 'downloaded' | 'in-library' | 'possible-duplicate'; downloadedAt?: string | null; preferenceOwned?: boolean };
  selection?: { mode: 'select' | 'browse'; selected: boolean; onToggle: (item: DoujinSearchResult) => void };
  review?: { state: 'pending' | 'reviewed' | 'unreviewed'; onChange: (item: DoujinSearchResult, reviewed: boolean) => void };
  feedback?: { pending: boolean; onOpen: (item: DoujinSearchResult) => void };
  display?: 'full' | 'recommendation' | 'discovery';
  /** Render the download action as an outline button so a shelf of cards stays calm. */
  quietAction?: boolean;
  /** Extra sources this gallery was also found on (unified search grouping).
   *  Text labels — never color-only. */
  provenance?: { extraSources: DoujinSource[] };
}

export const GalleryCard = React.memo(function GalleryCard({ item, onOpen, onDownload, downloadSetup, starting = false, ownership, selection, review, feedback, display = 'full', quietAction = false, provenance }: GalleryCardProps) {
  const selectMode = selection?.mode === 'select', selected = selection?.selected ?? false;
  const onToggleSelect = selection?.onToggle, onReview = review?.onChange;
  const reviewed = review?.state === 'reviewed', reviewPending = review?.state === 'pending';
  const onFeedback = feedback?.onOpen, dismissing = feedback?.pending ?? false;
  const owned = ownership.preferenceOwned ?? false;
  const libraryMatch = ownership.type === 'in-library' ? 'owned' : ownership.type === 'possible-duplicate' ? 'possible' : undefined;
  const showSource = display !== 'recommendation', showTags = display === 'full';
  const tags = item.tags.slice(0, 4);
  const inLibrary = libraryMatch === 'owned';
  const alreadyOwned = ownership.type === 'downloaded' || inLibrary;
  const task = useGalleryDownloadTask(item.source, item.galleryId);
  const active = starting || task?.state?.type === 'retry-wait' || task?.status === 'queued' || task?.status === 'downloading' || task?.status === 'paused';
  return (
    <article
      data-gallery-motion-id={`${item.source}:${item.galleryId}`}
      className={cn(
        'ui-card ui-card-interactive @container group flex min-w-0 flex-col overflow-hidden rounded-xl border transition-colors duration-200',
        selected ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border bg-surface hover:border-border-2',
      )}
    >
      <button type="button" onClick={() => (selectMode ? onToggleSelect?.(item) : onOpen(item))} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] text-left min-[420px]:block" aria-label={selectMode ? `${selected ? 'Deselect' : 'Select'} ${item.title}` : `View details for ${item.title}`} aria-pressed={selectMode ? selected : undefined}>
        <div className="relative overflow-hidden">
          <Cover url={item.coverUrl} title={item.title} className="downloader-cover aspect-[3/4] w-full" />
          <PageCountPill pageCount={item.pageCount} className={cn('absolute right-2', selectMode || selected ? 'bottom-2' : 'top-2')} />
          {(selectMode || selected) && (
            <span className={cn('pointer-events-none absolute left-2 top-2 z-20 inline-flex h-8 w-8 items-center justify-center rounded-md border', selected ? 'border-primary-button bg-primary-button text-white' : 'border-border-2 bg-surface text-muted')} aria-hidden="true">
              {selected ? <Check className="downloader-selection-check h-5 w-5" /> : <span className="h-4 w-4 rounded-sm border-2 border-current" />}
            </span>
          )}
          {!selectMode && !selected && <div className="pointer-events-none absolute inset-0 flex items-end justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary-button px-3 py-1 text-xs font-medium text-white">
              <Search className="h-3 w-3" /> Details
            </span>
          </div>}
        </div>
        <div className="flex min-w-0 flex-col gap-2 p-3 pb-0">
          <p className="min-h-10 overflow-hidden text-sm font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" title={item.title}>{item.title}</p>
          {item.artists.length > 0 && (
            <p className="truncate text-xs font-medium text-foreground" title={`Artists: ${item.artists.join(', ')}`}>
              <span className="text-muted">Artist{item.artists.length > 1 ? 's' : ''} · </span>{item.artists.join(', ')}
            </p>
          )}
          {showTags && tags.length > 0 && <div className="flex max-h-12 flex-wrap gap-1 overflow-hidden" aria-label="Tags">{tags.map((tag, i) => <span key={i} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{tag}</span>)}</div>}
        </div>
      </button>
      <div className="mt-auto flex min-w-0 flex-col gap-2 p-3">
        {(showSource || owned || provenance) && (
          <div className="flex min-h-6 flex-wrap items-center gap-2">
            {showSource && <SourceBadge source={item.source} />}
            {provenance && provenance.extraSources.length > 0 && (
              <span className="flex min-w-0 flex-wrap items-center gap-1" aria-label={`Also found on ${provenance.extraSources.map((s) => SOURCE_LABELS[s]).join(', ')}`}>
                <span className="text-xs text-muted">Also on:</span>
                {provenance.extraSources.map((s) => <SourceBadge key={s} source={s} />)}
              </span>
            )}
            {owned && <Badge tone="muted"><Bookmark className="h-3 w-3" /> Owned</Badge>}
          </div>
        )}
        <div className="flex min-w-0 items-stretch gap-2">
          {selectMode ? <>
            <Button size="sm" variant={selected ? 'default' : 'outline'} className="min-w-0 flex-1 px-2" onClick={() => onToggleSelect?.(item)} aria-pressed={selected} aria-label={`${selected ? 'Remove' : 'Select'} ${item.title} ${selected ? 'from' : 'for'} merging`}><CheckSquare className="h-3.5 w-3.5 shrink-0" /><span>{selected ? 'Selected' : 'Select'}</span></Button>
            <Button size="sm" variant="ghost" onClick={() => onOpen(item)} aria-label={`View details for ${item.title}`}>Details</Button>
          </> : <Button size="sm" variant={quietAction || alreadyOwned || libraryMatch === 'possible' ? 'outline' : 'default'} className={cn('max-lg:min-h-11 pointer-coarse:min-h-11 min-w-0 flex-1 px-2', onReview && 'h-auto min-h-11 px-1.5')} onClick={() => onDownload(item)} disabled={active || alreadyOwned || downloadSetup === 'loading' || downloadSetup === 'error'} aria-label={starting && !task ? `Checking duplicates for ${item.title}` : active ? `${item.title} is ${task?.status ?? 'starting'}` : alreadyOwned ? `${item.title} already in library` : libraryMatch === 'possible' ? `Review possible duplicate of ${item.title}` : downloadSetup === 'missing' ? `Set output folder before downloading ${item.title}` : `Download ${item.title}`}>
            {!onReview && (task?.status === 'paused' ? <Pause className="h-3.5 w-3.5 shrink-0" /> : task?.status === 'queued' ? <Circle className="h-3.5 w-3.5 shrink-0" /> : active ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : alreadyOwned ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <DownloadIcon className="h-3.5 w-3.5 shrink-0" />)}
            <span>{task?.state?.type === 'retry-wait' ? 'Retry scheduled' : task?.status === 'queued' ? 'Queued' : task?.status === 'paused' ? 'Paused' : starting && !task ? 'Checking…' : active ? 'Downloading' : inLibrary ? 'In library' : alreadyOwned ? 'Downloaded' : libraryMatch === 'possible' ? 'Review duplicate' : downloadSetup === 'missing' ? 'Set folder' : 'Download'}</span>
          </Button>}
          {!selectMode && onReview && <Button size="sm" variant="outline" className="relative h-auto min-h-11 shrink-0 px-1.5" disabled={reviewPending || reviewed} onClick={() => onReview(item, true)} aria-label={reviewed ? `${item.title} dismissed from inbox` : `Dismiss ${item.title}`} title={reviewed ? 'Kept in History' : 'Remove from Inbox and keep in History'}><span className={reviewPending ? 'invisible' : undefined}>{reviewed ? 'Dismissed' : 'Dismiss'}</span>{reviewPending && <Loader2 aria-hidden="true" className="absolute h-3.5 w-3.5 animate-spin" />}</Button>}
          {onFeedback && <Button size="icon" variant="outline" className="max-lg:min-h-11 max-lg:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-muted" disabled={dismissing} onClick={() => onFeedback(item)} aria-label={`Tune recommendations for ${item.title}`} title="Tune recommendations"><EllipsisVertical className="h-4 w-4" /></Button>}
        </div>
        {!selectMode && selected && <Button size="sm" onClick={() => onToggleSelect?.(item)} aria-pressed={true} aria-label={`Remove ${item.title} from merging`}><CheckSquare className="h-3.5 w-3.5 shrink-0" />Selected for merge</Button>}
      </div>
    </article>
  );
});
