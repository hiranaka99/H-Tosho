import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Search,
  Download as DownloadIcon,
  Loader2,
  Pause,
  Play,
  XCircle,
  RotateCcw,
  Trash2,
  CheckCircle2,
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
  ChevronLeft,
  ChevronRight,
  Users,
  Layers,
  Star,
  Tags,
} from 'lucide-react';
import { api, type DoujinSource, type DoujinSort, type DoujinSearchResult, type DoujinSuggestion, type DownloadTask } from '../lib/api';
import { useDownloads } from '../lib/DownloadsContext';
import { cn, timeAgo, toIsoUtc } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, Select, EmptyState, Spinner, ProgressBar, Dialog, DialogContent, DialogTitle, DialogDescription, PageHeader, SegmentedTabs, ErrorState, ConfirmDialog } from '../components/ui';
import { ComicInfoModal } from '../components/ComicInfoModal';

const SOURCES: { id: DoujinSource; label: string }[] = [
  { id: 'hitomi', label: 'Hitomi.la' },
  { id: 'nhentai', label: 'nHentai' },
];

/**
 * Result ordering options for nHentai searches, mirroring nhentai.net's own
 * sort controls. Only shown for the nHentai source (Hitomi has no equivalent).
 */
const NHENTAI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: 'default', label: 'Newest' },
  { value: 'popular', label: 'Popular — all time' },
  { value: 'popular-week', label: 'Popular — this week' },
  { value: 'popular-today', label: 'Popular — today' },
];

/** Human-facing display name for a doujin source. */
const SOURCE_LABELS: Record<DoujinSource, string> = { hitomi: 'Hitomi.la', nhentai: 'nHentai' };

/**
 * Split a query into terms, keeping quoted values (nHentai style) intact so
 * `tag:"big breasts"` stays one term instead of breaking at the space.
 */
function splitTerms(query: string): string[] {
  const terms: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of query) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) terms.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) terms.push(cur);
  return terms;
}

/**
 * Translate a search query from one doujin source's syntax to the other's so a
 * search can be re-run against the new source. nHentai uses quoted values and
 * supports negation (`-term`); Hitomi uses underscores for multi-word tag values
 * and has no negation, so excluded terms are dropped when heading to Hitomi.
 * Gender tags map between the sources too: Hitomi files them under the
 * `female:`/`male:` areas while nHentai has a single ungendered `tag:` type, so
 * `tag:"gyaru"` becomes `female:gyaru` heading to Hitomi (its primary tag area)
 * and `female:gyaru`/`male:bald` become `tag:"…"` heading to nHentai.
 */
function translateQuery(query: string, from: DoujinSource, to: DoujinSource): string {
  if (from === to) return query;
  const trimmed = query.trim();
  if (!trimmed) return query;
  const out: string[] = [];
  for (const rawTerm of splitTerms(trimmed)) {
    let negated = false;
    let term = rawTerm;
    if (term.startsWith('-')) {
      negated = true;
      term = term.slice(1);
    }
    const colon = term.indexOf(':');
    const ns = colon > 0 ? term.slice(0, colon) : null;
    let val = colon > 0 ? term.slice(colon + 1) : term;
    // Strip surrounding quotes (nHentai style).
    val = val.replace(/^["']+|["']+$/g, '');

    if (to === 'hitomi') {
      // Hitomi has no negation → drop excluded terms.
      if (negated) continue;
      // Multi-word values become a single underscored token.
      val = val.replace(/\s+/g, '_');
    } else {
      // nHentai: tag values are always quoted (multi-word values keep spaces).
      val = `"${val.replace(/_/g, ' ')}"`;
    }
    // Remap the namespace where the two sources name the same concept differently.
    let area = ns;
    if (to === 'hitomi' && ns === 'tag') area = 'female';
    else if (to === 'nhentai' && (ns === 'female' || ns === 'male')) area = 'tag';
    out.push(area ? `${area}:${val}` : val);
  }
  return out.join(' ');
}

/**
 * Build a single-tag/artist search fragment from the details card, formatted for
 * the target source's query syntax. Hitomi uses bare underscored multi-word values
 * (e.g. `artist:charu_lee`); nHentai wraps values in quotes (e.g. `artist:"Charu Lee"`).
 * An empty namespace yields a plain keyword search on the raw value.
 */
export function buildTagSearchFragment(value: string, ns: string | null | undefined, source: DoujinSource): string {
  const v = value.trim();
  if (!v) return '';
  if (source === 'nhentai') {
    return ns ? `${ns}:"${v}"` : `"${v}"`;
  }
  const underscored = v.replace(/\s+/g, '_');
  return ns ? `${ns}:${underscored}` : underscored;
}

/** Badge color per suggestion tag type (mirrors the nHentai search dropdown). */
const SUGG_TYPE_STYLES: Record<string, string> = {
  artist: 'bg-violet-500/20 text-violet-300',
  group: 'bg-amber-500/25 text-amber-300',
  character: 'bg-pink-500/20 text-pink-300',
  parody: 'bg-blue-500/20 text-blue-300',
  series: 'bg-cyan-500/20 text-cyan-300',
  language: 'bg-emerald-500/20 text-emerald-300',
  category: 'bg-rose-500/20 text-rose-300',
  tag: 'bg-slate-500/25 text-slate-300',
};

function SourceBadge({ source }: { source: DoujinSource }) {
  const color = source === 'nhentai' ? '#e91e63' : '#ff5722';
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: color + '22', color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {SOURCE_LABELS[source]}
    </span>
  );
}

function Cover({ url, title, className }: { url?: string | null; title: string; className?: string }) {
  const [failed, setFailed] = React.useState(false);
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

/** Page numbers with ellipses: [1 … 4 5 6 … 42] style, capped to a sane width. */
function pageList(page: number, count: number): (number | '…')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(count - 1, page + 1);
  if (lo > 2) pages.push('…');
  for (let p = lo; p <= hi; p++) pages.push(p);
  if (hi < count - 1) pages.push('…');
  pages.push(count);
  return pages;
}

function formatSpeed(bps: number | null): string {
  if (!bps || bps <= 0) return '';
  const mb = bps / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
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
  return <>{map[status] ?? <Badge>{status}</Badge>}</>;
}

// ---------------- Gallery card ----------------
function GalleryCard({ item, onOpen, onDownload, downloading, index = 0, downloadedAt }: { item: DoujinSearchResult; onOpen: () => void; onDownload: () => void; downloading: boolean; index?: number; downloadedAt?: string | null }) {
  const tags = [...item.artists, ...item.tags].slice(0, 6);
  return (
    <article
      style={{ animationDelay: `${Math.min(index, 15) * 40}ms` }}
      className="group flex animate-fade-up flex-col overflow-hidden rounded-xl border border-border bg-surface transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:shadow-xl hover:shadow-black/30"
    >
      <button type="button" onClick={onOpen} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60" aria-label={`View details for ${item.title}`}>
        <div className="relative overflow-hidden">
          <Cover url={item.coverUrl} title={item.title} className="aspect-[3/4] w-full transition-transform duration-300 ease-out group-hover:scale-105" />
          {item.language && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
              <Languages className="h-3 w-3" /> {item.language}
            </span>
          )}
          {item.pageCount ? <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">{item.pageCount}p</span> : null}
          <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"><Search className="h-3 w-3" /> Details</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 p-3 pb-0">
          <p className="line-clamp-2 text-sm font-medium" title={item.title}>{item.title}</p>
          {tags.length > 0 && <div className="flex flex-wrap gap-1">{tags.map((t, i) => <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t}</span>)}</div>}
        </div>
      </button>
      <div className="mt-auto flex items-center justify-between gap-2 p-3 pt-2">
        <SourceBadge source={item.source} />
        <Button size="sm" onClick={onDownload} disabled={downloading || !!downloadedAt} aria-label={downloadedAt ? `${item.title} already downloaded` : `Download ${item.title}`}>
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : downloadedAt ? <CheckCircle2 className="h-3.5 w-3.5" /> : <DownloadIcon className="h-3.5 w-3.5" />}
          {downloadedAt ? 'Downloaded' : 'Download'}
        </Button>
      </div>
    </article>
  );
}

// ---------------- Gallery detail modal ----------------

const TAG_GROUP_STYLES: Record<string, string> = {
  Artists: 'bg-violet-500/20 text-violet-300',
  Groups: 'bg-amber-500/25 text-amber-300',
  Characters: 'bg-pink-500/20 text-pink-300',
  Series: 'bg-cyan-500/20 text-cyan-300',
  Tags: 'bg-slate-500/25 text-slate-300',
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
  const style = Object.entries(TAG_GROUP_STYLES).find(([k]) => label.startsWith(k))?.[1] ?? 'bg-slate-500/25 text-slate-300';
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
                'rounded-full px-2.5 py-1 text-xs transition-all',
                style,
                onSearch && 'cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
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
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function GalleryDetailModal({ item, onClose, onDownload, downloading, onSearchTag }: { item: DoujinSearchResult; onClose: () => void; onDownload: () => void; downloading: boolean; onSearchTag: (fragment: string) => void }) {
  const { data: gallery, isPending, isError, error } = useQuery({
    queryKey: ['doujin-gallery', item.source, item.galleryId],
    queryFn: () => api.doujinGallery(item.source, item.galleryId),
    staleTime: 5 * 60_000,
  });

  const g = gallery;

  /** Search a single tag/artist value (from the details card) on this source. */
  const searchFor = (value: string, ns?: string | null) => {
    const fragment = buildTagSearchFragment(value, ns, item.source);
    if (fragment) onSearchTag(fragment);
  };
  /** Tooltip showing the exact query a pill will run. */
  const searchTitle = (value: string, ns?: string | null) => {
    const fragment = buildTagSearchFragment(value, ns, item.source);
    return fragment ? `Search for “${fragment}”` : undefined;
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] flex-col gap-5 overflow-y-auto p-5 sm:flex-row">
          <div className="w-full shrink-0 sm:w-48">
            <Cover url={g?.coverUrl ?? item.coverUrl} title={item.title} className="mx-auto aspect-[3/4] w-40 rounded-md border border-border sm:w-full" />
            {g?.url && (
              <a href={g.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-primary">
                <ExternalLink className="h-3 w-3" /> View on {SOURCE_LABELS[item.source]}
              </a>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="min-w-0 pr-10">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <SourceBadge source={item.source} />
                {g?.language && <Badge tone="info"><Languages className="h-3 w-3" /> {g.language}</Badge>}
              </div>
              <DialogTitle className="text-lg leading-snug">{g?.title ?? item.title}</DialogTitle>
              <DialogDescription>Gallery details and download options.</DialogDescription>
            </div>

            {isPending && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted">
                <Spinner /> Loading gallery details…
              </div>
            )}

            {isError && (
              <div className="rounded-md bg-danger/10 p-3 text-sm text-danger">
                Failed to load details: {error instanceof Error ? error.message : String(error)}
              </div>
            )}

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
                <TagList label="Characters" items={g.genres} icon={<Star className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'character')} titleFor={(v) => searchTitle(v, 'character')} />
                {g.series && (
                  <div className="flex flex-col gap-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <BookOpen className="h-3 w-3" /> Series
                    </p>
                    <button
                      type="button"
                      onClick={() => searchFor(g.series ?? '', 'series')}
                      title={searchTitle(g.series ?? '', 'series')}
                      className="w-fit cursor-pointer rounded-full bg-cyan-500/20 px-2.5 py-1 text-xs text-cyan-300 transition-all hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {g.series}
                    </button>
                  </div>
                )}
                {g.tags?.length ? (
                  <TagList label={`Tags (${g.tags.length})`} items={g.tags} namespaces={g.tagNamespaces} icon={<Tags className="h-3 w-3" />} onSearch={(v, ns) => searchFor(v, ns)} titleFor={(v, ns) => searchTitle(v, ns)} />
                ) : null}

                <div className="mt-auto flex items-center justify-end gap-2 pt-2">
                  <Button variant="ghost" onClick={onClose}>
                    <X className="h-4 w-4" /> Close
                  </Button>
                  <Button onClick={onDownload} disabled={downloading}>
                    {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />} Download
                  </Button>
                </div>
              </>
            )}

            {!g && (
              <div className="mt-auto flex items-center justify-end gap-2 pt-2">
                <Button onClick={onDownload} disabled={downloading}>
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />} Download
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Queue row ----------------

function QueueRow({ task, onAction, onEditComicInfo, onDelete }: { task: DownloadTask; onAction: (a: 'pause' | 'resume' | 'cancel' | 'retry') => void; onEditComicInfo?: (path: string) => void; onDelete?: () => void }) {
  const pct = task.progressTotal > 0 ? Math.round((task.progressCurrent / task.progressTotal) * 100) : 0;
  return (
    <div className="flex animate-fade-up flex-col gap-2 rounded-lg border border-border p-3 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <DownloadStatusBadge status={task.status} />
          <span className="truncate text-sm font-medium" title={task.title ?? ''}>{task.title ?? `Gallery ${task.galleryId}`}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.status === 'downloading' && <Button size="icon" variant="ghost" aria-label="Pause download" onClick={() => onAction('pause')}><Pause className="h-4 w-4" /></Button>}
          {task.status === 'paused' && <Button size="icon" variant="ghost" aria-label="Resume download" onClick={() => onAction('resume')}><Play className="h-4 w-4" /></Button>}
          {task.status === 'failed' && <Button size="icon" variant="ghost" aria-label="Retry download" onClick={() => onAction('retry')}><RotateCcw className="h-4 w-4" /></Button>}
          {task.status === 'completed' && <Button size="icon" variant="ghost" aria-label="Download again" onClick={() => onAction('retry')}><RotateCcw className="h-4 w-4" /></Button>}
          {(task.status === 'downloading' || task.status === 'queued') && <Button size="icon" variant="ghost" aria-label="Cancel download" onClick={() => onAction('cancel')}><XCircle className="h-4 w-4" /></Button>}
          {onDelete && <Button size="icon" variant="danger" aria-label="Remove download from history" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>}
        </div>
      </div>

      {task.status === 'downloading' && (
        <>
          <ProgressBar value={task.progressCurrent} max={task.progressTotal} active={task.status === 'downloading'} />
          <div className="flex flex-col gap-1 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
            <span className="truncate">{task.currentFile ? `Saving ${task.currentFile}` : 'Starting…'}</span>
            <span className="shrink-0">
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
          <span className="truncate text-muted" title={task.outputPath}>{task.outputPath}</span>
          {task.outputFormat === 'cbz' && onEditComicInfo && (
            <Button size="icon" variant="ghost" className="ml-auto h-9 w-9 shrink-0" aria-label="Edit ComicInfo.xml" onClick={() => onEditComicInfo(task.outputPath!)}>
              <FileText className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      {task.status === 'failed' && task.errorMessage && (
        <p className="text-xs text-danger">{task.errorMessage}</p>
      )}

      <div className="flex items-center justify-between text-xs text-muted">
        <span>{timeAgo(task.createdAt)}</span>
        <Badge tone={task.outputFormat === 'cbz' ? 'default' : 'info'}>{task.outputFormat.toUpperCase()}</Badge>
      </div>
    </div>
  );
}

// ---------------- Page ----------------

export function Downloader() {
  // Shared app-wide download state (live via SSE + polling fallback) and actions.
  // Deep links from the Libraries page prefill the source and an artist search
  // (`/downloader?source=nhentai&q=artist%3A...`). App remounts this page on
  // path changes, so reading the params once at mount covers every entry.
  const [searchParams] = useSearchParams();
  const [source, setSource] = React.useState<DoujinSource>(() => (searchParams.get('source') === 'nhentai' ? 'nhentai' : 'hitomi'));
  const [query, setQuery] = React.useState(() => searchParams.get('q') ?? '');
  const [searchKey, setSearchKey] = React.useState<string | null>(() => {
    const q = searchParams.get('q');
    return q && q.trim() ? q.trim() : null;
  });
  // Result ordering for nHentai searches (ignored by other sources). Persisted
  // across source switches so it applies the next time nHentai is searched.
  const [sort, setSort] = React.useState<DoujinSort>('default');
  const [selected, setSelected] = React.useState<DoujinSearchResult | null>(null);
  // ComicInfo editor: null = closed; { path? } = open (path from a completed row, or none to browse).
  const [comicInfo, setComicInfo] = React.useState<{ path?: string } | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const { tasks, active, liveConnected, error: downloadsError, refetch: refetchDownloads, startDownload, pause, resume, cancel, retry, removeTask, clearCompleted } = useDownloads();
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
    const before = full.slice(0, caret);
    let idx = before.length;
    while (idx > 0 && !/\s/.test(before[idx - 1])) idx--;
    let seed = before.slice(idx);
    if (seed.includes(':')) seed = seed.slice(seed.indexOf(':') + 1);
    return seed.replace(/^[\s"']+|[\s"']+$/g, '');
  }

  // Debounced tag/artist autocomplete for the active token. Only nHentai implements
  // `suggest`, so the dropdown stays empty for Hitomi (its search is unchanged).
  React.useEffect(() => {
    const seed = activeSeed();
    if (seed.length < 2) {
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
  }, [query, source]);

  const { data: results, isFetching, isError: searchFailed, error: searchError, refetch: retrySearch } = useQuery({
    queryKey: ['doujin-search', source, searchKey, sort],
    queryFn: () => api.doujinSearch(source, searchKey!, sort),
    enabled: searchKey !== null && searchKey.trim().length > 0,
  });

  // Galleries with a completed download task — powers the duplicate badges.
  const { data: completed } = useQuery({
    queryKey: ['downloads-completed'],
    queryFn: api.downloadsCompleted,
    refetchInterval: 15_000,
  });
  const downloadedAt = React.useMemo(
    () => new Map((completed ?? []).map((k) => [`${k.source}:${k.galleryId}`, k.finishedAt])),
    [completed],
  );

  // Saved watches so the star button reflects the current search's state.
  const { data: watches, refetch: refetchWatches } = useQuery({
    queryKey: ['watched-searches'],
    queryFn: api.watchedSearches,
    refetchInterval: 30_000,
  });
  const currentWatch = (watches ?? []).find((w) => w.source === source && w.query === query.trim());

  async function toggleWatch() {
    const q = query.trim();
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

  // Tracks which gallery a start-download is in flight for (for button spinners).
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);

  // Results are fetched in full (up to ~1000 galleries) and paged client-side —
  // rendering every card at once is the heaviest thing this page can do.
  const [page, setPage] = React.useState(1);
  const [showAllHistory, setShowAllHistory] = React.useState(false);

  // Top-of-page view tabs: search results vs. the download manager queue.
  const [tab, setTab] = React.useState<'search' | 'manager'>('search');
  React.useEffect(() => {
    setPage(1);
  }, [searchKey, source]);


  async function doStartDownload(item: DoujinSearchResult) {
    const key = `${item.source}:${item.galleryId}`;
    setPendingKey(key);
    try {
      await startDownload({ source: item.source, galleryId: item.galleryId, title: item.title ?? undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'already-downloaded') {
        toast({ tone: 'info', title: 'Already downloaded', description: 'This gallery has a completed task — use Retry in the Download Manager to re-download it.' });
      } else {
        toast({ tone: 'danger', title: 'Could not start download', description: msg });
      }
    } finally {
      setPendingKey(null);
    }
  }

  const act = (id: number, a: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (a === 'pause') pause(id);
    else if (a === 'resume') resume(id);
    else if (a === 'cancel') cancel(id);
    else retry(id);
  };

  function selectSuggestion(s: DoujinSuggestion) {
    const el = inputRef.current;
    const q = s.filter ?? s.name;
    const full = el ? el.value : query;
    const caret = el && document.activeElement === el ? (el.selectionStart ?? full.length) : full.length;
    const before = full.slice(0, caret);
    let idx = before.length;
    while (idx > 0 && !/\s/.test(before[idx - 1])) idx--;
    const prefix = before.slice(0, idx);
    const rest = full.slice(caret);
    const needsLead = prefix.length > 0 && !/\s$/.test(prefix);
    let newQuery = prefix + (needsLead ? ' ' : '') + q;
    if (rest.trim().length > 0) {
      newQuery += /\s$/.test(newQuery) || /^\s/.test(rest) ? rest : ` ${rest}`;
    } else {
      newQuery += ' '; // trailing space so the next tag can be typed immediately
    }
    setQuery(newQuery);
    setSuggestions([]);
    setHighlight(-1);
    // Keep focus and park the caret after the inserted filter so more tags can be added.
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      try {
        node.setSelectionRange(newQuery.length, newQuery.length);
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
   * then closes the modal so the new results are visible.
   */
  function searchTagFragment(fragment: string) {
    const trimmed = fragment.trim();
    if (!trimmed) return;
    setQuery(trimmed);
    setSearchKey(trimmed);
    setSuggestions([]);
    setHighlight(-1);
    setSelected(null);
  }

  // Swap the active source, translating the current query into the target
  // source's syntax for the displayed text.
  function switchSource(next: DoujinSource) {
    if (next === source) return;
    const translated = translateQuery(query, source, next).trim();
    setQuery(translated);
    setSearchKey(translated || null);
    setSource(next);
  }

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    commitQuery(query);
  };

  const currentTasks = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'paused');
  const finished = tasks.filter((t) => t.status === 'completed' || t.status === 'failed');
  const pageCount = Math.max(1, Math.ceil((results?.length ?? 0) / RESULTS_PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageItems = results ? results.slice((curPage - 1) * RESULTS_PAGE_SIZE, curPage * RESULTS_PAGE_SIZE) : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon={<ListVideo className="h-5 w-5" />} title="Doujinshi Downloader" subtitle="Search Hitomi.la and nHentai, then download galleries into your Kavita library." />

      <SegmentedTabs
        items={[{ id: 'search' as const, label: 'Search' }, { id: 'manager' as const, label: 'Manager' }]}
        value={tab}
        onChange={setTab}
        label="Downloader sections"
        className="self-start"
      />

      {tab === 'search' && (<>

      {/* Search bar */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={runSearch} className="flex flex-col gap-2 lg:flex-row">
            <div role="group" aria-label="Download source" className="flex overflow-hidden rounded-md border border-border-2">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => switchSource(s.id)}
                  aria-pressed={source === s.id}
                  className={cn(
                    'px-4 py-2 text-sm font-medium transition-colors',
                    source === s.id ? 'bg-primary text-white' : 'bg-surface-2 text-muted hover:text-foreground',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="relative flex-1">
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
                className="pl-9 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  title="Clear"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}

              {showDropdown && (
                <div id="doujin-suggestions" role="listbox" className="absolute left-0 right-0 top-full z-50 mt-1 origin-top animate-scale-in overflow-hidden rounded-lg border border-border bg-surface shadow-xl shadow-black/30">
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
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectSuggestion(s);
                          }}
                          onMouseEnter={() => setHighlight(i)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                            i === highlight ? 'bg-surface-2' : 'hover:bg-surface-2',
                          )}
                        >
                          <span
                            className={cn(
                              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                              SUGG_TYPE_STYLES[s.type] ?? 'bg-slate-500/25 text-slate-300',
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
            {/* Popularity ordering — nHentai only (mirrors nhentai.net's sort). */}
            {source === 'nhentai' && (
              <Select
                value={sort}
                onChange={(e) => setSort(e.target.value as DoujinSort)}
                title="Sort results"
                className="w-44 shrink-0"
              >
                {NHENTAI_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </Select>
            )}
            <Button type="submit" disabled={isFetching || !query.trim()}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
            </Button>
            <Button
              type="button"
              variant={currentWatch ? 'secondary' : 'outline'}
              onClick={() => void toggleWatch()}
              disabled={!query.trim()}
              title={currentWatch ? `Stop watching “${query.trim()}”` : 'Watch this search — get a Discord ping when it finds new results'}
            >
              <Star className={cn('h-4 w-4', currentWatch && 'fill-current')} /> Watch
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Results grid */}
      {searchKey !== null && (
        <div>
          {searchFailed ? (
            <ErrorState title="Search failed" description={searchError instanceof Error ? searchError.message : String(searchError)} onRetry={() => void retrySearch()} />
          ) : isFetching ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted">
              <Spinner /> Searching {SOURCE_LABELS[source]}…
            </div>
          ) : results && results.length > 0 ? (
            <>
              <p className="mb-3 text-xs text-muted">
                {results.length} {results.length === 1 ? 'gallery' : 'galleries'} found on {SOURCE_LABELS[source]}
                {pageCount > 1 && ` — showing ${(curPage - 1) * RESULTS_PAGE_SIZE + 1}–${Math.min(curPage * RESULTS_PAGE_SIZE, results.length)}`}
              </p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                {pageItems.map((item, i) => (
                  <GalleryCard
                    key={item.source + item.galleryId}
                    item={item}
                    index={i}
                    onOpen={() => setSelected(item)}
                    downloading={pendingKey === `${item.source}:${item.galleryId}`}
                    downloadedAt={downloadedAt.get(`${item.source}:${item.galleryId}`)}
                    onDownload={() => doStartDownload(item)}
                  />
                ))}
              </div>
              {pageCount > 1 && (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-1">
                  <Button size="sm" variant="outline" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </Button>
                  {pageList(curPage, pageCount).map((p, i) =>
                    p === '…' ? (
                      <span key={`e${i}`} className="px-1 text-xs text-muted">…</span>
                    ) : (
                      <Button key={p} size="sm" variant={p === curPage ? 'default' : 'outline'} onClick={() => setPage(p)} aria-current={p === curPage ? 'page' : undefined}>
                        {p}
                      </Button>
                    ),
                  )}
                  <Button size="sm" variant="outline" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState icon={<Search className="h-8 w-8" />} title="No results" description={`No galleries found for “${searchKey}” on ${SOURCE_LABELS[source]}.`} />
          )}
        </div>
      )}

      {/* Gallery detail modal */}
      {selected && (
        <GalleryDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          downloading={pendingKey === `${selected.source}:${selected.galleryId}`}
          onDownload={() => doStartDownload(selected)}
          onSearchTag={searchTagFragment}
        />
      )}
      </>)
      }

      {/* Download manager */}
      {tab === 'manager' && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <DownloadIcon className="h-4 w-4" /> Download Manager
              {liveConnected && <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live</span>}
              {currentTasks.length > 0 && <Badge tone="info">{currentTasks.length} current</Badge>}
            </CardTitle>
            {finished.some((task) => task.status === 'completed') && <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)}><Trash2 className="h-3.5 w-3.5" /> Clear completed</Button>}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {downloadsError ? (
              <ErrorState title="Could not load downloads" description={downloadsError.message} onRetry={() => void refetchDownloads()} />
            ) : tasks.length === 0 ? (
              <EmptyState icon={<DownloadIcon className="h-8 w-8" />} title="No downloads yet" description="Click Download on a gallery to queue it. Set the output folder in Settings first." />
            ) : (
              <>
                {currentTasks.length > 0 && (
                  <section className="flex flex-col gap-2" aria-labelledby="current-downloads">
                    <p id="current-downloads" className="text-xs font-semibold uppercase tracking-wide text-muted">Current</p>
                    {currentTasks.map((task) => <QueueRow key={task.id} task={task} onAction={(action) => act(task.id, action)} onEditComicInfo={(path) => setComicInfo({ path })} />)}
                  </section>
                )}
                {finished.length > 0 && (
                  <section className="flex flex-col gap-2" aria-labelledby="download-history">
                    <div className="flex items-center justify-between">
                      <p id="download-history" className="text-xs font-semibold uppercase tracking-wide text-muted">History</p>
                      {finished.length > HISTORY_PREVIEW && <Button size="sm" variant="ghost" onClick={() => setShowAllHistory((value) => !value)}>{showAllHistory ? 'Show less' : `Show all (${finished.length})`}</Button>}
                    </div>
                    {(showAllHistory ? finished : finished.slice(0, HISTORY_PREVIEW)).map((task) => <QueueRow key={task.id} task={task} onAction={(action) => act(task.id, action)} onEditComicInfo={(path) => setComicInfo({ path })} onDelete={() => removeTask(task.id)} />)}
                  </section>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {comicInfo && (
        <ComicInfoModal initialPath={comicInfo.path} onClose={() => setComicInfo(null)} />
      )}
      <ConfirmDialog
        open={confirmClear}
        title="Clear completed downloads?"
        description="This removes every completed download from the manager history. Downloaded files are not deleted."
        confirmLabel="Clear completed"
        danger
        onOpenChange={setConfirmClear}
        onConfirm={() => { clearCompleted(); setConfirmClear(false); }}
      />

    </div>
  );
}