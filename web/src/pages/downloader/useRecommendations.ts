import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DoujinSearchResult, type FeedbackRequest } from '../../lib/api';
import { recommendationQuery } from '../../lib/recommendationQuery';
import { toast } from '../../lib/toast';
import type { DownloaderTab } from './state';

export function useRecommendations(tab: DownloaderTab) {
  const qc = useQueryClient();
  const { data: recs, isFetching: recsLoading, isError: recsFailed, error: recsError, refetch: refetchRecs } = useQuery({
    ...recommendationQuery,
    // App owns the initial load. This observer only reads the shared snapshot;
    // a failed first load retries only when the user chooses Retry.
    enabled: false });
  const [recsRefreshing, setRecsRefreshing] = React.useState(false);
  async function doRefreshRecs() {
    setRecsRefreshing(true);
    try {
      const refreshed = await api.refreshRecommendations();
      qc.setQueryData(['recommendations'], refreshed);
      toast({ tone: 'success', title: 'Fresh picks ready' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not refresh recommendations', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecsRefreshing(false);
    }
  }

  const ownedKeys = React.useMemo(
    () => new Set(recs?.ownedKeys ?? []),
    [recs],
  );
  const visibleRecs = recs?.items ?? [];
  const [dismissedGalleries, setDismissedGalleries] = React.useState<DoujinSearchResult[]>([]);
  const [feedbackPending, setFeedbackPending] = React.useState<string | null>(null);
  const [feedbackItem, setFeedbackItem] = React.useState<DoujinSearchResult | null>(null);
  const feedbackQuery = useQuery({ queryKey: ['recommendation-feedback'], queryFn: api.recommendationFeedback, enabled: tab === 'recommend' });
  const updateFeedback = React.useCallback(async (request: FeedbackRequest) => {
    setFeedbackPending(`${request.source}:${request.galleryId}`);
    try {
      const result = await api.saveRecommendationFeedback(request);
      qc.setQueryData(['recommendation-feedback'], result.feedback);
      qc.setQueryData(['recommendations'], result.recommendations);
      setFeedbackItem(null);
      const title = { like: 'More like this saved', unlike: 'Preference removed', 'mute-artist': 'Artist muted', 'unmute-artist': 'Artist unmuted' }[request.action];
      toast({ tone: 'success', title, description: request.action === 'like' || request.action === 'unlike' ? 'Refresh picks to use your updated preferences.' : undefined });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save recommendation feedback', description: error instanceof Error ? error.message : String(error) });
    } finally { setFeedbackPending(null); }
  }, [qc]);
  const doDismissGallery = React.useCallback(async (item: DoujinSearchResult) => {
    const key = `${item.source}:${item.galleryId}`;
    setFeedbackPending(key);
    try {
      const replacement = await api.dismissGallery({ source: item.source, galleryId: item.galleryId });
      qc.setQueryData(['recommendations'], replacement);
      setDismissedGalleries((current) => [...current.filter((gallery) => `${gallery.source}:${gallery.galleryId}` !== key), item]);
      setFeedbackItem(null);
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not dismiss gallery', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFeedbackPending(null);
    }
  }, [qc]);
  async function undoDismissGallery(item: DoujinSearchResult) {
    const key = `${item.source}:${item.galleryId}`;
    setFeedbackPending(key);
    try {
      const replacement = await api.undoDismissGallery({ source: item.source, galleryId: item.galleryId });
      qc.setQueryData(['recommendations'], replacement);
      setDismissedGalleries((current) => current.filter((gallery) => `${gallery.source}:${gallery.galleryId}` !== key));
      toast({ tone: 'success', title: 'Dismissal undone', description: 'This gallery can be recommended again.' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not undo dismissal', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFeedbackPending(null);
    }
  }

  // Which Kavita libraries feed the recommendation profile (per-library opt-out).
  const { data: recLibs } = useQuery({ queryKey: ['recommendation-libraries'], queryFn: api.recommendationLibraries, enabled: tab === 'recommend' });
  const { data: recSettings, refetch: refetchRecSettings } = useQuery({ queryKey: ['recommendation-settings'], queryFn: api.recommendationSettings, enabled: tab === 'recommend' });
  const [recLibraryPending, setRecLibraryPending] = React.useState<number | null>(null);
  async function toggleRecLibrary(lib: { id: number; name: string }) {
    setRecLibraryPending(lib.id);
    const excluded = new Set(recSettings?.excludedLibraryIds ?? []);
    if (excluded.has(lib.id)) excluded.delete(lib.id);
    else excluded.add(lib.id);
    try {
      await api.saveRecommendationSettings({ excludedLibraryIds: [...excluded] });
      await refetchRecSettings();
      toast({ tone: 'success', title: `“${lib.name}” ${excluded.has(lib.id) ? 'excluded from' : 'added to'} recommendations`, description: 'This applies to your next daily picks or when you choose Refresh picks.' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not update libraries', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecLibraryPending(null);
    }
  }

  return { recs, recsLoading, recsFailed, recsError, refetchRecs, recsRefreshing, doRefreshRecs, ownedKeys, visibleRecs, dismissedGalleries, feedbackPending, feedbackItem, setFeedbackItem, feedbackQuery, updateFeedback, doDismissGallery, undoDismissGallery, recLibs, recSettings, recLibraryPending, toggleRecLibrary };
}
