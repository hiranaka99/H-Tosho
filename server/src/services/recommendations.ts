import { and, asc, desc, eq, like, lt, ne } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery, DoujinSearchResult, DoujinSource, DoujinSort } from '../downloader/types.js';
import { mapLimit } from '../lib/http.js';
import { KavitaClient } from '../kavita/client.js';
import type { KavitaSeries } from '../kavita/types.js';
import { getKavitaConnection, getRecommendationSettings, setRecommendationSettings } from './settings.js';

/**
 * Daily doujinshi recommendations based on the user's downloaded library.
 *
 * Signal: the tag/artist profile of downloaded galleries (the `gallery_tags`
 * table — written when a download resolves its metadata, lazily backfilled for
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
 * `recommendations-v2:<date>`). "Refresh" busts the cache and re-rolls with a
 * fresh nonce. Every served pick enters a rolling cross-day history
 * (`recommendations-history`). Fresh personalized and popular candidates are
 * preferred; diversity caps relax only when needed. If those pools cannot fill
 * twelve slots, previously served picks return least-recently-shown first,
 * including same-day picks as the final fallback. Downloaded, owned, banned,
 * invalid, and duplicate galleries remain hard exclusions.
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
/** Total size of the daily set, split evenly across the registered sources. */
const TOTAL_PICKS = 12;
/** Hydrated spares cached with the visible set for instant owned-card replacement. */
const RESERVE_PICKS = 12;
const PICKS_PER_SOURCE = Math.max(1, Math.floor(TOTAL_PICKS / SOURCES.length));
/** Max picks per set a single tag/series term may dominate. */
const MAX_PICKS_PER_TERM = 2;
/** Artists get a stricter cap — one favorite artist should surface at most once per set. */
const MAX_PICKS_PER_ARTIST = 1;
/** Fewer profile terms than this → cold-start popularity fallback. */
const MIN_PROFILE_TERMS = 3;
/** Backfill cap per generation, and the tagged-gallery count below which it runs. */
const BACKFILL_LIMIT = 25;
// Hard bound on how many Kavita series the library scan touches (one metadata
// call each), so a very large library cannot stall daily generation.
const KAVITA_SERIES_LIMIT = 600;
/** Concurrent per-series metadata fetches against Kavita. */
const METADATA_PARALLELISM = 8;

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

// ---------------------------------------------------------------------------
// gallery_tags persistence
// ---------------------------------------------------------------------------

let profileRevision = 0;

/** Invalidate today's derived set whenever its taste inputs change. */
function invalidateProfile(): void {
  profileRevision += 1;
  emptyCooldownUntil = 0;
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, cacheKey(localDate()))).run();
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
    if (invalidate) invalidateProfile();
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

interface ProfileTerm {
  kind: 'artist' | 'tag' | 'series';
  name: string;
  /** Number of tagged galleries (or owned .cbz, for series) carrying this term. */
  weight: number;
  /** Search namespace observed per source (null = plain keyword). */
  nsBySource: Partial<Record<DoujinSource, string | null>>;
}

interface TasteProfile {
  terms: ProfileTerm[];
  /** Dominant language of the library, when one covers ≥60% of tagged galleries. */
  language: string | null;
}

function bumpTerm(terms: Map<string, ProfileTerm>, kind: 'artist' | 'tag' | 'series', name: string, source: DoujinSource | null, ns: string | null, weight = 1): void {
  const key = `${kind}:${name.toLowerCase()}`;
  let t = terms.get(key);
  if (!t) {
    t = { kind, name, weight: 0, nsBySource: {} };
    terms.set(key, t);
  }
  t.weight += weight;
  if (source === null) return; // library-scan terms are source-agnostic keywords
  const existing = t.nsBySource[source];
  // Prefer a concrete namespace over a keyword slot once seen.
  if (existing === undefined || (existing === null && ns !== null)) t.nsBySource[source] = ns;
}

function parseEntries(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Aggregate the per-gallery tag rows plus Kavita library signals into a weighted artist/tag/series profile. */
function buildProfile(signals: KavitaSeriesSignal[]): TasteProfile {
  const rows = getDb().select().from(schema.galleryTags).all();
  const terms = new Map<string, ProfileTerm>();
  const langCounts = new Map<string, number>();
  let taggedWithLang = 0;

  for (const row of rows) {
    const tags = parseEntries(row.tagsJson);
    const artists = parseEntries(row.artistsJson);
    const seenArtists = new Set<string>();
    for (const raw of artists) {
      const name = String(raw ?? '').trim();
      if (!name || seenArtists.has(name.toLowerCase())) continue;
      seenArtists.add(name.toLowerCase());
      bumpTerm(terms, 'artist', name, row.source as DoujinSource, null);
    }
    const seenTags = new Set<string>();
    for (const raw of tags) {
      const entry: GalleryTagEntry = typeof raw === 'string' ? { name: raw, ns: null } : { name: String((raw as GalleryTagEntry)?.name ?? ''), ns: (raw as GalleryTagEntry)?.ns ?? null };
      const name = entry.name.trim();
      if (!name || seenTags.has(name.toLowerCase())) continue;
      seenTags.add(name.toLowerCase());
      bumpTerm(terms, 'tag', name, row.source as DoujinSource, entry.ns);
    }
    const lang = row.language?.trim().toLowerCase();
    if (lang) {
      taggedWithLang += 1;
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
  }

  // Existing-library signals: ownership is one vote per series. Page count is
  // work length, not preference or engagement, and must not dominate tags from
  // several genuinely distinct owned works.
  for (const sig of signals) {
    const name = sig.name.trim();
    if (!name) continue;
    bumpTerm(terms, 'series', name, null, null);
    const seenTags = new Set<string>();
    for (const tag of sig.tags) {
      const t = tag.trim();
      if (!t || seenTags.has(t.toLowerCase())) continue;
      seenTags.add(t.toLowerCase());
      bumpTerm(terms, 'tag', t, null, null);
    }
    const seenArtists = new Set<string>();
    for (const artist of sig.artists) {
      const a = artist.trim();
      if (!a || seenArtists.has(a.toLowerCase())) continue;
      seenArtists.add(a.toLowerCase());
      bumpTerm(terms, 'artist', a, null, null);
    }
  }

  let language: string | null = null;
  if (taggedWithLang >= 5) {
    let best: [string, number] | null = null;
    for (const [l, n] of langCounts) if (!best || n > best[1]) best = [l, n];
    if (best && best[1] / taggedWithLang >= 0.6) language = best[0];
  }

  return { terms: [...terms.values()].sort((a, b) => b.weight - a.weight), language };
}

/** One Kavita series reduced to recommendation signals. */
export interface KavitaSeriesSignal {
  name: string;
  tags: string[];
  artists: string[];
}

/**
 * Fetch recommendation signals from the user's existing Kavita library via the
 * Kavita API — no local file access, so a large library (even on a network
 * drive) stays fast. Each series contributes its title (doujinshi sources
 * index fan works under the parody/series tag, so a series you own is a search
 * term) plus the genres/tags and writers Kavita already indexed from the
 * archives at scan time. Bounded by KAVITA_SERIES_LIMIT; any failure degrades
 * to an empty signal set so the download-based profile still works.
 */
// The scan below costs up to KAVITA_SERIES_LIMIT metadata calls and dominates
// generation time, yet the profile it feeds barely changes between refreshes —
// memoize it in memory. The key covers everything that can change the result:
// the connection and the excluded-library list. Failed scans are not cached, so
// a recovered Kavita is picked up on the next generation.
const KAVITA_SIGNALS_TTL_MS = 30 * 60_000;
let kavitaSignalsCache: { key: string; at: number; signals: KavitaSeriesSignal[] } | null = null;

async function buildKavitaSignals(): Promise<KavitaSeriesSignal[]> {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return [];
  // Libraries the user excluded from recommendations (e.g. a regular manga
  // collection that should not feed doujinshi searches). Part of the cache key.
  const excludedLibraries = new Set(getRecommendationSettings().excludedLibraryIds);
  const cacheKey = `${conn.baseUrl}|${[...excludedLibraries].sort((a, b) => a - b).join(',')}`;
  if (kavitaSignalsCache && kavitaSignalsCache.key === cacheKey && Date.now() - kavitaSignalsCache.at < KAVITA_SIGNALS_TTL_MS) {
    return kavitaSignalsCache.signals;
  }
  const client = new KavitaClient(conn.baseUrl, conn.apiKey);
  let libraries;
  try {
    libraries = await client.getLibraries();
  } catch (err) {
    console.warn('[recommendations] Kavita library scan skipped:', err instanceof Error ? err.message : err);
    return [];
  }

  // Phase 1: collect series across all libraries (one bulk call per library).
  const seriesList: KavitaSeries[] = [];
  for (const lib of libraries) {
    if (excludedLibraries.has(lib.id)) continue;
    let series: KavitaSeries[];
    try {
      series = await client.getSeries(lib.id);
    } catch (err) {
      console.warn(`[recommendations] Kavita series list skipped for library "${lib.name}":`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const s of series) {
      if (seriesList.length >= KAVITA_SERIES_LIMIT) break;
      seriesList.push(s);
    }
  }

  // Phase 2 (bounded parallelism): one metadata call per series. A failed
  // lookup still keeps the series title — it is a valid search term on its own.
  const signals: KavitaSeriesSignal[] = [];
  for (let i = 0; i < seriesList.length; i += METADATA_PARALLELISM) {
    const batch = await Promise.all(
      seriesList.slice(i, i + METADATA_PARALLELISM).map(async (s) => {
        try {
          const meta = await client.getSeriesMetadata(s.id);
          return {
            name: s.name,
            tags: [...(meta.genres ?? []), ...(meta.tags ?? [])].map((t) => t.title?.trim() ?? '').filter(Boolean),
            artists: (meta.writers ?? []).map((p) => p.name?.trim() ?? '').filter(Boolean),
          };
        } catch {
          return { name: s.name, tags: [] as string[], artists: [] as string[] };
        }
      }),
    );
    signals.push(...batch);
  }
  kavitaSignalsCache = { key: cacheKey, at: Date.now(), signals };
  return signals;
}

/**
 * Fill in tag data for completed downloads that predate the gallery_tags table
 * (or whose capture failed). Capped per run so the first recommendation pass
 * stays bounded; remaining galleries fill in on later generations.
 */
async function backfillMissingTags(): Promise<void> {
  const db = getDb();
  // Always inspect a bounded missing batch. A global row-count threshold would
  // strand large legacy libraries forever once any ten galleries were tagged.

  const tagged = new Set(
    db
      .select({ source: schema.galleryTags.source, galleryId: schema.galleryTags.galleryId })
      .from(schema.galleryTags)
      .all()
      .map((r) => `${r.source}:${r.galleryId}`),
  );
  const completed = db
    .select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId })
    .from(schema.downloadQueue)
    .where(eq(schema.downloadQueue.status, 'completed'))
    .orderBy(desc(schema.downloadQueue.id))
    .all();
  const missing = completed.filter((r) => !tagged.has(`${r.source}:${r.galleryId}`)).slice(0, BACKFILL_LIMIT);
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
          try {
            const gallery = await provider.getGallery(row.galleryId);
            persistGalleryTags(source, gallery, false);
          } catch {
            /* skip unreachable galleries — they stay untagged until a later pass */
          }
        }),
      );
    }
  }
}

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

const LANGUAGE_MATCH_BONUS = 1.5;

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

interface Candidate {
  result: DoujinSearchResult;
  score: number;
  reasons: string[];
  matched: Set<string>;
}

const keyOf = (r: { source: string; galleryId: string }) => `${r.source}:${r.galleryId}`;

function credit(c: Candidate, termKey: string, reason: string, weight: number): void {
  if (c.matched.has(termKey)) return;
  c.matched.add(termKey);
  c.score += weight;
  if (!c.reasons.includes(reason)) c.reasons.push(reason);
}

/** Match weight uses log-damped ownership frequency so common signals matter without dominating. */
function termScore(t: ProfileTerm): number {
  return 1 + Math.log2(1 + t.weight);
}

/** Search every spec and merge candidates by gallery (a gallery hit by several queries sums their weights). */
async function gatherCandidates(specs: QuerySpec[], downloaded: Set<string>, termIndex: Map<string, ProfileTerm>, preferredLanguage: string | null): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  // Run one spec's search, returning its raw results (or null when the query
  // failed — one failing query cannot kill the whole generation).
  const runSpec = async (spec: QuerySpec): Promise<DoujinSearchResult[] | null> => {
    const provider = getDoujinProvider(spec.source);
    if (!provider) return null;
    try {
      return await provider.search(spec.query, spec.results, spec.sort, { excludeTypes: EXCLUDED_GALLERY_TYPES, skip: spec.skip });
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
        for (const t of spec.terms) credit(c, `${t.kind}:${t.name.toLowerCase()}`, `${t.kind} ${t.name}`, termScore(t));
        // Hitomi results carry their own tag/artist lists — credit extra profile terms they share.
        if (r.source === 'hitomi') {
          for (const a of r.artists ?? []) {
            const t = termIndex.get(`artist:${a.toLowerCase()}`);
            if (t) credit(c, `artist:${a.toLowerCase()}`, `artist ${t.name}`, termScore(t));
          }
          for (const tag of r.tags ?? []) {
            const t = termIndex.get(`tag:${tag.toLowerCase()}`);
            if (t) credit(c, `tag:${tag.toLowerCase()}`, `tag ${t.name}`, termScore(t));
          }
          if (preferredLanguage && r.language?.trim().toLowerCase() === preferredLanguage) c.score += LANGUAGE_MATCH_BONUS;
        }
      }
    }
  }
  return out;
}

/**
 * Draws `count` picks by weighted sampling without replacement — draw
 * probability is proportional to a candidate's score, so top matches surface
 * most rolls without the same scoreboard winning every time (a sorted list
 * with small jitter could not: top scores always out-ranked the jitter). A
 * single term may contribute at most MAX_PICKS_PER_TERM picks (artists:
 * MAX_PICKS_PER_ARTIST), tracked across calls via `termPicks`, so no favorite
 * can dominate the whole set.
 */
function pickDaily(candidates: Candidate[], count: number, rng: () => number, termPicks: Map<string, number>): RecommendationItem[] {
  const pool = [...candidates];
  const out: RecommendationItem[] = [];
  while (out.length < count && pool.length > 0) {
    // A pick consumes every term it matches; allowing a heavier tag to hide an
    // already-saturated artist defeats the advertised diversity cap.
    const eligible = pool.filter((c) => !capReached(c, termPicks));
    if (!eligible.length) break;
    let total = 0;
    for (const c of eligible) total += c.score;
    // Roulette draw ∝ score; falls back to uniform when every score is 0.
    let chosen = eligible[Math.floor(rng() * eligible.length)];
    if (total > 0) {
      let r = rng() * total;
      for (const c of eligible) {
        r -= c.score;
        if (r <= 0) {
          chosen = c;
          break;
        }
      }
    }
    for (const term of chosen.matched) termPicks.set(term, (termPicks.get(term) ?? 0) + 1);
    out.push({ ...chosen.result, reasons: chosen.reasons });
    pool.splice(pool.indexOf(chosen), 1);
  }
  return out;
}

/** Weighted selection without diversity caps, used only after fresh popular candidates. */
function pickWithoutCaps(candidates: Candidate[], count: number, rng: () => number): RecommendationItem[] {
  const pool = [...candidates];
  const out: RecommendationItem[] = [];
  while (out.length < count && pool.length > 0) {
    let total = 0;
    for (const candidate of pool) total += candidate.score;
    let chosenIndex = Math.floor(rng() * pool.length);
    if (total > 0) {
      let draw = rng() * total;
      for (let i = 0; i < pool.length; i++) {
        draw -= pool[i].score;
        if (draw <= 0) {
          chosenIndex = i;
          break;
        }
      }
    }
    const [chosen] = pool.splice(chosenIndex, 1);
    out.push({ ...chosen.result, reasons: chosen.reasons });
  }
  return out;
}

function capReached(c: Candidate, termPicks: Map<string, number>): boolean {
  for (const term of c.matched) {
    const cap = term.startsWith('artist:') ? MAX_PICKS_PER_ARTIST : MAX_PICKS_PER_TERM;
    if ((termPicks.get(term) ?? 0) >= cap) return true;
  }
  return false;
}

/** Per-source budget of PICKS_PER_SOURCE, topped up from the leftovers when a source is thin. */
function pickWithBudget(candidates: Map<string, Candidate>, rng: () => number, termPicks: Map<string, number>): RecommendationItem[] {
  const picked: RecommendationItem[] = [];
  const pickedKeys = new Set<string>();
  for (const source of SOURCES) {
    const pool = [...candidates.values()].filter((c) => c.result.source === source);
    for (const item of pickDaily(pool, PICKS_PER_SOURCE, rng, termPicks)) {
      pickedKeys.add(keyOf(item));
      picked.push(item);
    }
  }
  if (picked.length < TOTAL_PICKS) {
    const rest = [...candidates.values()].filter((c) => !pickedKeys.has(keyOf(c.result)));
    picked.push(...pickDaily(rest, TOTAL_PICKS - picked.length, rng, termPicks));
  }
  return picked;
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
        const results = await provider.search(spec.query, TOTAL_PICKS + RESERVE_PICKS, spec.sort, { excludeTypes: EXCLUDED_GALLERY_TYPES, skip: Math.floor(rng() * ROLL_SKIP_WINDOW) });
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

/** Mark a gallery as owned (idempotent). */
export function markOwned(source: DoujinSource, galleryId: string): void {
  getDb()
    .insert(schema.ownedGalleries)
    .values({ source, galleryId })
    .onConflictDoNothing()
    .run();
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

function pruneHistory(): HistoryEntry[] {
  const cutoff = localDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000));
  const db = getDb();
  db.delete(schema.recommendationHistory).where(lt(schema.recommendationHistory.servedDate, cutoff)).run();
  const history = readHistory().slice(-MAX_HISTORY);
  const keep = new Set(history.map((entry) => entry.key));
  for (const row of db.select().from(schema.recommendationHistory).all()) {
    if (!keep.has(`${row.source}:${row.galleryId}`)) {
      db.delete(schema.recommendationHistory).where(and(eq(schema.recommendationHistory.source, row.source), eq(schema.recommendationHistory.galleryId, row.galleryId))).run();
    }
  }
  return history;
}

function addHistory(date: string, items: RecommendationItem[], history: HistoryEntry[]): void {
  const entries = new Map(history.map((entry) => [entry.key, entry]));
  const now = new Date().toISOString();
  for (const it of readSeenItems(date)) entries.set(keyOf(it), { key: keyOf(it), date, servedAt: now, item: it });
  for (const it of items) entries.set(keyOf(it), { key: keyOf(it), date, servedAt: now, item: it });
  writeHistory([...entries.values()].sort((a, b) => a.servedAt.localeCompare(b.servedAt)).slice(-MAX_HISTORY));
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, seenKey(date))).run();
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
  await backfillMissingTags();
  const kavitaSignals = await buildKavitaSignals();
  const profile = buildProfile(kavitaSignals);
  // Downloaded and owned galleries are hard exclusions. History is initially a
  // freshness exclusion, then becomes the least-recent fallback pool.
  const history = pruneHistory();
  const hardExcluded = new Set([...completedGalleryKeys(), ...ownedGalleryKeys()]);
  const freshExcluded = new Set([...hardExcluded, ...history.map((h) => h.key)]);

  let items: RecommendationItem[] = [];
  let libraryPicks = 0;
  let candidateCount = 0;
  let candidates = new Map<string, Candidate>();
  if (profile.terms.length >= MIN_PROFILE_TERMS) {
    const termIndex = new Map(profile.terms.map((t) => [`${t.kind}:${t.name.toLowerCase()}`, t]));
    const termPicks = new Map<string, number>();
    candidates = await gatherCandidates(buildQuerySpecs(profile, rng), freshExcluded, termIndex, profile.language);
    candidateCount = candidates.size;
    items = pickWithBudget(candidates, rng, termPicks);
    libraryPicks = items.length;
  }

  // Fresh popular galleries are preferred over relaxing personalized diversity.
  const popular = await gatherPopular(freshExcluded, rng);
  if (items.length < TOTAL_PICKS) {
    const existing = new Set(items.map(keyOf));
    for (const item of popular) {
      if (existing.has(keyOf(item))) continue;
      items.push(item);
      existing.add(keyOf(item));
      if (items.length >= TOTAL_PICKS) break;
    }
  }
  // Preserve freshness while relaxing only the per-term diversity caps.
  if (items.length < TOTAL_PICKS && candidates.size > 0) {
    const existing = new Set(items.map(keyOf));
    const remaining = [...candidates.values()].filter((candidate) => !existing.has(keyOf(candidate.result)));
    const relaxed = pickWithoutCaps(remaining, TOTAL_PICKS - items.length, rng);
    items.push(...relaxed);
    libraryPicks += relaxed.length;
  }

  // Last resort: recycle valid history least-recently-shown first. Earlier-day
  // entries naturally precede today's entries; same-day reuse occurs only when
  // no unseen or older recommendation can fill the panel.
  let repeatedCount = 0;
  let repeatedToday = false;
  if (items.length < TOTAL_PICKS) {
    const existing = new Set(items.map(keyOf));
    for (const entry of history) {
      if (hardExcluded.has(entry.key) || existing.has(entry.key)) continue;
      items.push(entry.item);
      existing.add(entry.key);
      repeatedCount += 1;
      repeatedToday ||= entry.date === date;
      if (items.length >= TOTAL_PICKS) break;
    }
  }
  // Keep hydrated, eligible leftovers beside the cached panel. Marking a card
  // owned can promote one synchronously instead of repeating all remote searches.
  const visibleKeys = new Set(items.map(keyOf));
  const reserve: RecommendationItem[] = [];
  const reserveKeys = new Set<string>();
  const addReserve = (item: RecommendationItem): void => {
    const key = keyOf(item);
    if (reserve.length >= RESERVE_PICKS || hardExcluded.has(key) || visibleKeys.has(key) || reserveKeys.has(key)) return;
    reserve.push(item);
    reserveKeys.add(key);
  };
  for (const candidate of candidates.values()) addReserve({ ...candidate.result, reasons: candidate.reasons });
  for (const item of popular) addReserve(item);
  for (const entry of history) addReserve(entry.item);


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
    if (!Array.isArray(set.items) || set.items.length === 0 || !set.items.every(isRecommendationItem)) return null;
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
    .where(and(like(schema.keyValueStore.key, 'recommendations-v2:%'), ne(schema.keyValueStore.key, cacheKey(set.date))))
    .run();
  db.delete(schema.keyValueStore)
    .where(like(schema.keyValueStore.key, 'recommendations-seen:%'))
    .run();
}

/** Serialize generation; invalidated profile inputs trigger a fresh pass before commit. */
let inflight: { date: string; promise: Promise<CachedRecommendationSet> } | null = null;

const EMPTY_RETRY_COOLDOWN_MS = 10 * 60_000;
let emptyCooldownUntil = 0;

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
      const history = pruneHistory();
      addHistory(date, set.items, history);
      if (set.items.length > 0) writeCached(set);
      else emptyCooldownUntil = Date.now() + EMPTY_RETRY_COOLDOWN_MS;
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
}

function withOwned(set: RecommendationSet): RecommendationResponse {
  const owned = ownedGalleryKeys();
  const { date, generatedAt, mode, profile, items, repeatedCount, degradedReason } = set;
  return { date, generatedAt, mode, profile, items: items.filter((item) => !owned.has(keyOf(item))), repeatedCount, degradedReason, ownedKeys: [...owned] };
}

export function getRecommendations(): Promise<RecommendationResponse> {
  const date = localDate();
  const cached = readCached(date);
  if (cached) {
    const response = withOwned(cached);
    if (response.items.length === TOTAL_PICKS || response.items.length === cached.items.length && cached.degradedReason === 'insufficient-eligible') {
      return Promise.resolve(response);
    }
    getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, cacheKey(date))).run();
  }
  if (Date.now() < emptyCooldownUntil) {
    return Promise.resolve(
      withOwned({ date, generatedAt: new Date().toISOString(), mode: 'popular', profile: { artists: [], tags: [], series: [], language: null }, items: [], repeatedCount: 0, degradedReason: 'insufficient-eligible' }),
    );
  }
  return generateFor(date, 0).then(withOwned);
}

/** Monotonic nonce so each refresh draws differently (deterministic, unlike Math.random). */
let refreshNonce = 0;

/** Re-roll today's picks with a fresh seed (manual refresh). */
export async function refreshRecommendations(): Promise<RecommendationResponse> {
  const date = localDate();
  // An explicit re-roll bypasses the empty-set cooldown.
  emptyCooldownUntil = 0;
  // If a generation is already running (the day's first pass, another tab),
  // wait for it and then roll anyway: joining its promise would silently
  // discard this click's fresh seed and hand back whatever was in flight.
  if (inflight?.date === date) await inflight.promise.catch(() => {});
  // No cache pre-delete: a successful generation overwrites today's row, and
  // keeping the last good set means a failed refresh degrades to stale picks
  // instead of forcing every request into a full regeneration.
  return withOwned(await generateFor(date, ++refreshNonce));
}
/** Mark a gallery owned and promote a pre-generated replacement without network work. */
export function markOwnedAndReplace(source: DoujinSource, galleryId: string): RecommendationResponse {
  markOwned(source, galleryId);
  const date = localDate();
  const cached = readCached(date);
  if (!cached) return withOwned({ date, generatedAt: new Date().toISOString(), mode: 'popular', profile: { artists: [], tags: [], series: [], language: null }, items: [], repeatedCount: 0, degradedReason: 'insufficient-eligible' });

  const owned = ownedGalleryKeys();
  const items = cached.items.filter((item) => !owned.has(keyOf(item)));
  const itemKeys = new Set(items.map(keyOf));
  const reserve = cached.reserve.filter((item) => !owned.has(keyOf(item)) && !itemKeys.has(keyOf(item)));
  const promoted: RecommendationItem[] = [];
  while (items.length < TOTAL_PICKS && reserve.length > 0) {
    const replacement = reserve.shift();
    if (!replacement) break;
    items.push(replacement);
    promoted.push(replacement);
    itemKeys.add(keyOf(replacement));
  }
  const updated: CachedRecommendationSet = {
    ...cached,
    items,
    reserve,
    profile: { ...termsFromPicks(items), language: cached.profile.language },
    degradedReason: items.length < TOTAL_PICKS ? 'insufficient-eligible' : cached.degradedReason,
  };
  writeCached(updated);
  if (promoted.length > 0) addHistory(date, promoted, pruneHistory());
  return withOwned(updated);
}

/** Replace the list of Kavita libraries feeding the profile; today's cached set is re-generated. */
export function setExcludedLibraries(ids: number[]): void {
  setRecommendationSettings({ excludedLibraryIds: [...new Set(ids)] });
  kavitaSignalsCache = null;
  invalidateProfile();
}
