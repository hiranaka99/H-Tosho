import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, Check, Download, History, House, Inbox, Link2, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { api, type DoujinSearchResult, type MatchSuggestion } from '../lib/api';
import { cn, PROVIDER_NAMES, timeAgo, toIsoUtc } from '../lib/utils';
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

function SectionHeading({ id, title, count, description, children }: { id: string; title: string; count?: number; description?: string; children?: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 id={id} className="flex items-center gap-2 text-base font-semibold tracking-tight">{title}{count !== undefined && <Badge tone="muted" className="tabular-nums">{count}</Badge>}</h2>
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
      toast({ tone: 'info', title: 'Candidate marked as no match', description: 'This candidate stays hidden. Different candidates can still appear.' });
    } catch (error) { notifyError('Could not save your decision')(error as Error); }
    finally { setRejectedIds(current => new Set([...current].filter(id => id !== item.seriesId))); }
  }
  async function markReviewed(item: DoujinSearchResult) {
    const key = `${item.source}:${item.galleryId}`;
    setReviewingKeys(current => new Set(current).add(key));
    try {
      await api.reviewWatchedGalleries([{ source: item.source, galleryId: item.galleryId }], true);
      await qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
    } catch (error) { notifyError('Could not mark gallery reviewed')(error as Error); }
    finally { setReviewingKeys(current => new Set([...current].filter(value => value !== key))); }
  }
  return <div className="flex min-w-0 flex-col gap-8">
    <PageHeader icon={<House className="h-5 w-5" />} title="Home" subtitle="Discover your next read. Keep your library moving." />

    <section aria-labelledby="home-recommendations" className="min-w-0 space-y-4">
      <SectionHeading id="home-recommendations" title="Recommended galleries" description={recs?.mode === 'popular' ? 'Popular picks to get you started. Your library and feedback shape future recommendations.' : 'Daily picks from your library and preferences.'}>
        <div className="flex flex-wrap items-center gap-4"><Button size="sm" variant="ghost" disabled={recsRefreshing || recsLoading} onClick={() => void doRefreshRecs()}><RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', recsRefreshing && 'animate-spin')} />{recsRefreshing ? 'Refreshing…' : 'Refresh picks'}</Button><SectionLink to="/downloader?tab=recommend">View all picks</SectionLink></div>
      </SectionHeading>
      {recsLoading && !recs ? <div role="status" aria-label="Loading recommendations" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="aspect-[3/5] rounded-xl" />)}</div>
        : recsFailed ? <ErrorState title="Could not load recommendations" description={recsError?.message} onRetry={() => void refetchRecs()} />
        : !recommendationItems.length ? <div className="rounded-xl border border-border bg-surface"><EmptyState icon={<Sparkles className="h-5 w-5" />} title="No recommendations yet" description="Try Refresh picks, or browse Discover to find galleries and build your preferences." /></div>
        : <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">{recommendationItems.map((item, index) => {
          const key = `${item.source}:${item.galleryId}`;
          return <div key={key} className={cn('min-w-0 [&>article]:h-full', index >= 2 && 'hidden md:block')}><GalleryCard item={item} onOpen={setSelected} onDownload={doStartDownload} downloadSetup={setup.status} starting={pendingKeys.has(key)} display="recommendation" ownership={{ type: inLibrary.has(key) ? 'in-library' : owned.has(key) ? 'downloaded' : possible.has(key) ? 'possible-duplicate' : 'available' }} /></div>;
        })}</div>}
    </section>

    <div className="grid min-w-0 items-stretch gap-6 xl:grid-cols-2">
      <section aria-labelledby="home-matches" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <SectionHeading id="home-matches" title="Galleries that can be matched" count={matches.data ? matchItems.length : undefined} description="New metadata candidates for your unmatched galleries.">
          <Button variant="outline" size="sm" disabled={scanning || scanNow.isPending || !matches.data?.configured} onClick={() => scanNow.mutate()}>{scanning || scanNow.isPending ? <Spinner /> : <Search aria-hidden="true" className="h-3.5 w-3.5" />}{scanning ? 'Scanning…' : 'Scan now'}</Button>
        </SectionHeading>
        <p className="mt-3 text-xs text-muted">{scanning ? (scan?.progressTotal ? `Checking ${scan.progressCurrent} of ${scan.progressTotal} galleries` : 'Checking your unmatched galleries…') : scan?.status === 'failed' ? 'Last scan failed. Retry with Scan now, or check Tasks for details.' : scan?.status === 'cancelled' ? 'Last scan cancelled. Scan again when you’re ready.' : scan?.finishedAt ? `Checked ${timeAgo(scan.finishedAt)} · Scans daily` : 'Scans daily · Candidates are reviewed before syncing'}</p>
        {scanning && <ProgressBar className="mt-3" label="Matching scan progress" value={scan?.progressCurrent ?? 0} max={scan?.progressTotal ?? 0} active />}
        {scan?.status === 'completed' && !!(scan.result as { failed?: number } | null)?.failed && <p className="mt-2 text-xs text-warning">Some providers could not be checked. <Link to="/jobs" className="underline underline-offset-4">View scan details</Link></p>}
        {matches.isPending ? <LoadingRows /> : matches.isError ? <ErrorState title="Could not load matching candidates" description={matches.error.message} onRetry={() => void matches.refetch()} />
          : !matches.data.configured ? <div className="py-8 text-center"><p className="text-sm text-muted">Connect Kavita to discover matches for your library.</p><SectionLink to="/settings?tab=general#kavita-connection">Connect Kavita</SectionLink></div>
          : !matchItems.length ? <EmptyState icon={<Link2 className="h-5 w-5" />} title={scanning ? 'Looking for candidates' : 'No matching candidates yet'} description={scanning ? 'You can keep browsing while the scan runs.' : 'Use Scan now to check your unmatched galleries. Rejected candidates stay hidden; different candidates can appear later.'} />
          : <><ul className="mt-4 divide-y divide-border">{matchItems.slice((currentMatchPage - 1) * 4, currentMatchPage * 4).map(item => <li key={item.seriesId} className="flex min-w-0 gap-3 py-4">
            <button type="button" onClick={() => setReview(item)} className="h-20 w-14 shrink-0 overflow-hidden rounded-md" aria-label={`Review match for ${item.name}`}><Cover url={item.cover ?? item.candidate.coverUrl} title={item.name} className="h-full w-full" /></button>
            <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-1 break-words text-xs text-muted">{item.libraryName}</p><p className="mt-2 break-words text-xs"><span className="font-medium text-success">{Math.round(item.candidate.score * 100)}% match</span><span className="text-muted"> · {PROVIDER_NAMES[item.candidate.providerId] ?? item.candidate.providerId} · {item.candidate.title}</span></p>
              <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => setReview(item)}>Review match<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" disabled={rejectedIds.has(item.seriesId)} onClick={() => void reject(item)}>{rejectedIds.has(item.seriesId) ? <Spinner /> : <X aria-hidden="true" className="h-3.5 w-3.5" />}No match found</Button></div>
            </div>
          </li>)}</ul><div className="mt-3"><Pager page={currentMatchPage} count={matchPageCount} onPageChange={setMatchPage} /></div></>}
      </section>

      <section aria-labelledby="home-inbox" className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <SectionHeading id="home-inbox" title="Unreviewed saved search results" count={feed.data?.inboxCount} description="New finds from your watched searches, ready to review."><SectionLink to="/downloader?tab=watched">Open inbox</SectionLink></SectionHeading>
        {feed.isPending ? <LoadingRows /> : feed.isError ? <ErrorState title="Could not load saved search results" description={feed.error.message} onRetry={() => void feed.refetch()} />
          : !discoveryItems.length ? <div><EmptyState icon={<Inbox className="h-5 w-5" />} title="Your inbox is clear" description="New results from saved searches will appear here. Review them at your own pace." /><div className="text-center"><SectionLink to="/downloader?tab=watched">Manage saved searches</SectionLink></div></div>
          : <ul className="mt-4 divide-y divide-border">{discoveryItems.map((item, index) => {
            const key = `${item.source}:${item.galleryId}`, meta = feed.data?.items[index];
            return <li key={key} className="flex min-w-0 gap-3 py-4"><button type="button" onClick={() => setSelected(item)} className="h-20 w-14 shrink-0 overflow-hidden rounded-md" aria-label={`View details for ${item.title}`}><Cover url={item.coverUrl} title={item.title} className="h-full w-full" /></button>
              <div className="min-w-0 flex-1"><button type="button" onClick={() => setSelected(item)} className="break-words text-left text-sm font-medium hover:text-primary">{item.title}</button><p className="mt-1 break-words text-xs text-muted">{item.artists.join(', ') || (item.source === 'hitomi' ? 'Hitomi.la' : 'nHentai')}{item.pageCount ? ` · ${item.pageCount} pages` : ''}</p><p className="mt-2 break-words text-xs text-muted">Via {meta?.query}</p>
                <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setSelected(item)}>View gallery<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" disabled={reviewingKeys.has(key)} onClick={() => void markReviewed(item)}>{reviewingKeys.has(key) ? <Spinner /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}Mark reviewed</Button></div>
              </div></li>;
          })}</ul>}
      </section>
    </div>

    <section aria-labelledby="home-activity" className="min-w-0 border-t border-border pt-6">
      <SectionHeading id="home-activity" title="Recent activity" description="Your latest matches, downloads, and library updates."><SectionLink to="/jobs">View tasks</SectionLink></SectionHeading>
      {activity.isPending ? <LoadingRows /> : activity.isError ? <ErrorState title="Could not load recent activity" description={activity.error.message} onRetry={() => void activity.refetch()} />
        : !activity.data.length ? <EmptyState icon={<History className="h-5 w-5" />} title="Your library’s story starts here" description="Match a gallery or complete a download to see it in your recent activity." />
        : <ul className="mt-4 grid gap-x-8 lg:grid-cols-2">{activity.data.map(item => <li key={item.id} className="flex min-w-0 items-start gap-3 border-b border-border py-3">
          <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', item.action === 'failed' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success')}>{item.action === 'downloaded' ? <Download aria-hidden="true" className="h-3.5 w-3.5" /> : item.action === 'failed' ? <X aria-hidden="true" className="h-3.5 w-3.5" /> : <Link2 aria-hidden="true" className="h-3.5 w-3.5" />}</span>
          <div className="min-w-0 flex-1"><Link to={item.href} className="break-words text-sm font-medium underline-offset-4 hover:text-primary hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center">{item.title}</Link><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted"><span>{activityLabels[item.action] ?? item.action}</span><time dateTime={toIsoUtc(item.createdAt)} title={new Date(toIsoUtc(item.createdAt)).toLocaleString()}>{timeAgo(item.createdAt)}</time></div></div>
        </li>)}</ul>}
    </section>
    {review && <CandidateReview key={review.seriesId} item={review} onClose={() => { setReview(null); void qc.invalidateQueries({ queryKey: ['home-matches'] }); }} />}
    {selected && <GalleryDetailModal item={selected} onClose={() => setSelected(null)} onDownload={() => void doStartDownload(selected)} checking={pendingKeys.has(`${selected.source}:${selected.galleryId}`)} downloaded={owned.has(`${selected.source}:${selected.galleryId}`) || inLibrary.has(`${selected.source}:${selected.galleryId}`)} inLibrary={inLibrary.has(`${selected.source}:${selected.galleryId}`)} setup={setup} onSearchTag={(fragment, source) => navigate(`/downloader?tab=search&source=${source ?? selected.source}&q=${encodeURIComponent(fragment)}`)} />}
    {duplicateDialog}
  </div>;
}
