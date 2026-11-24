import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Download, Eraser, History, House, Image as ImageIcon, Inbox, Link2, PenLine, RefreshCw, Search, ShieldQuestion, Sparkles, Unlink, X, XCircle, type LucideIcon } from 'lucide-react';
import { api, type DoujinSearchResult, type DownloadTask, type MatchSuggestion } from '../lib/api';
import { cn, PROVIDER_NAMES, sourceDisplayName, timeAgo, toIsoUtc } from '../lib/utils';
import { toast } from '../lib/toast';
import { useDownloadsSelector, useGalleryDownloadStatus } from '../lib/DownloadsContext';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Pager, ProgressBar, Skeleton, Spinner } from '../components/ui';
import { Cover, GalleryCard, OwnershipChip } from './downloader/GalleryCard';
import type { DownloadSetup } from './downloader/state';
import type { GalleryOwnership } from './downloader/ownership';
const IdentifyModal = React.lazy(() => import('../components/IdentifyModal').then((m) => ({ default: m.IdentifyModal })));
const GalleryDetailModal = React.lazy(() => import('./downloader/GalleryDetailModal').then((m) => ({ default: m.GalleryDetailModal })));
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
  return score >= 0.95 ? { label: 'Strong', tone: 'success' } : score >= 0.85 ? { label: 'Likely', tone: 'default' } : { label: 'Unsure', tone: 'warning' };
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

type WaitingItem = { key: string; label: string; icon: LucideIcon; tone?: 'warning' | 'danger'; jump?: string; to?: string };

/** A small cover with a caption, so the current → proposed direction never relies on the arrow alone. */
function CoverWithLabel({ url, title, label }: { url: string | undefined; title: string; label: string }) {
  return <span className="flex w-12 flex-col items-center gap-1">
    <Cover url={url} title={title} className="h-[4.5rem] w-12 rounded-md" />
    <span className="text-[11px] leading-none text-muted">{label}</span>
  </span>;
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

const NO_DOWNLOAD_COUNTS = { active: 0, failed: 0 };
/** Header chip counts; numbers are structurally shared, so progress ticks never re-render Home. */
function selectHomeDownloadCounts(tasks: DownloadTask[]) {
  return {
    active: tasks.filter(task => task.status === 'downloading' || task.status === 'queued').length,
    failed: tasks.filter(task => task.status === 'failed' && !task.retryAt).length,
  };
}

/** One Following find: the same download, ownership and dismiss decisions as a Discover card, in a list row. */
function FollowingRow({ item, label, ownership, starting, reviewing, setupStatus, onOpen, onDownload, onDismiss }: {
  item: DoujinSearchResult; label?: string; ownership: GalleryOwnership; starting: boolean; reviewing: boolean; setupStatus: DownloadSetup['status'];
  onOpen: (item: DoujinSearchResult) => void; onDownload: (item: DoujinSearchResult) => void; onDismiss: (item: DoujinSearchResult) => void;
}) {
  // Coarse status only, so the row never re-renders on byte/speed ticks.
  const taskStatus = useGalleryDownloadStatus(item.source, item.galleryId);
  const active = starting || !!taskStatus;
  const inLibrary = ownership.type === 'in-library', owned = inLibrary || ownership.type === 'downloaded', possible = ownership.type === 'possible-duplicate';
  const actionLabel = taskStatus === 'retry-wait' ? 'Retry scheduled' : taskStatus === 'queued' ? 'Queued' : taskStatus === 'paused' ? 'Paused' : starting && !taskStatus ? 'Checking…' : active ? 'Downloading'
    : inLibrary ? 'In library' : owned ? 'Downloaded' : possible ? 'Review duplicate' : setupStatus === 'missing' ? 'Set folder' : 'Download';
  return <li className="flex min-w-0 gap-3 py-4">
    <button type="button" onClick={() => onOpen(item)} className="h-20 w-14 shrink-0 self-start overflow-hidden rounded-md" tabIndex={-1} aria-hidden="true"><Cover url={item.coverUrl} title={item.title} className="h-full w-full" /></button>
    <div className="min-w-0 flex-1">
      <button type="button" onClick={() => onOpen(item)} className="break-words text-left text-sm font-medium underline-offset-4 hover:text-primary hover:underline">{item.title}</button>
      <p className="mt-1 break-words text-xs text-muted">{item.artists.join(', ') || sourceDisplayName(item.source)}{item.pageCount ? ` · ${item.pageCount} pages` : ''}{label ? ` · From ${label}` : ''}</p>
      {ownership.type !== 'available' && <OwnershipChip type={ownership.type} className="mt-2" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Owned finds already carry their ownership chip; a faded disabled button would only repeat it. */}
        {(!owned || active) && <Button size="sm" variant="outline" disabled={active || setupStatus === 'loading' || setupStatus === 'error'} onClick={() => onDownload(item)} aria-label={`${actionLabel}: ${item.title}`}>
          {active ? <Spinner /> : <Download aria-hidden="true" className="h-3.5 w-3.5" />}{actionLabel}
        </Button>}
        <Button size="sm" variant="ghost" disabled={reviewing} onClick={() => onDismiss(item)} aria-label={`Dismiss ${item.title}`}>{reviewing ? <Spinner /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}Dismiss</Button>
      </div>
    </div>
  </li>;
}

export function Home() {
  const qc = useQueryClient(), navigate = useNavigate();
  const { recs, recsLoading, recsFailed, recsError, refetchRecs, recsRefreshing, doRefreshRecs, visibleRecs, ownedKeys } = useRecommendations('search');
  const { setup, pendingKeys, doStartDownload, duplicateDialog } = useGalleryDownload();
  const { active: activeDownloads, failed: failedDownloads } = useDownloadsSelector(selectHomeDownloadCounts) ?? NO_DOWNLOAD_COUNTS;
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
  const recommendationItems = React.useMemo(() => visibleRecs.slice(0, 6), [visibleRecs]);
  const discoveryItems = React.useMemo<DoujinSearchResult[]>(() => (feed.data?.items ?? []).map(item => ({ ...item, coverUrl: item.coverUrl ?? undefined, tags: [] })), [feed.data]);
  const visibleGalleries = React.useMemo(() => [...recommendationItems, ...discoveryItems], [recommendationItems, discoveryItems]);
  const visibleGalleriesKey = React.useMemo(
    () => visibleGalleries.map((item) => `${item.source}:${item.galleryId}`).join(','),
    [visibleGalleries],
  );
  const ownership = useQuery({
    queryKey: ['gallery-library-matches', visibleGalleriesKey],
    queryFn: () => api.libraryMatches(visibleGalleries), enabled: visibleGalleries.length > 0, staleTime: 30_000,
  });
  const owned = React.useMemo(() => new Set([...ownedKeys, ...(completed.data ?? []).map(item => `${item.source}:${item.galleryId}`)]), [ownedKeys, completed.data]);
  const inLibrary = React.useMemo(() => new Set((ownership.data?.reports ?? []).filter(report => report.matches.some(match => match.confirmed && ['In library', 'Owned', 'completed'].includes(match.status))).map(report => `${report.source}:${report.galleryId}`)), [ownership.data]);
  const possible = React.useMemo(() => new Set((ownership.data?.reports ?? []).filter(report => report.matches.length > 0).map(report => `${report.source}:${report.galleryId}`)), [ownership.data]);
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
      toast({ tone: 'info', title: targets.length === 1 ? 'Dismissed' : `${targets.length} finds dismissed`, description: targets.length === 1 ? targets[0].title : 'They left the Following inbox and stay in All finds.',
        action: { label: 'Undo', onClick: () => { void api.reviewWatchedGalleries(refs, false).then(() => qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] })).catch(notifyError('Could not undo')); } } });
    } catch (error) { notifyError('Could not dismiss')(error as Error); }
    finally { setReviewingKeys(current => new Set([...current].filter(value => !keys.includes(value)))); }
  }
  const inboxCount = feed.data?.inboxCount ?? discoveryItems.length;
  const kavitaMissing = matches.data?.configured === false;
  const uncertain = useQuery({ queryKey: ['low-confidence'], queryFn: api.lowConfidenceCount, enabled: !!matches.data?.configured, refetchInterval: 60_000 });
  const uncertainCount = matches.data?.configured ? uncertain.data?.count ?? 0 : 0;
  const waiting: WaitingItem[] = [];
  if (matches.data?.configured && matchItems.length > 0) waiting.push({ key: 'matches', jump: 'home-matches', icon: Link2, label: `${matchItems.length} ${matchItems.length === 1 ? 'match' : 'matches'} to review` });
  if (uncertainCount > 0) waiting.push({ key: 'uncertain', to: '/libraries/review', icon: ShieldQuestion, tone: 'warning', label: `${uncertainCount} uncertain ${uncertainCount === 1 ? 'match' : 'matches'} in Libraries` });
  if (inboxCount > 0) waiting.push({ key: 'inbox', jump: 'home-inbox', icon: Inbox, label: `${inboxCount} new in Following` });
  if (failedDownloads > 0) waiting.push({ key: 'failed', to: '/downloader?tab=downloads&status=failed', icon: AlertTriangle, tone: 'danger', label: `${failedDownloads} failed ${failedDownloads === 1 ? 'download' : 'downloads'}` });
  const caughtUp = !!matches.data?.configured && !feed.isPending && !feed.isError && !uncertain.isPending && !matchItems.length && !discoveryItems.length && uncertainCount === 0 && !scanning && !scanFailed && !scanStale && !scanPartial;
  // Work comes first; recommendations lead only once nothing is waiting.
  const recsFirst = caughtUp && waiting.length === 0;
  const chipClass = 'inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-surface px-3 text-sm font-medium transition-colors hover:bg-surface-2 max-lg:min-h-11 pointer-coarse:min-h-11';
  const scanNoun = scan?.type === 'scan-downloaded' ? 'galleries' : 'series';

  // One quiet live region: it changes only when the scan starts or settles, not on every progress poll.
  const scanAnnouncement = !matches.data?.configured ? ''
    : scanning ? 'Matching scan running.'
    : scanFailed ? 'Last scan failed.'
    : scanStale ? 'Daily scans look overdue.'
    : scan?.status === 'cancelled' ? 'Last scan cancelled.'
    : scan?.finishedAt ? 'Matching scan finished.' : '';
  const scanLine = !matches.data?.configured ? null
    : scanning ? <p className="mt-3 text-xs text-muted">{scan?.progressTotal ? `Checking ${scan.progressCurrent} of ${scan.progressTotal} ${scanNoun}` : `Checking your unmatched ${scanNoun}…`}</p>
    : scanFailed ? <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-danger"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" /><span>Last scan failed.</span><button type="button" onClick={() => scanNow.mutate()} disabled={scanBusy} className="font-medium underline underline-offset-4 disabled:opacity-50 max-lg:min-h-11 pointer-coarse:min-h-11">Retry</button><Link to="/jobs" className="underline underline-offset-4">View task</Link></p>
    : scanStale ? <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warning"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" /><span>Last checked {timeAgo(scan?.finishedAt)}. Daily scans look overdue.</span><Link to="/jobs" className="underline underline-offset-4">Check Tasks</Link></p>
    : scan?.status === 'cancelled' ? <p className="mt-3 text-xs text-muted">Last scan cancelled. Scan again when you’re ready.</p>
    : <p className="mt-3 text-xs text-muted">{scan?.finishedAt ? `Checked ${timeAgo(scan.finishedAt)} · Scans daily` : 'Scans daily · Candidates are reviewed before syncing'}</p>;
  const scanButton = <Button variant="outline" size="sm" disabled={scanBusy || !matches.data?.configured} onClick={() => scanNow.mutate()}>{scanBusy ? <Spinner /> : <Search aria-hidden="true" className="h-3.5 w-3.5" />}{scanning ? 'Scanning…' : 'Scan now'}</Button>;
  const activityItems = (activity.data ?? []).filter(item => !kavitaMissing || item.action === 'downloaded');

  const recommendations = <section aria-labelledby="home-recommendations" className="min-w-0 space-y-4">
    <SectionHeading id="home-recommendations" title="Recommended galleries" inline description={recs?.mode === 'popular' ? 'Popular picks to get you started. Your library and feedback shape future recommendations.' : 'Daily picks from your library and preferences.'}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><Button variant="ghost" disabled={recsRefreshing || recsLoading} onClick={() => void doRefreshRecs()}><RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', recsRefreshing && 'animate-spin')} />{recsRefreshing ? 'Refreshing…' : 'Refresh picks'}</Button><SectionLink to="/downloader?tab=recommend">View all picks</SectionLink></div>
    </SectionHeading>
    {recsLoading && !recs ? <div role="status" aria-label="Loading recommendations" className="flex gap-3 overflow-hidden xl:grid xl:grid-cols-6">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="aspect-[3/5] w-40 shrink-0 rounded-xl xl:w-auto" />)}</div>
      : recsFailed ? <ErrorState title="Could not load recommendations" description={recsError?.message} onRetry={() => void refetchRecs()} />
      : !recommendationItems.length ? <div className="rounded-xl border border-border bg-surface"><EmptyState compact icon={<Sparkles className="h-5 w-5" />} title="No recommendations yet" description={<>Try Refresh picks, or <Link to="/downloader" className="font-medium text-primary underline underline-offset-4">browse Discover</Link> to find galleries and build your preferences.</>} /></div>
      : <ul aria-label="Recommended galleries" className="-m-1 flex snap-x snap-mandatory gap-3 overflow-x-auto p-1 xl:grid xl:grid-cols-6 xl:overflow-visible">{recommendationItems.map(item => {
        const key = `${item.source}:${item.galleryId}`;
        return <li key={key} className="w-40 shrink-0 snap-start xl:w-auto [&>article]:h-full"><GalleryCard item={item} onOpen={setSelected} onDownload={doStartDownload} downloadSetup={setup.status} starting={pendingKeys.has(key)} display="recommendation" quietAction compact reasons={item.reasons} ownership={ownershipFor(key)} /></li>;
      })}</ul>}
  </section>;

  const caughtUpCard = <section aria-labelledby="home-caught-up" className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><CheckCircle2 aria-hidden="true" className="h-5 w-5" /></span>
      <div className="min-w-0"><h2 id="home-caught-up" tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">You’re all caught up</h2><p className="mt-0.5 text-pretty text-sm text-muted">No matches to review in Home or Libraries, and nothing new in Following.{scan?.finishedAt ? ` Checked ${timeAgo(scan.finishedAt)}.` : ''}</p></div>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{scanButton}<SectionLink to="/downloader?tab=watched">Open Following</SectionLink></div>
  </section>;

  const queues = <div className={'grid min-w-0 gap-6 lg:grid-cols-2'}>
    {kavitaMissing ? <section aria-labelledby="home-kavita-setup" className="flex min-w-0 flex-col items-start self-start rounded-xl border border-primary/40 bg-surface p-4 sm:p-5">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Link2 aria-hidden="true" className="h-5 w-5" /></span>
      <h2 id="home-kavita-setup" tabIndex={-1} className="mt-4 text-base font-semibold tracking-tight outline-none">Connect your Kavita library</h2>
      <p className="mt-1 max-w-prose text-pretty text-sm text-muted">H-Tosho checks your series against metadata providers and suggests better titles, descriptions, tags, and covers. You review every change before it syncs to Kavita.</p>
      <p className="mt-3 max-w-prose text-pretty text-sm text-muted">You’ll need your Kavita server address and an admin Auth Key from Kavita’s User Settings.</p>
      <Button asChild className="mt-5"><Link to="/settings?tab=kavita#kavita-connection">Connect Kavita<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Link></Button>
    </section>
    : <section aria-labelledby="home-matches" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <SectionHeading id="home-matches" title="Matches to review" count={matches.data?.configured ? matchItems.length : undefined} countLabel="candidates" description="Suggested metadata for series that don’t have a match yet.">
        <div className="flex flex-wrap items-center gap-2">
          {matchItems.length > 0 && <Button size="sm" onClick={reviewNext}>Review next<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button>}
          {matches.data?.configured && scanButton}
        </div>
      </SectionHeading>
      <p role="status" className="sr-only">{scanAnnouncement}</p>
      {scanLine}
      {scanning && <ProgressBar className="mt-3" label="Matching scan progress" value={scan?.progressCurrent ?? 0} max={scan?.progressTotal ?? 0} active />}
      {scanPartial && <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warning"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />Some providers could not be checked.<Link to="/jobs" className="underline underline-offset-4">View scan details</Link></p>}
      {matches.isPending ? <LoadingRows /> : matches.isError ? <ErrorState title="Could not load matching candidates" description={matches.error.message} onRetry={() => void matches.refetch()} />
        : !matchItems.length ? <p className="mt-4 flex items-start gap-2 text-sm text-muted"><Link2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{scanning ? 'Looking for candidates. You can keep browsing while the scan runs.' : 'No candidates waiting. Rejected candidates stay hidden; different ones can appear after the next scan.'}</p>
        : <><ul className="mt-4 divide-y divide-border">{matchItems.slice((currentMatchPage - 1) * 4, currentMatchPage * 4).map(item => {
          const band = matchBand(item.candidate.score), candidateCover = item.candidate.coverUrl;
          const sameTitle = item.candidate.title.trim().toLowerCase() === item.name.trim().toLowerCase();
          const provider = PROVIDER_NAMES[item.candidate.providerId] ?? item.candidate.providerId;
          return <li key={item.seriesId} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-4">
            <button type="button" onClick={() => openReview(item)} className="flex shrink-0 items-start gap-1 self-start" tabIndex={-1} aria-hidden="true">
              {item.cover && <CoverWithLabel url={item.cover} title={item.name} label="Current" />}
              {item.cover && candidateCover && <ArrowRight className="mt-8 h-3 w-3 text-muted" />}
              {candidateCover ? <CoverWithLabel url={candidateCover} title={item.candidate.title} label="Proposed" />
                : !item.cover && <CoverWithLabel url={undefined} title={item.name} label="Current" />}
            </button>
            <div className="min-w-0"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-0.5 break-words text-xs text-muted">{item.libraryName}</p>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"><Badge tone={band.tone} className="tabular-nums"><span className="sr-only">Confidence: </span>{band.label} · {Math.round(item.candidate.score * 100)}%</Badge><span className="min-w-0 break-words"><span className="sr-only">Proposed match from </span><span className="text-muted">{provider}</span>{!sameTitle && <> · {item.candidate.title}</>}</span></p>
            </div>
            <div className="col-span-2 mt-3 flex flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-2">
              <Button size="sm" variant="outline" onClick={() => openReview(item)} aria-label={`Review match: ${item.name}`}>Review match<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" disabled={rejectedIds.has(item.seriesId)} onClick={() => void reject(item)} aria-label={`Not a match: ${item.name}`}>{rejectedIds.has(item.seriesId) ? <Spinner /> : <X aria-hidden="true" className="h-3.5 w-3.5" />}Not a match</Button>
            </div>
          </li>;
        })}</ul><div className="mt-3"><Pager page={currentMatchPage} count={matchPageCount} onPageChange={setMatchPage} /></div></>}
      {uncertainCount > 0 && <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-4 text-sm text-muted"><ShieldQuestion aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" /><span>{uncertainCount} matched {uncertainCount === 1 ? 'series has' : 'series have'} low confidence.</span><Link to="/libraries/review" className="font-medium text-primary underline-offset-4 hover:underline max-lg:min-h-11 max-lg:inline-flex max-lg:items-center pointer-coarse:min-h-11">Open the review queue</Link></p>}
    </section>}

    <section aria-labelledby="home-inbox" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <SectionHeading id="home-inbox" title="New in Following" count={feed.data?.inboxCount} countLabel="unreviewed" description="New finds from searches you follow. Dismissed finds stay in All finds.">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {discoveryItems.length > 1 && <Button size="sm" variant="ghost" disabled={discoveryItems.every(item => reviewingKeys.has(`${item.source}:${item.galleryId}`))} onClick={() => void dismissFinds(discoveryItems)}><Check aria-hidden="true" className="h-3.5 w-3.5" />{inboxCount > discoveryItems.length ? `Dismiss these ${discoveryItems.length}` : 'Dismiss all'}</Button>}
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
  </div>;

  return <div className="flex min-w-0 flex-col gap-8">
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader icon={<House className="h-5 w-5" />} title="Home">
        {/* The sidebar shows running downloads on desktop; the phone header has no sidebar. */}
        {activeDownloads > 0 && <Link to="/downloader?tab=downloads" className={cn(chipClass, 'border-border-2 lg:hidden')}><Spinner />{activeDownloads} downloading</Link>}
      </PageHeader>
      {waiting.length > 0 && <nav aria-label="Waiting for you"><ul className="flex flex-wrap gap-2">{waiting.map(item => {
        const Icon = item.icon;
        const className = cn(chipClass, 'gap-2 pl-2.5', item.tone === 'danger' ? 'border-danger/50 text-danger' : item.tone === 'warning' ? 'border-warning/50' : 'border-border-2');
        const content = <><Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', item.tone === 'warning' ? 'text-warning' : item.tone === 'danger' ? '' : 'text-primary')} />{item.label}<ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted" /></>;
        return <li key={item.key}>{item.to ? <Link to={item.to} className={className}>{content}</Link>
          : <a href={`#${item.jump}`} onClick={event => { event.preventDefault(); jumpTo(item.jump!); }} className={className}>{content}</a>}</li>;
      })}</ul></nav>}
    </div>

    {recsFirst ? <>{recommendations}{caughtUpCard}</> : <>{caughtUp ? caughtUpCard : queues}{recommendations}</>}

    <section aria-labelledby="home-activity" className="min-w-0 border-t border-border pt-6">
      <SectionHeading id="home-activity" title="Recent activity" description={kavitaMissing ? 'Your latest downloads.' : 'Your latest matches, downloads, and library updates.'}><SectionLink to="/jobs">View tasks</SectionLink></SectionHeading>
      {activity.isPending ? <LoadingRows /> : activity.isError ? <ErrorState title="Could not load recent activity" description={activity.error.message} onRetry={() => void activity.refetch()} />
        : !activityItems.length ? <EmptyState compact icon={<History className="h-5 w-5" />} title="No activity yet" description={kavitaMissing ? 'Finished downloads will show up here.' : 'Matching a gallery or finishing a download will show up here.'} />
        : <ul className="mt-4 lg:grid lg:grid-cols-2 lg:gap-x-8">{activityItems.map(item => {
          const meta = activityMeta[item.action] ?? { label: item.action, icon: Link2, tone: 'muted' as const }, Icon = meta.icon;
          const failed = item.action === 'failed';
          return <li key={item.id} className="flex min-w-0 items-start gap-3 border-b border-border py-3">
            <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', activityToneClass[meta.tone])}><Icon aria-hidden="true" className="h-3.5 w-3.5" /></span>
            <div className="min-w-0 flex-1"><Link to={item.href} className="break-words text-sm font-medium underline-offset-4 hover:text-primary hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center">{item.title}</Link><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted"><span className={cn(failed && 'font-medium text-danger')}>{meta.label}</span><time dateTime={toIsoUtc(item.createdAt)} title={new Date(toIsoUtc(item.createdAt)).toLocaleString()}>{timeAgo(item.createdAt)}</time></div>
              {failed && <p className="mt-1 break-words text-xs text-muted">{item.detail ? `${item.detail.replace(/[.\s]+$/, '')}. ` : ''}Open the series to sync it again.</p>}
            </div>
          </li>;
        })}</ul>}
    </section>
    <React.Suspense fallback={null}>
      {review && <CandidateReview key={review.seriesId} item={review} onClose={() => { setReview(null); void qc.invalidateQueries({ queryKey: ['home-matches'] }); }} />}
      {selected && <GalleryDetailModal item={selected} onClose={() => setSelected(null)} onDownload={() => void doStartDownload(selected)} checking={pendingKeys.has(`${selected.source}:${selected.galleryId}`)} downloaded={owned.has(`${selected.source}:${selected.galleryId}`) || inLibrary.has(`${selected.source}:${selected.galleryId}`)} inLibrary={inLibrary.has(`${selected.source}:${selected.galleryId}`)} libraryMatch={ownership.data?.reports.find(report => report.source === selected.source && report.galleryId === selected.galleryId)?.matches.find(match => match.confirmed && match.status === 'In library')} setup={setup} onSearchTag={(fragment, source) => navigate(`/downloader?tab=search&source=${source ?? selected.source}&q=${encodeURIComponent(fragment)}`)} />}
    </React.Suspense>
    {duplicateDialog}
  </div>;
}
