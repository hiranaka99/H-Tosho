import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
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
  X,
  ArrowRight,
  ExternalLink,
  BookOpen,
  Users,
  Layers,
  Star,
  Tags,
} from 'lucide-react';
import { api, type DoujinSource, type DoujinSearchResult, type DoujinSuggestion, type DownloadTask } from '../lib/api';
import { useDownloads } from '../lib/DownloadsContext';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, EmptyState, Spinner, ProgressBar, Dialog, DialogContent } from '../components/ui';
import { cn, timeAgo } from '../lib/utils';

const SOURCES: { id: DoujinSource; label: string }[] = [
  { id: 'hitomi', label: 'Hitomi.la' },
  { id: 'nhentai', label: 'nHentai' },
];

/** Human-facing display name for a doujin source. */
const SOURCE_LABELS: Record<DoujinSource, string> = { hitomi: 'Hitomi.la', nhentai: 'nHentai' };

/**
 * Translate a search query from one doujin source's syntax to the other's so a
 * search can be re-run against the new source. nHentai uses quoted values and
 * supports negation (`-term`); Hitomi uses underscores for multi-word tag values
 * and has no negation, so excluded terms are dropped when heading to Hitomi.
 */
function translateQuery(query: string, from: DoujinSource, to: DoujinSource): string {
  if (from === to) return query;
  const trimmed = query.trim();
  if (!trimmed) return query;
  const out: string[] = [];
  for (const rawTerm of trimmed.split(/\s+/)) {
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
    out.push(ns ? `${ns}:${val}` : val);
  }
  return out.join(' ');
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
  const d = new Date(iso);
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

function GalleryCard({ item, onOpen, onDownload, downloading }: { item: DoujinSearchResult; onOpen: () => void; onDownload: () => void; downloading: boolean }) {
  const tags = [...item.artists, ...item.tags].slice(0, 6);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="relative">
        <Cover url={item.coverUrl} title={item.title} className="aspect-[3/4] w-full" />
        {/* Show the gallery's language badge (e.g. "english", "japanese"). */}
        {item.language && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
            <Languages className="h-3 w-3" /> {item.language}
          </span>
        )}
        {item.pageCount ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">{item.pageCount}p</span>
        ) : null}
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
          <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-white">
            <Search className="h-3 w-3" /> Details
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={item.title}>{item.title}</p>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((t, i) => (
              <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{t}</span>
            ))}
          </div>
        )}
        <div className="mt-auto flex items-center justify-between pt-1">
          <SourceBadge source={item.source} />
          <Button size="sm" onClick={(e) => { e.stopPropagation(); onDownload(); }} disabled={downloading}>
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />} Download
          </Button>
        </div>
      </div>
    </div>
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

function TagList({ label, items, icon }: { label: string; items?: string[]; icon?: React.ReactNode }) {
  if (!items?.length) return null;
  const style = Object.entries(TAG_GROUP_STYLES).find(([k]) => label.startsWith(k))?.[1] ?? 'bg-slate-500/25 text-slate-300';
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        {icon} {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t, i) => (
          <span key={i} className={cn('rounded-full px-2.5 py-1 text-xs', style)}>
            {t}
          </span>
        ))}
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

function GalleryDetailModal({ item, onClose, onDownload, downloading }: { item: DoujinSearchResult; onClose: () => void; onDownload: () => void; downloading: boolean }) {
  const { data: gallery, isPending, isError, error } = useQuery({
    queryKey: ['doujin-gallery', item.source, item.galleryId],
    queryFn: () => api.doujinGallery(item.source, item.galleryId),
    staleTime: 5 * 60_000,
  });

  const g = gallery;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] gap-5 overflow-y-auto p-5">
          {/* Cover */}
          <div className="w-40 shrink-0 sm:w-48">
            <Cover url={g?.coverUrl ?? item.coverUrl} title={item.title} className="aspect-[3/4] w-full rounded-md border border-border" />
            {g?.url && (
              <a
                href={g.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-primary"
              >
                <ExternalLink className="h-3 w-3" /> View on {SOURCE_LABELS[item.source]}
              </a>
            )}
          </div>

          {/* Details */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="min-w-0 pr-6">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <SourceBadge source={item.source} />
                {g?.language && (
                  <Badge tone="info"><Languages className="h-3 w-3" /> {g.language}</Badge>
                )}
              </div>
              <h2 className="text-lg font-semibold leading-snug">{g?.title ?? item.title}</h2>
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

                <TagList label="Artists" items={g.artists ?? item.artists} icon={<Users className="h-3 w-3" />} />
                <TagList label="Groups" items={g.groups} icon={<Layers className="h-3 w-3" />} />
                <TagList label="Characters" items={g.genres} icon={<Star className="h-3 w-3" />} />
                {g.series && (
                  <div className="flex flex-col gap-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <BookOpen className="h-3 w-3" /> Series
                    </p>
                    <span className="w-fit rounded-full bg-cyan-500/20 px-2.5 py-1 text-xs text-cyan-300">{g.series}</span>
                  </div>
                )}
                {g.tags?.length ? (
                  <TagList label={`Tags (${g.tags.length})`} items={g.tags} icon={<Tags className="h-3 w-3" />} />
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

function QueueRow({ task, onAction }: { task: DownloadTask; onAction: (a: 'pause' | 'resume' | 'cancel' | 'retry') => void }) {
  const pct = task.progressTotal > 0 ? Math.round((task.progressCurrent / task.progressTotal) * 100) : 0;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <DownloadStatusBadge status={task.status} />
          <span className="truncate text-sm font-medium" title={task.title ?? ''}>{task.title ?? `Gallery ${task.galleryId}`}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.status === 'downloading' && (
            <Button size="icon" variant="ghost" title="Pause" onClick={() => onAction('pause')}><Pause className="h-4 w-4" /></Button>
          )}
          {(task.status === 'paused' || task.status === 'failed') && (
            <Button size="icon" variant="ghost" title="Resume" onClick={() => onAction('resume')}><Play className="h-4 w-4" /></Button>
          )}
          {task.status === 'failed' && (
            <Button size="icon" variant="ghost" title="Retry" onClick={() => onAction('retry')}><RotateCcw className="h-4 w-4" /></Button>
          )}
          {(task.status === 'downloading' || task.status === 'queued') && (
            <Button size="icon" variant="ghost" title="Cancel" onClick={() => onAction('cancel')}><XCircle className="h-4 w-4" /></Button>
          )}
        </div>
      </div>

      {task.status === 'downloading' && (
        <>
          <ProgressBar value={task.progressCurrent} max={task.progressTotal} />
          {typeof task.bytesTotal === 'number' && task.bytesTotal > 0 && (
            <ProgressBar value={Math.min(task.bytesCurrent ?? 0, task.bytesTotal)} max={task.bytesTotal} className="h-1" />
          )}
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="truncate">{task.currentFile ? `Saving ${task.currentFile}` : 'Starting…'}</span>
            <span className="shrink-0">
              {task.progressTotal > 0 ? `${task.progressCurrent}/${task.progressTotal} pages (${pct}%)` : 'Resolving gallery…'}
              {typeof task.bytesCurrent === 'number' && (task.bytesCurrent > 0 || (task.bytesTotal ?? 0) > 0) && (
                ` · ${formatBytes(task.bytesCurrent)}${(task.bytesTotal ?? 0) > 0 ? ` / ${formatBytes(task.bytesTotal)}` : ''}`
              )}
              {formatSpeed(task.speed) && ` · ${formatSpeed(task.speed)}`}
            </span>
          </div>
        </>
      )}

      {task.status === 'completed' && task.outputPath && (
        <div className="flex items-center gap-2 text-xs">
          {task.outputFormat === 'cbz' ? <FileArchive className="h-3.5 w-3.5 text-success" /> : <FolderOpen className="h-3.5 w-3.5 text-success" />}
          <span className="truncate text-muted" title={task.outputPath}>{task.outputPath}</span>
        </div>
      )}

      {task.status === 'failed' && task.errorMessage && (
        <p className="text-xs text-danger">{task.errorMessage}</p>
      )}

      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>{timeAgo(task.createdAt)}</span>
        <Badge tone={task.outputFormat === 'cbz' ? 'default' : 'info'} className="text-[10px]">{task.outputFormat.toUpperCase()}</Badge>
      </div>
    </div>
  );
}

// ---------------- Page ----------------

export function Downloader() {
  // Shared app-wide download state (live via SSE + polling fallback) and actions.
  const { tasks, active, liveConnected, startDownload, pause, resume, cancel, retry, removeTask, clearCompleted } = useDownloads();
  const [source, setSource] = React.useState<DoujinSource>('hitomi');
  const [query, setQuery] = React.useState('');
  const [searchKey, setSearchKey] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<DoujinSearchResult | null>(null);

  // Autocomplete dropdown state (nHentai tag/artist suggestions).
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

  const { data: results, isFetching } = useQuery({
    queryKey: ['doujin-search', source, searchKey],
    queryFn: () => api.doujinSearch(source, searchKey!),
    enabled: searchKey !== null && searchKey.trim().length > 0,
  });

  // Tracks which gallery a start-download is in flight for (for button spinners).
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);

  async function doStartDownload(item: DoujinSearchResult) {
    const key = `${item.source}:${item.galleryId}`;
    setPendingKey(key);
    try {
      await startDownload({ source: item.source, galleryId: item.galleryId, title: item.title ?? undefined });
    } catch {
      /* surfaced via toast */
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

  const finished = tasks.filter((t) => t.status !== 'downloading' && t.status !== 'queued');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ListVideo className="h-5 w-5" /> Doujinshi Downloader
        </h1>
        <p className="text-sm text-muted">Search Hitomi.la & nHentai (nhentai.net) and download galleries straight into your Kavita library.</p>
      </div>

      {/* Search bar */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={runSearch} className="flex flex-col gap-2 sm:flex-row">
            <div className="flex overflow-hidden rounded-md border border-border-2">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => switchSource(s.id)}
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
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                onFocus={() => setInputFocused(true)}
                onBlur={() => {
                  setInputFocused(false);
                  setHighlight(-1);
                }}
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
                <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-surface shadow-xl">
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
            <Button type="submit" disabled={isFetching || !query.trim()}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Results grid */}
      {searchKey !== null && (
        <div>
          {isFetching ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted">
              <Spinner /> Searching {SOURCE_LABELS[source]}…
            </div>
          ) : results && results.length > 0 ? (
            <>
              <p className="mb-3 text-xs text-muted">
                {results.length} {results.length === 1 ? 'gallery' : 'galleries'} found on {SOURCE_LABELS[source]}
              </p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                {results.map((item) => (
                  <GalleryCard
                    key={item.source + item.galleryId}
                    item={item}
                    onOpen={() => setSelected(item)}
                    downloading={pendingKey === `${item.source}:${item.galleryId}`}
                    onDownload={() => doStartDownload(item)}
                  />
                ))}
              </div>
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
        />
      )}

      {/* Download manager */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <DownloadIcon className="h-4 w-4" /> Download Manager
            {liveConnected && (
              <span title="Real-time updates connected" className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
              </span>
            )}
            {active.length > 0 && <Badge tone="info">{active.length} active</Badge>}
          </CardTitle>
          {finished.some((t) => t.status === 'completed') && (
            <Button size="sm" variant="outline" onClick={() => clearCompleted()}>
              <Trash2 className="h-3.5 w-3.5" /> Clear completed
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tasks.length === 0 ? (
            <EmptyState icon={<DownloadIcon className="h-8 w-8" />} title="No downloads yet" description="Click Download on a gallery to queue it. Set the output folder in Settings first." />
          ) : (
            <>
              {active.length > 0 && (
                <div className="flex flex-col gap-2">
                  {active.map((t) => (
                    <QueueRow key={t.id} task={t} onAction={(a) => act(t.id, a)} />
                  ))}
                </div>
              )}
              {finished.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-semibold text-muted">History</p>
                  {finished.map((t) => (
                    <div key={t.id} className="relative">
                      <QueueRow task={t} onAction={(a) => act(t.id, a)} />
                      <button
                        onClick={() => removeTask(t.id)}
                        title="Remove from list"
                        className="absolute right-2 top-2 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}