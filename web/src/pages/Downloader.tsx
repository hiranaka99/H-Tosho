import { useGallerySelection, resolveGallerySelection } from './downloader/useGallerySelection';
import { useWatchedFeed } from './downloader/useWatchedFeed';
import { useRecommendations } from './downloader/useRecommendations';
import { gallerySearchReducer } from './downloader/searchState';
import { GallerySearchInput } from '../components/GallerySearchInput';
import { useGalleryDownload } from './downloader/useGalleryDownload';
import * as React from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Search, Loader2, RotateCcw, CheckCircle2, Compass, Sparkles, CheckSquare, Settings2, Inbox, CheckCheck, FunnelX, Plus } from 'lucide-react';
import { api, type DoujinSource, type DoujinSort, type DoujinSearchResult } from '../lib/api';
import type { WatchedSearch } from '../../../server/src/contracts/following';
import { cn } from '../lib/utils';
import { downloadErrorHelp } from '../lib/downloadErrors';
import { toast } from '../lib/toast';
import { useDownloadSummary } from '../lib/DownloadsContext';
import { Button, Card, CardContent, Badge, Select, EmptyState, Spinner, PageHeader, SegmentedTabs, SegmentedControl, TabPanel, Disclosure, ErrorState, Pager } from '../components/ui';
const MergeIntoSeriesDialog = React.lazy(() => import('../components/MergeIntoSeriesDialog').then((m) => ({ default: m.MergeIntoSeriesDialog })));
import { GalleryFeedbackDialog, RecommendationFeedbackManager } from '../components/RecommendationFeedback';
import { GallerySelectionBar, type GallerySelectionActions } from '../components/GallerySelectionBar';
import { switchProviderSearch, type TranslationLink } from '../lib/searchTranslation';

import { FALLBACK_SOURCES, SOURCE_COLORS, SOURCE_LABELS, sortsFor, readDownloaderState, writeDownloaderState, type DownloaderTab, type DownloaderStateCache, type SearchScope } from './downloader/state';
import { DownloadDestination } from './downloader/DownloadSetup';
import { GalleryCard } from './downloader/GalleryCard';
const GalleryDetailModal = React.lazy(() => import('./downloader/GalleryDetailModal').then((m) => ({ default: m.GalleryDetailModal })));
const ManagerTab = React.lazy(() => import('./downloader/DownloadManager').then((m) => ({ default: m.ManagerTab })));
import { UnifiedSearchTab } from './downloader/UnifiedSearchTab';
import { SearchResultsHeader, SelectModeButton, WatchSearchButton } from './downloader/SearchResultsHeader';
import { useUnifiedSearch, toWebResult } from './downloader/useUnifiedSearch';
import { WatchedManagerDrawer, FollowingCheckStatus, nextScheduledCheck, formatCheckTime } from './downloader/WatchedSearchControls';
import { SearchHint } from './downloader/SearchHint';
import { SearchFailure } from './downloader/SearchFailure';
import { GallerySkeletonGrid } from './downloader/GallerySkeletons';
import { galleryKey, galleryOwnership } from './downloader/ownership';
import { folderNameFrom } from '../lib/mergeNames';
import type { MergeDownloadResult } from './downloader/MergeDownloadDialog';
const MergeDownloadDialog = React.lazy(() => import('./downloader/MergeDownloadDialog').then((m) => ({ default: m.MergeDownloadDialog })));
import { useDownloaderTransitions } from './downloader/motion';
import type { UnifiedSearchEntry } from '../lib/api';
const RESULTS_PAGE_SIZE = 25;
const EMPTY_GALLERIES: DoujinSearchResult[] = [];

/** One edition group's selectable variant (the stable primary unless `key` names another). */
function webVariant(entry: UnifiedSearchEntry, key: string | null): DoujinSearchResult {
  const variant = (key ? entry.variants.find((v) => `${v.source}:${v.galleryId}` === key) : undefined) ?? entry.variants[0];
  if (!variant) return toWebResult(entry.primary);
  return {
    source: variant.source,
    galleryId: variant.galleryId,
    title: variant.title,
    coverUrl: variant.coverUrl,
    tags: [],
    artists: variant.artists,
    language: variant.language,
    pageCount: variant.pageCount,
    uploadedAt: variant.uploadedAt,
    url: variant.url ?? undefined,
  };
}
/** Every gallery key an edition group can be selected by. */
const entryKeys = (entry: UnifiedSearchEntry) => [`${entry.primary.source}:${entry.primary.galleryId}`, ...entry.variants.map((v) => `${v.source}:${v.galleryId}`)];
const sameWatch = (watch: WatchedSearch, target: { source: DoujinSource; query: string }) => watch.source === target.source && watch.query === target.query;
export function Downloader() {
  const qc = useQueryClient();
  // Search cards consume live tasks so each doujin reflects queued, downloading,
  // or paused state. Deep links from the Libraries page override cached search
  // state; ordinary navigation restores the last input, committed search, and
  // result page.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialState = React.useMemo(readDownloaderState, []);
  const initialSearches = React.useMemo(() => {
    const previousSource = initialState.source ?? 'hitomi';
    return {
      [previousSource]: { query: initialState.query ?? '', searchKey: initialState.searchKey ?? null, sort: initialState.sort ?? 'default' },
      ...initialState.searches,
    };
  }, [initialState]);
  const linkedQuery = searchParams.get('q');
  const initialSource = React.useMemo<DoujinSource>(() => {
    const requested = searchParams.get('source');
    if (requested && SOURCE_COLORS[requested as DoujinSource]) return requested as DoujinSource;
    return initialState.source && SOURCE_COLORS[initialState.source] ? initialState.source : 'hitomi';
  }, []);

  // One Search tab: 'all' fans out to every source, a provider id searches just
  // that source (with its own sort and Watch). Deep links pin their source.
  const [scope, setScope] = React.useState<SearchScope>(() => {
    if (linkedQuery !== null) return initialSource;
    if (searchParams.get('tab') === 'unified') return 'all';
    return initialState.scope === 'all' || (initialState.scope && SOURCE_COLORS[initialState.scope]) ? initialState.scope : 'all';
  });

  // The server reports the registered doujin providers; the radio list follows
  // it so new sources appear without UI changes (static fallback while loading).
  const { data: providerList } = useQuery({ queryKey: ['doujin-providers'], queryFn: api.doujinProviders, staleTime: Infinity });
  const sources = React.useMemo(
    () => (providerList && providerList.length > 0 ? providerList.map((p) => ({ id: p.id, label: p.name })) : FALLBACK_SOURCES),
    [providerList],
  );
  const [searchState, dispatchSearch] = React.useReducer(gallerySearchReducer, undefined, () => {
    const saved = initialSearches[initialSource];
    return { source: initialSource, query: linkedQuery ?? saved?.query ?? '',
      searchKey: linkedQuery !== null ? linkedQuery.trim() || null : saved?.searchKey?.trim() || null,
      sort: sortsFor(initialSource).some(option => option.value === saved?.sort) ? saved!.sort : 'default' };
  });
  const { source, query, searchKey, sort } = searchState;
  const setQuery = (query: string) => dispatchSearch({ type: 'input', query });
  const setSearchKey = (query: string) => dispatchSearch({ type: 'commit', query });
  const setSort = (sort: DoujinSort) => dispatchSearch({ type: 'sort', sort });
  const searches = React.useRef<DownloaderStateCache['searches']>(initialSearches);
  const translation = React.useRef<TranslationLink | null>(linkedQuery === null ? initialState.translation ?? null : null);
  const [translationNotice, setTranslationNotice] = React.useState<{ query: string; issues: string[] } | null>(() => {
    const saved = translation.current;
    return saved?.to === source ? { query: saved.output.query, issues: saved.issues } : null;
  });
  function rememberSearch() {
    searches.current = { ...searches.current, [source]: { query, searchKey, sort } };
  }
  const deepLink = JSON.stringify([searchParams.get('source'), linkedQuery]);
  const previousDeepLink = React.useRef(deepLink);
  React.useEffect(() => {
    if (deepLink === previousDeepLink.current) return;
    previousDeepLink.current = deepLink;
    const linkedSource = searchParams.get('source');
    const nextSource = linkedSource && SOURCE_COLORS[linkedSource as DoujinSource] ? linkedSource as DoujinSource : source;
    const nextQuery = searchParams.get('q');
    if (nextQuery === null) return;
    const trimmed = nextQuery.trim();
    rememberSearch();
    translation.current = null;
    setTranslationNotice(null);
    dispatchSearch({ type: 'replace', state: { source: nextSource, query: nextQuery, searchKey: trimmed || null, sort: sortsFor(nextSource).some(option => option.value === sort) ? sort : 'default' } });
    setScope(nextSource);
    setSelected(null);
  }, [deepLink, searchParams, source]);
  const [selected, setSelected] = React.useState<DoujinSearchResult | null>(null);

  // Unified search (all sources at once). State is isolated from native
  // per-source searches and only runs while its tab is visible.
  const [unifiedSelectedEntry, setUnifiedSelectedEntry] = React.useState<UnifiedSearchEntry | null>(null);
  const [unifiedVariantKey, setUnifiedVariantKey] = React.useState<string | null>(null);

  // Multi-select mode for merged downloads (mirrors the Libraries page). One
  // selection, keyed `${source}:${galleryId}`, serves every scope and tab and
  // survives new searches, so a shortlist can be built across several queries.
  // Click order defines chapter numbering for merges.
  const [selectMode, setSelectMode] = React.useState(false);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [mergePending, setMergePending] = React.useState(false);
  const mergePendingRef = React.useRef(false);
  const [mergeItems, setMergeItems] = React.useState<DoujinSearchResult[]>([]);
  const [mergeResult, setMergeResult] = React.useState<MergeDownloadResult | null>(null);
  const [selectionHeight, setSelectionHeight] = React.useState(0);
  const [mergeIntoOpen, setMergeIntoOpen] = React.useState(false);

  const { setup, checkDuplicates, duplicateDialog, ensureDownloadReady, pendingKeys, doStartDownload } = useGalleryDownload();
  // Failures win the Downloads tab count (red); otherwise it shows what is moving.
  const downloadSummary = useDownloadSummary();
  const downloadStatus = setup.status;
  // Top-of-page view tabs: search results vs. the download manager queue.
  const [rememberedTab, setRememberedTab] = React.useState<DownloaderTab>(() =>
    ['recommend', 'watched', 'manager'].includes(initialState.tab ?? '') ? initialState.tab as DownloaderTab : 'search');
  const requestedTab = searchParams.get('tab');
  const tab: DownloaderTab = requestedTab === 'downloads' ? 'manager'
    : requestedTab === 'recommend' || requestedTab === 'watched' ? requestedTab
    : requestedTab !== null || linkedQuery !== null ? 'search' : rememberedTab;
  const searchAll = tab === 'search' && scope === 'all';
  const searchNative = tab === 'search' && scope !== 'all';
  // The retired ?tab=unified link opens Search scoped to every source.
  const wantsUnified = requestedTab === 'unified';
  React.useEffect(() => { if (wantsUnified) setScope('all'); }, [wantsUnified]);
  const unified = useUnifiedSearch(searchAll);
  React.useEffect(() => {
    setRememberedTab(tab);
    writeDownloaderState({ tab });
  }, [tab]);
  React.useEffect(() => { writeDownloaderState({ scope }); }, [scope]);
  const setTab = (next: DownloaderTab) => {
    setRememberedTab(next);
    writeDownloaderState({ tab: next });
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('tab', next === 'manager' ? 'downloads' : next);
      return params;
    }, { replace: true });
  };
  const searchIdentity = JSON.stringify([source, searchKey, sort]);
  const [pagination, setPagination] = React.useState(() => ({ identity: searchIdentity, page: linkedQuery !== null ? 1 : Math.max(1, initialState.page ?? 1) }));
  const page = pagination.identity === searchIdentity ? pagination.page : 1;
  const setPage = (next: number) => setPagination({ identity: searchIdentity, page: next });
  const { data: searchResponse, isFetching, isError: searchFailed, error: searchError, refetch: retrySearch } = useQuery({
    queryKey: ['doujin-search', source, searchKey, sort, page],
    queryFn: () => api.doujinSearchPage(source, searchKey!, (page - 1) * RESULTS_PAGE_SIZE, RESULTS_PAGE_SIZE, sort),
    enabled: searchNative && searchKey !== null && searchKey.trim().length > 0,
    // Refocusing the window must not re-scrape Hitomi/nHentai, and while a new
    // search loads the grid keeps the previous results instead of blanking.
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  // The previous grid stays mounted while a new query loads; it is dimmed and inert until then.
  const showingStaleResults = searchNative && isFetching && !!searchResponse;
  const results = searchResponse?.items;
  const pageItems = results ?? EMPTY_GALLERIES;

  // Galleries with a completed download task — powers the duplicate badges.
  // The downloads context invalidates this key when a task completes.
  const { data: completed } = useQuery({
    queryKey: ['downloads-completed'],
    queryFn: api.downloadsCompleted,
  });
  const downloadedAt = React.useMemo(
    () => new Map((completed ?? []).map((k) => [`${k.source}:${k.galleryId}`, k.finishedAt])),
    [completed],
  );

  // Saved watches correspond to the committed search represented by the visible
  // results, never to edits that have not been submitted yet.
  const { data: watches, refetch: refetchWatches } = useQuery({
    queryKey: ['watched-searches'],
    queryFn: api.watchedSearches,
    // toggleWatch refetches after add/remove and the cache survives tab
    // switches — no polling, and no fetch while neither view needs it.
    enabled: tab === 'search' || tab === 'watched',
  });
  const watchedQuery = searchKey?.trim() ?? '';
  const currentWatch = (watches ?? []).find((w) => sameWatch(w, { source, query: watchedQuery }));
  // The account view (never secrets) gates the E-Hentai empty state: an
  // unconfigured account gets a settings pointer instead of a dead search.
  const ehAccount = useQuery({ queryKey: ['ehentai-account'], queryFn: api.ehentaiAccount, staleTime: 30_000, enabled: searchNative && source === 'ehentai' });

  // Watch follows one search on every source it can: the single source in
  // single-source scope, or each followable lane's own query in All sources.
  const [watchPending, setWatchPending] = React.useState(false);
  async function toggleWatches(targets: { source: DoujinSource; query: string }[], label: string) {
    if (!targets.length || watchPending) return;
    const existing = targets.map((t) => (watches ?? []).find((w) => sameWatch(w, t)));
    const watchingAll = existing.every(Boolean);
    const where = targets.map((t) => SOURCE_LABELS[t.source]).join(' and ');
    setWatchPending(true);
    try {
      if (watchingAll) {
        for (const watch of existing) if (watch) await api.removeWatchedSearch(watch.id, watch.revision);
        toast({ tone: 'info', title: 'Unwatched', description: `“${label}” on ${where} will no longer be checked.` });
      } else {
        for (const [i, target] of targets.entries()) if (!existing[i]) await api.addWatchedSearch(target.source, target.query);
        toast({ tone: 'success', title: 'Watching search', description: `New finds for “${label}” on ${where} appear in Following. Discord notifications depend on your settings.`, action: { label: 'Open Following', onClick: () => setTab('watched') } });
      }
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not update watches', description: e instanceof Error ? e.message : String(e) });
    } finally {
      await refetchWatches().catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
      setWatchPending(false);
    }
  }

  // The Following tab label carries the unreviewed count even while another tab is open.
  const { data: inboxCount } = useQuery({
    queryKey: ['watched-gallery-feed', 'inbox-count'],
    queryFn: () => api.watchedGalleryFeed({ view: 'inbox', offset: 0, limit: 1 }),
    select: feed => feed.inboxCount,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const [manageWatchesOpen, setManageWatchesOpen] = React.useState(false);
  const manageWatchesTrigger = React.useRef<HTMLElement | null>(null);
  const openManageWatches = () => { manageWatchesTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setManageWatchesOpen(true); };
  const selection = useGallerySelection();
  const { filtersActive, clearFilters, feedView, setFeedView, feedSource, setFeedSource, feedWatch, setFeedWatch, feedFolder, setFeedFolder, foldersQuery, setFeedPage, galleryFeed, feedWatches, feedLoading, feedFailed, feedError, retryFeed, feedItems, knownDiscoveries, feedMetaByKey, feedPageCount, feedCurPage, feedPageItems, reviewingKeys, reviewDiscoveries, reviewGallery } = useWatchedFeed(tab, selection.remove);
  const selectionView = React.useMemo(() => resolveGallerySelection(selection.chosen, results ?? EMPTY_GALLERIES, feedItems, knownDiscoveries.current), [selection.chosen, results, feedItems, knownDiscoveries]);
  const selectedGalleries = selection.keys, selectedItems = selectionView.items, reviewableSelectedItems = selectionView.reviewable;
  const toggleGallerySelect = selection.toggle;
  const { recs, recsLoading, recsFailed, recsError, refetchRecs, recsRefreshing, doRefreshRecs, ownedKeys, visibleRecs, dismissedGalleries, feedbackPending, feedbackItem, setFeedbackItem, feedbackQuery, updateFeedback, doDismissGallery, undoDismissGallery, recLibs, recSettings, recLibraryPending, toggleRecLibrary } = useRecommendations(tab);

  React.useEffect(() => {
    // Debounced so typing a long query does not serialize to sessionStorage on
    // every keystroke; the timer resets per change and clears on unmount.
    const t = window.setTimeout(() => {
      searches.current = { ...searches.current, [source]: { query, searchKey, sort } };
      writeDownloaderState({ source, query, searchKey, sort, page, searches: searches.current, translation: translation.current });
    }, 300);
    return () => window.clearTimeout(t);
  }, [source, query, searchKey, sort, page]);


  const openMergedDownload = React.useCallback((items: DoujinSearchResult[]) => {
    if (!items.length) return;
    // Snapshot click order so successful requests never shift remaining chapters.
    setMergeItems(items);
    setMergeResult(null);
    setMergeOpen(true);
  }, []);
  const [mergeIntoItems, setMergeIntoItems] = React.useState<DoujinSearchResult[] | null>(null);
  const openMergeInto = React.useCallback((items: DoujinSearchResult[]) => {
    if (!items.length) return;
    setMergeIntoItems(items);
    setMergeIntoOpen(true);
  }, []);
  const clearSelection = selection.clear;
  const cancelSelection = React.useCallback(() => { selection.clear(); setSelectMode(false); }, [selection.clear]);

  // ---------------- unified search selection ----------------
  // An edition group is selected when any of its variants is; selecting it
  // snapshots the stable primary. Picking a variant in the detail modal
  // re-points that group in place, so click order (merge chapters) holds.
  const toggleGroupSelection = selection.toggleGroup;
  const toggleUnifiedGroup = React.useCallback((entry: UnifiedSearchEntry) => toggleGroupSelection(entryKeys(entry), webVariant(entry, null)), [toggleGroupSelection]);
  const unifiedSelectedIds = React.useMemo(
    () => new Set(unified.entries.filter((e) => entryKeys(e).some((k) => selection.keys.has(k))).map((e) => e.entryId)),
    [unified.entries, selection.keys],
  );
  const unifiedCommittedRef = React.useRef(unified.committed);
  React.useEffect(() => {
    if (unifiedCommittedRef.current === unified.committed) return;
    unifiedCommittedRef.current = unified.committed;
    setUnifiedSelectedEntry(null);
    setUnifiedVariantKey(null);
  }, [unified.committed]);
  function unifiedOwnership(entry: UnifiedSearchEntry) {
    // Every variant is inspected, but only exact source+galleryId matches claim ownership.
    const primaryKey = `${entry.primary.source}:${entry.primary.galleryId}`;
    const variantKeys = entry.variants.map((v) => `${v.source}:${v.galleryId}`).filter((k) => k !== primaryKey);
    return galleryOwnership([primaryKey, ...variantKeys], libraryMatches, downloadedAt, ownedKeys);
  }

  const showSelection = (tab === 'search' || tab === 'recommend' || tab === 'watched') && (selectMode || selectedGalleries.size > 0);
  // Queue each chosen gallery on its own, one at a time so duplicate reviews never stack up.
  const downloadingEach = React.useRef(false);
  async function downloadEach(items: DoujinSearchResult[]) {
    if (!items.length || downloadingEach.current || !ensureDownloadReady()) return;
    downloadingEach.current = true;
    try {
      for (const item of items) await doStartDownload(item);
      selection.clear();
      setSelectMode(false);
    } finally {
      downloadingEach.current = false;
    }
  }
  // All sources selects whole edition groups; a group counts once whichever variant was picked.
  const pageSelectable: DoujinSearchResult[] = searchAll ? unified.entries.filter((e) => !unifiedSelectedIds.has(e.entryId)).map((e) => webVariant(e, null))
    : tab === 'search' ? pageItems : tab === 'recommend' ? visibleRecs : tab === 'watched' ? feedPageItems : EMPTY_GALLERIES;
  const selectionActions: GallerySelectionActions = {
    items: selectedItems,
    onDownloadEach: () => void downloadEach(selectedItems),
    onSelectAll: pageSelectable.length ? () => selection.addMany(pageSelectable) : undefined,
    allSelected: searchAll ? unified.entries.length > 0 && pageSelectable.length === 0 : pageSelectable.length > 0 && pageSelectable.every(item => selectedGalleries.has(galleryKey(item))),
    selectAllLabel: searchAll ? 'Select all loaded' : tab === 'recommend' ? 'Select all shown' : 'Select all on page',
    destination: <DownloadDestination setup={setup} />,
    onMerge: () => openMergedDownload(selectedItems),
    onMergeInto: () => openMergeInto(selectedItems),
    onRemove: toggleGallerySelect,
    onClear: clearSelection,
    onCancel: cancelSelection,
    // Following is a triage queue: dismissing a batch sits with the other batch actions.
    dismiss: tab === 'watched' ? {
      label: reviewableSelectedItems.length === selectedItems.length ? 'Dismiss selected' : `Dismiss ${reviewableSelectedItems.length} in Inbox`,
      count: reviewableSelectedItems.length,
      pending: reviewingKeys.size > 0,
      onDismiss: () => void reviewDiscoveries(reviewableSelectedItems, true),
    } : undefined,
  };

  /** Queue only unfinished entries, keeping failed items and all merge inputs. */
  async function doMergedDownload(folder: string, numbers: (number | null)[]) {
    if (mergePendingRef.current || !ensureDownloadReady() || setup.format !== 'cbz') return;
    if (!mergeItems.length) return;
    mergePendingRef.current = true;
    setMergePending(true);
    const queuedKeys = [...(mergeResult?.queuedKeys ?? [])];
    const skippedKeys = [...(mergeResult?.skippedKeys ?? [])];
    const settled = new Set([...queuedKeys, ...skippedKeys]);
    const failures: MergeDownloadResult['failures'] = [];
    try {
      const approved = await checkDuplicates(mergeItems.filter(item => !settled.has(`${item.source}:${item.galleryId}`)));
      if (approved === null) return;
      const items = mergeItems.flatMap((item, i) => {
        const key = `${item.source}:${item.galleryId}`;
        return settled.has(key) ? [] : [{ source: item.source, galleryId: item.galleryId, url: item.url, chapter: numbers[i] ?? undefined, allowDuplicate: approved.has(key) }];
      });
      const result = await api.startMergedDownloads({ mergeFolder: folder, items });
      void qc.invalidateQueries({ queryKey: ['downloads'] });
      for (const item of result.items) {
        const key = `${item.source}:${item.galleryId}`;
        if (item.id !== undefined) {
          queuedKeys.push(key);
          settled.add(key);
        } else if (item.error === 'already-downloaded' || item.error === 'already-queued') {
          skippedKeys.push(key);
          settled.add(key);
        } else failures.push({ key, message: downloadErrorHelp(item.error ?? 'Could not queue download').message });
      }
      setMergeResult({ queuedKeys, skippedKeys, failures });
      selection.remove(settled);
      if (!failures.length) {
        setSelectMode(false);
        setMergeOpen(false);
        toast({
          tone: queuedKeys.length ? 'success' : 'info',
          title: queuedKeys.length ? 'Merged downloads queued' : 'Galleries already owned or queued',
          description: `${queuedKeys.length} queued${skippedKeys.length ? ` · ${skippedKeys.length} already owned or queued` : ''} → “${folder}”`,
        });
      }
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not check selected galleries', description: error instanceof Error ? error.message : String(error) });
    } finally {
      mergePendingRef.current = false;
      setMergePending(false);
    }
  }

  // Send native syntax verbatim; both providers apply the default English filter.
  function commitQuery(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setSearchKey(trimmed);
  }

  /**
   * Run a fresh search for a single tag/artist clicked in the details card.
   * Replaces the search bar with just that fragment and commits it immediately,
   * then closes the modal so the new results are visible. The fragment is built
   * for the gallery's own source, so jump to that source's search tab — the
   * details card also opens from the For you tab, where the active source
   * may be the other one.
   */
  function searchTagFragment(fragment: string, itemSource?: DoujinSource | 'all') {
    const trimmed = fragment.trim();
    if (!trimmed) return;
    if (itemSource === 'all') {
      // A shared filter from an All-sources result keeps searching every source.
      unified.setDraft(trimmed);
      unified.startSearch(trimmed);
      setScope('all');
      setTab('search');
      setSelected(null);
      setUnifiedSelectedEntry(null);
      return;
    }
    rememberSearch();
    translation.current = null;
    setTranslationNotice(null);
    const nextSource = itemSource ?? source;
    dispatchSearch({ type: 'replace', state: { source: nextSource, query: trimmed, searchKey: trimmed, sort: sortsFor(nextSource).some(option => option.value === sort) ? sort : 'default' } });
    setScope(nextSource);
    setTab('search');
    setSelected(null);
  }

  // Translate the active query on every switch; review losses before searching.
  function switchSource(next: DoujinSource) {
    if (next === source) return;
    rememberSearch();
    const translated = switchProviderSearch({ query, searchKey, sort }, source, next, translation.current);
    translation.current = translated.link;
    setTranslationNotice({ query: translated.search.query, issues: translated.issues });
    dispatchSearch({ type: 'replace', state: { ...translated.search, source: next } });
    // A consumed deep link must not overwrite the restored draft on refresh.
    setSearchParams(current => {
      const params = new URLSearchParams(current);
      params.delete('q');
      params.delete('source');
      return params;
    }, { replace: true });
  }

  /** Moving between scopes carries a typed-but-unsent query along instead of dropping it. */
  function changeScope(next: SearchScope) {
    if (next === scope) return;
    if (next === 'all') {
      if (!unified.draft.trim() && query.trim()) unified.setDraft(query.trim());
      setScope('all');
      return;
    }
    const carried = scope === 'all' && !query.trim() && unified.draft.trim() ? unified.draft : null;
    if (next !== source) switchSource(next);
    if (carried) setQuery(carried);
    setScope(next);
  }
  const scopeItems = React.useMemo(() => [{ id: 'all' as SearchScope, label: 'All sources' }, ...sources.map(item => ({ id: item.id as SearchScope, label: item.label }))], [sources]);

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    commitQuery(query);
  };

  const resultCount = searchResponse?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(resultCount / RESULTS_PAGE_SIZE));
  const curPage = Math.min(page, pageCount);

  function changePage(nextPage: number) {
    setPage(nextPage);
    document.querySelector('main')?.scrollTo({ top: 0 });
  }
  const matchItems = React.useMemo(
    () => (searchAll
      ? unified.entries.flatMap((e) => e.variants.map((v) => webVariant(e, `${v.source}:${v.galleryId}`)))
      : tab === 'search' ? pageItems : tab === 'recommend' ? visibleRecs : tab === 'watched' ? feedPageItems
      : []),
    [searchAll, unified.entries, tab, pageItems, visibleRecs, feedPageItems],
  );
  const matchItemsKey = React.useMemo(
    () => matchItems.map((item) => `${item.source}:${item.galleryId}`).join(','),
    [matchItems],
  );
  const matchQuery = useQuery({
    queryKey: ['gallery-library-matches', matchItemsKey],
    queryFn: () => api.libraryMatches(matchItems),
    enabled: matchItems.length > 0,
    staleTime: 60_000,
  });
  const libraryMatches = React.useMemo(() => new Map((matchQuery.data?.reports ?? []).map(report => [
    `${report.source}:${report.galleryId}`,
    report.matches.some(match => match.confirmed && ['In library', 'Owned', 'completed'].includes(match.status)) ? 'owned' as const : report.matches.length ? 'possible' as const : undefined,
  ])), [matchQuery.data]);
  const ownershipFor = (item: DoujinSearchResult) => galleryOwnership([galleryKey(item)], libraryMatches, downloadedAt, ownedKeys);
  /** The confirmed library copy behind an "In library" gallery, for the detail modal. */
  const libraryCopyFor = (key: string) => matchQuery.data?.reports.find(report => `${report.source}:${report.galleryId}` === key)
    ?.matches.find(match => match.confirmed && match.status === 'In library');
  const folderCount = foldersQuery.data?.length ?? 0;
  const showFolderFilter = folderCount > 0 || feedFolder !== '';
  // Filters appear once there is something to choose between, and stay put while narrowing.
  const showWatchFilter = (watches?.length ?? 0) > 1 || feedWatch !== '';
  const showSourceFilter = new Set((watches ?? []).map(watch => watch.source)).size > 1 || feedSource !== '';
  // ---------------- Following triage ----------------
  // After a dismissal removes a card from Inbox, focus moves to the next find's
  // Dismiss so keyboard triage continues where it was.
  const feedGridRef = React.useRef<HTMLDivElement>(null);
  const feedTriageState = React.useRef({ items: feedPageItems, view: feedView });
  feedTriageState.current = { items: feedPageItems, view: feedView };
  const refocusAfterDismiss = React.useRef<{ index: number; key: string } | null>(null);
  const triageGallery = React.useCallback((item: DoujinSearchResult, reviewed: boolean) => {
    const key = galleryKey(item);
    const { items, view } = feedTriageState.current;
    if (reviewed && view === 'inbox') refocusAfterDismiss.current = { index: items.findIndex(entry => galleryKey(entry) === key), key };
    reviewGallery(item, reviewed);
  }, [reviewGallery]);
  React.useLayoutEffect(() => {
    const pending = refocusAfterDismiss.current;
    if (!pending || feedPageItems.some(item => galleryKey(item) === pending.key)) return;
    refocusAfterDismiss.current = null;
    // Respect a user who has already moved focus somewhere else.
    if (document.activeElement && document.activeElement !== document.body) return;
    const actions = [...(feedGridRef.current?.querySelectorAll<HTMLElement>('[data-review-action]') ?? [])];
    const target = actions[Math.min(Math.max(pending.index, 0), actions.length - 1)] ?? document.querySelector<HTMLElement>('[data-feed-empty-action]');
    target?.focus();
  }, [feedPageItems]);
  const filterByWatch = React.useCallback((searchId: number) => { setFeedWatch(String(searchId)); setFeedPage(1); }, [setFeedWatch, setFeedPage]);
  /** j/k move between finds, d dismisses, u restores: the inbox works without a pointer. */
  const onFeedKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || selectMode) return;
    const card = (event.target as Element).closest<HTMLElement>('[data-feed-card]');
    if (!card || (event.target as Element).closest('input, select, textarea')) return;
    const key = event.key.toLowerCase();
    if (key === 'j' || key === 'k') {
      const cards = [...(feedGridRef.current?.querySelectorAll<HTMLElement>('[data-feed-card]') ?? [])];
      const next = cards[cards.indexOf(card) + (key === 'j' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      const onAction = (event.target as Element).closest('[data-review-action]') !== null;
      (onAction ? next.querySelector<HTMLElement>('[data-review-action]') : next.querySelector<HTMLElement>('article > button'))?.focus();
    } else if (key === 'd' || key === 'u') {
      const action = card.querySelector<HTMLButtonElement>(`[data-review-action="${key === 'd' ? 'dismiss' : 'restore'}"]`);
      if (!action || action.disabled) return;
      event.preventDefault();
      action.click();
    }
  };
  const nextCheck = nextScheduledCheck(watches ?? []);

  const galleryMotionKey = React.useMemo(
    () => `${tab}:${pageItems.map(item => `${item.source}:${item.galleryId}`).join(',')}:${visibleRecs.map(item => `${item.source}:${item.galleryId}`).join(',')}:${feedPageItems.map(item => `${item.source}:${item.galleryId}`).join(',')}:${unified.entries.map(entry => entry.entryId).join(',')}:${selectMode}`,
    [tab, pageItems, visibleRecs, feedPageItems, unified.entries, selectMode],
  );
  const galleryMotionRef = useDownloaderTransitions(galleryMotionKey);

  // Watch targets: the single source, or every lane of an All-sources search
  // that ran and can be followed (E-Hentai is search-and-download only).
  const nativeWatchTargets = source === 'ehentai' || !watchedQuery ? [] : [{ source, query: watchedQuery }];
  const unifiedWatchTargets = unified.providers.flatMap((p) => (p.watchQuery ? [{ source: p.source, query: p.watchQuery }] : []));
  const watchingAllOf = (targets: { source: DoujinSource; query: string }[]) => targets.length > 0 && targets.every((t) => (watches ?? []).some((w) => sameWatch(w, t)));
  const unifiedWatching = watchingAllOf(unifiedWatchTargets);
  const unifiedWatchNames = unifiedWatchTargets.map((t) => SOURCE_LABELS[t.source]).join(' and ');
  const searchInControl = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span aria-hidden="true" className="text-sm font-medium text-muted">Search in</span>
      <SegmentedControl items={scopeItems} value={scope} onChange={changeScope} label="Search in" className="max-w-full" itemClassName="min-h-9 px-3 text-xs sm:text-sm max-lg:min-h-11" />
    </div>
  );

  return (
    <div ref={galleryMotionRef} className={cn('flex flex-col gap-4', showSelection && 'pb-[calc(var(--selection-tray-height,0px)+1rem)] lg:pb-0')} style={{ '--selection-tray-height': `${selectionHeight}px` } as React.CSSProperties}>
      <PageHeader icon={<Compass className="h-5 w-5" />} title="Discover galleries" subtitle={tab === 'manager' ? 'Follow each download from the queue into your Kavita library.' : undefined} />
      {/* The folder is shown where downloads start (selection bar, gallery details);
          up here it only appears when it needs fixing before anything can download. */}
      {tab !== 'manager' && (downloadStatus === 'missing' || downloadStatus === 'error') && <DownloadDestination setup={setup} />}

      <SegmentedTabs
        items={[{ id: 'search' as const, label: 'Search' }, { id: 'recommend' as const, label: 'For you' }, { id: 'watched' as const, label: inboxCount ? `Following (${inboxCount})` : 'Following' }, { id: 'manager' as const, label: 'Downloads', count: downloadSummary.failed || downloadSummary.active || undefined, alert: downloadSummary.failed > 0 }]}
        value={tab}
        onChange={setTab}
        label="Discover sections"
        panelId="downloader-panel"
        className="sticky top-0 z-10 self-start bg-background"
      />
      <TabPanel value={tab} id="downloader-panel" role="tabpanel" aria-labelledby={`downloader-panel-tab-${tab}`}>

      {tab === 'search' && (<>

      {searchAll ? (
        <UnifiedSearchTab
          unified={unified}
          scopeControl={searchInControl}
          watchControl={
            <WatchSearchButton
              watching={unifiedWatching}
              pending={watchPending || unified.status !== 'idle'}
              disabledReason={unified.status === 'idle' && unified.providers.length > 0 && unifiedWatchTargets.length === 0 ? 'Only Hitomi.la and nHentai searches can be watched.' : undefined}
              title={unifiedWatching ? `Stop watching “${unified.committed}” on ${unifiedWatchNames}` : `Watch “${unified.committed}” on ${unifiedWatchNames}; new finds land in Following`}
              onToggle={() => void toggleWatches(unifiedWatchTargets, unified.committed ?? '')}
            />
          }
          onOpenEntry={(entry) => {
            setUnifiedSelectedEntry(entry);
            setUnifiedVariantKey(`${entry.primary.source}:${entry.primary.galleryId}`);
            setSelected(null);
          }}
          onDownload={(item) => doStartDownload(item)}
          downloadStatus={downloadStatus}
          startingKeys={pendingKeys}
          ownershipFor={unifiedOwnership}
          selectedEntryIds={unifiedSelectedIds}
          onToggleGroup={toggleUnifiedGroup}
          selectMode={selectMode}
          onToggleSelectMode={() => setSelectMode((m) => !m)}
          selectionActions={selectionActions}
          showSelection={showSelection}
        />
      ) : (<>

      {/* Search bar */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          {searchInControl}
          <form onSubmit={runSearch} className="flex flex-col gap-2 sm:flex-row">
            <div className="flex min-w-0 flex-1 gap-2">
              <GallerySearchInput value={query} onChange={setQuery} source={source} label="Search galleries" describedBy="search-hint" placeholder="Keyword, tag, artist, gallery ID or URL…" clearLabel="Clear search input" className="h-11" />
              <Button className="h-11 shrink-0" type="submit" disabled={isFetching || !query.trim()}>
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
              </Button>
            </div>
            {/* Popularity ordering — mirrors each source's own sort controls. The
                sort travels as a separate field, so its syntax never appears in the search box. */}
            {sortsFor(source).length > 1 && (
              <Select
                value={sort}
                onChange={(e) => setSort(e.target.value as DoujinSort)}
                aria-label="Sort results"
                className="h-11 min-w-0 w-full shrink-0 text-sm sm:w-44"
              >
                {sortsFor(source).map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </Select>
            )}
          </form>
          <SearchHint id="search-hint" />
          {translationNotice?.query === query && translationNotice.issues.length > 0 && <p role="status" aria-label="Search query translation" className="break-words text-sm text-muted">{translationNotice.issues.join(' ')} Review the query, then choose Search.</p>}
        </CardContent>
      </Card>

      {searchKey === null && showSelection && <GallerySelectionBar {...selectionActions} />}

      {/* Before the first search there is nothing below the bar — give it a purpose. */}
      {searchKey === null && (
        <Card className="flex items-center justify-center">
          <EmptyState icon={<Search className="h-8 w-8" />} title="Search for galleries" description={source === 'ehentai' && ehAccount.data && !ehAccount.data.configured ? 'This source needs your own E-Hentai or ExHentai account. Save it under Settings → Downloader → E-Hentai account, then search here.' : 'Search one source with its own sort and filters. Choose Watch on a search to have new releases land in Following.'} />
        </Card>
      )}

      {/* Results grid */}
      {searchKey !== null && (
        <div>
          <SearchResultsHeader
            status={isFetching ? 'Searching…' : results
              ? (pageCount > 1
                ? `Showing ${(curPage - 1) * RESULTS_PAGE_SIZE + 1}–${Math.min(curPage * RESULTS_PAGE_SIZE, resultCount)} of ${resultCount} galleries on ${SOURCE_LABELS[source]}`
                : `${resultCount} ${resultCount === 1 ? 'gallery' : 'galleries'} on ${SOURCE_LABELS[source]}`)
              : ''}
            actions={<>
              <WatchSearchButton
                watching={!!currentWatch}
                pending={watchPending}
                disabledReason={source === 'ehentai' ? 'Watching isn’t available for E-Hentai.' : undefined}
                title={currentWatch ? `Stop watching “${watchedQuery}”` : `Watch “${watchedQuery}” on ${SOURCE_LABELS[source]}; new finds land in Following`}
                onToggle={() => void toggleWatches(nativeWatchTargets, watchedQuery)}
              />
              {(!!results?.length || selectMode) && <SelectModeButton selectMode={selectMode} onToggle={() => setSelectMode(m => !m)} />}
            </>}
          />
          {showSelection && <GallerySelectionBar {...selectionActions} />}
          {searchFailed ? (
            <SearchFailure title="Search failed" subject={SOURCE_LABELS[source]} error={searchError} onRetry={() => void retrySearch()} />
          // placeholderData keeps the previous grid mounted during a refetch —
          // the skeleton only shows before any results exist.
          ) : isFetching && !results ? (
            <GallerySkeletonGrid label={`Searching ${SOURCE_LABELS[source]}`} />
          ) : results && results.length > 0 ? (
            <>
              <div aria-busy={showingStaleResults} inert={showingStaleResults} className={cn('grid grid-cols-1 gap-3 transition-opacity duration-150 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6', showingStaleResults && 'opacity-50')}>
                {pageItems.map(item => (
                  <GalleryCard
                    key={item.source + item.galleryId}
                    item={item}
                    onOpen={setSelected}
                    starting={pendingKeys.has(`${item.source}:${item.galleryId}`)}
                    onDownload={doStartDownload}
                    downloadSetup={downloadStatus}
                    quietAction
                    ownership={ownershipFor(item)} selection={{ mode: selectMode ? 'select' : 'browse', selected: selectedGalleries.has(`${item.source}:${item.galleryId}`), onToggle: toggleGallerySelect }} />
                ))}
              </div>
              <Pager page={curPage} count={pageCount} onPageChange={changePage} />
            </>
          ) : (
            <EmptyState icon={<Search className="h-8 w-8" />} title="No results" description={`No galleries found for “${searchKey}” on ${SOURCE_LABELS[source]}.`} />
          )}
        </div>
      )}

      </>)}

      </>)}


      {/* Daily recommendations */}
      {tab === 'recommend' && (
        <div className="flex flex-col gap-4">
          <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {recLibs && recLibs.length > 0 && (
                <div role="group" aria-label="Libraries used for recommendations" className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="mr-1 text-xs font-medium text-muted">Include libraries</span>
                  {recLibs.map((lib) => {
                    const excluded = (recSettings?.excludedLibraryIds ?? []).includes(lib.id);
                    return (
                      <Button
                        key={lib.id}
                        size="sm"
                        variant="outline"
                        aria-pressed={!excluded}
                        disabled={!recSettings || recLibraryPending !== null || recsRefreshing || feedbackPending !== null || recsLoading}
                        onClick={() => void toggleRecLibrary(lib)}
                        title={excluded ? `Include ${lib.name} in your recommendations` : `Exclude ${lib.name} from your recommendations`}
                        className={cn('min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 max-w-full', excluded ? 'text-muted' : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15')}
                      >
                        {recLibraryPending === lib.id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', excluded && 'opacity-0')} aria-hidden="true" />}
                        <span className="truncate">{lib.name}</span>
                      </Button>
                    );
                  })}
                </div>
              )}
              <div className="grid grid-cols-2 items-center gap-2 sm:ml-auto sm:flex sm:shrink-0 sm:flex-wrap">
                {recs?.mode === 'popular' && <span className="col-span-2 w-fit"><Badge tone="muted">Popular picks</Badge></span>}
                {recs?.mode === 'mixed' && <span className="col-span-2 w-fit"><Badge tone="muted">Personalized + popular</Badge></span>}
                <Button size="sm" variant={selectMode ? 'default' : 'outline'} className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 w-full sm:w-auto" aria-pressed={selectMode} onClick={() => setSelectMode(current => !current)} disabled={!visibleRecs.length && !selectedGalleries.size}>
                  <CheckSquare className="h-3.5 w-3.5 shrink-0" />{selectMode ? 'Done selecting' : 'Select galleries'}
                </Button>
                <RecommendationFeedbackManager feedback={feedbackQuery.data} pending={feedbackPending !== null || recsRefreshing || recLibraryPending !== null || recsLoading} onAction={request => void updateFeedback(request)} />
                <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11 w-full sm:w-auto" onClick={() => void doRefreshRecs()} disabled={recsRefreshing || recLibraryPending !== null || feedbackPending !== null || recsLoading} title="Get a fresh selection of recommendations">
                  <RotateCcw className={cn('h-3.5 w-3.5 shrink-0', recsRefreshing && 'animate-spin')} /> {recsRefreshing ? 'Refreshing…' : 'Refresh picks'}
                </Button>
              </div>
            </div>
            {recs?.degradedReason === 'same-day-pool-exhausted' && (
              <p className="text-xs text-muted">You’ve seen all of today’s fresh picks. Some earlier recommendations may appear again.</p>
            )}
            {recs?.degradedReason === 'insufficient-eligible' && (
              <p className="text-xs text-muted">Only {recs.items.length} picks are available with your current preferences and exclusions.</p>
            )}
            {recs && (recs.profile.artists.length > 0 || recs.profile.tags.length > 0 || (recs.profile.series?.length ?? 0) > 0) && (
              <Disclosure label="What shapes these picks" className="border-t border-border pt-2" summaryClassName="px-0 text-xs">
                <div className="flex flex-col gap-2 pt-2">
                  {[
                    { label: 'Artists', values: recs.profile.artists },
                    { label: 'Tags', values: recs.profile.tags },
                    { label: 'Series', values: recs.profile.series ?? [] },
                  ].filter((group) => group.values.length > 0).map((group) => (
                    <div key={group.label} className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-xs text-muted">{group.label}</span>
                      {group.values.map((value) => <span key={value} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted" title={value}>{value}</span>)}
                    </div>
                  ))}
                </div>
              </Disclosure>
            )}
          </Card>

          {feedbackQuery.isError && <ErrorState title="Could not load recommendation feedback" description={feedbackQuery.error.message} onRetry={() => void feedbackQuery.refetch()} />}
          <p className="sr-only" role="status">{dismissedGalleries.length > 0 ? `${dismissedGalleries.length} dismissed galleries. Expand Dismissed galleries to undo.` : ''}</p>
          {dismissedGalleries.length > 0 && (
            <Disclosure label={<>Dismissed galleries <Badge tone="muted">{dismissedGalleries.length}</Badge></>} className="rounded-lg border border-border bg-surface" summaryClassName="p-3">
              <ul className="max-h-64 overflow-y-auto border-t border-border px-3">
                {dismissedGalleries.map((item) => (
                  <li key={`${item.source}:${item.galleryId}`} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                    <p className="min-w-0 flex-1 truncate text-sm" title={item.title}>{item.title}</p>
                    <Button size="sm" variant="ghost" className="max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0" onClick={() => void undoDismissGallery(item)} disabled={feedbackPending !== null || recsRefreshing} aria-label={`Undo dismissal of ${item.title}`}>
                      {feedbackPending === `${item.source}:${item.galleryId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Undo
                    </Button>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          {recsFailed ? (
            <ErrorState title="Recommendations failed" description={recsError instanceof Error ? recsError.message : String(recsError)} onRetry={() => void refetchRecs()} />
          ) : !recs && recsLoading ? (
            <div role="status" className="flex items-start justify-center gap-2 px-4 py-12 text-sm text-muted"><Spinner /><span className="max-w-sm">Building your picks — the first pass of the day can take a minute…</span>
            </div>
          ) : visibleRecs.length > 0 ? (
            <>
            {showSelection && <GallerySelectionBar {...selectionActions} />}
            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {visibleRecs.map(item => (
                <div key={item.source + item.galleryId} className="flex flex-col gap-1 [&>article]:flex-1">
                  <GalleryCard
                    item={item}
                    onOpen={setSelected}
                    starting={pendingKeys.has(`${item.source}:${item.galleryId}`)}
                    onDownload={doStartDownload}
                    downloadSetup={downloadStatus}


                   ownership={ownershipFor(item)} selection={{ mode: selectMode ? 'select' : 'browse', selected: selectedGalleries.has(`${item.source}:${item.galleryId}`), onToggle: toggleGallerySelect }} display="recommendation" reasons={item.reasons} feedback={{ pending: feedbackPending !== null || recsRefreshing || recLibraryPending !== null || recsLoading, onOpen: setFeedbackItem }} />
                </div>
              ))}
            </div>
            </>
          ) : (
            <EmptyState icon={<Sparkles className="h-8 w-8" />} title="No picks available" description="Nothing eligible came back. Refresh the picks, or include another library above." />
          )}
        </div>
      )}

      {/* The inbox leads; watch upkeep lives in a side sheet. */}
      {tab === 'watched' && (
        <div className="flex flex-col gap-4">
          <section aria-label="Watched discoveries" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl items={[{ id: 'inbox' as const, label: `Inbox${galleryFeed ? ` (${galleryFeed.inboxCount})` : ''}` }, { id: 'history' as const, label: `All finds${galleryFeed ? ` (${galleryFeed.historyCount})` : ''}` }]} value={feedView} onChange={view => { setFeedView(view); setFeedPage(1); }} label="Discovery view" itemClassName="min-h-11" />
                  <Button size="sm" className="h-11" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode(current => !current)} disabled={!feedItems.length && !selectedGalleries.size}><CheckSquare className="h-3.5 w-3.5" />{selectMode ? 'Done selecting' : 'Select galleries'}</Button>
                </div>
                <Button size="sm" className="h-11" variant="outline" onClick={openManageWatches}><Settings2 className="h-3.5 w-3.5" />Manage watches{watches ? ` (${watches.length})` : ''}</Button>
              </div>
              {watches && watches.length > 0 && <FollowingCheckStatus watches={watches} />}
            </div>
            {(showFolderFilter || showWatchFilter || showSourceFilter) && <div className="flex min-w-0 flex-wrap items-end gap-3">
              {showFolderFilter && <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-medium text-muted lg:max-w-xs">Folder
                <Select className="h-11" aria-label="Filter discoveries by folder" value={feedFolder} onChange={event => { setFeedFolder(event.target.value); setFeedWatch(''); setFeedPage(1); }} disabled={!foldersQuery.isSuccess}>
                  <option value="">All folders</option><option value="unfiled">Unfiled</option>
                  {(foldersQuery.data ?? []).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </Select>
              </label>}
              {showWatchFilter && <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-medium text-muted lg:max-w-xs">Watch
                <Select className="h-11" aria-label="Filter discoveries by watch" value={feedWatch} onChange={event => { setFeedWatch(event.target.value); setFeedPage(1); }}>
                  <option value="">All watches</option>
                  {feedWatches?.map(watch => <option key={watch.id} value={watch.id}>{SOURCE_LABELS[watch.source]} · {watch.watchLabel}{watch.removed ? ' (removed watch)' : ''}</option>)}
                </Select>
              </label>}
              {showSourceFilter && <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-medium text-muted lg:max-w-[12rem]">Source
                <Select className="h-11" aria-label="Filter discoveries by source" value={feedSource} onChange={event => { setFeedSource(event.target.value); setFeedPage(1); }}><option value="">All sources</option><option value="hitomi">Hitomi.la</option><option value="nhentai">nHentai</option></Select>
              </label>}
              {filtersActive && <Button size="sm" variant="ghost" className="h-11" onClick={clearFilters}><FunnelX aria-hidden="true" className="h-3.5 w-3.5" />Clear filters</Button>}
            </div>}
            {foldersQuery.isError && <ErrorState title="Could not load folder filters" description={foldersQuery.error.message} onRetry={() => void foldersQuery.refetch()} />}
            {showSelection && <GallerySelectionBar {...selectionActions} />}
            {feedFailed ? <SearchFailure title="Could not load discoveries" subject="Your discoveries" error={feedError} onRetry={() => void retryFeed()} /> : !galleryFeed && feedLoading ? (
              <GallerySkeletonGrid label="Loading discoveries" count={6} />
            ) : feedItems.length ? (
              <>
                <div ref={feedGridRef} onKeyDown={onFeedKeyDown} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {feedPageItems.map(item => {
                    const key = `${item.source}:${item.galleryId}`, meta = feedMetaByKey.get(key);
                    return <div key={key} data-feed-card data-review-pending={reviewingKeys.has(key)} className="watched-discovery flex min-w-0 flex-col [&>article]:flex-1">
                      <GalleryCard item={item} onOpen={setSelected} starting={pendingKeys.has(key)} onDownload={doStartDownload} downloadSetup={downloadStatus} ownership={ownershipFor(item)} selection={{ mode: selectMode ? 'select' : 'browse', selected: selectedGalleries.has(key), onToggle: toggleGallerySelect }} display="discovery" review={{ state: reviewingKeys.has(key) ? 'pending' : meta?.reviewedAt ? 'reviewed' : 'unreviewed', onChange: triageGallery }}
                        origin={meta ? { searchId: meta.searchId, label: meta.watchLabel, query: meta.query, foundAt: meta.foundAt, removed: meta.watchRemoved } : undefined} onOriginSelect={filterByWatch} />
                    </div>;
                  })}
                </div>
                <p className="hidden text-center text-xs text-muted pointer-fine:lg:block">
                  Keyboard: <kbd className="rounded border border-border-2 bg-surface-2 px-1 font-mono text-foreground">j</kbd> / <kbd className="rounded border border-border-2 bg-surface-2 px-1 font-mono text-foreground">k</kbd> move between finds · <kbd className="rounded border border-border-2 bg-surface-2 px-1 font-mono text-foreground">d</kbd> dismiss · <kbd className="rounded border border-border-2 bg-surface-2 px-1 font-mono text-foreground">u</kbd> return to Inbox
                </p>
                <Pager page={feedCurPage} count={feedPageCount} onPageChange={page => { setFeedPage(page); document.querySelector('main')?.scrollTo({ top: 0 }); }} />
              </>
            ) : (
              <div className="flex flex-col items-center">
                {filtersActive ? <>
                  <EmptyState icon={<FunnelX className="h-8 w-8" />} title="No matching finds" description={feedView === 'inbox' ? 'Nothing in Inbox matches these filters.' : 'No finds match these filters.'} />
                  <Button data-feed-empty-action variant="outline" className="-mt-6 mb-10 min-h-11" onClick={clearFilters}><FunnelX className="h-3.5 w-3.5" />Clear filters</Button>
                </> : watches?.length === 0 ? <>
                  <EmptyState icon={<Inbox className="h-8 w-8" />} title="Nothing followed yet" description="Choose Watch on any search, or add a search to follow here. New finds land in Inbox for review." />
                  <Button data-feed-empty-action variant="outline" className="-mt-6 mb-10 min-h-11" onClick={openManageWatches}><Plus className="h-3.5 w-3.5" />Add a watched search</Button>
                </> : feedView === 'inbox' ? <>
                  <EmptyState icon={<CheckCheck className="h-8 w-8" />} title="All caught up"
                    description={nextCheck ? <>Next check at <time dateTime={nextCheck}>{formatCheckTime(nextCheck)}</time>. New finds will land here.</> : 'Automatic checks are off. Use Check now above to look for new finds.'} />
                  {(galleryFeed?.historyCount ?? 0) > 0 && <Button data-feed-empty-action variant="outline" className="-mt-6 mb-10 min-h-11" onClick={() => { setFeedView('history'); setFeedPage(1); }}>Browse all finds</Button>}
                </> : <EmptyState icon={<Inbox className="h-8 w-8" />} title="No finds yet" description="Every find from your watched searches is kept here, including the ones you dismiss." />}
              </div>
            )}
          </section>
          <WatchedManagerDrawer open={manageWatchesOpen} onOpenChange={setManageWatchesOpen} returnFocusTo={manageWatchesTrigger} onOpenSearch={(src, q) => searchTagFragment(q, src)} />
        </div>
      )}
      <React.Suspense fallback={null}>
      {/* Merged download confirm — reachable from both results grids */}
      {mergeOpen && mergeItems.length > 0 && (
        <MergeDownloadDialog
          items={mergeItems}
          defaultFolder={folderNameFrom(mergeItems[0].title ?? '')}
          onClose={() => setMergeOpen(false)}
          onConfirm={(folder, numbers) => void doMergedDownload(folder, numbers)}
          setup={setup}
          pending={mergePending}
          result={mergeResult}
        />
      )}

      {/* Merge selected galleries into an existing Kavita series */}
      {mergeIntoOpen && mergeIntoItems && mergeIntoItems.length > 0 && (
        <MergeIntoSeriesDialog
          items={mergeIntoItems}
          onClose={() => setMergeIntoOpen(false)}
          onQueued={(keys) => {
            const queued = new Set(keys);
            selection.remove(queued);
            setSelectMode(false);
          }}
          setup={setup}
        />
      )}

      {/* Gallery detail modal */}
      {feedbackItem && <GalleryFeedbackDialog item={feedbackItem} feedback={feedbackQuery.data} pending={feedbackPending !== null || recsRefreshing || recLibraryPending !== null || recsLoading} onClose={() => setFeedbackItem(null)} onAction={request => void updateFeedback(request)} onDismiss={() => void doDismissGallery(feedbackItem)} />}
      {selected && (
        <GalleryDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          checking={pendingKeys.has(`${selected.source}:${selected.galleryId}`)}

          downloaded={downloadedAt.has(`${selected.source}:${selected.galleryId}`) || libraryMatches.get(`${selected.source}:${selected.galleryId}`) === 'owned' || ownedKeys.has(`${selected.source}:${selected.galleryId}`)}
          inLibrary={libraryMatches.get(`${selected.source}:${selected.galleryId}`) === 'owned'}
          libraryMatch={libraryCopyFor(`${selected.source}:${selected.galleryId}`)}
          setup={setup}
          onDownload={() => doStartDownload(selected)}
          onSearchTag={searchTagFragment}
        />
      )}

      {/* Unified search detail: one entry, a selectable real source per variant */}
      {unifiedSelectedEntry && (() => {
        const key = unifiedVariantKey ?? `${unifiedSelectedEntry.primary.source}:${unifiedSelectedEntry.primary.galleryId}`;
        const item = webVariant(unifiedSelectedEntry, key);
        const variants = unifiedSelectedEntry.variants.length > 1
          ? unifiedSelectedEntry.variants.map((v) => ({ item: webVariant(unifiedSelectedEntry, `${v.source}:${v.galleryId}`), position: v.providerPosition }))
          : undefined;
        return (
          <GalleryDetailModal
            item={item}
            variants={variants}
            selectedVariantKey={key}
            onSelectVariant={(v) => {
              setUnifiedVariantKey(`${v.source}:${v.galleryId}`);
              // Re-point the group's download target; never queues both copies.
              selection.replaceGroup(entryKeys(unifiedSelectedEntry), v);
            }}
            onClose={() => setUnifiedSelectedEntry(null)}
            checking={pendingKeys.has(key)}
            downloaded={downloadedAt.has(key) || libraryMatches.get(key) === 'owned' || ownedKeys.has(key)}
            inLibrary={libraryMatches.get(key) === 'owned'}
            libraryMatch={libraryCopyFor(key)}
            setup={setup}
            onDownload={() => doStartDownload(item)}
            onSearchTag={searchTagFragment}
            searchAcrossSources
          />
        );
      })()}

      {/* Download manager — own component so live task ticks never re-render the page */}
      {tab === 'manager' && <ManagerTab />}
      </React.Suspense>

      </TabPanel>
      {showSelection && <GallerySelectionBar {...selectionActions} mobile onHeightChange={setSelectionHeight} />}
      {duplicateDialog}
    </div>
  );
}
