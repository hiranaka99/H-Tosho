import type { KavitaSeriesMetadataDto } from '../kavita/types.js';
import { invalidateRecommendationSeries } from './recommendationSignals.js';

/** Minimal client surface the cache needs — satisfied by KavitaClient. */
export interface MetadataSource {
  getSeriesMetadata(seriesId: number): Promise<Pick<KavitaSeriesMetadataDto, 'pencillers' | 'inkers' | 'writers'>>;
}

/**
 * Artist names per series, sourced from Kavita's own series metadata.
 *
 * Matched series carry provider artists in the local match row (and H-Tosho
 * pushes them into Kavita's penciller role), but unmatched entries have no
 * match row at all — their people live only in Kavita metadata. `/Series/all-v2`
 * does not embed metadata, so names are fetched per series and cached here.
 */

/** How long a fetched (or definitively empty) result stays fresh. */
const TTL_MS = 60 * 60 * 1000;
/** Parallel metadata requests while filling the cache. */
const CONCURRENCY = 8;

interface Entry {
  artists: string[];
  at: number;
}

const cache = new Map<number, Entry>();

/** Drop one series' cached names (call after Kavita metadata is rewritten). */
export function invalidateSeriesArtists(seriesId: number): void {
  cache.delete(seriesId);
  invalidateRecommendationSeries(seriesId);
}

/** Roles treated as "artist" for search purposes, in display priority order. */
function artistNames(meta: Pick<KavitaSeriesMetadataDto, 'pencillers' | 'inkers' | 'writers'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const person of [...(meta.pencillers ?? []), ...(meta.inkers ?? []), ...(meta.writers ?? [])]) {
    const name = person.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && e.message.includes('HTTP 404');
}

/**
 * Artist names for the given series from Kavita metadata. Fresh cache entries
 * are served immediately; missing/stale ones are fetched with limited
 * concurrency (first load of a large library takes a few seconds). 404s
 * (series without a metadata row) are cached as empty so they are not
 * re-fetched on every poll; other errors are not cached and retry next time.
 */
export async function kavitaSeriesArtists(client: MetadataSource, seriesIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const pending: number[] = [];
  for (const id of seriesIds) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) out.set(id, hit.artists);
    else pending.push(id);
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length) {
      const id = pending[next++];
      try {
        const meta = await client.getSeriesMetadata(id);
        const artists = artistNames(meta);
        cache.set(id, { artists, at: Date.now() });
        out.set(id, artists);
      } catch (e) {
        if (isNotFound(e)) {
          cache.set(id, { artists: [], at: Date.now() });
          out.set(id, []);
        } else {
          // Transient failure: leave uncached so the next poll retries.
          out.set(id, []);
        }
      }
    }
  }
  const workers = pending.length > 0 ? Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()) : [];
  await Promise.all(workers);
  return out;
}
