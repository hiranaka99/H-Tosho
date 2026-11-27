import {
  buildProfile,
  backfillMissingTags,
  isBoilerplateTag,
  type ProfileTerm,
  type TasteProfile,
} from "./recommendationProfile.js";
import { MutationCoordinator } from "../lib/mutations.js";
const recommendationMutations = new MutationCoordinator();
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { getDoujinProvider } from "../downloader/providers.js";
import type {
  DoujinGallery,
  DoujinProvider,
  DoujinSearchResult,
  DoujinSort,
} from "../downloader/types.js";
import type { DoujinSource } from "../contracts/doujin.js";
import { mapLimit } from "../lib/http.js";
import {
  getDownloaderSettings,
  onSettingChange,
  setRecommendationSettings,
} from "./settings.js";
import {
  buildKavitaSignals,
  clearRecommendationSignals,
  onRecommendationSeriesChange,
} from "./recommendationSignals.js";
import {
  buildEligibilityContext,
  eligibleRecommendations,
  type EligibilityContext,
} from "./recommendationEligibility.js";
import {
  rankCandidates,
  selectBalancedRecommendations,
  selectRecommendations,
} from "./recommendationRanking.js";
import type { Candidate } from "./recommendationRanking.js";
import {
  getRecommendationFeedback,
  saveRecommendationFeedback,
  type FeedbackAction,
  type RecommendationFeedback,
} from "./recommendationFeedback.js";

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
const SOURCES = ["hitomi"] as const;

/** Top-N profile terms turned into one search query each, per source (capped at <=9 total). */
const ARTIST_QUERIES = 2; // artist terms per source — artists rotate, tags/series carry the set
const PAIR_QUERIES = 2; // distinctive co-occurring tag pairs (replaces single-tag/series slots)
const TAG_QUERIES = 4; // top tag terms per source when no tag pairs are available
const SERIES_QUERIES = 3; // top parody/series terms per source when no tag pairs are available
/**
 * How many heaviest terms per kind are eligible for weighted query sampling.
 * Wide pools let long-tail favorites surface while weight-proportional draws
 * keep core tastes prominent.
 */
const ARTIST_QUERY_POOL = 24;
const TAG_QUERY_POOL = 32;
const SERIES_QUERY_POOL = 20;
/** Results fetched per candidate query — hydration is one request per gallery, so the cap stays tight. */
const HITOMI_RESULTS_PER_QUERY = 12;
/**
 * Seeded skip window for candidate queries. Combined with `wrapSkip: true`,
 * popular rankings rotate cleanly while small artists/niche tags wrap within
 * their available catalog instead of returning empty slices.
 */
const ROLL_SKIP_WINDOW = 24;
const PAIR_SKIP_WINDOW = 12;
/** Per-kind popularity/recency horizons so artists surface both classics and new releases. */
const ARTIST_SORTS: DoujinSort[] = ["popular", "default", "popular-year"];
const PAIR_SORTS: DoujinSort[] = ["popular-year", "popular-month", "popular"];
const TAG_SORTS: DoujinSort[] = [
  "popular-year",
  "popular-month",
  "popular-week",
];
const SERIES_SORTS: DoujinSort[] = [
  "popular-year",
  "popular-month",
  "popular-week",
];
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
  mode: "library" | "mixed" | "popular";
  profile: RecommendationProfile;
  items: RecommendationItem[];
  /** Number of picks reused from recommendation history. */
  repeatedCount: number;
  /** Why fewer than twelve fresh picks could not be supplied. */
  degradedReason: "same-day-pool-exhausted" | "insufficient-eligible" | null;
}

interface CachedRecommendationSet extends RecommendationSet {
  reserve: RecommendationItem[];
}

const CANDIDATE_POOL_TTL_MS = 30 * 60_000;
let candidatePool: {
  key: string;
  at: number;
  provider: DoujinProvider | null;
  candidates: Map<string, Candidate>;
  popular: RecommendationItem[];
} | null = null;

// ---------------------------------------------------------------------------
// gallery_tags persistence
// ---------------------------------------------------------------------------

let profileRevision = 0;
onSettingChange("downloader", invalidateProfile);
onSettingChange("kavita-connection", invalidateProfile);
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
function persistGalleryTags(
  source: DoujinSource,
  gallery: DoujinGallery,
  invalidate: boolean
): void {
  const tags: GalleryTagEntry[] = (gallery.tags ?? [])
    .map((name, i) => ({
      name: String(name ?? "").trim(),
      ns: gallery.tagNamespaces?.[i] ?? null,
    }))
    .filter((t) => t.name);
  const artists = (gallery.artists ?? [])
    .map((a) => String(a ?? "").trim())
    .filter(Boolean);
  const parodies = [
    ...new Set(
      [...(gallery.parodies ?? []), ...(gallery.series ? [gallery.series] : [])]
        .map((p) => String(p ?? "").trim())
        .filter(Boolean)
    ),
  ];
  const characters = (gallery.characters ?? [])
    .map((ch) => String(ch ?? "").trim())
    .filter(Boolean);
  const groups = (gallery.groups ?? [])
    .map((g) => String(g ?? "").trim())
    .filter(Boolean);
  try {
    getDb()
      .insert(schema.galleryTags)
      .values({
        source,
        galleryId: gallery.galleryId,
        title: gallery.title,
        tagsJson: JSON.stringify(tags),
        artistsJson: JSON.stringify(artists),
        parodiesJson: JSON.stringify(parodies),
        charactersJson: JSON.stringify(characters),
        groupsJson: JSON.stringify(groups),
        language: gallery.language ?? null,
        fetchedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [schema.galleryTags.source, schema.galleryTags.galleryId],
        set: {
          title: gallery.title,
          tagsJson: JSON.stringify(tags),
          artistsJson: JSON.stringify(artists),
          parodiesJson: JSON.stringify(parodies),
          charactersJson: JSON.stringify(characters),
          groupsJson: JSON.stringify(groups),
          language: gallery.language ?? null,
          fetchedAt: new Date().toISOString(),
        },
      })
      .run();
    getDb()
      .insert(schema.ownedGalleries)
      .values({ source, galleryId: gallery.galleryId })
      .onConflictDoNothing()
      .run();
    if (invalidate) invalidateTasteInputs();
  } catch (err) {
    console.warn("[h-tosho] failed to record gallery tags:", err);
  }
}

export function recordGalleryTags(
  source: DoujinSource,
  gallery: DoujinGallery
): void {
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
const EXCLUDED_GALLERY_TYPES = ["imageset", "artistcg"];

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

interface ResolvedTagInfo {
  ns: string;
  count: number;
}

/** Hitomi search fragment for a profile term (null = not searchable). */
function fragmentFor(
  term: ProfileTerm,
  resolvedTags?: Map<string, ResolvedTagInfo>
): string | null {
  const name = term.name.trim();
  if (!name) return null;
  const encoded = name.replace(/\s+/g, "_");
  // Hitomi namespaces use underscores for multi-word values.
  if (term.kind === "artist") return `artist:${encoded}`;
  if (term.kind === "series") {
    // Fan works of a series are indexed under its name.
    return `series:${encoded}`;
  }
  const resolved = resolvedTags?.get(name.toLowerCase());
  const ns =
    term.nsBySource.hitomi ??
    (resolved && (resolved.ns === "female" || resolved.ns === "male")
      ? resolved.ns
      : null);
  if (ns === "language") return null; // language is handled as its own filter
  return ns ? `${ns}:${encoded}` : encoded;
}

/**
 * Resolve Hitomi namespaces & catalog counts for top profile tags (especially
 * un-namespaced tags from Kavita, nHentai, and liked galleries). Cached in the
 * provider; gracefully no-ops when the provider stub lacks `resolveTagInfo`.
 */
async function resolveProfileTags(
  profile: TasteProfile,
  provider: DoujinProvider | null | undefined
): Promise<Map<string, ResolvedTagInfo>> {
  const out = new Map<string, ResolvedTagInfo>();
  if (!provider?.resolveTagInfo) return out;
  const tagTerms = profile.terms
    .filter(
      (t) =>
        t.kind === "tag" &&
        (t.nsBySource.hitomi ?? null) !== "language" &&
        !isBoilerplateTag(t.name)
    )
    .slice(0, TAG_QUERY_POOL);
  const results = await mapLimit(tagTerms, 4, async (term) => {
    try {
      const info = await provider.resolveTagInfo!(term.name);
      return info ? { key: term.name.toLowerCase(), info } : null;
    } catch {
      return null;
    }
  });
  for (const entry of results) {
    if (entry)
      out.set(entry.key, { ns: entry.info.ns, count: entry.info.count });
  }
  return out;
}

/**
 * Weighted sampling without replacement over the top `poolSize` terms.
 * Uses sqrt(weight) so favorites are queried more frequently while long-tail
 * tastes still surface across rolls.
 */
function sampleWeightedTerms<T extends { weight: number }>(
  terms: T[],
  count: number,
  poolSize: number,
  rng: () => number,
  anchor = false
): T[] {
  const pool = terms.slice(0, poolSize);
  if (pool.length <= count) return pool;
  const selected: T[] = [];
  const remaining = [...pool];
  if (anchor && remaining.length > 0) {
    selected.push(remaining.shift()!);
  }
  while (selected.length < count && remaining.length > 0) {
    const weights = remaining.map((item) =>
      Math.sqrt(Math.max(0.1, item.weight))
    );
    const total = weights.reduce((sum, w) => sum + w, 0);
    let draw = rng() * total;
    let pick = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      draw -= weights[i];
      if (draw < 0) {
        pick = i;
        break;
      }
    }
    selected.push(remaining.splice(pick, 1)[0]);
  }
  return selected;
}

/**
 * Build up to 9 Hitomi candidate queries per roll:
 *   - 2 artist queries (classics + latest releases)
 *   - up to 2 co-occurring tag-pair queries (multi-tag synergy)
 *   - remaining tag queries (non-boilerplate only, with resolved namespaces)
 *   - series/parody queries (preferring confirmed parodies over Kavita titles)
 */
function buildQuerySpecs(
  profile: TasteProfile,
  rng: () => number,
  resolvedTags?: Map<string, ResolvedTagInfo>
): QuerySpec[] {
  const artists = sampleWeightedTerms(
    profile.terms.filter((t) => t.kind === "artist"),
    ARTIST_QUERIES,
    ARTIST_QUERY_POOL,
    rng,
    false
  );

  // Sample up to 2 distinctive co-occurring tag pairs.
  const sampledPairs = sampleWeightedTerms(
    profile.tagPairs.map((pair) => ({ ...pair, weight: pair.score })),
    PAIR_QUERIES,
    12,
    rng,
    false
  );
  const pairSpecs: QuerySpec[] = [];
  for (const source of SOURCES) {
    for (const pair of sampledPairs) {
      const fragA = fragmentFor(pair.a, resolvedTags);
      const fragB = fragmentFor(pair.b, resolvedTags);
      if (!fragA || !fragB || fragA === fragB) continue;
      pairSpecs.push({
        source,
        query: `${fragA} ${fragB}`,
        results: HITOMI_RESULTS_PER_QUERY,
        terms: [pair.a, pair.b],
        sort: PAIR_SORTS[Math.floor(rng() * PAIR_SORTS.length)],
        skip: Math.floor(rng() * PAIR_SKIP_WINDOW),
      });
    }
  }

  const allNonLangTags = profile.terms.filter(
    (t) => t.kind === "tag" && (t.nsBySource.hitomi ?? null) !== "language"
  );
  const distinctiveTags = allNonLangTags.filter(
    (t) => !isBoilerplateTag(t.name)
  );
  const tagCandidates =
    distinctiveTags.length > 0 ? distinctiveTags : allNonLangTags;
  const tagQuota =
    pairSpecs.length > 0
      ? Math.max(2, TAG_QUERIES - pairSpecs.length)
      : TAG_QUERIES;
  const tags = sampleWeightedTerms(
    tagCandidates,
    tagQuota,
    TAG_QUERY_POOL,
    rng,
    rng() < 0.4
  );

  const allSeries = profile.terms.filter((t) => t.kind === "series");
  const confirmedSeries = allSeries.filter(
    (t) => t.nsBySource.hitomi === "series"
  );
  const fallbackSeries = allSeries.filter(
    (t) => t.nsBySource.hitomi !== "series"
  );
  const seriesQuota =
    pairSpecs.length > 0 ? Math.min(2, SERIES_QUERIES) : SERIES_QUERIES;
  const seriesPool = [...confirmedSeries, ...fallbackSeries];
  const series = sampleWeightedTerms(
    seriesPool,
    seriesQuota,
    SERIES_QUERY_POOL,
    rng,
    confirmedSeries.length > 0 && rng() < 0.4
  );

  const specs: QuerySpec[] = [];
  for (const source of SOURCES) {
    for (const term of artists) {
      const frag = fragmentFor(term, resolvedTags);
      if (!frag) continue;
      specs.push({
        source,
        query: frag,
        results: HITOMI_RESULTS_PER_QUERY,
        terms: [term],
        sort: ARTIST_SORTS[Math.floor(rng() * ARTIST_SORTS.length)],
        skip: Math.floor(rng() * ROLL_SKIP_WINDOW),
      });
    }
    for (const spec of pairSpecs) {
      if (spec.source === source) specs.push(spec);
    }
    for (const term of tags) {
      const frag = fragmentFor(term, resolvedTags);
      if (!frag) continue;
      specs.push({
        source,
        query: frag,
        results: HITOMI_RESULTS_PER_QUERY,
        terms: [term],
        sort: TAG_SORTS[Math.floor(rng() * TAG_SORTS.length)],
        skip: Math.floor(rng() * ROLL_SKIP_WINDOW),
      });
    }
    for (const term of series) {
      const frag = fragmentFor(term, resolvedTags);
      if (!frag) continue;
      specs.push({
        source,
        query: frag,
        results: HITOMI_RESULTS_PER_QUERY,
        terms: [term],
        sort: SERIES_SORTS[Math.floor(rng() * SERIES_SORTS.length)],
        skip: Math.floor(rng() * ROLL_SKIP_WINDOW),
      });
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Scoring + daily selection
// ---------------------------------------------------------------------------

const keyOf = (r: { source: string; galleryId: string }) =>
  `${r.source}:${r.galleryId}`;

function credit(c: Candidate, termKey: string, reason: string): void {
  if (c.matched.has(termKey)) return;
  c.matched.add(termKey);
  if (!c.reasons.includes(reason)) c.reasons.push(reason);
}

function numericHitomiIds(keys: Set<string>): Set<number> {
  const out = new Set<number>();
  for (const key of keys) {
    if (!key.startsWith("hitomi:")) continue;
    const id = Number(key.slice("hitomi:".length));
    if (Number.isSafeInteger(id) && id > 0) out.add(id);
  }
  return out;
}

/** Search every spec and merge candidates by gallery (a gallery hit by several queries sums their weights). */
async function gatherCandidates(
  specs: QuerySpec[],
  downloaded: Set<string>,
  termIndex: Map<string, ProfileTerm>,
  excludeIds?: Set<number>,
  queryLanguage?: string
): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  // Run one spec's search, returning its raw results (or null when the query
  // failed — one failing query cannot kill the whole generation).
  const runSpec = async (
    spec: QuerySpec
  ): Promise<DoujinSearchResult[] | null> => {
    const provider = getDoujinProvider(spec.source);
    if (!provider) return null;
    try {
      return await provider.search(spec.query, spec.results, spec.sort, {
        excludeTypes: EXCLUDED_GALLERY_TYPES,
        skip: spec.skip,
        wrapSkip: true,
        excludeIds,
        language: queryLanguage,
        strictExclusions: true,
      });
    } catch (err) {
      console.warn(
        `[h-tosho] recommendations query failed (${spec.source} “${spec.query}”):`,
        err instanceof Error ? err.message : err
      );
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
    [...bySource.values()].map((group) => mapLimit(group, 4, runSpec))
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
        for (const t of spec.terms)
          credit(c, `${t.kind}:${t.name.toLowerCase()}`, `${t.kind} ${t.name}`);
        // Hitomi results carry their own tag/artist/parody lists — credit extra profile terms they share.
        if (r.source === "hitomi") {
          for (const a of r.artists ?? []) {
            const t = termIndex.get(`artist:${a.toLowerCase()}`);
            if (t) credit(c, `artist:${a.toLowerCase()}`, `artist ${t.name}`);
          }
          for (const tag of r.tags ?? []) {
            const t = termIndex.get(`tag:${tag.toLowerCase()}`);
            if (t) credit(c, `tag:${tag.toLowerCase()}`, `tag ${t.name}`);
          }
          for (const parody of r.parodies ?? []) {
            const t = termIndex.get(`series:${parody.toLowerCase()}`);
            if (t)
              credit(c, `series:${parody.toLowerCase()}`, `series ${t.name}`);
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

const POPULAR_FALLBACK: Record<
  (typeof SOURCES)[number],
  { query: string; sort: DoujinSort }
> = {
  hitomi: { query: "doujinshi", sort: "popular-year" },
};

async function gatherPopular(
  downloaded: Set<string>,
  rng: () => number,
  excludeIds?: Set<number>,
  queryLanguage?: string
): Promise<RecommendationItem[]> {
  const out: RecommendationItem[] = [];
  await Promise.all(
    SOURCES.map(async (source) => {
      const provider = getDoujinProvider(source);
      if (!provider) return;
      const spec = POPULAR_FALLBACK[source];
      try {
        const results = await provider.search(
          spec.query,
          TOTAL_PICKS + RESERVE_PICKS,
          spec.sort,
          {
            excludeTypes: EXCLUDED_GALLERY_TYPES,
            skip: Math.floor(rng() * ROLL_SKIP_WINDOW),
            wrapSkip: true,
            excludeIds,
            language: queryLanguage,
            strictExclusions: true,
          }
        );
        const pool = results.filter((r) => !downloaded.has(keyOf(r)));
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        out.push(
          ...pool
            .slice(0, TOTAL_PICKS + RESERVE_PICKS)
            .map((r) => ({ ...r, reasons: [] as string[] }))
        );
      } catch (err) {
        console.warn(
          `[h-tosho] recommendations popular fetch failed (${source}):`,
          err instanceof Error ? err.message : err
        );
      }
    })
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Generation + daily cache
// ---------------------------------------------------------------------------

const HISTORY_KEY = "recommendations-history";
const HISTORY_DAYS = 30;
const MAX_HISTORY = 1200;

interface HistoryEntry {
  key: string;
  date: string;
  servedAt: string;
  item: RecommendationItem;
}

function isRecommendationItem(value: unknown): value is RecommendationItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RecommendationItem>;
  return (
    (item.source === "hitomi" || item.source === "nhentai") &&
    typeof item.galleryId === "string" &&
    item.galleryId.length > 0 &&
    typeof item.title === "string" &&
    Array.isArray(item.tags) &&
    Array.isArray(item.artists) &&
    Array.isArray(item.reasons)
  );
}

function parseHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<HistoryEntry>;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? "") ||
    !isRecommendationItem(entry.item)
  )
    return null;
  const key = keyOf(entry.item);
  const servedAt =
    typeof entry.servedAt === "string" &&
    !Number.isNaN(Date.parse(entry.servedAt))
      ? entry.servedAt
      : `${entry.date}T00:00:00.000Z`;
  return entry.key === key
    ? { key, date: entry.date!, servedAt, item: entry.item }
    : null;
}

function writeHistory(entries: HistoryEntry[]): void {
  const db = getDb();
  const keep = new Set(entries.map((entry) => entry.key));
  db.transaction((tx) => {
    const toDeleteBySource = new Map<string, string[]>();
    for (const row of tx
      .select({
        source: schema.recommendationHistory.source,
        galleryId: schema.recommendationHistory.galleryId,
      })
      .from(schema.recommendationHistory)
      .all()) {
      if (!keep.has(`${row.source}:${row.galleryId}`)) {
        let list = toDeleteBySource.get(row.source);
        if (!list) {
          list = [];
          toDeleteBySource.set(row.source, list);
        }
        list.push(row.galleryId);
      }
    }
    for (const [source, ids] of toDeleteBySource) {
      for (let i = 0; i < ids.length; i += 500) {
        tx.delete(schema.recommendationHistory)
          .where(
            and(
              eq(schema.recommendationHistory.source, source),
              inArray(
                schema.recommendationHistory.galleryId,
                ids.slice(i, i + 500)
              )
            )
          )
          .run();
      }
    }
    for (const entry of entries) {
      const itemJson = JSON.stringify(entry.item);
      tx.insert(schema.recommendationHistory)
        .values({
          source: entry.item.source,
          galleryId: entry.item.galleryId,
          servedDate: entry.date,
          servedAt: entry.servedAt,
          itemJson,
        })
        .onConflictDoUpdate({
          target: [
            schema.recommendationHistory.source,
            schema.recommendationHistory.galleryId,
          ],
          set: { servedDate: entry.date, servedAt: entry.servedAt, itemJson },
        })
        .run();
    }
  });
}

/** Read normalized history and migrate the legacy JSON blob once. */
function readHistory(): HistoryEntry[] {
  const db = getDb();
  const normalized = db
    .select()
    .from(schema.recommendationHistory)
    .orderBy(asc(schema.recommendationHistory.servedAt))
    .all();
  if (normalized.length) {
    return normalized.flatMap((row) => {
      try {
        return (
          parseHistoryEntry({
            key: `${row.source}:${row.galleryId}`,
            date: row.servedDate,
            servedAt: row.servedAt,
            item: JSON.parse(row.itemJson) as unknown,
          }) ?? []
        );
      } catch {
        return [];
      }
    });
  }
  const legacyRow = db
    .select()
    .from(schema.keyValueStore)
    .where(eq(schema.keyValueStore.key, HISTORY_KEY))
    .get();
  if (!legacyRow) return [];
  try {
    const parsed: unknown = JSON.parse(legacyRow.valueJson);
    if (!Array.isArray(parsed)) return [];
    const entries = (parsed as unknown[])
      .map(parseHistoryEntry)
      .filter((entry): entry is HistoryEntry => entry !== null);
    writeHistory(entries);
    db.delete(schema.keyValueStore)
      .where(eq(schema.keyValueStore.key, HISTORY_KEY))
      .run();
    return entries;
  } catch {
    return [];
  }
}

function readHistoryItem(
  source: string,
  galleryId: string
): RecommendationItem | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(schema.recommendationHistory)
    .where(
      and(
        eq(schema.recommendationHistory.source, source),
        eq(schema.recommendationHistory.galleryId, galleryId)
      )
    )
    .get();
  if (row) {
    try {
      return parseHistoryEntry({
        key: `${row.source}:${row.galleryId}`,
        date: row.servedDate,
        servedAt: row.servedAt,
        item: JSON.parse(row.itemJson) as unknown,
      })?.item;
    } catch {
      return undefined;
    }
  }
  // Legacy migration fallback only when the normalized table is completely empty.
  const anyRow = db
    .select({ source: schema.recommendationHistory.source })
    .from(schema.recommendationHistory)
    .limit(1)
    .get();
  if (!anyRow)
    return readHistory().find((entry) => entry.key === `${source}:${galleryId}`)
      ?.item;
  return undefined;
}

function pruneHistoryRows(): void {
  const cutoff = localDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000));
  const db = getDb();
  db.delete(schema.recommendationHistory)
    .where(lt(schema.recommendationHistory.servedDate, cutoff))
    .run();
  db.run(
    sql`DELETE FROM recommendation_history WHERE rowid NOT IN (SELECT rowid FROM recommendation_history ORDER BY served_at DESC LIMIT ${MAX_HISTORY})`
  );
}

function pruneHistory(): HistoryEntry[] {
  pruneHistoryRows();
  return readHistory().slice(-MAX_HISTORY);
}

function addHistory(date: string, items: RecommendationItem[]): void {
  const db = getDb();
  // Ensure any legacy blob is migrated once before incremental upserts.
  const anyRow = db
    .select({ source: schema.recommendationHistory.source })
    .from(schema.recommendationHistory)
    .limit(1)
    .get();
  if (!anyRow) readHistory();
  const seen = readSeenItems(date);
  const now = new Date().toISOString();
  const byKey = new Map<string, RecommendationItem>();
  for (const it of seen) byKey.set(keyOf(it), it);
  for (const it of items) byKey.set(keyOf(it), it);
  for (const it of byKey.values()) {
    const itemJson = JSON.stringify(it);
    db.insert(schema.recommendationHistory)
      .values({
        source: it.source,
        galleryId: it.galleryId,
        servedDate: date,
        servedAt: now,
        itemJson,
      })
      .onConflictDoUpdate({
        target: [
          schema.recommendationHistory.source,
          schema.recommendationHistory.galleryId,
        ],
        set: { servedDate: date, servedAt: now, itemJson },
      })
      .run();
  }
  pruneHistoryRows();
  db.delete(schema.keyValueStore)
    .where(eq(schema.keyValueStore.key, seenKey(date)))
    .run();
}

const seenKey = (date: string) => `recommendations-seen:${date}`;

function readSeenItems(date: string): RecommendationItem[] {
  const row = getDb()
    .select()
    .from(schema.keyValueStore)
    .where(eq(schema.keyValueStore.key, seenKey(date)))
    .get();
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.valueJson);
    return Array.isArray(parsed)
      ? (parsed as unknown[]).filter(isRecommendationItem)
      : [];
  } catch {
    return [];
  }
}

function termsFromPicks(items: RecommendationItem[]): {
  artists: string[];
  tags: string[];
  series: string[];
} {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const reason of item.reasons)
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const byKind: Record<"artist" | "tag" | "series", [string, number][]> = {
    artist: [],
    tag: [],
    series: [],
  };
  for (const [reason, count] of counts) {
    const separator = reason.indexOf(" ");
    if (separator <= 0) continue;
    const kind = reason.slice(0, separator);
    if (kind === "artist" || kind === "tag" || kind === "series")
      byKind[kind].push([reason.slice(separator + 1), count]);
  }
  const top = (list: [string, number][]) =>
    list
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name);
  return {
    artists: top(byKind.artist),
    tags: top(byKind.tag),
    series: top(byKind.series),
  };
}
async function doGenerate(
  date: string,
  nonce: number
): Promise<CachedRecommendationSet> {
  const rng = mulberry32(hashSeed(`${date}:${nonce}`));
  await backfillMissingTags(persistGalleryTags);
  const kavitaSignals = await buildKavitaSignals();
  const profile = buildProfile(kavitaSignals);
  // Downloaded, queued, owned, dismissed, and unreviewed Following items are
  // hard exclusions. History is initially a freshness exclusion, then becomes
  // the least-recent fallback pool.
  const history = pruneHistory();
  // One exclusion snapshot serves every eligibility pass of this roll. Mid-roll
  // taste/feedback changes bump profileRevision and re-run the roll, and the
  // response path (withOwned) revalidates against fresh state.
  const eligibility = buildEligibilityContext();
  const hardExcluded = new Set([
    ...eligibility.activeDownloads,
    ...eligibility.owned,
    ...eligibility.unreviewedFollowing,
    ...eligibility.dismissed,
  ]);
  const freshExcluded = new Set([
    ...hardExcluded,
    ...history.map((h) => h.key),
  ]);
  const excludeIds = numericHitomiIds(freshExcluded);
  const queryLanguage =
    profile.language ?? (profile.multiLanguage ? "all" : undefined);

  let items: RecommendationItem[] = [];
  let libraryPicks = 0;
  let candidateCount = 0;
  const poolKey = JSON.stringify([
    profile,
    getDownloaderSettings().hitomiBannedTags,
  ]);
  const provider = getDoujinProvider("hitomi");
  if (
    !candidatePool ||
    candidatePool.key !== poolKey ||
    candidatePool.provider !== provider ||
    Date.now() - candidatePool.at >= CANDIDATE_POOL_TTL_MS
  ) {
    candidatePool = {
      key: poolKey,
      at: Date.now(),
      provider,
      candidates: new Map(),
      popular: [],
    };
  }
  const pool = candidatePool;
  const asCandidate = (item: RecommendationItem): Candidate => ({
    result: item,
    score: 1,
    reasons: item.reasons,
    matched: new Set(),
  });
  const readFreshPool = async () => {
    const combined = new Map<string, DoujinSearchResult>();
    for (const candidate of pool.candidates.values())
      combined.set(keyOf(candidate.result), candidate.result);
    for (const item of pool.popular) {
      const k = keyOf(item);
      if (!combined.has(k)) combined.set(k, item);
    }
    const eligible = await eligibleRecommendations(
      [...combined.values()],
      eligibility
    );
    const eligibleKeys = new Set(eligible.map(keyOf));
    const candidates = new Map(
      [...pool.candidates].filter(
        ([key]) => eligibleKeys.has(key) && !freshExcluded.has(key)
      )
    );
    const popular = pool.popular.filter((item) => {
      const k = keyOf(item);
      return eligibleKeys.has(k) && !freshExcluded.has(k);
    });
    return { candidates, popular };
  };
  let { candidates, popular } = await readFreshPool();
  let resolvedTags = new Map<string, ResolvedTagInfo>();
  // Count picks under the same gallery/work/artist constraints as selection,
  // rather than treating many galleries from one artist as a full pool. This
  // probe leaves the roll's RNG untouched and fetching stays bounded to one batch.
  const usable = selectRecommendations(
    [
      ...[...candidates.values()].map((candidate) => ({
        ...candidate,
        score: 1,
      })),
      ...popular.map(asCandidate),
    ],
    TOTAL_PICKS + RESERVE_PICKS,
    () => 0
  );
  if (usable.length < TOTAL_PICKS + RESERVE_PICKS) {
    if (
      profile.terms.length >= MIN_PROFILE_TERMS ||
      getRecommendationFeedback().liked.length > 0
    ) {
      resolvedTags = await resolveProfileTags(profile, provider);
      const termIndex = new Map(
        profile.terms.map((term) => [
          `${term.kind}:${term.name.toLowerCase()}`,
          term,
        ])
      );
      const fetched = await gatherCandidates(
        buildQuerySpecs(profile, rng, resolvedTags),
        hardExcluded,
        termIndex,
        excludeIds,
        queryLanguage
      );
      for (const [key, candidate] of fetched)
        pool.candidates.set(key, candidate);
    }
    const fetchedPopular = await gatherPopular(
      hardExcluded,
      rng,
      excludeIds,
      queryLanguage
    );
    const popularByKey = new Map(
      pool.popular.map((item) => [keyOf(item), item])
    );
    for (const item of fetchedPopular) popularByKey.set(keyOf(item), item);
    pool.popular = [...popularByKey.values()].slice(-240);
    pool.candidates = new Map([...pool.candidates].slice(-480));
    ({ candidates, popular } = await readFreshPool());
  }
  candidateCount = candidates.size;
  const globalTagCounts = new Map<string, number>();
  for (const [name, info] of resolvedTags) {
    if (info.count > 0) globalTagCounts.set(`tag:${name}`, info.count);
  }
  rankCandidates(
    [...candidates.values()],
    new Map(
      profile.terms.map((term) => [
        `${term.kind}:${term.name.toLowerCase()}`,
        term.weight,
      ])
    ),
    profile.language,
    {
      dislikedTerms: profile.dislikedTerms,
      globalTagCounts: globalTagCounts.size > 0 ? globalTagCounts : undefined,
      preferredPageCount: profile.preferredPageCount,
    }
  );
  items = selectBalancedRecommendations(
    [...candidates.values()],
    TOTAL_PICKS,
    rng
  );
  libraryPicks = items.length;
  items.push(
    ...selectRecommendations(
      popular.map(asCandidate),
      TOTAL_PICKS - items.length,
      rng,
      items
    )
  );

  // Last resort: recycle valid history least-recently-shown first. Earlier-day
  // entries naturally precede today's entries; same-day reuse occurs only when
  // no unseen or older recommendation can fill the panel.
  let repeatedCount = 0;
  let repeatedToday = false;
  if (items.length < TOTAL_PICKS) {
    const historyDateByKey = new Map(
      history.map((entry) => [entry.key, entry.date])
    );
    const eligibleHistory = await eligibleRecommendations(
      history.map((entry) => entry.item),
      eligibility
    );
    for (const item of eligibleHistory) {
      // Preserve least-recent ordering while enforcing artist/work exclusions.
      const selected = selectRecommendations(
        [asCandidate(item)],
        1,
        rng,
        items
      );
      if (!selected.length) continue;
      items.push(item);
      repeatedCount += 1;
      repeatedToday ||= historyDateByKey.get(keyOf(item)) === date;
      if (items.length >= TOTAL_PICKS) break;
    }
  }
  // Reserves are ordered highest-scored first so card dismissals promote strong spares.
  const visibleKeys = new Set(items.map(keyOf));
  const leftovers = [...candidates.values()]
    .filter((candidate) => !visibleKeys.has(keyOf(candidate.result)))
    .sort((a, b) => b.score - a.score);
  const reserve = selectRecommendations(leftovers, RESERVE_PICKS, () => 0);
  reserve.push(
    ...selectRecommendations(
      popular.filter((item) => !visibleKeys.has(keyOf(item))).map(asCandidate),
      RESERVE_PICKS - reserve.length,
      rng,
      reserve
    )
  );

  const popularPicks = items.length - libraryPicks;
  const mode: RecommendationSet["mode"] =
    libraryPicks === 0 ? "popular" : popularPicks > 0 ? "mixed" : "library";
  const degradedReason: RecommendationSet["degradedReason"] = repeatedToday
    ? "same-day-pool-exhausted"
    : items.length < TOTAL_PICKS
      ? "insufficient-eligible"
      : null;

  console.info(
    `[recommendations] generated mode=${mode} terms=${profile.terms.length} candidates=${candidateCount} library=${libraryPicks} popular=${popularPicks} repeated=${repeatedCount} total=${items.length}`
  );
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

function parseCachedSet(valueJson: string): CachedRecommendationSet | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (!parsed || typeof parsed !== "object") return null;
    const set = parsed as Partial<CachedRecommendationSet>;
    if (!Array.isArray(set.items) || !set.items.every(isRecommendationItem))
      return null;
    const reserve = Array.isArray(set.reserve)
      ? set.reserve.filter(isRecommendationItem)
      : [];
    const profile = set.profile;
    if (
      !profile ||
      !Array.isArray(profile.artists) ||
      !Array.isArray(profile.tags) ||
      !Array.isArray(profile.series)
    )
      return null;
    if (
      ![...profile.artists, ...profile.tags, ...profile.series].every(
        (value) => typeof value === "string"
      )
    )
      return null;
    if (profile.language !== null && typeof profile.language !== "string")
      return null;
    const repeatedCount =
      typeof set.repeatedCount === "number" ? set.repeatedCount : 0;
    const degradedReason =
      set.degradedReason === "same-day-pool-exhausted" ||
      set.degradedReason === "insufficient-eligible"
        ? set.degradedReason
        : null;
    if (
      set.items.length < TOTAL_PICKS &&
      degradedReason !== "insufficient-eligible"
    )
      return null;
    return {
      ...set,
      reserve,
      repeatedCount,
      degradedReason,
    } as CachedRecommendationSet;
  } catch {
    return null;
  }
}

function readCached(date: string): CachedRecommendationSet | null {
  const row = getDb()
    .select({ valueJson: schema.keyValueStore.valueJson })
    .from(schema.keyValueStore)
    .where(eq(schema.keyValueStore.key, cacheKey(date)))
    .get();
  return row ? parseCachedSet(row.valueJson) : null;
}

/** Feedback after midnight edits the displayed set, without starting a new day. */
function readDisplayedSet(): CachedRecommendationSet | null {
  const row = getDb()
    .select({ valueJson: schema.keyValueStore.valueJson })
    .from(schema.keyValueStore)
    .where(
      and(
        gte(schema.keyValueStore.key, "recommendations-v2:"),
        lt(schema.keyValueStore.key, "recommendations-v2;")
      )
    )
    .orderBy(desc(schema.keyValueStore.key))
    .limit(1)
    .get();
  return row ? parseCachedSet(row.valueJson) : null;
}

function writeCached(set: CachedRecommendationSet): void {
  const db = getDb();
  const valueJson = JSON.stringify(set);
  db.insert(schema.keyValueStore)
    .values({ key: cacheKey(set.date), valueJson })
    .onConflictDoUpdate({
      target: schema.keyValueStore.key,
      set: { valueJson },
    })
    .run();
  // Keep only today's cached set (the rolling history row prunes itself), and
  // drop legacy per-day seen rows superseded by the history.
  db.delete(schema.keyValueStore)
    .where(
      and(
        gte(schema.keyValueStore.key, "recommendations-v2:"),
        lt(schema.keyValueStore.key, "recommendations-v2;"),
        ne(schema.keyValueStore.key, cacheKey(set.date))
      )
    )
    .run();
  db.delete(schema.keyValueStore)
    .where(
      and(
        gte(schema.keyValueStore.key, "recommendations-seen:"),
        lt(schema.keyValueStore.key, "recommendations-seen;")
      )
    )
    .run();
}

/** Serialize generation; invalidated profile inputs trigger a fresh pass before commit. */
let inflight: {
  date: string;
  promise: Promise<CachedRecommendationSet>;
} | null = null;

function generateFor(
  date: string,
  nonce: number
): Promise<CachedRecommendationSet> {
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

async function withOwned(
  set: RecommendationSet,
  context?: EligibilityContext
): Promise<RecommendationResponse> {
  // Ownership keys stay complete: the UI badges arbitrary search results with
  // them, not just these picks. Other exclusions are looked up per pick.
  const eligibility = context ?? buildEligibilityContext(set.items);
  const { date, generatedAt, mode, profile, repeatedCount, degradedReason } =
    set;
  const eligible = await eligibleRecommendations(set.items, eligibility);
  // These picks were already ranked. Filtering ownership must preserve their order.
  const items = eligible.slice(0, TOTAL_PICKS);
  return {
    date,
    generatedAt,
    mode,
    profile,
    items,
    repeatedCount,
    degradedReason:
      items.length < TOTAL_PICKS ? "insufficient-eligible" : degradedReason,
    ownedKeys: [...eligibility.owned],
    dismissedKeys: [...eligibility.dismissed],
  };
}

function displayedRecommendations(): Promise<RecommendationResponse> {
  return withOwned(
    readDisplayedSet() ?? {
      date: localDate(),
      generatedAt: new Date().toISOString(),
      mode: "popular",
      profile: { artists: [], tags: [], series: [], language: null },
      items: [],
      repeatedCount: 0,
      degradedReason: "insufficient-eligible",
    }
  );
}

export async function getRecommendations(): Promise<RecommendationResponse> {
  return recommendationMutations.run(["displayed-set"], async () => {
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
export type CoverWarmer = (
  urls: string[]
) => Promise<{ loaded: number; failed: number }>;

/** Attempts per displayed set before cover warming gives up until the set changes. */
const COVER_WARM_ATTEMPTS = 5;

/**
 * Prepare each day's persisted picks — and their cover images — even when no
 * browser has the app open, so the first visit of the day renders instantly.
 */
export function startRecommendationPreloading(
  warmCovers?: CoverWarmer
): () => void {
  let pending = false;
  // Warming is keyed by the displayed set's generation stamp, so a new day, a
  // manual refresh or a settings re-roll each warm their own covers once.
  let warmed: { generatedAt: string; attempts: number; done: boolean } | null =
    null;
  const warm = async (): Promise<void> => {
    if (!warmCovers) return;
    const set = readDisplayedSet();
    if (!set) return;
    if (warmed?.generatedAt !== set.generatedAt)
      warmed = { generatedAt: set.generatedAt, attempts: 0, done: false };
    if (warmed.done || warmed.attempts >= COVER_WARM_ATTEMPTS) return;
    warmed.attempts += 1;
    const urls = [...set.items, ...set.reserve]
      .map((item) => item.coverUrl)
      .filter(
        (url): url is string =>
          typeof url === "string" && url.startsWith("http")
      );
    const { failed } = await warmCovers(urls);
    // Cached covers are disk hits, so retrying only re-fetches the failures.
    if (failed === 0) warmed.done = true;
    else
      console.warn(
        `[recommendations] ${failed} cover(s) failed to prefetch; retrying in one minute`
      );
  };
  const preload = (): void => {
    if (pending) return;
    pending = true;
    void recommendationMutations
      .run(["displayed-set"], async () => {
        const date = localDate();
        if (!readCached(date)) await generateFor(date, 0);
      })
      .catch((error: unknown) => {
        console.warn(
          "[recommendations] daily preload failed; retrying in one minute:",
          error
        );
      })
      .then(() => warm())
      .catch((error: unknown) => {
        console.warn(
          "[recommendations] cover prefetch failed; retrying in one minute:",
          error
        );
      })
      .finally(() => {
        pending = false;
      });
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
  return recommendationMutations.run(["displayed-set"], async () => {
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
/** Explicit feedback excludes this gallery and records its metadata as a soft negative taste signal. */
export async function dismissAndReplace(
  source: DoujinSource,
  galleryId: string
): Promise<RecommendationResponse> {
  return recommendationMutations.run(["displayed-set"], async () => {
    const cached = readDisplayedSet();
    const targetKey = `${source}:${galleryId}`;
    const known =
      cached?.items.find((item) => keyOf(item) === targetKey) ??
      cached?.reserve.find((item) => keyOf(item) === targetKey) ??
      readHistoryItem(source, galleryId);
    getDb()
      .insert(schema.dismissedGalleries)
      .values({
        source,
        galleryId,
        title: known?.title ?? null,
        artistsJson: JSON.stringify(known?.artists ?? []),
        tagsJson: JSON.stringify(known?.tags ?? []),
      })
      .onConflictDoUpdate({
        target: [
          schema.dismissedGalleries.source,
          schema.dismissedGalleries.galleryId,
        ],
        set: {
          title: known?.title ?? null,
          artistsJson: JSON.stringify(known?.artists ?? []),
          tagsJson: JSON.stringify(known?.tags ?? []),
        },
      })
      .run();
    profileRevision += 1;
    if (!cached) return displayedRecommendations();
    return reconcileAndRespond(cached);
  });
}

/** Reconcile the displayed set and answer from the same exclusion snapshot. */
async function reconcileAndRespond(
  cached: CachedRecommendationSet,
  restore?: RecommendationItem
): Promise<RecommendationResponse> {
  const eligibility = buildEligibilityContext([
    ...cached.items,
    ...cached.reserve,
    ...(restore ? [restore] : []),
  ]);
  return withOwned(
    await reconcileDisplayedSet(cached, restore, eligibility),
    eligibility
  );
}

/** Revalidate visible cards and promote spares using one policy for every feedback action. */
async function reconcileDisplayedSet(
  cached: CachedRecommendationSet,
  restore?: RecommendationItem,
  context?: EligibilityContext
): Promise<CachedRecommendationSet> {
  const eligible = await eligibleRecommendations(
    [...cached.items, ...cached.reserve, ...(restore ? [restore] : [])],
    context
  );
  const eligibleKeys = new Set(eligible.map(keyOf));
  let items = cached.items.filter((item) => eligibleKeys.has(keyOf(item)));
  if (restore && eligibleKeys.has(keyOf(restore))) {
    const remaining = items.filter((item) => keyOf(item) !== keyOf(restore));
    items = [
      restore,
      ...selectRecommendations(
        remaining.map((item) => ({
          result: item,
          score: 1,
          reasons: item.reasons,
          matched: new Set<string>(),
        })),
        TOTAL_PICKS - 1,
        () => 0,
        [restore]
      ),
    ];
  }
  const keys = new Set(items.map(keyOf));
  const reserve = [...cached.items, ...cached.reserve].filter(
    (item) => eligibleKeys.has(keyOf(item)) && !keys.has(keyOf(item))
  );
  const promoted = selectRecommendations(
    reserve.map((item) => ({
      result: item,
      score: 1,
      reasons: item.reasons,
      matched: new Set<string>(),
    })),
    Math.max(0, TOTAL_PICKS - items.length),
    () => 0,
    items
  );
  items.push(...promoted);
  const used = new Set(items.map(keyOf));
  const updated: CachedRecommendationSet = {
    ...cached,
    items,
    reserve: reserve.filter((item) => !used.has(keyOf(item))),
    profile: { ...termsFromPicks(items), language: cached.profile.language },
    degradedReason:
      items.length < TOTAL_PICKS
        ? "insufficient-eligible"
        : cached.degradedReason === "same-day-pool-exhausted"
          ? cached.degradedReason
          : null,
  };
  commitDisplayedSet(updated, promoted);
  return updated;
}

/** Commit the displayed snapshot and its serve history as one local transaction. */
function commitDisplayedSet(
  set: CachedRecommendationSet,
  served: RecommendationItem[] = []
): void {
  getDb().transaction(() => {
    if (served.length) addHistory(set.date, served);
    writeCached(set);
  });
}

/** Undo removes feedback, not true ownership; restore the original card when still eligible. */
export async function undoDismiss(
  source: DoujinSource,
  galleryId: string
): Promise<RecommendationResponse> {
  return recommendationMutations.run(["displayed-set"], async () => {
    getDb()
      .delete(schema.dismissedGalleries)
      .where(
        and(
          eq(schema.dismissedGalleries.source, source),
          eq(schema.dismissedGalleries.galleryId, galleryId)
        )
      )
      .run();
    profileRevision += 1;
    return restoreHistoryItem(source, galleryId);
  });
}

async function restoreHistoryItem(
  source: DoujinSource,
  galleryId: string
): Promise<RecommendationResponse> {
  const cached = readDisplayedSet();
  const original = readHistoryItem(source, galleryId);
  if (cached && original) return reconcileAndRespond(cached, original);
  return displayedRecommendations();
}

/** Use server-side history/provider metadata, not client-supplied taste signals. */
export async function applyRecommendationFeedback(
  action: FeedbackAction,
  target: {
    source: DoujinSource;
    galleryId: string;
    artist?: string;
    tag?: string;
  }
): Promise<{
  feedback: RecommendationFeedback;
  recommendations: RecommendationResponse;
}> {
  return recommendationMutations.run(["displayed-set"], async () => {
    let item: DoujinSearchResult | undefined;
    if (
      action === "like" ||
      action === "mute-artist" ||
      action === "mute-tag"
    ) {
      const targetKey = `${target.source}:${target.galleryId}`;
      const cached = readDisplayedSet();
      item =
        cached?.items.find((entry) => keyOf(entry) === targetKey) ??
        readHistoryItem(target.source, target.galleryId);
      if (!item) {
        const provider = getDoujinProvider(target.source);
        if (!provider?.getGallery)
          throw new Error("Gallery metadata is unavailable");
        item = await provider.getGallery(target.galleryId);
      }
    }
    const feedback = saveRecommendationFeedback(action, target, item);
    profileRevision++;
    candidatePool = null;
    const cached = readDisplayedSet();
    const recommendations = cached
      ? await reconcileAndRespond(cached)
      : await displayedRecommendations();
    return { feedback, recommendations };
  });
}

/** Library preferences apply to the next daily generation or explicit refresh. */
export function setExcludedLibraries(ids: number[]): void {
  setRecommendationSettings({ excludedLibraryIds: [...new Set(ids)] });
  clearRecommendationSignals();
  invalidateProfile();
}
