import type { DoujinSearchResult, DuplicateReport } from './api';

/** POST /api/downloads/library-matches accepts at most this many galleries per request. */
export const LIBRARY_MATCH_CHUNK = 100;

export interface LibraryMatchCacheEntry {
  report: DuplicateReport | null;
  fetchedAt: number;
}

/**
 * Deduplicate galleries in order, drop entries still fresh in `cache`, and
 * split the unchecked remainder into chunks of `LIBRARY_MATCH_CHUNK`.
 */
export function selectUncheckedGalleries(
  items: readonly DoujinSearchResult[],
  cache: ReadonlyMap<string, LibraryMatchCacheEntry>,
  now: number,
  ttlMs: number,
): DoujinSearchResult[][] {
  const seen = new Set<string>();
  const missing: DoujinSearchResult[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.galleryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < ttlMs) continue;
    missing.push(item);
  }
  const chunks: DoujinSearchResult[][] = [];
  for (let i = 0; i < missing.length; i += LIBRARY_MATCH_CHUNK) {
    chunks.push(missing.slice(i, i + LIBRARY_MATCH_CHUNK));
  }
  return chunks;
}

/** Evict oldest entries in Map insertion order until `cache.size <= maxEntries`. */
export function pruneLibraryMatchCache<T extends { fetchedAt: number }>(
  cache: Map<string, T>,
  maxEntries: number,
): void {
  const limit = Math.max(0, maxEntries);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
