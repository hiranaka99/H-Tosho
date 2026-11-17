import { useDownloaderTransitions } from './motion';
import { Cover } from './GalleryCard';
import { GallerySearchInput } from '../../components/GallerySearchInput';
import { WatchedDisclosure, WatchedReveal } from '../../components/WatchedMotion';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Loader2, X, ExternalLink, Star, ChevronDown, Plus } from 'lucide-react';
import { api, ApiError, type DoujinSource } from '../../lib/api';
import { cn, timeAgo } from '../../lib/utils';
import { toast } from '../../lib/toast';
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Select, ErrorState, ConfirmDialog, Skeleton } from '../../components/ui';
import { PageCountPill } from '../../components/PageCountPill';
import { switchProviderSearch, type TranslationLink } from '../../lib/searchTranslation';

import { SOURCE_LABELS } from './state';
import type { WatchedSearch } from '../../../../server/src/contracts/following';
import { WatchEditor, FollowingFolders, cadenceLabel } from './FollowingOrganization';
import { FollowingDeliveries } from './FollowingDeliveries';
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

export function WatchedTab({ onOpenSearch }: { onOpenSearch: (source: DoujinSource, query: string) => void }) {
  const qc = useQueryClient();
  const watchesQuery = useQuery({ queryKey: ['watched-searches'], queryFn: api.watchedSearches, staleTime: 30_000, refetchInterval: 30_000 });
  const watches = watchesQuery.data;
  const foldersQuery = useQuery({ queryKey: ['watched-search-folders'], queryFn: api.watchedSearchFolders, staleTime: 30_000, refetchInterval: 30_000 });
  const folders = foldersQuery.data ?? [];
  const [editingWatch, setEditingWatch] = React.useState<number | null>(null);
  const editButtons = React.useRef(new Map<number, HTMLButtonElement>());
  const [updatingWatch, setUpdatingWatch] = React.useState<number | null>(null);
  const [watchError, setWatchError] = React.useState<{ id: number; message: string } | null>(null);
  const closeEditor = () => { if (editingWatch !== null) editButtons.current.get(editingWatch)?.focus(); setEditingWatch(null); };
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const intervalMinutes = settingsQuery.data?.watchedSearchIntervalMinutes ?? 15;
  const [savingInterval, setSavingInterval] = React.useState(false);
  const [source, setSource] = React.useState<DoujinSource>('hitomi');
  const [query, setQuery] = React.useState('');
  const watchTranslation = React.useRef<TranslationLink | null>(null);
  const [watchTranslationNotice, setWatchTranslationNotice] = React.useState<{ query: string; issues: string[] } | null>(null);
  function switchWatchSource(next: DoujinSource) {
    if (next === source) return;
    const translated = switchProviderSearch({ query, searchKey: null, sort: 'default' }, source, next, watchTranslation.current);
    watchTranslation.current = translated.link;
    setQuery(translated.search.query);
    setWatchTranslationNotice({ query: translated.search.query, issues: translated.issues });
    setSource(next);
  }
  const [adding, setAdding] = React.useState(false);
  const watchQueryId = React.useId();
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
  const completionRef = React.useRef('');
  React.useEffect(() => {
    if (!checkJob || ['queued', 'running'].includes(checkJob.status)) return;
    const stamp = `${checkJob.id}:${checkJob.status}`;
    if (completionRef.current === stamp) return;
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

  async function add() {
    const q = query.trim();
    if (!q || adding) return;
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
    if (updatingWatch !== null) return;
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
  async function checkNow(watchIds?: number[]) {
    if (checkActive) return;
    setChecking(true);
    try {
      const queued = await api.checkWatchedSearches(watchIds);
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

  const watchMotionRef = useDownloaderTransitions(`${manageOpen}:${(watches ?? []).map(watch => watch.id).join(',')}`, '[data-watched-search-id]');

  return (
    <div ref={watchMotionRef}>
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <CardTitle as="h2" className="flex items-center gap-2">
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
        <p className="text-xs text-muted">Check now checks active watches only. Checks collect discoveries for review; downloads remain your choice.</p>
        <p className="text-xs text-muted">Provider checks and Discord delivery have separate outcomes. Disabled or uncertain sends are never counted as delivered.</p>
        <WatchedDisclosure label={`Manage watches${watches ? ` (${watches.length})` : ''}`} open={manageOpen || watches?.length === 0} onOpenChange={setManageOpen}>
        {() => (
        <div className="flex flex-col gap-4 pt-3">
        <form className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-end" aria-label="Add a watched search" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">Source<Select aria-label="Watched search source" value={source} onChange={(e) => switchWatchSource(e.target.value as DoujinSource)} disabled={adding} className="h-11 sm:w-32 sm:shrink-0"><option value="hitomi">Hitomi.la</option><option value="nhentai">nHentai</option></Select></label>
          <div className="flex min-w-0 flex-col gap-1"><label htmlFor={watchQueryId} className="text-xs text-muted">Query</label><GallerySearchInput id={watchQueryId} value={query} onChange={setQuery} source={source} label="Watched search query" placeholder="Artist, tag, or search query" clearLabel="Clear watched search query" disabled={adding} className="h-11" /></div>
          <Button size="sm" className="h-11" type="submit" disabled={adding || !query.trim()}>{adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add watch</Button>
        </form>
        {watchTranslationNotice?.query === query && watchTranslationNotice.issues.length > 0 && <p role="status" aria-label="Watch query translation" className="break-words text-sm text-muted">{watchTranslationNotice.issues.join(' ')} Review the query before adding the watch.</p>}
        {foldersQuery.isError && <ErrorState title="Could not load watch folders" description={foldersQuery.error.message} onRetry={() => void foldersQuery.refetch()} />}
        {foldersQuery.isPending ? <Skeleton className="h-20 w-full" /> : foldersQuery.data && <FollowingFolders folders={folders} onRefresh={() => foldersQuery.refetch()} />}
        {watchesQuery.isPending ? (
          <div role="status" aria-label="Loading watched searches" className="flex flex-col gap-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><span className="sr-only">Loading watched searches…</span></div>
        ) : watches && watches.length > 0 ? (
          <div className="flex flex-col border-t border-border">
            {watches.map((w) => (
              <div key={w.id} data-watched-search-id={w.id} className="border-b border-border py-3 text-xs last:border-b-0">
                <div className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <button type="button" onClick={() => onOpenSearch(w.source, w.query)} title={`Open in search tab: ${w.query}`} aria-label={`Search “${w.displayName ?? w.query}” on ${SOURCE_LABELS[w.source] ?? w.source}${w.displayName ? ` · Query: ${w.query}` : ''}`} className="flex min-h-11 min-w-0 items-center text-left text-sm font-medium text-primary underline-offset-2 hover:underline"><span className="break-words line-clamp-2">{w.displayName ?? w.query}</span></button>
                    {w.displayName && <p className="break-words text-muted">{w.query}</p>}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><Badge tone="muted">{SOURCE_LABELS[w.source] ?? w.source}</Badge><Badge tone={w.pausedAt ? 'warning' : 'muted'}>{w.pausedAt ? 'Paused' : 'Active'}</Badge><span className="text-muted">{folders.find(folder => folder.id === w.folderId)?.name ?? 'Unfiled'}</span></div>
                    <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 text-muted sm:grid-cols-2">
                      <div><dt className="inline">Last success: </dt><dd className="inline"><time dateTime={w.lastCheckedAt ?? undefined} title={w.lastCheckedAt ? new Date(w.lastCheckedAt).toLocaleString() : undefined}>{w.lastCheckedAt ? timeAgo(w.lastCheckedAt) : 'Not checked yet'}</time></dd></div>
                      <div><dt className="inline">Last failed attempt: </dt><dd className="inline"><time dateTime={w.lastFailedAt ?? undefined} title={w.lastFailedAt ? new Date(w.lastFailedAt).toLocaleString() : undefined}>{w.lastFailedAt ? timeAgo(w.lastFailedAt) : 'None recorded'}</time></dd></div>
                      <div><dt className="inline">Automatic checks: </dt><dd className="inline">{w.effectiveIntervalMinutes === 0 ? w.pausedAt ? 'Off · paused' : 'Off globally' : `Every ${cadenceLabel(w.effectiveIntervalMinutes)} · ${w.intervalMinutes === null ? 'inherited' : 'custom'}`}</dd></div>
                      <div><dt className="inline">Next due: </dt><dd className="inline">{w.nextCheckAt ? <time dateTime={w.nextCheckAt}>{new Date(w.nextCheckAt).toLocaleString()}</time> : 'Not scheduled'}</dd></div>
                      <div><dt className="inline">Notifications: </dt><dd className="inline">{w.notificationMode === 'digest' ? 'Daily digest' : w.notificationMode === 'in-app' ? 'In-app only' : 'Immediate Discord'}</dd></div>
                    </dl>
                    <p className="text-muted">Checks cover up to {w.coverageLimit} provider results, not a complete catch-up.</p>
                    {w.pausedAt && <p className="text-warning">Check once updates in-app discoveries only. No Discord notification is sent, and this watch stays paused.</p>}
                    {w.lastError ? <p className="break-words text-warning">{w.lastError}</p> : w.lastNewCount !== null && w.lastNewCount !== undefined ? <p className="text-muted">{w.lastNewCount ? `${w.lastNewCount} new in last check` : 'No new finds in last check'}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                  {w.lastResults.length > 0 && (
                    <Button size="sm" variant="ghost" className="h-11" aria-expanded={expanded.has(w.id)} aria-controls={`watched-results-${w.id}`} aria-label={`${expanded.has(w.id) ? 'Hide' : 'Show'} ${w.lastResults.length} latest finds for ${w.query}`} onClick={() => toggleExpanded(w.id)}>
                      {w.lastResults.length} finds
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', expanded.has(w.id) && 'rotate-180')} />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" className="h-11 w-11" aria-label={`Remove watch ${w.displayName ?? w.query}`} onClick={() => setRemoveTarget(w)}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button ref={button => { if (button) editButtons.current.set(w.id, button); else editButtons.current.delete(w.id); }} size="sm" variant="outline" className="min-h-11" aria-label={`Edit watch ${w.displayName ?? w.query}`} aria-expanded={editingWatch === w.id} aria-controls={`watch-edit-${w.id}`} onClick={() => editingWatch === w.id ? closeEditor() : setEditingWatch(w.id)}>Edit</Button>
                  <Button size="sm" variant="outline" className="min-h-11" aria-label={`${w.pausedAt ? 'Resume' : 'Pause'} watch ${w.displayName ?? w.query}`} disabled={updatingWatch !== null || watchesQuery.isError} onClick={() => void togglePause(w)}>{updatingWatch === w.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{w.pausedAt ? 'Resume' : 'Pause'}</Button>
                  <Button size="sm" variant="ghost" className="min-h-11" aria-label={`Check once ${w.displayName ?? w.query}`} disabled={checkActive || checkQuery.isPending || updatingWatch !== null} onClick={() => void checkNow([w.id])}>Check once</Button>
                </div>
                {watchError?.id === w.id && <p role="alert" className="mt-2 break-words text-sm text-danger">{watchError.message}</p>}
                {editingWatch === w.id && <div id={`watch-edit-${w.id}`}><WatchEditor watch={w} folders={folders} foldersReady={foldersQuery.isSuccess} globalInterval={intervalMinutes} onClose={closeEditor} onRefresh={() => watchesQuery.refetch()} /></div>}
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
            ))}
          </div>
        ) : (
          watches && <p className="text-sm text-muted">No watched searches yet</p>
        )}

        </div>
        )}
        </WatchedDisclosure>
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
    <div className="mt-4"><FollowingDeliveries /></div>
    </div>
  );
}

// ---------------- Download manager tab ----------------

/**
 * The manager tab is the only consumer of live task state; subscribing here
 * (rather than at the page top) keeps SSE progress ticks from re-rendering the
 * whole page. Task-mutating actions come from the same stable actions API.
 */
