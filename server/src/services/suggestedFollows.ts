import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { CommonSearchQuery, DoujinSource } from '../contracts/doujin.js';
import type { SuggestedFollow, WatchedSearch } from '../contracts/following.js';
import { compileEhentai, compileHitomi, compileNhentai } from './unifiedQuery.js';
import { getRecommendationFeedback, normalizeArtist } from './recommendationFeedback.js';
import { isAccountConfigured } from './ehentaiAccount.js';
import { addWatchedSearch, FollowingError, updateWatchedSearch } from './watchedSearches.js';

/**
 * Suggested follows: artists behind several downloaded galleries (or liked
 * picks) that no watch covers yet. Suggestions only read local history; a
 * follow is a normal watch whose first check seeds silently.
 */

const DISMISSED_KEY = 'suggested-follows-dismissed';
const MIN_SCORE = 2;
const LIMIT = 8;
const PLACEHOLDER_ARTISTS = new Set(['n/a', 'na', 'unknown', 'anonymous', 'various', 'none']);

function parseList(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try { const value: unknown = JSON.parse(json); return Array.isArray(value) ? value : []; } catch { return []; }
}

function dismissedArtists(): Set<string> {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, DISMISSED_KEY)).get();
  return new Set(parseList(row?.valueJson).filter((name): name is string => typeof name === 'string'));
}

/** Artists any watch already covers, on any source, from its positive artist filters. */
export function followedArtists(queries: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const query of queries) {
    for (const match of query.matchAll(/(?:^|\s)artists?:(?:"((?:[^"\\]|\\.)*)"|(\S+))/gi)) {
      const value = (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1').replace(/\$$/, '');
      const name = normalizeArtist(value);
      if (name) out.add(name);
    }
  }
  return out;
}

/** The watch query for one artist, in the source's own syntax. */
export function artistWatchQuery(source: DoujinSource, artist: string): string {
  const query: CommonSearchQuery = { raw: `artist:"${artist}"`, keywords: [], phrases: [], filters: [{ namespace: 'artist', value: artist }], exclusions: [] };
  return (source === 'hitomi' ? compileHitomi(query) : source === 'nhentai' ? compileNhentai(query) : compileEhentai(query)).query;
}

export function listSuggestedFollows(): SuggestedFollow[] {
  const db = getDb();
  const followed = followedArtists(db.select({ query: schema.watchedSearches.query }).from(schema.watchedSearches).all().map(row => row.query));
  const feedback = getRecommendationFeedback();
  const muted = new Set(feedback.mutedArtists.map(normalizeArtist));
  const dismissed = dismissedArtists();
  const ehentai = isAccountConfigured();
  interface Tally { artist: string; downloads: number; liked: number; bySource: Map<DoujinSource, number>; titles: string[]; last: string | null }
  const tallies = new Map<string, Tally>();
  const tally = (raw: string, source: DoujinSource) => {
    const artist = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const key = normalizeArtist(artist);
    if (!key || PLACEHOLDER_ARTISTS.has(key) || followed.has(key) || muted.has(key) || dismissed.has(key)) return null;
    let entry = tallies.get(key);
    if (!entry) { entry = { artist, downloads: 0, liked: 0, bySource: new Map(), titles: [], last: null }; tallies.set(key, entry); }
    entry.bySource.set(source, (entry.bySource.get(source) ?? 0) + 1);
    return entry;
  };
  const owned = new Set(db.select({ source: schema.ownedGalleries.source, galleryId: schema.ownedGalleries.galleryId }).from(schema.ownedGalleries).all().map(row => `${row.source}:${row.galleryId}`));
  for (const row of db.select({ source: schema.galleryTags.source, galleryId: schema.galleryTags.galleryId, title: schema.galleryTags.title, artistsJson: schema.galleryTags.artistsJson, fetchedAt: schema.galleryTags.fetchedAt }).from(schema.galleryTags).all()) {
    if (!owned.has(`${row.source}:${row.galleryId}`)) continue;
    const seen = new Set<string>();
    for (const raw of parseList(row.artistsJson)) {
      if (typeof raw !== 'string' || seen.has(normalizeArtist(raw))) continue;
      seen.add(normalizeArtist(raw));
      const entry = tally(raw, row.source as DoujinSource);
      if (!entry) continue;
      entry.downloads++;
      if (row.title && entry.titles.length < 3 && !entry.titles.includes(row.title)) entry.titles.push(row.title);
      if (!entry.last || row.fetchedAt > entry.last) entry.last = row.fetchedAt;
    }
  }
  for (const item of feedback.liked) {
    for (const raw of new Set(item.artists)) {
      const entry = tally(raw, item.source);
      if (entry) entry.liked++;
    }
  }
  return [...tallies.values()]
    .map(entry => ({ entry, score: entry.downloads + 2 * entry.liked }))
    .filter(({ score }) => score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || (b.entry.last ?? '').localeCompare(a.entry.last ?? '') || a.entry.artist.localeCompare(b.entry.artist))
    .slice(0, LIMIT)
    .map(({ entry }) => {
      const ranked = [...entry.bySource.entries()].filter(([source]) => source !== 'ehentai' || ehentai).sort((a, b) => b[1] - a[1]);
      const source: DoujinSource = ranked[0]?.[0] ?? 'hitomi';
      return { artist: entry.artist, source, query: artistWatchQuery(source, entry.artist), downloads: entry.downloads, liked: entry.liked, titles: entry.titles, lastDownloadedAt: entry.last };
    });
}

/** Follow an artist with a readable watch name; following twice returns the same watch. */
export function followSuggestedArtist(artist: string, source: DoujinSource): WatchedSearch {
  const name = typeof artist === 'string' ? artist.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 120 || /[\u0000-\u001f"]/.test(name)) throw new FollowingError('Choose an artist name of 1–120 characters without quotes.', 400);
  if (source === 'ehentai' && !isAccountConfigured()) throw new FollowingError('Save an E-Hentai account in Settings before following there.', 400);
  const watch = addWatchedSearch(source, artistWatchQuery(source, name));
  return watch.displayName ? watch : updateWatchedSearch(watch.id, { expectedRevision: watch.revision, displayName: name });
}

/** Hide (or bring back) one suggestion; this never touches watches or recommendations. */
export function setSuggestedFollowDismissed(artist: string, dismissed: boolean): void {
  const key = normalizeArtist(typeof artist === 'string' ? artist : '');
  if (!key || key.length > 120) throw new FollowingError('Choose an artist.', 400);
  const current = dismissedArtists();
  if (dismissed) current.add(key); else current.delete(key);
  const valueJson = JSON.stringify([...current].slice(-1000));
  getDb().insert(schema.keyValueStore).values({ key: DISMISSED_KEY, valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
}
