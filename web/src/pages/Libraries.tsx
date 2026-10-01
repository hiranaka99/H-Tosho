import * as React from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
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
function needsReview(row: SeriesRow): boolean {
  return row.status === 'matched' && !row.confirmed && typeof row.matchScore === 'number' && row.matchScore < LOW_CONFIDENCE;
}
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
  React.useEffect(() => setFailed(false), [src]);
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
  const trigger = React.useRef<HTMLButtonElement>(null);
  const menuId = React.useId();
  const focusLast = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    const menu = root.current?.querySelector<HTMLElement>('[role="menu"]');
    if (menu) {
      const bounds = menu.getBoundingClientRect();
      const offset = bounds.left < 8 ? 8 - bounds.left : Math.min(0, window.innerWidth - 8 - bounds.right);
      menu.style.transform = `translateX(${offset}px)`;
    }
    const items = root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus();
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    const resize = () => setOpen(false);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  const searchArtist = (source: DoujinSource) => {
    const artist = row.artists?.[0];
    const fragment = artist ? buildTagSearchFragment(artist, 'artist', source) : null;
    setOpen(false);
    if (fragment) navigate(`/downloader?source=${source}&q=${encodeURIComponent(fragment)}`);
  };

  const menuKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const match = [...items.slice(index + 1), ...items.slice(0, index + 1)].find((item) => item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) next = items.indexOf(match);
    }
    if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
  };

  return (
    <div ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} className="absolute right-1.5 top-1.5 z-30">
      <button ref={trigger} type="button" aria-label={`Actions for ${row.name}`} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} onClick={() => { focusLast.current = false; setOpen((value) => !value); }} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setOpen(true); } }} className="flex h-11 w-11 items-center justify-center rounded-md border border-white/20 bg-black/75 text-white transition-colors duration-150 hover:border-primary hover:bg-black">
        <EllipsisVertical className="h-5 w-5" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={`Actions for ${row.name}`} onKeyDown={menuKeys} className="absolute right-0 top-full mt-1 w-52 overflow-hidden rounded-md border border-border bg-surface p-1 text-foreground shadow-xl">
          {row.artists?.length ? (['hitomi', 'nhentai'] as const).map((source) => (
            <button key={source} type="button" role="menuitem" tabIndex={-1} onClick={() => searchArtist(source)} className="flex min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
              <img src={`/${source}.png`} alt="" className="h-5 w-5 rounded object-contain" aria-hidden="true" />
              Search {ARTIST_SOURCE_META[source].label}
            </button>
          )) : null}
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); trigger.current?.focus(); onEdit(); }} className="flex min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
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

export function Libraries({ review = false }: { review?: boolean }) {
  const { libraryId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const initialState = React.useMemo(readLibraryState, []);
  const [selected, setSelected] = React.useState<number | null>(libraryId ? Number(libraryId) : null);
  const [query, setQuery] = React.useState(review ? '' : initialState.query ?? '');
  const [statusFilter, setStatusFilter] = React.useState(() => review ? 'all' : initialState.statusFilter ?? 'all');
  const [view, setView] = React.useState<'grid' | 'table'>(() => initialState.view ?? 'grid');
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [identify, setIdentify] = React.useState<{ id: number; name: string; cover?: string | null } | null>(null);
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

  const connection = useQuery({ queryKey: ['kavita-status'], queryFn: api.kavitaStatus });
  const needsConnection = connection.data?.configured === false;
  const libs = useQuery({ queryKey: ['libraries'], queryFn: api.libraries, enabled: !needsConnection });
  // The full series list is expensive server-side (Kavita fan-out per request),
  // so only refresh it while a job is actually running — the sidebar's always-on
  // ['jobs'] poll drives this. When the last active job finishes, one explicit
  // refresh captures the outcome without any idle polling.
  const { data: jobs } = useQuery({ queryKey: ['jobs'], queryFn: api.jobs });
  const activeJobs = React.useMemo(
    () => (jobs ?? []).filter((j) => j.status === 'queued' || j.status === 'running').length,
    [jobs],
  );

  const series = useQuery({
    queryKey: ['library-series', review ? 'review' : selected],
    queryFn: () => review ? api.reviewSeries() : api.librarySeries(selected!),
    enabled: !needsConnection && (review || selected !== null),
    refetchInterval: activeJobs > 0 && !identify ? 5000 : false,
  });
  const currentMeta = useQuery({
    queryKey: ['series', identify?.id],
    queryFn: () => api.series(identify!.id),
    enabled: identify !== null,
  });
  const override = useQuery({
    queryKey: ['library-override', selected],
    queryFn: () => api.libraryOverride(selected!),
    enabled: !review && selected !== null,
  });


  // /libraries no longer has an "all" view — land on the first library once loaded.
  React.useEffect(() => {
    if (!review && selected === null && libs.data && libs.data.length > 0) {
      navigate(`/libraries/${libs.data[0].id}`, { replace: true });
    }
  }, [libs.data, selected, navigate, review]);

  const rows = series.data ?? [];

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase();
    return rows.filter((r) => {
      const okStatus =
        review || statusFilter === 'all' ? true :
        statusFilter === 'low-score' ? needsReview(r) :
        r.status === statusFilter;
      const okQuery = query ? r.name.toLowerCase().includes(q) || (r.artists ?? []).some((a) => a.toLowerCase().includes(q)) : true;
      return okStatus && okQuery;
    });
  }, [rows, statusFilter, query, review]);
  const pageCount = React.useMemo(() => Math.max(1, Math.ceil(filtered.length / SERIES_PAGE_SIZE)), [filtered.length]);
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filtered.slice((currentPage - 1) * SERIES_PAGE_SIZE, currentPage * SERIES_PAGE_SIZE);
  const firstVisible = filtered.length === 0 ? 0 : (currentPage - 1) * SERIES_PAGE_SIZE + 1;
  const lastVisible = Math.min(currentPage * SERIES_PAGE_SIZE, filtered.length);
  React.useEffect(() => writeLibraryState(review ? { view } : { query, statusFilter, view }), [query, statusFilter, view, review]);
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
      qc.invalidateQueries({ queryKey: ['low-confidence'] });
      setUnmatchTarget(null);
      toast({ tone: 'success', title: 'Unmatched', description: row.name });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Unmatch failed', description: e instanceof Error ? e.message : String(e) }),
  });

  const matchedInLib = rows.filter((r) => r.status === 'matched').length;

  if (needsConnection) {
    return <div className="flex flex-col gap-4">
      <PageHeader icon={<BookOpen className="h-5 w-5" />} title="Libraries" subtitle="Review matches and manage Kavita metadata." />
      <Card className="flex flex-col items-center pb-8">
        <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Connect your Kavita library" description="Connect Kavita to browse your series, identify matches, and keep metadata up to date." />
        <Button asChild><Link to="/settings#kavita-connection">Connect Kavita</Link></Button>
      </Card>
    </div>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader icon={<BookOpen className="h-5 w-5" />} title={review ? 'Needs review' : 'Libraries'} subtitle={review ? 'Review uncertain matches across all your libraries.' : 'Review matches and manage Kavita metadata.'} />
      <div className="sticky top-0 z-20 -mx-1 flex flex-col gap-3 bg-background px-1 py-2">
        {/* View tabs — one per Kavita library. */}
        {libs.isError ? (
          <Card><ErrorState title="Could not load libraries" description={libs.error instanceof Error ? libs.error.message : String(libs.error)} onRetry={() => void libs.refetch()} /></Card>
        ) : libs.data && libs.data.length > 0 ? (
          <div className="flex flex-col gap-2 border-b border-border-2 lg:flex-row lg:items-end">
            <div role="group" aria-label="Kavita library" className="flex min-w-0 max-w-full gap-4 overflow-x-auto p-1">
              {libs.data.map((lib) => (
                <button
                  key={lib.id}
                  type="button"
                  aria-pressed={!review && selected === lib.id}
                  onClick={() => pickLibrary(lib.id)}
                  className={cn('shrink-0 border-b-2 px-1 pb-2 text-sm font-medium transition-colors duration-150', !review && selected === lib.id ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground')}
                >
                  {lib.name}
                </button>
              ))}
              <Link to="/libraries/review" aria-current={review ? 'page' : undefined} className={cn('shrink-0 border-b-2 px-1 pb-2 text-sm font-medium', review ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground')}>Needs review</Link>
            </div>
            {!review && <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2 lg:ml-auto lg:flex-nowrap">
              <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => enqueue('match-unmatched', { libraryId: selected })} disabled={selected === null}><Play className="h-3.5 w-3.5" /> Match all unmatched</Button>
              <Button size="sm" className="flex-1 sm:flex-none" onClick={() => enqueue('scan-new', { libraryId: selected })} disabled={selected === null}><RefreshCw className="h-3.5 w-3.5" /> Refresh library</Button>
            </div>}
          </div>
        ) : (
          <div className="self-start border-b border-border-2 pb-2 text-sm text-muted">
            {libs.isLoading ? 'Loading libraries…' : 'No libraries — connect Kavita in Settings.'}
          </div>
        )}

        {(review || selected !== null) && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{series.data ? (isFiltering ? `${filtered.length} of ${rows.length} series` : `${rows.length} series`) : 'Loading…'}</h2>
                <p className="text-sm text-muted">{review ? 'Matches below 80% confidence · All libraries' : `${matchedInLib} matched · ${rows.length - matchedInLib} pending`}</p>
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
              {!review && <Select aria-label="Filter by match status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="min-w-0 sm:w-44">
                <option value="all">All</option>
                <option value="matched">Matched</option>
                <option value="unmatched">Unmatched</option>
                <option value="failed">Failed</option>
                <option value="low-score">Needs review (&lt;80%)</option>
              </Select>}
              {!review && <Button className="w-full sm:w-auto" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode((m) => !m)} title={selectMode ? 'Exit multi-select mode' : 'Multi-select — click cards to select them'}>
                <CheckSquare className="h-4 w-4" /> Select
              </Button>}
              {!review && <label className="flex h-9 min-w-0 cursor-pointer select-none items-center justify-between gap-2 rounded-md border border-border-2 bg-surface px-3 text-xs font-medium text-muted transition-colors duration-150 hover:bg-surface-2 sm:justify-start">
                Auto-match
                <Switch aria-label="Automatically match new series" checked={override.data?.autoMatch ?? true} onCheckedChange={setAutoMatch} />
              </label>}
              <div className="ml-auto flex overflow-hidden rounded-md border border-border-2 sm:ml-0">
                <button type="button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')} className={cn('flex h-9 w-9 items-center justify-center transition-colors duration-150', view === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2')}><LayoutGrid className="h-4 w-4" /></button>
                <button type="button" aria-label="Table view" aria-pressed={view === 'table'} onClick={() => setView('table')} className={cn('flex h-9 w-9 items-center justify-center transition-colors duration-150', view === 'table' ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2')}><Table2 className="h-4 w-4" /></button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {!review && selected === null ? (
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
                <EmptyState title={review && !query ? 'All caught up' : 'No series'} description={review && !query ? 'No matches need review. New uncertain matches will appear here.' : 'No series match the current filters.'} />
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
                      type="button"
                      className="flex h-full w-full flex-col rounded-lg text-left"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (selectMode) toggleCheck(r.id);
                        else setIdentify({ id: r.id, name: r.name, cover: r.cover });
                      }}
                      title={selectMode ? (checked.has(r.id) ? 'Deselect series' : 'Select series') : `Identify ${r.name}`}
                      aria-label={selectMode ? (checked.has(r.id) ? `Deselect ${r.name}` : `Select ${r.name}`) : `Identify ${r.name}`}
                      aria-pressed={selectMode ? checked.has(r.id) : undefined}
                    >
                      {checked.has(r.id) && (
                        <span className="pointer-events-none absolute left-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-primary-button text-white" aria-hidden><Check className="h-4 w-4" /></span>
                      )}
                      <div className="aspect-[3/4] w-full overflow-hidden rounded-t-lg">
                        <Cover src={r.cover} name={r.name} className="transition-transform duration-300 ease-out group-hover:scale-105" />
                      </div>
                      <div className="flex w-full flex-1 flex-col gap-2 p-3">
                        <p className="min-h-10 overflow-hidden text-sm font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">{r.name}</p>
                        {review && <p className="text-xs text-muted">{r.libraryName}</p>}
                        <div className="mt-auto flex flex-wrap items-center gap-1">
                          {needsReview(r)
                            ? <Badge tone="warning">Needs review · {Math.round(r.matchScore! * 100)}%</Badge>
                            : <StatusBadge status={r.status} />}
                        </div>
                      </div>
                    </button>
                    {!selectMode && <CardActionMenu row={r} onEdit={() => setComicInfo({ id: r.id, name: r.name })} />}
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="overflow-x-auto">
                <table className="min-w-[760px] w-full text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      {!review && <th className="px-3 py-2">
                        <label className="flex h-9 w-9 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={() => setChecked(allChecked ? new Set([...checked].filter((id) => !visibleRows.some((r) => r.id === id))) : new Set([...checked, ...visibleRows.map((r) => r.id)]))}
                            aria-label="Select all series on this page"
                            className="h-4 w-4 accent-[var(--color-primary)]"
                          />
                        </label>
                      </th>}
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
                        {!review && <td className="px-3 py-2.5">
                          <label className="flex h-9 w-9 cursor-pointer items-center justify-center">
                            <input type="checkbox" aria-label={`Select ${r.name}`} checked={checked.has(r.id)} onChange={() => toggleCheck(r.id)} className="h-4 w-4 accent-[var(--color-primary)]" />
                          </label>
                        </td>}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-9 w-6 overflow-hidden rounded border border-border bg-surface-2">
                              <Cover src={r.cover} name={r.name} />
                            </div>
                            <div><span className="font-medium">{r.name}</span>{review && <p className="text-xs text-muted">{r.libraryName}</p>}</div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {needsReview(r)
                            ? <Badge tone="warning">Needs review · {Math.round(r.matchScore! * 100)}%</Badge>
                            : <StatusBadge status={r.status} className="whitespace-nowrap" />}
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
                              className={cn('tabular-nums', needsReview(r) && 'font-medium text-warning')}
                              title={needsReview(r) ? `Needs review (${Math.round(r.matchScore * 100)}% confidence)` : r.confirmed ? 'Manually confirmed match' : undefined}
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
                            <Button size="sm" variant="outline" onClick={() => setIdentify({ id: r.id, name: r.name, cover: r.cover })}>
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
          currentCover={identify.cover}
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
