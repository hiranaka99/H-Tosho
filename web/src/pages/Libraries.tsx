import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Search, LayoutGrid, Table2, Sparkles, RefreshCw, Play, BookOpen, Unlink, ArrowUpRight, FileText, Combine, Check, CheckSquare, ChevronLeft, ChevronRight, EllipsisVertical } from 'lucide-react';
import { api, type SeriesRow, type DoujinSource } from '../lib/api';
import { Button, Card, Input, Select, Badge, StatusBadge, ProviderBadge, Skeleton, EmptyState, Switch, PageHeader, ErrorState, ConfirmDialog } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { ComicInfoModal } from '../components/ComicInfoModal';
import { MergeSeriesModal } from '../components/MergeSeriesModal';
import { buildTagSearchFragment, cn, timeAgo } from '../lib/utils';
import { toast } from '../lib/toast';
/** Matches below this score are surfaced for review (mirrors the server's threshold). */
const LOW_CONFIDENCE = 0.8;
const SERIES_PAGE_SIZE = 40;

const LIBRARY_STATE_KEY = 'h-tosho:library-state';

interface LibraryStateCache {
  query?: string;
  statusFilter?: string;
  view?: 'grid' | 'table';
  pages?: Record<string, number>;
}

function readLibraryState(): LibraryStateCache {
  try {
    return JSON.parse(sessionStorage.getItem(LIBRARY_STATE_KEY) ?? '{}') as LibraryStateCache;
  } catch {
    return {};
  }
}

function writeLibraryState(update: Partial<LibraryStateCache>) {
  const current = readLibraryState();
  sessionStorage.setItem(LIBRARY_STATE_KEY, JSON.stringify({ ...current, ...update }));
}

function Cover({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  // Covers may be absolute provider URLs or same-origin relative paths
  // (e.g. the Kavita proxy at /api/kavita/series/{id}/cover). Fall back to a
  // letter placeholder when there is no URL or the image fails to load
  // (e.g. Kavita returns 404 because the cover file is missing on disk).
  const showImage = !failed && src !== null && src !== undefined && src !== '' && (/^https?:\/\//i.test(src) || src.startsWith('/'));
  if (showImage) {
    return <img src={src} alt={name} className={cn('h-full w-full object-cover', className)} loading="lazy" onError={() => setFailed(true)} />;
  }
  return (
    <div className={cn('flex h-full w-full items-center justify-center bg-surface-2 text-2xl font-semibold text-muted', className)}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
const ARTIST_SOURCE_META: Record<DoujinSource, { label: string; color: string }> = {
  hitomi: { label: 'Hitomi.la', color: '#ff5722' },
  nhentai: { label: 'nHentai', color: '#e91e63' },
};

/** One-click deep link into the Downloader with an artist search pre-filled. */
function ArtistSearchButton({ source, artists }: { source: DoujinSource; artists: string[] }) {
  const navigate = useNavigate();
  const primary = artists[0];
  const fragment = buildTagSearchFragment(primary, 'artist', source);
  if (!fragment) return null;
  const meta = ARTIST_SOURCE_META[source];
  const target = artists.length > 1 ? `${artists.join(', ')} (first: ${primary})` : `“${primary}”`;
  const title = `Search artist ${target} on ${meta.label}`;
  return (
    <button
      type="button"
      onClick={() => navigate(`/downloader?source=${source}&q=${encodeURIComponent(fragment)}`)}
      title={title}
      className="group/artist inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors duration-150 hover:brightness-125"
      style={{ borderColor: meta.color + '8c', backgroundColor: meta.color + '33' }}
    >
      <Search className="h-3 w-3" />
      <span className="max-w-24 truncate">{primary}</span>
      <span style={{ color: meta.color }}>{meta.label}</span>
      <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity duration-150 group-hover/artist:opacity-100" style={{ color: meta.color }} />
    </button>
  );
}

function CardActionMenu({ row, onEdit }: { row: SeriesRow; onEdit: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const searchArtist = (source: DoujinSource) => {
    const artist = row.artists?.[0];
    const fragment = artist ? buildTagSearchFragment(artist, 'artist', source) : null;
    if (fragment) navigate(`/downloader?source=${source}&q=${encodeURIComponent(fragment)}`);
  };

  return (
    <div ref={root} className="absolute right-1.5 top-1.5 z-30">
      <button type="button" aria-label={`Actions for ${row.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex h-11 w-11 items-center justify-center rounded-md border border-white/20 bg-black/75 text-white transition-colors duration-150 hover:border-primary hover:bg-black">
        <EllipsisVertical className="h-5 w-5" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 w-52 overflow-hidden rounded-md border border-border bg-surface p-1 text-foreground shadow-xl">
          {row.artists?.length ? (['hitomi', 'nhentai'] as const).map((source) => (
            <button key={source} type="button" role="menuitem" onClick={() => searchArtist(source)} className="flex min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
              <img src={`/${source}.png`} alt="" className="h-5 w-5 rounded object-contain" aria-hidden="true" />
              Search {ARTIST_SOURCE_META[source].label}
            </button>
          )) : null}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onEdit(); }} className="flex min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
            <FileText className="h-4 w-4" /> Edit ComicInfo.xml
          </button>
        </div>
      )}
    </div>
  );
}

function PaginationControls({ currentPage, pageCount, firstVisible, lastVisible, total, compact = false, onChange }: { currentPage: number; pageCount: number; firstVisible: number; lastVisible: number; total: number; compact?: boolean; onChange: (page: number) => void }) {
  return (
    <nav aria-label={compact ? 'Series pages above results' : 'Series pages'} className="flex flex-wrap items-center justify-center gap-2">
      <Button size="sm" variant="outline" disabled={currentPage === 1} onClick={() => onChange(Math.max(1, currentPage - 1))} aria-label={compact ? 'Previous series page' : undefined}>
        <ChevronLeft className="h-3.5 w-3.5" /> {!compact && 'Previous'}
      </Button>
      <span className="text-xs tabular-nums text-muted sm:text-sm">{compact ? `${firstVisible}–${lastVisible} of ${total}` : `Page ${currentPage} of ${pageCount} · ${firstVisible}–${lastVisible} of ${total}`}</span>
      <Button size="sm" variant="outline" disabled={currentPage === pageCount} onClick={() => onChange(Math.min(pageCount, currentPage + 1))} aria-label={compact ? 'Next series page' : undefined}>
        {!compact && 'Next'} <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </nav>
  );
}

export function Libraries() {
  const { libraryId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const initialState = React.useMemo(readLibraryState, []);
  const [selected, setSelected] = React.useState<number | null>(libraryId ? Number(libraryId) : null);
  const [query, setQuery] = React.useState(initialState.query ?? '');
  const [statusFilter, setStatusFilter] = React.useState(() => initialState.statusFilter ?? 'all');
  const [view, setView] = React.useState<'grid' | 'table'>(() => initialState.view ?? 'grid');
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [identify, setIdentify] = React.useState<{ id: number; name: string } | null>(null);
  const [comicInfo, setComicInfo] = React.useState<{ id: number; name: string } | null>(null);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [selectMode, setSelectMode] = React.useState(false);
  const [page, setPage] = React.useState(() => libraryId ? initialState.pages?.[libraryId] ?? 1 : 1);
  const [unmatchTarget, setUnmatchTarget] = React.useState<SeriesRow | null>(null);

  React.useEffect(() => {
    if (!libraryId) return;
    setSelected(Number(libraryId));
    setPage(readLibraryState().pages?.[libraryId] ?? 1);
  }, [libraryId]);

  const pickLibrary = (id: number) => {
    setSelected(id);
    setPage(readLibraryState().pages?.[String(id)] ?? 1);
    setChecked(new Set());
    navigate(`/libraries/${id}`);
  };

  const libs = useQuery({ queryKey: ['libraries'], queryFn: api.libraries });
  // The full series list is expensive server-side (Kavita fan-out per request),
  // so only refresh it while a job is actually running — the sidebar's always-on
  // ['jobs'] poll drives this. When the last active job finishes, one explicit
  // refresh captures the outcome without any idle polling.
  const { data: jobs } = useQuery({ queryKey: ['jobs'], queryFn: api.jobs });
  const activeJobs = React.useMemo(
    () => (jobs ?? []).filter((j) => j.status === 'queued' || j.status === 'running').length,
    [jobs],
  );
  const hadActiveJobs = React.useRef(false);
  React.useEffect(() => {
    const wasActive = hadActiveJobs.current;
    hadActiveJobs.current = activeJobs > 0;
    if (wasActive && activeJobs === 0 && selected !== null) {
      void qc.invalidateQueries({ queryKey: ['library-series', selected] });
    }
  }, [activeJobs, selected, qc]);

  const series = useQuery({
    queryKey: ['library-series', selected],
    queryFn: () => api.librarySeries(selected!),
    enabled: selected !== null,
    refetchInterval: activeJobs > 0 ? 5000 : false,
  });
  const currentMeta = useQuery({
    queryKey: ['series', identify?.id],
    queryFn: () => api.series(identify!.id),
    enabled: identify !== null,
  });
  const override = useQuery({
    queryKey: ['library-override', selected],
    queryFn: () => api.libraryOverride(selected!),
    enabled: selected !== null,
  });


  // /libraries no longer has an "all" view — land on the first library once loaded.
  React.useEffect(() => {
    if (selected === null && libs.data && libs.data.length > 0) {
      navigate(`/libraries/${libs.data[0].id}`, { replace: true });
    }
  }, [libs.data, selected, navigate]);

  const rows = series.data ?? [];

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase();
    return rows.filter((r) => {
      const okStatus =
        statusFilter === 'all' ? true :
        statusFilter === 'low-score' ? (r.status === 'matched' && typeof r.matchScore === 'number' && r.matchScore < LOW_CONFIDENCE) :
        r.status === statusFilter;
      const okQuery = query ? r.name.toLowerCase().includes(q) || (r.artists ?? []).some((a) => a.toLowerCase().includes(q)) : true;
      return okStatus && okQuery;
    });
  }, [rows, statusFilter, query]);
  const pageCount = React.useMemo(() => Math.max(1, Math.ceil(filtered.length / SERIES_PAGE_SIZE)), [filtered.length]);
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filtered.slice((currentPage - 1) * SERIES_PAGE_SIZE, currentPage * SERIES_PAGE_SIZE);
  const firstVisible = filtered.length === 0 ? 0 : (currentPage - 1) * SERIES_PAGE_SIZE + 1;
  const lastVisible = Math.min(currentPage * SERIES_PAGE_SIZE, filtered.length);
  React.useEffect(() => writeLibraryState({ query, statusFilter, view }), [query, statusFilter, view]);
  const changePage = (nextPage: number) => {
    setPage(nextPage);
    document.querySelector('main')?.scrollTo({ top: 0 });
  };
  React.useEffect(() => {
    if (selected === null) return;
    writeLibraryState({ pages: { ...(readLibraryState().pages ?? {}), [selected]: page } });
  }, [selected, page]);
  const isFiltering = statusFilter !== 'all' || query.trim() !== '';

  const toggleCheck = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allChecked = visibleRows.length > 0 && visibleRows.every((r) => checked.has(r.id));

  const enqueue = (type: string, payload: Record<string, unknown> = {}) => {
    return api.enqueue(type, payload)
      .then(() => qc.invalidateQueries({ queryKey: ['jobs'] }))
      .catch((error) => toast({ tone: 'danger', title: 'Could not queue job', description: error instanceof Error ? error.message : String(error) }));
  };
  const setAutoMatch = (c: boolean) => {
    if (selected === null) return;
    void api.saveLibraryOverride(selected, { autoMatch: c })
      .then(() => qc.invalidateQueries({ queryKey: ['library-override', selected] }))
      .catch((error) => toast({ tone: 'danger', title: 'Could not update auto-match', description: error instanceof Error ? error.message : String(error) }));
  };

  const unmatch = useMutation({
    mutationFn: (row: SeriesRow) => api.unmatch(row.id),
    onSuccess: (_res, row) => {
      qc.invalidateQueries({ queryKey: ['library-series'] });
      qc.invalidateQueries({ queryKey: ['libraries'] });
      setUnmatchTarget(null);
      toast({ tone: 'success', title: 'Unmatched', description: row.name });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Unmatch failed', description: e instanceof Error ? e.message : String(e) }),
  });

  const matchedInLib = rows.filter((r) => r.status === 'matched').length;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader icon={<BookOpen className="h-5 w-5" />} title="Libraries" subtitle="Review matches and manage Kavita metadata." />
      <div className="sticky -top-3 z-20 -mx-1 -mt-3 flex flex-col gap-3 bg-background px-1 pb-2 pt-3 sm:-top-5 sm:-mt-5 sm:pt-5 lg:-top-8 lg:-mt-8 lg:pt-8">
        {/* View tabs — one per Kavita library. */}
        {libs.isError ? (
          <Card><ErrorState title="Could not load libraries" description={libs.error instanceof Error ? libs.error.message : String(libs.error)} onRetry={() => void libs.refetch()} /></Card>
        ) : libs.data && libs.data.length > 0 ? (
          <div className="flex flex-col gap-2 border-b border-border-2 lg:flex-row lg:items-end">
            <div role="group" aria-label="Kavita library" className="flex max-w-full gap-4 overflow-x-auto">
              {libs.data.map((lib) => (
                <button
                  key={lib.id}
                  type="button"
                  aria-pressed={selected === lib.id}
                  onClick={() => pickLibrary(lib.id)}
                  className={cn('-mb-px shrink-0 border-b-2 px-1 pb-2 text-sm font-medium transition-colors duration-150', selected === lib.id ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground')}
                >
                  {lib.name}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 pb-2 lg:ml-auto lg:flex-nowrap">
              <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => enqueue('match-unmatched', { libraryId: selected })} disabled={selected === null}><Play className="h-3.5 w-3.5" /> Match all unmatched</Button>
              <Button size="sm" className="flex-1 sm:flex-none" onClick={() => enqueue('scan-new', { libraryId: selected })} disabled={selected === null}><RefreshCw className="h-3.5 w-3.5" /> Refresh library</Button>
            </div>
          </div>
        ) : (
          <div className="self-start border-b border-border-2 pb-2 text-sm text-muted">
            {libs.isLoading ? 'Loading libraries…' : 'No libraries — connect Kavita in Settings.'}
          </div>
        )}

        {selected !== null && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{series.data ? (isFiltering ? `${filtered.length} of ${rows.length} series` : `${rows.length} series`) : 'Loading…'}</h2>
                <p className="text-sm text-muted">{matchedInLib} matched · {rows.length - matchedInLib} pending</p>
              </div>
              {filtered.length > SERIES_PAGE_SIZE && (
                <PaginationControls currentPage={currentPage} pageCount={pageCount} firstVisible={firstVisible} lastVisible={lastVisible} total={filtered.length} compact onChange={changePage} />
              )}
            </div>
            <div className="grid w-full grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
              <div className="relative col-span-2 min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input aria-label="Filter series or artists" placeholder="Filter series or artist…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} className="w-full pl-8" />
              </div>
              <Select aria-label="Filter by match status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="min-w-0 sm:w-44">
                <option value="all">All</option>
                <option value="matched">Matched</option>
                <option value="unmatched">Unmatched</option>
                <option value="failed">Failed</option>
                <option value="low-score">Low confidence (&lt;80%)</option>
              </Select>
              <Button className="w-full sm:w-auto" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode((m) => !m)} title={selectMode ? 'Exit multi-select mode' : 'Multi-select — click cards to select them'}>
                <CheckSquare className="h-4 w-4" /> Select
              </Button>
              <label className="flex h-9 min-w-0 cursor-pointer select-none items-center justify-between gap-2 rounded-md border border-border-2 bg-surface px-3 text-xs font-medium text-muted transition-colors duration-150 hover:bg-surface-2 sm:justify-start">
                Auto-match
                <Switch aria-label="Automatically match new series" checked={override.data?.autoMatch ?? true} onCheckedChange={setAutoMatch} />
              </label>
              <div className="ml-auto flex overflow-hidden rounded-md border border-border-2 sm:ml-0">
                <button type="button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')} className={cn('flex h-9 w-9 items-center justify-center transition-colors duration-150', view === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2')}><LayoutGrid className="h-4 w-4" /></button>
                <button type="button" aria-label="Table view" aria-pressed={view === 'table'} onClick={() => setView('table')} className={cn('flex h-9 w-9 items-center justify-center transition-colors duration-150', view === 'table' ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2')}><Table2 className="h-4 w-4" /></button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {selected === null ? (
          <Card className="flex flex-1 items-center justify-center">
            <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Select a library" description="Pick a Kavita library above to browse and identify its series." />
          </Card>
        ) : (
          <>

            {(selectMode || checked.size > 0) && (
              <div className={cn('flex animate-scale-in flex-wrap items-center gap-2 rounded-lg border p-2', selectMode ? 'border-primary/50 bg-primary/10' : 'border-border-2 bg-surface-2')}>
                {selectMode && (
                  <>
                    <CheckSquare className="h-4 w-4 shrink-0 text-primary" />
                    <span className="text-xs font-medium text-primary">Selection mode — click cards to select or deselect</span>
                  </>
                )}
                {checked.size > 0 && (
                  <>
                    <Badge tone="info">{checked.size} selected</Badge>
                    <Button size="sm" onClick={() => setMergeOpen(true)} disabled={checked.size < 2} title={checked.size < 2 ? 'Select at least two series' : undefined}>
                      <Combine className="h-3.5 w-3.5" /> Merge selected
                    </Button>
                  </>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={checked.size === 0} onClick={() => setChecked(new Set())}>
                    Clear selection
                  </Button>
                </div>
              </div>
            )}

            {series.isError ? (
              <Card><ErrorState title="Could not load series" description={series.error instanceof Error ? series.error.message : String(series.error)} onRetry={() => void series.refetch()} /></Card>
            ) : series.isLoading ? (
              <div role="status" aria-label="Loading series" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {Array.from({ length: 12 }, (_, index) => (
                  <Card key={index} className="overflow-hidden"><Skeleton className="aspect-[3/4] w-full rounded-none" /></Card>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <Card className="flex flex-1 items-center justify-center">
                <EmptyState title="No series" description="No series match the current filters." />
              </Card>
            ) : view === 'grid' ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {visibleRows.map((r, i) => (
                  <Card
                    key={r.id}
                    style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                    className={cn(
                      'group relative z-0 animate-fade-up cursor-pointer transition-colors duration-200 hover:border-border-2 focus-within:z-40',
                      checked.has(r.id) && 'border-primary/60 ring-2 ring-primary',
                    )}
                  >
                    <button
                      className={cn('absolute inset-0 rounded-xl', selectMode ? 'z-30' : 'z-10')}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (selectMode) toggleCheck(r.id);
                        else setIdentify({ id: r.id, name: r.name });
                      }}
                      title={selectMode ? (checked.has(r.id) ? 'Deselect series' : 'Select series') : `Identify ${r.name}`}
                      aria-label={selectMode ? (checked.has(r.id) ? `Deselect ${r.name}` : `Select ${r.name}`) : `Identify ${r.name}`}
                    />
                    <span className={cn('absolute left-2 top-2 z-20 h-3 w-3 rounded-full border-2 border-black/60 shadow-sm', r.status === 'matched' ? 'bg-success' : r.status === 'failed' ? 'bg-danger' : r.status === 'syncing' ? 'bg-warning' : 'bg-muted')} title={`Status: ${r.status}`} aria-hidden="true" />
                    {checked.has(r.id) && (
                      <div className="pointer-events-none absolute bottom-2 left-2 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-primary bg-primary text-white" aria-hidden><Check className="h-3.5 w-3.5" /></div>
                    )}
                    {!selectMode && <CardActionMenu row={r} onEdit={() => setComicInfo({ id: r.id, name: r.name })} />}
                    <div className="aspect-[3/4] w-full overflow-hidden rounded-lg">
                      <Cover src={r.cover} name={r.name} className="transition-transform duration-300 ease-out group-hover:scale-105" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-black/90 to-transparent p-2 pt-6">
                      <p className="min-h-8 overflow-hidden text-xs font-semibold leading-4 text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [text-shadow:1px_0_0_rgba(0,0,0,0.85),-1px_0_0_rgba(0,0,0,0.85),0_1px_0_rgba(0,0,0,0.85),0_-1px_0_rgba(0,0,0,0.85),0_2px_3px_rgba(0,0,0,0.6)]">{r.name}</p>
                      <div className="flex flex-wrap items-center gap-1">
                        {r.providerId && <ProviderBadge id={r.providerId} solid />}
                        <StatusBadge status={r.status} className="bg-black/70" />
                        {r.aligned && <span className="rounded bg-success/90 px-1.5 py-0.5 text-2xs font-medium text-white">Aligned</span>}
                        {typeof r.pageCount === 'number' && r.pageCount > 0 && <span className="rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-white/80">{r.pageCount} pages</span>}
                      </div>
                      {r.status === 'failed' && r.errorMessage && <span className="line-clamp-2 text-2xs text-red-200">{r.errorMessage}</span>}
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="overflow-x-auto">
                <table className="min-w-[760px] w-full text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className="px-3 py-2">
                        <label className="flex h-9 w-9 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={() => setChecked(allChecked ? new Set([...checked].filter((id) => !visibleRows.some((r) => r.id === id))) : new Set([...checked, ...visibleRows.map((r) => r.id)]))}
                            aria-label="Select all series on this page"
                            className="h-4 w-4 accent-[var(--color-primary)]"
                          />
                        </label>
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted">Series</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted">Status</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted">Provider</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted">Score</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted">Pages</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted">Synced</th>
                      <th className="min-w-56 whitespace-nowrap px-3 py-2 text-right font-medium text-muted">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0 transition-colors hover:bg-surface-2/60">
                        <td className="px-3 py-2.5">
                          <label className="flex h-9 w-9 cursor-pointer items-center justify-center">
                            <input type="checkbox" aria-label={`Select ${r.name}`} checked={checked.has(r.id)} onChange={() => toggleCheck(r.id)} className="h-4 w-4 accent-[var(--color-primary)]" />
                          </label>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-9 w-6 overflow-hidden rounded border border-border bg-surface-2">
                              <Cover src={r.cover} name={r.name} />
                            </div>
                            <span className="font-medium">{r.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status={r.status} className="whitespace-nowrap" />
                          {r.status === 'failed' && r.errorMessage && <p className="mt-1 max-w-48 break-words text-xs text-danger">{r.errorMessage}</p>}
                        </td>
                        <td className="px-3 py-2.5">
                          {r.providerId ? (
                            <div className="flex items-center gap-1.5">
                              <ProviderBadge id={r.providerId} />
                              {r.aligned && <span className="rounded bg-success/15 px-1.5 py-0.5 text-2xs font-medium text-success">Aligned</span>}
                            </div>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-muted">
                          {typeof r.matchScore === 'number' ? (
                            <span
                              className={cn('tabular-nums', r.status === 'matched' && r.matchScore < LOW_CONFIDENCE && 'font-medium text-warning')}
                              title={r.status === 'matched' && r.matchScore < LOW_CONFIDENCE ? `Low confidence (${Math.round(r.matchScore * 100)}%) — review via the “Low confidence” filter` : undefined}
                            >
                              {Math.round(r.matchScore * 100)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-muted">{typeof r.pageCount === 'number' && r.pageCount > 0 ? `${r.pageCount}` : '—'}</td>
                        <td className="px-3 py-2.5 text-xs text-muted">{timeAgo(r.lastSyncedAt)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {r.artists?.length ? (
                              <>
                                <ArtistSearchButton source="hitomi" artists={r.artists} />
                                <ArtistSearchButton source="nhentai" artists={r.artists} />
                              </>
                            ) : null}
                            {r.providerId && (
                              <Button size="sm" variant="ghost" onClick={() => setUnmatchTarget(r)} title="Remove this match and remove metadata and covers previously applied by H-Tosho from Kavita">
                                <Unlink className="h-3.5 w-3.5" /> Unmatch
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setComicInfo({ id: r.id, name: r.name })} title="Edit the ComicInfo.xml of this series' .cbz files">
                              <FileText className="h-3.5 w-3.5" /> ComicInfo
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setIdentify({ id: r.id, name: r.name })}>
                              <Sparkles className="h-3.5 w-3.5" /> Identify
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
            {filtered.length > SERIES_PAGE_SIZE && (
              <div className="pt-2">
                <PaginationControls currentPage={currentPage} pageCount={pageCount} firstVisible={firstVisible} lastVisible={lastVisible} total={filtered.length} onChange={changePage} />
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={unmatchTarget !== null}
        title="Unmatch series?"
        description={unmatchTarget ? `This removes the match and removes metadata and covers previously applied by H-Tosho from “${unmatchTarget.name}”.` : ''}
        confirmLabel="Unmatch"
        danger
        pending={unmatch.isPending}
        onOpenChange={(open) => { if (!open && !unmatch.isPending) setUnmatchTarget(null); }}
        onConfirm={() => { if (unmatchTarget) unmatch.mutate(unmatchTarget); }}
      />
      {identify && (
        <IdentifyModal
          seriesId={identify.id}
          current={{
            name: currentMeta.data?.series.name ?? identify.name,
            metadata: currentMeta.data?.kavita ?? null,
          }}
          match={currentMeta.data?.match ?? null}
          onClose={() => setIdentify(null)}
        />
      )}

      {comicInfo && (
        <ComicInfoModal seriesId={comicInfo.id} onClose={() => setComicInfo(null)} />
      )}

      {mergeOpen && (
        <MergeSeriesModal
          selected={(series.data ?? []).filter((r) => checked.has(r.id))}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </div>
  );
}