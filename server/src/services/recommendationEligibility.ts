import { getDb, schema } from '../db/index.js';
import { getDownloaderSettings } from './settings.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinSearchResult } from '../downloader/types.js';
import { getRecommendationFeedback, normalizeArtist } from './recommendationFeedback.js';

/** Every selection source passes this policy, including cached cards and history. */
export async function eligibleRecommendations<T extends DoujinSearchResult>(items: T[]): Promise<T[]> {
  const db = getDb();
  const excluded = new Set([
    ...db.select().from(schema.ownedGalleries).all(),
    ...db.select().from(schema.dismissedGalleries).all(),
    ...db.select({ source: schema.galleryTags.source, galleryId: schema.galleryTags.galleryId }).from(schema.galleryTags).all(),
  ].map((row) => `${row.source}:${row.galleryId}`));
  const settings = getDownloaderSettings();
  const feedback = getRecommendationFeedback();
  const muted = new Set(feedback.mutedArtists.map(normalizeArtist));
  const normalize = (value: string) => value.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  const allowed = items.filter((item) => {
    if (item.source !== 'hitomi' || !item.galleryId || !item.title || !Array.isArray(item.tags) || !Array.isArray(item.artists) || excluded.has(`${item.source}:${item.galleryId}`)) return false;
    if (item.artists.some(a => muted.has(normalizeArtist(a)))) return false;
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
