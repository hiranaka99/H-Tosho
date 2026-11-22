import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, Check, Download, History, House, Inbox, Link2, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { api, type DoujinSearchResult, type MatchSuggestion } from '../lib/api';
import { cn, PROVIDER_NAMES, sourceDisplayName, timeAgo, toIsoUtc } from '../lib/utils';
import { toast } from '../lib/toast';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Pager, ProgressBar, Skeleton, Spinner } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { Cover, GalleryCard } from './downloader/GalleryCard';
import { GalleryDetailModal } from './downloader/GalleryDetailModal';
import { useGalleryDownload } from './downloader/useGalleryDownload';
import { useRecommendations } from './downloader/useRecommendations';

const activityLabels: Record<string, string> = {
  downloaded: 'Downloaded', matched: 'Matched', updated: 'Metadata updated', failed: 'Sync failed',
  unmatched: 'Match removed', cover: 'Cover updated', cleared: 'Metadata cleared',
};

function SectionHeading({ id, title, count, countLabel, description, children }: { id: string; title: string; count?: number; countLabel?: string; description?: string; children?: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 id={id} className="flex scroll-mt-16 items-center gap-2 text-base font-semibold tracking-tight"><span>{title}{count !== undefined && <span className="sr-only"> {count} {countLabel ?? 'items'}</span>}</span>{count !== undefined && <Badge tone="muted" className="tabular-nums" aria-hidden="true">{count}</Badge>}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
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

export function Home() {
  const qc = useQueryClient(), navigate = useNavigate();
  const { recs, recsLoading, recsFailed, recsError, refetchRecs, recsRefreshing, doRefreshRecs, visibleRecs, ownedKeys } = useRecommendations('search');
  const { setup, pendingKeys, doStartDownload, duplicateDialog } = useGalleryDownload();
  const [selected, setSelected] = React.useState<DoujinSearchResult | null>(null);
  const [review, setReview] = React.useState<MatchSuggestion | null>(null);
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
  const scan = matches.data?.scan;
  const scanning = ['queued', 'running'].includes(scan?.status ?? '');
  const matchItems = matches.data?.items ?? [];
  const matchPageCount = Math.max(1, Math.ceil(matchItems.length / 4));
  const currentMatchPage = Math.min(matchPage, matchPageCount);
  const notifyError = (title: string) => (error: Error) => toast({ tone: 'danger', title, description: error.message });
  const scanNow = useMutation({ mutationFn: api.scanMatchable, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['home-matches'] }); void qc.invalidateQueries({ queryKey: ['jobs'] }); }, onError: notifyError('Could not start matching scan') });
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
  async function markReviewed(targets: DoujinSearchResult[]) {
    const keys = targets.map(item => `${item.source}:${item.galleryId}`), refs = targets.map(item => ({ source: item.source, galleryId: item.galleryId }));
    setReviewingKeys(current => new Set([...current, ...keys]));
    try {
      await api.reviewWatchedGalleries(refs, true);
      await qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
      toast({ tone: 'info', title: targets.length === 1 ? 'Marked reviewed' : `${targets.length} galleries marked reviewed`, description: targets.length === 1 ? targets[0].title : 'They moved from the Following inbox to History.',
        action: { label: 'Undo', onClick: () => { void api.reviewWatchedGalleries(refs, false).then(() => qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] })).catch(notifyError('Could not undo')); } } });
    } catch (error) { notifyError('Could not mark gallery reviewed')(error as Error); }
    finally { setReviewingKeys(current => new Set([...current].filter(value => !keys.includes(value)))); }
  }
  const inboxCount = feed.data?.inboxCount ?? discoveryItems.length;
  const waiting = [
    matches.data?.configured && matchItems.length > 0 && { href: '#home-matches', label: `${matchItems.length} ${matchItems.length === 1 ? 'match' : 'matches'} to review` },
    inboxCount > 0 && { href: '#home-inbox', label: `${inboxCount} new in Following` },
  ].filter(Boolean) as { href: string; label: string }[];
  return <div className="flex min-w-0 flex-col gap-8">
    <PageHeader icon={<House className="h-5 w-5" />} title="Home" subtitle="Today’s picks, matches to review, and new finds.">
      {waiting.length > 0 && <nav aria-label="Waiting for you" className="flex flex-wrap gap-2">{waiting.map(item => <a key={item.href} href={item.href} className="inline-flex min-h-9 items-center rounded-full border border-border-2 bg-surface px-3 text-sm font-medium transition-colors hover:bg-surface-2 max-lg:min-h-11 pointer-coarse:min-h-11">{item.label}</a>)}</nav>}
    </PageHeader>

    <section aria-labelledby="home-recommendations" className="min-w-0 space-y-4">
      <SectionHeading id="home-recommendations" title="Recommended galleries" description={recs?.mode === 'popular' ? 'Popular picks to get you started. Your library and feedback shape future recommendations.' : 'Daily picks from your library and preferences.'}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><Button variant="ghost" disabled={recsRefreshing || recsLoading} onClick={() => void doRefreshRecs()}><RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', recsRefreshing && 'animate-spin')} />{recsRefreshing ? 'Refreshing…' : 'Refresh picks'}</Button><SectionLink to="/downloader?tab=recommend">View all picks</SectionLink></div>
      </SectionHeading>
      {recsLoading && !recs ? <div role="status" aria-label="Loading recommendations" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="aspect-[3/5] rounded-xl" />)}</div>
        : recsFailed ? <ErrorState title="Could not load recommendations" description={recsError?.message} onRetry={() => void refetchRecs()} />
        : !recommendationItems.length ? <div className="rounded-xl border border-border bg-surface"><EmptyState compact icon={<Sparkles className="h-5 w-5" />} title="No recommendations yet" description={<>Try Refresh picks, or <Link to="/downloader" className="font-medium text-primary underline underline-offset-4">browse Discover</Link> to find galleries and build your preferences.</>} /></div>
        : <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">{recommendationItems.map((item, index) => {
          const key = `${item.source}:${item.galleryId}`;
          return <div key={key} className={cn('min-w-0 [&>article]:h-full', index >= 2 && 'hidden md:block')}><GalleryCard item={item} onOpen={setSelected} onDownload={doStartDownload} downloadSetup={setup.status} starting={pendingKeys.has(key)} display="recommendation" quietAction ownership={{ type: inLibrary.has(key) ? 'in-library' : owned.has(key) ? 'downloaded' : possible.has(key) ? 'possible-duplicate' : 'available' }} /></div>;
        })}</div>}
    </section>

    <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
      <section aria-labelledby="home-matches" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <SectionHeading id="home-matches" title="Matches to review" count={matches.data?.configured ? matchItems.length : undefined} countLabel="candidates" description="New metadata candidates for your unmatched galleries.">
          {matches.data?.configured !== false && <Button variant="outline" size="sm" disabled={scanning || scanNow.isPending || !matches.data?.configured} onClick={() => scanNow.mutate()}>{scanning || scanNow.isPending ? <Spinner /> : <Search aria-hidden="true" className="h-3.5 w-3.5" />}{scanning ? 'Scanning…' : 'Scan now'}</Button>}
        </SectionHeading>
        {matches.data?.configured !== false && <p className="mt-3 text-xs text-muted">{scanning ? (scan?.progressTotal ? `Checking ${scan.progressCurrent} of ${scan.progressTotal} galleries` : 'Checking your unmatched galleries…') : scan?.status === 'failed' ? 'Last scan failed. Retry with Scan now, or check Tasks for details.' : scan?.status === 'cancelled' ? 'Last scan cancelled. Scan again when you’re ready.' : scan?.finishedAt ? `Checked ${timeAgo(scan.finishedAt)} · Scans daily` : 'Scans daily · Candidates are reviewed before syncing'}</p>}
        {scanning && <ProgressBar className="mt-3" label="Matching scan progress" value={scan?.progressCurrent ?? 0} max={scan?.progressTotal ?? 0} active />}
        {scan?.status === 'completed' && !!(scan.result as { failed?: number } | null)?.failed && <p className="mt-2 text-xs text-warning">Some providers could not be checked. <Link to="/jobs" className="underline underline-offset-4">View scan details</Link></p>}
        {matches.isPending ? <LoadingRows /> : matches.isError ? <ErrorState title="Could not load matching candidates" description={matches.error.message} onRetry={() => void matches.refetch()} />
          : !matches.data.configured ? <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1"><p className="text-sm text-muted">Connect Kavita to find metadata matches for your library.</p><SectionLink to="/settings?tab=general#kavita-connection">Connect Kavita</SectionLink></div>
          : !matchItems.length ? <EmptyState compact icon={<Link2 className="h-5 w-5" />} title={scanning ? 'Looking for candidates' : 'No matching candidates yet'} description={scanning ? 'You can keep browsing while the scan runs.' : 'Use Scan now to check your unmatched galleries. Rejected candidates stay hidden; different candidates can appear later.'} />
          : <><ul className="mt-4 divide-y divide-border">{matchItems.slice((currentMatchPage - 1) * 4, currentMatchPage * 4).map(item => <li key={item.seriesId} className="flex min-w-0 gap-3 py-4">
            <button type="button" onClick={() => setReview(item)} className="h-20 w-14 shrink-0 overflow-hidden rounded-md" tabIndex={-1} aria-hidden="true"><Cover url={item.cover ?? item.candidate.coverUrl} title={item.name} className="h-full w-full" /></button>
            <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-1 break-words text-xs text-muted">{item.libraryName}</p><p className="mt-2 break-words text-xs"><span className="font-medium text-success">{Math.round(item.candidate.score * 100)}% match</span><span className="text-muted"> · {PROVIDER_NAMES[item.candidate.providerId] ?? item.candidate.providerId} · {item.candidate.title}</span></p>
              <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => setReview(item)}>Review match<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" disabled={rejectedIds.has(item.seriesId)} onClick={() => void reject(item)}>{rejectedIds.has(item.seriesId) ? <Spinner /> : <X aria-hidden="true" className="h-3.5 w-3.5" />}Not a match</Button></div>
            </div>
          </li>)}</ul><div className="mt-3"><Pager page={currentMatchPage} count={matchPageCount} onPageChange={setMatchPage} /></div></>}
      </section>

      <section aria-labelledby="home-inbox" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <SectionHeading id="home-inbox" title="New in Following" count={feed.data?.inboxCount} countLabel="unreviewed" description="New galleries from the searches you follow, ready to review.">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {discoveryItems.length > 1 && <Button size="sm" variant="ghost" disabled={discoveryItems.every(item => reviewingKeys.has(`${item.source}:${item.galleryId}`))} onClick={() => void markReviewed(discoveryItems)}><Check aria-hidden="true" className="h-3.5 w-3.5" />{inboxCount > discoveryItems.length ? `Mark these ${discoveryItems.length} reviewed` : 'Mark all reviewed'}</Button>}
            <SectionLink to="/downloader?tab=watched">Open Following</SectionLink>
          </div>
        </SectionHeading>
        {feed.isPending ? <LoadingRows /> : feed.isError ? <ErrorState title="Could not load new finds" description={feed.error.message} onRetry={() => void feed.refetch()} />
          : !discoveryItems.length ? <div><EmptyState compact icon={<Inbox className="h-5 w-5" />} title="Nothing new to review" description="New results from the searches you follow will appear here. Review them at your own pace." /><div className="text-center"><SectionLink to="/downloader?tab=watched">Manage Following</SectionLink></div></div>
          : <><ul className="mt-4 divide-y divide-border">{discoveryItems.map((item, index) => {
            const key = `${item.source}:${item.galleryId}`, meta = feed.data?.items[index];
            return <li key={key} className="flex min-w-0 gap-3 py-4"><button type="button" onClick={() => setSelected(item)} className="h-20 w-14 shrink-0 overflow-hidden rounded-md" tabIndex={-1} aria-hidden="true"><Cover url={item.coverUrl} title={item.title} className="h-full w-full" /></button>
              <div className="min-w-0 flex-1"><button type="button" onClick={() => setSelected(item)} className="break-words text-left text-sm font-medium underline-offset-4 hover:text-primary hover:underline">{item.title}</button><p className="mt-1 break-words text-xs text-muted">{item.artists.join(', ') || sourceDisplayName(item.source)}{item.pageCount ? ` · ${item.pageCount} pages` : ''}</p><p className="mt-2 break-words text-xs text-muted">Via {meta?.query}</p>
                <div className="mt-3"><Button size="sm" variant="ghost" className="-ml-2.5" disabled={reviewingKeys.has(key)} onClick={() => void markReviewed([item])}>{reviewingKeys.has(key) ? <Spinner /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}Mark reviewed</Button></div>
              </div></li>;
          })}</ul>{inboxCount > discoveryItems.length && <p className="mt-3 text-xs text-muted">Showing {discoveryItems.length} of {inboxCount}. The rest are waiting in Following.</p>}</>}
      </section>
    </div>

    <section aria-labelledby="home-activity" className="min-w-0 border-t border-border pt-6">
      <SectionHeading id="home-activity" title="Recent activity" description="Your latest matches, downloads, and library updates."><SectionLink to="/jobs">View tasks</SectionLink></SectionHeading>
      {activity.isPending ? <LoadingRows /> : activity.isError ? <ErrorState title="Could not load recent activity" description={activity.error.message} onRetry={() => void activity.refetch()} />
        : !activity.data.length ? <EmptyState icon={<History className="h-5 w-5" />} title="Your library’s story starts here" description="Match a gallery or complete a download to see it in your recent activity." />
        : <ul className="mt-4 lg:columns-2 lg:gap-x-8">{activity.data.map(item => <li key={item.id} className="flex min-w-0 break-inside-avoid items-start gap-3 border-b border-border py-3">
          <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', item.action === 'failed' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success')}>{item.action === 'downloaded' ? <Download aria-hidden="true" className="h-3.5 w-3.5" /> : item.action === 'failed' ? <X aria-hidden="true" className="h-3.5 w-3.5" /> : <Link2 aria-hidden="true" className="h-3.5 w-3.5" />}</span>
          <div className="min-w-0 flex-1"><Link to={item.href} className="break-words text-sm font-medium underline-offset-4 hover:text-primary hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center">{item.title}</Link><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted"><span className={cn(item.action === 'failed' && 'font-medium text-danger')}>{activityLabels[item.action] ?? item.action}</span><time dateTime={toIsoUtc(item.createdAt)} title={new Date(toIsoUtc(item.createdAt)).toLocaleString()}>{timeAgo(item.createdAt)}</time></div></div>
        </li>)}</ul>}
    </section>
    {review && <CandidateReview key={review.seriesId} item={review} onClose={() => { setReview(null); void qc.invalidateQueries({ queryKey: ['home-matches'] }); }} />}
    {selected && <GalleryDetailModal item={selected} onClose={() => setSelected(null)} onDownload={() => void doStartDownload(selected)} checking={pendingKeys.has(`${selected.source}:${selected.galleryId}`)} downloaded={owned.has(`${selected.source}:${selected.galleryId}`) || inLibrary.has(`${selected.source}:${selected.galleryId}`)} inLibrary={inLibrary.has(`${selected.source}:${selected.galleryId}`)} setup={setup} onSearchTag={(fragment, source) => navigate(`/downloader?tab=search&source=${source ?? selected.source}&q=${encodeURIComponent(fragment)}`)} />}
    {duplicateDialog}
  </div>;
}
