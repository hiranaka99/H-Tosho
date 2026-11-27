import type { KavitaSeriesMetadataDto } from "../kavita/types.js";
import { onSettingChange } from "./settings.js";

export type CachedKavitaMetadata = Pick<
  KavitaSeriesMetadataDto,
  "pencillers" | "inkers" | "writers"
> &
  Partial<
    Pick<KavitaSeriesMetadataDto, "tags" | "genres" | "language" | "webLinks">
  >;

const MAX_CACHE_ENTRIES = 50_000;
const fullMetaCache = new Map<
  number,
  { at: number; meta: CachedKavitaMetadata }
>();

onSettingChange("kavita-connection", () => {
  fullMetaCache.clear();
});

export function setCachedSeriesMetadataForSignals(
  id: number,
  meta: CachedKavitaMetadata,
  at = Date.now()
): void {
  fullMetaCache.delete(id);
  fullMetaCache.set(id, { at, meta });
  while (fullMetaCache.size > MAX_CACHE_ENTRIES) {
    const oldest = fullMetaCache.keys().next().value;
    if (oldest === undefined) break;
    fullMetaCache.delete(oldest);
  }
}

export function getCachedSeriesMetadataForSignals(
  seriesId: number,
  maxAgeMs: number
): CachedKavitaMetadata | null {
  const hit = fullMetaCache.get(seriesId);
  if (!hit || Date.now() - hit.at >= maxAgeMs) return null;
  fullMetaCache.delete(seriesId);
  fullMetaCache.set(seriesId, hit);
  return hit.meta;
}

export function clearCachedSeriesMetadataForSignals(seriesId: number): void {
  fullMetaCache.delete(seriesId);
}
