import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery } from '../downloader/types.js';
import type { DoujinSource } from '../contracts/doujin.js';
import { mapKavitaPathToLocalPath } from '../lib/cbz.js';
import type { GalleryTagEntry } from './recommendations.js';
import { getExcludedKavitaLibraryPaths, type KavitaSeriesSignal } from './recommendationSignals.js';
import { getRecommendationFeedback, normalizeArtist, normalizeTag } from './recommendationFeedback.js';
import { getDownloaderSettings } from './settings.js';

const BACKFILL_LIMIT = 25;
/** Unreachable (deleted/404) galleries back off from one hour, doubling to a week. */
const BACKFILL_RETRY_BASE_MS = 60 * 60_000;
const BACKFILL_RETRY_MAX_MS = 7 * 24 * 60 * 60_000;
const backfillFailures = new Map<string, { failures: number; retryAt: number }>();

/**
 * Structural/meta Hitomi tags that appear on the majority of galleries and
 * describe format/censorship/translation rather than content taste. Kept out
 * of query generation and diversity overlap penalties so actual preference
 * tags drive discovery.
 */
export const BOILERPLATE_TAGS = new Set([
  'sole female', 'sole male', 'mosaic censorship', 'full censorship',
  'uncensored', 'decensored', 'censored', 'translated', 'rewrite',
  'digital', 'multi-work series', 'story arc', 'anthology', 'tankoubon',
  'webtoon', 'incomplete', 'non-h', 'speechless', 'text cleaned',
  'oneshot', 'one-shot', 'english', 'japanese', 'chinese', 'korean',
  'raw', 'scanmark', 'watermarked', 'variant set', 'sample', 'misc',
  'doujinshi', 'manga', 'artist cg', 'game cg', 'image set', 'western',
  'colorized', 'full color', 'rough translation', 'mtled', 'ai generated',
  'original', 'n/a',
]);

/** Generic manga/anime genres from Kavita (AniList/MAL) that are not Hitomi content tags. */
const GENERIC_KAVITA_GENRES = new Set([
  'action', 'adventure', 'comedy', 'drama', 'ecchi', 'fantasy', 'hentai',
  'horror', 'mahou shoujo', 'mecha', 'music', 'mystery', 'psychological',
  'romance', 'sci-fi', 'slice of life', 'sports', 'supernatural', 'thriller',
  'seinen', 'shounen', 'shoujo', 'josei', 'adult', 'mature', 'erotica',
  'smut', 'doujinshi', 'manga', 'one-shot', 'oneshot',
]);

export function isBoilerplateTag(name: string): boolean {
  return BOILERPLATE_TAGS.has(normalizeTag(name));
}

export interface ProfileTerm {
  kind: 'artist' | 'tag' | 'series';
  name: string;
  /** Weighted frequency across tagged galleries, Kavita signals, watches, and feedback. */
  weight: number;
  /** Search namespace observed per source (null = plain keyword). */
  nsBySource: Partial<Record<DoujinSource, string | null>>;
}

export interface TagPair {
  a: ProfileTerm;
  b: ProfileTerm;
  count: number;
  score: number;
}

export interface TasteProfile {
  terms: ProfileTerm[];
  /** Distinctive co-occurring tag pairs from downloaded and liked galleries. */
  tagPairs: TagPair[];
  /** Soft negative term weights learned from dismissed galleries (`kind:lowercase`). */
  dislikedTerms: Record<string, number>;
  /** Dominant language of the library, when one covers ≥60% of tagged galleries. */
  language: string | null;
  /** True when the library has ≥5 tagged works split across languages with no ≥60% majority. */
  multiLanguage: boolean;
  /** Median page count of known library/downloaded works, when available. */
  preferredPageCount: number | null;
}

function bumpTerm(
  terms: Map<string, ProfileTerm>,
  kind: 'artist' | 'tag' | 'series',
  name: string,
  source: DoujinSource | null,
  ns: string | null,
  weight = 1,
): void {
  const clean = name.trim();
  if (!clean || weight <= 0) return;
  const key = `${kind}:${clean.toLowerCase()}`;
  let t = terms.get(key);
  if (!t) {
    t = { kind, name: clean, weight: 0, nsBySource: {} };
    terms.set(key, t);
  }
  t.weight += weight;
  if (source === null) return;
  const existing = t.nsBySource[source];
  // Prefer a concrete namespace over a keyword slot once seen.
  if (existing === undefined || (existing === null && ns !== null)) t.nsBySource[source] = ns;
}

function parseEntries(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Mild recency decay bucketed by whole days: <=7 days = 1.0, 6 months ≈ 0.69, 2 years ≈ 0.51. */
function recencyWeight(iso?: string | null): number {
  if (!iso) return 1;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 1;
  const ageDays = Math.floor(Math.max(0, (Date.now() - ms) / 86_400_000));
  if (ageDays <= 7) return 1;
  return Math.round((0.5 + 0.5 * Math.exp(-(ageDays - 7) / 180)) * 1000) / 1000;
}

/** Engagement multiplier for a Kavita series based on user ratings and reading progress. */
function kavitaEngagementWeight(sig: KavitaSeriesSignal): number {
  if (sig.hasUserRated && typeof sig.userRating === 'number' && sig.userRating > 0) {
    if (sig.userRating >= 4.5) return 1.6;
    if (sig.userRating >= 3.5) return 1.3;
    if (sig.userRating <= 2) return 0.35;
    return 1.0;
  }
  if (typeof sig.totalReads === 'number' && sig.totalReads >= 2) return 1.5;
  if (typeof sig.pages === 'number' && sig.pages > 0 && typeof sig.pagesRead === 'number') {
    if (sig.pagesRead >= sig.pages * 0.85) return 1.3;
    if (sig.pagesRead > 0) return 1.1;
    return 0.85;
  }
  return 1.0;
}

function extractSourceKeysFromWebLinks(webLinks?: string | null): string[] {
  if (!webLinks) return [];
  return [...webLinks.matchAll(/https?:\/\/[^\s<>"',;]+/gi)].flatMap(([value]) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const hitomi = host === 'hitomi.la' && (url.pathname.match(/^\/(?:reader\/|[^/]+\/)(?:[^/]*-)?(\d+)\.html$/) || url.pathname.match(/^\/(\d+)\/?$/));
      const nhentai = host === 'nhentai.net' && url.pathname.match(/^\/g\/(\d+)\/?$/);
      return hitomi ? [`hitomi:${hitomi[1]}`] : nhentai ? [`nhentai:${nhentai[1]}`] : [];
    } catch {
      return [];
    }
  });
}

function normalizePathPrefix(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** Skip downloads whose output archive lives inside an excluded Kavita library folder. */
function excludedDownloadKeys(): Set<string> {
  const excludedKavitaPaths = getExcludedKavitaLibraryPaths();
  if (!excludedKavitaPaths.length) return new Set();
  let mappings = [] as { kavitaPath: string; localPath: string }[];
  try { mappings = getDownloaderSettings().libraryPathMappings ?? []; } catch { /* ignore */ }
  const roots = excludedKavitaPaths
    .flatMap((p) => {
      const mapped = mapKavitaPathToLocalPath(p, mappings);
      return mapped && mapped !== p ? [p, mapped] : [p];
    })
    .map(normalizePathPrefix)
    .filter(Boolean);
  if (!roots.length) return new Set();
  const excluded = new Set<string>();
  for (const row of getDb().select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId, outputPath: schema.downloadQueue.outputPath }).from(schema.downloadQueue).where(isNotNull(schema.downloadQueue.outputPath)).all()) {
    if (!row.outputPath) continue;
    const out = normalizePathPrefix(row.outputPath);
    if (roots.some((root) => out === root || out.startsWith(`${root}/`))) {
      excluded.add(`${row.source}:${row.galleryId}`);
    }
  }
  return excluded;
}

/** Heuristic: avoid treating raw bracketed single-gallery doujin titles as Hitomi series/parody names. */
function looksLikeSearchableSeriesName(name: string, downloadedTitles: Set<string>): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/[\[\]]/.test(trimmed)) return false;
  if (downloadedTitles.has(trimmed.toLowerCase())) return false;
  return true;
}

function addWatchedSearchSignals(terms: Map<string, ProfileTerm>): void {
  const watches = getDb().select({ source: schema.watchedSearches.source, query: schema.watchedSearches.query }).from(schema.watchedSearches).where(isNull(schema.watchedSearches.pausedAt)).all();
  for (const watch of watches) {
    const source = watch.source === 'hitomi' || watch.source === 'nhentai' ? (watch.source as DoujinSource) : null;
    const tokens = watch.query.trim().split(/\s+/).filter(Boolean);
    for (const raw of tokens) {
      if (raw.startsWith('-') || raw.toLowerCase() === 'or') continue;
      const colon = raw.indexOf(':');
      if (colon <= 0) continue;
      const ns = raw.slice(0, colon).toLowerCase();
      const value = raw.slice(colon + 1).replace(/_/g, ' ').replace(/^["']|["']$/g, '').trim();
      if (!value) continue;
      if (ns === 'artist') bumpTerm(terms, 'artist', value, source, 'artist', 2);
      else if (ns === 'series' || ns === 'parody') bumpTerm(terms, 'series', value, source, 'series', 2);
      else if (ns === 'female' || ns === 'male') bumpTerm(terms, 'tag', value, source, ns, 1.5);
      else if (ns === 'tag') bumpTerm(terms, 'tag', value, source, null, 1.5);
    }
  }
}

function buildDislikedTerms(): Record<string, number> {
  const db = getDb();
  const dismissed = db.select({
    source: schema.dismissedGalleries.source,
    galleryId: schema.dismissedGalleries.galleryId,
    artistsJson: schema.dismissedGalleries.artistsJson,
    tagsJson: schema.dismissedGalleries.tagsJson,
  }).from(schema.dismissedGalleries).all();
  if (!dismissed.length) return {};

  const parsedRows: { source: string; galleryId: string; artists: string[]; tags: string[] }[] = [];
  const legacyBySource = new Map<string, Set<string>>();
  for (const row of dismissed) {
    const artists = parseEntries(row.artistsJson).map((a) => String(a ?? '').trim()).filter(Boolean);
    const tags = parseEntries(row.tagsJson).map((t) => String(t ?? '').trim()).filter(Boolean);
    parsedRows.push({ source: row.source, galleryId: row.galleryId, artists, tags });
    if (!artists.length && !tags.length) {
      let ids = legacyBySource.get(row.source);
      if (!ids) {
        ids = new Set();
        legacyBySource.set(row.source, ids);
      }
      ids.add(row.galleryId);
    }
  }

  // Only legacy dismissals without stored metadata need history; batch-load them per source.
  const historicByKey = new Map<string, { artists?: string[]; tags?: string[] }>();
  for (const [source, idSet] of legacyBySource) {
    const ids = [...idSet];
    for (let i = 0; i < ids.length; i += 500) {
      const rows = db.select({
        source: schema.recommendationHistory.source,
        galleryId: schema.recommendationHistory.galleryId,
        itemJson: schema.recommendationHistory.itemJson,
      }).from(schema.recommendationHistory)
        .where(and(eq(schema.recommendationHistory.source, source), inArray(schema.recommendationHistory.galleryId, ids.slice(i, i + 500))))
        .all();
      for (const h of rows) {
        try {
          historicByKey.set(`${h.source}:${h.galleryId}`, JSON.parse(h.itemJson) as { artists?: string[]; tags?: string[] });
        } catch {
          /* skip malformed */
        }
      }
    }
  }

  const disliked: Record<string, number> = {};
  for (const row of parsedRows) {
    let artists = row.artists;
    let tags = row.tags;
    if (!artists.length && !tags.length) {
      const historic = historicByKey.get(`${row.source}:${row.galleryId}`);
      if (historic) {
        artists = (historic.artists ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
        tags = (historic.tags ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
      }
    }
    for (const a of new Set(artists.map((x) => x.toLowerCase()))) {
      disliked[`artist:${a}`] = (disliked[`artist:${a}`] ?? 0) + 1.5;
    }
    for (const t of new Set(tags.map((x) => x.toLowerCase()))) {
      if (isBoilerplateTag(t)) continue;
      disliked[`tag:${t}`] = (disliked[`tag:${t}`] ?? 0) + 1;
    }
  }
  return disliked;
}

/** Aggregate per-gallery tag rows, Kavita library signals, watched searches, and feedback into a taste profile. */
export function buildProfile(signals: KavitaSeriesSignal[]): TasteProfile {
  const db = getDb();
  const rows = db.select().from(schema.galleryTags).all();
  const excludedDownloads = excludedDownloadKeys();
  const terms = new Map<string, ProfileTerm>();
  const langCounts = new Map<string, number>();
  let taggedWithLang = 0;

  const countedDownloadKeys = new Set<string>();
  const downloadedTitles = new Set<string>();
  const pairCounts = new Map<string, { aKey: string; bKey: string; count: number; weight: number }>();
  const tagDocCounts = new Map<string, number>();

  const recordPairs = (tagKeys: string[], weight: number) => {
    const unique = [...new Set(tagKeys)].sort();
    for (const key of unique) tagDocCounts.set(key, (tagDocCounts.get(key) ?? 0) + weight);
    // Cap per-gallery tag list so mega-tagged anthologies don't explode pair counts.
    const bounded = unique.slice(0, 12);
    for (let i = 0; i < bounded.length; i++) {
      for (let j = i + 1; j < bounded.length; j++) {
        const pairKey = `${bounded[i]}|${bounded[j]}`;
        const existing = pairCounts.get(pairKey);
        if (existing) {
          existing.count += 1;
          existing.weight += weight;
        } else {
          pairCounts.set(pairKey, { aKey: bounded[i], bKey: bounded[j], count: 1, weight });
        }
      }
    }
  };

  for (const row of rows) {
    const rowKey = `${row.source}:${row.galleryId}`;
    if (excludedDownloads.has(rowKey)) continue;
    countedDownloadKeys.add(rowKey);
    if (row.title) downloadedTitles.add(row.title.trim().toLowerCase());
    const w = recencyWeight(row.fetchedAt);

    const tags = parseEntries(row.tagsJson);
    const artists = parseEntries(row.artistsJson);
    const parodies = parseEntries(row.parodiesJson);
    const seenArtists = new Set<string>();
    for (const raw of artists) {
      const name = String(raw ?? '').trim();
      if (!name || seenArtists.has(name.toLowerCase())) continue;
      seenArtists.add(name.toLowerCase());
      bumpTerm(terms, 'artist', name, row.source as DoujinSource, null, w);
    }
    const seenTags = new Set<string>();
    const distinctiveTagKeys: string[] = [];
    for (const raw of tags) {
      const entry: GalleryTagEntry = typeof raw === 'string'
        ? { name: raw, ns: null }
        : { name: String((raw as GalleryTagEntry)?.name ?? ''), ns: (raw as GalleryTagEntry)?.ns ?? null };
      const name = entry.name.trim();
      const lower = name.toLowerCase();
      if (!name || seenTags.has(lower)) continue;
      seenTags.add(lower);
      bumpTerm(terms, 'tag', name, row.source as DoujinSource, entry.ns, w);
      if (!isBoilerplateTag(name)) distinctiveTagKeys.push(`tag:${lower}`);
    }
    recordPairs(distinctiveTagKeys, w);

    const seenParodies = new Set<string>();
    for (const raw of parodies) {
      const name = String(raw ?? '').trim();
      const lower = name.toLowerCase();
      if (!name || lower === 'original' || lower === 'n/a' || seenParodies.has(lower)) continue;
      seenParodies.add(lower);
      bumpTerm(terms, 'series', name, row.source as DoujinSource, 'series', w);
    }
    const lang = row.language?.trim().toLowerCase();
    if (lang) {
      taggedWithLang += 1;
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
  }

  // Existing-library signals: engagement-weighted vote per series, skipping
  // duplicate full counts when the series links back to an already-counted download.
  const pageCounts: number[] = [];
  for (const sig of signals) {
    const name = sig.name.trim();
    if (!name) continue;
    const engagement = kavitaEngagementWeight(sig);
    const linkedKeys = extractSourceKeysFromWebLinks(sig.webLinks);
    const alreadyCounted = linkedKeys.some((key) => countedDownloadKeys.has(key));
    const effectiveWeight = alreadyCounted ? Math.max(0, engagement - 1) : engagement;
    if (effectiveWeight <= 0) continue;

    if (typeof sig.pages === 'number' && sig.pages > 0 && sig.pages < 1000) pageCounts.push(sig.pages);

    if (!alreadyCounted && looksLikeSearchableSeriesName(name, downloadedTitles)) {
      bumpTerm(terms, 'series', name, null, null, effectiveWeight);
    }
    const genreSet = new Set((sig.genres ?? []).map((g) => g.trim().toLowerCase()));
    const seenTags = new Set<string>();
    for (const tag of sig.tags) {
      const t = tag.trim();
      const lower = t.toLowerCase();
      if (!t || seenTags.has(lower)) continue;
      seenTags.add(lower);
      // Skip generic manga genres (Action, Comedy, Seinen...) that aren't Hitomi content tags.
      if (genreSet.has(lower) && GENERIC_KAVITA_GENRES.has(lower)) continue;
      bumpTerm(terms, 'tag', t, null, null, effectiveWeight);
    }
    const seenArtists = new Set<string>();
    for (const artist of sig.artists) {
      const a = artist.trim();
      if (!a || seenArtists.has(a.toLowerCase())) continue;
      seenArtists.add(a.toLowerCase());
      bumpTerm(terms, 'artist', a, null, null, effectiveWeight);
    }
  }

  // Active watched searches represent explicit, ongoing user interest.
  addWatchedSearchSignals(terms);

  const feedback = getRecommendationFeedback();
  const mutedArtists = new Set(feedback.mutedArtists.map(normalizeArtist));
  const mutedTags = new Set(feedback.mutedTags.map(normalizeTag));
  for (const item of feedback.liked) {
    // A positive signal strengthens similar work without marking this gallery owned.
    for (const artist of new Set(item.artists)) bumpTerm(terms, 'artist', artist, item.source, 'artist', 3);
    const distinctiveLikedTags: string[] = [];
    for (let i = 0; i < item.tags.length; i++) {
      const tag = item.tags[i];
      const ns = item.tagNamespaces?.[i] ?? null;
      bumpTerm(terms, 'tag', tag, item.source, ns, 2);
      if (!isBoilerplateTag(tag)) distinctiveLikedTags.push(`tag:${tag.trim().toLowerCase()}`);
    }
    recordPairs(distinctiveLikedTags, 2);
    for (const parody of new Set(item.parodies ?? [])) {
      const lower = parody.trim().toLowerCase();
      if (lower && lower !== 'original' && lower !== 'n/a') bumpTerm(terms, 'series', parody, item.source, 'series', 2.5);
    }
  }

  const dislikedTerms = buildDislikedTerms();
  // Gently dampen terms the user repeatedly dismisses so they stop winning query slots.
  for (const [key, penalty] of Object.entries(dislikedTerms)) {
    const term = terms.get(key);
    if (!term) continue;
    term.weight = Math.max(0.1, term.weight - penalty * 0.4);
  }

  for (const [key, term] of terms) {
    if (term.kind === 'artist' && mutedArtists.has(normalizeArtist(term.name))) terms.delete(key);
    if (term.kind === 'tag' && mutedTags.has(normalizeTag(term.name))) terms.delete(key);
  }

  // Build distinctive co-occurring tag pairs (PMI-like lift × log frequency).
  const tagPairs: TagPair[] = [];
  for (const entry of pairCounts.values()) {
    if (entry.count < 2 && entry.weight < 2) continue;
    const a = terms.get(entry.aKey);
    const b = terms.get(entry.bKey);
    if (!a || !b) continue;
    if (mutedTags.has(normalizeTag(a.name)) || mutedTags.has(normalizeTag(b.name))) continue;
    const countA = tagDocCounts.get(entry.aKey) ?? 1;
    const countB = tagDocCounts.get(entry.bKey) ?? 1;
    const score = (entry.weight / Math.sqrt(countA * countB)) * Math.log2(1 + entry.weight);
    tagPairs.push({ a, b, count: entry.count, score });
  }
  tagPairs.sort((x, y) => y.score - x.score || y.count - x.count);

  let language: string | null = null;
  let multiLanguage = false;
  if (taggedWithLang >= 5) {
    let best: [string, number] | null = null;
    for (const [l, n] of langCounts) if (!best || n > best[1]) best = [l, n];
    if (best && best[1] / taggedWithLang >= 0.6) language = best[0];
    else if (langCounts.size >= 2) multiLanguage = true;
  }

  let preferredPageCount: number | null = null;
  if (pageCounts.length >= 5) {
    pageCounts.sort((a, b) => a - b);
    preferredPageCount = pageCounts[Math.floor(pageCounts.length / 2)];
  }

  return {
    terms: [...terms.values()].sort((a, b) => b.weight - a.weight),
    tagPairs: tagPairs.slice(0, 16),
    dislikedTerms,
    language,
    multiLanguage,
    preferredPageCount,
  };
}

/**
 * Fill in tag data for completed downloads that predate the gallery_tags table
 * (or whose capture failed). Capped per run so the first recommendation pass
 * stays bounded; remaining galleries fill in on later generations.
 */
export async function backfillMissingTags(persistGalleryTags: (source: DoujinSource, gallery: DoujinGallery, invalidate: boolean) => void): Promise<void> {
  const db = getDb();
  // Always inspect a bounded missing batch. A global row-count threshold would
  // strand large legacy libraries forever once any ten galleries were tagged.
  // Galleries in backoff are skipped, so the batch over-fetches by their count
  // to keep them from occupying every slot.
  const now = Date.now();
  const backingOff = new Set<string>();
  for (const [key, entry] of backfillFailures) if (entry.retryAt > now) backingOff.add(key);
  const completed = db
    .select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId })
    .from(schema.downloadQueue)
    .leftJoin(schema.galleryTags, and(
      eq(schema.galleryTags.source, schema.downloadQueue.source),
      eq(schema.galleryTags.galleryId, schema.downloadQueue.galleryId),
    ))
    .where(and(eq(schema.downloadQueue.status, 'completed'), isNull(schema.galleryTags.galleryId)))
    .orderBy(desc(schema.downloadQueue.id))
    .limit(BACKFILL_LIMIT + backingOff.size)
    .all();
  const seen = new Set<string>();
  const missing = completed.filter((r) => {
    const key = `${r.source}:${r.galleryId}`;
    if (backingOff.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, BACKFILL_LIMIT);
  if (!missing.length) return;

  const bySource = new Map<DoujinSource, typeof missing>();
  for (const row of missing) {
    if (row.source !== 'hitomi' && row.source !== 'nhentai') continue;
    const source = row.source;
    const rows = bySource.get(source);
    if (rows) rows.push(row);
    else bySource.set(source, [row]);
  }
  for (const [source, rows] of bySource) {
    const provider = getDoujinProvider(source);
    if (!provider) continue;
    for (let i = 0; i < rows.length; i += 8) {
      await Promise.all(
        rows.slice(i, i + 8).map(async (row) => {
          const key = `${source}:${row.galleryId}`;
          try {
            const gallery = await provider.getGallery(row.galleryId);
            persistGalleryTags(source, gallery, false);
            backfillFailures.delete(key);
          } catch {
            // Unreachable galleries stay untagged and back off instead of being
            // re-requested on every refresh.
            const failures = (backfillFailures.get(key)?.failures ?? 0) + 1;
            const delay = Math.min(BACKFILL_RETRY_MAX_MS, BACKFILL_RETRY_BASE_MS * 2 ** (failures - 1));
            backfillFailures.set(key, { failures, retryAt: Date.now() + delay });
          }
        }),
      );
    }
  }
}
