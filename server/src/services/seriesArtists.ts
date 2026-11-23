import type { KavitaSeriesMetadataDto } from '../kavita/types.js';
import { invalidateRecommendationSeries } from './recommendationSignals.js';
import { onSettingChange } from './settings.js';

/** Minimal client surface the cache needs — satisfied by KavitaClient. */
export interface MetadataSource {
  getSeriesMetadata(seriesId: number): Promise<Pick<KavitaSeriesMetadataDto, 'pencillers' | 'inkers' | 'writers'> & Partial<Pick<KavitaSeriesMetadataDto, 'tags'>>>;
}

/**
 * Searchable artists and tags, sourced from Kavita's own series metadata.
 *
 * Matched series carry provider artists in the local match row (and H-Tosho
 * pushes them into Kavita's penciller role), but unmatched entries have no
 * match row at all — their people live only in Kavita metadata. `/Series/all-v2`
 * does not embed metadata, so names are fetched per series and cached here.
 */

/** How long a fetched (or definitively empty) result stays fresh. */
const TTL_MS = 5 * 60 * 1000;
/** Parallel metadata requests while filling the cache. */
const CONCURRENCY = 8;
/** Parallel metadata requests while re-reading expired entries nobody is waiting on. */
const BACKGROUND_CONCURRENCY = 4;

export interface SeriesSearchMetadata {
  artists: string[];
  /** null means metadata could not be read; an empty array means no saved tags. */
  tags: string[] | null;
}

interface Entry extends SeriesSearchMetadata {
  at: number;
}

const cache = new Map<number, Entry>();
/** Stale ids already being re-read in the background, so repeated polls never stack refreshes. */
const refreshing = new Set<number>();
/** Bumped on invalidation so a read that started before a metadata write cannot cache the old values. */
const generations = new Map<number, number>();
let connectionEpoch = 0;
onSettingChange('kavita-connection', () => { cache.clear(); connectionEpoch++; });

/** Drop cached artists and tags after Kavita metadata is rewritten. */
export function invalidateSeriesArtists(seriesId: number): void {
  cache.delete(seriesId);
  generations.set(seriesId, (generations.get(seriesId) ?? 0) + 1);
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

/** Fetch metadata for `ids` with bounded concurrency, caching definitive answers. */
async function readMetadata(client: MetadataSource, ids: readonly number[], concurrency: number, epoch: number): Promise<Map<number, SeriesSearchMetadata>> {
  const out = new Map<number, SeriesSearchMetadata>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < ids.length) {
      const id = ids[next++];
      const generation = generations.get(id) ?? 0;
      const remember = (entry: SeriesSearchMetadata) => {
        if (epoch === connectionEpoch && generation === (generations.get(id) ?? 0)) cache.set(id, { ...entry, at: Date.now() });
      };
      try {
        const meta = await client.getSeriesMetadata(id);
        const artists = artistNames(meta);
        const seen = new Set<string>();
        const tags = meta.tags === undefined ? null : (meta.tags ?? []).flatMap(tag => {
          const title = tag.title?.trim();
          if (!title || seen.has(title.toLowerCase())) return [];
          seen.add(title.toLowerCase());
          return [title];
        });
        remember({ artists, tags });
        out.set(id, { artists, tags });
      } catch (e) {
        if (isNotFound(e)) remember({ artists: [], tags: null });
        // A transient failure stays uncached (or keeps its stale entry) so the next request retries.
        out.set(id, { artists: [], tags: null });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return out;
}

/**
 * Artists and tags for the given series from Kavita metadata. Cached entries are
 * served immediately; expired ones are re-read in the background
 * (stale-while-revalidate), so only series never seen before wait on Kavita.
 * The first load of a large library still takes a few seconds; later visits
 * no longer repeat that fan-out every TTL. 404s (series without a metadata row)
 * are cached as empty so they are not re-fetched on every poll; other errors
 * are not cached and retry next time.
 */
export async function kavitaSeriesSearchMetadata(client: MetadataSource, seriesIds: number[]): Promise<Map<number, SeriesSearchMetadata>> {
  const epoch = connectionEpoch;
  const out = new Map<number, SeriesSearchMetadata>();
  const missing: number[] = [];
  const stale: number[] = [];
  const now = Date.now();
  for (const id of new Set(seriesIds)) {
    const hit = cache.get(id);
    if (!hit) { missing.push(id); continue; }
    out.set(id, hit);
    if (now - hit.at >= TTL_MS && !refreshing.has(id)) stale.push(id);
  }
  if (stale.length > 0) {
    for (const id of stale) refreshing.add(id);
    // Gentler than a blocking fill: this competes with nothing the user waits on.
    void readMetadata(client, stale, BACKGROUND_CONCURRENCY, epoch).finally(() => { for (const id of stale) refreshing.delete(id); });
  }
  if (missing.length > 0) {
    for (const [id, entry] of await readMetadata(client, missing, CONCURRENCY, epoch)) out.set(id, entry);
  }
  return out;
}

/** Compatibility for artist-only consumers; shares the metadata cache. */
export async function kavitaSeriesArtists(client: MetadataSource, seriesIds: number[]): Promise<Map<number, string[]>> {
  const metadata = await kavitaSeriesSearchMetadata(client, seriesIds);
  return new Map([...metadata].map(([id, item]) => [id, item.artists]));
}
