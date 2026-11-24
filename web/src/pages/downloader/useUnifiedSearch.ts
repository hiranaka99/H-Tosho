/**
 * Client state for the unified search tab (plan P2.5/P2.6).
 *
 * Isolated from the native per-source search state: draft + committed query
 * live here, results/cursor/lanes live in memory, and sessionStorage holds
 * only non-sensitive text. A restored committed query starts a fresh server
 * session — dead cursors and stale restricted results are never restored.
 * Responses carry their request sequence; a superseded or aborted response
 * can never replace a newer search. A new search streams: each provider's
 * cards are appended as it answers, and the final page fills in the rest.
 */
import * as React from 'react';
import { api, ApiError, type DoujinSearchResult, type ProviderSearchStatus, type PublicDoujinSearchResult, type UnifiedSearchEntry } from '../../lib/api';
import { writeDownloaderState } from './state';

/** Map the server's public DTO onto the web result type the cards consume. */
export function toWebResult(pub: PublicDoujinSearchResult): DoujinSearchResult {
  return {
    source: pub.source,
    galleryId: pub.galleryId,
    title: pub.title,
    coverUrl: pub.coverUrl,
    tags: pub.tags,
    artists: pub.artists,
    language: pub.language,
    pageCount: pub.pageCount,
    uploadedAt: pub.uploadedAt,
    url: pub.url ?? undefined,
  };
}

const variantKey = (e: { source: string; galleryId: string }) => `${e.source}:${e.galleryId}`;

export type UnifiedStatus = 'idle' | 'searching' | 'loading-more';
export interface UnifiedSessionError {
  message: string;
  kind: 'query' | 'session';
}

interface UnifiedState {
  draft: string;
  committed: string | null;
  status: UnifiedStatus;
  entries: UnifiedSearchEntry[];
  cursor: string | null;
  hasMore: boolean;
  loadedUniqueCount: number;
  totalUnique: number | null;
  providers: ProviderSearchStatus[];
  error: UnifiedSessionError | null;
  retrying: string | null;
}

const INITIAL: UnifiedState = {
  draft: '',
  committed: null,
  status: 'idle',
  entries: [],
  cursor: null,
  hasMore: false,
  loadedUniqueCount: 0,
  totalUnique: null,
  providers: [],
  error: null,
  retrying: null,
};

type Action =
  | { type: 'draft'; value: string }
  | { type: 'start'; query: string }
  | { type: 'clear' }
  | { type: 'busy-more' }
  | { type: 'progress'; items: UnifiedSearchEntry[]; updates: UnifiedSearchEntry[]; loadedUniqueCount: number; providers: ProviderSearchStatus[] }
  | { type: 'page'; items: UnifiedSearchEntry[]; updates: UnifiedSearchEntry[]; cursor: string | null; hasMore: boolean; loadedUniqueCount: number; totalUnique: number | null; providers: ProviderSearchStatus[] }
  | { type: 'retry'; source: string }
  | { type: 'cancel' }
  | { type: 'fail'; error: UnifiedSessionError };

/** Merge a late group update into a delivered entry without moving it: the
 *  primary stays stable (P2.3.9) and duplicate variants are dropped. */
function mergeEntry(existing: UnifiedSearchEntry, update: UnifiedSearchEntry): UnifiedSearchEntry {
  const seen = new Set(existing.variants.map(variantKey));
  const extra = update.variants.filter((v) => !seen.has(variantKey(v)));
  return extra.length ? { ...existing, variants: [...existing.variants, ...extra] } : existing;
}

/** Append new cards and merge updates. A card already shown (sent by a
 *  progress event, then repeated by the final page) keeps its position and
 *  only gains variants it lacks. */
function applyEntries(current: UnifiedSearchEntry[], items: UnifiedSearchEntry[], updates: UnifiedSearchEntry[]): UnifiedSearchEntry[] {
  const index = new Map(current.map((e, i) => [e.entryId, i]));
  const entries = [...current];
  for (const item of items) {
    const idx = index.get(item.entryId);
    if (idx === undefined) {
      index.set(item.entryId, entries.length);
      entries.push(item);
    } else {
      entries[idx] = mergeEntry(entries[idx], item);
    }
  }
  for (const update of updates) {
    const idx = index.get(update.entryId);
    if (idx !== undefined) entries[idx] = mergeEntry(entries[idx], update);
  }
  return entries;
}

export function reducer(state: UnifiedState, action: Action): UnifiedState {
  switch (action.type) {
    case 'draft':
      return { ...state, draft: action.value };
    case 'start':
      return {
        ...INITIAL,
        draft: state.draft,
        committed: action.query,
        status: 'searching',
        totalUnique: null,
      };
    case 'clear':
      return { ...INITIAL, draft: state.draft };
    case 'busy-more':
      return { ...state, status: 'loading-more' };
    case 'progress':
      // Only a search still in flight takes partial results.
      if (state.status !== 'searching') return state;
      return {
        ...state,
        entries: applyEntries(state.entries, action.items, action.updates),
        loadedUniqueCount: action.loadedUniqueCount,
        providers: action.providers,
      };
    case 'page': {
      return {
        ...state,
        entries: applyEntries(state.entries, action.items, action.updates),
        cursor: action.cursor,
        hasMore: action.hasMore,
        loadedUniqueCount: action.loadedUniqueCount,
        totalUnique: action.totalUnique ?? null,
        providers: action.providers,
        status: 'idle',
        error: null,
        retrying: null,
      };
    }
    case 'retry':
      return { ...state, status: 'loading-more', retrying: action.source };
    case 'cancel':
      // The current request was aborted without being replaced (the hook
      // unmounted). Leave the busy state so the search can start again.
      return { ...state, status: 'idle', retrying: null };
    case 'fail':
      return { ...state, status: 'idle', error: action.error, retrying: null };
  }
}

function classifyError(e: unknown): UnifiedSessionError | null {
  if (e instanceof DOMException && e.name === 'AbortError') return null;
  if (e instanceof ApiError) {
    const kind = e.details.kind;
    if (kind === 'expired' || kind === 'stale' || kind === 'invalidated') {
      return { message: e.message, kind: 'session' };
    }
    return { message: e.message, kind: e.status === 400 ? 'query' : 'session' };
  }
  return { message: e instanceof Error ? e.message : String(e), kind: 'session' };
}

export function useUnifiedSearch(visible: boolean) {
  const [state, dispatch] = React.useReducer(reducer, undefined, () => {
    const saved = ((): { unifiedQuery?: string; unifiedSearchKey?: string | null } => {
      try {
        return JSON.parse(sessionStorage.getItem('h-tosho:downloader-state') ?? '{}');
      } catch {
        return {};
      }
    })();
    return {
      ...INITIAL,
      draft: saved.unifiedQuery ?? '',
      committed: saved.unifiedSearchKey?.trim() ? saved.unifiedSearchKey : null,
    };
  });

  const seqRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const startedRef = React.useRef(false);

  // Persist only non-sensitive text, debounced like the native search state.
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      writeDownloaderState({ unifiedQuery: state.draft, unifiedSearchKey: state.committed });
    }, 300);
    return () => window.clearTimeout(t);
  }, [state.draft, state.committed]);

  // Unmounting aborts the request in flight and forgets that a restored
  // query was started. React StrictMode unmounts and remounts every component
  // once in development: without the reset, the restored search was aborted
  // and never restarted, leaving the tab on its loading skeleton forever.
  React.useEffect(() => () => {
    abortRef.current?.abort();
    startedRef.current = false;
  }, []);

  function run(body: { query?: string; cursor?: string; retry?: string }, busy: 'start' | 'retry' | 'more') {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    if (busy === 'start') dispatch({ type: 'start', query: body.query!.trim() });
    else if (busy === 'retry') dispatch({ type: 'retry', source: body.retry! });
    else dispatch({ type: 'busy-more' });
    const request = busy === 'start'
      ? api.unifiedSearchStream(body.query!.trim(), (progress) => {
        if (seq === seqRef.current) dispatch({ type: 'progress', ...progress });
      }, controller.signal)
      : api.unifiedSearch(body, controller.signal);
    void request
      .then((page) => {
        if (seq !== seqRef.current) return;
        dispatch({
          type: 'page',
          items: page.items,
          updates: page.updates,
          cursor: page.nextCursor,
          hasMore: page.hasMore,
          loadedUniqueCount: page.loadedUniqueCount,
          totalUnique: page.totalUnique ?? null,
          providers: page.providers,
        });
      })
      .catch((e) => {
        // A newer search or reset bumps the sequence first, so only an abort
        // that nothing replaced (unmount) reaches 'cancel'.
        if (seq !== seqRef.current) return;
        const error = classifyError(e);
        dispatch(error ? { type: 'fail', error } : { type: 'cancel' });
      });
  }

  const startSearch = React.useCallback((query?: string) => {
    const q = (query ?? state.draft).trim();
    if (!q) return;
    if (query !== undefined) dispatch({ type: 'draft', value: query });
    run({ query: q }, 'start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.draft]);

  const loadMore = React.useCallback(() => {
    if (state.status !== 'idle' || !state.cursor || !state.hasMore) return;
    run({ cursor: state.cursor }, 'more');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.cursor, state.hasMore]);
  const retrySource = React.useCallback((source: string) => {
    if (state.status !== 'idle' || !state.cursor) return;
    run({ cursor: state.cursor, retry: source }, 'retry');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.cursor]);

  const setDraft = React.useCallback((value: string) => dispatch({ type: 'draft', value }), []);
  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    seqRef.current += 1;
    startedRef.current = false;
    dispatch({ type: 'clear' });
  }, []);

  // Restored committed query: start a fresh session the first time the tab is
  // visible — never for hidden tabs, never after a failed session.
  React.useEffect(() => {
    if (!visible || startedRef.current) return;
    if (!state.committed || state.status !== 'idle' || state.entries.length > 0 || state.error) return;
    startedRef.current = true;
    run({ query: state.committed }, 'start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, state.committed, state.status, state.entries.length, state.error]);

  return {
    ...state,
    setDraft,
    startSearch,
    loadMore,
    retrySource,
    reset,
  };
}

export type UnifiedSearchValue = ReturnType<typeof useUnifiedSearch>;
