import * as React from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Search, RefreshCw, Play, BookOpen, Unlink, FileText, Combine, Check, CheckSquare, ChevronLeft, ChevronRight, EllipsisVertical } from 'lucide-react';
import { api, type SeriesRow, type DoujinSource } from '../lib/api';
import { Button, Card, Input, Select, Badge, StatusBadge, Skeleton, EmptyState, Switch, PageHeader, ErrorState, ConfirmDialog, SegmentedControl, TabPanel } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { ComicInfoModal } from '../components/ComicInfoModal';
import { MergeSeriesModal } from '../components/MergeSeriesModal';
import { PageCountPill } from '../components/PageCountPill';
import { buildTagSearchFragment, cn } from '../lib/utils';
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

function CardActionMenu({ row, onEdit, onUnmatch }: { row: SeriesRow; onEdit: () => void; onUnmatch: () => void }) {
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
            <button key={source} type="button" role="menuitem" tabIndex={-1} onClick={() => searchArtist(source)} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
              <img src={`/${source}.png`} alt="" className="h-5 w-5 rounded object-contain" aria-hidden="true" />
              Search {ARTIST_SOURCE_META[source].label}
            </button>
          )) : null}
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); trigger.current?.focus(); onEdit(); }} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
            <FileText className="h-4 w-4" /> Edit ComicInfo.xml
          </button>
          {row.providerId && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); trigger.current?.focus(); onUnmatch(); }} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
              <Unlink className="h-4 w-4" /> Unmatch series
            </button>
          )}
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
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const initialState = React.useMemo(readLibraryState, []);
  const [selected, setSelected] = React.useState<number | null>(libraryId ? Number(libraryId) : null);
  const [query, setQuery] = React.useState(review ? '' : initialState.query ?? '');
  const [statusFilter, setStatusFilter] = React.useState(() => review ? 'all' : initialState.statusFilter ?? 'all');
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [identify, setIdentify] = React.useState<{ id: number; name: string; cover?: string | null } | null>(null);
  const [comicInfo, setComicInfo] = React.useState<{ id: number; name: string } | null>(null);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [selectMode, setSelectMode] = React.useState(false);
  const [page, setPage] = React.useState(() => libraryId ? initialState.pages?.[libraryId] ?? 1 : 1);
  const [unmatchTarget, setUnmatchTarget] = React.useState<SeriesRow | null>(null);
  const [recoveryFile, setRecoveryFile] = React.useState<string | null>(null);
  const requestedSeries = Number(searchParams.get('series'));
  const linkedSeriesId = Number.isSafeInteger(requestedSeries) && requestedSeries > 0 ? requestedSeries : null;
  const linkedSeries = useQuery({ queryKey: ['series', linkedSeriesId], queryFn: () => api.series(linkedSeriesId!), enabled: linkedSeriesId !== null });
  const handledLink = React.useRef('');
  React.useEffect(() => {
    const key = searchParams.toString();
    if (key === handledLink.current) return;
    if (searchParams.get('file') && !linkedSeriesId) {
      setRecoveryFile(searchParams.get('file'));
      handledLink.current = key;
    } else if (linkedSeries.data && linkedSeriesId !== null) {
      const series = linkedSeries.data.series;
      setSelected(series.libraryId);
      setQuery(searchParams.get('q') ?? series.name);
      setStatusFilter('all');
      setPage(1);
      const target = { id: series.id, name: series.name, cover: series.cover };
      if (searchParams.get('action') === 'identify') setIdentify(target);
      if (searchParams.get('action') === 'comicinfo') setComicInfo(target);
      handledLink.current = key;
    } else if (!linkedSeriesId) {
      if (searchParams.has('q')) { setQuery(searchParams.get('q') ?? ''); setStatusFilter('all'); setPage(1); }
      handledLink.current = key;
    }
  }, [searchParams, linkedSeries.data, linkedSeriesId]);

  React.useEffect(() => {
    if (!libraryId) return;
    setSelected(Number(libraryId));
    setPage(readLibraryState().pages?.[libraryId] ?? 1);
    setChecked(new Set());
    setMergeOpen(false);
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
  const reviewCount = useQuery({ queryKey: ['low-confidence'], queryFn: api.lowConfidenceCount, enabled: !needsConnection, refetchInterval: 60_000 });
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
    if (!review && selected === null && linkedSeriesId === null && libs.data && libs.data.length > 0) {
      if (searchParams.has('file')) setSelected(libs.data[0].id);
      else navigate(`/libraries/${libs.data[0].id}${searchParams.size ? `?${searchParams}` : ''}`, { replace: true });
    }
  }, [libs.data, selected, navigate, review, linkedSeriesId, searchParams]);

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
  React.useEffect(() => {
    if (!review) writeLibraryState({ query, statusFilter });
  }, [query, statusFilter, review]);
  const changePage = (nextPage: number) => {
    setPage(nextPage);
    document.querySelector('main')?.scrollTo({ top: 0 });
  };
  React.useEffect(() => {
    if (selected === null) return;
    writeLibraryState({ pages: { ...(readLibraryState().pages ?? {}), [selected]: page } });
  }, [selected, page]);
  const isFiltering = (!review && statusFilter !== 'all') || query !== '';
  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setPage(1);
  };

  const toggleCheck = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      {linkedSeriesId && linkedSeries.isPending && <p role="status" className="text-sm text-muted">Opening series…</p>}
      {linkedSeries.isError && <ErrorState title="Could not open series" description={linkedSeries.error.message} onRetry={() => void linkedSeries.refetch()} />}
      <Card className="min-w-0">
        <div className="flex min-w-0 flex-col gap-3 border-b border-border px-3 py-3 sm:px-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {libs.isError ? (
              <ErrorState title="Could not load libraries" description={libs.error instanceof Error ? libs.error.message : String(libs.error)} onRetry={() => void libs.refetch()} />
            ) : libs.data && libs.data.length > 0 ? (
              <SegmentedControl items={libs.data.map((lib) => ({ id: lib.id, label: lib.name }))} value={review ? null : selected} onChange={pickLibrary} label="Kavita library" />
            ) : (
              <p className="text-sm text-muted">{libs.isLoading ? 'Loading libraries…' : 'No libraries — connect Kavita in Settings.'}</p>
            )}
            {reviewCount.data && reviewCount.data.count > 0 && (
              <Link to="/libraries/review" aria-current={review ? 'page' : undefined} className="inline-flex min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0 items-center gap-2 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10">
                Needs review <Badge tone="warning">{reviewCount.data.count}</Badge>
              </Link>
            )}
          </div>
          {!review && (
            <div role="group" aria-label="Library actions" className="flex min-w-0 flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 flex-1 sm:flex-none" onClick={() => enqueue('scan-new', { libraryId: selected })} disabled={selected === null}><RefreshCw className="h-3.5 w-3.5 shrink-0" /> Refresh library</Button>
              <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 flex-1 sm:flex-none" onClick={() => enqueue('match-unmatched', { libraryId: selected })} disabled={selected === null}><Play className="h-3.5 w-3.5 shrink-0" /> Match all unmatched</Button>
              <label className="flex min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 w-full cursor-pointer select-none items-center justify-between gap-3 px-1 text-xs font-medium text-muted sm:w-auto sm:pl-3">
                Auto-match new series
                <Switch aria-label="Automatically match new series" checked={override.data?.autoMatch ?? true} onCheckedChange={setAutoMatch} disabled={selected === null} />
              </label>
            </div>
          )}
        </div>

        {(review || selected !== null) && (
          <div className="flex flex-col gap-3 p-3 sm:p-4">
            <div className="grid w-full grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
              <div className="relative col-span-2 min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input aria-label="Filter series or artists" placeholder="Search series or artists…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-full pl-8 sm:min-h-9" />
              </div>
              {!review && <Select aria-label="Filter by match status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="max-lg:min-h-11 pointer-coarse:min-h-11 min-w-0 sm:min-h-9 sm:w-44">
                <option value="all">All statuses</option>
                <option value="matched">Matched</option>
                <option value="unmatched">Unmatched</option>
                <option value="failed">Failed</option>
                <option value="low-score">Needs review (&lt;80%)</option>
              </Select>}
              {!review && !selectMode && checked.size === 0 && (
                <Button variant="outline" className="max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0 sm:min-h-9" onClick={() => setSelectMode(true)}><CheckSquare className="h-4 w-4" /> Select series</Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold tabular-nums">{series.data ? (isFiltering ? `${filtered.length} of ${rows.length} series` : `${rows.length} series`) : 'Loading…'}</h2>
                {series.data && <p className="text-xs text-muted">{review ? 'Matches below 80% confidence · All libraries' : `${matchedInLib} matched · ${rows.length - matchedInLib} pending`}</p>}
              </div>
              {filtered.length > SERIES_PAGE_SIZE && (
                <PaginationControls currentPage={currentPage} pageCount={pageCount} firstVisible={firstVisible} lastVisible={lastVisible} total={filtered.length} compact onChange={changePage} />
              )}
            </div>
          </div>
        )}
      </Card>

      {!review && selected !== null && (selectMode || checked.size > 0) && (
        <div role="region" aria-label="Series selection" className="sticky top-0 z-40 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-primary/50 bg-surface px-3 py-2 shadow-md sm:mx-0">
          <span role="status" className="mr-auto text-sm font-medium tabular-nums">{checked.size} selected</span>
          <Button size="sm" className="max-lg:min-h-11 pointer-coarse:min-h-11 sm:min-h-9" onClick={() => setMergeOpen(true)} disabled={checked.size < 2} title={checked.size < 2 ? 'Select at least two series' : undefined}>
            <Combine className="h-3.5 w-3.5" /> <span>Merge<span className="hidden sm:inline"> selected</span></span>
          </Button>
          <Button size="sm" variant="ghost" className="max-lg:min-h-11 pointer-coarse:min-h-11 sm:min-h-9" disabled={checked.size === 0} onClick={() => setChecked(new Set())}><span>Clear<span className="hidden sm:inline"> selection</span></span></Button>
          <Button size="sm" variant="outline" className="max-lg:min-h-11 pointer-coarse:min-h-11 sm:min-h-9" onClick={() => { setSelectMode(false); setChecked(new Set()); }}><span>Exit<span className="hidden sm:inline"> selection</span></span></Button>
        </div>
      )}

      <TabPanel value={`${review ? 'review' : selected}:${series.isLoading ? 'loading' : 'ready'}`} role="region" aria-label="Library series" className="flex-1 gap-3">
        {!review && selected === null ? (
          <Card className="flex flex-1 items-center justify-center">
            <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Select a library" description="Pick a Kavita library above to browse and identify its series." />
          </Card>
        ) : (
          <>
            {series.isError ? (
              <Card><ErrorState title="Could not load series" description={series.error instanceof Error ? series.error.message : String(series.error)} onRetry={() => void series.refetch()} /></Card>
            ) : series.isLoading ? (
              <div role="status" aria-label="Loading series" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {Array.from({ length: 12 }, (_, index) => (
                  <Card key={index} className="overflow-hidden"><Skeleton className="aspect-[3/4] w-full rounded-none" /></Card>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <Card className="flex flex-1 flex-col items-center justify-center pb-6">
                <EmptyState title={review && rows.length === 0 ? 'All caught up' : 'No series'} description={review && rows.length === 0 ? 'No matches need review. New uncertain matches will appear here.' : 'No series match the current filters.'} />
                {isFiltering && !(review && rows.length === 0) && <Button variant="outline" className="max-lg:min-h-11 pointer-coarse:min-h-11 sm:min-h-9" onClick={clearFilters}>Clear filters</Button>}
              </Card>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {visibleRows.map((r, i) => (
                  <Card
                    key={r.id}
                    style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                    className={cn(
                      'ui-card-interactive group relative z-0 min-w-0 animate-fade-up cursor-pointer transition-colors duration-200 hover:border-border-2 focus-within:z-40',
                      checked.has(r.id) && 'border-primary/60 ring-2 ring-primary',
                    )}
                  >
                    <button
                      type="button"
                      className="flex h-full w-full flex-col rounded-xl text-left"
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
                      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-t-xl">
                        <Cover src={r.cover} name={r.name} className="transition-transform duration-300 ease-out group-hover:scale-105" />
                        <PageCountPill pageCount={r.pageCount} className="absolute bottom-2 right-2" />
                      </div>
                      <div className="flex min-w-0 w-full flex-1 flex-col gap-2 p-3">
                        <p className="min-h-10 overflow-hidden text-sm font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" title={r.name}>{r.name}</p>
                        {r.artists && r.artists.length > 0 && (
                          <p className="truncate text-xs font-medium text-foreground" title={`Artists: ${r.artists.join(', ')}`}>
                            <span className="text-muted">Artist{r.artists.length > 1 ? 's' : ''} · </span>{r.artists.join(', ')}
                          </p>
                        )}
                        {review && <p className="text-xs text-muted">{r.libraryName}</p>}
                        <div className="mt-auto flex flex-wrap items-center gap-1">
                          {needsReview(r)
                            ? <Badge tone="warning">Needs review · {Math.round(r.matchScore! * 100)}%</Badge>
                            : <StatusBadge status={r.status} />}
                        </div>
                      </div>
                    </button>
                    {!selectMode && <CardActionMenu row={r} onEdit={() => setComicInfo({ id: r.id, name: r.name })} onUnmatch={() => setUnmatchTarget(r)} />}
                  </Card>
                ))}
              </div>
            )}
            {filtered.length > SERIES_PAGE_SIZE && (
              <div className="pt-2">
                <PaginationControls currentPage={currentPage} pageCount={pageCount} firstVisible={firstVisible} lastVisible={lastVisible} total={filtered.length} onChange={changePage} />
              </div>
            )}
          </>
        )}
      </TabPanel>

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
      {recoveryFile && <ComicInfoModal initialPath={recoveryFile} onClose={() => setRecoveryFile(null)} />}

      {mergeOpen && (
        <MergeSeriesModal
          selected={(series.data ?? []).filter((r) => checked.has(r.id))}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </div>
  );
}
