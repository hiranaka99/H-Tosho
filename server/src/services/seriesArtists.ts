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
const MAX_CACHE_ENTRIES = 5000;

export interface SeriesSearchMetadata {
  artists: string[];
  /** null means metadata could not be read; an empty array means no saved tags. */
  tags: string[] | null;
}

interface Entry extends SeriesSearchMetadata {
  at: number;
}

const cache = new Map<number, Entry>();
const inflight = new Map<number, { epoch: number; promise: Promise<SeriesSearchMetadata> }>();
let connectionEpoch = 0;
onSettingChange('kavita-connection', () => { cache.clear(); inflight.clear(); connectionEpoch++; });

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
 * Artists and tags for the given series from Kavita metadata. Fresh cache entries
 * are served immediately; missing/stale ones are fetched with limited
 * concurrency (first load of a large library takes a few seconds). 404s
 * (series without a metadata row) are cached as empty so they are not
 * re-fetched on every poll; other errors are not cached and retry next time.
 */
export async function kavitaSeriesSearchMetadata(client: MetadataSource, seriesIds: number[]): Promise<Map<number, SeriesSearchMetadata>> {
  const epoch = connectionEpoch;
  const now = Date.now();
  const out = new Map<number, SeriesSearchMetadata>();
  const joining: [number, Promise<SeriesSearchMetadata>][] = [];
  const pending: { id: number; resolve: (value: SeriesSearchMetadata) => void }[] = [];
  for (const id of new Set(seriesIds)) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) {
      cache.delete(id);
      cache.set(id, hit);
      out.set(id, hit);
      continue;
    }
    const existing = inflight.get(id);
    if (existing && existing.epoch === epoch) {
      joining.push([id, existing.promise]);
      continue;
    }
    let resolve!: (value: SeriesSearchMetadata) => void;
    const promise = new Promise<SeriesSearchMetadata>((r) => { resolve = r; });
    inflight.set(id, { epoch, promise });
    pending.push({ id, resolve });
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length) {
      const item = pending[next++];
      const { id, resolve } = item;
      let result: SeriesSearchMetadata = { artists: [], tags: null };
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
        result = { artists, tags };
        if (epoch === connectionEpoch) setCacheEntry(id, { artists, tags, at: Date.now() });
      } catch (e) {
        if (isNotFound(e) && epoch === connectionEpoch) {
          setCacheEntry(id, { artists: [], tags: null, at: Date.now() });
        }
      } finally {
        if (inflight.get(id)?.epoch === epoch) inflight.delete(id);
        out.set(id, result);
        resolve(result);
      }
    }
  }
  const workers = pending.length > 0 ? Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()) : [];
  await Promise.all([
    ...workers,
    ...joining.map(async ([id, promise]) => { out.set(id, await promise); }),
  ]);
  return out;
}

/** Compatibility for artist-only consumers; shares the metadata cache. */
export async function kavitaSeriesArtists(client: MetadataSource, seriesIds: number[]): Promise<Map<number, string[]>> {
  const metadata = await kavitaSeriesSearchMetadata(client, seriesIds);
  return new Map([...metadata].map(([id, item]) => [id, item.artists]));
}
