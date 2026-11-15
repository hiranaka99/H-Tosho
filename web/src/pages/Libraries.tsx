import * as React from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Search, RefreshCw, Play, BookOpen, Unlink, FileText, Combine, Check, CheckSquare, EllipsisVertical, Trash2, Eye, X } from 'lucide-react';
import { api, type SeriesRow, type DoujinSource, type Job } from '../lib/api';
import { Button, Card, Input, Select, Badge, StatusBadge, Skeleton, EmptyState, Switch, PageHeader, ErrorState, ConfirmDialog, SegmentedControl, TabPanel, Spinner, ProgressBar, Pager, Disclosure } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { ComicInfoModal } from '../components/ComicInfoModal';
import { SeriesPreviewModal } from '../components/SeriesPreviewModal';
import { MergeSeriesModal } from '../components/MergeSeriesModal';
import { PageCountPill } from '../components/PageCountPill';
import { buildTagSearchFragment, cn, jobLabel } from '../lib/utils';
import { toast } from '../lib/toast';
import { useMediaQuery } from '../lib/useMediaQuery';
import { filterLibraryRows, librarySearchTerm, needsReview, prepareLibraryRows } from '../lib/libraryShelf';
const SERIES_PAGE_SIZE = 40;
const EMPTY_SERIES: SeriesRow[] = [];

const LIBRARY_STATE_KEY = 'h-tosho:library-state';

interface LibraryStateCache {
  query?: string;
  statusFilter?: string;
  sortBy?: 'name' | 'date-added';
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

function MatchingTags({ tags, query }: { tags?: string[]; query: string }) {
  const { q } = librarySearchTerm(query);
  const matches = q ? tags?.filter(tag => tag.toLowerCase().includes(q)) ?? [] : [];
  if (!matches.length) return null;
  return <p className="min-w-0 break-words text-xs text-muted line-clamp-2" title={`Matching tags: ${matches.join(', ')}`}><span className="font-medium">Tags · </span>{matches.join(', ')}</p>;
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

function CardActionMenu({ row, onEdit, onUnmatch, onDelete }: { row: SeriesRow; onEdit: () => void; onUnmatch: () => void; onDelete: () => void }) {
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
      <button ref={trigger} type="button" aria-label={`Actions for ${row.name}`} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} onClick={() => { focusLast.current = false; setOpen((value) => !value); }} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setOpen(true); } }} className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-surface/90 text-foreground transition-colors duration-150 hover:border-primary hover:bg-surface">
        <EllipsisVertical className="h-5 w-5" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={`Actions for ${row.name}`} onKeyDown={menuKeys} className="absolute right-0 top-full mt-1 w-52 overflow-hidden rounded-md border border-border bg-surface p-1 text-foreground shadow-xl">
          {row.artists?.length ? (
            <>
              <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted">More by this artist</p>
              {(['hitomi', 'nhentai'] as const).map((source) => (
                <button key={source} type="button" role="menuitem" tabIndex={-1} onClick={() => searchArtist(source)} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
                  <img src={`/${source}.png`} alt="" className="h-5 w-5 rounded object-contain" aria-hidden="true" />
                  {ARTIST_SOURCE_META[source].label}
                </button>
              ))}
            </>
          ) : null}
          {row.artists?.length ? <div role="separator" className="mx-1 my-1 h-px bg-border" /> : null}
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); trigger.current?.focus(); onEdit(); }} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
            <FileText className="h-4 w-4" /> Edit ComicInfo.xml
          </button>
          {row.providerId && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); trigger.current?.focus(); onUnmatch(); }} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2">
              <Unlink className="h-4 w-4" /> Unmatch series
            </button>
          )}
          <div role="separator" className="mx-1 my-1 h-px bg-border" />
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); trigger.current?.focus(); onDelete(); }} className="flex max-lg:min-h-11 pointer-coarse:min-h-11 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-danger transition-colors hover:bg-surface-2">
            <Trash2 className="h-4 w-4" /> Delete files
          </button>
        </div>
      )}
    </div>
  );
}

/** Follow visible books through shelf changes; never measure on idle job polls. */
function useLibraryMotion(state: string) {
  const ref = React.useRef<HTMLDivElement>(null);
  const previous = React.useRef<Map<string, { x: number; y: number }> | null>(null);
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const origin = container.getBoundingClientRect();
    const positions = new Map<string, { x: number; y: number }>();
    const animations: Animation[] = [];
    container.querySelectorAll<HTMLElement>('[data-library-motion-id]').forEach(element => {
      const bounds = element.getBoundingClientRect();
      const position = { x: bounds.left - origin.left, y: bounds.top - origin.top };
      const id = element.dataset.libraryMotionId!;
      positions.set(id, position);
      if (!previous.current || preference.matches || document.hidden || bounds.bottom < 0 || bounds.top > window.innerHeight || typeof element.animate !== 'function') return;
      const old = previous.current.get(id);
      const dx = old ? old.x - position.x : 0;
      const dy = old ? old.y - position.y : 0;
      if (old && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const nearby = old && Math.abs(dx) < bounds.width * 2 && Math.abs(dy) < bounds.height * 2;
      animations.push(element.animate(
        nearby ? [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]
          : id.startsWith('selection:') ? [{ opacity: 0.4, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }]
            : [{ opacity: 0.65 }, { opacity: 1 }],
        { duration: nearby ? 260 : 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      ));
    });
    previous.current = positions;
    const cancel = () => animations.forEach(animation => animation.cancel());
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

export function Libraries({ review = false }: { review?: boolean }) {
  const { libraryId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const initialState = React.useMemo(readLibraryState, []);
  const [selected, setSelected] = React.useState<number | null>(libraryId ? Number(libraryId) : null);
  const [query, setQuery] = React.useState(review ? '' : initialState.query ?? '');
  const [statusFilter, setStatusFilter] = React.useState(() => review ? 'all' : initialState.statusFilter ?? 'all');
  const [sortBy, setSortBy] = React.useState<'name' | 'date-added'>(review ? 'name' : initialState.sortBy ?? 'date-added');
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [identify, setIdentify] = React.useState<{ id: number; name: string; cover?: string | null } | null>(null);
  const reviewQueue = React.useRef<SeriesRow[]>([]);
  const browseScroll = React.useRef(0);
  const wideControls = useMediaQuery('(min-width: 640px)');
  const openIdentify = (row: SeriesRow) => {
    browseScroll.current = document.querySelector('main')?.scrollTop ?? 0;
    reviewQueue.current = review ? [...filtered] : [];
    setIdentify({ id: row.id, name: row.name, cover: row.cover });
  };
  const closeIdentify = () => {
    setIdentify(null);
    requestAnimationFrame(() => document.querySelector('main')?.scrollTo({ top: browseScroll.current }));
  };
  const reviewIndex = identify ? reviewQueue.current.findIndex((row) => row.id === identify.id) : -1;
  const nextReview = reviewQueue.current[reviewIndex + 1];
  const [comicInfo, setComicInfo] = React.useState<{ id: number; name: string } | null>(null);
  const [preview, setPreview] = React.useState<{ id: number; name: string } | null>(null);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [selectMode, setSelectMode] = React.useState(false);
  const [page, setPage] = React.useState(() => libraryId ? initialState.pages?.[libraryId] ?? 1 : 1);
  const [unmatchTarget, setUnmatchTarget] = React.useState<SeriesRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: number; name: string; dir: string } | null>(null);
  const [recoveryFile, setRecoveryFile] = React.useState<string | null>(null);
  const [lastQueuedJob, setLastQueuedJob] = React.useState<{ id: number; type: string; libraryId: number } | null>(null);
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

  const rows = series.data ?? EMPTY_SERIES;
  const shelf = React.useMemo(() => prepareLibraryRows(rows, sortBy), [rows, sortBy]);
  const filtered = React.useMemo(() => filterLibraryRows(shelf, query, statusFilter, review), [shelf, statusFilter, query, review]);
  const selectedRows = React.useMemo(() => rows.filter(row => checked.has(row.id)), [rows, checked]);
  const pageCount = React.useMemo(() => Math.max(1, Math.ceil(filtered.length / SERIES_PAGE_SIZE)), [filtered.length]);
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filtered.slice((currentPage - 1) * SERIES_PAGE_SIZE, currentPage * SERIES_PAGE_SIZE);
  const motionRef = useLibraryMotion(`${review}:${selected}:${currentPage}:${visibleRows.map(row => row.id).join(',')}:${selectMode}:${[...checked].join(',')}`);
  React.useEffect(() => {
    if (!review) writeLibraryState({ query, statusFilter, sortBy });
  }, [query, statusFilter, sortBy, review]);
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

  const enqueue = useMutation({
    mutationFn: ({ type, libraryId }: { type: 'scan-new' | 'match-unmatched'; libraryId: number }) => api.enqueue(type, { libraryId }),
    onSuccess: (result, variables) => {
      setLastQueuedJob({ id: result.id, ...variables });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      const libraryName = libs.data?.find((library) => library.id === variables.libraryId)?.name;
      toast({ tone: 'info', title: variables.type === 'scan-new' ? 'Refresh queued' : 'Matching queued', description: `${libraryName ? `${libraryName}. ` : ''}Follow progress below or in Jobs.` });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Could not queue job', description: error instanceof Error ? error.message : String(error) }),
  });
  const queueLibraryJob = (type: 'scan-new' | 'match-unmatched') => {
    if (selected !== null && !enqueue.isPending) enqueue.mutate({ type, libraryId: selected });
  };
  const libraryJobs = React.useMemo(() => (jobs ?? []).filter((job) =>
    job.payload.libraryId === selected || shelf.ids.has(job.payload.seriesId as number),
  ), [jobs, selected, shelf]);
  const runningLibraryJobs = libraryJobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const lastJob = lastQueuedJob?.libraryId === selected ? (jobs ?? []).find((job) => job.id === lastQueuedJob.id) : undefined;
  const libraryActivity: Pick<Job, 'id' | 'type' | 'payload' | 'status' | 'progressCurrent' | 'progressTotal'> | null = runningLibraryJobs[0] ?? lastJob ?? (lastQueuedJob?.libraryId === selected ? { ...lastQueuedJob, payload: { libraryId: selected }, status: 'queued', progressCurrent: 0, progressTotal: 0 } : null);
  const saveAutoMatch = useMutation({
    mutationFn: ({ libraryId, autoMatch }: { libraryId: number; autoMatch: boolean }) => api.saveLibraryOverride(libraryId, { autoMatch }),
    onSuccess: (_result, variables) => qc.invalidateQueries({ queryKey: ['library-override', variables.libraryId] }),
    onError: (error) => toast({ tone: 'danger', title: 'Could not update auto-match', description: error instanceof Error ? error.message : String(error) }),
  });

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

  // "Delete files": first resolve the series' on-disk folder (for the
  // confirmation dialog), then queue the deletion as a background job — the
  // server re-resolves and validates the path itself.
  const prepareDelete = useMutation({
    mutationFn: (row: SeriesRow) => api.cbzSeriesFiles(row.id),
    onSuccess: (res, row) => {
      if (!res.dir) toast({ tone: 'danger', title: 'Cannot locate this series on this machine', description: res.reason ?? undefined });
      else setDeleteTarget({ id: row.id, name: row.name, dir: res.dir });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not load the series files', description: e instanceof Error ? e.message : String(e) }),
  });
  const deleteSeries = useMutation({
    mutationFn: (target: { id: number; name: string }) => api.enqueue('delete-series', { seriesId: target.id }),
    onSuccess: (_res, target) => {
      setDeleteTarget(null);
      toast({ tone: 'success', title: `Deleting “${target.name}”`, description: 'The folder is being removed in the background — follow progress on the Jobs page.' });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue the deletion', description: e instanceof Error ? e.message : String(e) }),
  });

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
    <div ref={motionRef} className="flex min-w-0 flex-col gap-4">
      <PageHeader icon={<BookOpen className="h-5 w-5" />} title={review ? 'Needs review' : 'Libraries'} subtitle={review ? 'Review uncertain matches across all your libraries.' : 'Review matches and manage Kavita metadata.'} />
      {linkedSeriesId && linkedSeries.isPending && <p role="status" className="text-sm text-muted">Opening series…</p>}
      {linkedSeries.isError && <ErrorState title="Could not open series" description={linkedSeries.error.message} onRetry={() => void linkedSeries.refetch()} />}
      <Card className="min-w-0">
        <div className="flex min-w-0 flex-col gap-3 border-b border-border px-3 py-3 sm:px-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {libs.isError ? (
              <ErrorState title="Could not load libraries" description={libs.error instanceof Error ? libs.error.message : String(libs.error)} onRetry={() => void libs.refetch()} />
            ) : libs.data && libs.data.length > 0 ? (
              review ? <Button asChild variant="ghost"><Link to="/libraries">Back to libraries</Link></Button> : <>
                <label htmlFor="library-picker" className="flex min-w-0 w-full flex-col gap-1 text-xs font-medium text-muted sm:hidden">Library
                  <Select id="library-picker" aria-label="Kavita library" value={selected ?? ''} onChange={event => pickLibrary(Number(event.target.value))} title={libs.data.find(lib => lib.id === selected)?.name} className="min-h-11">
                    {libs.data.map(lib => <option key={lib.id} value={lib.id}>{lib.name}</option>)}
                  </Select>
                </label>
                <SegmentedControl items={libs.data.map((lib) => ({ id: lib.id, label: lib.name }))} value={selected} onChange={pickLibrary} label="Kavita library" className="hidden sm:flex" />
              </>
            ) : (
              <p className="text-sm text-muted">{libs.isLoading ? 'Loading libraries…' : 'No libraries — connect Kavita in Settings.'}</p>
            )}
            {!review && reviewCount.data && reviewCount.data.count > 0 && (
              <Link to="/libraries/review" aria-current={review ? 'page' : undefined} className="inline-flex min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0 items-center gap-2 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10">
                Needs review <Badge tone="warning">{reviewCount.data.count}</Badge>
              </Link>
            )}
          </div>
          {!review && (
            <Disclosure label="Library actions" className="min-w-0" summaryClassName="min-h-11 text-sm">
            {override.isError && <ErrorState title="Could not load auto-match settings" description={override.error instanceof Error ? override.error.message : String(override.error)} onRetry={() => void override.refetch()} />}
            <div role="group" aria-label="Library actions" className="flex min-w-0 flex-wrap items-center gap-2 pt-2">
              <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 flex-1 sm:flex-none" onClick={() => queueLibraryJob('scan-new')} disabled={selected === null || enqueue.isPending}>{enqueue.isPending && enqueue.variables?.type === 'scan-new' && enqueue.variables.libraryId === selected ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5 shrink-0" />} {enqueue.isPending && enqueue.variables?.type === 'scan-new' && enqueue.variables.libraryId === selected ? 'Queuing refresh…' : 'Refresh library'}</Button>
              <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 flex-1 sm:flex-none" onClick={() => queueLibraryJob('match-unmatched')} disabled={selected === null || enqueue.isPending}>{enqueue.isPending && enqueue.variables?.type === 'match-unmatched' && enqueue.variables.libraryId === selected ? <Spinner /> : <Play className="h-3.5 w-3.5 shrink-0" />} {enqueue.isPending && enqueue.variables?.type === 'match-unmatched' && enqueue.variables.libraryId === selected ? 'Queuing matching…' : 'Match all unmatched'}</Button>
              <label className="flex min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 w-full cursor-pointer select-none items-center justify-between gap-3 px-1 text-xs font-medium text-muted sm:w-auto sm:pl-3">
                <span className="flex items-center gap-2">Auto-match new series{saveAutoMatch.isPending && <Spinner />}</span>
                <Switch aria-label="Automatically match new series" aria-busy={saveAutoMatch.isPending} checked={saveAutoMatch.isPending && saveAutoMatch.variables.libraryId === selected ? saveAutoMatch.variables.autoMatch : override.data?.autoMatch ?? true} onCheckedChange={autoMatch => { if (selected !== null) saveAutoMatch.mutate({ libraryId: selected, autoMatch }); }} disabled={selected === null || !override.data || saveAutoMatch.isPending} />
              </label>
            </div>
            </Disclosure>
          )}
        </div>

        {!review && libraryActivity && (
          <div aria-label="Library activity" role="region" className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/50 px-3 py-3 sm:px-4">
            <div className="min-w-0 flex-1">
              <p role="status" className={cn('flex items-center gap-2 text-sm font-medium', libraryActivity.status === 'failed' ? 'text-danger' : libraryActivity.status === 'completed' ? 'text-success' : 'text-foreground')}>
                {libraryActivity.status === 'running' && <Spinner />}
                <span>{jobLabel(libraryActivity.type, libraryActivity.payload)} · {libraryActivity.status === 'running' ? 'In progress' : libraryActivity.status.charAt(0).toUpperCase() + libraryActivity.status.slice(1)}</span>
              </p>
              {libraryActivity.status === 'running' && libraryActivity.progressTotal > 0 && (
                <div className="mt-2 flex items-center gap-2"><ProgressBar label="Library job progress" value={libraryActivity.progressCurrent} max={libraryActivity.progressTotal} className="max-w-xs" /><span className="shrink-0 text-xs tabular-nums text-muted">{libraryActivity.progressCurrent}/{libraryActivity.progressTotal}</span></div>
              )}
              {runningLibraryJobs.length > 1 && <p className="mt-1 text-xs text-muted">{runningLibraryJobs.length} active jobs for this library</p>}
            </div>
            <Button asChild size="sm" variant="outline"><Link to={runningLibraryJobs.length > 1 ? '/jobs?filter=active' : `/jobs?job=${libraryActivity.id}`}>{runningLibraryJobs.length > 1 ? 'View jobs' : 'View job'}</Link></Button>
          </div>
        )}

        {(review || selected !== null) && (
          <div className="flex flex-col gap-3 p-3 sm:p-4">
            <div className="grid w-full grid-cols-2 items-start gap-2 sm:flex sm:flex-wrap sm:items-center">
              <div className="relative col-span-2 min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input aria-label="Filter series, artists or tags" placeholder="Search series, artists or tags…" title="Use tag:romance to search tags only" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-full pl-8 pr-11 sm:min-h-9" />
                {query && <Button size="icon" variant="ghost" className="absolute right-0 top-1/2 -translate-y-1/2" aria-label="Clear series search" onClick={() => { setQuery(''); setPage(1); }}><X className="h-4 w-4" /></Button>}
              </div>
              {!review && <Select aria-label="Filter by match status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="max-lg:min-h-11 pointer-coarse:min-h-11 min-w-0 sm:min-h-9 sm:w-44">
                <option value="all">All statuses</option>
                <option value="matched">Matched</option>
                <option value="unmatched">Unmatched</option>
                <option value="failed">Failed</option>
                <option value="low-score">Needs review (&lt;80%)</option>
              </Select>}
              {!review && <Disclosure open={wideControls || undefined} label="Sort" className="min-w-0 sm:contents" summaryClassName="min-h-11 sm:hidden">
              <div className="flex flex-wrap gap-2 pt-2 sm:flex-nowrap sm:pt-0">
              {!review && <Select aria-label="Sort series" value={sortBy} onChange={(e) => { setSortBy(e.target.value as 'name' | 'date-added'); setPage(1); }} className="max-lg:min-h-11 pointer-coarse:min-h-11 min-w-0 sm:min-h-9 sm:w-44">
                <option value="name">Sort · A–Z</option>
                <option value="date-added">Sort · Date added</option>
              </Select>}
              </div></Disclosure>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="contents sm:flex sm:min-w-0 sm:flex-1 sm:flex-wrap sm:items-baseline sm:gap-x-3 sm:gap-y-1">
                <h2 aria-live="polite" aria-atomic="true" className="mr-auto text-sm font-semibold tabular-nums sm:mr-0">{series.data ? (isFiltering ? `${filtered.length} of ${rows.length} series` : `${rows.length} series`) : 'Loading…'}</h2>
                {series.data && <p className="order-last w-full text-xs text-muted sm:order-none sm:w-auto">{review ? 'Matches below 80% confidence · All libraries' : `${shelf.counts.matched} matched · ${shelf.counts.unmatched} unmatched${shelf.counts.failed ? ` · ${shelf.counts.failed} failed` : ''}`}</p>}
              </div>
              {!review && !selectMode && checked.size === 0 && <Button variant="outline" className="max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0 sm:min-h-9" onClick={() => setSelectMode(true)}><CheckSquare className="h-4 w-4" /> Select to merge</Button>}
            </div>
              {review && filtered.length > 0 && <Button size="sm" onClick={() => openIdentify(filtered[0])}>Start review</Button>}
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
          {checked.size > 0 && <ul aria-label="Selected series" className="grid max-h-28 w-full grid-cols-1 gap-x-4 overflow-y-auto border-t border-border sm:grid-cols-2 xl:grid-cols-3">
            {selectedRows.map(row => <li key={row.id} data-library-motion-id={`selection:${row.id}`} className="flex min-w-0 items-center gap-2 py-2">
              <div className="h-10 w-8 shrink-0 overflow-hidden rounded"><Cover src={row.cover} name={row.name} /></div>
              <span className="min-w-0 flex-1 break-words text-xs font-medium">{row.name}</span>
              <Button size="icon" variant="ghost" className="shrink-0" aria-label={`Remove ${row.name} from selection`} onClick={() => toggleCheck(row.id)}><X className="h-4 w-4" /></Button>
            </li>)}
          </ul>}
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
                <EmptyState title={review && rows.length === 0 ? 'All caught up' : rows.length === 0 ? 'This library is empty' : 'No matching series'} description={review && rows.length === 0 ? 'No matches need review. New uncertain matches will appear here.' : rows.length === 0 ? 'Refresh from Kavita to look for new series. If books are missing, check your Kavita connection and library setup.' : 'Try another search or clear the filters to see your series.'} />
                {isFiltering && !(review && rows.length === 0) && <Button variant="outline" className="max-lg:min-h-11 pointer-coarse:min-h-11 sm:min-h-9" onClick={clearFilters}>Clear filters</Button>}
                {!review && rows.length === 0 && <div className="flex flex-wrap justify-center gap-2"><Button onClick={() => queueLibraryJob('scan-new')} disabled={enqueue.isPending}>Refresh library</Button><Button asChild variant="outline"><Link to="/settings#kavita-connection">Check connection</Link></Button></div>}
              </Card>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {visibleRows.map(r => (
                  <Card
                    key={r.id}
                    data-library-motion-id={`shelf:${r.id}`}
                    className={cn(
                      'ui-card-interactive group relative z-0 flex min-w-0 flex-col transition-colors duration-200 focus-within:z-40',
                      checked.has(r.id) ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'hover:border-border-2',
                    )}
                  >
                    <button
                      type="button"
                      className="flex w-full flex-col rounded-xl text-left"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (selectMode) toggleCheck(r.id);
                        else openIdentify(r);
                      }}
                      title={selectMode ? (checked.has(r.id) ? 'Deselect series' : 'Select series') : `${r.providerId ? 'Review metadata for' : 'Identify'} ${r.name}`}
                      aria-label={selectMode ? (checked.has(r.id) ? `Deselect ${r.name}` : `Select ${r.name}`) : `${r.providerId ? 'Review metadata for' : 'Identify'} ${r.name}`}
                      aria-pressed={selectMode ? checked.has(r.id) : undefined}
                    >
                      {selectMode && (
                        <span className={cn('pointer-events-none absolute left-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-md border transition-colors duration-150', checked.has(r.id) ? 'border-primary-button bg-primary-button text-white' : 'border-border-2 bg-surface text-muted')} aria-hidden>{checked.has(r.id) ? <Check className="library-selection-check h-5 w-5" /> : <span className="h-4 w-4 rounded-sm border-2 border-current" />}</span>
                      )}
                      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-t-xl">
                        <Cover src={r.cover} name={r.name} className="library-cover" />
                        <PageCountPill pageCount={r.pageCount} className="absolute bottom-2 right-2" />
                      </div>
                      <div className="min-w-0 w-full px-3 pt-3">
                        <p className="min-h-10 overflow-hidden text-sm font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" title={r.name}>{r.name}</p>
                      </div>
                    </button>
                    <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 pb-3">
                      {!!r.artists?.length && <p className="min-w-0 break-words text-xs font-medium text-foreground line-clamp-2" title={`Artists: ${r.artists.join(', ')}`}><span className="text-muted">Artist{r.artists.length > 1 ? 's' : ''} · </span>{r.artists.join(', ')}</p>}
                      <MatchingTags tags={r.tags} query={query} />
                        {review && <p className="text-xs text-muted">{r.libraryName}</p>}
                        <div className="mt-auto flex flex-wrap items-center gap-1">
                          {needsReview(r)
                            ? <Badge tone="warning">Needs review · {Math.round(r.matchScore! * 100)}%</Badge>
                            : <StatusBadge status={r.status} />}
                          {r.status === 'failed' && <p className="w-full break-words text-xs text-danger">{r.errorMessage || 'Matching or sync failed. Retry identification, or check provider settings.'}</p>}
                        </div>
                        {!selectMode && (r.status === 'failed' || r.providerId) && <Button variant="ghost" className="min-h-9 justify-start px-0 text-xs text-primary" onClick={() => openIdentify(r)}>{r.status === 'failed' ? 'Retry identification' : 'Review metadata'} <Play aria-hidden="true" className="h-3 w-3" /></Button>}
                        {!selectMode && <Button variant="outline" className="min-h-11 w-full px-2 text-xs" aria-label={`Preview pages of ${r.name}`} onClick={() => setPreview({ id: r.id, name: r.name })}><Eye className="h-4 w-4 shrink-0" />Preview pages</Button>}
                        {selectMode && <Button size="sm" variant={checked.has(r.id) ? 'default' : 'outline'} aria-pressed={checked.has(r.id)} aria-label={`${checked.has(r.id) ? 'Remove' : 'Select'} ${r.name} ${checked.has(r.id) ? 'from' : 'for'} merging`} onClick={() => toggleCheck(r.id)}><CheckSquare className="h-4 w-4" />{checked.has(r.id) ? 'Selected' : 'Select'}</Button>}
                    </div>
                    {!selectMode && <CardActionMenu row={r} onEdit={() => setComicInfo({ id: r.id, name: r.name })} onUnmatch={() => setUnmatchTarget(r)} onDelete={() => prepareDelete.mutate(r)} />}
                  </Card>
                ))}
              </div>
            )}
            {filtered.length > SERIES_PAGE_SIZE && (
              <div className="pt-2">
                <Pager page={currentPage} count={pageCount} onPageChange={changePage} />
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
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete series files?"
        description={deleteTarget ? `This permanently deletes the folder containing “${deleteTarget.name}” and its .cbz files:` : ''}
        details={deleteTarget ? (
          <>
            <code className="break-all rounded bg-surface-2 px-2 py-1.5 font-mono text-xs text-foreground">{deleteTarget.dir}</code>
            <p>Kavita drops the series on its next scan. This cannot be undone.</p>
          </>
        ) : undefined}
        confirmLabel="Delete"
        danger
        pending={deleteSeries.isPending}
        onOpenChange={(open) => { if (!open && !deleteSeries.isPending) setDeleteTarget(null); }}
        onConfirm={() => { if (deleteTarget) deleteSeries.mutate(deleteTarget); }}
      />
      {identify && (
        <IdentifyModal
          key={identify.id}
          reviewPosition={reviewIndex >= 0 ? `${reviewIndex + 1} of ${reviewQueue.current.length}` : undefined}
          onNext={review && nextReview ? () => setIdentify({ id: nextReview.id, name: nextReview.name, cover: nextReview.cover }) : undefined}
          seriesId={identify.id}
          autoReview
          current={{
            name: currentMeta.data?.series.name ?? identify.name,
            metadata: currentMeta.data?.kavita ?? null,
          }}
          currentLoading={currentMeta.isPending || currentMeta.isFetching}
          currentError={currentMeta.isError ? (currentMeta.error instanceof Error ? currentMeta.error.message : String(currentMeta.error)) : null}
          onRetryCurrent={() => void currentMeta.refetch()}
          match={currentMeta.data?.match ?? null}
          currentCover={identify.cover}
          onClose={closeIdentify}
        />
      )}

      {comicInfo && (
        <ComicInfoModal seriesId={comicInfo.id} onClose={() => setComicInfo(null)} />
      )}
      {preview && (
        <SeriesPreviewModal seriesId={preview.id} name={preview.name} onClose={() => setPreview(null)} />
      )}
      {recoveryFile && <ComicInfoModal initialPath={recoveryFile} onClose={() => setRecoveryFile(null)} />}

      {mergeOpen && (
        <MergeSeriesModal
          selected={selectedRows}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </div>
  );
}
