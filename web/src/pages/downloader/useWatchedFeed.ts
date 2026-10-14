import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DoujinSearchResult } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { DownloaderTab } from './state';
export function useWatchedFeed(tab: DownloaderTab, onReviewed: (keys: Set<string>) => void) {
  const [feedView, setFeedView] = React.useState<'inbox' | 'history'>('inbox');
  const [feedSource, setFeedSource] = React.useState('');
  const [feedWatch, setFeedWatch] = React.useState('');
  const [feedPage, setFeedPage] = React.useState(1);
  const WATCH_PAGE_SIZE = 12;
  const { data: galleryFeed, isFetching: feedLoading, isError: feedFailed, error: feedError, refetch: retryFeed } = useQuery({
    queryKey: ['watched-gallery-feed', feedView, feedSource, feedWatch, feedPage],
    queryFn: () => api.watchedGalleryFeed({ view: feedView, source: feedSource, searchId: feedWatch, offset: (feedPage - 1) * WATCH_PAGE_SIZE, limit: WATCH_PAGE_SIZE }),
    enabled: tab === 'watched',
    refetchInterval: 60_000 });
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
  const reviewDiscoveries = React.useCallback(async (items: DoujinSearchResult[], reviewed: boolean) => {
    const keys = items.map(item => `${item.source}:${item.galleryId}`);
    if (!keys.length || keys.some(key => reviewingKeys.has(key))) return;
    setReviewingKeys(current => new Set([...current, ...keys]));
    try {
      await api.reviewWatchedGalleries(items.map(({ source, galleryId }) => ({ source, galleryId })), reviewed);
      const handled = new Set(keys);
      onReviewed(handled);
      await qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update Inbox', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setReviewingKeys(current => new Set([...current].filter(key => !keys.includes(key))));
    }
  }, [qc, reviewingKeys, onReviewed]);
  const reviewGallery = React.useCallback((item: DoujinSearchResult, reviewed: boolean) => { void reviewDiscoveries([item], reviewed); }, [reviewDiscoveries]);
  return { feedView, setFeedView, feedSource, setFeedSource, feedWatch, setFeedWatch, feedPage, setFeedPage, galleryFeed, feedLoading, feedFailed, feedError, retryFeed, feedItems, knownDiscoveries, feedMetaByKey, feedPageCount, feedCurPage, feedPageItems, reviewingKeys, reviewDiscoveries, reviewGallery };
}
