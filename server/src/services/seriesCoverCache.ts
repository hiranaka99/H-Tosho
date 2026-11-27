const COVER_CACHE_MAX_ENTRIES = 200;
const COVER_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export interface CachedSeriesCover {
  seriesId: number;
  data: Buffer;
  contentType: string;
  etag: string;
}

const seriesCoverCache = new Map<string, CachedSeriesCover>();
let seriesCoverCacheBytes = 0;
export const seriesCoverInflight = new Map<
  string,
  Promise<CachedSeriesCover>
>();

function deleteSeriesCoverEntry(key: string): void {
  const existing = seriesCoverCache.get(key);
  if (!existing) return;
  seriesCoverCache.delete(key);
  seriesCoverCacheBytes -= existing.data.length;
}

export function getSeriesCoverEntry(
  key: string
): CachedSeriesCover | undefined {
  const entry = seriesCoverCache.get(key);
  if (!entry) return undefined;
  seriesCoverCache.delete(key);
  seriesCoverCache.set(key, entry);
  return entry;
}

export function setSeriesCoverEntry(
  key: string,
  entry: CachedSeriesCover
): void {
  deleteSeriesCoverEntry(key);
  if (entry.data.length > COVER_CACHE_MAX_BYTES) return;
  while (
    seriesCoverCache.size >= COVER_CACHE_MAX_ENTRIES ||
    (seriesCoverCacheBytes + entry.data.length > COVER_CACHE_MAX_BYTES &&
      seriesCoverCache.size > 0)
  ) {
    const oldest = seriesCoverCache.keys().next().value;
    if (oldest === undefined) break;
    deleteSeriesCoverEntry(oldest);
  }
  seriesCoverCache.set(key, entry);
  seriesCoverCacheBytes += entry.data.length;
}

export function invalidateSeriesCoverCache(seriesId?: number): void {
  if (seriesId === undefined) {
    seriesCoverCache.clear();
    seriesCoverCacheBytes = 0;
    seriesCoverInflight.clear();
    return;
  }
  for (const [key, entry] of Array.from(seriesCoverCache.entries())) {
    if (entry.seriesId === seriesId) deleteSeriesCoverEntry(key);
  }
  const marker = `\0${seriesId}\0`;
  for (const key of Array.from(seriesCoverInflight.keys())) {
    if (key.includes(marker)) seriesCoverInflight.delete(key);
  }
}
