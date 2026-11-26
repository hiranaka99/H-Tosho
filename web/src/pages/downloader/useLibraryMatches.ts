import * as React from 'react';
import { api, type DoujinSearchResult, type DuplicateReport } from '../../lib/api';
import {
  LIBRARY_MATCH_CHUNK,
  pruneLibraryMatchCache,
  selectUncheckedGalleries,
  type LibraryMatchCacheEntry,
} from '../../lib/libraryMatchBatcher';

const MAX_CACHE_ENTRIES = 1000;
const matchCache = new Map<string, LibraryMatchCacheEntry>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let lastResetKey: string | null = null;

function notifyListeners() {
  for (const listener of listeners) listener();
}

export function clearLibraryMatchCache(): void {
  matchCache.clear();
  lastResetKey = null;
  notifyListeners();
}

/**
 * Incrementally fetch `/api/downloads/library-matches` only for galleries not
 * yet cached within `ttlMs` (including 0-match results), shared across mounts.
 */
export function useLibraryMatchReports(
  items: readonly DoujinSearchResult[],
  options?: { resetKey?: string | null; ttlMs?: number },
): ReadonlyMap<string, DuplicateReport> {
  const resetKey = options?.resetKey ?? null;
  const ttlMs = options?.ttlMs ?? 60_000;
  const [, bump] = React.useReducer((tick: number) => tick + 1, 0);
  const itemsRef = React.useRef(items);
  itemsRef.current = items;

  React.useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  const itemsKey = React.useMemo(() => {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const item of items) {
      const key = `${item.source}:${item.galleryId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys.join(',');
  }, [items]);

  React.useEffect(() => {
    if (resetKey !== null) {
      if (lastResetKey !== null && lastResetKey !== resetKey) {
        matchCache.clear();
        notifyListeners();
      }
      lastResetKey = resetKey;
    }

    const unchecked = selectUncheckedGalleries(itemsRef.current, matchCache, Date.now(), ttlMs);
    const pending: DoujinSearchResult[] = [];
    for (const chunk of unchecked) {
      for (const item of chunk) {
        const key = `${item.source}:${item.galleryId}`;
        if (!inflight.has(key)) pending.push(item);
      }
    }
    if (!pending.length) return;

    const chunks: DoujinSearchResult[][] = [];
    for (let i = 0; i < pending.length; i += LIBRARY_MATCH_CHUNK) {
      chunks.push(pending.slice(i, i + LIBRARY_MATCH_CHUNK));
    }

    for (const chunk of chunks) {
      const chunkKeys = chunk.map((item) => `${item.source}:${item.galleryId}`);
      for (const key of chunkKeys) inflight.add(key);
      void (async () => {
        try {
          const response = await api.libraryMatches(chunk);
          const fetchedAt = Date.now();
          const byKey = new Map<string, DuplicateReport>();
          for (const report of response.reports) {
            byKey.set(`${report.source}:${report.galleryId}`, report);
          }
          for (const key of chunkKeys) {
            // Re-insert so recently checked entries stay at the tail of Map order.
            matchCache.delete(key);
            matchCache.set(key, { report: byKey.get(key) ?? null, fetchedAt });
          }
          pruneLibraryMatchCache(matchCache, MAX_CACHE_ENTRIES);
          notifyListeners();
        } catch {
          // Leave uncached so future renders/retries can re-check transient errors.
        } finally {
          for (const key of chunkKeys) inflight.delete(key);
        }
      })();
    }
  }, [itemsKey, resetKey, ttlMs]);

  const prevResultRef = React.useRef<ReadonlyMap<string, DuplicateReport>>(new Map());
  const nextResult = new Map<string, DuplicateReport>();
  const now = Date.now();
  for (const item of items) {
    const key = `${item.source}:${item.galleryId}`;
    if (nextResult.has(key)) continue;
    const entry = matchCache.get(key);
    if (entry && now - entry.fetchedAt < ttlMs && entry.report) {
      nextResult.set(key, entry.report);
    }
  }

  const prev = prevResultRef.current;
  let same = prev.size === nextResult.size;
  if (same) {
    for (const [k, v] of nextResult) {
      if (prev.get(k) !== v) {
        same = false;
        break;
      }
    }
  }
  if (!same) prevResultRef.current = nextResult;
  return prevResultRef.current;
}
