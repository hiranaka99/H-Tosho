import { useDownloaderTransitions } from './motion';
import { Cover } from './GalleryCard';
import { GallerySearchInput } from '../../components/GallerySearchInput';
import { WatchedDisclosure, WatchedReveal } from '../../components/WatchedMotion';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { GripVertical, Loader2, Pause, Pencil, Play, X, ExternalLink, Star, ChevronDown, Plus } from 'lucide-react';
import { api, ApiError, type DoujinSource } from '../../lib/api';
import { cn, timeAgo } from '../../lib/utils';
import { toast } from '../../lib/toast';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Select, ErrorState, Skeleton } from '../../components/ui';
import { ConfirmDialog, Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/dialog';
import { PageCountPill } from '../../components/PageCountPill';
import { switchProviderSearch, type TranslationLink } from '../../lib/searchTranslation';

import { SOURCE_LABELS } from './state';
import type { WatchedSearch } from '../../../../server/src/contracts/following';
import { WatchEditor, FollowingFolders, cadenceLabel, WATCH_DRAG_TYPE } from './FollowingOrganization';
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

/** Unsent add-watch draft, kept across closing and reopening the side sheet. */
let watchDraft: { source: DoujinSource; query: string } = { source: 'hitomi', query: '' };
const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });
const TIME_SHORT_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function AddWatchForm({ onAdded }: { onAdded: () => void }) {
  const [source, setSource] = React.useState<DoujinSource>(watchDraft.source);
  const [query, setQuery] = React.useState(watchDraft.query);
  // The side sheet unmounts when closed; an unsent watch draft survives that.
  React.useEffect(() => { watchDraft = { source, query }; }, [source, query]);
  const watchTranslation = React.useRef<TranslationLink | null>(null);
  const [watchTranslationNotice, setWatchTranslationNotice] = React.useState<{ query: string; issues: string[] } | null>(null);
  const [adding, setAdding] = React.useState(false);
  const watchQueryId = React.useId();

  function switchWatchSource(next: DoujinSource) {
    if (next === source) return;
    const translated = switchProviderSearch({ query, searchKey: null, sort: 'default' }, source, next, watchTranslation.current);
    watchTranslation.current = translated.link;
    setQuery(translated.search.query);
    setWatchTranslationNotice({ query: translated.search.query, issues: translated.issues });
    setSource(next);
  }

  async function add() {
    const q = query.trim();
    if (!q || adding) return;
    setAdding(true);
    try {
      await api.addWatchedSearch(source, q);
      setQuery('');
      onAdded();
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not add watch', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-end" aria-label="Add a watched search" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">Source<Select aria-label="Watched search source" value={source} onChange={(e) => switchWatchSource(e.target.value as DoujinSource)} disabled={adding} className="h-11 sm:w-32 sm:shrink-0"><option value="hitomi">Hitomi.la</option><option value="nhentai">nHentai</option></Select></label>
        <div className="flex min-w-0 flex-col gap-1"><label htmlFor={watchQueryId} className="text-xs text-muted">Query</label><GallerySearchInput id={watchQueryId} value={query} onChange={setQuery} source={source} label="Watched search query" placeholder="Artist, tag, or search query" clearLabel="Clear watched search query" disabled={adding} className="h-11" /></div>
        <Button size="sm" className="h-11" type="submit" disabled={adding || !query.trim()}>{adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add watch</Button>
      </form>
      {watchTranslationNotice?.query === query && watchTranslationNotice.issues.length > 0 && <p role="status" aria-label="Watch query translation" className="break-words text-sm text-muted">{watchTranslationNotice.issues.join(' ')} Review the query before adding the watch.</p>}
    </>
  );
}

export function WatchedTab({ onOpenSearch, inDrawer = false }: { onOpenSearch: (source: DoujinSource, query: string) => void; inDrawer?: boolean }) {
  const qc = useQueryClient();
  const watchesQuery = useQuery({ queryKey: ['watched-searches'], queryFn: api.watchedSearches, staleTime: 30_000, refetchInterval: 30_000 });
  const watches = watchesQuery.data;
  const foldersQuery = useQuery({ queryKey: ['watched-search-folders'], queryFn: api.watchedSearchFolders, staleTime: 30_000, refetchInterval: 30_000 });
  const folders = foldersQuery.data ?? [];
  const [editingWatch, setEditingWatch] = React.useState<number | null>(null);
  const editSession = React.useRef(0);
  const editButtons = React.useRef(new Map<number, HTMLButtonElement>());
  const restoreEditFocus = React.useRef<number | null>(null);
  const [updatingWatch, setUpdatingWatch] = React.useState<number | null>(null);
  const [draggedWatch, setDraggedWatch] = React.useState<WatchedSearch | null>(null);
  const [movingWatch, setMovingWatch] = React.useState<number | null>(null);
  const moveInFlight = React.useRef(false);
  const [watchError, setWatchError] = React.useState<{ id: number; message: string } | null>(null);
  const openEditor = (id: number) => { editSession.current++; setEditingWatch(id); };
  const closeEditor = () => { restoreEditFocus.current = editingWatch; editSession.current++; setEditingWatch(null); };
  React.useLayoutEffect(() => {
    if (editingWatch !== null || restoreEditFocus.current === null) return;
    // A folder change can remount the row; focus its newly attached edit button.
    editButtons.current.get(restoreEditFocus.current)?.focus();
    restoreEditFocus.current = null;
  }, [editingWatch]);
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const intervalMinutes = settingsQuery.data?.watchedSearchIntervalMinutes ?? 15;
  const [savingInterval, setSavingInterval] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<WatchedSearch | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [requestedJob, setRequestedJob] = React.useState<number | null>(null);
  const [manageOpen, setManageOpen] = React.useState(false);
  const checkQuery = useQuery({
    queryKey: ['watched-check-status'], queryFn: api.watchedCheckStatus,
    refetchInterval: query => checking || requestedJob !== null || ['queued', 'running'].includes(query.state.data?.status ?? '') ? 2500 : 30_000 });
  const checkJob = checkQuery.data;
  const checkActive = checking || (requestedJob !== null && checkJob?.id !== requestedJob && !checkQuery.isError) || checkJob?.status === 'queued' || checkJob?.status === 'running';
  // null until the first status is seen: a check that had already finished when
  // the sheet opened is not a new completion, so it must not refetch the lists.
  // A check seen queued/running records '' and invalidates once it finishes.
  const completionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!checkJob) return;
    const done = !['queued', 'running'].includes(checkJob.status);
    const stamp = done ? `${checkJob.id}:${checkJob.status}` : '';
    if (completionRef.current === null) { completionRef.current = stamp; return; }
    if (!done || completionRef.current === stamp) return;
    completionRef.current = stamp;
    void qc.invalidateQueries({ queryKey: ['watched-searches'] });
    void qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
    setRequestedJob(null);
  }, [checkJob, qc]);
  const summary = checkJob?.result as { newGalleries?: number; failed?: number; processed?: number } | undefined;
  const checkLabel = checkQuery.isError ? 'Check status unavailable' : checkActive ? checkJob?.status === 'running' ? `Checking ${checkJob.progressCurrent} of ${checkJob.progressTotal} watches` : 'Check queued' : checkJob?.status === 'failed' ? 'Check failed' : checkJob?.status === 'cancelled' ? 'Check cancelled' : checkJob?.status === 'completed' ? `${summary?.newGalleries ?? 0} new ${summary?.newGalleries === 1 ? 'find' : 'finds'}${summary?.failed ? ` · ${summary.failed} ${summary.failed === 1 ? 'watch failed' : 'watches failed'}` : ''}` : 'No check recorded';
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const onWatchAdded = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['watched-searches'] });
  }, [qc]);
  const folderNameById = React.useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  async function remove(target: WatchedSearch): Promise<boolean> {
    setRemoving(true);
    try {
      await api.removeWatchedSearch(target.id, target.revision);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['watched-searches'] }),
        qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] }),
      ]);
      toast({ tone: 'info', title: 'Watch removed', description: 'Discoveries and their watch name remain in Inbox and History.' });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const refreshed = await watchesQuery.refetch();
        const latest = refreshed.data?.find(watch => watch.id === target.id);
        if (latest && !refreshed.isError) setRemoveTarget(latest);
        else setRemoveTarget(null);
        toast({ tone: 'info', title: 'Watch changed elsewhere', description: 'The latest watches have been requested. Review the watch before removing it again.' });
      } else {
        toast({ tone: 'danger', title: 'Could not remove watch', description: e instanceof Error ? e.message : String(e) });
      }
      return false;
    } finally { setRemoving(false); }
  }
  async function togglePause(watch: WatchedSearch) {
    if (updatingWatch !== null || moveInFlight.current) return;
    setUpdatingWatch(watch.id);
    setWatchError(null);
    try {
      await api.updateWatchedSearch(watch.id, { expectedRevision: watch.revision, paused: watch.pausedAt === null });
      await watchesQuery.refetch();
    } catch (e) {
      setWatchError({ id: watch.id, message: e instanceof ApiError && e.status === 409 ? 'This watch changed elsewhere. The latest version has been requested; review it before trying again.' : e instanceof Error ? e.message : String(e) });
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) await watchesQuery.refetch();
    } finally { setUpdatingWatch(null); }
  }
  async function moveWatch(watch: WatchedSearch, folderId: number | null) {
    setDraggedWatch(null);
    if (moveInFlight.current || updatingWatch !== null || watch.folderId === folderId) return;
    if (folderId !== null && !folders.some(folder => folder.id === folderId)) return;
    moveInFlight.current = true;
    setMovingWatch(watch.id);
    setWatchError(null);
    try {
      const saved = await api.updateWatchedSearch(watch.id, { expectedRevision: watch.revision, folderId });
      qc.setQueryData<WatchedSearch[]>(['watched-searches'], current => current?.map(item => item.id === saved.id ? saved : item));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['watched-searches'] }),
        qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] }),
      ]);
      toast({ tone: 'success', title: 'Watch moved', description: `“${saved.displayName ?? saved.query}” moved to ${folders.find(folder => folder.id === folderId)?.name ?? 'Unfiled'}.` });
    } catch (failure) {
      const message = failure instanceof ApiError && failure.status === 409
        ? 'This watch changed elsewhere. The latest version has been requested; review it and drag again.'
        : failure instanceof ApiError && failure.status === 404
          ? 'The watch or folder no longer exists. The latest lists have been requested; choose another folder.'
          : failure instanceof Error ? failure.message : String(failure);
      setWatchError({ id: watch.id, message });
      toast({ tone: 'danger', title: 'Could not move watch', description: message });
      if (failure instanceof ApiError && (failure.status === 409 || failure.status === 404)) {
        await Promise.all([watchesQuery.refetch(), foldersQuery.refetch()]);
      }
    } finally {
      moveInFlight.current = false;
      setMovingWatch(null);
    }
  }
  async function checkNow() {
    if (checkActive) return;
    setChecking(true);
    try {
      const queued = await api.checkWatchedSearches();
      setRequestedJob(queued.id);
      await checkQuery.refetch();
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
      qc.invalidateQueries({ queryKey: ['watched-searches'] });
      toast({ tone: 'success', title: 'Check interval updated' });
    } catch (e) {
      void settingsQuery.refetch(); // snap the select back to the server value
      toast({ tone: 'danger', title: 'Could not save check interval', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingInterval(false);
    }
  }

  function renderWatch(w: WatchedSearch) {
    const session = editSession.current;
    return (
      <div key={w.id} data-watched-search-id={w.id} aria-busy={movingWatch === w.id} className={cn('border-b border-border py-3 text-xs last:border-b-0', draggedWatch?.id === w.id && 'opacity-60')}>
        <div className="flex items-start gap-2">
          <Button type="button" size="icon" variant="ghost" className="h-11 w-11 shrink-0 cursor-grab active:cursor-grabbing" aria-label={`Move watch ${w.displayName ?? w.query}`} title="Drag to a folder, or click to choose a folder" disabled={updatingWatch !== null || movingWatch !== null || editingWatch !== null || !foldersQuery.isSuccess || watchesQuery.isError} draggable={updatingWatch === null && movingWatch === null && editingWatch === null && foldersQuery.isSuccess && !watchesQuery.isError}
            onClick={() => openEditor(w.id)}
            onDragStart={event => {
              if (moveInFlight.current || updatingWatch !== null || editingWatch !== null || !foldersQuery.isSuccess || watchesQuery.isError) { event.preventDefault(); return; }
              event.dataTransfer.setData(WATCH_DRAG_TYPE, String(w.id));
              event.dataTransfer.effectAllowed = 'move';
              setDraggedWatch(w);
            }}
            onDragEnd={() => setDraggedWatch(null)}
          ><GripVertical aria-hidden="true" className="pointer-events-none h-4 w-4" /></Button>
          <button type="button" onClick={() => onOpenSearch(w.source, w.query)} title={`Open in search tab: ${w.query}`} aria-label={`Search “${w.displayName ?? w.query}” on ${SOURCE_LABELS[w.source] ?? w.source}${w.displayName ? ` · Query: ${w.query}` : ''}`} className="flex min-h-11 min-w-0 flex-1 items-center text-left text-sm font-medium text-primary underline-offset-2 hover:underline"><span className="break-words line-clamp-2">{w.displayName ?? w.query}</span></button>
          <div data-watch-actions role="group" aria-label={`Actions for ${w.displayName ?? w.query}`} className="flex shrink-0 items-center sm:gap-1">
            <Button ref={button => {
              if (!button) return;
              editButtons.current.set(w.id, button);
              return () => { if (editButtons.current.get(w.id) === button) editButtons.current.delete(w.id); };
            }} size="icon" variant="ghost" className="h-11 w-11" title="Edit watch" aria-label={`Edit watch ${w.displayName ?? w.query}`} aria-expanded={editingWatch === w.id} aria-controls={`watch-edit-${w.id}`} disabled={movingWatch !== null} onClick={() => editingWatch === w.id ? closeEditor() : openEditor(w.id)}><Pencil aria-hidden="true" className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" className="h-11 w-11" title={w.pausedAt ? 'Resume watch' : 'Pause watch'} aria-label={`${w.pausedAt ? 'Resume' : 'Pause'} watch ${w.displayName ?? w.query}`} aria-pressed={w.pausedAt !== null} disabled={updatingWatch !== null || movingWatch !== null || watchesQuery.isError} onClick={() => void togglePause(w)}>{updatingWatch === w.id ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : w.pausedAt ? <Play aria-hidden="true" className="h-4 w-4" /> : <Pause aria-hidden="true" className="h-4 w-4" />}</Button>
            <Button size="icon" variant="ghost" className="h-11 w-11" title="Remove watch" aria-label={`Remove watch ${w.displayName ?? w.query}`} disabled={movingWatch !== null} onClick={() => setRemoveTarget(w)}><X className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        <div className="ml-[3.25rem] flex min-w-0 flex-col gap-1">
          {w.displayName && <p className="break-words text-muted">{w.query}</p>}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><Badge tone="muted">{SOURCE_LABELS[w.source] ?? w.source}</Badge><Badge tone={w.pausedAt ? 'warning' : 'muted'}>{w.pausedAt ? 'Paused' : 'Active'}</Badge><span className="text-muted">{(w.folderId != null ? folderNameById.get(w.folderId) : undefined) ?? 'Unfiled'}</span>{movingWatch === w.id && <span role="status" className="inline-flex items-center gap-1 text-muted"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />Moving…</span>}
            {w.lastResults.length > 0 && (
              <Button size="sm" variant="ghost" className="ml-auto h-11" aria-expanded={expanded.has(w.id)} aria-controls={`watched-results-${w.id}`} aria-label={`${expanded.has(w.id) ? 'Hide' : 'Show'} ${w.lastResults.length} latest finds for ${w.query}`} onClick={() => toggleExpanded(w.id)}>
                {w.lastResults.length} {w.lastResults.length === 1 ? 'find' : 'finds'}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', expanded.has(w.id) && 'rotate-180')} />
              </Button>
            )}
          </div>
          <p className="text-muted">
            {w.lastCheckedAt ? <>Checked <time dateTime={w.lastCheckedAt} title={DATE_TIME_FMT.format(new Date(w.lastCheckedAt))}>{timeAgo(w.lastCheckedAt)}</time></> : 'Not checked yet'}
            {' · '}{w.effectiveIntervalMinutes === 0 ? w.pausedAt ? 'Off · paused' : 'Off globally' : `Every ${cadenceLabel(w.effectiveIntervalMinutes)} · ${w.intervalMinutes === null ? 'inherited' : 'custom'}`}
            {w.nextCheckAt && !w.pausedAt && w.effectiveIntervalMinutes > 0 && <>{' · next '}<time dateTime={w.nextCheckAt} title={DATE_TIME_FMT.format(new Date(w.nextCheckAt))}>{TIME_SHORT_FMT.format(new Date(w.nextCheckAt))}</time></>}
          </p>
          {w.lastError ? <p className="break-words text-warning">{w.lastFailedAt ? `Last attempt failed ${timeAgo(w.lastFailedAt)}: ` : ''}{w.lastError}</p> : w.lastNewCount !== null && w.lastNewCount !== undefined ? <p className="text-muted">{w.lastNewCount ? `${w.lastNewCount} new ${w.lastNewCount === 1 ? 'find' : 'finds'}` : 'No new finds'}</p> : null}
        </div>
        {watchError?.id === w.id && <p role="alert" className="mt-2 break-words text-sm text-danger">{watchError.message}</p>}
        {editingWatch === w.id && <div id={`watch-edit-${w.id}`}><WatchEditor watch={w} folders={folders} foldersReady={foldersQuery.isSuccess} globalInterval={intervalMinutes} onClose={closeEditor} onSaved={() => { if (editSession.current === session) closeEditor(); }} onRefresh={() => watchesQuery.refetch()} /></div>}
        {w.lastResults.length > 0 && <WatchedReveal id={`watched-results-${w.id}`} open={expanded.has(w.id)} lazy>{() => (
          <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
            {w.lastFindsAt && <p className="text-muted">Found {timeAgo(w.lastFindsAt)}</p>}
            {w.lastResults.map(r => {
              const content = <><Cover url={r.coverUrl} title={r.title} className="h-10 w-8 shrink-0 rounded" /><span className="min-w-0 flex-1 break-words text-left line-clamp-2">{r.title}</span><PageCountPill pageCount={r.pageCount} />{r.url && <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />}</>;
              const className = 'flex min-h-11 items-center gap-2 rounded px-1 text-foreground hover:bg-surface-2 hover:underline';
              return r.url
                ? <a key={r.galleryId} href={r.url} target="_blank" rel="noreferrer" className={className}>{content}</a>
                : <button key={r.galleryId} type="button" className={className} onClick={() => onOpenSearch(w.source, r.galleryId)} aria-label={`Search for ${r.title} on ${SOURCE_LABELS[w.source]}`}>{content}</button>;
            })}
          </div>
        )}</WatchedReveal>}
      </div>
    );
  }

  const manageBody = () => (
        <div className="flex flex-col gap-4 pt-3">
        <AddWatchForm onAdded={onWatchAdded} />
        {foldersQuery.isError && <ErrorState title="Could not load watch folders" description={foldersQuery.error.message} onRetry={() => void foldersQuery.refetch()} />}
        {foldersQuery.isPending ? <Skeleton className="h-20 w-full" /> : foldersQuery.data && <FollowingFolders folders={folders} watches={watches ?? []} watchesReady={watches !== undefined} renderWatch={renderWatch} onRefresh={() => foldersQuery.refetch()} draggedWatch={draggedWatch} movePending={movingWatch !== null || foldersQuery.isError} onMoveWatch={(watch, folderId) => void moveWatch(watch, folderId)} />}
        {watchesQuery.isPending ? (
          <div role="status" aria-label="Loading watched searches" className="flex flex-col gap-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><span className="sr-only">Loading watched searches…</span></div>
        ) : !foldersQuery.data && watches && watches.length > 0 ? (
          <div className="flex flex-col border-t border-border">
            {watches.map(renderWatch)}
          </div>
        ) : (
          watches?.length === 0 && <p className="text-sm text-muted">No watched searches yet. Add one above, or choose Watch on any single-source search.</p>
        )}

        </div>
  );

  const watchMotionRef = useDownloaderTransitions(`${manageOpen}:${(watches ?? []).map(watch => `${watch.id}:${watch.folderId}`).join(',')}`, '[data-watched-search-id]');

  return (
    <div ref={watchMotionRef}>
    <Card className={inDrawer ? 'border-0 bg-transparent p-0 shadow-none' : undefined}>
      <CardHeader className="gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <CardTitle as="h2" className={cn('flex items-center gap-2', inDrawer && 'sr-only')}>
            <Star aria-hidden="true" className="h-4 w-4 shrink-0" /> Watched searches
          </CardTitle>
          <div role="status" className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span key={`${checkJob?.id}:${checkJob?.status}`} className={cn('watched-check-status break-words', checkJob?.status === 'failed' || summary?.failed ? 'text-warning' : 'text-muted')}>{checkLabel}{checkJob?.finishedAt && !checkActive ? ` · ${timeAgo(checkJob.finishedAt)}` : ''}</span>
            {checkJob && <Link className="inline-flex min-h-11 items-center text-primary underline underline-offset-4" to={`/jobs?job=${checkJob.id}`}>View check</Link>}
            {checkQuery.isError && <Button size="sm" variant="ghost" onClick={() => void checkQuery.refetch()}>Retry status</Button>}
          </div>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted sm:flex-none">Check every
          <Select aria-label="Watched search check interval" value={String(intervalMinutes)} onChange={(e) => void saveInterval(Number(e.target.value))} disabled={savingInterval || !settingsQuery.data} className="h-11 sm:w-32">
            {WATCH_INTERVAL_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </Select>
          </label>
          <Button size="sm" variant="outline" className="h-11 shrink-0" onClick={() => void checkNow()} disabled={checkActive || !(watches ?? []).some(watch => watch.pausedAt === null) || checkQuery.isPending} title="Check active watches once; paused watches are excluded">
            {checkActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />} Check now
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {watchesQuery.isError && <ErrorState title="Could not load watched searches" description={watchesQuery.error instanceof Error ? watchesQuery.error.message : String(watchesQuery.error)} onRetry={() => void watchesQuery.refetch()} />}
        {settingsQuery.isError && <ErrorState title="Could not load the check interval" description={settingsQuery.error instanceof Error ? settingsQuery.error.message : String(settingsQuery.error)} onRetry={() => void settingsQuery.refetch()} />}
        {inDrawer ? manageBody() : (
          <WatchedDisclosure label={`Manage watches${watches ? ` (${watches.length})` : ''}`} open={manageOpen || watches?.length === 0} onOpenChange={setManageOpen}>
          {manageBody}
          </WatchedDisclosure>
        )}
        <ConfirmDialog
          open={removeTarget !== null}
          title="Remove watched search?"
          description={removeTarget ? `Stop watching “${removeTarget.displayName ?? removeTarget.query}”? Existing discoveries and their watch name stay in Inbox and History.` : ''}
          confirmLabel="Remove"
          pending={removing}
          onOpenChange={(open) => { if (!open && !removing) setRemoveTarget(null); }}
          onConfirm={() => { if (removeTarget && !removing) void remove(removeTarget).then(success => { if (success) setRemoveTarget(null); }); }}
        />
      </CardContent>
    </Card>
    </div>
  );
}

/** Watch management lives beside the inbox, not above it: the inbox is the payoff, this is upkeep. */
export function WatchedManagerDrawer({ open, onOpenChange, onOpenSearch, returnFocusTo }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenSearch: (source: DoujinSource, query: string) => void; returnFocusTo?: React.RefObject<HTMLElement | null> }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sheet-content left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-xl translate-x-0 translate-y-0 overflow-y-auto rounded-none rounded-l-2xl border-y-0 border-r-0 p-4 sm:max-h-dvh sm:w-full"
        // Escape first closes an open suggestion list or a draft that owns it; only then the sheet.
        onCloseAutoFocus={event => { if (returnFocusTo?.current?.isConnected) { event.preventDefault(); returnFocusTo.current.focus(); } }}
        onEscapeKeyDown={event => { if ((event.target as Element | null)?.closest?.('[role="combobox"][aria-expanded="true"], [data-owns-escape]')) event.preventDefault(); }}>
        <div className="flex flex-col gap-1 pb-3 pr-10">
          <DialogTitle>Manage watches</DialogTitle>
          <DialogDescription>Add searches to follow, choose how often they are checked, and organise them into folders.</DialogDescription>
        </div>
        <WatchedTab inDrawer onOpenSearch={(source, query) => { onOpenChange(false); onOpenSearch(source, query); }} />
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Download manager tab ----------------

/**
 * The manager tab is the only consumer of live task state; subscribing here
 * (rather than at the page top) keeps SSE progress ticks from re-rendering the
 * whole page. Task-mutating actions come from the same stable actions API.
 */
