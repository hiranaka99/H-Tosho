import { useDuplicateReview } from '../components/DuplicateReview';
import * as React from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search,
  Loader2,
  RefreshCcw,
  Download as DownloadIcon,
  Pause,
  Play,
  XCircle,
  RotateCcw,
  Trash2,
  CheckCircle2,
  Check,
  Circle,
  ImageOff,
  ListVideo,
  Languages,
  FileArchive,
  FolderOpen,
  FileText,
  X,
  ArrowRight,
  ExternalLink,
  BookOpen,
  Bookmark,
  Users,
  Layers,
  Star,
  Sparkles,
  Tags,
  CheckSquare,
  Combine,
  ChevronDown,
  Plus,
  EllipsisVertical,
} from 'lucide-react';
import { api, ApiError, type DuplicateCheck, type FeedbackRequest, type DoujinSource, type DoujinSort, type DoujinSearchResult, type DoujinSuggestion, type DownloadTask } from '../lib/api';
import { useDownloadActions, useDownloads } from '../lib/DownloadsContext';
import { buildTagSearchFragment, cn, timeAgo, toIsoUtc } from '../lib/utils';
import { formatBytes, formatSpeed } from '../lib/format';
import { downloadErrorHelp } from '../lib/downloadErrors';
import { toast } from '../lib/toast';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, Select, EmptyState, Spinner, ProgressBar, Dialog, DialogContent, DialogTitle, DialogDescription, PageHeader, SegmentedTabs, SegmentedControl, TabPanel, Disclosure, ErrorState, ConfirmDialog, Skeleton, Pager } from '../components/ui';
import { ComicInfoModal } from '../components/ComicInfoModal';
import { MergeIntoSeriesDialog } from '../components/MergeIntoSeriesDialog';
import { chapterErrors } from '../lib/chapterNumbers';
import { GalleryFeedbackDialog, RecommendationFeedbackManager } from '../components/RecommendationFeedback';
import { PagePreview } from '../components/PagePreview';
import { PageCountPill } from '../components/PageCountPill';
import { GallerySelectionBar } from '../components/GallerySelectionBar';
import { indexSelectableGalleries, selectedGalleryItems } from '../lib/gallerySelection';

/** Source list fallback (rendered before the server's provider list resolves). */
const FALLBACK_SOURCES: { id: DoujinSource; label: string }[] = [
  { id: 'hitomi', label: 'Hitomi.la' },
  { id: 'nhentai', label: 'nHentai' },
];

/** Display accent per doujin source (mirrors backend provider.color). */
const SOURCE_COLORS: Record<DoujinSource, string> = {
  hitomi: '#ff5722',
  nhentai: '#e91e63',
};

const DOWNLOADER_STATE_KEY = 'h-tosho:downloader-state';

interface DownloaderStateCache {
  source?: DoujinSource;
  query?: string;
  searchKey?: string | null;
  sort?: DoujinSort;
  page?: number;
  searches?: Partial<Record<DoujinSource, { query: string; searchKey: string | null; sort: DoujinSort }>>;
}

function readDownloaderState(): DownloaderStateCache {
  try {
    return JSON.parse(sessionStorage.getItem(DOWNLOADER_STATE_KEY) ?? '{}') as DownloaderStateCache;
  } catch {
    return {};
  }
}

function writeDownloaderState(update: Partial<DownloaderStateCache>) {
  sessionStorage.setItem(DOWNLOADER_STATE_KEY, JSON.stringify({ ...readDownloaderState(), ...update }));
}

/**
 * Result ordering options for nHentai searches, mirroring nhentai.net's own
 * sort controls.
 */
const NHENTAI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: 'default', label: 'Newest' },
  { value: 'popular', label: 'Popular — all time' },
  { value: 'popular-week', label: 'Popular — this week' },
  { value: 'popular-today', label: 'Popular — today' },
];

/** Result ordering options for Hitomi searches (mirrors hitomi.la's sort dropdown). */
const HITOMI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: 'default', label: 'Newest' },
  { value: 'popular-today', label: 'Popular Today' },
  { value: 'popular-week', label: 'Popular Week' },
  { value: 'popular-year', label: 'Popular Year' },
];

/** The sort options a source offers (sent as a separate field — the search box never shows the syntax). */
const DEFAULT_SORTS: { value: DoujinSort; label: string }[] = [{ value: 'default', label: 'Newest' }];
const sortsFor = (src: DoujinSource): { value: DoujinSort; label: string }[] =>
  src === 'nhentai' ? NHENTAI_SORTS : src === 'hitomi' ? HITOMI_SORTS : DEFAULT_SORTS;

/** Human-facing display name for a doujin source. */
const SOURCE_LABELS: Record<DoujinSource, string> = { hitomi: 'Hitomi.la', nhentai: 'nHentai' };

type DownloadSetup = { status: 'loading' | 'error' | 'missing' | 'ready'; directory?: string; format?: 'cbz' | 'folder'; onRetry: () => void };
const DOWNLOADER_SETTINGS_URL = '/settings?tab=downloader';

function DownloadDestination({ setup }: { setup: DownloadSetup }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted" role="status">
    {setup.status === 'loading' ? <><Spinner /> Checking download settings…</> : setup.status === 'error' ? <><span>Could not check the download folder.</span><Button size="sm" variant="outline" onClick={setup.onRetry}>Retry settings</Button></> : setup.status === 'missing' ? <><span>Choose where downloads will be saved.</span><Link className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4" to={DOWNLOADER_SETTINGS_URL}>Set output folder</Link></> : <>
      <FolderOpen className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-all">Save to {setup.directory}</span><Badge tone="muted">{setup.format === 'cbz' ? 'CBZ' : 'Image folder'}</Badge><Link className="inline-flex min-h-9 items-center text-primary underline underline-offset-4" to={DOWNLOADER_SETTINGS_URL}>Change</Link>
    </>}
  </div>;
}

function DownloadFailure({ message }: { message: string }) {
  const help = downloadErrorHelp(message);
  return <div className="space-y-1 text-xs">
    <p className="text-danger">{help.message}</p>
    {help.settings && <Link className="inline-flex min-h-9 items-center text-primary underline underline-offset-4" to={DOWNLOADER_SETTINGS_URL}>Open Downloader settings</Link>}
    <Disclosure label="Technical details" className="text-muted"><p className="break-all pt-2">{message}</p></Disclosure>
  </div>;
}

/** Bounds of the token at the caret; whitespace inside quotes belongs to the same token. */
function activeTermBounds(full: string, caret: number): { start: number; end: number } {
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (!quote && /\s/.test(ch)) {
      if (i >= caret) return { start, end: i };
      start = i + 1;
    } else if (ch === quote) {
      quote = null;
    } else if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
    }
  }
  return { start, end: full.length };
}

/** Badge color per suggestion tag type (mirrors the nHentai search dropdown). */
const SUGG_TYPE_STYLES: Record<string, string> = {
  artist: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/20 dark:text-violet-300',
  group: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300',
  character: 'bg-pink-500/10 text-pink-700 dark:bg-pink-400/20 dark:text-pink-300',
  parody: 'bg-blue-500/10 text-blue-700 dark:bg-blue-400/20 dark:text-blue-300',
  series: 'bg-cyan-500/10 text-cyan-700 dark:bg-cyan-400/20 dark:text-cyan-300',
  language: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300',
  category: 'bg-rose-500/10 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300',
  tag: 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/20 dark:text-slate-300',
};

function SourceBadge({ source }: { source: DoujinSource }) {
  const color = SOURCE_COLORS[source];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: color + '22', color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {SOURCE_LABELS[source]}
    </span>
  );
}

function Cover({ url, title, className }: { url?: string | null; title: string; className?: string }) {
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

/** Gallaries per results page — the provider returns up to ~1000 in one shot. */
const RESULTS_PAGE_SIZE = 25;

/** Finished tasks shown before the History section collapses (rest via "Show all"). */
const HISTORY_PREVIEW = 5;
const EMPTY_GALLERIES: DoujinSearchResult[] = [];

/** Track gallery/queue relationships only when membership or selection changes. */
function useDownloaderTransitions(state: string) {
  const ref = React.useRef<HTMLDivElement>(null);
  const previous = React.useRef<Map<string, { x: number; y: number }> | null>(null);
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const origin = container.getBoundingClientRect();
    const positions = new Map<string, { x: number; y: number }>();
    const animations: Animation[] = [];
    container.querySelectorAll<HTMLElement>('[data-download-id], [data-gallery-motion-id], [data-gallery-shortlist-id]').forEach((row) => {
      const bounds = row.getBoundingClientRect();
      // Hidden desktop/mobile shortlist copies never participate in motion.
      if (!bounds.width || !bounds.height) return;
      const id = row.dataset.galleryMotionId ? `gallery:${row.dataset.galleryMotionId}` : row.dataset.galleryShortlistId ? `shortlist:${row.dataset.galleryShortlistId}` : `task:${row.dataset.downloadId}`;
      const position = { x: bounds.left - origin.left, y: bounds.top - origin.top };
      positions.set(id, position);
      if (!previous.current || preference.matches || document.hidden || bounds.bottom < 0 || bounds.top > window.innerHeight || typeof row.animate !== 'function') return;
      const old = previous.current.get(id);
      const dx = old ? old.x - position.x : 0;
      const dy = old ? old.y - position.y : 6;
      if (old && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const nearby = old && Math.abs(dx) < bounds.width * 2 && Math.abs(dy) < bounds.height * 2;
      animations.push(row.animate(
        nearby ? [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]
          : id.startsWith('shortlist:') ? [{ opacity: 0.5, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }]
            : [{ opacity: 0.65 }, { opacity: 1 }],
        { duration: nearby ? 240 : 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      ));
    });
    previous.current = positions;
    const cancel = () => animations.forEach((animation) => animation.cancel());
    const onPreferenceChange = () => { if (preference.matches) cancel(); };
    const onVisibilityChange = () => { if (document.hidden) cancel(); };
    preference.addEventListener('change', onPreferenceChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancel();
      preference.removeEventListener('change', onPreferenceChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [state]);
  return ref;
}

/** Format an ISO 8601 date string for display, or undefined when absent/invalid. */
function formatDate(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(toIsoUtc(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function DownloadStatusBadge({ status }: { status: string }) {
  const map: Record<string, React.ReactNode> = {
    queued: <Badge tone="muted"><Circle className="h-3 w-3" /> Queued</Badge>,
    downloading: <Badge tone="info"><Loader2 className="h-3 w-3 animate-spin" /> Downloading</Badge>,
    completed: <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Completed</Badge>,
    failed: <Badge tone="danger"><XCircle className="h-3 w-3" /> Failed</Badge>,
    paused: <Badge tone="warning"><Pause className="h-3 w-3" /> Paused</Badge>,
  };
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
  task?: DownloadTask;
  starting?: boolean;
  downloadedAt?: string | null;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (item: DoujinSearchResult) => void;
  owned?: boolean;
  libraryMatch?: 'owned' | 'possible';
  dismissing?: boolean;
  showSource?: boolean;
  showTags?: boolean;
  onFeedback?: (item: DoujinSearchResult) => void;
}

const GalleryCard = React.memo(function GalleryCard({ item, onOpen, onDownload, downloadSetup, task, starting = false, downloadedAt, selectMode = false, selected = false, onToggleSelect, owned = false, libraryMatch, dismissing = false, showSource = true, showTags = true, onFeedback }: GalleryCardProps) {
  const tags = item.tags.slice(0, 4);
  const inLibrary = libraryMatch === 'owned';
  const alreadyOwned = owned || inLibrary || downloadedAt !== undefined;
  const active = starting || task?.status === 'queued' || task?.status === 'downloading' || task?.status === 'paused';
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
          {item.language && (
            <span className={cn('absolute left-2 hidden items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white min-[420px]:inline-flex', selectMode || selected ? 'bottom-2' : 'top-2')}>
              <Languages className="h-3 w-3" /> {item.language}
            </span>
          )}
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
          {item.language && <p className="text-xs text-muted min-[420px]:hidden">{item.language}</p>}
          {item.artists.length > 0 && (
            <p className="truncate text-xs font-medium text-foreground" title={`Artists: ${item.artists.join(', ')}`}>
              <span className="text-muted">Artist{item.artists.length > 1 ? 's' : ''} · </span>{item.artists.join(', ')}
            </p>
          )}
          {showTags && tags.length > 0 && <div className="flex max-h-12 flex-wrap gap-1 overflow-hidden" aria-label="Tags">{tags.map((tag, i) => <span key={i} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{tag}</span>)}</div>}
        </div>
      </button>
      <div className="mt-auto flex min-w-0 flex-col gap-2 p-3">
        {(showSource || owned) && (
          <div className="flex min-h-6 flex-wrap items-center gap-2">
            {showSource && <SourceBadge source={item.source} />}
            {owned && <Badge tone="muted"><Bookmark className="h-3 w-3" /> Owned</Badge>}
          </div>
        )}
        <div className="flex min-w-0 items-stretch gap-2">
          {selectMode ? <>
            <Button size="sm" variant={selected ? 'default' : 'outline'} className="min-w-0 flex-1 px-2" onClick={() => onToggleSelect?.(item)} aria-pressed={selected} aria-label={`${selected ? 'Remove' : 'Select'} ${item.title} ${selected ? 'from' : 'for'} merging`}><CheckSquare className="h-3.5 w-3.5 shrink-0" /><span>{selected ? 'Selected' : 'Select'}</span></Button>
            <Button size="sm" variant="ghost" onClick={() => onOpen(item)} aria-label={`View details for ${item.title}`}>Details</Button>
          </> : <Button size="sm" variant={alreadyOwned || libraryMatch === 'possible' ? 'outline' : 'default'} className="max-lg:min-h-11 pointer-coarse:min-h-11 min-w-0 flex-1 px-2" onClick={() => onDownload(item)} disabled={active || alreadyOwned || downloadSetup === 'loading' || downloadSetup === 'error'} aria-label={starting && !task ? `Checking duplicates for ${item.title}` : active ? `${item.title} is ${task?.status ?? 'starting'}` : alreadyOwned ? `${item.title} already in library` : libraryMatch === 'possible' ? `Review possible duplicate of ${item.title}` : downloadSetup === 'missing' ? `Set output folder before downloading ${item.title}` : `Download ${item.title}`}>
            {task?.status === 'paused' ? <Pause className="h-3.5 w-3.5 shrink-0" /> : task?.status === 'queued' ? <Circle className="h-3.5 w-3.5 shrink-0" /> : active ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : alreadyOwned ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <DownloadIcon className="h-3.5 w-3.5 shrink-0" />}
            <span>{task?.status === 'queued' ? 'Queued' : task?.status === 'paused' ? 'Paused' : starting && !task ? 'Checking…' : active ? 'Downloading' : inLibrary ? 'In library' : alreadyOwned ? 'Downloaded' : libraryMatch === 'possible' ? 'Review duplicate' : downloadSetup === 'missing' ? 'Set folder' : 'Download'}</span>
          </Button>}
          {onFeedback && <Button size="icon" variant="outline" className="max-lg:min-h-11 max-lg:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-muted" disabled={dismissing} onClick={() => onFeedback(item)} aria-label={`Tune recommendations for ${item.title}`} title="Tune recommendations"><EllipsisVertical className="h-4 w-4" /></Button>}
        </div>
        {!selectMode && selected && <Button size="sm" onClick={() => onToggleSelect?.(item)} aria-pressed={true} aria-label={`Remove ${item.title} from merging`}><CheckSquare className="h-3.5 w-3.5 shrink-0" />Selected for merge</Button>}
      </div>
    </article>
  );
});

// ---------------- Gallery detail modal ----------------

const TAG_GROUP_STYLES: Record<string, string> = {
  Artists: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/20 dark:text-violet-300',
  Groups: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300',
  Characters: 'bg-pink-500/10 text-pink-700 dark:bg-pink-400/20 dark:text-pink-300',
  Series: 'bg-cyan-500/10 text-cyan-700 dark:bg-cyan-400/20 dark:text-cyan-300',
  Tags: 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/20 dark:text-slate-300',
};

function TagList({ label, items, namespaces, icon, onSearch, titleFor }: {
  label: string;
  items?: string[];
  /** Per-item search namespace (parallel to `items`). */
  namespaces?: (string | null)[];
  icon?: React.ReactNode;
  onSearch?: (value: string, ns?: string | null) => void;
  /** Tooltip for a searchable item — show the exact query it will run. */
  titleFor?: (value: string, ns?: string | null) => string | undefined;
}) {
  if (!items?.length) return null;
  const style = Object.entries(TAG_GROUP_STYLES).find(([k]) => label.startsWith(k))?.[1] ?? 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/20 dark:text-slate-300';
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        {icon} {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t, i) => {
          const ns = namespaces?.[i];
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSearch?.(t, ns)}
              title={titleFor ? titleFor(t, ns) : onSearch ? `Search for “${t}”` : undefined}
              className={cn(
                'max-lg:min-h-11 pointer-coarse:min-h-11 rounded-full px-2.5 py-1 text-xs transition-all',
                style,
                onSearch && 'cursor-pointer hover:brightness-125',
              )}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-surface-2/50 px-3 py-2">
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function GalleryDetailModal({ item, onClose, onDownload, downloading, checking, downloaded, inLibrary, setup, onSearchTag }: { item: DoujinSearchResult; onClose: () => void; onDownload: () => void; downloading: boolean; checking: boolean; downloaded: boolean; inLibrary: boolean; setup: DownloadSetup; onSearchTag: (fragment: string, source?: DoujinSource) => void }) {
  const { data: gallery, isPending, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['doujin-gallery', item.source, item.galleryId],
    queryFn: () => api.doujinGallery(item.source, item.galleryId),
    staleTime: 5 * 60_000,
  });
  const g = gallery;
  const previewPages = g?.previewPages ?? [];

  /** Search a single tag/artist value (from the details card) on this source. */
  const searchFor = (value: string, ns?: string | null) => {
    const fragment = buildTagSearchFragment(value, ns, item.source);
    if (fragment) onSearchTag(fragment, item.source);
  };
  /** Tooltip showing the exact query a pill will run. */
  const searchTitle = (value: string, ns?: string | null) => {
    const fragment = buildTagSearchFragment(value, ns, item.source);
    return fragment ? `Search for “${fragment}”` : undefined;
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[min(98vw,1760px)]" aria-describedby={undefined}>
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="grid min-h-0 gap-4 overflow-y-auto p-3 sm:p-5 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-5">
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:self-start">
            <div className="min-w-0 pr-10">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <SourceBadge source={item.source} />
                {g?.language && <Badge tone="info"><Languages className="h-3 w-3" /> {g.language}</Badge>}
              </div>
              <DialogTitle className="break-words text-lg leading-snug">{g?.title ?? item.title}</DialogTitle>
            </div>

            {isPending && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted">
                <Spinner /> Loading gallery details…
              </div>
            )}

            {isError && (
              <div className="space-y-2" role="alert">
                <p className="text-sm font-medium">Could not load gallery details</p>
                <DownloadFailure message={error instanceof Error ? error.message : String(error)} />
                <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}><RotateCcw className="h-3.5 w-3.5" />{isFetching ? 'Retrying…' : 'Retry details'}</Button>
              </div>
            )}

          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:col-start-1 lg:row-start-1 lg:row-span-2">
            {previewPages.length > 0 ? (
              <PagePreview key={`${item.source}:${item.galleryId}`} pages={previewPages} fallbacks={g?.previewFallbacks} name={g?.title ?? item.title} />
            ) : (
              <Cover url={g?.coverUrl ?? item.coverUrl} title={item.title} className="mx-auto aspect-[3/4] w-40 rounded-md border border-border lg:w-48" />
            )}
            {g?.url && (
              <a href={g.url} target="_blank" rel="noreferrer" className="inline-flex max-lg:min-h-11 pointer-coarse:min-h-11 items-center gap-1.5 self-start text-xs text-muted transition-colors hover:text-primary">
                <ExternalLink className="h-3 w-3" /> View on {SOURCE_LABELS[item.source]}
              </a>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-2 lg:self-start">
            {g && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetaItem label="Pages" value={g.pageCount ? `${g.pageCount} pages` : null} />
                  <MetaItem label="Language" value={g.language} />
                  <MetaItem label="Uploaded" value={formatDate(g.uploadedAt ?? item.uploadedAt)} />
                  <MetaItem label="Gallery ID" value={g.galleryId} />
                </div>

                <TagList label="Artists" items={g.artists ?? item.artists} icon={<Users className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'artist')} titleFor={(v) => searchTitle(v, 'artist')} />
                <TagList label="Groups" items={g.groups} icon={<Layers className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'group')} titleFor={(v) => searchTitle(v, 'group')} />
                <TagList label="Characters" items={g.characters ?? g.genres} icon={<Star className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'character')} titleFor={(v) => searchTitle(v, 'character')} />
                {g.series && (
                  <div className="flex flex-col gap-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <BookOpen className="h-3 w-3" /> Series
                    </p>
                    <button
                      type="button"
                      onClick={() => searchFor(g.series ?? '', 'series')}
                      title={searchTitle(g.series ?? '', 'series')}
                      className="max-lg:min-h-11 pointer-coarse:min-h-11 w-fit cursor-pointer rounded-full bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-700 transition-all hover:brightness-125 dark:bg-cyan-400/20 dark:text-cyan-300"
                    >
                      {g.series}
                    </button>
                  </div>
                )}
                {g.tags?.length ? (
                  <TagList label={`Tags (${g.tags.length})`} items={g.tags} namespaces={g.tagNamespaces} icon={<Tags className="h-3 w-3" />} onSearch={(v, ns) => searchFor(v, ns)} titleFor={(v, ns) => searchTitle(v, ns)} />
                ) : null}

              </>
            )}

          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-surface p-3 sm:px-5">
          <div className="flex min-w-0 flex-col gap-1">
            <DownloadDestination setup={setup} />
            {downloaded && !inLibrary && <Link to="/downloader?tab=downloads" onClick={onClose} className="inline-flex min-h-11 items-center self-start text-xs text-primary underline underline-offset-4">Manage this gallery in Downloads</Link>}
          </div>
          <div className="ml-auto flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Close</Button>
            {(downloaded || setup.status !== 'missing') && <Button onClick={onDownload} disabled={downloaded || downloading || checking || setup.status !== 'ready'}>
              {downloaded ? <CheckCircle2 className="h-4 w-4" /> : (downloading || checking) ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />}{inLibrary ? 'In library' : downloaded ? 'Downloaded' : checking ? 'Checking…' : downloading ? 'Queued / downloading' : 'Download'}
            </Button>}
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Queue row ----------------

/**
 * Cover for a finished download — the first image of the saved file, served
 * locally by /downloads/:id/cover. Stretches to the full height of its row so
 * completed downloads are identifiable at a glance; lazy-loaded and hidden
 * when the file is gone or holds no image, so rows never show a broken
 * placeholder.
 */
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
            <DownloadStatusBadge status={task.status} />
            <span className="min-w-0 break-words text-sm font-medium line-clamp-2 sm:flex-1" title={task.title ?? ''}>{task.title ?? `Gallery ${task.galleryId}`}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {task.status === 'downloading' && <Button size="icon" variant="ghost" aria-label={`Pause ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onAction(task.id, 'pause')}><Pause className="h-4 w-4" /></Button>}
            {task.status === 'paused' && <Button size="icon" variant="ghost" aria-label={`Resume ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onAction(task.id, 'resume')}><Play className="h-4 w-4" /></Button>}
            {task.status === 'failed' && <Button size="sm" variant="outline" aria-label={`Retry ${task.title ?? 'download'}`} onClick={() => onAction(task.id, 'retry')}><RotateCcw className="h-4 w-4" /> Retry</Button>}
            {task.status === 'completed' && <Button size="icon" variant="ghost" aria-label={`Download ${task.title ?? `Gallery ${task.galleryId}`} again`} onClick={() => onAction(task.id, 'retry')}><RotateCcw className="h-4 w-4" /></Button>}
            {(task.status === 'downloading' || task.status === 'queued') && <Button size="icon" variant="ghost" aria-label={`Cancel ${task.title ?? `Gallery ${task.galleryId}`}`} onClick={() => onAction(task.id, 'cancel')}><XCircle className="h-4 w-4" /></Button>}
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
          <DownloadFailure message={task.errorMessage} />
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
function folderNameFrom(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Confirm dialog for queued merged downloads: all selected galleries land in one
 * shared folder (one Kavita series). Chapter numbers are prefilled with the
 * selection order but editable by hand; an empty field skips numbering that file.
 */
interface MergeDownloadResult {
  queuedKeys: string[];
  skippedKeys: string[];
  failures: { key: string; message: string }[];
}

function MergeDownloadDialog({ items, defaultFolder, onClose, onConfirm, setup, pending, result }: {
  items: DoujinSearchResult[];
  defaultFolder: string;
  onClose: () => void;
  onConfirm: (folder: string, numbers: (number | null)[]) => void;
  setup: DownloadSetup;
  pending: boolean;
  result: MergeDownloadResult | null;
}) {
  const [folder, setFolder] = React.useState(defaultFolder);
  // Per-gallery chapter numbers as editable strings, prefilled with selection order.
  const [numbers, setNumbers] = React.useState<string[]>(() => items.map((_, i) => String(i + 1)));
  const settled = new Set([...(result?.queuedKeys ?? []), ...(result?.skippedKeys ?? [])]);
  const setNumber = (i: number, v: string) => {
    setNumbers((prev) => prev.map((n, j) => (j === i ? v : n)));
  };
  const numberErrors = chapterErrors(numbers.map((value, index) => ({ key: String(index), value, changed: true })));
  const folderError = /[\\/]/.test(folder) ? 'Use a folder name without slashes.' : null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg" onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
        <div className="flex max-h-[calc(100vh-9rem)] flex-col gap-3 overflow-y-auto p-5 pr-12">
          <div>
            <DialogTitle>Merged download</DialogTitle>
            <DialogDescription className="sr-only">Download the selected galleries as one series.</DialogDescription>
          </div>
          <DownloadDestination setup={setup} />
          {result && result.failures.length > 0 && <div role="alert" className="space-y-1 text-sm">
            <p className="font-medium">{result.queuedKeys.length} queued{result.skippedKeys.length > 0 ? ` · ${result.skippedKeys.length} already owned or queued` : ''} · {result.failures.length} {result.failures.length === 1 ? 'needs' : 'need'} retry</p>
          </div>}
          {setup.status === 'ready' && setup.format !== 'cbz' && <p className="text-sm text-danger">Merged downloads need CBZ format. <Link className="underline underline-offset-4" to={DOWNLOADER_SETTINGS_URL}>Change the output format</Link> first.</p>}
          <div className="flex flex-col gap-1">
            <span id="merge-folder-label" className="text-xs font-medium text-muted">Series folder name</span>
            <Input id="merge-folder" aria-labelledby="merge-folder-label" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Series folder" disabled={pending || settled.size > 0} aria-invalid={!!folderError} aria-describedby={folderError ? "merge-folder-error" : undefined} autoFocus />
            {folderError && <p id="merge-folder-error" className="text-xs text-danger">{folderError}</p>}
          </div>
          <hr className="border-border" />
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
            {items.map((item, i) => (
              <div key={`${item.source}:${item.galleryId}`} className="flex shrink-0 items-center gap-2 rounded-md border border-border-2 bg-surface-2 px-2 py-1.5">
                <div className="min-w-0 flex-1 text-xs">
                  <p className="break-words">{item.title}</p>
                  {result?.queuedKeys.includes(`${item.source}:${item.galleryId}`) && <p className="text-success">Queued</p>}
                  {result?.skippedKeys.includes(`${item.source}:${item.galleryId}`) && <p className="text-muted">Already owned or queued</p>}
                  {result?.failures.filter(failure => failure.key === `${item.source}:${item.galleryId}`).map(failure => <p key={failure.key} className="mt-1 text-danger">{failure.message}</p>)}
                  {numberErrors[String(i)] && <p id={`merge-number-error-${i}`} className="mt-1 text-danger">{numberErrors[String(i)]}</p>}
                </div>
                <Input
                  inputMode="decimal"
                  aria-label={`Chapter number for ${item.title}`}
                  value={numbers[i]}
                  aria-invalid={!!numberErrors[String(i)]}
                  aria-describedby={numberErrors[String(i)] ? `merge-number-error-${i}` : undefined}
                  disabled={pending || settled.has(`${item.source}:${item.galleryId}`)}
                  onChange={(e) => setNumber(i, e.target.value)}
                  className="h-7 w-20 px-2 text-right text-base sm:text-base lg:text-xs pointer-coarse:text-base"
                />
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending || !folder.trim() || !!folderError || Object.keys(numberErrors).length > 0 || setup.status !== 'ready' || setup.format !== 'cbz'} onClick={() => onConfirm(folder.trim(), numbers.map((n) => (n.trim() === '' ? null : Number(n))))}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : result?.failures.length ? <RotateCcw className="h-4 w-4" /> : <Combine className="h-4 w-4" />} {pending ? 'Queuing…' : result?.failures.length ? `Retry remaining (${result.failures.length})` : `Download ${items.length} ${items.length === 1 ? 'gallery' : 'galleries'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Watched searches tab ----------------

/**
 * Saved searches that ping Discord when they find new galleries. Owns its own
 * query observer (30s poll — auto-scan results land while the tab is open) so
 * refetches never re-render the rest of the page; the search tab's Watch
 * button shares the same cache key.
 */
const WATCH_INTERVAL_OPTIONS = [
  { minutes: 0, label: 'Off' },
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours' },
] as const;

/** Human-readable cadence for the description copy; falls back to raw minutes. */
function watchIntervalLabel(minutes: number): string {
  return WATCH_INTERVAL_OPTIONS.find((o) => o.minutes === minutes)?.label ?? `${minutes} min`;
}

function WatchedTab({ onOpenSearch }: { onOpenSearch: (source: DoujinSource, query: string) => void }) {
  const qc = useQueryClient();
  const watchesQuery = useQuery({ queryKey: ['watched-searches'], queryFn: api.watchedSearches, refetchInterval: 30_000 });
  const watches = watchesQuery.data;
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const intervalMinutes = settingsQuery.data?.watchedSearchIntervalMinutes ?? 15;
  const [savingInterval, setSavingInterval] = React.useState(false);
  const [source, setSource] = React.useState<DoujinSource>('hitomi');
  const [query, setQuery] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<{ id: number; query: string } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  async function add() {
    const q = query.trim();
    if (!q) return;
    setAdding(true);
    try {
      await api.addWatchedSearch(source, q);
      setQuery('');
      qc.invalidateQueries({ queryKey: ['watched-searches'] });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not add watch', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.removeWatchedSearch(id);
      qc.invalidateQueries({ queryKey: ['watched-searches'] });
      toast({ tone: 'info', title: 'Watched search removed' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not remove watch', description: e instanceof Error ? e.message : String(e) });
    }
  }
  async function checkNow() {
    setChecking(true);
    try {
      await api.checkWatchedSearches();
      toast({ tone: 'success', title: 'Check queued', description: 'Results land in the job log; new galleries ping Discord.' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not queue check', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }

  async function saveInterval(minutes: number) {
    if (minutes === intervalMinutes || savingInterval) return;
    setSavingInterval(true);
    try {
      await api.saveWatchedSearchInterval(minutes);
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast({ tone: 'success', title: 'Check interval updated' });
    } catch (e) {
      void settingsQuery.refetch(); // snap the select back to the server value
      toast({ tone: 'danger', title: 'Could not save check interval', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingInterval(false);
    }
  }

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <CardTitle as="h2" className="flex items-center gap-2">
          <Star className="h-4 w-4" /> Watched searches
        </CardTitle>
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted sm:flex-none">Check every
          <Select aria-label="Watched search check interval" value={String(intervalMinutes)} onChange={(e) => void saveInterval(Number(e.target.value))} disabled={savingInterval || !settingsQuery.data} className="max-lg:min-h-11 pointer-coarse:min-h-11 sm:w-32">
            {WATCH_INTERVAL_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </Select>
          </label>
          <Button size="sm" variant="outline" className="shrink-0" onClick={checkNow} disabled={checking}>
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />} Check now
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {watchesQuery.isError && <ErrorState title="Could not load watched searches" description={watchesQuery.error instanceof Error ? watchesQuery.error.message : String(watchesQuery.error)} onRetry={() => void watchesQuery.refetch()} />}
        {settingsQuery.isError && <ErrorState title="Could not load the check interval" description={settingsQuery.error instanceof Error ? settingsQuery.error.message : String(settingsQuery.error)} onRetry={() => void settingsQuery.refetch()} />}
        {settingsQuery.data && (intervalMinutes > 0 ? (
          <p className="text-sm text-muted">Checked automatically every {watchIntervalLabel(intervalMinutes)}. New results ping Discord — the first run just records what already exists.</p>
        ) : (
          <p className="text-sm text-muted">Auto-check is off — use Check now to run all watches. New results ping Discord; the first run just records what already exists.</p>
        ))}
        {watchesQuery.isPending ? (
          <div role="status" aria-label="Loading watched searches" className="flex flex-col gap-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><span className="sr-only">Loading watched searches…</span></div>
        ) : watches && watches.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {watches.map((w) => (
              <div key={w.id} className="rounded-lg border border-border px-3 py-3 text-xs">
                <div className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><Badge tone="muted">{SOURCE_LABELS[w.source] ?? w.source}</Badge><span className="text-muted">{w.lastCheckedAt ? `Checked ${timeAgo(w.lastCheckedAt)}` : 'Not checked yet'}</span></div>
                    <button type="button" onClick={() => onOpenSearch(w.source, w.query)} title={`Open in search tab: ${w.query}`} aria-label={`Search “${w.query}” on ${SOURCE_LABELS[w.source] ?? w.source}`} className="max-lg:min-h-11 pointer-coarse:min-h-11 min-w-0 text-left text-sm font-medium text-primary underline-offset-2 hover:underline"><span className="break-words line-clamp-2">{w.query}</span></button>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                  {w.lastResults.length > 0 && (
                    <Button size="sm" variant="ghost" aria-expanded={expanded.has(w.id)} aria-controls={`watched-results-${w.id}`} aria-label={`${expanded.has(w.id) ? 'Hide' : 'Show'} ${w.lastResults.length} new results for ${w.query}`} onClick={() => toggleExpanded(w.id)}>
                      {w.lastResults.length} new
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', expanded.has(w.id) && 'rotate-180')} />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" aria-label={`Remove watch ${w.query}`} onClick={() => setRemoveTarget({ id: w.id, query: w.query })}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
                {w.lastResults.length > 0 && expanded.has(w.id) && (
                  <div id={`watched-results-${w.id}`} className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
                    {w.lastResults.map(r => {
                      const content = <><Cover url={r.coverUrl} title={r.title} className="h-10 w-8 shrink-0 rounded" /><span className="min-w-0 flex-1 break-words text-left line-clamp-2">{r.title}</span><PageCountPill pageCount={r.pageCount} />{r.url && <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />}</>;
                      const className = 'flex min-h-11 items-center gap-2 rounded px-1 text-foreground hover:bg-surface-2 hover:underline';
                      return r.url
                        ? <a key={r.galleryId} href={r.url} target="_blank" rel="noreferrer" className={className}>{content}</a>
                        : <button key={r.galleryId} type="button" className={className} onClick={() => onOpenSearch(w.source, r.galleryId)} aria-label={`Search for ${r.title} on ${SOURCE_LABELS[w.source]}`}>{content}</button>;
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          watches && <p className="text-sm text-muted">No watched searches yet — add one below, or use the Watch button in the Search tab.</p>
        )}
        <form className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center" aria-label="Add a watched search" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Select aria-label="Watched search source" value={source} onChange={(e) => setSource(e.target.value as DoujinSource)} disabled={adding} className="sm:w-32 sm:shrink-0"><option value="hitomi">Hitomi.la</option><option value="nhentai">nHentai</option></Select>
          <Input aria-label="Watched search query" placeholder="Search query, e.g. artist:konboi" value={query} onChange={(e) => setQuery(e.target.value)} disabled={adding} className="flex-1" />
          <Button size="sm" type="submit" disabled={adding || !query.trim()}>{adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add watch</Button>
        </form>
        <ConfirmDialog
          open={removeTarget !== null}
          title="Remove watched search?"
          description={removeTarget ? `Stop watching “${removeTarget.query}”?` : ''}
          confirmLabel="Remove"
          onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
          onConfirm={() => { if (removeTarget) void remove(removeTarget.id); setRemoveTarget(null); }}
        />
      </CardContent>
    </Card>
  );
}

// ---------------- Download manager tab ----------------

/**
 * The manager tab is the only consumer of live task state; subscribing here
 * (rather than at the page top) keeps SSE progress ticks from re-rendering the
 * whole page. Task-mutating actions come from the same stable actions API.
 */
function ManagerTab() {
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

export function Downloader() {
  const navigate = useNavigate();
  // Search cards consume live tasks so each doujin reflects queued, downloading,
  // or paused state. Deep links from the Libraries page override cached search
  // state; ordinary navigation restores the last input, committed search, and
  // result page.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialState = React.useMemo(readDownloaderState, []);
  const initialSearches = React.useMemo(() => {
    const previousSource = initialState.source ?? 'hitomi';
    return {
      [previousSource]: { query: initialState.query ?? '', searchKey: initialState.searchKey ?? null, sort: initialState.sort ?? 'default' },
      ...initialState.searches,
    };
  }, [initialState]);
  const linkedQuery = searchParams.get('q');
  const [source, setSource] = React.useState<DoujinSource>(() => {
    const requested = searchParams.get('source');
    if (requested && SOURCE_COLORS[requested as DoujinSource]) return requested as DoujinSource;
    return initialState.source && SOURCE_COLORS[initialState.source] ? initialState.source : 'hitomi';
  });

  // The server reports the registered doujin providers; the radio list follows
  // it so new sources appear without UI changes (static fallback while loading).
  const { data: providerList } = useQuery({ queryKey: ['doujin-providers'], queryFn: api.doujinProviders, staleTime: Infinity });
  const sources = React.useMemo(
    () => (providerList && providerList.length > 0 ? providerList.map((p) => ({ id: p.id, label: p.name })) : FALLBACK_SOURCES),
    [providerList],
  );
  const sourceSearch = initialSearches[source];
  const [query, setQuery] = React.useState(() => linkedQuery ?? sourceSearch?.query ?? '');
  const [searchKey, setSearchKey] = React.useState<string | null>(() => {
    if (linkedQuery !== null) return linkedQuery.trim() || null;
    return sourceSearch?.searchKey?.trim() || null;
  });
  // Restore the source's sort alongside its search, including the legacy cache.
  const [sort, setSort] = React.useState<DoujinSort>(() => {
    const saved = sourceSearch?.sort;
    return sortsFor(source).some(option => option.value === saved) ? saved! : 'default';
  });
  const searches = React.useRef<DownloaderStateCache['searches']>(initialSearches);
  function rememberSearch() {
    searches.current = { ...searches.current, [source]: { query, searchKey, sort } };
  }
  const deepLink = JSON.stringify([searchParams.get('source'), linkedQuery]);
  const previousDeepLink = React.useRef(deepLink);
  React.useEffect(() => {
    if (deepLink === previousDeepLink.current) return;
    previousDeepLink.current = deepLink;
    const linkedSource = searchParams.get('source');
    const nextSource = linkedSource === 'nhentai' || linkedSource === 'hitomi' ? linkedSource : source;
    const nextQuery = searchParams.get('q');
    if (nextQuery === null) return;
    const trimmed = nextQuery.trim();
    rememberSearch();
    setSource(nextSource);
    setQuery(nextQuery);
    setSearchKey(trimmed || null);
    setSort((current) => sortsFor(nextSource).some((option) => option.value === current) ? current : 'default');
    setSelected(null);
  }, [deepLink, searchParams, source]);
  const [selected, setSelected] = React.useState<DoujinSearchResult | null>(null);

  // Multi-select mode for merged downloads (mirrors the Libraries page). Selection
  // is keyed `${source}:${galleryId}` and persists across result pages; a fresh
  // search resets it. Click order defines chapter numbering for merges.
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedGalleries, setSelectedGalleries] = React.useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [mergePending, setMergePending] = React.useState(false);
  const mergePendingRef = React.useRef(false);
  const [mergeItems, setMergeItems] = React.useState<DoujinSearchResult[]>([]);
  const [mergeResult, setMergeResult] = React.useState<MergeDownloadResult | null>(null);
  const [selectionHeight, setSelectionHeight] = React.useState(0);
  const [mergeIntoOpen, setMergeIntoOpen] = React.useState(false);

  const { startDownload } = useDownloadActions();
  const { checkDuplicates, reviewCheck, dialog: duplicateDialog } = useDuplicateReview();
  const downloadSettings = useQuery({ queryKey: ['downloader-settings'], queryFn: api.downloaderSettings });
  const setup: DownloadSetup = {
    status: downloadSettings.isError ? 'error' : !downloadSettings.data ? 'loading' : downloadSettings.data.downloadDirectory.trim() ? 'ready' : 'missing',
    directory: downloadSettings.data?.downloadDirectory,
    format: downloadSettings.data?.format,
    onRetry: () => { void downloadSettings.refetch(); },
  };
  const downloadStatus = setup.status;
  const ensureDownloadReady = React.useCallback(() => {
    if (downloadStatus === 'ready') return true;
    if (downloadStatus === 'missing') navigate(DOWNLOADER_SETTINGS_URL);
    else toast({ tone: 'info', title: downloadStatus === 'loading' ? 'Checking download settings' : 'Download settings unavailable', description: 'Retry the settings check before starting a download.' });
    return false;
  }, [downloadStatus, navigate]);
  const { tasks } = useDownloads();
  const activeTasksByGallery = React.useMemo(() => {
    const byGallery = new Map<string, DownloadTask>();
    for (const task of tasks) {
      if (task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') {
        byGallery.set(`${task.source}:${task.galleryId}`, task);
      }
    }
    return byGallery;
  }, [tasks]);
  const [suggestions, setSuggestions] = React.useState<DoujinSuggestion[]>([]);
  const [suggLoading, setSuggLoading] = React.useState(false);
  const [inputFocused, setInputFocused] = React.useState(false);
  const [highlight, setHighlight] = React.useState(-1);
  const inputRef = React.useRef<HTMLInputElement>(null);

  /**
   * Extract the "active word" being typed at the caret so we can suggest tags for
   * just that token (like nhentai.net), rather than the whole query string. This
   * lets you build multi-tag filters such as `artist:"konboi" language:english`.
   */
  function activeSeed(): string {
    const el = inputRef.current;
    const full = el ? el.value : query;
    const caret = el && document.activeElement === el ? (el.selectionStart ?? full.length) : full.length;
    const { start } = activeTermBounds(full, caret);
    let seed = full.slice(start, caret);
    if (seed.includes(':')) seed = seed.slice(seed.indexOf(':') + 1);
    return seed.replace(/^[\s"']+|[\s"']+$/g, '');
  }

  // Debounced tag/artist autocomplete for the active token. Only nHentai implements
  // `suggest`, so the dropdown stays empty for Hitomi (its search is unchanged).
  React.useEffect(() => {
    const seed = activeSeed();
    // The dropdown is only visible while the input has focus — skip the network
    // entirely when suggestions cannot be shown, but still drop stale state so
    // reopening the dropdown never flashes old tags.
    if (!inputFocused || seed.length < 2) {
      setSuggestions([]);
      setSuggLoading(false);
      return;
    }
    let cancelled = false;
    setSuggLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await api.doujinSuggestions(source, seed);
        if (!cancelled) {
          setSuggestions(Array.isArray(res) ? res : []);
          setHighlight(-1);
        }
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSuggLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, source, inputFocused]);

  // Top-of-page view tabs: search results vs. the download manager queue.
  type DownloaderTab = 'search' | 'recommend' | 'watched' | 'manager';
  const requestedTab = searchParams.get('tab');
  const tab: DownloaderTab = requestedTab === 'downloads' ? 'manager' : requestedTab === 'recommend' || requestedTab === 'watched' ? requestedTab : 'search';
  const setTab = (next: DownloaderTab) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === 'search') params.delete('tab');
      else params.set('tab', next === 'manager' ? 'downloads' : next);
      return params;
    }, { replace: true });
  };
  const { data: results, isFetching, isError: searchFailed, error: searchError, refetch: retrySearch } = useQuery({
    queryKey: ['doujin-search', source, searchKey, sort],
    queryFn: () => api.doujinSearch(source, searchKey!, sort),
    enabled: searchKey !== null && searchKey.trim().length > 0,
    // Refocusing the window must not re-scrape Hitomi/nHentai, and while a new
    // search loads the grid keeps the previous results instead of blanking.
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Galleries with a completed download task — powers the duplicate badges.
  // The downloads context invalidates this key when a task completes.
  const { data: completed } = useQuery({
    queryKey: ['downloads-completed'],
    queryFn: api.downloadsCompleted,
  });
  const downloadedAt = React.useMemo(
    () => new Map((completed ?? []).map((k) => [`${k.source}:${k.galleryId}`, k.finishedAt])),
    [completed],
  );

  // Saved watches correspond to the committed search represented by the visible
  // results, never to edits that have not been submitted yet.
  const { data: watches, refetch: refetchWatches } = useQuery({
    queryKey: ['watched-searches'],
    queryFn: api.watchedSearches,
    // toggleWatch refetches after add/remove and the cache survives tab
    // switches — no polling, and no fetch while the search tab is hidden.
    enabled: tab === 'search',
  });
  const watchedQuery = searchKey?.trim() ?? '';
  const currentWatch = (watches ?? []).find((w) => w.source === source && w.query === watchedQuery);

  async function toggleWatch() {
    const q = watchedQuery;
    if (!q) return;
    try {
      if (currentWatch) {
        await api.removeWatchedSearch(currentWatch.id);
        toast({ tone: 'info', title: 'Unwatched', description: `“${q}” on ${SOURCE_LABELS[source]} will no longer be checked.` });
      } else {
        await api.addWatchedSearch(source, q);
        toast({ tone: 'success', title: 'Watching search', description: `You'll get a Discord ping when “${q}” finds new results on ${SOURCE_LABELS[source]}.` });
      }
      await refetchWatches();
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not update watches', description: e instanceof Error ? e.message : String(e) });
    }
  }

  // Galleries the watches reported as new — polled while the Watched tab is
  // visible; a check can land new rows at any time in between.
  const { data: newGalleries, isFetching: feedLoading, isError: feedFailed, error: feedError, refetch: retryFeed } = useQuery({
    queryKey: ['watched-search-new'],
    queryFn: () => api.watchedSearchNew(200),
    enabled: tab === 'watched',
    refetchInterval: 60_000,
  });
  // Feed rows as gallery items for the shared card/selection machinery; the
  // detail modal fetches full metadata itself.
  const feedItems = React.useMemo<DoujinSearchResult[]>(
    () => (newGalleries ?? []).map((g) => ({ source: g.source, galleryId: g.galleryId, title: g.title, coverUrl: g.coverUrl ?? null, pageCount: g.pageCount, tags: [], artists: [] })),
    [newGalleries],
  );
  const feedMetaByKey = React.useMemo(() => {
    const m = new Map<string, { query: string; foundAt: string }>();
    for (const g of newGalleries ?? []) m.set(`${g.source}:${g.galleryId}`, { query: g.query, foundAt: g.foundAt });
    return m;
  }, [newGalleries]);
  const [feedPage, setFeedPage] = React.useState(1);
  const feedPageCount = Math.max(1, Math.ceil(feedItems.length / RESULTS_PAGE_SIZE));
  const feedCurPage = Math.min(feedPage, feedPageCount);
  const feedPageItems = feedItems.slice((feedCurPage - 1) * RESULTS_PAGE_SIZE, feedCurPage * RESULTS_PAGE_SIZE);

  // Daily recommendations: stable per local date (server caches the day's set),
  // so no polling — a manual refresh re-rolls with a fresh seed.
  const qc = useQueryClient();
  const { data: recs, isFetching: recsLoading, isError: recsFailed, error: recsError, refetch: refetchRecs } = useQuery({
    queryKey: ['recommendations'],
    queryFn: api.recommendations,
    enabled: tab === 'recommend',
  });
  const [recsRefreshing, setRecsRefreshing] = React.useState(false);
  async function doRefreshRecs() {
    setRecsRefreshing(true);
    try {
      const refreshed = await api.refreshRecommendations();
      qc.setQueryData(['recommendations'], refreshed);
      toast({ tone: 'success', title: 'Fresh picks ready' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not refresh recommendations', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecsRefreshing(false);
    }
  }

  const ownedKeys = React.useMemo(
    () => new Set(recs?.ownedKeys ?? []),
    [recs],
  );
  const visibleRecs = recs?.items ?? [];
  const [dismissedGalleries, setDismissedGalleries] = React.useState<DoujinSearchResult[]>([]);
  const [feedbackPending, setFeedbackPending] = React.useState<string | null>(null);
  const [feedbackItem, setFeedbackItem] = React.useState<DoujinSearchResult | null>(null);
  const feedbackQuery = useQuery({ queryKey: ['recommendation-feedback'], queryFn: api.recommendationFeedback, enabled: tab === 'recommend' });
  const updateFeedback = React.useCallback(async (request: FeedbackRequest) => {
    setFeedbackPending(`${request.source}:${request.galleryId}`);
    try {
      const result = await api.saveRecommendationFeedback(request);
      qc.setQueryData(['recommendation-feedback'], result.feedback);
      qc.setQueryData(['recommendations'], result.recommendations);
      setFeedbackItem(null);
      const title = { like: 'More like this saved', unlike: 'Preference removed', 'mute-artist': 'Artist muted', 'unmute-artist': 'Artist unmuted' }[request.action];
      toast({ tone: 'success', title, description: request.action === 'like' || request.action === 'unlike' ? 'Refresh picks to use your updated preferences.' : undefined });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save recommendation feedback', description: error instanceof Error ? error.message : String(error) });
    } finally { setFeedbackPending(null); }
  }, [qc]);
  const doDismissGallery = React.useCallback(async (item: DoujinSearchResult) => {
    const key = `${item.source}:${item.galleryId}`;
    setFeedbackPending(key);
    try {
      const replacement = await api.dismissGallery({ source: item.source, galleryId: item.galleryId });
      qc.setQueryData(['recommendations'], replacement);
      setDismissedGalleries((current) => [...current.filter((gallery) => `${gallery.source}:${gallery.galleryId}` !== key), item]);
      setFeedbackItem(null);
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not dismiss gallery', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFeedbackPending(null);
    }
  }, [qc]);
  async function undoDismissGallery(item: DoujinSearchResult) {
    const key = `${item.source}:${item.galleryId}`;
    setFeedbackPending(key);
    try {
      const replacement = await api.undoDismissGallery({ source: item.source, galleryId: item.galleryId });
      qc.setQueryData(['recommendations'], replacement);
      setDismissedGalleries((current) => current.filter((gallery) => `${gallery.source}:${gallery.galleryId}` !== key));
      toast({ tone: 'success', title: 'Dismissal undone', description: 'This gallery can be recommended again.' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not undo dismissal', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFeedbackPending(null);
    }
  }

  // Completed-download changes can affect eligibility and the taste profile.
  // Invalidate inactive recommendations without fetching until the tab opens.
  const completedFingerprint = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!completed) return;
    const next = completed.map((gallery) => `${gallery.source}:${gallery.galleryId}:${gallery.finishedAt}`).sort().join('|');
    if (completedFingerprint.current !== null && completedFingerprint.current !== next) {
      void qc.invalidateQueries({ queryKey: ['recommendations'] });
    }
    completedFingerprint.current = next;
  }, [completed, qc]);

  // Which Kavita libraries feed the recommendation profile (per-library opt-out).
  const { data: recLibs } = useQuery({ queryKey: ['recommendation-libraries'], queryFn: api.recommendationLibraries, enabled: tab === 'recommend' });
  const { data: recSettings, refetch: refetchRecSettings } = useQuery({ queryKey: ['recommendation-settings'], queryFn: api.recommendationSettings, enabled: tab === 'recommend' });
  const [recLibraryPending, setRecLibraryPending] = React.useState<number | null>(null);
  async function toggleRecLibrary(lib: { id: number; name: string }) {
    setRecLibraryPending(lib.id);
    const excluded = new Set(recSettings?.excludedLibraryIds ?? []);
    if (excluded.has(lib.id)) excluded.delete(lib.id);
    else excluded.add(lib.id);
    try {
      await api.saveRecommendationSettings({ excludedLibraryIds: [...excluded] });
      // The server invalidates today's cached set — refetching re-rolls the picks.
      await Promise.all([refetchRecSettings(), refetchRecs()]);
      toast({ tone: 'success', title: `“${lib.name}” ${excluded.has(lib.id) ? 'excluded from' : 'added to'} recommendations`, description: 'Your picks now use the selected libraries.' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not update libraries', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecLibraryPending(null);
    }
  }

  // Tracks every gallery whose start request is in flight. A set preserves the
  // indicators when downloads are queued concurrently from different surfaces.
  const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(new Set());

  // Results are fetched in full (up to ~1000 galleries) and paged client-side —
  // rendering every card at once is the heaviest thing this page can do.
  const [page, setPage] = React.useState(() => linkedQuery !== null ? 1 : Math.max(1, initialState.page ?? 1));
  const searchMounted = React.useRef(false);
  React.useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return;
    }
    setPage(1);
    setSelectedGalleries(new Set());
    setSelectMode(false);
  }, [searchKey, source]);
  React.useEffect(() => {
    // Debounced so typing a long query does not serialize to sessionStorage on
    // every keystroke; the timer resets per change and clears on unmount.
    const t = window.setTimeout(() => {
      searches.current = { ...searches.current, [source]: { query, searchKey, sort } };
      writeDownloaderState({ source, query, searchKey, sort, page, searches: searches.current });
    }, 300);
    return () => window.clearTimeout(t);
  }, [source, query, searchKey, sort, page]);


  // Item-argument style and stable (startDownload is stable, state updates are
  // functional) so memoized GalleryCards can keep this reference.
  const doStartDownload = React.useCallback(async (item: DoujinSearchResult) => {
    if (!ensureDownloadReady()) return;
    const key = `${item.source}:${item.galleryId}`;
    setPendingKeys((current) => new Set(current).add(key));
    try {
      const approved = await checkDuplicates([item]);
      if (approved === null) return;
      const input = { source: item.source, galleryId: item.galleryId, title: item.title ?? undefined, allowDuplicate: approved.has(key) };
      try { await startDownload(input); }
      catch (error) {
        if (!(error instanceof ApiError) || error.message !== 'possible-duplicate') throw error;
        const approval = await reviewCheck(error.details as unknown as DuplicateCheck);
        if (approval !== null) await startDownload({ ...input, allowDuplicate: approval.has(key) });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'already-downloaded') {
        toast({ tone: 'info', title: 'Already downloaded', description: 'This gallery has already been downloaded. Open Downloads and choose Download again to get another copy.' });
      } else if (msg === 'Could not check for duplicates') {
        toast({ tone: 'danger', title: 'Could not check for duplicates', description: 'Retry the download to check again.' });
      } else if (msg !== 'already-queued') {
        toast({ tone: 'danger', title: 'Could not start download', description: downloadErrorHelp(msg).message });
      }
    } finally {
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [startDownload, ensureDownloadReady, checkDuplicates, reviewCheck]);

  // Item-argument style + setter-only closure (see GalleryCard memo).
  const toggleGallerySelect = React.useCallback((item: DoujinSearchResult) => {
    const key = `${item.source}:${item.galleryId}`;
    setSelectedGalleries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Selected galleries in click order — the order chapter numbers are assigned.
  // Selections can come from either results grid (search or "Recently added");
  // a gallery present in live search results keeps its richer metadata.
  const selectableGalleries = React.useMemo(() => indexSelectableGalleries(results ?? EMPTY_GALLERIES, feedItems), [results, feedItems]);
  const selectedItems = React.useMemo(() => selectedGalleryItems(selectableGalleries, selectedGalleries), [selectableGalleries, selectedGalleries]);

  const openMergedDownload = React.useCallback(() => {
    if (!selectedItems.length) return;
    // Snapshot click order so successful requests never shift remaining chapters.
    setMergeItems(selectedItems);
    setMergeResult(null);
    setMergeOpen(true);
  }, [selectedItems]);
  const openMergeInto = React.useCallback(() => setMergeIntoOpen(true), []);
  const clearSelection = React.useCallback(() => setSelectedGalleries(new Set()), []);
  const cancelSelection = React.useCallback(() => { setSelectedGalleries(new Set()); setSelectMode(false); }, []);

  const showSelection = (tab === 'search' || tab === 'watched') && (selectMode || selectedGalleries.size > 0);
  const selectionActions = {
    items: selectedItems,
    onMerge: openMergedDownload,
    onMergeInto: openMergeInto,
    onRemove: toggleGallerySelect,
    onClear: clearSelection,
    onCancel: cancelSelection,
  };

  /** Queue only unfinished entries, keeping failed items and all merge inputs. */
  async function doMergedDownload(folder: string, numbers: (number | null)[]) {
    if (mergePendingRef.current || !ensureDownloadReady() || setup.format !== 'cbz') return;
    if (!mergeItems.length) return;
    mergePendingRef.current = true;
    setMergePending(true);
    const queuedKeys = [...(mergeResult?.queuedKeys ?? [])];
    const skippedKeys = [...(mergeResult?.skippedKeys ?? [])];
    const settled = new Set([...queuedKeys, ...skippedKeys]);
    const failures: MergeDownloadResult['failures'] = [];
    try {
      const approved = await checkDuplicates(mergeItems.filter(item => !settled.has(`${item.source}:${item.galleryId}`)));
      if (approved === null) return;
      for (let i = 0; i < mergeItems.length; i++) {
        const item = mergeItems[i];
        const key = `${item.source}:${item.galleryId}`;
        if (settled.has(key)) continue;
        try {
          await startDownload({ source: item.source, galleryId: item.galleryId, title: item.title ?? undefined, mergeFolder: folder, chapter: numbers[i] ?? undefined, allowDuplicate: approved.has(key) });
          queuedKeys.push(key);
          settled.add(key);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === 'already-downloaded' || message === 'already-queued') {
            skippedKeys.push(key);
            settled.add(key);
          } else failures.push({ key, message: downloadErrorHelp(message).message });
        }
      }
      setMergeResult({ queuedKeys, skippedKeys, failures });
      setSelectedGalleries(current => new Set([...current].filter(key => !settled.has(key))));
      if (!failures.length) {
        setSelectMode(false);
        setMergeOpen(false);
        toast({
          tone: queuedKeys.length ? 'success' : 'info',
          title: queuedKeys.length ? 'Merged downloads queued' : 'Galleries already owned or queued',
          description: `${queuedKeys.length} queued${skippedKeys.length ? ` · ${skippedKeys.length} already owned or queued` : ''} → “${folder}”`,
        });
      }
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not check selected galleries', description: error instanceof Error ? error.message : String(error) });
    } finally {
      mergePendingRef.current = false;
      setMergePending(false);
    }
  }

  function selectSuggestion(s: DoujinSuggestion) {
    const el = inputRef.current;
    const q = s.filter ?? s.name;
    const full = el ? el.value : query;
    const caret = el && document.activeElement === el ? (el.selectionStart ?? full.length) : full.length;
    const { start, end } = activeTermBounds(full, caret);
    const prefix = full.slice(0, start);
    const suffix = full.slice(end);
    const newQuery = prefix + q + suffix + (suffix ? '' : ' ');
    const nextCaret = prefix.length + q.length + (suffix ? 0 : 1);
    setQuery(newQuery);
    setSuggestions([]);
    setHighlight(-1);
    // Keep focus and park the caret after the inserted filter, before any later terms.
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      try {
        node.setSelectionRange(nextCaret, nextCaret);
      } catch {
        /* ignore */
      }
    });
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(suggestions.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? Math.max(0, suggestions.length - 1) : h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight >= 0 && suggestions[highlight]) selectSuggestion(suggestions[highlight]);
      else commitQuery(query);
    } else if (e.key === 'Escape') {
      setSuggestions([]);
      setHighlight(-1);
    }
  }

  const showDropdown = inputFocused && (suggestions.length > 0 || suggLoading);

  // Commit a search. The query is sent verbatim (trimmed), matching how the
  // sources' own search boxes behave — Hitomi defaults to "all languages" unless
  // the user adds an explicit `language:` filter.
  function commitQuery(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setSearchKey(trimmed);
  }

  /**
   * Run a fresh search for a single tag/artist clicked in the details card.
   * Replaces the search bar with just that fragment and commits it immediately,
   * then closes the modal so the new results are visible. The fragment is built
   * for the gallery's own source, so jump to that source's search tab — the
   * details card also opens from the Recommended tab, where the active source
   * may be the other one.
   */
  function searchTagFragment(fragment: string, itemSource?: DoujinSource) {
    const trimmed = fragment.trim();
    if (!trimmed) return;
    rememberSearch();
    if (itemSource && itemSource !== source) {
      setSource(itemSource);
      // Drop a sort the target source does not offer so the dropdown never
      // shows a value with no matching option.
      if (!sortsFor(itemSource).some((s) => s.value === sort)) setSort('default');
    }
    setTab('search');
    setQuery(trimmed);
    setSearchKey(trimmed);
    setSuggestions([]);
    setHighlight(-1);
    setSelected(null);
  }

  // Source syntax differs: each source keeps its own unmodified draft and search.
  function switchSource(next: DoujinSource) {
    if (next === source) return;
    rememberSearch();
    const saved = searches.current?.[next];
    setQuery(saved?.query ?? '');
    setSearchKey(saved?.searchKey ?? null);
    setSort(saved && sortsFor(next).some(option => option.value === saved.sort) ? saved.sort : 'default');
    setSuggestions([]);
    setHighlight(-1);
    setSource(next);
    // A consumed deep link must not overwrite the restored draft on refresh.
    setSearchParams(current => {
      const params = new URLSearchParams(current);
      params.delete('q');
      params.delete('source');
      return params;
    }, { replace: true });
  }

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    commitQuery(query);
  };

  const pageCount = Math.max(1, Math.ceil((results?.length ?? 0) / RESULTS_PAGE_SIZE));
  const curPage = Math.min(page, pageCount);

  function changePage(nextPage: number) {
    setPage(nextPage);
    document.querySelector('main')?.scrollTo({ top: 0 });
  }
  const pageItems = results ? results.slice((curPage - 1) * RESULTS_PAGE_SIZE, curPage * RESULTS_PAGE_SIZE) : [];
  const matchItems = tab === 'search' ? pageItems : tab === 'recommend' ? visibleRecs : tab === 'watched' ? feedPageItems : [];
  const matchQuery = useQuery({
    queryKey: ['gallery-library-matches', matchItems.map(({ source, galleryId, title, artists, language, pageCount }) => ({ source, galleryId, title, artists, language, pageCount }))],
    queryFn: () => api.libraryMatches(matchItems),
    enabled: matchItems.length > 0,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const libraryMatches = new Map((matchQuery.data?.reports ?? []).map(report => [
    `${report.source}:${report.galleryId}`,
    report.matches.some(match => match.confirmed && ['In library', 'Owned', 'completed'].includes(match.status)) ? 'owned' as const : report.matches.length ? 'possible' as const : undefined,
  ]));
  const galleryMotionRef = useDownloaderTransitions(`${tab}:${pageItems.map(item => `${item.source}:${item.galleryId}`).join(',')}:${visibleRecs.map(item => `${item.source}:${item.galleryId}`).join(',')}:${feedPageItems.map(item => `${item.source}:${item.galleryId}`).join(',')}:${selectMode}:${[...selectedGalleries].join(',')}`);

  return (
    <div ref={galleryMotionRef} className={cn('flex flex-col gap-4', showSelection && 'pb-[calc(var(--selection-tray-height,0px)+1rem)] lg:pb-0')} style={{ '--selection-tray-height': `${selectionHeight}px` } as React.CSSProperties}>
      <PageHeader icon={<ListVideo className="h-5 w-5" />} title="Doujinshi Downloader" subtitle="Search Hitomi.la and nHentai, then download galleries into your Kavita library." />
      <DownloadDestination setup={setup} />

      <SegmentedTabs
        items={[{ id: 'search' as const, label: 'Search' }, { id: 'recommend' as const, label: 'Recommended' }, { id: 'watched' as const, label: 'Watched' }, { id: 'manager' as const, label: 'Downloads' }]}
        value={tab}
        onChange={setTab}
        label="Downloader sections"
        panelId="downloader-panel"
        className="sticky top-0 z-10 self-start bg-background"
      />
      <TabPanel value={tab} id="downloader-panel" role="tabpanel" aria-labelledby={`downloader-panel-tab-${tab}`}>

      {tab === 'search' && (<>

      {/* Search bar */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={runSearch} className="flex flex-col gap-2 lg:flex-row">
            <div className="flex min-w-0 flex-1 gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input
                  ref={inputRef}
                  role="combobox"
                  aria-label="Search galleries"
                  aria-expanded={showDropdown}
                  aria-controls="doujin-suggestions"
                  aria-activedescendant={highlight >= 0 ? `doujin-suggestion-${highlight}` : undefined}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => { setInputFocused(false); setHighlight(-1); }}
                  placeholder="Search by keyword, tag, artist, gallery ID or URL…"
                  className="pl-9 pr-11"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear search input"
                    className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded text-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}

                {showDropdown && (
                  <div id="doujin-suggestions" role="listbox" className="absolute left-0 right-0 top-full z-50 mt-1 origin-top animate-scale-in overflow-hidden rounded-md border border-border bg-surface shadow-lg">
                    {suggLoading && suggestions.length === 0 ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
                        <Spinner /> Searching tags…
                      </div>
                    ) : (
                      <div className="max-h-80 overflow-y-auto py-1">
                        {suggestions.map((s, i) => (
                          <button
                            key={`${s.type}-${s.name}`}
                            type="button"
                            id={`doujin-suggestion-${i}`}
                            role="option"
                            aria-selected={i === highlight}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => selectSuggestion(s)}
                            onMouseEnter={() => setHighlight(i)}
                            className={cn(
                              'flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm',
                              i === highlight ? 'bg-surface-2' : 'hover:bg-surface-2',
                            )}
                          >
                            <span
                              className={cn(
                                'shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
                                SUGG_TYPE_STYLES[s.type] ?? 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/20 dark:text-slate-300',
                              )}
                            >
                              {s.type}
                            </span>
                            <span className="truncate">{s.name}</span>
                            {typeof s.count === 'number' && <span className="text-xs text-muted">{s.count}</span>}
                            <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <Button className="shrink-0" type="submit" disabled={isFetching || !query.trim()}>
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
              </Button>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)] gap-2 lg:flex lg:shrink-0">
              <SegmentedControl items={sources} value={source} onChange={switchSource} label="Download source" className="lg:shrink-0" itemClassName="px-2 text-xs sm:px-3 sm:text-sm" />
              {/* Popularity ordering — mirrors each source's own sort controls. The
                  sort travels as a separate field, so its syntax never appears in the search box. */}
              {sortsFor(source).length > 1 && (
                <Select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as DoujinSort)}
                  aria-label="Sort results"
                  className="min-w-0 w-full shrink-0 text-xs sm:text-sm lg:w-40"
                >
                  {sortsFor(source).map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </Select>
              )}
            </div>
          </form>
          <p className="text-xs text-muted">Each source remembers its own search and filters.</p>
        </CardContent>
      </Card>

      {/* Before the first search there is nothing below the bar — give it a purpose. */}
      {searchKey === null && (
        <Card className="flex items-center justify-center">
          <EmptyState icon={<Search className="h-8 w-8" />} title="Search for galleries" description="Keyword, tag, artist, gallery ID or URL. Use Watch to keep checking a query — new releases land in the Watched tab and ping Discord." />
        </Card>
      )}

      {/* Results grid */}
      {searchKey !== null && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p role="status" className="min-w-0 w-full text-sm text-muted min-[420px]:w-auto min-[420px]:flex-1">
              {isFetching ? 'Searching…' : results ? results.length + (results.length === 1 ? ' gallery' : ' galleries') + ' found on ' + SOURCE_LABELS[source] : 'Search results'}
              {!isFetching && pageCount > 1 && ' · ' + ((curPage - 1) * RESULTS_PAGE_SIZE + 1) + '–' + Math.min(curPage * RESULTS_PAGE_SIZE, results?.length ?? 0)}
            </p>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                aria-pressed={!!currentWatch}
                variant={currentWatch ? 'secondary' : 'outline'}
                onClick={() => void toggleWatch()}
                disabled={!watchedQuery}
                title={currentWatch ? `Stop watching “${watchedQuery}”` : watchedQuery ? `Watch the displayed results for “${watchedQuery}”` : 'Search first to watch these results'}
              >
                <Star className={cn('h-4 w-4', currentWatch && 'fill-current')} /> {currentWatch ? 'Watching' : 'Watch'}
              </Button>
              {!!results?.length && (
                <Button size="sm" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode(m => !m)} title="Select galleries to download together or merge into an existing series">
                  <CheckSquare className="h-3.5 w-3.5" /> {selectMode ? 'Done selecting' : 'Select to merge'}
                </Button>
              )}
            </div>
          </div>
          {searchFailed ? (
            <ErrorState title="Search failed" description={searchError instanceof Error ? searchError.message : String(searchError)} onRetry={() => void retrySearch()} />
          // placeholderData keeps the previous grid mounted during a refetch —
          // the spinner only shows before any results exist.
          ) : isFetching && !results ? (
            <div role="status" aria-label={`Searching ${SOURCE_LABELS[source]}`} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface">
                  <Skeleton className="aspect-[3/4] w-full rounded-none" />
                  <div className="flex flex-col gap-2 p-3">
                    <Skeleton className="h-4 w-4/5" />
                    <div className="flex flex-wrap gap-1">
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-5 w-20 rounded-full" />
                      <Skeleton className="h-5 w-14 rounded-full" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-3 pt-2">
                    <Skeleton className="h-5 w-20 rounded-full" />
                    <Skeleton className="h-7 w-24 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          ) : results && results.length > 0 ? (
            <>
              {showSelection && <GallerySelectionBar {...selectionActions} />}
              <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {pageItems.map(item => (
                  <GalleryCard
                    key={item.source + item.galleryId}
                    item={item}
                    selectMode={selectMode}
                    selected={selectedGalleries.has(`${item.source}:${item.galleryId}`)}
                    onToggleSelect={toggleGallerySelect}
                    onOpen={setSelected}
                    task={activeTasksByGallery.get(`${item.source}:${item.galleryId}`)}
                    starting={pendingKeys.has(`${item.source}:${item.galleryId}`)}
                    downloadedAt={downloadedAt.get(`${item.source}:${item.galleryId}`)}
                    libraryMatch={libraryMatches.get(`${item.source}:${item.galleryId}`)}
                    onDownload={doStartDownload}
                    downloadSetup={downloadStatus}
                  />
                ))}
              </div>
              <Pager page={curPage} count={pageCount} onPageChange={changePage} />
            </>
          ) : (
            <EmptyState icon={<Search className="h-8 w-8" />} title="No results" description={`No galleries found for “${searchKey}” on ${SOURCE_LABELS[source]}.`} />
          )}
        </div>
      )}

      </>)
      }

      {/* Daily recommendations */}
      {tab === 'recommend' && (
        <div className="flex flex-col gap-4">
          <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {recLibs && recLibs.length > 0 && (
                <div role="group" aria-label="Libraries used for recommendations" className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="mr-1 text-xs font-medium text-muted">Use libraries</span>
                  {recLibs.map((lib) => {
                    const excluded = (recSettings?.excludedLibraryIds ?? []).includes(lib.id);
                    return (
                      <Button
                        key={lib.id}
                        size="sm"
                        variant="outline"
                        aria-pressed={!excluded}
                        disabled={!recSettings || recLibraryPending !== null || recsRefreshing || feedbackPending !== null || recsLoading}
                        onClick={() => void toggleRecLibrary(lib)}
                        title={excluded ? `Include ${lib.name} in your recommendations` : `Exclude ${lib.name} from your recommendations`}
                        className={cn('min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 max-w-full', excluded ? 'text-muted' : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15')}
                      >
                        {recLibraryPending === lib.id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', excluded && 'opacity-0')} aria-hidden="true" />}
                        <span className="truncate">{lib.name}</span>
                      </Button>
                    );
                  })}
                </div>
              )}
              <div className="grid grid-cols-2 items-center gap-2 sm:ml-auto sm:flex sm:shrink-0 sm:flex-wrap">
                {recs?.mode === 'popular' && <span className="col-span-2 w-fit"><Badge tone="muted">Popular picks</Badge></span>}
                {recs?.mode === 'mixed' && <span className="col-span-2 w-fit"><Badge tone="muted">Personalized + popular</Badge></span>}
                <RecommendationFeedbackManager feedback={feedbackQuery.data} pending={feedbackPending !== null || recsRefreshing || recLibraryPending !== null || recsLoading} onAction={request => void updateFeedback(request)} />
                <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 w-full sm:w-auto" onClick={() => void doRefreshRecs()} disabled={recsRefreshing || recLibraryPending !== null || feedbackPending !== null || recsLoading} title="Get a fresh selection of recommendations">
                  <RotateCcw className={cn('h-3.5 w-3.5 shrink-0', recsRefreshing && 'animate-spin')} /> {recsRefreshing ? 'Refreshing…' : 'Refresh picks'}
                </Button>
              </div>
            </div>
            {recs?.degradedReason === 'same-day-pool-exhausted' && (
              <p className="text-xs text-muted">You’ve seen all of today’s fresh picks. Some earlier recommendations may appear again.</p>
            )}
            {recs?.degradedReason === 'insufficient-eligible' && (
              <p className="text-xs text-muted">Only {recs.items.length} picks are available with your current preferences and exclusions.</p>
            )}
            {recs && (recs.profile.artists.length > 0 || recs.profile.tags.length > 0 || (recs.profile.series?.length ?? 0) > 0) && (
              <Disclosure label="What shapes these picks" className="border-t border-border pt-2" summaryClassName="px-0 text-xs">
                <div className="flex flex-col gap-2 pt-2">
                  {[
                    { label: 'Artists', values: recs.profile.artists },
                    { label: 'Tags', values: recs.profile.tags },
                    { label: 'Series', values: recs.profile.series ?? [] },
                  ].filter((group) => group.values.length > 0).map((group) => (
                    <div key={group.label} className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-xs text-muted">{group.label}</span>
                      {group.values.map((value) => <span key={value} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted" title={value}>{value}</span>)}
                    </div>
                  ))}
                </div>
              </Disclosure>
            )}
          </Card>

          {feedbackQuery.isError && <ErrorState title="Could not load recommendation feedback" description={feedbackQuery.error.message} onRetry={() => void feedbackQuery.refetch()} />}
          <p className="sr-only" role="status">{dismissedGalleries.length > 0 ? `${dismissedGalleries.length} dismissed galleries. Expand Dismissed galleries to undo.` : ''}</p>
          {dismissedGalleries.length > 0 && (
            <Disclosure label={<>Dismissed galleries <Badge tone="muted">{dismissedGalleries.length}</Badge></>} className="rounded-lg border border-border bg-surface" summaryClassName="p-3">
              <ul className="max-h-64 overflow-y-auto border-t border-border px-3">
                {dismissedGalleries.map((item) => (
                  <li key={`${item.source}:${item.galleryId}`} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                    <p className="min-w-0 flex-1 truncate text-sm" title={item.title}>{item.title}</p>
                    <Button size="sm" variant="ghost" className="max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0" onClick={() => void undoDismissGallery(item)} disabled={feedbackPending !== null || recsRefreshing} aria-label={`Undo dismissal of ${item.title}`}>
                      {feedbackPending === `${item.source}:${item.galleryId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Undo
                    </Button>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          {recsFailed ? (
            <ErrorState title="Recommendations failed" description={recsError instanceof Error ? recsError.message : String(recsError)} onRetry={() => void refetchRecs()} />
          ) : !recs && recsLoading ? (
            <div role="status" className="flex items-start justify-center gap-2 px-4 py-12 text-sm text-muted"><Spinner /><span className="max-w-sm">Building your picks — the first pass of the day can take a minute…</span>
            </div>
          ) : visibleRecs.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {visibleRecs.map(item => (
                <div key={item.source + item.galleryId} className="flex flex-col gap-1 [&>article]:flex-1">
                  <GalleryCard
                    item={item}
                    onOpen={setSelected}
                    task={activeTasksByGallery.get(`${item.source}:${item.galleryId}`)}
                    starting={pendingKeys.has(`${item.source}:${item.galleryId}`)}
                    downloadedAt={downloadedAt.get(`${item.source}:${item.galleryId}`)}
                    libraryMatch={libraryMatches.get(`${item.source}:${item.galleryId}`)}
                    onDownload={doStartDownload}
                    downloadSetup={downloadStatus}
                    owned={ownedKeys.has(`${item.source}:${item.galleryId}`)}
                    onFeedback={setFeedbackItem}
                    dismissing={feedbackPending !== null || recsRefreshing || recLibraryPending !== null || recsLoading}
                    showSource={false}
                    showTags={false}
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Sparkles className="h-8 w-8" />} title="No picks available" description="Hitomi returned no eligible galleries — try refreshing, or check back later." />
          )}
        </div>
      )}

      {/* Watched searches — two stacked sections: the "Recently added" feed, then the watch list */}
      {tab === 'watched' && (
        <div className="flex flex-col gap-4">
          <section aria-label="Recently added" className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Recently added</h2>
            {feedFailed ? (
              <ErrorState title="Could not load recently added galleries" description={feedError instanceof Error ? feedError.message : String(feedError)} onRetry={() => void retryFeed()} />
            ) : !newGalleries && feedLoading ? (
              <div role="status" className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-muted">
                <Spinner /> Loading recently added galleries…
              </div>
            ) : feedItems.length > 0 ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <p className="min-w-0 w-full text-sm text-muted min-[420px]:w-auto min-[420px]:flex-1">
                    {feedItems.length} {feedItems.length === 1 ? 'gallery' : 'galleries'} found by your watched searches — newest first
                  </p>
                  <Button size="sm" className="ml-auto shrink-0" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode(m => !m)} title="Select galleries to download together or merge into an existing series">
                    <CheckSquare className="h-3.5 w-3.5" /> {selectMode ? 'Done selecting' : 'Select to merge'}
                  </Button>
                </div>
                {showSelection && <GallerySelectionBar {...selectionActions} />}
                <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {feedPageItems.map(item => {
                    const key = `${item.source}:${item.galleryId}`;
                    const meta = feedMetaByKey.get(key);
                    return (
                      <div key={key} className="flex flex-col gap-1 [&>article]:flex-1">
                        <GalleryCard
                          item={item}
                          selectMode={selectMode}
                          selected={selectedGalleries.has(key)}
                          onToggleSelect={toggleGallerySelect}
                          onOpen={setSelected}
                          task={activeTasksByGallery.get(key)}
                          starting={pendingKeys.has(key)}
                          downloadedAt={downloadedAt.get(key)}
                          libraryMatch={libraryMatches.get(key)}
                          onDownload={doStartDownload}
                          downloadSetup={downloadStatus}
                        />
                        {meta && (
                          <p className="break-words px-1 text-xs leading-snug text-muted line-clamp-2" title={`Found by watch “${meta.query}”`}>
                            via “{meta.query}” · {timeAgo(meta.foundAt)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Pager page={feedCurPage} count={feedPageCount} onPageChange={(p) => { setFeedPage(p); document.querySelector('main')?.scrollTo({ top: 0 }); }} />
              </>
            ) : (
              <EmptyState icon={<Star className="h-8 w-8" />} title="Nothing new yet" description="New results from your watched searches will appear here after the next check — add a watched search below if you haven't yet." />
            )}
          </section>
          <WatchedTab onOpenSearch={(src, q) => searchTagFragment(q, src)} />
        </div>
      )}
      {/* Merged download confirm — reachable from both results grids */}
      {mergeOpen && mergeItems.length > 0 && (
        <MergeDownloadDialog
          items={mergeItems}
          defaultFolder={folderNameFrom(mergeItems[0].title ?? '')}
          onClose={() => setMergeOpen(false)}
          onConfirm={(folder, numbers) => void doMergedDownload(folder, numbers)}
          setup={setup}
          pending={mergePending}
          result={mergeResult}
        />
      )}

      {/* Merge selected galleries into an existing Kavita series */}
      {mergeIntoOpen && selectedItems.length > 0 && (
        <MergeIntoSeriesDialog
          items={selectedItems}
          onClose={() => setMergeIntoOpen(false)}
          onQueued={(keys) => {
            const queued = new Set(keys);
            setSelectedGalleries(current => new Set([...current].filter(key => !queued.has(key))));
            setSelectMode(false);
          }}
          setup={setup}
        />
      )}

      {/* Gallery detail modal */}
      {feedbackItem && <GalleryFeedbackDialog item={feedbackItem} feedback={feedbackQuery.data} pending={feedbackPending !== null || recsRefreshing || recLibraryPending !== null || recsLoading} onClose={() => setFeedbackItem(null)} onAction={request => void updateFeedback(request)} onDismiss={() => void doDismissGallery(feedbackItem)} />}
      {selected && (
        <GalleryDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          checking={pendingKeys.has(`${selected.source}:${selected.galleryId}`)}
          downloading={activeTasksByGallery.has(`${selected.source}:${selected.galleryId}`)}
          downloaded={downloadedAt.has(`${selected.source}:${selected.galleryId}`) || libraryMatches.get(`${selected.source}:${selected.galleryId}`) === 'owned' || ownedKeys.has(`${selected.source}:${selected.galleryId}`)}
          inLibrary={libraryMatches.get(`${selected.source}:${selected.galleryId}`) === 'owned'}
          setup={setup}
          onDownload={() => doStartDownload(selected)}
          onSearchTag={searchTagFragment}
        />
      )}

      {/* Download manager — own component so live task ticks never re-render the page */}
      {tab === 'manager' && <ManagerTab />}

      </TabPanel>
      {showSelection && <GallerySelectionBar {...selectionActions} mobile onHeightChange={setSelectionHeight} />}
      {duplicateDialog}
    </div>
  );
}
