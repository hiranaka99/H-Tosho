import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { DoujinSearchResult } from '../downloader/types.js';
import type { DoujinSource } from '../contracts/doujin.js';

export interface RecommendationFeedback {
  liked: DoujinSearchResult[];
  mutedArtists: string[];
  mutedTags: string[];
}
const KEY = 'recommendation-feedback-v1';
export const normalizeArtist = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
export const normalizeTag = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/^(?:female|male|tag):/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
const sameGallery = (a: { source: string; galleryId: string }, b: { source: string; galleryId: string }) => a.source === b.source && a.galleryId === b.galleryId;

export function getRecommendationFeedback(): RecommendationFeedback {
  try {
    const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, KEY)).get();
    const stored = JSON.parse(row?.valueJson ?? '{}');
    return {
      liked: (Array.isArray(stored.liked) ? stored.liked : []).filter((item: DoujinSearchResult) => item && item.source === 'hitomi' && typeof item.galleryId === 'string'
        && typeof item.title === 'string' && Array.isArray(item.artists) && item.artists.every(a => typeof a === 'string') && Array.isArray(item.tags) && item.tags.every(t => typeof t === 'string')),
      mutedArtists: (Array.isArray(stored.mutedArtists) ? stored.mutedArtists : []).filter((a: unknown) => typeof a === 'string'),
      mutedTags: (Array.isArray(stored.mutedTags) ? stored.mutedTags : []).filter((t: unknown) => typeof t === 'string'),
    };
  } catch { return { liked: [], mutedArtists: [], mutedTags: [] }; }
}

export type FeedbackAction = 'like' | 'unlike' | 'mute-artist' | 'unmute-artist' | 'mute-tag' | 'unmute-tag';
export function saveRecommendationFeedback(action: FeedbackAction, target: { source: DoujinSource; galleryId: string; artist?: string; tag?: string }, item?: DoujinSearchResult): RecommendationFeedback {
  const feedback = getRecommendationFeedback();
  if (action === 'like') {
    if (!item) throw new Error('Gallery metadata is required');
    // One bounded preference vote per gallery, not one vote per click.
    const tags = item.tags.slice(0, 100);
    const tagNamespaces = item.tagNamespaces?.slice(0, tags.length);
    const parodies = item.parodies?.slice(0, 20);
    feedback.liked = [...feedback.liked.filter(g => !sameGallery(g, target)), {
      source: item.source, galleryId: item.galleryId, title: item.title, artists: item.artists.slice(0, 30), tags,
      ...(tagNamespaces?.some(ns => ns !== undefined) ? { tagNamespaces } : {}),
      ...(parodies?.length ? { parodies } : {}),
      language: item.language,
    }];
    if (feedback.liked.length > 500) throw new Error('Preference limit reached (500). Remove a preference first.');
  }
  if (action === 'unlike') feedback.liked = feedback.liked.filter(g => !sameGallery(g, target));
  if (action === 'mute-artist') {
    const name = item?.artists.find(a => normalizeArtist(a) === normalizeArtist(target.artist ?? ''));
    if (!name) throw new Error('Choose an artist listed for this gallery');
    feedback.mutedArtists = [...new Set([...feedback.mutedArtists.map(normalizeArtist), normalizeArtist(name)])];
    if (feedback.mutedArtists.length > 500) throw new Error('Muted artist limit reached (500). Unmute an artist first.');
  }
  if (action === 'unmute-artist') feedback.mutedArtists = feedback.mutedArtists.filter(a => normalizeArtist(a) !== normalizeArtist(target.artist ?? ''));
  if (action === 'mute-tag') {
    const name = item?.tags.find(t => normalizeTag(t) === normalizeTag(target.tag ?? ''));
    if (!name) throw new Error('Choose a tag listed for this gallery');
    feedback.mutedTags = [...new Set([...feedback.mutedTags.map(normalizeTag), normalizeTag(name)])];
    if (feedback.mutedTags.length > 500) throw new Error('Muted tag limit reached (500). Unmute a tag first.');
  }
  if (action === 'unmute-tag') feedback.mutedTags = feedback.mutedTags.filter(t => normalizeTag(t) !== normalizeTag(target.tag ?? ''));
  const valueJson = JSON.stringify(feedback);
  getDb().insert(schema.keyValueStore).values({ key: KEY, valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
  return feedback;
}
