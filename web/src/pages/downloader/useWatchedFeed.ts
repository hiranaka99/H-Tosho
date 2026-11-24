import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DoujinSearchResult } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { DownloaderTab } from './state';
export function useWatchedFeed(tab: DownloaderTab, onReviewed: (keys: Set<string>) => void) {
  const [feedView, setFeedView] = React.useState<'inbox' | 'history'>('inbox');
  const [feedSource, setFeedSource] = React.useState('');
  const [feedWatch, setFeedWatch] = React.useState('');
  const [feedFolder, setFeedFolder] = React.useState('');
  const foldersQuery = useQuery({ queryKey: ['watched-search-folders'], queryFn: api.watchedSearchFolders, enabled: tab === 'watched', staleTime: 30_000 });
  React.useEffect(() => {
    if (foldersQuery.isSuccess && feedFolder && feedFolder !== 'unfiled' && !foldersQuery.data.some(folder => String(folder.id) === feedFolder)) {
      setFeedFolder(''); setFeedWatch(''); setFeedPage(1);
    }
  }, [foldersQuery.data, foldersQuery.isSuccess, feedFolder]);
  const [feedPage, setFeedPage] = React.useState(1);
  const WATCH_PAGE_SIZE = 12;
  const { data: galleryFeed, isFetching: feedLoading, isSuccess: feedSucceeded, isError: feedFailed, error: feedError, refetch: retryFeed } = useQuery({
    queryKey: ['watched-gallery-feed', feedView, feedSource, feedWatch, feedFolder, feedPage],
    queryFn: () => api.watchedGalleryFeed({ view: feedView, source: feedSource, searchId: feedWatch ? Number(feedWatch) : undefined, folderId: feedFolder === 'unfiled' ? 'unfiled' : feedFolder ? Number(feedFolder) : undefined, offset: (feedPage - 1) * WATCH_PAGE_SIZE, limit: WATCH_PAGE_SIZE }),
    enabled: tab === 'watched',
    refetchInterval: 60_000 });
  // The Watch filter only offers watches the other filters can still match.
  const feedWatches = React.useMemo(() => {
    if (!galleryFeed) return undefined;
    const bySource = feedSource ? galleryFeed.watches.filter(watch => watch.source === feedSource) : galleryFeed.watches;
    if (!feedFolder) return bySource;
    if (feedFolder === 'unfiled') return bySource.filter(watch => watch.folderId === null || watch.removed);
    const folderId = Number(feedFolder);
    return bySource.filter(watch => watch.folderId === folderId && !watch.removed);
  }, [galleryFeed, feedFolder, feedSource]);
  const filtersActive = Boolean(feedWatch || feedSource || feedFolder);
  const clearFilters = React.useCallback(() => { setFeedWatch(''); setFeedSource(''); setFeedFolder(''); setFeedPage(1); }, []);
  React.useEffect(() => {
    if (!feedSucceeded || feedLoading || !feedWatch || !feedWatches) return;
    const watchId = Number(feedWatch);
    if (!feedWatches.some(watch => watch.id === watchId)) {
      setFeedWatch('');
      setFeedPage(1);
    }
  }, [feedSucceeded, feedLoading, feedWatch, feedWatches]);
  const feedItems = React.useMemo<DoujinSearchResult[]>(() => (galleryFeed?.items ?? []).map(g => ({ source: g.source, galleryId: g.galleryId, title: g.title, coverUrl: g.coverUrl ?? undefined, pageCount: g.pageCount, tags: [], artists: g.artists ?? [], language: g.language })), [galleryFeed]);
  const knownDiscoveries = React.useRef(new Set<string>());
  React.useEffect(() => { for (const item of feedItems) knownDiscoveries.current.add(`${item.source}:${item.galleryId}`); }, [feedItems]);
  const feedMetaByKey = new Map((galleryFeed?.items ?? []).map(g => [`${g.source}:${g.galleryId}`, g]));
  const feedPageCount = Math.max(1, Math.ceil((galleryFeed?.total ?? 0) / WATCH_PAGE_SIZE));
  const feedCurPage = Math.min(feedPage, feedPageCount);
  React.useEffect(() => { if (galleryFeed && feedPage > feedPageCount) setFeedPage(feedPageCount); }, [galleryFeed, feedPage, feedPageCount]);
  const feedPageItems = feedItems;
  const [reviewingKeys, setReviewingKeys] = React.useState(new Set<string>());

  // Daily recommendations: stable per local date (server caches the day's set),
  // so no polling — a manual refresh re-rolls with a fresh seed.
  const qc = useQueryClient();
  const latestReview = React.useRef<(items: DoujinSearchResult[], reviewed: boolean) => Promise<void>>(async () => undefined);
  const reviewDiscoveries = React.useCallback(async (items: DoujinSearchResult[], reviewed: boolean) => {
    const keys = items.map(item => `${item.source}:${item.galleryId}`);
    if (!keys.length || keys.some(key => reviewingKeys.has(key))) return;
    setReviewingKeys(current => new Set([...current, ...keys]));
    try {
      await api.reviewWatchedGalleries(items.map(({ source, galleryId }) => ({ source, galleryId })), reviewed);
      const handled = new Set(keys);
      onReviewed(handled);
      await qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
      // Dismiss is one keystroke away from a mistake; every dismissal can be taken back.
      if (reviewed) toast({
        tone: 'info',
        title: items.length === 1 ? 'Dismissed' : `Dismissed ${items.length} finds`,
        description: items.length === 1 ? `“${items[0].title}” moved out of Inbox. It stays in All finds.` : 'They moved out of Inbox and stay in All finds.',
        action: { label: 'Undo', onClick: () => void latestReview.current(items, false) },
      });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update Inbox', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setReviewingKeys(current => new Set([...current].filter(key => !keys.includes(key))));
    }
  }, [qc, reviewingKeys, onReviewed]);
  React.useEffect(() => { latestReview.current = reviewDiscoveries; }, [reviewDiscoveries]);
  const reviewGallery = React.useCallback((item: DoujinSearchResult, reviewed: boolean) => { void reviewDiscoveries([item], reviewed); }, [reviewDiscoveries]);
  return { filtersActive, clearFilters, feedView, setFeedView, feedSource, setFeedSource, feedWatch, setFeedWatch, feedFolder, setFeedFolder, foldersQuery, feedPage, setFeedPage, galleryFeed, feedWatches, feedLoading, feedFailed, feedError, retryFeed, feedItems, knownDiscoveries, feedMetaByKey, feedPageCount, feedCurPage, feedPageItems, reviewingKeys, reviewDiscoveries, reviewGallery };
}
