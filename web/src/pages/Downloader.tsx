import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
} from 'lucide-react';
import { api, type DoujinSource, type DoujinSearchResult, type DownloadTask } from '../lib/api';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, EmptyState, Spinner, ProgressBar } from '../components/ui';
import { cn, timeAgo } from '../lib/utils';

const SOURCES: { id: DoujinSource; label: string }[] = [
  { id: 'hitomi', label: 'Hitomi.la' },
  { id: 'nhentai', label: 'NHentai' },
];

function SourceBadge({ source }: { source: DoujinSource }) {
  const color = source === 'nhentai' ? '#e91e63' : '#ff5722';
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: color + '22', color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {source === 'nhentai' ? 'NHentai' : 'Hitomi.la'}
    </span>
  );
}

function Cover({ url, title }: { url?: string | null; title: string }) {
  const [failed, setFailed] = React.useState(false);
  if (!url || failed) {
    return (
      <div className="flex h-40 w-full items-center justify-center bg-surface-2 text-muted">
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
      className="h-40 w-full object-cover"
    />
  );
}

function formatSpeed(bps: number | null): string {
  if (!bps || bps <= 0) return '';
  const mb = bps / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
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

function GalleryCard({ item, onDownload, downloading }: { item: DoujinSearchResult; onDownload: () => void; downloading: boolean }) {
  const tags = [...item.artists, ...item.tags].slice(0, 6);
  return (
    <div className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-shadow hover:shadow-md">
      <div className="relative">
        <Cover url={item.coverUrl} title={item.title} />
        {item.language && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
            <Languages className="h-3 w-3" /> {item.language}
          </span>
        )}
        {item.pageCount ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">{item.pageCount}p</span>
        ) : null}
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
          <Button size="sm" onClick={onDownload} disabled={downloading}>
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />} Download
          </Button>
        </div>
      </div>
    </div>
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
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{task.currentFile ? `Saving ${task.currentFile}` : 'Starting…'}</span>
            <span>
              {task.progressTotal > 0 ? `${task.progressCurrent}/${task.progressTotal} pages (${pct}%)` : 'Resolving gallery…'}
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
  const qc = useQueryClient();
  const [source, setSource] = React.useState<DoujinSource>('nhentai');
  const [query, setQuery] = React.useState('');
  const [searchKey, setSearchKey] = React.useState<string | null>(null);

  const { data: results, isFetching } = useQuery({
    queryKey: ['doujin-search', source, searchKey],
    queryFn: () => api.doujinSearch(source, searchKey!),
    enabled: searchKey !== null && searchKey.trim().length > 0,
  });

  const { data: tasks = [] } = useQuery({ queryKey: ['downloads'], queryFn: api.downloads, refetchInterval: 1500 });

  const startDownload = useMutation({
    mutationFn: (item: DoujinSearchResult) => api.startDownload({ source: item.source, galleryId: item.galleryId, title: item.title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' | 'cancel' | 'retry' }) => api.downloadAction(id, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });

  const clearCompleted = useMutation({
    mutationFn: api.clearCompletedDownloads,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });

  const removeTask = useMutation({
    mutationFn: (id: number) => api.deleteDownload(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) setSearchKey(query.trim());
  };

  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued');
  const finished = tasks.filter((t) => t.status !== 'downloading' && t.status !== 'queued');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ListVideo className="h-5 w-5" /> Doujinshi Downloader
        </h1>
        <p className="text-sm text-muted">Search Hitomi.la & NHentai (nhentai.net) and download galleries straight into your Kavita library.</p>
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
                  onClick={() => setSource(s.id)}
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
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by keyword, tag, artist, gallery ID or URL…" className="pl-9" />
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
              <Spinner /> Searching {source === 'nhentai' ? 'NHentai' : 'Hitomi.la'}…
            </div>
          ) : results && results.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {results.map((item) => (
                <GalleryCard
                  key={item.source + item.galleryId}
                  item={item}
                  downloading={startDownload.isPending && startDownload.variables?.galleryId === item.galleryId}
                  onDownload={() => startDownload.mutate(item)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<Search className="h-8 w-8" />} title="No results" description={`No galleries found for “${searchKey}” on ${source === 'nhentai' ? 'NHentai' : 'Hitomi.la'}.`} />
          )}
        </div>
      )}

      {/* Download manager */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <DownloadIcon className="h-4 w-4" /> Download Manager
            {active.length > 0 && <Badge tone="info">{active.length} active</Badge>}
          </CardTitle>
          {finished.some((t) => t.status === 'completed') && (
            <Button size="sm" variant="outline" onClick={() => clearCompleted.mutate()} disabled={clearCompleted.isPending}>
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
                    <QueueRow key={t.id} task={t} onAction={(a) => act.mutate({ id: t.id, action: a })} />
                  ))}
                </div>
              )}
              {finished.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-semibold text-muted">History</p>
                  {finished.map((t) => (
                    <div key={t.id} className="relative">
                      <QueueRow task={t} onAction={(a) => act.mutate({ id: t.id, action: a })} />
                      <button
                        onClick={() => removeTask.mutate(t.id)}
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