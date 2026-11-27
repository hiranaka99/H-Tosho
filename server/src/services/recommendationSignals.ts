import { KavitaClient } from "../kavita/client.js";
import type { KavitaSeries } from "../kavita/types.js";
import { mapLimit } from "../lib/http.js";
import {
  clearCachedSeriesMetadataForSignals,
  getCachedSeriesMetadataForSignals,
  setCachedSeriesMetadataForSignals,
} from "./seriesMetadataCache.js";
import {
  getKavitaConnection,
  getRecommendationSettings,
  onSettingChange,
} from "./settings.js";

export interface KavitaSeriesSignal {
  id?: number;
  libraryId?: number;
  name: string;
  tags: string[];
  /** Genres reported separately by Kavita (kept distinct from ComicInfo/custom tags). */
  genres?: string[];
  artists: string[];
  language?: string | null;
  webLinks?: string | null;
  pages?: number;
  pagesRead?: number;
  totalReads?: number;
  userRating?: number;
  hasUserRated?: boolean;
  created?: string;
  lastAdded?: string;
}

const SERIES_LIMIT = 600;
const TTL_MS = 30 * 60_000;
let connectionKey = "";
let listing: {
  at: number;
  series: KavitaSeries[];
  excludedLibraryPaths: string[];
} | null = null;
const metadata = new Map<number, { at: number; signal: KavitaSeriesSignal }>();
/** Series edited since the listing was read; re-read individually instead of re-listing every library. */
const staleListingSeries = new Set<number>();
const listeners = new Set<() => void>();

export function getExcludedKavitaLibraryPaths(): string[] {
  return listing?.excludedLibraryPaths ?? [];
}

export function onRecommendationSeriesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateRecommendationSeries(seriesId: number): void {
  metadata.delete(seriesId);
  clearCachedSeriesMetadataForSignals(seriesId);
  // One series' sync can rename it, but leaves the rest of the listing valid.
  if (listing) staleListingSeries.add(seriesId);
  for (const listener of listeners) listener();
}

export function clearRecommendationSignals(): void {
  listing = null;
  staleListingSeries.clear();
}

onSettingChange("kavita-connection", () => {
  connectionKey = "";
  listing = null;
  staleListingSeries.clear();
  metadata.clear();
});

/** Re-read edited series in place; any failure falls back to a full re-list. */
async function refreshStaleListingSeries(client: KavitaClient): Promise<void> {
  if (!listing || staleListingSeries.size === 0) return;
  const current = listing;
  const ids = [...staleListingSeries];
  staleListingSeries.clear();
  const positions = new Map(
    current.series.map((series, index) => [series.id, index])
  );
  const sampled = ids.filter((id) => positions.has(id));
  try {
    const fresh = await mapLimit(sampled, 4, (id) => client.getSeriesById(id));
    if (listing !== current) return;
    for (const series of fresh) {
      const index = positions.get(series.id);
      if (index !== undefined) current.series[index] = series;
    }
  } catch {
    if (listing === current) listing = null;
  }
}

/** Round-robin sampling prevents the first large library starving later libraries. */
export function balancedSeries(
  libraries: KavitaSeries[][],
  limit = SERIES_LIMIT
): KavitaSeries[] {
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
  const key = JSON.stringify([
    conn.baseUrl,
    conn.apiKey,
    [...excluded].sort((a, b) => a - b),
  ]);
  if (connectionKey !== key) {
    connectionKey = key;
    listing = null;
  }
  const client = new KavitaClient(conn.baseUrl, conn.apiKey);
  await refreshStaleListingSeries(client);
  if (!listing || Date.now() - listing.at >= TTL_MS) {
    staleListingSeries.clear();
    try {
      const allLibraries = await client.getLibraries();
      const libraries = allLibraries.filter(
        (library) => !excluded.has(library.id)
      );
      const excludedLibraryPaths = allLibraries
        .filter((library) => excluded.has(library.id))
        .flatMap(
          (library) => library.paths ?? (library.path ? [library.path] : [])
        );
      let failed = false;
      const lists = await mapLimit(libraries, 4, async (library) => {
        try {
          return await client.getSeries(library.id);
        } catch {
          failed = true;
          return [];
        }
      });
      const series = balancedSeries(lists);
      listing = { at: failed ? 0 : Date.now(), series, excludedLibraryPaths };
      const retained = new Set(series.map((item) => item.id));
      for (const id of metadata.keys())
        if (!retained.has(id)) metadata.delete(id);
    } catch (error) {
      console.warn("[recommendations] Kavita library scan skipped:", error);
      return [];
    }
  }
  return mapLimit(listing.series, 8, async (series) => {
    const engagement = {
      id: series.id,
      libraryId: series.libraryId,
      pages: series.pages,
      pagesRead: series.pagesRead,
      totalReads: series.totalReads,
      userRating: series.userRating,
      hasUserRated: series.hasUserRated,
      created: series.created,
      lastAdded: series.lastAdded,
    };
    const cached = metadata.get(series.id);
    if (
      cached &&
      Date.now() - cached.at < TTL_MS &&
      cached.signal.name === series.name
    ) {
      return { ...cached.signal, ...engagement };
    }
    try {
      const preloaded = getCachedSeriesMetadataForSignals(series.id, TTL_MS);
      const meta = preloaded ?? (await client.getSeriesMetadata(series.id));
      if (!preloaded) setCachedSeriesMetadataForSignals(series.id, meta);
      const genres = (meta.genres ?? [])
        .map((tag) => tag.title?.trim() ?? "")
        .filter(Boolean);
      const rawTags = (meta.tags ?? [])
        .map((tag) => tag.title?.trim() ?? "")
        .filter(Boolean);
      const seenArtists = new Set<string>();
      const artists: string[] = [];
      for (const person of [
        ...(meta.pencillers ?? []),
        ...(meta.inkers ?? []),
        ...(meta.writers ?? []),
      ]) {
        const name = person.name?.trim() ?? "";
        if (!name || seenArtists.has(name.toLowerCase())) continue;
        seenArtists.add(name.toLowerCase());
        artists.push(name);
      }
      const signal: KavitaSeriesSignal = {
        ...engagement,
        name: series.name,
        tags: [...genres, ...rawTags],
        genres,
        artists,
        language: meta.language ?? null,
        webLinks: meta.webLinks ?? null,
      };
      metadata.set(series.id, { at: Date.now(), signal });
      return signal;
    } catch {
      return cached?.signal
        ? { ...cached.signal, ...engagement }
        : {
            ...engagement,
            name: series.name,
            tags: [],
            genres: [],
            artists: [],
          };
    }
  });
}
