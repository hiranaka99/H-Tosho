import { KavitaClient } from '../kavita/client.js';
import type { KavitaSeries } from '../kavita/types.js';
import { mapLimit } from '../lib/http.js';
import { getKavitaConnection, getRecommendationSettings, onSettingChange } from './settings.js';

export interface KavitaSeriesSignal {
  name: string;
  tags: string[];
  artists: string[];
}

const SERIES_LIMIT = 600;
const TTL_MS = 30 * 60_000;
let connectionKey = '';
let listing: { at: number; series: KavitaSeries[] } | null = null;
const metadata = new Map<number, { at: number; signal: KavitaSeriesSignal }>();
const listeners = new Set<() => void>();

export function onRecommendationSeriesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateRecommendationSeries(seriesId: number): void {
  metadata.delete(seriesId);
  listing = null;
  for (const listener of listeners) listener();
}

export function clearRecommendationSignals(): void {
  listing = null;
}

onSettingChange('kavita-connection', () => {
  connectionKey = '';
  listing = null;
  metadata.clear();
});

/** Round-robin sampling prevents the first large library starving later libraries. */
export function balancedSeries(libraries: KavitaSeries[][], limit = SERIES_LIMIT): KavitaSeries[] {
  const result: KavitaSeries[] = [];
  const seen = new Set<number>();
  for (let offset = 0; result.length < limit; offset++) {
    let found = false;
    for (const library of libraries) {
      const series = library[offset];
      if (!series) continue;
      found = true;
      if (!seen.has(series.id)) {
        seen.add(series.id);
        result.push(series);
        if (result.length === limit) break;
      }
    }
    if (!found) break;
  }
  return result;
}

export async function buildKavitaSignals(): Promise<KavitaSeriesSignal[]> {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return [];
  const excluded = new Set(getRecommendationSettings().excludedLibraryIds);
  const key = JSON.stringify([conn.baseUrl, conn.apiKey, [...excluded].sort((a, b) => a - b)]);
  if (connectionKey !== key) {
    connectionKey = key;
    listing = null;
  }
  const client = new KavitaClient(conn.baseUrl, conn.apiKey);
  if (!listing || Date.now() - listing.at >= TTL_MS) {
    try {
      const libraries = (await client.getLibraries()).filter((library) => !excluded.has(library.id));
      let failed = false;
      const lists = await mapLimit(libraries, 4, async (library) => {
        try { return await client.getSeries(library.id); }
        catch { failed = true; return []; }
      });
      const series = balancedSeries(lists);
      listing = { at: failed ? 0 : Date.now(), series };
      const retained = new Set(series.map((item) => item.id));
      for (const id of metadata.keys()) if (!retained.has(id)) metadata.delete(id);
    } catch (error) {
      console.warn('[recommendations] Kavita library scan skipped:', error);
      return [];
    }
  }
  return mapLimit(listing.series, 8, async (series) => {
    const cached = metadata.get(series.id);
    if (cached && Date.now() - cached.at < TTL_MS && cached.signal.name === series.name) return cached.signal;
    try {
      const meta = await client.getSeriesMetadata(series.id);
      const signal = {
        name: series.name,
        tags: [...(meta.genres ?? []), ...(meta.tags ?? [])].map((tag) => tag.title?.trim() ?? '').filter(Boolean),
        // Artist/language behavior intentionally unchanged by this cutover.
        artists: (meta.writers ?? []).map((person) => person.name?.trim() ?? '').filter(Boolean),
      };
      metadata.set(series.id, { at: Date.now(), signal });
      return signal;
    } catch {
      return cached?.signal ?? { name: series.name, tags: [], artists: [] };
    }
  });
}
