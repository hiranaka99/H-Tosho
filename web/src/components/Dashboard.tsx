import * as React from 'react';
import { Search, Download, BookOpen, X, Loader2, RefreshCw, Play, Pause, Trash2, CheckCircle2, XCircle, Clock, FolderDown, FileArchive, ArrowRight } from 'lucide-react';
import { api, type DoujinSearchResult, type DoujinSuggestion, type DoujinSource, type DownloadTask, type DownloaderSettings } from '../lib/api';
import { Button, Input, Select, Card, Badge, ProviderBadge, Spinner, EmptyState, Dialog, DialogContent } from '../components/ui';
import { cn } from '../lib/utils';

interface GalleryDetail {
  title: string;
  coverUrl?: string | null;
  language?: string | null;
  series?: string | null;
  artists: string[];
  tags: string[];
  pageCount: number;
  url?: string;
}

const DOUJIN_SOURCES: { id: DoujinSource; name: string }[] = [
  { id: 'hitomi', name: 'Hitomi.la' },
  { id: 'nhentai', name: 'NHentai' },
];

/** Badge color per suggestion tag type (mirrors the NHentai search dropdown). */
const SUGG_TYPE_STYLES: Record<string, string> = {
  artist: 'bg-violet-500/20 text-violet-300',
  group: 'bg-amber-500/25 text-amber-300',
  character: 'bg-pink-500/20 text-pink-300',
  series: 'bg-blue-500/20 text-blue-300',
  language: 'bg-emerald-500/20 text-emerald-300',
  tag: 'bg-slate-500/25 text-slate-300',
};

export function Dashboard() {
  const [source, setSource] = React.useState<DoujinSource>('hitomi');
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<DoujinSearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Autocomplete dropdown state.
  const [suggestions, setSuggestions] = React.useState<DoujinSuggestion[]>([]);
  const [suggLoading, setSuggLoading] = React.useState(false);
  const [inputFocused, setInputFocused] = React.useState(false);
  const [highlight, setHighlight] = React.useState(-1);
  const suppressSuggest = React.useRef(false);

  // Preview dialog state.
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewSource, setPreviewSource] = React.useState<DoujinSource>('hitomi');
  const [detail, setDetail] = React.useState<GalleryDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [downloadFormat, setDownloadFormat] = React.useState<'cbz' | 'folder'>('cbz');
  const [downloading, setDownloading] = React.useState(false);

  // Download queue + settings state.
  const [downloads, setDownloads] = React.useState<DownloadTask[]>([]);
  const [dlSettings, setDlSettings] = React.useState<DownloaderSettings | null>(null);
  const [showDlSettings, setShowDlSettings] = React.useState(false);

  const refreshDownloads = React.useCallback(async () => {
    try {
      setDownloads(await api.downloads());
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    api.downloaderSettings().then(setDlSettings).catch(() => {});
    refreshDownloads();
  }, [refreshDownloads]);

  // Poll the download queue while any task is active.
  const hasActive = downloads.some((d) => d.status === 'queued' || d.status === 'downloading');
  React.useEffect(() => {
    if (!hasActive) return;
    const t = window.setInterval(refreshDownloads, 1000);
    return () => window.clearInterval(t);
  }, [hasActive, refreshDownloads]);

  // Debounced tag/artist autocomplete for the search box.
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setSuggLoading(false);
      return;
    }
    if (suppressSuggest.current) {
      suppressSuggest.current = false;
      setSuggestions([]);
      setSuggLoading(false);
      return;
    }
    let cancelled = false;
    setSuggLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await api.doujinSuggestions(source, q);
        if (!cancelled) {
          setSuggestions(res ?? []);
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

  // Fetch full gallery metadata when the preview dialog opens.
  React.useEffect(() => {
    if (previewId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .doujinGallery(previewSource, previewId)
      .then((g) => {
        if (!cancelled) setDetail(g);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewId, previewSource]);

  async function runSearch(override?: string) {
    const q = (override ?? query).trim();
    if (!q) return;
    setInputFocused(false);
    setSuggestions([]);
    setLoading(true);
    setResults([]);
    setError(null);
    try {
      const res = await api.doujinSearch(source, q);
      setResults(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  function selectSuggestion(s: DoujinSuggestion) {
    const q = s.filter ?? s.name;
    suppressSuggest.current = true;
    setQuery(q);
    setSuggestions([]);
    setHighlight(-1);
    runSearch(q);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(Math.min(suggestions.length - 1, highlight + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(highlight <= 0 ? Math.max(0, suggestions.length - 1) : highlight - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight >= 0 && suggestions[highlight]) selectSuggestion(suggestions[highlight]);
      else runSearch();
    } else if (e.key === 'Escape') {
      setSuggestions([]);
      setHighlight(-1);
    }
  }

  const showDropdown = inputFocused && query.trim().length >= 2 && (suggestions.length > 0 || suggLoading);

  function openPreview(sourceId: DoujinSource, galleryId: string) {
    setPreviewSource(sourceId);
    setPreviewId(galleryId);
    setDetail(null);
  }

  async function handleDownload() {
    if (previewId === null) return;
    setDownloading(true);
    try {
      await api.startDownload({ source: previewSource, galleryId: previewId, title: detail?.title, format: downloadFormat });
      setShowDlSettings(false);
      refreshDownloads();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start download');
    } finally {
      setDownloading(false);
    }
  }

  async function actOn(id: number, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    try {
      await api.downloadAction(id, action);
      refreshDownloads();
    } catch {
      /* ignore */
    }
  }

  async function removeTask(id: number) {
    try {
      await api.deleteDownload(id);
      refreshDownloads();
    } catch {
      /* ignore */
    }
  }

  async function clearCompleted() {
    try {
      await api.clearCompletedDownloads();
      refreshDownloads();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Search bar */}
      <Card>
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              Doujinshi Search
            </h1>
            <span className="text-xs text-muted">Download galleries to Kavita via CBZ or folder</span>
          </div>

          <div className="flex gap-2">
            <div className="relative max-w-xl flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                onFocus={() => setInputFocused(true)}
                onBlur={() => {
                  setInputFocused(false);
                  setHighlight(-1);
                }}
                placeholder="Search by title, tag, artist, or gallery ID / URL…"
                className="pl-9 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground p-1"
                >
                  <X className="h-4 w-4" />
                </button>
              )}

              {/* Autocomplete dropdown */}
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
                              'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0',
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

            <Select value={source} onChange={(e) => setSource(e.target.value as DoujinSource)}>
              {DOUJIN_SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>

            <Button onClick={() => runSearch()} disabled={loading || !query.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </div>

          {error && (
            <div className="flex items-center justify-between rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-danger/70 hover:text-danger">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Results */}
        {loading && (
          <div className="border-t border-border p-8 flex items-center justify-center gap-2 text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Searching…
          </div>
        )}

        {!loading && results.length === 0 && query.trim() !== '' && (
          <div className="border-t border-border">
            <EmptyState icon={<Search className="h-8 w-8" />} title="No results found" description="Try a different keyword, tag, artist, or paste a gallery ID / URL." />
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="border-t border-border p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {results.map((r) => (
              <div key={`${r.source}-${r.galleryId}`} className="group rounded-md border border-border bg-surface-2 overflow-hidden hover:border-primary/50 transition-colors flex flex-col">
                <button type="button" onClick={() => openPreview(r.source, r.galleryId)} className="relative block w-full aspect-[3/4] overflow-hidden bg-black/40">
                  {r.coverUrl ? (
                    <img src={r.coverUrl} alt={r.title} loading="lazy" className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted">
                      <BookOpen className="h-8 w-8" />
                    </div>
                  )}
                  <span className="absolute left-2 top-2">
                    <ProviderBadge id={r.source} />
                  </span>
                </button>
                <div className="p-3 flex flex-col gap-2 flex-1">
                  <button type="button" onClick={() => openPreview(r.source, r.galleryId)} className="text-left text-sm font-medium line-clamp-2 hover:text-primary transition-colors min-h-[2.5rem]">
                    {r.title}
                  </button>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="text-xs text-muted truncate">{r.artists[0] ?? (r.pageCount ? `${r.pageCount} pages` : r.galleryId)}</span>
                    <Button size="sm" variant="secondary" onClick={() => openPreview(r.source, r.galleryId)}>
                      <Download className="h-3.5 w-3.5" /> Preview
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Download queue */}
      {downloads.length > 0 && (
        <Card>
          <div className="p-4 flex items-center justify-between border-b border-border">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <FolderDown className="h-4 w-4 text-primary" /> Download Queue
              {hasActive && <Spinner />}
            </h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={clearCompleted}>Clear completed</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowDlSettings((v) => !v)}>
                Settings
              </Button>
            </div>
          </div>

          {showDlSettings && dlSettings && (
            <div className="px-4 py-3 border-b border-border grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-muted">
                Download directory
                <Input value={dlSettings.downloadDirectory} onChange={(e) => setDlSettings({ ...dlSettings, downloadDirectory: e.target.value })} placeholder="/path/to/library" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Format
                <Select value={dlSettings.format} onChange={(e) => setDlSettings({ ...dlSettings, format: e.target.value as 'cbz' | 'folder' })}>
                  <option value="cbz">CBZ archive</option>
                  <option value="folder">Folder (PNG/JPG)</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Max concurrent galleries
                <Input type="number" min={1} max={8} value={dlSettings.maxConcurrentDownloads} onChange={(e) => setDlSettings({ ...dlSettings, maxConcurrentDownloads: Number(e.target.value) || 1 })} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Max images per gallery
                <Input type="number" min={1} max={32} value={dlSettings.maxImageConcurrency} onChange={(e) => setDlSettings({ ...dlSettings, maxImageConcurrency: Number(e.target.value) || 1 })} />
              </label>
            </div>
          )}

          <div className="divide-y divide-border">
            {downloads.map((d) => (
              <div key={d.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <ProviderBadge id={d.source} />
                    <span className="text-sm font-medium truncate">{d.title || d.galleryId}</span>
                    <Badge tone={d.status === 'completed' ? 'success' : d.status === 'failed' ? 'danger' : d.status === 'paused' ? 'warning' : 'info'}>{d.status}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                    {d.status === 'downloading' && (
                      <>
                        <span className="w-40">
                          <ProgressBarInline value={d.progressCurrent} max={d.progressTotal} />
                        </span>
                        <span>
                          {d.progressCurrent}/{d.progressTotal || '?'}
                        </span>
                        {d.speed != null && <span>{formatSpeed(d.speed)}/s</span>}
                      </>
                    )}
                    {d.status === 'completed' && d.outputPath && <span className="truncate">{d.outputPath}</span>}
                    {d.status === 'failed' && <span className="text-danger truncate">{d.errorMessage}</span>}
                    {d.status === 'queued' && <span>Waiting…</span>}
                    {d.status === 'paused' && <span>Paused</span>}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {(d.status === 'downloading' || d.status === 'queued') && (
                    <Button size="icon" variant="ghost" title="Pause" onClick={() => actOn(d.id, 'pause')}>
                      <Pause className="h-4 w-4" />
                    </Button>
                  )}
                  {d.status === 'paused' && (
                    <Button size="icon" variant="ghost" title="Resume" onClick={() => actOn(d.id, 'resume')}>
                      <Play className="h-4 w-4" />
                    </Button>
                  )}
                  {(d.status === 'failed' || d.status === 'paused') && (
                    <Button size="icon" variant="ghost" title="Retry" onClick={() => actOn(d.id, 'retry')}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  )}
                  {(d.status === 'queued' || d.status === 'downloading') && (
                    <Button size="icon" variant="ghost" title="Cancel" onClick={() => actOn(d.id, 'cancel')}>
                      <XCircle className="h-4 w-4" />
                    </Button>
                  )}
                  {(d.status === 'completed' || d.status === 'failed') && (
                    <Button size="icon" variant="ghost" title="Remove" onClick={() => removeTask(d.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Preview dialog */}
      <Dialog open={previewId !== null} onOpenChange={(o) => !o && setPreviewId(null)}>
        {previewId !== null && (
          <DialogContent className="max-w-3xl">
            <div className="grid gap-4 p-6 sm:grid-cols-[200px_1fr]">
              <div>
                {detail?.coverUrl ? (
                  <img src={detail.coverUrl} alt={detail.title} className="w-full rounded-md border border-border" />
                ) : (
                  <div className="flex aspect-[3/4] items-center justify-center rounded-md border border-border bg-surface-2 text-muted">
                    <BookOpen className="h-8 w-8" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-3 min-h-0">
                {detailLoading && !detail ? (
                  <div className="flex items-center gap-2 text-muted text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading gallery details…
                  </div>
                ) : detail ? (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <ProviderBadge id={previewSource} />
                        <h2 className="mt-1 text-base font-semibold leading-snug">{detail.title}</h2>
                      </div>
                      {detail.url && (
                        <a href={detail.url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-primary shrink-0">
                          View source ↗
                        </a>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2 text-xs text-muted">
                      {detail.pageCount > 0 && (
                        <Badge tone="default">
                          <FileArchive className="h-3 w-3" /> {detail.pageCount} pages
                        </Badge>
                      )}
                      {detail.language && <Badge tone="info">{detail.language}</Badge>}
                      {detail.series && <Badge tone="muted">Series: {detail.series}</Badge>}
                    </div>

                    {detail.artists.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {detail.artists.map((a) => (
                          <Badge key={a} tone="default">{a}</Badge>
                        ))}
                      </div>
                    )}

                    {detail.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {detail.tags.slice(0, 24).map((t) => (
                          <span key={t} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t}</span>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex items-center gap-3 pt-3 border-t border-border">
                      <Select value={downloadFormat} onChange={(e) => setDownloadFormat(e.target.value as 'cbz' | 'folder')} className="w-40">
                        <option value="cbz">CBZ archive</option>
                        <option value="folder">Folder (PNG/JPG)</option>
                      </Select>
                      <Button onClick={handleDownload} disabled={downloading} className="ml-auto">
                        {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        Start Download
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted">Could not load gallery details.</div>
                )}
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function ProgressBarInline({ value, max }: { value: number; max: number }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: p + '%' }} />
    </div>
  );
}

function formatSpeed(bps: number): string {
  if (bps >= 1_048_576) return (bps / 1_048_576).toFixed(1) + ' MB';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB';
  return Math.round(bps) + ' B';
}
