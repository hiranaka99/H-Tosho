import { buildProfile, backfillMissingTags, type ProfileTerm, type TasteProfile } from './recommendationProfile.js';
import { MutationCoordinator } from '../lib/mutations.js';
const recommendationMutations = new MutationCoordinator();
import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery, DoujinSearchResult, DoujinSort } from '../downloader/types.js';
import type { DoujinSource } from '../contracts/doujin.js';
import { mapLimit } from '../lib/http.js';
import { getDownloaderSettings, onSettingChange, setRecommendationSettings } from './settings.js';
import { buildKavitaSignals, clearRecommendationSignals, onRecommendationSeriesChange } from './recommendationSignals.js';
import { eligibleRecommendations } from './recommendationEligibility.js';
import type { DoujinProvider } from '../downloader/types.js';
import { rankCandidates, selectRecommendations } from './recommendationRanking.js';
import type { Candidate } from './recommendationRanking.js';
import { getRecommendationFeedback, saveRecommendationFeedback, type FeedbackAction, type RecommendationFeedback } from './recommendationFeedback.js';

/**
 * Daily doujinshi recommendations based on the user's downloaded library.
 *
 * Signal: the tag/artist profile of downloaded galleries (the `gallery_tags`
 * table — written after a successful download, lazily backfilled for
 * pre-existing downloads), plus the user's existing Kavita library: each series'
 * title feeds parody/series searches, and the genres/tags/writers Kavita has
 * already indexed from the archives join the artist/tag profile. The engine
 * builds a handful of artist/tag/series queries from the top profile terms
 * and searches Hitomi with them (the popularity horizon is a seeded per-roll
 * choice, so the candidate pool itself rotates), scores candidates by how
 * strongly they match the profile, drops galleries already in the library or
 * recently, and picks a daily set.
 *
 * Daily rotation: selection is seeded with the local date, so a day always
 * yields the same picks (cached in `key_value_store` under
 * `recommendations-v2:<date>`). Refresh resamples a bounded hydrated pool with a
 * fresh nonce, fetching more only when its fresh candidates run low or expire.
 * Every served pick enters rolling cross-day history. Tag/series overlap reduces
 * selection weight; actual artists and reliably identified editions never repeat.
 * When fresh pools cannot fill twelve slots, history returns least-recently-shown first,
 * including same-day picks as the final fallback. Downloaded, owned, dismissed,
 * banned, invalid, and duplicate galleries remain hard exclusions on every path.
 */

/**
 * Sources the daily picks are drawn from — Hitomi only. nHentai stays fully
 * available in search, watched searches and downloads; it just no longer feeds
 * the recommender, whose roll of ~9 rate-limited nHentai searches took 30+
 * seconds per refresh. The taste profile still learns from nHentai galleries
 * downloaded through the engine (recordGalleryTags at download time).
 */
const SOURCES = ['hitomi'] as const;

/** Top-N profile terms turned into one search query each, per source. */
const ARTIST_QUERIES = 2; // artist terms per source — artists rotate, tags/series carry the set
const TAG_QUERIES = 4; // top tag terms per source
const SERIES_QUERIES = 3; // top Kavita series titles per source (series search)
/**
 * How many heaviest terms per kind are eligible for queries. Wide pools are
 * what give later rolls somewhere to rotate to; without them every roll
 * queries the same handful of heaviest terms and returns the same galleries.
 * Artists sample without an anchor (they rotate fully); tags/series keep
 * their #1 anchor on only some rolls (see buildQuerySpecs).
 */
const ARTIST_QUERY_POOL = 12;
const TAG_QUERY_POOL = 16;
const SERIES_QUERY_POOL = 12;
/** Results fetched per candidate query — hydration is one request per gallery, so the cap stays tight. */
const HITOMI_RESULTS_PER_QUERY = 12;
/**
 * Seeded skip window for candidate queries. Popularity-sorted rankings barely
 * move between rolls, so without rotation every refresh would re-query the
 * same top slice per term and the fresh pool would dry up after a few sets —
 * forcing same-day re-serves. Each spec skips a seeded number of leading
 * results, sliding its sampled window down the ranking as the day's
 * refreshes accumulate.
 */
const ROLL_SKIP_WINDOW = 24;
/**
 * Popularity horizons a roll draws one sort from, per source. All-time lists
 * barely move day to day; pairing them with a weekly horizon keeps the
 * candidate pool itself rotating, not just the terms querying it.
 */
const SEARCH_SORTS: Record<(typeof SOURCES)[number], DoujinSort[]> = {
  hitomi: ['popular-year', 'popular-week'],
};
/** Target size; strict eligibility and artist/work diversity may yield fewer. */
const TOTAL_PICKS = 12;
/** Hydrated spares cached for instant dismissed-card replacement. */
const RESERVE_PICKS = 12;
/** Fewer profile terms than this → cold-start popularity fallback. */
const MIN_PROFILE_TERMS = 3;

export interface GalleryTagEntry {
  name: string;
  /** Search namespace for the tag (null = plain keyword). */
  ns: string | null;
}

export interface RecommendationItem extends DoujinSearchResult {
  /** Human-readable profile terms that matched this gallery, e.g. ["artist konboi", "tag solo"]. */
  reasons: string[];
}

export interface RecommendationProfile {
  /** Terms that matched today's picks (top 8 per kind by match count). */
  artists: string[];
  tags: string[];
  series: string[];
  language: string | null;
}

export interface RecommendationSet {
  date: string;
  generatedAt: string;
  /** How the visible set was composed. */
  mode: 'library' | 'mixed' | 'popular';
  profile: RecommendationProfile;
  items: RecommendationItem[];
  /** Number of picks reused from recommendation history. */
  repeatedCount: number;
  /** Why fewer than twelve fresh picks could not be supplied. */
  degradedReason: 'same-day-pool-exhausted' | 'insufficient-eligible' | null;
}

interface CachedRecommendationSet extends RecommendationSet {
  reserve: RecommendationItem[];
}

const CANDIDATE_POOL_TTL_MS = 30 * 60_000;
let candidatePool: { key: string; at: number; provider: DoujinProvider | null; candidates: Map<string, Candidate>; popular: RecommendationItem[] } | null = null;

// ---------------------------------------------------------------------------
// gallery_tags persistence
// ---------------------------------------------------------------------------

let profileRevision = 0;
onSettingChange('downloader', invalidateProfile);
onSettingChange('kavita-connection', invalidateProfile);
onRecommendationSeriesChange(invalidateProfile);

/** Update the next roll's inputs without replacing persisted daily picks. */
function invalidateProfile(): void {
  invalidateTasteInputs();
}

/** Learn from downloads without replacing the picks the user is browsing. */
function invalidateTasteInputs(): void {
  profileRevision += 1;
  candidatePool = null;
}

/** Persist metadata already resolved for a successfully downloaded gallery. */
function persistGalleryTags(source: DoujinSource, gallery: DoujinGallery, invalidate: boolean): void {
  const tags: GalleryTagEntry[] = (gallery.tags ?? [])
    .map((name, i) => ({ name: String(name ?? '').trim(), ns: gallery.tagNamespaces?.[i] ?? null }))
    .filter((t) => t.name);
  const artists = (gallery.artists ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
  try {
    getDb()
      .insert(schema.galleryTags)
      .values({ source, galleryId: gallery.galleryId, title: gallery.title, tagsJson: JSON.stringify(tags), artistsJson: JSON.stringify(artists), language: gallery.language ?? null, fetchedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [schema.galleryTags.source, schema.galleryTags.galleryId],
        set: { title: gallery.title, tagsJson: JSON.stringify(tags), artistsJson: JSON.stringify(artists), language: gallery.language ?? null, fetchedAt: new Date().toISOString() },
      })
      .run();
    getDb().insert(schema.ownedGalleries).values({ source, galleryId: gallery.galleryId }).onConflictDoNothing().run();
    if (invalidate) invalidateTasteInputs();
  } catch (err) {
    console.warn('[h-tosho] failed to record gallery tags:', err);
  }
}

export function recordGalleryTags(source: DoujinSource, gallery: DoujinGallery): void {
  persistGalleryTags(source, gallery, true);
}

// ---------------------------------------------------------------------------
// Taste profile
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Candidate queries
// ---------------------------------------------------------------------------
/**
 * Gallery types recommendations never surface. Image sets are already dropped
 * by the hitomi provider itself; artist CGs appear in plain search results but
 * stay out of the daily picks.
 */
const EXCLUDED_GALLERY_TYPES = ['imageset', 'artistcg'];

interface QuerySpec {
  source: DoujinSource;
  query: string;
  /** Result cap for this query (hitomi hydrates one request per result; nhentai is a single API page). */
  results: number;
  terms: ProfileTerm[];
  sort: DoujinSort;
  /** Leading ranking positions to skip this roll (seeded window rotation). */
  skip: number;
}

/** Hitomi search fragment for a profile term (null = not searchable). */
function fragmentFor(term: ProfileTerm): string | null {
  const name = term.name.trim();
  if (!name) return null;
  // Hitomi namespaces use underscores for multi-word values.
  if (term.kind === 'artist') return `artist:${name.replace(/\s+/g, '_')}`;
  if (term.kind === 'series') {
    // Fan works of a series are indexed under its name.
    return `series:${name.replace(/\s+/g, '_')}`;
  }
  const ns = term.nsBySource.hitomi ?? null;
  if (ns === 'language') return null; // language is handled as its own filter
  return ns ? `${ns}:${name.replace(/\s+/g, '_')}` : name;
}


/**
 * The terms queried this roll. Tags/series keep their #1 heaviest term as a
 * taste anchor on only half the rolls (a seeded coin — anchoring every roll
 * re-queries the top term every time and the set converges on it); artists
 * are always fully seeded-sampled from their pool. One query per term, per
 * source (AND-combining would shrink pools too hard). Each spec also draws a
 * seeded skip so consecutive rolls sample different slices of each static
 * ranking.
 */
function buildQuerySpecs(profile: TasteProfile, rng: () => number): QuerySpec[] {
  const artists = sampleTerms(profile.terms.filter((t) => t.kind === 'artist'), ARTIST_QUERIES, ARTIST_QUERY_POOL, rng, false);
  const tags = sampleTerms(
    profile.terms.filter((t) => t.kind === 'tag' && (t.nsBySource.hitomi ?? null) !== 'language'),
    TAG_QUERIES,
    TAG_QUERY_POOL,
    rng,
    rng() < 0.5,
  );
  const series = sampleTerms(profile.terms.filter((t) => t.kind === 'series'), SERIES_QUERIES, SERIES_QUERY_POOL, rng, rng() < 0.5);
  const specs: QuerySpec[] = [];
  for (const source of SOURCES) {
    for (const term of [...artists, ...tags, ...series]) {
      const frag = fragmentFor(term);
      if (!frag) continue;
      specs.push({
        source,
        query: frag,
        results: HITOMI_RESULTS_PER_QUERY,
        terms: [term],
        sort: SEARCH_SORTS[source][Math.floor(rng() * SEARCH_SORTS[source].length)],
        skip: Math.floor(rng() * ROLL_SKIP_WINDOW),
      });
    }
  }
  return specs;
}

/**
 * Top-`count` terms from a weight-descending list. With `anchor`, the #1 term
 * is always in and the remaining slots are seeded-sampled from the top
 * `poolSize`; without it, all slots are sampled from the pool.
 */
function sampleTerms(terms: ProfileTerm[], count: number, poolSize: number, rng: () => number, anchor = true): ProfileTerm[] {
  const pool = terms.slice(0, poolSize);
  if (pool.length <= count) return pool;
  const rest = anchor ? pool.slice(1) : [...pool];
  for (let i = 0; i < (anchor ? count - 1 : count); i++) {
    const j = i + Math.floor(rng() * (rest.length - i));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return anchor ? [pool[0], ...rest.slice(0, count - 1)] : rest.slice(0, count);
}

// ---------------------------------------------------------------------------
// Scoring + daily selection
// ---------------------------------------------------------------------------


const keyOf = (r: { source: string; galleryId: string }) => `${r.source}:${r.galleryId}`;

function credit(c: Candidate, termKey: string, reason: string): void {
  if (c.matched.has(termKey)) return;
  c.matched.add(termKey);
  if (!c.reasons.includes(reason)) c.reasons.push(reason);
}


/** Search every spec and merge candidates by gallery (a gallery hit by several queries sums their weights). */
async function gatherCandidates(specs: QuerySpec[], downloaded: Set<string>, termIndex: Map<string, ProfileTerm>): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  // Run one spec's search, returning its raw results (or null when the query
  // failed — one failing query cannot kill the whole generation).
  const runSpec = async (spec: QuerySpec): Promise<DoujinSearchResult[] | null> => {
    const provider = getDoujinProvider(spec.source);
    if (!provider) return null;
    try {
      return await provider.search(spec.query, spec.results, spec.sort, { excludeTypes: EXCLUDED_GALLERY_TYPES, skip: spec.skip, strictExclusions: true });
    } catch (err) {
      console.warn(`[h-tosho] recommendations query failed (${spec.source} “${spec.query}”):`, err instanceof Error ? err.message : err);
      return null;
    }
  };
  // Fire up to ~9 searches per generation. Run them all at once and Hitomi's
  // CDN answers with 429s (these direct calls bypass the downloader's
  // requestDelayMs throttle) — cap concurrency at 4.
  const bySource = new Map<DoujinSource, QuerySpec[]>();
  for (const spec of specs) {
    const group = bySource.get(spec.source);
    if (group) group.push(spec);
    else bySource.set(spec.source, [spec]);
  }
  const resultsBySpec = await Promise.all(
    [...bySource.values()].map((group) => mapLimit(group, 4, runSpec)),
  );
  // Merge in spec order (not completion order): the candidate map's insertion
  // order feeds the weighted sampler, and a completion-order map would make
  // per-term cap outcomes nondeterministic across runs.
  for (const [groupIndex, group] of [...bySource.values()].entries()) {
    for (const [specIndex, spec] of group.entries()) {
      const results = resultsBySpec[groupIndex]?.[specIndex];
      if (!results) continue;
      for (const r of results) {
        const key = keyOf(r);
        if (downloaded.has(key)) continue;
        let c = out.get(key);
        if (!c) {
          c = { result: r, score: 0, reasons: [], matched: new Set() };
          out.set(key, c);
        }
        for (const t of spec.terms) credit(c, `${t.kind}:${t.name.toLowerCase()}`, `${t.kind} ${t.name}`);
        // Hitomi results carry their own tag/artist lists — credit extra profile terms they share.
        if (r.source === 'hitomi') {
          for (const a of r.artists ?? []) {
            const t = termIndex.get(`artist:${a.toLowerCase()}`);
            if (t) credit(c, `artist:${a.toLowerCase()}`, `artist ${t.name}`);
          }
          for (const tag of r.tags ?? []) {
            const t = termIndex.get(`tag:${tag.toLowerCase()}`);
            if (t) credit(c, `tag:${tag.toLowerCase()}`, `tag ${t.name}`);
          }
        }
      }
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Cold-start popularity fallback
// ---------------------------------------------------------------------------

const POPULAR_FALLBACK: Record<(typeof SOURCES)[number], { query: string; sort: DoujinSort }> = {
  hitomi: { query: 'doujinshi', sort: 'popular-year' },
};

async function gatherPopular(downloaded: Set<string>, rng: () => number): Promise<RecommendationItem[]> {
  const out: RecommendationItem[] = [];
  await Promise.all(
    SOURCES.map(async (source) => {
      const provider = getDoujinProvider(source);
      if (!provider) return;
      const spec = POPULAR_FALLBACK[source];
      try {
        const results = await provider.search(spec.query, TOTAL_PICKS + RESERVE_PICKS, spec.sort, { excludeTypes: EXCLUDED_GALLERY_TYPES, skip: Math.floor(rng() * ROLL_SKIP_WINDOW), strictExclusions: true });
        const pool = results.filter((r) => !downloaded.has(keyOf(r)));
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        out.push(...pool.slice(0, TOTAL_PICKS + RESERVE_PICKS).map((r) => ({ ...r, reasons: [] as string[] })));
      } catch (err) {
        console.warn(`[h-tosho] recommendations popular fetch failed (${source}):`, err instanceof Error ? err.message : err);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic daily seed
// ---------------------------------------------------------------------------

function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local-timezone YYYY-MM-DD — the day boundary for "different every day". */
function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Generation + daily cache
// ---------------------------------------------------------------------------

function completedGalleryKeys(): Set<string> {
  const rows = getDb()
    .select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId })
    .from(schema.downloadQueue)
    .where(eq(schema.downloadQueue.status, 'completed'))
    .all();
  return new Set(rows.map((r) => `${r.source}:${r.galleryId}`));
}

/** Galleries the user has marked as owned — they are never recommended. */
function ownedGalleryKeys(): Set<string> {
  const rows = getDb()
    .select({ source: schema.ownedGalleries.source, galleryId: schema.ownedGalleries.galleryId })
    .from(schema.ownedGalleries)
    .all();
  return new Set(rows.map((r) => `${r.source}:${r.galleryId}`));
}

const HISTORY_KEY = 'recommendations-history';
const HISTORY_DAYS = 30;
const MAX_HISTORY = 1200;

interface HistoryEntry {
  key: string;
  date: string;
  servedAt: string;
  item: RecommendationItem;
}

function isRecommendationItem(value: unknown): value is RecommendationItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RecommendationItem>;
  return (item.source === 'hitomi' || item.source === 'nhentai')
    && typeof item.galleryId === 'string' && item.galleryId.length > 0
    && typeof item.title === 'string' && Array.isArray(item.tags)
    && Array.isArray(item.artists) && Array.isArray(item.reasons);
}

function parseHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<HistoryEntry>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? '') || !isRecommendationItem(entry.item)) return null;
  const key = keyOf(entry.item);
  const servedAt = typeof entry.servedAt === 'string' && !Number.isNaN(Date.parse(entry.servedAt))
    ? entry.servedAt
    : `${entry.date}T00:00:00.000Z`;
  return entry.key === key ? { key, date: entry.date!, servedAt, item: entry.item } : null;
}

function writeHistory(entries: HistoryEntry[]): void {
  const db = getDb();
  const keep = new Set(entries.map((entry) => entry.key));
  for (const row of db.select().from(schema.recommendationHistory).all()) {
    if (!keep.has(`${row.source}:${row.galleryId}`)) {
      db.delete(schema.recommendationHistory).where(and(eq(schema.recommendationHistory.source, row.source), eq(schema.recommendationHistory.galleryId, row.galleryId))).run();
    }
  }
  for (const entry of entries) {
    const itemJson = JSON.stringify(entry.item);
    db.insert(schema.recommendationHistory)
      .values({ source: entry.item.source, galleryId: entry.item.galleryId, servedDate: entry.date, servedAt: entry.servedAt, itemJson })
      .onConflictDoUpdate({ target: [schema.recommendationHistory.source, schema.recommendationHistory.galleryId], set: { servedDate: entry.date, servedAt: entry.servedAt, itemJson } })
      .run();
  }
}

/** Read normalized history and migrate the legacy JSON blob once. */
function readHistory(): HistoryEntry[] {
  const db = getDb();
  const normalized = db.select().from(schema.recommendationHistory).orderBy(asc(schema.recommendationHistory.servedAt)).all();
  if (normalized.length) {
    return normalized.flatMap((row) => {
      try {
        return parseHistoryEntry({ key: `${row.source}:${row.galleryId}`, date: row.servedDate, servedAt: row.servedAt, item: JSON.parse(row.itemJson) }) ?? [];
      } catch {
        return [];
      }
    });
  }
  const legacyRow = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, HISTORY_KEY)).get();
  if (!legacyRow) return [];
  try {
    const parsed = JSON.parse(legacyRow.valueJson);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.map(parseHistoryEntry).filter((entry): entry is HistoryEntry => entry !== null);
    writeHistory(entries);
    db.delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, HISTORY_KEY)).run();
    return entries;
  } catch {
    return [];
  }
}

function readHistoryItem(source: string, galleryId: string): RecommendationItem | undefined {
  const db = getDb();
  const row = db.select().from(schema.recommendationHistory)
    .where(and(eq(schema.recommendationHistory.source, source), eq(schema.recommendationHistory.galleryId, galleryId)))
    .get();
  if (row) {
    try {
      return parseHistoryEntry({ key: `${row.source}:${row.galleryId}`, date: row.servedDate, servedAt: row.servedAt, item: JSON.parse(row.itemJson) })?.item;
    } catch {
      return undefined;
    }
  }
  // Legacy migration fallback only when the normalized table is completely empty.
  const anyRow = db.select({ source: schema.recommendationHistory.source }).from(schema.recommendationHistory).limit(1).get();
  if (!anyRow) return readHistory().find((entry) => entry.key === `${source}:${galleryId}`)?.item;
  return undefined;
}

function pruneHistoryRows(): void {
  const cutoff = localDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000));
  const db = getDb();
  db.delete(schema.recommendationHistory).where(lt(schema.recommendationHistory.servedDate, cutoff)).run();
  db.run(sql`DELETE FROM recommendation_history WHERE rowid NOT IN (SELECT rowid FROM recommendation_history ORDER BY served_at DESC LIMIT ${MAX_HISTORY})`);
}

function pruneHistory(): HistoryEntry[] {
  pruneHistoryRows();
  return readHistory().slice(-MAX_HISTORY);
}

function addHistory(date: string, items: RecommendationItem[]): void {
  const db = getDb();
  // Ensure any legacy blob is migrated once before incremental upserts.
  const anyRow = db.select({ source: schema.recommendationHistory.source }).from(schema.recommendationHistory).limit(1).get();
  if (!anyRow) readHistory();
  const seen = readSeenItems(date);
  const now = new Date().toISOString();
  const byKey = new Map<string, RecommendationItem>();
  for (const it of seen) byKey.set(keyOf(it), it);
  for (const it of items) byKey.set(keyOf(it), it);
  for (const it of byKey.values()) {
    const itemJson = JSON.stringify(it);
    db.insert(schema.recommendationHistory)
      .values({ source: it.source, galleryId: it.galleryId, servedDate: date, servedAt: now, itemJson })
      .onConflictDoUpdate({ target: [schema.recommendationHistory.source, schema.recommendationHistory.galleryId], set: { servedDate: date, servedAt: now, itemJson } })
      .run();
  }
  pruneHistoryRows();
  db.delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, seenKey(date))).run();
}

const seenKey = (date: string) => `recommendations-seen:${date}`;

function readSeenItems(date: string): RecommendationItem[] {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, seenKey(date))).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.valueJson);
    return Array.isArray(parsed) ? parsed.filter(isRecommendationItem) : [];
  } catch {
    return [];
  }
}

function termsFromPicks(items: RecommendationItem[]): { artists: string[]; tags: string[]; series: string[] } {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const reason of item.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const byKind: Record<'artist' | 'tag' | 'series', [string, number][]> = { artist: [], tag: [], series: [] };
  for (const [reason, count] of counts) {
    const separator = reason.indexOf(' ');
    if (separator <= 0) continue;
    const kind = reason.slice(0, separator);
    if (kind === 'artist' || kind === 'tag' || kind === 'series') byKind[kind].push([reason.slice(separator + 1), count]);
  }
  const top = (list: [string, number][]) => list.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  return { artists: top(byKind.artist), tags: top(byKind.tag), series: top(byKind.series) };
}
async function doGenerate(date: string, nonce: number): Promise<CachedRecommendationSet> {
  const rng = mulberry32(hashSeed(`${date}:${nonce}`));
  await backfillMissingTags(persistGalleryTags);
  const kavitaSignals = await buildKavitaSignals();
  const profile = buildProfile(kavitaSignals);
  // Downloaded and owned galleries are hard exclusions. History is initially a
  // freshness exclusion, then becomes the least-recent fallback pool.
  const history = pruneHistory();
  const hardExcluded = new Set([...completedGalleryKeys(), ...ownedGalleryKeys(), ...getDb().select().from(schema.dismissedGalleries).all().map(keyOf)]);
  const freshExcluded = new Set([...hardExcluded, ...history.map((h) => h.key)]);

  let items: RecommendationItem[] = [];
  let libraryPicks = 0;
  let candidateCount = 0;
  const poolKey = JSON.stringify([profile, getDownloaderSettings().hitomiBannedTags]);
  const provider = getDoujinProvider('hitomi');
  if (!candidatePool || candidatePool.key !== poolKey || candidatePool.provider !== provider || Date.now() - candidatePool.at >= CANDIDATE_POOL_TTL_MS) {
    candidatePool = { key: poolKey, at: Date.now(), provider, candidates: new Map(), popular: [] };
  }
  const pool = candidatePool;
  const asCandidate = (item: RecommendationItem): Candidate => ({ result: item, score: 1, reasons: item.reasons, matched: new Set() });
  const readFreshPool = async () => {
    const eligible = await eligibleRecommendations([...pool.candidates.values()].map((candidate) => candidate.result));
    const eligibleKeys = new Set(eligible.map(keyOf));
    const candidates = new Map([...pool.candidates].filter(([key]) => eligibleKeys.has(key) && !freshExcluded.has(key)));
    const popular = (await eligibleRecommendations(pool.popular)).filter((item) => !freshExcluded.has(keyOf(item)));
    return { candidates, popular };
  };
  let { candidates, popular } = await readFreshPool();
  // Count picks under the same gallery/work/artist constraints as selection,
  // rather than treating many galleries from one artist as a full pool. This
  // probe leaves the roll's RNG untouched and fetching stays bounded to one batch.
  const usable = selectRecommendations([
    ...[...candidates.values()].map((candidate) => ({ ...candidate, score: 1 })),
    ...popular.map(asCandidate),
  ], TOTAL_PICKS + RESERVE_PICKS, () => 0);
  if (usable.length < TOTAL_PICKS + RESERVE_PICKS) {
    if (profile.terms.length >= MIN_PROFILE_TERMS || getRecommendationFeedback().liked.length > 0) {
      const termIndex = new Map(profile.terms.map((term) => [`${term.kind}:${term.name.toLowerCase()}`, term]));
      const fetched = await gatherCandidates(buildQuerySpecs(profile, rng), hardExcluded, termIndex);
      for (const [key, candidate] of fetched) pool.candidates.set(key, candidate);
    }
    const fetchedPopular = await gatherPopular(hardExcluded, rng);
    const popularByKey = new Map(pool.popular.map((item) => [keyOf(item), item]));
    for (const item of fetchedPopular) popularByKey.set(keyOf(item), item);
    pool.popular = [...popularByKey.values()].slice(-240);
    pool.candidates = new Map([...pool.candidates].slice(-480));
    ({ candidates, popular } = await readFreshPool());
  }
  candidateCount = candidates.size;
  rankCandidates([...candidates.values()], new Map(profile.terms.map((term) => [`${term.kind}:${term.name.toLowerCase()}`, term.weight])), profile.language);
  items = selectRecommendations([...candidates.values()], TOTAL_PICKS, rng);
  libraryPicks = items.length;
  items.push(...selectRecommendations(popular.map(asCandidate), TOTAL_PICKS - items.length, rng, items));

  // Last resort: recycle valid history least-recently-shown first. Earlier-day
  // entries naturally precede today's entries; same-day reuse occurs only when
  // no unseen or older recommendation can fill the panel.
  let repeatedCount = 0;
  let repeatedToday = false;
  if (items.length < TOTAL_PICKS) {
    const eligibleHistory = await eligibleRecommendations(history.map((entry) => entry.item));
    for (const item of eligibleHistory) {
      // Preserve least-recent ordering while enforcing artist/work exclusions.
      const selected = selectRecommendations([asCandidate(item)], 1, rng, items);
      if (!selected.length) continue;
      items.push(item);
      repeatedCount += 1;
      repeatedToday ||= history.find((entry) => entry.key === keyOf(item))?.date === date;
      if (items.length >= TOTAL_PICKS) break;
    }
  }
  // Reserves are ranked independently; promotion rechecks current diversity.
  const visibleKeys = new Set(items.map(keyOf));
  const leftovers = [...candidates.values()].filter((candidate) => !visibleKeys.has(keyOf(candidate.result)));
  const reserve = selectRecommendations(leftovers, RESERVE_PICKS, rng);
  reserve.push(...selectRecommendations(popular.filter((item) => !visibleKeys.has(keyOf(item))).map(asCandidate), RESERVE_PICKS - reserve.length, rng, reserve));


  const popularPicks = items.length - libraryPicks;
  const mode: RecommendationSet['mode'] = libraryPicks === 0 ? 'popular' : popularPicks > 0 ? 'mixed' : 'library';
  const degradedReason: RecommendationSet['degradedReason'] = repeatedToday
    ? 'same-day-pool-exhausted'
    : items.length < TOTAL_PICKS ? 'insufficient-eligible' : null;

  console.info(`[recommendations] generated mode=${mode} terms=${profile.terms.length} candidates=${candidateCount} library=${libraryPicks} popular=${popularPicks} repeated=${repeatedCount} total=${items.length}`);
  return {
    date,
    generatedAt: new Date().toISOString(),
    mode,
    profile: { ...termsFromPicks(items), language: profile.language },
    items,
    repeatedCount,
    degradedReason,
    reserve,
  };
}

const cacheKey = (date: string) => `recommendations-v2:${date}`;

function readCached(date: string): CachedRecommendationSet | null {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, cacheKey(date))).get();
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.valueJson);
    if (!parsed || typeof parsed !== 'object') return null;
    const set = parsed as Partial<CachedRecommendationSet>;
    if (!Array.isArray(set.items) || !set.items.every(isRecommendationItem)) return null;
    const reserve = Array.isArray(set.reserve) ? set.reserve.filter(isRecommendationItem) : [];
    const profile = set.profile;
    if (!profile || !Array.isArray(profile.artists) || !Array.isArray(profile.tags) || !Array.isArray(profile.series)) return null;
    if (![...profile.artists, ...profile.tags, ...profile.series].every((value) => typeof value === 'string')) return null;
    if (profile.language !== null && typeof profile.language !== 'string') return null;
    const repeatedCount = typeof set.repeatedCount === 'number' ? set.repeatedCount : 0;
    const degradedReason = set.degradedReason === 'same-day-pool-exhausted' || set.degradedReason === 'insufficient-eligible'
      ? set.degradedReason
      : null;
    if (set.items.length < TOTAL_PICKS && degradedReason !== 'insufficient-eligible') return null;
    return { ...set, reserve, repeatedCount, degradedReason } as CachedRecommendationSet;
  } catch {
    return null;
  }
}

/** Feedback after midnight edits the displayed set, without starting a new day. */
function readDisplayedSet(): CachedRecommendationSet | null {
  const row = getDb().select({ key: schema.keyValueStore.key }).from(schema.keyValueStore)
    .where(and(gte(schema.keyValueStore.key, 'recommendations-v2:'), lt(schema.keyValueStore.key, 'recommendations-v2;')))
    .orderBy(desc(schema.keyValueStore.key)).get();
  return row ? readCached(row.key.slice('recommendations-v2:'.length)) : null;
}

function writeCached(set: CachedRecommendationSet): void {
  const db = getDb();
  const valueJson = JSON.stringify(set);
  db.insert(schema.keyValueStore)
    .values({ key: cacheKey(set.date), valueJson })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } })
    .run();
  // Keep only today's cached set (the rolling history row prunes itself), and
  // drop legacy per-day seen rows superseded by the history.
  db.delete(schema.keyValueStore)
    .where(and(gte(schema.keyValueStore.key, 'recommendations-v2:'), lt(schema.keyValueStore.key, 'recommendations-v2;'), ne(schema.keyValueStore.key, cacheKey(set.date))))
    .run();
  db.delete(schema.keyValueStore)
    .where(and(gte(schema.keyValueStore.key, 'recommendations-seen:'), lt(schema.keyValueStore.key, 'recommendations-seen;')))
    .run();
}

/** Serialize generation; invalidated profile inputs trigger a fresh pass before commit. */
let inflight: { date: string; promise: Promise<CachedRecommendationSet> } | null = null;

function generateFor(date: string, nonce: number): Promise<CachedRecommendationSet> {
  if (inflight && inflight.date === date) return inflight.promise;
  const promise = (async () => {
    let generationNonce = nonce;
    for (;;) {
      const revision = profileRevision;
      const set = await doGenerate(date, generationNonce);
      if (revision !== profileRevision) {
        generationNonce += 1;
        continue;
      }
      commitDisplayedSet(set, set.items);
      return set;
    }
  })().finally(() => {
    if (inflight?.date === date) inflight = null;
  });
  inflight = { date, promise };
  return promise;
}

/** Daily set plus fresh ownership state for the UI (owned picks filtered out). */
export interface RecommendationResponse extends RecommendationSet {
  /** Keys (`source:galleryId`) of every owned gallery, for the UI's owned badges. */
  ownedKeys: string[];
  dismissedKeys: string[];
}

async function withOwned(set: RecommendationSet): Promise<RecommendationResponse> {
  const owned = ownedGalleryKeys();
  const dismissed = getDb().select().from(schema.dismissedGalleries).all().map(keyOf);
  const { date, generatedAt, mode, profile, repeatedCount, degradedReason } = set;
  const eligible = await eligibleRecommendations(set.items);
  // These picks were already ranked. Filtering ownership must preserve their order.
  const items = eligible.slice(0, TOTAL_PICKS);
  return { date, generatedAt, mode, profile, items, repeatedCount, degradedReason: items.length < TOTAL_PICKS ? 'insufficient-eligible' : degradedReason, ownedKeys: [...owned], dismissedKeys: dismissed };
}

function displayedRecommendations(): Promise<RecommendationResponse> {
  return withOwned(readDisplayedSet() ?? {
    date: localDate(), generatedAt: new Date().toISOString(), mode: 'popular',
    profile: { artists: [], tags: [], series: [], language: null }, items: [],
    repeatedCount: 0, degradedReason: 'insufficient-eligible',
  });
}

export async function getRecommendations(): Promise<RecommendationResponse> {
  return recommendationMutations.run(['displayed-set'], async () => {
    const date = localDate();
    const cached = readCached(date);
    if (cached) {
      // Completed downloads leave gaps, not a new roll. Refresh explicitly to refill.
      return withOwned(cached);
    }
    return generateFor(date, 0).then(withOwned);
  });
}

/** Cover warmer injected by the server (the media proxy's prefetch). */
export type CoverWarmer = (urls: string[]) => Promise<{ loaded: number; failed: number }>;

/** Attempts per displayed set before cover warming gives up until the set changes. */
const COVER_WARM_ATTEMPTS = 5;

/**
 * Prepare each day's persisted picks — and their cover images — even when no
 * browser has the app open, so the first visit of the day renders instantly.
 */
export function startRecommendationPreloading(warmCovers?: CoverWarmer): () => void {
  let pending = false;
  // Warming is keyed by the displayed set's generation stamp, so a new day, a
  // manual refresh or a settings re-roll each warm their own covers once.
  let warmed: { generatedAt: string; attempts: number; done: boolean } | null = null;
  const warm = async (): Promise<void> => {
    if (!warmCovers) return;
    const set = readDisplayedSet();
    if (!set) return;
    if (warmed?.generatedAt !== set.generatedAt) warmed = { generatedAt: set.generatedAt, attempts: 0, done: false };
    if (warmed.done || warmed.attempts >= COVER_WARM_ATTEMPTS) return;
    warmed.attempts += 1;
    const urls = [...set.items, ...set.reserve]
      .map((item) => item.coverUrl)
      .filter((url): url is string => typeof url === 'string' && url.startsWith('http'));
    const { failed } = await warmCovers(urls);
    // Cached covers are disk hits, so retrying only re-fetches the failures.
    if (failed === 0) warmed.done = true;
    else console.warn(`[recommendations] ${failed} cover(s) failed to prefetch; retrying in one minute`);
  };
  const preload = (): void => {
    if (pending) return;
    pending = true;
    void recommendationMutations.run(['displayed-set'], async () => {
      const date = localDate();
      if (!readCached(date)) await generateFor(date, 0);
    }).catch((error: unknown) => {
      console.warn('[recommendations] daily preload failed; retrying in one minute:', error);
    }).then(() => warm()).catch((error: unknown) => {
      console.warn('[recommendations] cover prefetch failed; retrying in one minute:', error);
    }).finally(() => { pending = false; });
  };
  // Checking the local date handles midnight, DST and a sleeping server without
  // re-rolling a valid daily set. Failed attempts retry on the next tick.
  const timer = setInterval(preload, 60_000);
  timer.unref();
  preload();
  return () => clearInterval(timer);
}

/** Monotonic nonce so each refresh draws differently (deterministic, unlike Math.random). */
let refreshNonce = 0;

/** Re-roll today's picks with a fresh seed (manual refresh). */
export async function refreshRecommendations(): Promise<RecommendationResponse> {
  return recommendationMutations.run(['displayed-set'], async () => {
    const date = localDate();
    // If a generation is already running (the day's first pass, another tab),
    // wait for it and then roll anyway: joining its promise would silently
    // discard this click's fresh seed and hand back whatever was in flight.
    if (inflight?.date === date) await inflight.promise.catch(() => {});
    // No cache pre-delete: a successful generation overwrites today's row, and
    // keeping the last good set means a failed refresh degrades to stale picks
    // instead of forcing every request into a full regeneration.
    return withOwned(await generateFor(date, ++refreshNonce));
  });
}
/** Explicit feedback excludes only this gallery; it never becomes an ownership/taste vote. */
export async function dismissAndReplace(source: DoujinSource, galleryId: string): Promise<RecommendationResponse> {
  return recommendationMutations.run(['displayed-set'], async () => {
    getDb().insert(schema.dismissedGalleries).values({ source, galleryId }).onConflictDoNothing().run();
    profileRevision += 1;
    const cached = readDisplayedSet();
    if (!cached) return displayedRecommendations();
    const updated = await reconcileDisplayedSet(cached);
    return withOwned(updated);
  });
}

/** Revalidate visible cards and promote spares using one policy for every feedback action. */
async function reconcileDisplayedSet(cached: CachedRecommendationSet, restore?: RecommendationItem): Promise<CachedRecommendationSet> {
  const eligible = await eligibleRecommendations([...cached.items, ...cached.reserve, ...(restore ? [restore] : [])]);
  const eligibleKeys = new Set(eligible.map(keyOf));
  let items = cached.items.filter(item => eligibleKeys.has(keyOf(item)));
  if (restore && eligibleKeys.has(keyOf(restore))) {
    const remaining = items.filter(item => keyOf(item) !== keyOf(restore));
    items = [restore, ...selectRecommendations(remaining.map(item => ({ result: item, score: 1, reasons: item.reasons, matched: new Set<string>() })), TOTAL_PICKS - 1, () => 0, [restore])];
  }
  const keys = new Set(items.map(keyOf));
  const reserve = [...cached.items, ...cached.reserve].filter(item => eligibleKeys.has(keyOf(item)) && !keys.has(keyOf(item)));
  const promoted = selectRecommendations(reserve.map(item => ({ result: item, score: 1, reasons: item.reasons, matched: new Set<string>() })), Math.max(0, TOTAL_PICKS - items.length), () => 0, items);
  items.push(...promoted);
  const used = new Set(items.map(keyOf));
  const updated: CachedRecommendationSet = { ...cached, items, reserve: reserve.filter(item => !used.has(keyOf(item))),
    profile: { ...termsFromPicks(items), language: cached.profile.language },
    degradedReason: items.length < TOTAL_PICKS ? 'insufficient-eligible' : cached.degradedReason === 'same-day-pool-exhausted' ? cached.degradedReason : null };
  commitDisplayedSet(updated, promoted);
  return updated;
}

/** Commit the displayed snapshot and its serve history as one local transaction. */
function commitDisplayedSet(set: CachedRecommendationSet, served: RecommendationItem[] = []): void {
  getDb().transaction(() => {
    if (served.length) addHistory(set.date, served);
    writeCached(set);
  });
}

/** Undo removes feedback, not true ownership; restore the original card when still eligible. */
export async function undoDismiss(source: DoujinSource, galleryId: string): Promise<RecommendationResponse> {
  return recommendationMutations.run(['displayed-set'], async () => {
    getDb().delete(schema.dismissedGalleries).where(and(eq(schema.dismissedGalleries.source, source), eq(schema.dismissedGalleries.galleryId, galleryId))).run();
    profileRevision += 1;
    return restoreHistoryItem(source, galleryId);
  });
}

async function restoreHistoryItem(source: DoujinSource, galleryId: string): Promise<RecommendationResponse> {
  const cached = readDisplayedSet();
  const original = readHistoryItem(source, galleryId);
  if (cached && original) return withOwned(await reconcileDisplayedSet(cached, original));
  return displayedRecommendations();
}

/** Use server-side history/provider metadata, not client-supplied taste signals. */
export async function applyRecommendationFeedback(action: FeedbackAction, target: { source: DoujinSource; galleryId: string; artist?: string }): Promise<{ feedback: RecommendationFeedback; recommendations: RecommendationResponse }> {
  return recommendationMutations.run(['displayed-set'], async () => {
    let item: DoujinSearchResult | undefined;
    if (action === 'like' || action === 'mute-artist') {
      item = readHistoryItem(target.source, target.galleryId);
      if (!item) {
        const provider = getDoujinProvider(target.source);
        if (!provider?.getGallery) throw new Error('Gallery metadata is unavailable');
        item = await provider.getGallery(target.galleryId);
      }
    }
    const feedback = saveRecommendationFeedback(action, target, item);
    profileRevision++;
    candidatePool = null;
    const cached = readDisplayedSet();
    const recommendations = cached ? await withOwned(await reconcileDisplayedSet(cached)) : await displayedRecommendations();
    return { feedback, recommendations };
  });
}

/** Library preferences apply to the next daily generation or explicit refresh. */
export function setExcludedLibraries(ids: number[]): void {
  setRecommendationSettings({ excludedLibraryIds: [...new Set(ids)] });
  clearRecommendationSignals();
  invalidateProfile();
}
