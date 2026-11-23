import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Download, Eraser, History, House, Image as ImageIcon, Inbox, Link2, PenLine, RefreshCw, Search, Sparkles, Unlink, X, XCircle, type LucideIcon } from 'lucide-react';
import { api, type DoujinSearchResult, type MatchSuggestion } from '../lib/api';
import { cn, PROVIDER_NAMES, sourceDisplayName, timeAgo, toIsoUtc } from '../lib/utils';
import { toast } from '../lib/toast';
import { useDownloadTasks, useGalleryDownloadTask } from '../lib/DownloadsContext';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Pager, ProgressBar, Skeleton, Spinner } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { Cover, GalleryCard, OwnershipChip } from './downloader/GalleryCard';
import { GalleryDetailModal } from './downloader/GalleryDetailModal';
import type { DownloadSetup } from './downloader/state';
import type { GalleryOwnership } from './downloader/ownership';
import { useGalleryDownload } from './downloader/useGalleryDownload';
import { useRecommendations } from './downloader/useRecommendations';

type ActivityTone = 'success' | 'danger' | 'muted';
const activityMeta: Record<string, { label: string; icon: LucideIcon; tone: ActivityTone }> = {
  downloaded: { label: 'Downloaded', icon: Download, tone: 'success' },
  matched: { label: 'Matched', icon: Link2, tone: 'success' },
  updated: { label: 'Metadata updated', icon: PenLine, tone: 'success' },
  failed: { label: 'Sync failed', icon: XCircle, tone: 'danger' },
  unmatched: { label: 'Match removed', icon: Unlink, tone: 'muted' },
  cover: { label: 'Cover updated', icon: ImageIcon, tone: 'success' },
  cleared: { label: 'Metadata cleared', icon: Eraser, tone: 'muted' },
};
const activityToneClass: Record<ActivityTone, string> = { success: 'bg-success/10 text-success', danger: 'bg-danger/10 text-danger', muted: 'bg-surface-2 text-muted' };

/** A scan older than this has missed its daily run. */
const STALE_SCAN_MS = 36 * 3_600_000;

/** Confidence bands: only the extremes get a colour; the label and number always carry the meaning. */
function matchBand(score: number): { label: string; tone: 'success' | 'default' | 'warning' } {
  return score >= 0.95 ? { label: 'Strong', tone: 'success' } : score >= 0.85 ? { label: 'Likely', tone: 'default' } : { label: 'Check', tone: 'warning' };
}

function jumpTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  target.focus({ preventScroll: true });
}

function SectionHeading({ id, title, count, countLabel, description, inline, children }: { id: string; title: string; count?: number; countLabel?: string; description?: string; inline?: boolean; children?: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className={cn('min-w-0', inline && 'flex flex-wrap items-baseline gap-x-3 gap-y-0.5')}>
      <h2 id={id} tabIndex={-1} className="flex scroll-mt-16 items-center gap-2 text-base font-semibold tracking-tight outline-none"><span>{title}{count !== undefined && <span className="sr-only"> {count} {countLabel ?? 'items'}</span>}</span>{count !== undefined && <Badge tone="muted" className="tabular-nums" aria-hidden="true">{count}</Badge>}</h2>
      {description && <p className={cn('text-pretty text-sm text-muted', !inline && 'mt-1')}>{description}</p>}
    </div>
    {children}
  </div>;
}

function SectionLink({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link to={to} className="inline-flex min-h-9 items-center gap-1.5 rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline max-lg:min-h-11 pointer-coarse:min-h-11">{children}<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Link>;
}

function LoadingRows() {
  return <div aria-label="Loading galleries" role="status" className="space-y-4 py-4">{[0, 1, 2].map(i => <div key={i} className="flex gap-3"><Skeleton className="h-16 w-12 shrink-0 rounded-md" /><div className="flex-1 space-y-2 pt-1"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>)}</div>;
}

function CandidateReview({ item, onClose }: { item: MatchSuggestion; onClose: () => void }) {
  const current = useQuery({ queryKey: ['series', item.seriesId], queryFn: () => api.series(item.seriesId) });
  return <IdentifyModal seriesId={item.seriesId} initialCandidate={item.candidate}
    current={{ name: current.data?.series.name ?? item.name, metadata: current.data?.kavita ?? null }}
    currentLoading={current.isPending} currentError={current.isError ? current.error.message : null}
    onRetryCurrent={() => { void current.refetch(); }} match={current.data?.match ?? null} currentCover={item.cover} onClose={onClose} />;
}

/** One Following find: the same download, ownership and dismiss decisions as a Discover card, in a list row. */
function FollowingRow({ item, label, ownership, starting, reviewing, setupStatus, onOpen, onDownload, onDismiss }: {
  item: DoujinSearchResult; label?: string; ownership: GalleryOwnership; starting: boolean; reviewing: boolean; setupStatus: DownloadSetup['status'];
  onOpen: (item: DoujinSearchResult) => void; onDownload: (item: DoujinSearchResult) => void; onDismiss: (item: DoujinSearchResult) => void;
}) {
  const task = useGalleryDownloadTask(item.source, item.galleryId);
  const active = starting || !!task;
  const inLibrary = ownership.type === 'in-library', owned = inLibrary || ownership.type === 'downloaded', possible = ownership.type === 'possible-duplicate';
  const actionLabel = task?.state?.type === 'retry-wait' ? 'Retry scheduled' : task?.status === 'queued' ? 'Queued' : task?.status === 'paused' ? 'Paused' : starting && !task ? 'Checking…' : active ? 'Downloading'
    : inLibrary ? 'In library' : owned ? 'Downloaded' : possible ? 'Review duplicate' : setupStatus === 'missing' ? 'Set folder' : 'Download';
  return <li className="flex min-w-0 gap-3 py-4">
    <button type="button" onClick={() => onOpen(item)} className="h-20 w-14 shrink-0 self-start overflow-hidden rounded-md" tabIndex={-1} aria-hidden="true"><Cover url={item.coverUrl} title={item.title} className="h-full w-full" /></button>
    <div className="min-w-0 flex-1">
      <button type="button" onClick={() => onOpen(item)} className="break-words text-left text-sm font-medium underline-offset-4 hover:text-primary hover:underline">{item.title}</button>
      <p className="mt-1 break-words text-xs text-muted">{item.artists.join(', ') || sourceDisplayName(item.source)}{item.pageCount ? ` · ${item.pageCount} pages` : ''}{label ? ` · From ${label}` : ''}</p>
      {ownership.type !== 'available' && <OwnershipChip type={ownership.type} className="mt-2" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={active || owned || setupStatus === 'loading' || setupStatus === 'error'} onClick={() => onDownload(item)} aria-label={`${actionLabel}: ${item.title}`}>
          {active ? <Spinner /> : owned ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" /> : <Download aria-hidden="true" className="h-3.5 w-3.5" />}{actionLabel}
        </Button>
        <Button size="sm" variant="ghost" disabled={reviewing} onClick={() => onDismiss(item)} aria-label={`Dismiss ${item.title}`} title="Remove from the Following inbox and keep it in History">{reviewing ? <Spinner /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}Dismiss</Button>
      </div>
    </div>
  </li>;
}

export function Home() {
  const qc = useQueryClient(), navigate = useNavigate();
  const { recs, recsLoading, recsFailed, recsError, refetchRecs, recsRefreshing, doRefreshRecs, visibleRecs, ownedKeys } = useRecommendations('search');
  const { setup, pendingKeys, doStartDownload, duplicateDialog } = useGalleryDownload();
  const { tasks: downloadTasks, active: activeDownloads } = useDownloadTasks();
  const [selected, setSelected] = React.useState<DoujinSearchResult | null>(null);
  const [review, setReview] = React.useState<MatchSuggestion | null>(null);
  const [openedIds, setOpenedIds] = React.useState(new Set<number>());
  const [matchPage, setMatchPage] = React.useState(1);
  const [reviewingKeys, setReviewingKeys] = React.useState(new Set<string>());
  const [rejectedIds, setRejectedIds] = React.useState(new Set<number>());
  const matches = useQuery({ queryKey: ['home-matches'], queryFn: api.homeMatches,
    refetchInterval: query => ['queued', 'running'].includes(query.state.data?.scan?.status ?? '') ? 3000 : 60_000 });
  const feed = useQuery({ queryKey: ['watched-gallery-feed', 'home'], queryFn: () => api.watchedGalleryFeed({ view: 'inbox', offset: 0, limit: 4 }), refetchInterval: 60_000 });
  const activity = useQuery({ queryKey: ['home-activity'], queryFn: api.homeActivity, refetchInterval: 30_000 });
  const completed = useQuery({ queryKey: ['downloads-completed'], queryFn: api.downloadsCompleted });
  const recommendationItems = visibleRecs.slice(0, 6);
  const discoveryItems = React.useMemo<DoujinSearchResult[]>(() => (feed.data?.items ?? []).map(item => ({ ...item, coverUrl: item.coverUrl ?? undefined, tags: [] })), [feed.data]);
  const visibleGalleries = [...recommendationItems, ...discoveryItems];
  const ownership = useQuery({
    queryKey: ['gallery-library-matches', visibleGalleries.map(({ source, galleryId, title, artists, language, pageCount }) => ({ source, galleryId, title, artists, language, pageCount }))],
    queryFn: () => api.libraryMatches(visibleGalleries), enabled: visibleGalleries.length > 0, staleTime: 30_000,
  });
  const owned = new Set([...ownedKeys, ...(completed.data ?? []).map(item => `${item.source}:${item.galleryId}`)]);
  const inLibrary = new Set((ownership.data?.reports ?? []).filter(report => report.matches.some(match => match.confirmed && ['In library', 'Owned', 'completed'].includes(match.status))).map(report => `${report.source}:${report.galleryId}`));
  const possible = new Set((ownership.data?.reports ?? []).filter(report => report.matches.length > 0).map(report => `${report.source}:${report.galleryId}`));
  const ownershipFor = (key: string): GalleryOwnership => ({ type: inLibrary.has(key) ? 'in-library' : owned.has(key) ? 'downloaded' : possible.has(key) ? 'possible-duplicate' : 'available' });
  const scan = matches.data?.scan;
  const scanning = ['queued', 'running'].includes(scan?.status ?? '');
  const matchItems = matches.data?.items ?? [];
  const matchPageCount = Math.max(1, Math.ceil(matchItems.length / 4));
  const currentMatchPage = Math.min(matchPage, matchPageCount);
  const scanFinishedMs = scan?.finishedAt ? new Date(toIsoUtc(scan.finishedAt)).getTime() : null;
  const scanStale = scan?.status === 'completed' && scanFinishedMs !== null && Date.now() - scanFinishedMs > STALE_SCAN_MS;
  const scanFailed = scan?.status === 'failed';
  const scanPartial = scan?.status === 'completed' && !!(scan.result as { failed?: number } | null)?.failed;
  const notifyError = (title: string) => (error: Error) => toast({ tone: 'danger', title, description: error.message });
  const scanNow = useMutation({ mutationFn: api.scanMatchable, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['home-matches'] }); void qc.invalidateQueries({ queryKey: ['jobs'] }); }, onError: notifyError('Could not start matching scan') });
  const scanBusy = scanning || scanNow.isPending;
  function openReview(item: MatchSuggestion) {
    setOpenedIds(current => new Set(current).add(item.seriesId));
    setReview(item);
  }
  /** Opens the first candidate not yet opened this visit, so repeated presses work through the queue. */
  function reviewNext() {
    const next = matchItems.find(item => !openedIds.has(item.seriesId)) ?? matchItems[0];
    if (next) openReview(next);
  }
  async function reject(item: MatchSuggestion) {
    setRejectedIds(current => new Set(current).add(item.seriesId));
    try {
      await api.rejectMatchCandidate(item);
      await qc.invalidateQueries({ queryKey: ['home-matches'] });
      toast({ tone: 'info', title: 'Marked as not a match', description: `${item.name}: this candidate stays hidden. Different candidates can still appear.`,
        action: { label: 'Undo', onClick: () => { void api.restoreMatchCandidate(item).then(() => qc.invalidateQueries({ queryKey: ['home-matches'] })).catch(notifyError('Could not undo')); } } });
    } catch (error) { notifyError('Could not save your decision')(error as Error); }
    finally { setRejectedIds(current => new Set([...current].filter(id => id !== item.seriesId))); }
  }
  async function dismissFinds(targets: DoujinSearchResult[]) {
    const keys = targets.map(item => `${item.source}:${item.galleryId}`), refs = targets.map(item => ({ source: item.source, galleryId: item.galleryId }));
    setReviewingKeys(current => new Set([...current, ...keys]));
    try {
      await api.reviewWatchedGalleries(refs, true);
      await qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
      toast({ tone: 'info', title: targets.length === 1 ? 'Dismissed' : `${targets.length} finds dismissed`, description: targets.length === 1 ? targets[0].title : 'They moved from the Following inbox to History.',
        action: { label: 'Undo', onClick: () => { void api.reviewWatchedGalleries(refs, false).then(() => qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] })).catch(notifyError('Could not undo')); } } });
    } catch (error) { notifyError('Could not dismiss')(error as Error); }
    finally { setReviewingKeys(current => new Set([...current].filter(value => !keys.includes(value)))); }
  }
  const inboxCount = feed.data?.inboxCount ?? discoveryItems.length;
  const waiting = [
    matches.data?.configured && matchItems.length > 0 && { id: 'home-matches', label: `${matchItems.length} ${matchItems.length === 1 ? 'match' : 'matches'} to review` },
    inboxCount > 0 && { id: 'home-inbox', label: `${inboxCount} new in Following` },
  ].filter(Boolean) as { id: string; label: string }[];
  const failedDownloads = downloadTasks.filter(task => task.status === 'failed' && !task.retryAt).length;
  const kavitaMissing = matches.data?.configured === false;
  const caughtUp = !!matches.data?.configured && !feed.isPending && !feed.isError && !matchItems.length && !discoveryItems.length && !scanning && !scanFailed && !scanStale && !scanPartial;
  const chipClass = 'inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-surface px-3 text-sm font-medium transition-colors hover:bg-surface-2 max-lg:min-h-11 pointer-coarse:min-h-11';

  const scanLine = !matches.data?.configured ? null
    : scanning ? <p role="status" className="mt-3 text-xs text-muted">{scan?.progressTotal ? `Checking ${scan.progressCurrent} of ${scan.progressTotal} galleries` : 'Checking your unmatched galleries…'}</p>
    : scanFailed ? <p role="status" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-danger"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" /><span>Last scan failed.</span><button type="button" onClick={() => scanNow.mutate()} disabled={scanBusy} className="font-medium underline underline-offset-4 disabled:opacity-50 max-lg:min-h-11 pointer-coarse:min-h-11">Retry</button><Link to="/jobs" className="underline underline-offset-4">View task</Link></p>
    : scanStale ? <p role="status" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warning"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" /><span>Last checked {timeAgo(scan?.finishedAt)}. Daily scans look overdue.</span><Link to="/jobs" className="underline underline-offset-4">Check Tasks</Link></p>
    : scan?.status === 'cancelled' ? <p role="status" className="mt-3 text-xs text-muted">Last scan cancelled. Scan again when you’re ready.</p>
    : <p role="status" className="mt-3 text-xs text-muted">{scan?.finishedAt ? `Checked ${timeAgo(scan.finishedAt)} · Scans daily` : 'Scans daily · Candidates are reviewed before syncing'}</p>;
  const scanButton = <Button variant="outline" size="sm" disabled={scanBusy || !matches.data?.configured} onClick={() => scanNow.mutate()}>{scanBusy ? <Spinner /> : <Search aria-hidden="true" className="h-3.5 w-3.5" />}{scanning ? 'Scanning…' : 'Scan now'}</Button>;

  return <div className="flex min-w-0 flex-col gap-8">
    <PageHeader icon={<House className="h-5 w-5" />} title="Home">
      {waiting.length > 0 && <nav aria-label="Waiting for you" className="flex flex-wrap gap-2">{waiting.map(item => <a key={item.id} href={`#${item.id}`} onClick={event => { event.preventDefault(); jumpTo(item.id); }} className={cn(chipClass, 'border-border-2 lg:sr-only lg:focus:not-sr-only')}>{item.label}</a>)}</nav>}
      {(activeDownloads.length > 0 || failedDownloads > 0) && <nav aria-label="Downloads" className="flex flex-wrap gap-2">
        {activeDownloads.length > 0 && <Link to="/downloader?tab=downloads" className={cn(chipClass, 'border-border-2')}><Spinner />{activeDownloads.length} downloading</Link>}
        {failedDownloads > 0 && <Link to="/downloader?tab=downloads" className={cn(chipClass, 'border-danger/50 text-danger')}><AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />{failedDownloads} failed {failedDownloads === 1 ? 'download' : 'downloads'}</Link>}
      </nav>}
    </PageHeader>

    {kavitaMissing && <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-border bg-surface px-4 py-2 sm:px-5">
      <p className="flex items-center gap-2 text-sm"><Link2 aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />Connect Kavita to find metadata matches for your library.</p>
      <SectionLink to="/settings?tab=general#kavita-connection">Connect Kavita</SectionLink>
    </div>}

    <section aria-labelledby="home-recommendations" className="min-w-0 space-y-4">
      <SectionHeading id="home-recommendations" title="Recommended galleries" inline description={recs?.mode === 'popular' ? 'Popular picks to get you started. Your library and feedback shape future recommendations.' : 'Daily picks from your library and preferences.'}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><Button variant="ghost" disabled={recsRefreshing || recsLoading} onClick={() => void doRefreshRecs()}><RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', recsRefreshing && 'animate-spin')} />{recsRefreshing ? 'Refreshing…' : 'Refresh picks'}</Button><span className="xl:hidden"><SectionLink to="/downloader?tab=recommend">View all picks</SectionLink></span></div>
      </SectionHeading>
      {recsLoading && !recs ? <div role="status" aria-label="Loading recommendations" className="flex gap-3 overflow-hidden xl:grid xl:grid-cols-7">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="aspect-[3/5] w-40 shrink-0 rounded-xl xl:w-auto" />)}</div>
        : recsFailed ? <ErrorState title="Could not load recommendations" description={recsError?.message} onRetry={() => void refetchRecs()} />
        : !recommendationItems.length ? <div className="rounded-xl border border-border bg-surface"><EmptyState compact icon={<Sparkles className="h-5 w-5" />} title="No recommendations yet" description={<>Try Refresh picks, or <Link to="/downloader" className="font-medium text-primary underline underline-offset-4">browse Discover</Link> to find galleries and build your preferences.</>} /></div>
        : <ul aria-label="Recommended galleries" className="-m-1 flex snap-x snap-mandatory gap-3 overflow-x-auto p-1 xl:grid xl:grid-cols-7 xl:overflow-visible">{recommendationItems.map(item => {
          const key = `${item.source}:${item.galleryId}`;
          return <li key={key} className="w-40 shrink-0 snap-start xl:w-auto [&>article]:h-full"><GalleryCard item={item} onOpen={setSelected} onDownload={doStartDownload} downloadSetup={setup.status} starting={pendingKeys.has(key)} display="recommendation" quietAction compact reason={item.reasons?.[0]} ownership={ownershipFor(key)} /></li>;
        }).concat([<li key="all" className="hidden xl:block"><Link to="/downloader?tab=recommend" className="flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-2 p-3 text-center text-sm font-medium text-primary transition-colors hover:bg-surface"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10"><ArrowRight aria-hidden="true" className="h-4 w-4" /></span>View all picks</Link></li>])}</ul>}
    </section>

    {caughtUp ? <section aria-labelledby="home-caught-up" className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><CheckCircle2 aria-hidden="true" className="h-5 w-5" /></span>
        <div className="min-w-0"><h2 id="home-caught-up" tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">You’re all caught up</h2><p className="mt-0.5 text-sm text-muted">No matches to review and nothing new in Following.{scan?.finishedAt ? ` Checked ${timeAgo(scan.finishedAt)}.` : ''}</p></div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{scanButton}<SectionLink to="/downloader?tab=watched">Open Following</SectionLink></div>
    </section>
    : <div className={cn('grid min-w-0 items-start gap-6', !kavitaMissing && 'lg:grid-cols-2')}>
      {!kavitaMissing && <section aria-labelledby="home-matches" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <SectionHeading id="home-matches" title="Matches to review" count={matches.data?.configured ? matchItems.length : undefined} countLabel="candidates">
          <div className="flex flex-wrap items-center gap-2">
            {matchItems.length > 0 && <Button size="sm" onClick={reviewNext}>Review next<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button>}
            {matches.data?.configured && scanButton}
          </div>
        </SectionHeading>
        {scanLine}
        {scanning && <ProgressBar className="mt-3" label="Matching scan progress" value={scan?.progressCurrent ?? 0} max={scan?.progressTotal ?? 0} active />}
        {scanPartial && <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warning"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />Some providers could not be checked.<Link to="/jobs" className="underline underline-offset-4">View scan details</Link></p>}
        {matches.isPending ? <LoadingRows /> : matches.isError ? <ErrorState title="Could not load matching candidates" description={matches.error.message} onRetry={() => void matches.refetch()} />
          : !matchItems.length ? <p className="mt-4 flex items-start gap-2 text-sm text-muted"><Link2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{scanning ? 'Looking for candidates. You can keep browsing while the scan runs.' : 'No candidates waiting. Rejected candidates stay hidden; different ones can appear after the next scan.'}</p>
          : <><ul className="mt-4 divide-y divide-border">{matchItems.slice((currentMatchPage - 1) * 4, currentMatchPage * 4).map(item => {
            const band = matchBand(item.candidate.score), candidateCover = item.candidate.coverUrl;
            const sameTitle = item.candidate.title.trim().toLowerCase() === item.name.trim().toLowerCase();
            return <li key={item.seriesId} className="flex min-w-0 gap-3 py-4">
              <button type="button" onClick={() => openReview(item)} className="flex shrink-0 items-center gap-1 self-start" tabIndex={-1} aria-hidden="true">
                <Cover url={item.cover ?? candidateCover} title={item.name} className="h-[4.5rem] w-12 rounded-md" />
                {candidateCover && item.cover && <><ArrowRight className="h-3 w-3 text-muted" /><Cover url={candidateCover} title={item.candidate.title} className="h-[4.5rem] w-12 rounded-md" /></>}
              </button>
              <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-0.5 break-words text-xs text-muted">{item.libraryName}</p>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"><Badge tone={band.tone} className="tabular-nums">{band.label} · {Math.round(item.candidate.score * 100)}%</Badge><span className="min-w-0 break-words"><span className="text-muted">{PROVIDER_NAMES[item.candidate.providerId] ?? item.candidate.providerId}</span>{!sameTitle && <> · {item.candidate.title}</>}</span></p>
                <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => openReview(item)}>Review match<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" disabled={rejectedIds.has(item.seriesId)} onClick={() => void reject(item)}>{rejectedIds.has(item.seriesId) ? <Spinner /> : <X aria-hidden="true" className="h-3.5 w-3.5" />}Not a match</Button></div>
              </div>
            </li>;
          })}</ul><div className="mt-3"><Pager page={currentMatchPage} count={matchPageCount} onPageChange={setMatchPage} /></div></>}
      </section>}

      <section aria-labelledby="home-inbox" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <SectionHeading id="home-inbox" title="New in Following" count={feed.data?.inboxCount} countLabel="unreviewed">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {discoveryItems.length > 1 && <Button size="sm" variant="ghost" disabled={discoveryItems.every(item => reviewingKeys.has(`${item.source}:${item.galleryId}`))} onClick={() => void dismissFinds(discoveryItems)}><Check className="h-3.5 w-3.5" />{inboxCount > discoveryItems.length ? `Dismiss these ${discoveryItems.length}` : 'Dismiss all'}</Button>}
            <SectionLink to="/downloader?tab=watched">Open Following</SectionLink>
          </div>
        </SectionHeading>
        {feed.isPending ? <LoadingRows /> : feed.isError ? <ErrorState title="Could not load new finds" description={feed.error.message} onRetry={() => void feed.refetch()} />
          : !discoveryItems.length ? <p className="mt-4 flex items-start gap-2 text-sm text-muted"><Inbox aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />Nothing new from the searches you follow. Results appear here when they turn up.</p>
          : <><ul className="mt-4 divide-y divide-border">{discoveryItems.map((item, index) => {
            const key = `${item.source}:${item.galleryId}`;
            return <FollowingRow key={key} item={item} label={feed.data?.items[index]?.watchLabel} ownership={ownershipFor(key)} starting={pendingKeys.has(key)} reviewing={reviewingKeys.has(key)} setupStatus={setup.status}
              onOpen={setSelected} onDownload={doStartDownload} onDismiss={target => void dismissFinds([target])} />;
          })}</ul>{inboxCount > discoveryItems.length && <p className="mt-3 text-xs text-muted">Showing {discoveryItems.length} of {inboxCount}. The rest are waiting in Following.</p>}</>}
      </section>
    </div>}

    <section aria-labelledby="home-activity" className="min-w-0 border-t border-border pt-6">
      <SectionHeading id="home-activity" title="Recent activity" description="Your latest matches, downloads, and library updates."><SectionLink to="/jobs">View tasks</SectionLink></SectionHeading>
      {activity.isPending ? <LoadingRows /> : activity.isError ? <ErrorState title="Could not load recent activity" description={activity.error.message} onRetry={() => void activity.refetch()} />
        : !activity.data.length ? <EmptyState compact icon={<History className="h-5 w-5" />} title="No activity yet" description="Matching a gallery or finishing a download will show up here." />
        : <ul className="mt-4 lg:grid lg:grid-cols-2 lg:gap-x-8">{activity.data.map(item => {
          const meta = activityMeta[item.action] ?? { label: item.action, icon: Link2, tone: 'muted' as const }, Icon = meta.icon;
          return <li key={item.id} className="flex min-w-0 items-start gap-3 border-b border-border py-3">
            <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', activityToneClass[meta.tone])}><Icon aria-hidden="true" className="h-3.5 w-3.5" /></span>
            <div className="min-w-0 flex-1"><Link to={item.href} className="break-words text-sm font-medium underline-offset-4 hover:text-primary hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center">{item.title}</Link><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted"><span className={cn(item.action === 'failed' && 'font-medium text-danger')}>{meta.label}</span><time dateTime={toIsoUtc(item.createdAt)} title={new Date(toIsoUtc(item.createdAt)).toLocaleString()}>{timeAgo(item.createdAt)}</time></div></div>
          </li>;
        })}</ul>}
    </section>
    {review && <CandidateReview key={review.seriesId} item={review} onClose={() => { setReview(null); void qc.invalidateQueries({ queryKey: ['home-matches'] }); }} />}
    {selected && <GalleryDetailModal item={selected} onClose={() => setSelected(null)} onDownload={() => void doStartDownload(selected)} checking={pendingKeys.has(`${selected.source}:${selected.galleryId}`)} downloaded={owned.has(`${selected.source}:${selected.galleryId}`) || inLibrary.has(`${selected.source}:${selected.galleryId}`)} inLibrary={inLibrary.has(`${selected.source}:${selected.galleryId}`)} setup={setup} onSearchTag={(fragment, source) => navigate(`/downloader?tab=search&source=${source ?? selected.source}&q=${encodeURIComponent(fragment)}`)} />}
    {duplicateDialog}
  </div>;
}
