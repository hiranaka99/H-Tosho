import { inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDownloaderSettings } from './settings.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinSearchResult } from '../downloader/types.js';
import { getRecommendationFeedback, normalizeArtist, normalizeTag } from './recommendationFeedback.js';
import { findKnownLibraryDuplicateKeys } from './galleryDuplicates.js';

/** Every selection source passes this policy, including cached cards and history. */
export async function eligibleRecommendations<T extends DoujinSearchResult>(items: T[]): Promise<T[]> {
  const db = getDb();
  const activeDownloads = db
    .select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId })
    .from(schema.downloadQueue)
    .where(inArray(schema.downloadQueue.status, ['completed', 'queued', 'downloading', 'paused']))
    .all();
  const unreviewedFollowing = db
    .select({ source: schema.watchedSearchNew.source, galleryId: schema.watchedSearchNew.galleryId })
    .from(schema.watchedSearchNew)
    .where(isNull(schema.watchedSearchNew.reviewedAt))
    .all();
  const excluded = new Set([
    ...db.select().from(schema.ownedGalleries).all(),
    ...db.select().from(schema.dismissedGalleries).all(),
    ...db.select({ source: schema.galleryTags.source, galleryId: schema.galleryTags.galleryId }).from(schema.galleryTags).all(),
    ...activeDownloads,
    ...unreviewedFollowing,
  ].map((row) => `${row.source}:${row.galleryId}`));
  const libraryDuplicates = findKnownLibraryDuplicateKeys(items);
  const settings = getDownloaderSettings();
  const feedback = getRecommendationFeedback();
  const mutedArtists = new Set(feedback.mutedArtists.map(normalizeArtist));
  const mutedTags = new Set(feedback.mutedTags.map(normalizeTag));
  const normalize = (value: string) => value.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  const allowed = items.filter((item) => {
    const key = `${item.source}:${item.galleryId}`;
    if (item.source !== 'hitomi' || !item.galleryId || !item.title || !Array.isArray(item.tags) || !Array.isArray(item.artists)
      || excluded.has(key) || libraryDuplicates.has(key)) return false;
    if (item.artists.some((a) => mutedArtists.has(normalizeArtist(a)))) return false;
    if (item.tags.some((t) => mutedTags.has(normalizeTag(t)))) return false;
    const fields = new Set([...item.tags, ...item.artists, item.title].map(normalize));
    const artists = new Set(item.artists.map(normalize));
    for (const raw of settings.hitomiBannedTags) {
      const entry = normalize(raw);
      const colon = entry.indexOf(':');
      const namespace = colon < 0 ? '' : entry.slice(0, colon);
      const value = colon < 0 ? entry : entry.slice(colon + 1);
      if (namespace === 'artist' ? artists.has(value) : fields.has(value) || fields.has(entry)) return false;
    }
    return true;
  });
  if (allowed.length === 0 || settings.hitomiBannedTags.length === 0) return allowed;
  const provider = getDoujinProvider('hitomi');
  if (!provider?.filterRecommendations) return allowed;
  try {
    const filtered = await provider.filterRecommendations(allowed);
    const keys = new Set(filtered.map((item) => `${item.source}:${item.galleryId}`));
    return allowed.filter((item) => keys.has(`${item.source}:${item.galleryId}`));
  } catch (error) {
    // A failed exclusion lookup is not permission to recommend excluded content.
    console.warn('[recommendations] exclusion check unavailable:', error);
    return [];
  }
}
