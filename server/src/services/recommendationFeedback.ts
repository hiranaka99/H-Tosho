import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { DoujinSearchResult, DoujinSource } from '../downloader/types.js';

export interface RecommendationFeedback {
  liked: DoujinSearchResult[];
  mutedArtists: string[];
  snoozed: { source: DoujinSource; galleryId: string; title: string; until: string }[];
}
const KEY = 'recommendation-feedback-v1';
export const normalizeArtist = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
const sameGallery = (a: { source: string; galleryId: string }, b: { source: string; galleryId: string }) => a.source === b.source && a.galleryId === b.galleryId;

export function getRecommendationFeedback(): RecommendationFeedback {
  try {
    const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, KEY)).get();
    const stored = JSON.parse(row?.valueJson ?? '{}');
    return {
      liked: (Array.isArray(stored.liked) ? stored.liked : []).filter((item: DoujinSearchResult) => item && item.source === 'hitomi' && typeof item.galleryId === 'string'
        && typeof item.title === 'string' && Array.isArray(item.artists) && item.artists.every(a => typeof a === 'string') && Array.isArray(item.tags) && item.tags.every(t => typeof t === 'string')),
      mutedArtists: (Array.isArray(stored.mutedArtists) ? stored.mutedArtists : []).filter((a: unknown) => typeof a === 'string'),
      snoozed: (Array.isArray(stored.snoozed) ? stored.snoozed : []).filter((s: RecommendationFeedback['snoozed'][number]) => s && s.source === 'hitomi'
        && typeof s.galleryId === 'string' && typeof s.title === 'string' && typeof s.until === 'string' && Date.parse(s.until) > Date.now()),
    };
  } catch { return { liked: [], mutedArtists: [], snoozed: [] }; }
}

export type FeedbackAction = 'like' | 'unlike' | 'mute-artist' | 'unmute-artist' | 'snooze' | 'unsnooze';
export function saveRecommendationFeedback(action: FeedbackAction, target: { source: DoujinSource; galleryId: string; artist?: string; days?: 7 | 30 }, item?: DoujinSearchResult): RecommendationFeedback {
  const feedback = getRecommendationFeedback();
  if (action === 'like') {
    if (!item) throw new Error('Gallery metadata is required');
    // One bounded preference vote per gallery, not one vote per click.
    feedback.liked = [...feedback.liked.filter(g => !sameGallery(g, target)), {
      source: item.source, galleryId: item.galleryId, title: item.title, artists: item.artists.slice(0, 30), tags: item.tags.slice(0, 100), language: item.language,
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
  if (action === 'snooze') {
    if (!item || (target.days !== 7 && target.days !== 30)) throw new Error('Choose a snooze duration of 7 or 30 days');
    feedback.snoozed = [...feedback.snoozed.filter(g => !sameGallery(g, target)), {
      source: target.source, galleryId: target.galleryId, title: item.title, until: new Date(Date.now() + target.days * 86_400_000).toISOString(),
    }];
    if (feedback.snoozed.length > 1000) throw new Error('Snooze limit reached (1000). End a snooze first.');
  }
  if (action === 'unsnooze') feedback.snoozed = feedback.snoozed.filter(g => !sameGallery(g, target));
  const valueJson = JSON.stringify(feedback);
  getDb().insert(schema.keyValueStore).values({ key: KEY, valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
  return feedback;
}
