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
/** Above any realistic library size, so one large listing never evicts its own entries mid-request. */
const MAX_CACHE_ENTRIES = 50_000;

export interface SeriesSearchMetadata {
  artists: string[];
  /** null means metadata could not be read; an empty array means no saved tags. */
  tags: string[] | null;
}

interface Entry extends SeriesSearchMetadata {
  at: number;
}

interface Flight {
  epoch: number;
  promise: Promise<SeriesSearchMetadata>;
}

const cache = new Map<number, Entry>();
/** Uncached reads in progress, so concurrent requests for the same series share one fetch. */
const inflight = new Map<number, Flight>();
/** Stale ids already being re-read in the background, so repeated polls never stack refreshes. */
const refreshing = new Set<number>();
/** Bumped on invalidation so a read that started before a metadata write cannot cache the old values. */
const generations = new Map<number, number>();
let connectionEpoch = 0;
onSettingChange('kavita-connection', () => { cache.clear(); inflight.clear(); connectionEpoch++; });

/** Insert as most recently used, evicting the oldest entries past the cap. */
function setCacheEntry(id: number, entry: Entry): void {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drop cached artists and tags after Kavita metadata is rewritten. */
export function invalidateSeriesArtists(seriesId: number): void {
  cache.delete(seriesId);
  inflight.delete(seriesId);
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

/** Read one series' metadata, caching definitive answers unless the connection or series changed meanwhile. Never throws. */
async function readOne(client: MetadataSource, id: number, epoch: number): Promise<SeriesSearchMetadata> {
  const generation = generations.get(id) ?? 0;
  const remember = (entry: SeriesSearchMetadata) => {
    if (epoch === connectionEpoch && generation === (generations.get(id) ?? 0)) setCacheEntry(id, { ...entry, at: Date.now() });
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
    return { artists, tags };
  } catch (e) {
    if (isNotFound(e)) remember({ artists: [], tags: null });
    // A transient failure stays uncached (or keeps its stale entry) so the next request retries.
    return { artists: [], tags: null };
  }
}

/** Run `task` over `items` with at most `concurrency` running at once. */
async function runPool<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) await task(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

/**
 * Artists and tags for the given series from Kavita metadata. Cached entries are
 * served immediately; expired ones are re-read in the background
 * (stale-while-revalidate), so only series never seen before wait on Kavita,
 * and concurrent requests for the same uncached series share one fetch.
 * The first load of a large library still takes a few seconds; later visits
 * no longer repeat that fan-out every TTL. 404s (series without a metadata row)
 * are cached as empty so they are not re-fetched on every poll; other errors
 * are not cached and retry next time.
 */
export async function kavitaSeriesSearchMetadata(client: MetadataSource, seriesIds: number[]): Promise<Map<number, SeriesSearchMetadata>> {
  const epoch = connectionEpoch;
  const out = new Map<number, SeriesSearchMetadata>();
  const stale: number[] = [];
  const joining: [number, Promise<SeriesSearchMetadata>][] = [];
  const pending: { id: number; flight: Flight; resolve: (value: SeriesSearchMetadata) => void }[] = [];
  const now = Date.now();
  for (const id of new Set(seriesIds)) {
    const hit = cache.get(id);
    if (hit) {
      setCacheEntry(id, hit);
      out.set(id, hit);
      if (now - hit.at >= TTL_MS && !refreshing.has(id)) stale.push(id);
      continue;
    }
    const existing = inflight.get(id);
    if (existing && existing.epoch === epoch) {
      joining.push([id, existing.promise]);
      continue;
    }
    let resolve!: (value: SeriesSearchMetadata) => void;
    const flight: Flight = { epoch, promise: new Promise<SeriesSearchMetadata>((r) => { resolve = r; }) };
    inflight.set(id, flight);
    pending.push({ id, flight, resolve });
  }
  if (stale.length > 0) {
    for (const id of stale) refreshing.add(id);
    // Gentler than a blocking fill: this competes with nothing the user waits on.
    void runPool(stale, BACKGROUND_CONCURRENCY, async (id) => { await readOne(client, id, epoch); })
      .finally(() => { for (const id of stale) refreshing.delete(id); });
  }
  await Promise.all([
    runPool(pending, CONCURRENCY, async ({ id, flight, resolve }) => {
      const result = await readOne(client, id, epoch);
      if (inflight.get(id) === flight) inflight.delete(id);
      out.set(id, result);
      resolve(result);
    }),
    ...joining.map(async ([id, promise]) => { out.set(id, await promise); }),
  ]);
  return out;
}
