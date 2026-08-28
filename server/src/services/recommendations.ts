import { and, desc, eq, like, ne } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery, DoujinSearchResult, DoujinSource, DoujinSort } from '../downloader/types.js';
import { sleep } from '../lib/http.js';
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
 * builds a handful of artist/tag/series queries per source from the top
 * profile terms (the popularity horizon is a seeded per-roll choice, so the
 * candidate pool itself rotates), scores candidates by how strongly they
 * match the profile, drops galleries already in the library or served
 * recently, and picks a daily set.
 *
 * Daily rotation: selection is seeded with the local date, so a day always
 * yields the same picks (cached in `key_value_store` under
 * `recommendations-v2:<date>`). "Refresh" busts the cache and re-rolls with a
 * fresh nonce. Every served pick enters a rolling cross-day history
 * (`recommendations-history`): manual refreshes never re-serve it, and
 * neither does the next day's first set — that history is what stops the
 * same galleries from resurfacing day after day. Picks become eligible again
 * after HISTORY_DAYS, or sooner when the fresh candidate pool is exhausted
 * (oldest history recycles first). When the profile is too thin to be
 * meaningful (cold start), it falls back to each source's popularity list.
 */

const SOURCES: DoujinSource[] = ['hitomi', 'nhentai'];

/** Top-N profile terms turned into one search query each, per source. */
const ARTIST_QUERIES = 2; // artist terms per source — artists rotate, tags/series carry the set
const TAG_QUERIES = 4; // top tag terms per source
const SERIES_QUERIES = 3; // top Kavita series titles per source (parody/series search)
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
/**
 * Results fetched per candidate query. Hitomi hydration is one request per
 * gallery, so its cap stays tight; nhentai answers from a single API page,
 * so a wider pool there costs nothing.
 */
const HITOMI_RESULTS_PER_QUERY = 12;
const NHENTAI_RESULTS_PER_QUERY = 24;
/**
 * Popularity horizons a roll draws one sort from, per source. All-time lists
 * barely move day to day; pairing them with a weekly horizon keeps the
 * candidate pool itself rotating, not just the terms querying it.
 */
const SEARCH_SORTS: Record<DoujinSource, DoujinSort[]> = {
  hitomi: ['popular-year', 'popular-week'],
  nhentai: ['popular', 'popular-week'],
};
/** Picks per source and total size of the daily set. */
const PICKS_PER_SOURCE = 6;
const TOTAL_PICKS = 12;
/** Max picks per set a single tag/series term may dominate. */
const MAX_PICKS_PER_TERM = 2;
/** Artists get a stricter cap — one favorite artist should surface at most once per set. */
const MAX_PICKS_PER_ARTIST = 1;
/** Fewer profile terms than this → cold-start popularity fallback. */
const MIN_PROFILE_TERMS = 3;
/** Backfill cap per generation, and the tagged-gallery count below which it runs. */
const BACKFILL_LIMIT = 25;
const BACKFILL_THRESHOLD = 10;
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
  /** 'library' = picked from the taste profile; 'popular' = cold-start fallback. */
  mode: 'library' | 'popular';
  profile: RecommendationProfile;
  items: RecommendationItem[];
}

// ---------------------------------------------------------------------------
// gallery_tags persistence
// ---------------------------------------------------------------------------

/**
 * Persist a resolved gallery's tag/artist data for the recommendation profile.
 * Called by the download engine right after `getGallery` succeeds, so every
 * downloaded gallery contributes to the profile without re-fetching later.
 * Failures are logged and swallowed — tag capture must never break a download.
 */
export function recordGalleryTags(source: DoujinSource, gallery: DoujinGallery): void {
  const tags: GalleryTagEntry[] = (gallery.tags ?? [])
    .map((name, i) => ({ name: String(name ?? '').trim(), ns: gallery.tagNamespaces?.[i] ?? null }))
    .filter((t) => t.name);
  const artists = (gallery.artists ?? []).map((a) => String(a ?? '').trim()).filter(Boolean);
  try {
    getDb()
      .insert(schema.galleryTags)
      .values({
        source,
        galleryId: gallery.galleryId,
        title: gallery.title,
        tagsJson: JSON.stringify(tags),
        artistsJson: JSON.stringify(artists),
        language: gallery.language ?? null,
        fetchedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [schema.galleryTags.source, schema.galleryTags.galleryId],
        set: {
          title: gallery.title,
          tagsJson: JSON.stringify(tags),
          artistsJson: JSON.stringify(artists),
          language: gallery.language ?? null,
          fetchedAt: new Date().toISOString(),
        },
      })
      .run();
  } catch (err) {
    console.warn('[h-tosho] failed to record gallery tags:', err);
  }
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

  // Existing-library signals: each series' title becomes a 'series' term
  // (weight = pages Kavita has indexed — a heavily-read series matters more),
  // and its metadata tags/artists join the profile as plain keyword terms.
  for (const sig of signals) {
    const name = sig.name.trim();
    if (!name) continue;
    bumpTerm(terms, 'series', name, null, null, sig.weight);
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
  /** Engagement weight — pages Kavita has indexed for the series (≥1). */
  weight: number;
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
async function buildKavitaSignals(): Promise<KavitaSeriesSignal[]> {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return [];
  const client = new KavitaClient(conn.baseUrl, conn.apiKey);
  let libraries;
  try {
    libraries = await client.getLibraries();
  } catch (err) {
    console.warn('[recommendations] Kavita library scan skipped:', err instanceof Error ? err.message : err);
    return [];
  }

  // Libraries the user excluded from recommendations (e.g. a regular manga
  // collection that should not feed doujinshi searches).
  const excludedLibraries = new Set(getRecommendationSettings().excludedLibraryIds);
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
            weight: s.pages ?? 1,
            tags: [...(meta.genres ?? []), ...(meta.tags ?? [])].map((t) => t.title?.trim() ?? '').filter(Boolean),
            artists: (meta.writers ?? []).map((p) => p.name?.trim() ?? '').filter(Boolean),
          };
        } catch {
          return { name: s.name, weight: 1, tags: [] as string[], artists: [] as string[] };
        }
      }),
    );
    signals.push(...batch);
  }
  return signals;
}

/**
 * Fill in tag data for completed downloads that predate the gallery_tags table
 * (or whose capture failed). Capped per run so the first recommendation pass
 * stays bounded; remaining galleries fill in on later generations.
 */
async function backfillMissingTags(): Promise<void> {
  const db = getDb();
  const taggedCount = db.select({ source: schema.galleryTags.source }).from(schema.galleryTags).all().length;
  if (taggedCount >= BACKFILL_THRESHOLD) return;

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

  for (const source of SOURCES) {
    const provider = getDoujinProvider(source);
    if (!provider) continue;
    const rows = missing.filter((r) => r.source === source);
    // Bounded parallelism; nHentai gets a pause between batches to stay inside
    // its rate limits (especially without an API key).
    for (let i = 0; i < rows.length; i += 8) {
      await Promise.all(
        rows.slice(i, i + 8).map(async (row) => {
          try {
            const gallery = await provider.getGallery(row.galleryId);
            recordGalleryTags(source, gallery);
          } catch {
            /* skip unreachable galleries — they stay untagged until a later pass */
          }
        }),
      );
      if (source === 'nhentai' && i + 8 < rows.length) await sleep(500);
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate queries
// ---------------------------------------------------------------------------

interface QuerySpec {
  source: DoujinSource;
  query: string;
  /** Result cap for this query (hitomi hydrates one request per result; nhentai is a single API page). */
  results: number;
  terms: ProfileTerm[];
  sort: DoujinSort;
}

/** Source-specific search fragment for a profile term (null = not searchable there). */
function fragmentFor(source: DoujinSource, term: ProfileTerm): string | null {
  const name = term.name.trim();
  if (!name) return null;
  if (term.kind === 'artist') {
    // Hitomi namespaces use underscores for spaces; nHentai quotes the value.
    return source === 'hitomi' ? `artist:${name.replace(/\s+/g, '_')}` : `artist:"${name}"`;
  }
  if (term.kind === 'series') {
    // Fan works of a series are indexed under its name on both sources.
    return source === 'hitomi' ? `series:${name.replace(/\s+/g, '_')}` : `parody:"${name}"`;
  }
  const ns = term.nsBySource[source] ?? null;
  if (ns === 'language') return null; // language is handled as its own filter
  if (source === 'hitomi') {
    const val = name.replace(/\s+/g, '_');
    return ns ? `${ns}:${val}` : name;
  }
  return ns ? `${ns}:"${name}"` : `"${name}"`;
}

function languageFragment(source: DoujinSource, language: string): string {
  return source === 'hitomi' ? `language:${language.toLowerCase()}` : `language:"${language}"`;
}

/**
 * The terms queried this roll. Tags/series keep their #1 heaviest term as a
 * taste anchor on only half the rolls (a seeded coin — anchoring every roll
 * re-queries the top term every time and the set converges on it); artists
 * are always fully seeded-sampled from their pool. One query per term, per
 * source (AND-combining would shrink pools too hard).
 */
function buildQuerySpecs(profile: TasteProfile, rng: () => number): QuerySpec[] {
  const artists = sampleTerms(profile.terms.filter((t) => t.kind === 'artist'), ARTIST_QUERIES, ARTIST_QUERY_POOL, rng, false);
  const tags = sampleTerms(
    profile.terms.filter((t) => t.kind === 'tag' && (t.nsBySource.hitomi ?? null) !== 'language' && (t.nsBySource.nhentai ?? null) !== 'language'),
    TAG_QUERIES,
    TAG_QUERY_POOL,
    rng,
    rng() < 0.5,
  );
  const series = sampleTerms(profile.terms.filter((t) => t.kind === 'series'), SERIES_QUERIES, SERIES_QUERY_POOL, rng, rng() < 0.5);
  const specs: QuerySpec[] = [];
  for (const source of SOURCES) {
    const lang = profile.language ? languageFragment(source, profile.language) : null;
    for (const term of [...artists, ...tags, ...series]) {
      const frag = fragmentFor(source, term);
      if (!frag) continue;
      specs.push({
        source,
        query: [frag, lang].filter(Boolean).join(' '),
        results: source === 'hitomi' ? HITOMI_RESULTS_PER_QUERY : NHENTAI_RESULTS_PER_QUERY,
        terms: [term],
        sort: SEARCH_SORTS[source][Math.floor(rng() * SEARCH_SORTS[source].length)],
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

/**
 * Match weight used for scoring: log-damped library frequency. Raw weight is
 * skewed by design — a series term weighs as many pages as Kavita indexed for
 * it (hundreds) while a tag counts galleries (single digits) — so raw sums
 * would let one series hit outweigh a five-tag profile match.
 */
function termScore(t: ProfileTerm): number {
  return 1 + Math.log2(1 + t.weight);
}

/** Search every spec and merge candidates by gallery (a gallery hit by several queries sums their weights). */
async function gatherCandidates(specs: QuerySpec[], downloaded: Set<string>, termIndex: Map<string, ProfileTerm>): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  await Promise.all(
    specs.map(async (spec) => {
      const provider = getDoujinProvider(spec.source);
      if (!provider) return;
      let results: DoujinSearchResult[];
      try {
        results = await provider.search(spec.query, spec.results, spec.sort);
      } catch (err) {
        console.warn(`[h-tosho] recommendations query failed (${spec.source} “${spec.query}”):`, err instanceof Error ? err.message : err);
        return;
      }
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
        }
      }
    }),
  );
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
function pickDaily(candidates: Candidate[], count: number, rng: () => number, termIndex: Map<string, ProfileTerm>, termPicks: Map<string, number>): RecommendationItem[] {
  const pool = [...candidates];
  const out: RecommendationItem[] = [];
  while (out.length < count && pool.length > 0) {
    // Candidates whose dominant term already hit its cap for this set are not drawable.
    const eligible = pool.filter((c) => !capReached(c, termIndex, termPicks));
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
    const dominant = dominantTerm(chosen, termIndex);
    if (dominant) termPicks.set(dominant, (termPicks.get(dominant) ?? 0) + 1);
    out.push({ ...chosen.result, reasons: chosen.reasons });
    pool.splice(pool.indexOf(chosen), 1);
  }
  return out;
}

/** The candidate's heaviest match — that term "consumes" the pick. */
function dominantTerm(c: Candidate, termIndex: Map<string, ProfileTerm>): string | null {
  let dominant: string | null = null;
  let bestWeight = -1;
  for (const key of c.matched) {
    const w = termIndex.get(key)?.weight ?? 0;
    if (w > bestWeight) {
      bestWeight = w;
      dominant = key;
    }
  }
  return dominant;
}

function capReached(c: Candidate, termIndex: Map<string, ProfileTerm>, termPicks: Map<string, number>): boolean {
  const dominant = dominantTerm(c, termIndex);
  if (!dominant) return false;
  const cap = dominant.startsWith('artist:') ? MAX_PICKS_PER_ARTIST : MAX_PICKS_PER_TERM;
  return (termPicks.get(dominant) ?? 0) >= cap;
}

/** Per-source budget of PICKS_PER_SOURCE, topped up from the leftovers when a source is thin. */
function pickWithBudget(candidates: Map<string, Candidate>, rng: () => number, termIndex: Map<string, ProfileTerm>, termPicks: Map<string, number>): RecommendationItem[] {
  const picked: RecommendationItem[] = [];
  const pickedKeys = new Set<string>();
  for (const source of SOURCES) {
    const pool = [...candidates.values()].filter((c) => c.result.source === source);
    for (const item of pickDaily(pool, PICKS_PER_SOURCE, rng, termIndex, termPicks)) {
      pickedKeys.add(keyOf(item));
      picked.push(item);
    }
  }
  if (picked.length < TOTAL_PICKS) {
    const rest = [...candidates.values()].filter((c) => !pickedKeys.has(keyOf(c.result)));
    picked.push(...pickDaily(rest, TOTAL_PICKS - picked.length, rng, termIndex, termPicks));
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Cold-start popularity fallback
// ---------------------------------------------------------------------------

const POPULAR_FALLBACK: Record<DoujinSource, { query: string; sort: DoujinSort }> = {
  hitomi: { query: 'doujinshi', sort: 'popular-year' },
  nhentai: { query: 'type:doujinshi', sort: 'popular' },
};

async function gatherPopular(downloaded: Set<string>, rng: () => number): Promise<RecommendationItem[]> {
  const out: RecommendationItem[] = [];
  await Promise.all(
    SOURCES.map(async (source) => {
      const provider = getDoujinProvider(source);
      if (!provider) return;
      const spec = POPULAR_FALLBACK[source];
      try {
        const results = await provider.search(spec.query, PICKS_PER_SOURCE * 2, spec.sort);
        const pool = results.filter((r) => !downloaded.has(keyOf(r)));
        // Seeded shuffle — popularity order is already quality-ranked; the seed
        // only decides which slice of it the user sees today.
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        out.push(...pool.slice(0, PICKS_PER_SOURCE).map((r) => ({ ...r, reasons: [] as string[] })));
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
/** Served picks stay excluded for this many days before they are eligible again. */
const HISTORY_DAYS = 30;
/** Hard cap on retained history entries (bounds the row and the recycling pool). */
const MAX_HISTORY = 1200;

/** One previously-served pick, kept until it ages out of the history window. */
interface HistoryEntry {
  key: string;
  /** Local date the pick was last served — drives expiry. */
  date: string;
  item: RecommendationItem;
}

function readHistory(): HistoryEntry[] {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, HISTORY_KEY)).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.valueJson);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}


/** Drop expired entries and enforce the cap (oldest last, so the tail is the newest). */
function pruneHistory(): HistoryEntry[] {
  const cutoff = localDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000));
  const history = readHistory().filter((h) => h.date >= cutoff).slice(-MAX_HISTORY);
  const valueJson = JSON.stringify(history);
  getDb().insert(schema.keyValueStore)
    .values({ key: HISTORY_KEY, valueJson })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } })
    .run();
  return history;
}

/**
 * Record today's picks as served (re-serving a recycled pick refreshes its
 * date, restarting its exclusion window). Also migrates the legacy per-day
 * seen row, so a deploy does not re-serve picks shown earlier today.
 */
function addHistory(date: string, items: RecommendationItem[]): void {
  const entries = new Map<string, HistoryEntry>();
  for (const h of readHistory()) entries.set(h.key, h);
  const legacy = readSeenItems(date);
  for (const it of legacy) entries.set(keyOf(it), { key: keyOf(it), date, item: it });
  if (legacy.length) {
    getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, seenKey(date))).run();
  }
  for (const it of items) entries.set(keyOf(it), { key: keyOf(it), date, item: it });
  const trimmed = [...entries.values()].slice(-MAX_HISTORY);
  const valueJson = JSON.stringify(trimmed);
  getDb().insert(schema.keyValueStore)
    .values({ key: HISTORY_KEY, valueJson })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } })
    .run();
}

const seenKey = (date: string) => `recommendations-seen:${date}`;
/**
 * Legacy per-day seen rows (`recommendations-seen:<date>`), read only for the
 * one-time migration into the rolling history.
 */
function readSeenItems(date: string): RecommendationItem[] {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, seenKey(date))).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.valueJson);
    return Array.isArray(parsed) ? (parsed as RecommendationItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Terms that actually matched today's picks, by match count — drives the
 * "Based on:" chips so they vary with every re-roll. Reasons are generated in
 * the fixed `${kind} ${name}` format, so splitting on the first space is safe.
 */
function termsFromPicks(items: RecommendationItem[]): { artists: string[]; tags: string[]; series: string[] } {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const reason of it.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const byKind: Record<'artist' | 'tag' | 'series', [string, number][]> = { artist: [], tag: [], series: [] };
  for (const [reason, n] of counts) {
    const i = reason.indexOf(' ');
    if (i <= 0) continue;
    const kind = reason.slice(0, i);
    if (kind === 'artist' || kind === 'tag' || kind === 'series') byKind[kind].push([reason.slice(i + 1), n]);
  }
  const top = (list: [string, number][]) => list.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  return { artists: top(byKind.artist), tags: top(byKind.tag), series: top(byKind.series) };
}
async function doGenerate(date: string, nonce: number): Promise<RecommendationSet> {
  const rng = mulberry32(hashSeed(`${date}:${nonce}`));
  await backfillMissingTags();
  const kavitaSignals = await buildKavitaSignals();
  const profile = buildProfile(kavitaSignals);
  // Galleries already in the library, marked as owned, or served recently —
  // a fresh set must not re-serve any of them, even across days. That rolling
  // exclusion is what keeps today's first set from repeating yesterday's.
  const history = pruneHistory();
  const excluded = new Set([...completedGalleryKeys(), ...ownedGalleryKeys(), ...history.map((h) => h.key)]);

  let items: RecommendationItem[] = [];
  let mode: 'library' | 'popular' = 'popular';
  if (profile.terms.length >= MIN_PROFILE_TERMS) {
    mode = 'library';
    const termIndex = new Map(profile.terms.map((t) => [`${t.kind}:${t.name.toLowerCase()}`, t]));
    // Shared across both pick passes so the per-term cap applies to the whole set.
    const termPicks = new Map<string, number>();
    const candidates = await gatherCandidates(buildQuerySpecs(profile, rng), excluded, termIndex);
    items = pickWithBudget(candidates, rng, termIndex, termPicks);
  }

  // Cold start (or a day when the profile queries came up empty, or the per-term
  // caps left the panel short): fill with each source's popularity list.
  if (items.length < TOTAL_PICKS) {
    const existing = new Set(items.map(keyOf));
    const extra = (await gatherPopular(excluded, rng)).filter((r) => !existing.has(keyOf(r)));
    items = [...items, ...extra].slice(0, TOTAL_PICKS);
  }

  // The fresh candidate pool is exhausted (tiny pool, many refreshes): top up
  // with the oldest previously-served picks rather than leaving the panel short.
  if (items.length < TOTAL_PICKS) {
    const existing = new Set(items.map(keyOf));
    for (const h of history) {
      if (existing.has(h.key)) continue;
      items.push(h.item);
      existing.add(h.key);
      if (items.length >= TOTAL_PICKS) break;
    }
  }

  addHistory(date, items);

  return {
    date,
    generatedAt: new Date().toISOString(),
    mode,
    // Chips describe this set, not the whole library — they change with every re-roll.
    profile: { ...termsFromPicks(items), language: profile.language },
    items,
  };
}

const cacheKey = (date: string) => `recommendations-v2:${date}`;

function readCached(date: string): RecommendationSet | null {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, cacheKey(date))).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.valueJson) as RecommendationSet;
    // An empty set means generation found nothing (e.g. both sources were
    // down) — don't pin that to the rest of the day, regenerate instead.
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    // Rows written by an older server build lack profile.series — a shape
    // mismatch means the payload is stale for the current client, so
    // regenerate instead of serving it.
    const p = parsed.profile;
    if (!p || !Array.isArray(p.artists) || !Array.isArray(p.tags) || !Array.isArray(p.series)) return null;
    return parsed;
  } catch {
    /* malformed row — regenerate */
  }
  return null;
}

function writeCached(set: RecommendationSet): void {
  const db = getDb();
  const valueJson = JSON.stringify(set);
  db.insert(schema.keyValueStore)
    .values({ key: cacheKey(set.date), valueJson })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } })
    .run();
  // Keep only today's cached set (the rolling history row prunes itself), and
  // drop legacy per-day seen rows superseded by the history.
  db.delete(schema.keyValueStore)
    .where(and(like(schema.keyValueStore.key, 'recommendations:%'), ne(schema.keyValueStore.key, cacheKey(set.date))))
    .run();
  db.delete(schema.keyValueStore)
    .where(like(schema.keyValueStore.key, 'recommendations-seen:%'))
    .run();
}

/** Serialize concurrent generation for the same date (page reloads, SSE-free polling). */
let inflight: { date: string; promise: Promise<RecommendationSet> } | null = null;

function generateFor(date: string, nonce: number): Promise<RecommendationSet> {
  if (inflight && inflight.date === date) return inflight.promise;
  const promise = doGenerate(date, nonce)
    .then((set) => {
      writeCached(set);
      return set;
    })
    .finally(() => {
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
  return { ...set, items: set.items.filter((it) => !owned.has(keyOf(it))), ownedKeys: [...owned] };
}

export function getRecommendations(): Promise<RecommendationResponse> {
  const date = localDate();
  const cached = readCached(date);
  return (cached ? Promise.resolve(cached) : generateFor(date, 0)).then(withOwned);
}

/** Re-roll today's picks with a fresh seed (manual refresh). */
export async function refreshRecommendations(): Promise<RecommendationResponse> {
  const date = localDate();
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, cacheKey(date))).run();
  return withOwned(await generateFor(date, Math.floor(Math.random() * 0x7fffffff)));
}

/** Replace the list of Kavita libraries feeding the profile; today's cached set is re-generated. */
export function setExcludedLibraries(ids: number[]): void {
  setRecommendationSettings({ excludedLibraryIds: [...new Set(ids)] });
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, cacheKey(localDate()))).run();
}
