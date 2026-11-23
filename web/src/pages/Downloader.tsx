import { useGallerySelection, resolveGallerySelection } from './downloader/useGallerySelection';
import { useWatchedFeed } from './downloader/useWatchedFeed';
import { useRecommendations } from './downloader/useRecommendations';
import { gallerySearchReducer } from './downloader/searchState';
import { GallerySearchInput } from '../components/GallerySearchInput';
import { useGalleryDownload } from './downloader/useGalleryDownload';
import * as React from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Search, Loader2, RotateCcw, CheckCircle2, Check, Compass, Star, Sparkles, CheckSquare, Settings2 } from 'lucide-react';
import { api, ApiError, type DoujinSource, type DoujinSort, type DoujinSearchResult } from '../lib/api';
import { cn, timeAgo } from '../lib/utils';
import { downloadErrorHelp } from '../lib/downloadErrors';
import { toast } from '../lib/toast';
import { Button, Card, CardContent, Badge, Select, EmptyState, Spinner, PageHeader, SegmentedTabs, SegmentedControl, TabPanel, Disclosure, ErrorState, Pager } from '../components/ui';
import { MergeIntoSeriesDialog } from '../components/MergeIntoSeriesDialog';
import { GalleryFeedbackDialog, RecommendationFeedbackManager } from '../components/RecommendationFeedback';
import { GallerySelectionBar } from '../components/GallerySelectionBar';
import { switchProviderSearch, type TranslationLink } from '../lib/searchTranslation';

import { FALLBACK_SOURCES, SOURCE_COLORS, SOURCE_LABELS, sortsFor, readDownloaderState, writeDownloaderState, type DownloaderTab, type DownloaderStateCache, type SearchScope } from './downloader/state';
import { DownloadDestination } from './downloader/DownloadSetup';
import { GalleryCard } from './downloader/GalleryCard';
import { GalleryDetailModal } from './downloader/GalleryDetailModal';
import { ManagerTab } from './downloader/DownloadManager';
import { UnifiedSearchTab, type UnifiedSelectionActions } from './downloader/UnifiedSearchTab';
import { useUnifiedSearch, toWebResult } from './downloader/useUnifiedSearch';
import { WatchedManagerDrawer } from './downloader/WatchedSearchControls';
import { SearchHint } from './downloader/SearchHint';
import { SearchFailure } from './downloader/SearchFailure';
import { GallerySkeletonGrid } from './downloader/GallerySkeletons';
import { galleryKey, galleryOwnership } from './downloader/ownership';
import { MergeDownloadDialog, folderNameFrom, type MergeDownloadResult } from './downloader/MergeDownloadDialog';
import { useDownloaderTransitions } from './downloader/motion';
import type { UnifiedSearchEntry } from '../lib/api';
const RESULTS_PAGE_SIZE = 25;
const EMPTY_GALLERIES: DoujinSearchResult[] = [];
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
  const [unifiedSelected, setUnifiedSelected] = React.useState<{ entryId: string; source: DoujinSource; galleryId: string }[]>([]);

  // Multi-select mode for merged downloads (mirrors the Libraries page). Selection
  // is keyed `${source}:${galleryId}` and persists across result pages; a fresh
  // search resets it. Click order defines chapter numbering for merges.
  const [selectMode, setSelectMode] = React.useState(false);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [mergePending, setMergePending] = React.useState(false);
  const mergePendingRef = React.useRef(false);
  const [mergeItems, setMergeItems] = React.useState<DoujinSearchResult[]>([]);
  const [mergeResult, setMergeResult] = React.useState<MergeDownloadResult | null>(null);
  const [selectionHeight, setSelectionHeight] = React.useState(0);
  const [mergeIntoOpen, setMergeIntoOpen] = React.useState(false);

  const { setup, checkDuplicates, duplicateDialog, ensureDownloadReady, pendingKeys, doStartDownload } = useGalleryDownload();
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
    enabled: searchNative || tab === 'watched',
  });
  const watchedQuery = searchKey?.trim() ?? '';
  const currentWatch = (watches ?? []).find((w) => w.source === source && w.query === watchedQuery);
  // The account view (never secrets) gates the E-Hentai empty state: an
  // unconfigured account gets a settings pointer instead of a dead search.
  const ehAccount = useQuery({ queryKey: ['ehentai-account'], queryFn: api.ehentaiAccount, staleTime: 30_000, enabled: searchNative && source === 'ehentai' });

  async function toggleWatch() {
    const q = watchedQuery;
    if (!q) return;
    if (source === 'ehentai') {
      toast({ tone: 'info', title: 'Watching is not available for E-Hentai', description: 'Following checks Hitomi.la and nHentai; E-Hentai/ExHentai is a search and download source.' });
      return;
    }
    try {
      if (currentWatch) {
        await api.removeWatchedSearch(currentWatch.id, currentWatch.revision);
        toast({ tone: 'info', title: 'Unwatched', description: `“${q}” on ${SOURCE_LABELS[source]} will no longer be checked.` });
      } else {
        await api.addWatchedSearch(source, q);
        toast({ tone: 'success', title: 'Watching search', description: `New finds for “${q}” appear in Following. Discord notifications depend on your settings.` });
      }
      await refetchWatches();
      void qc.invalidateQueries({ queryKey: ['watched-gallery-feed'] });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) await refetchWatches();
      toast({ tone: 'danger', title: 'Could not update watches', description: e instanceof Error ? e.message : String(e) });
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
  const { feedView, setFeedView, feedSource, setFeedSource, feedWatch, setFeedWatch, feedFolder, setFeedFolder, foldersQuery, setFeedPage, galleryFeed, feedWatches, feedLoading, feedFailed, feedError, retryFeed, feedItems, knownDiscoveries, feedMetaByKey, feedPageCount, feedCurPage, feedPageItems, reviewingKeys, reviewDiscoveries, reviewGallery } = useWatchedFeed(tab, selection.remove);
  const selectionView = React.useMemo(() => resolveGallerySelection(selection.chosen, results ?? EMPTY_GALLERIES, feedItems, knownDiscoveries.current), [selection.chosen, results, feedItems, knownDiscoveries]);
  const selectedGalleries = selection.keys, selectedItems = selectionView.items, reviewableSelectedItems = selectionView.reviewable;
  const toggleGallerySelect = selection.toggle;
  const { recs, recsLoading, recsFailed, recsError, refetchRecs, recsRefreshing, doRefreshRecs, ownedKeys, visibleRecs, dismissedGalleries, feedbackPending, feedbackItem, setFeedbackItem, feedbackQuery, updateFeedback, doDismissGallery, undoDismissGallery, recLibs, recSettings, recLibraryPending, toggleRecLibrary } = useRecommendations(tab);

  const searchMounted = React.useRef(false);
  React.useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return;
    }
    selection.clear();
    setSelectMode(false);
  }, [searchKey, source]);
  const scopeMounted = React.useRef(false);
  React.useEffect(() => {
    if (!scopeMounted.current) { scopeMounted.current = true; return; }
    selection.clear();
    setUnifiedSelected([]);
    setSelectMode(false);
  }, [scope]);
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
  // Group selection is keyed by entryId; each selected group snapshots ONE
  // explicit variant (the stable primary by default). Click order is the
  // merge chapter order. A late group update never changes a made choice;
  // picking a variant in the detail modal re-points that group only.
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
  const unifiedEntriesById = React.useMemo(() => new Map(unified.entries.map((e) => [e.entryId, e])), [unified.entries]);
  const unifiedSelectedItems = React.useMemo(
    () => unifiedSelected
      .map((slot) => {
        const entry = unifiedEntriesById.get(slot.entryId);
        return entry ? webVariant(entry, `${slot.source}:${slot.galleryId}`) : null;
      })
      .filter((x): x is DoujinSearchResult => x !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unifiedSelected, unifiedEntriesById],
  );
  const toggleUnifiedGroup = React.useCallback((entry: UnifiedSearchEntry) => {
    setUnifiedSelected((prev) => {
      if (prev.some((s) => s.entryId === entry.entryId)) return prev.filter((s) => s.entryId !== entry.entryId);
      return [...prev, { entryId: entry.entryId, source: entry.primary.source, galleryId: entry.primary.galleryId }];
    });
  }, []);
  const unifiedSelectedIds = new Set(unifiedSelected.map((s) => s.entryId));
  const unifiedSelectionActions: UnifiedSelectionActions = {
    items: unifiedSelectedItems,
    onDownloadEach: () => void downloadEach(unifiedSelectedItems),
    onSelectAll: unified.entries.length ? () => setUnifiedSelected((prev) => {
      const have = new Set(prev.map((s) => s.entryId));
      return [...prev, ...unified.entries.filter((e) => !have.has(e.entryId)).map((e) => ({ entryId: e.entryId, source: e.primary.source, galleryId: e.primary.galleryId }))];
    }) : undefined,
    allSelected: unified.entries.length > 0 && unified.entries.every((e) => unifiedSelectedIds.has(e.entryId)),
    onMerge: () => openMergedDownload(unifiedSelectedItems),
    onMergeInto: () => openMergeInto(unifiedSelectedItems),
    onRemove: (item) => setUnifiedSelected((prev) => prev.filter((s) => `${s.source}:${s.galleryId}` !== `${item.source}:${item.galleryId}`)),
    onClear: () => setUnifiedSelected([]),
    onCancel: () => { setUnifiedSelected([]); setSelectMode(false); },
  };
  const unifiedCommittedRef = React.useRef(unified.committed);
  React.useEffect(() => {
    if (unifiedCommittedRef.current === unified.committed) return;
    unifiedCommittedRef.current = unified.committed;
    setUnifiedSelected([]);
    setUnifiedSelectedEntry(null);
    setUnifiedVariantKey(null);
    setSelectMode(false);
  }, [unified.committed]);
  function unifiedOwnership(entry: UnifiedSearchEntry) {
    // Every variant is inspected, but only exact source+galleryId matches claim ownership.
    const primaryKey = `${entry.primary.source}:${entry.primary.galleryId}`;
    const variantKeys = entry.variants.map((v) => `${v.source}:${v.galleryId}`).filter((k) => k !== primaryKey);
    return galleryOwnership([primaryKey, ...variantKeys], libraryMatches, downloadedAt, ownedKeys);
  }

  const showSelection = (tab === 'search' || tab === 'recommend' || tab === 'watched') && (selectMode || selectedGalleries.size > 0 || unifiedSelected.length > 0);
  // Queue each chosen gallery on its own, one at a time so duplicate reviews never stack up.
  const downloadingEach = React.useRef(false);
  async function downloadEach(items: DoujinSearchResult[]) {
    if (!items.length || downloadingEach.current || !ensureDownloadReady()) return;
    downloadingEach.current = true;
    try {
      for (const item of items) await doStartDownload(item);
      selection.clear();
      setUnifiedSelected([]);
      setSelectMode(false);
    } finally {
      downloadingEach.current = false;
    }
  }
  const pageSelectable: DoujinSearchResult[] = tab === 'search' ? pageItems : tab === 'recommend' ? visibleRecs : tab === 'watched' ? feedPageItems : EMPTY_GALLERIES;
  const selectionActions = {
    items: selectedItems,
    onDownloadEach: () => void downloadEach(selectedItems),
    onSelectAll: pageSelectable.length ? () => selection.addMany(pageSelectable) : undefined,
    allSelected: pageSelectable.length > 0 && pageSelectable.every(item => selectedGalleries.has(galleryKey(item))),
    onMerge: () => openMergedDownload(selectedItems),
    onMergeInto: () => openMergeInto(selectedItems),
    onRemove: toggleGallerySelect,
    onClear: clearSelection,
    onCancel: cancelSelection,
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
  function searchTagFragment(fragment: string, itemSource?: DoujinSource) {
    const trimmed = fragment.trim();
    if (!trimmed) return;
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
  const matchItems = searchAll ? unified.entries.flatMap((e) => e.variants.map((v) => webVariant(e, `${v.source}:${v.galleryId}`)))
    : tab === 'search' ? pageItems : tab === 'recommend' ? visibleRecs : tab === 'watched' ? feedPageItems
    : [];
  const matchQuery = useQuery({
    queryKey: ['gallery-library-matches', matchItems.map(({ source, galleryId, title, artists, language, pageCount }) => ({ source, galleryId, title, artists, language, pageCount }))],
    queryFn: () => api.libraryMatches(matchItems),
    enabled: matchItems.length > 0,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const libraryMatches = new Map((matchQuery.data?.reports ?? []).map(report => [
    `${report.source}:${report.galleryId}`,
    report.matches.some(match => match.confirmed && ['In library', 'Owned', 'completed'].includes(match.status)) ? 'owned' as const : report.matches.length ? 'possible' as const : undefined,
  ]));
  const ownershipFor = (item: DoujinSearchResult) => galleryOwnership([galleryKey(item)], libraryMatches, downloadedAt, ownedKeys);
  const folderCount = foldersQuery.data?.length ?? 0;
  const showFolderFilter = folderCount > 0 || feedFolder !== '';
  // Filters appear once there is something to choose between, and stay put while narrowing.
  const showWatchFilter = (watches?.length ?? 0) > 1 || feedWatch !== '';
  const showSourceFilter = new Set((watches ?? []).map(watch => watch.source)).size > 1 || feedSource !== '';
  const galleryMotionRef = useDownloaderTransitions(`${tab}:${pageItems.map(item => `${item.source}:${item.galleryId}`).join(',')}:${visibleRecs.map(item => `${item.source}:${item.galleryId}`).join(',')}:${feedPageItems.map(item => `${item.source}:${item.galleryId}`).join(',')}:${unified.entries.map(entry => entry.entryId).join(',')}:${selectMode}:${[...selectedGalleries].join(',')}`);

  return (
    <div ref={galleryMotionRef} className={cn('flex flex-col gap-4', showSelection && 'pb-[calc(var(--selection-tray-height,0px)+1rem)] lg:pb-0')} style={{ '--selection-tray-height': `${selectionHeight}px` } as React.CSSProperties}>
      <PageHeader icon={<Compass className="h-5 w-5" />} title="Discover galleries" subtitle={tab === 'watched' ? undefined : "Search Hitomi.la, nHentai and E-Hentai, then download galleries into your Kavita library."} />
      {tab !== 'manager' && <DownloadDestination setup={setup} compact={tab === 'watched'} />}

      <SegmentedTabs
        items={[{ id: 'search' as const, label: 'Search' }, { id: 'recommend' as const, label: 'For you' }, { id: 'watched' as const, label: inboxCount ? `Following (${inboxCount})` : 'Following' }, { id: 'manager' as const, label: 'Downloads' }]}
        value={tab}
        onChange={setTab}
        label="Discover sections"
        panelId="downloader-panel"
        className="sticky top-0 z-10 self-start bg-background"
      />
      <TabPanel value={tab} id="downloader-panel" role="tabpanel" aria-labelledby={`downloader-panel-tab-${tab}`}>

      {tab === 'search' && (<>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden="true" className="text-sm font-medium text-muted">Search in</span>
        <SegmentedControl items={scopeItems} value={scope} onChange={changeScope} label="Search in" className="max-w-full" itemClassName="min-h-9 px-3 text-xs sm:text-sm max-lg:min-h-11" />
      </div>

      {searchAll ? (
        <UnifiedSearchTab
          unified={unified}
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
          selectionActions={unifiedSelectionActions}
          showSelection={showSelection}
        />
      ) : (<>

      {/* Search bar */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={runSearch} className="flex flex-col gap-2 lg:flex-row">
            <div className="flex min-w-0 flex-1 gap-2">
              <GallerySearchInput value={query} onChange={setQuery} source={source} label="Search galleries" describedBy="search-hint" placeholder="Search by keyword, tag, artist, gallery ID or URL…" clearLabel="Clear search input" />
              <Button className="shrink-0" type="submit" disabled={isFetching || !query.trim()}>
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
                className="min-w-0 w-full shrink-0 text-xs sm:text-sm lg:w-44"
              >
                {sortsFor(source).map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </Select>
            )}
          </form>
          <SearchHint id="search-hint" scope={source} />
          {translationNotice?.query === query && translationNotice.issues.length > 0 && <p role="status" aria-label="Search query translation" className="break-words text-sm text-muted">{translationNotice.issues.join(' ')} Review the query, then choose Search.</p>}
        </CardContent>
      </Card>

      {/* Before the first search there is nothing below the bar — give it a purpose. */}
      {searchKey === null && (
        <Card className="flex items-center justify-center">
          <EmptyState icon={<Search className="h-8 w-8" />} title="Search for galleries" description={source === 'ehentai' && ehAccount.data && !ehAccount.data.configured ? 'This source needs your own E-Hentai or ExHentai account. Save it under Settings → Downloader → E-Hentai account, then search here.' : 'Keyword, tag, artist, gallery ID or URL. Use Watch to keep checking a query — new releases land in Following for you to review.'} />
        </Card>
      )}

      {/* Results grid */}
      {searchKey !== null && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p role="status" className="min-w-0 w-full text-sm text-muted min-[420px]:w-auto min-[420px]:flex-1">
              {isFetching ? 'Searching…' : results ? resultCount + (resultCount === 1 ? ' gallery' : ' galleries') + ' found on ' + SOURCE_LABELS[source] : 'Search results'}
              {!isFetching && pageCount > 1 && ' · ' + ((curPage - 1) * RESULTS_PAGE_SIZE + 1) + '–' + Math.min(curPage * RESULTS_PAGE_SIZE, resultCount)}
            </p>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {source === 'ehentai' && <span id="watch-note" className="text-xs text-muted">Watching isn’t available for E-Hentai.</span>}
              <Button
                type="button"
                size="sm"
                aria-label="Watch this search"
                aria-describedby={source === 'ehentai' ? 'watch-note' : undefined}
                aria-pressed={!!currentWatch}
                variant={currentWatch ? 'secondary' : 'outline'}
                onClick={() => void toggleWatch()}
                disabled={!watchedQuery || source === 'ehentai'}
                title={currentWatch ? `Stop watching “${watchedQuery}”` : watchedQuery ? `Watch the displayed results for “${watchedQuery}”` : 'Search first to watch these results'}
              >
                <Star className={cn('h-4 w-4', currentWatch && 'fill-current')} /> {currentWatch ? 'Watching' : 'Watch'}
              </Button>
              {!!results?.length && (
                <Button size="sm" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode(m => !m)} title="Select galleries to download together or merge into an existing series">
                  <CheckSquare className="h-3.5 w-3.5" /> {selectMode ? 'Done selecting' : 'Select galleries'}
                </Button>
              )}
            </div>
          </div>
          {searchFailed ? (
            <SearchFailure title="Search failed" subject={SOURCE_LABELS[source]} error={searchError} onRetry={() => void retrySearch()} />
          // placeholderData keeps the previous grid mounted during a refetch —
          // the spinner only shows before any results exist.
          ) : isFetching && !results ? (
            <GallerySkeletonGrid label={`Searching ${SOURCE_LABELS[source]}`} />
          ) : results && results.length > 0 ? (
            <>
              {showSelection && <GallerySelectionBar {...selectionActions} />}
              <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {pageItems.map(item => (
                  <GalleryCard
                    key={item.source + item.galleryId}
                    item={item}
                    onOpen={setSelected}
                    starting={pendingKeys.has(`${item.source}:${item.galleryId}`)}
                    onDownload={doStartDownload}
                    downloadSetup={downloadStatus}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl items={[{ id: 'inbox' as const, label: `Inbox${galleryFeed ? ` (${galleryFeed.inboxCount})` : ''}` }, { id: 'history' as const, label: `History${galleryFeed ? ` (${galleryFeed.historyCount})` : ''}` }]} value={feedView} onChange={view => { setFeedView(view); setFeedPage(1); }} label="Discovery view" itemClassName="min-h-11" />
                <Button size="sm" className="h-11" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={() => setSelectMode(current => !current)} disabled={!feedItems.length && !selectedGalleries.size}><CheckSquare className="h-3.5 w-3.5" />{selectMode ? 'Done selecting' : 'Select galleries'}</Button>
              </div>
              <Button size="sm" className="h-11" variant="outline" onClick={openManageWatches}><Settings2 className="h-3.5 w-3.5" />Manage watches{watches ? ` (${watches.length})` : ''}</Button>
            </div>
            {(showFolderFilter || showWatchFilter || showSourceFilter) && <div className="flex min-w-0 flex-wrap gap-3">
              {showFolderFilter && <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs font-medium text-muted lg:max-w-xs">Folder
                <Select className="h-11" aria-label="Filter discoveries by folder" value={feedFolder} onChange={event => { setFeedFolder(event.target.value); setFeedWatch(''); setFeedPage(1); }} disabled={!foldersQuery.isSuccess}>
                  <option value="">All folders</option><option value="unfiled">Unfiled</option>
                  {(foldersQuery.data ?? []).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </Select>
              </label>}
              {showWatchFilter && <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs font-medium text-muted lg:max-w-xs">Watch
                <Select className="h-11" aria-label="Filter discoveries by watch" value={feedWatch} onChange={event => { setFeedWatch(event.target.value); setFeedPage(1); }}>
                  <option value="">All watches</option>
                  {feedWatches?.map(watch => <option key={watch.id} value={watch.id}>{SOURCE_LABELS[watch.source]} · {watch.watchLabel}{watch.removed ? ' (removed watch)' : ''}</option>)}
                </Select>
              </label>}
              {showSourceFilter && <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs font-medium text-muted lg:max-w-[12rem]">Source
                <Select className="h-11" aria-label="Filter discoveries by source" value={feedSource} onChange={event => { setFeedSource(event.target.value); setFeedPage(1); }}><option value="">All sources</option><option value="hitomi">Hitomi.la</option><option value="nhentai">nHentai</option></Select>
              </label>}
            </div>}
            {foldersQuery.isError && <ErrorState title="Could not load folder filters" description={foldersQuery.error.message} onRetry={() => void foldersQuery.refetch()} />}
            {reviewableSelectedItems.length > 0 && <div className="flex justify-end">
              <Button size="sm" variant="outline" disabled={reviewingKeys.size > 0} onClick={() => void reviewDiscoveries(reviewableSelectedItems, true)}><Check className="h-3.5 w-3.5" />{reviewableSelectedItems.length === selectedItems.length ? 'Dismiss selected' : `Dismiss ${reviewableSelectedItems.length} finds`}</Button>
            </div>}
            {showSelection && <GallerySelectionBar {...selectionActions} />}
            {feedFailed ? <SearchFailure title="Could not load discoveries" subject="Your discoveries" error={feedError} onRetry={() => void retryFeed()} /> : !galleryFeed && feedLoading ? (
              <GallerySkeletonGrid label="Loading discoveries" count={6} />
            ) : feedItems.length ? (
              <>
                <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {feedPageItems.map(item => {
                    const key = `${item.source}:${item.galleryId}`, meta = feedMetaByKey.get(key);
                    return <div key={key} data-review-pending={reviewingKeys.has(key)} className="watched-discovery flex min-w-0 flex-col gap-1 [&>article]:flex-1">
                      <GalleryCard item={item} onOpen={setSelected} starting={pendingKeys.has(key)} onDownload={doStartDownload} downloadSetup={downloadStatus} ownership={ownershipFor(item)} selection={{ mode: selectMode ? 'select' : 'browse', selected: selectedGalleries.has(key), onToggle: toggleGallerySelect }} display="discovery" review={{ state: reviewingKeys.has(key) ? 'pending' : meta?.reviewedAt ? 'reviewed' : 'unreviewed', onChange: reviewGallery }} />
                      {meta && <div className="flex min-w-0 flex-col gap-1 px-1 text-xs">
                        <button className="min-h-11 break-words text-left text-muted underline-offset-4 hover:text-primary hover:underline line-clamp-2" onClick={() => { setFeedWatch(String(meta.searchId)); setFeedPage(1); }} title={`Filter by ${meta.watchLabel} · ${meta.query}`}>via {meta.watchLabel}{meta.watchRemoved ? ' · removed watch' : ''} · {timeAgo(meta.foundAt)}</button>
                        {meta.reviewedAt && <Button size="sm" variant="ghost" className="min-h-11 justify-start px-1" disabled={reviewingKeys.has(key)} onClick={() => reviewGallery(item, false)}><RotateCcw className="h-3.5 w-3.5" />Return to inbox</Button>}
                      </div>}
                    </div>;
                  })}
                </div>
                <Pager page={feedCurPage} count={feedPageCount} onPageChange={page => { setFeedPage(page); document.querySelector('main')?.scrollTo({ top: 0 }); }} />
              </>
            ) : (
              <div className="flex flex-col items-center">
                <EmptyState icon={<Star className="h-8 w-8" />}
                  title={feedWatch || feedSource || feedFolder ? 'No matching discoveries' : watches?.length === 0 ? 'Nothing followed yet' : feedView === 'inbox' ? 'Inbox is clear' : 'No discoveries yet'}
                  description={feedWatch || feedSource || feedFolder ? 'Clear a filter to see the rest.' : watches?.length === 0 ? 'Choose Watch on a single-source search, or add a search to follow. New finds land here for review.' : feedView === 'inbox' ? 'New finds from your watched searches will appear here.' : 'Dismissed finds are kept here.'} />
                {!feedWatch && !feedSource && !feedFolder && <Button variant="outline" className="-mt-6 mb-10 min-h-11" onClick={openManageWatches}><Settings2 className="h-3.5 w-3.5" />{watches?.length === 0 ? 'Add a watched search' : 'Manage watches'}</Button>}
              </div>
            )}
          </section>
          <WatchedManagerDrawer open={manageWatchesOpen} onOpenChange={setManageWatchesOpen} returnFocusTo={manageWatchesTrigger} onOpenSearch={(src, q) => searchTagFragment(q, src)} />
        </div>
      )}
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
            setUnifiedSelected((prev) => prev.filter((s) => !queued.has(`${s.source}:${s.galleryId}`)));
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
              setUnifiedSelected((prev) => prev.map((s) => (s.entryId === unifiedSelectedEntry.entryId ? { ...s, source: v.source, galleryId: v.galleryId } : s)));
            }}
            onClose={() => setUnifiedSelectedEntry(null)}
            checking={pendingKeys.has(key)}
            downloaded={downloadedAt.has(key) || libraryMatches.get(key) === 'owned' || ownedKeys.has(key)}
            inLibrary={libraryMatches.get(key) === 'owned'}
            setup={setup}
            onDownload={() => doStartDownload(item)}
            onSearchTag={searchTagFragment}
          />
        );
      })()}

      {/* Download manager — own component so live task ticks never re-render the page */}
      {tab === 'manager' && <ManagerTab />}

      </TabPanel>
      {showSelection && <GallerySelectionBar {...(searchAll ? unifiedSelectionActions : selectionActions)} mobile onHeightChange={setSelectionHeight} />}
      {duplicateDialog}
    </div>
  );
}
