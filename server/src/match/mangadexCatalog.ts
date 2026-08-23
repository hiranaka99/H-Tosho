import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema, type Db } from '../db/index.js';
import { canonicalTitle, scoreCanonical } from './normalize.js';
import type { CandidateMatch } from './autoMatcher.js';
import type { SearchResult } from '../providers/types.js';
import { KavitaAgeRating } from '../kavita/types.js';
import { JobCancelled } from '../jobs/queue.js';
import { retry, sleep } from '../lib/http.js';

/**
 * Local index of MangaDex adult-rated titles.
 *
 * MangaDex's title search only covers manga that have at least one chapter,
 * but most adult titles on the site are metadata-only (never scanlated) and
 * therefore unsearchable. To make mature series matchable, this module keeps
 * a cached copy of every reachable suggestive/erotica/pornographic title
 * (fetched via paginated GET /manga?contentRating[]=...) and scores series
 * names against it with the same titleScore machinery as live provider
 * searches. Titles without year metadata sort past the API's 10k pagination
 * window in every year-ordered query; they are indexed only while they sit
 * inside the most-recently-updated window.
 */

const BASE_URL = 'https://api.mangadex.org';
/** Cover image CDN (fileName resolved per title via GET /manga/{id}/cover). */
const COVERS_BASE_URL = 'https://uploads.mangadex.org';
const HEADERS: Record<string, string> = { 'Client-Agent': 'H-Tosho/1.0 (+https://github.com/h-tosho)' };

/** MangaDex contentRating values indexed for mature matching. */
export const ADULT_RATINGS = ['suggestive', 'erotica', 'pornographic'] as const;

const PAGE_SIZE = 50;
/** Catalog is refreshed when older than this (or empty). */
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Score floor for catalog candidates; below this the title is unrelated noise. */
const CATALOG_SCORE_FLOOR = 0.45;
/** Politeness delay between catalog pages (MangaDex occasionally 400s bursty clients). */
const PAGE_DELAY_MS = 120;
const MAX_CANDIDATES = 10;

const LAST_REFRESH_KEY = 'mangadex_catalog.last_refresh';

/** In-memory scoring form of one catalog row. */
export interface CatalogEntry {
  mangaId: string;
  titleEn?: string;
  originalTitle?: string;
  altTitles: string[];
  descriptionEn?: string;
  year?: number;
  /** Primary cover file name on uploads.mangadex.org (resolved lazily). */
  coverFile?: string;
}

export interface RefreshContext {
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void;
  onProgress?: (current: number, total: number) => void;
  isCancelled?: () => boolean;
}

/** True for Kavita age ratings that should be matched against the adult catalog. */
export function isMatureAgeRating(rating?: number | null): boolean {
  return typeof rating === 'number' && rating >= KavitaAgeRating.Mature15Plus;
}

/** Per-rating refresh state: where the incremental delta window starts and how far back the year audit goes. */
interface RatingState {
  /** updatedAt boundary of the last delta window; items updated since then are re-fetched on every refresh. */
  boundaryMs: number;
  /** Oldest year observed for this rating (lower bound of the per-year audit). */
  minYear: number;
}

/** Stored under LAST_REFRESH_KEY: last successful refresh time + which ratings were fully paginated. */
interface RefreshRecord {
  at: string;
  complete: Record<string, boolean>;
  perRating?: Partial<Record<(typeof ADULT_RATINGS)[number], RatingState>>;
}

function readRefreshRecord(): RefreshRecord {
  const kv = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, LAST_REFRESH_KEY)).get();
  if (!kv) return { at: '', complete: {} };
  try {
    const v: unknown = JSON.parse(kv.valueJson);
    if (typeof v === 'string') return { at: v, complete: {} }; // legacy format (ISO string only)
    if (v && typeof v === 'object' && typeof (v as RefreshRecord).at === 'string') {
      const r = v as RefreshRecord;
      const rec: RefreshRecord = { at: r.at, complete: r.complete ?? {}, perRating: r.perRating };
      // Legacy records without per-rating state migrate to a boundary at their timestamp.
      if (!rec.perRating && r.at && ADULT_RATINGS.every((x) => rec.complete[x])) {
        const boundaryMs = Date.parse(r.at);
        if (Number.isFinite(boundaryMs)) {
          rec.perRating = Object.fromEntries(ADULT_RATINGS.map((x) => [x, { boundaryMs, minYear: 0 }]));
        }
      }
      return rec;
    }
  } catch {
    /* corrupt record — treat as never refreshed */
  }
  return { at: '', complete: {} };
}

function writeRefreshRecord(rec: RefreshRecord): void {
  getDb()
    .insert(schema.keyValueStore)
    .values({ key: LAST_REFRESH_KEY, valueJson: JSON.stringify(rec) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(rec) } })
    .run();
}

/** Row count + last refresh timestamp of the local catalog. */
export function catalogStatus(): { count: number; lastRefreshedAt: string | null } {
  const db = getDb();
  const row = db.select({ count: sql<number>`count(*)` }).from(schema.mangadexCatalog).get();
  return { count: row?.count ?? 0, lastRefreshedAt: readRefreshRecord().at || null };
}

/** Whether the catalog is empty, stale, or missing any rating — i.e. warrants a refresh. */
export function catalogNeedsRefresh(): boolean {
  const { count, lastRefreshedAt } = catalogStatus();
  if (count === 0) return true;
  if (!lastRefreshedAt) return true;
  if (Date.now() - new Date(lastRefreshedAt).getTime() > REFRESH_INTERVAL_MS) return true;
  const { complete } = readRefreshRecord();
  return ADULT_RATINGS.some((r) => !complete[r]);
}

/** All titles of a catalog entry that should be compared against the series name. */
export function entryTitles(entry: CatalogEntry): string[] {
  const titles = [entry.titleEn, entry.originalTitle, ...entry.altTitles];
  return [...new Set(titles.filter((t): t is string => typeof t === 'string' && t.trim().length > 0))];
}

/**
 * Best title score for a catalog entry against a Kavita series name.
 * Pure function (no DB) so it can be unit-tested directly.
 */
export function bestCatalogScore(kavitaTitle: string, entry: CatalogEntry): { score: number; title: string } {
  const a = canonicalTitle(kavitaTitle);
  let best = { score: 0, title: '' };
  for (const t of entryTitles(entry)) {
    const s = scoreCanonical(a, canonicalTitle(t));
    if (s > best.score) best = { score: s, title: t };
  }
  return best;
}

/** Raw manga list item as returned by GET /manga (only the fields consumed here). */
interface MangaListItem {
  id: string;
  attributes?: {
    title?: Record<string, string | undefined>;
    altTitles?: Array<Record<string, string | undefined>>;
    description?: Record<string, string | undefined>;
    year?: number | string | null;
    status?: string | null;
    contentRating?: string | null;
    links?: { mal?: string; al?: string; mu?: string };
    updatedAt?: string;
  };
}

/** Flatten a MangaDex localized title object ({en, ja-ro, original, ...}) into its string values. */
function titleVariants(t: Record<string, string | undefined> | undefined): string[] {
  if (!t) return [];
  return Object.values(t).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/** MangaDex caps `from + size` at 10000 on /manga — deeper offsets are rejected. */
const MAX_OFFSET = 9950;

function catalogPageUrl(rating: string, extra: Record<string, string>, offset: number): string {
  const p = new URLSearchParams();
  p.append('contentRating[]', rating);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  p.set('limit', String(PAGE_SIZE));
  p.set('offset', String(offset));
  return `${BASE_URL}/manga?${p.toString()}`;
}

async function fetchCatalogPage(url: string, label: string): Promise<{ total?: number; items: MangaListItem[] }> {
  const data = await retry(
    async () => {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`MangaDex ${label}: HTTP ${res.status} ${body}`);
      }
      return (await res.json()) as { total?: number; data?: MangaListItem[] };
    },
    8,
    1000,
  );
  return { total: data.total, items: data.data ?? [] };
}

/**
 * Fetch one catalog page, re-fetching once when it looks truncated: MangaDex
 * occasionally returns partial pages under load, and believing the first short
 * page would silently end the sweep — everything past it is never fetched. A
 * short page at the true end of a list is legitimate (the server reports no
 * items remaining), so only re-check when more than what arrived should have
 * been served.
 */
async function fetchPageVerified(url: string, label: string, offset: number): Promise<{ total?: number; items: MangaListItem[] }> {
  let res = await fetchCatalogPage(url, label);
  if (res.total !== undefined && res.items.length < PAGE_SIZE && res.total - offset > res.items.length) {
    const recheck = await fetchCatalogPage(url, `${label} (recheck)`);
    if (recheck.items.length > res.items.length) res = recheck;
  }
  return res;
}

interface RefreshCounters {
  added: number;
  updated: number;
  fetched: number;
}

function reportProgress(ctx: RefreshContext, c: RefreshCounters, totals: Map<string, number>): void {
  ctx.onProgress?.(c.fetched, [...totals.values()].reduce((a, b) => a + b, 0));
}

function upsertItems(db: Db, rating: string, items: MangaListItem[], existing: Set<string>, c: RefreshCounters, now: string): void {
  db.transaction((t) => {
    for (const item of items) {
      const a = item.attributes ?? {};
      const row = {
        mangaId: item.id,
        titleEn: a.title?.en,
        originalTitle: a.title?.original,
        altTitlesJson: JSON.stringify((a.altTitles ?? []).map(titleVariants).flat()),
        descriptionEn: a.description?.en ?? a.description?.original,
        year: typeof a.year === 'string' ? Number(a.year) || undefined : a.year ?? undefined,
        status: a.status ?? null,
        contentRating: a.contentRating ?? rating,
        malId: a.links?.mal ?? null,
        alId: a.links?.al ?? null,
        muId: a.links?.mu ?? null,
        mdUpdatedAt: a.updatedAt ?? now,
        fetchedAt: now,
      };
      t.insert(schema.mangadexCatalog)
        .values(row)
        .onConflictDoUpdate({ target: schema.mangadexCatalog.mangaId, set: { ...row } })
        .run();
      if (existing.has(item.id)) c.updated++;
      else c.added++;
    }
  });
}

function countByYear(db: Db, rating: string, year: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.mangadexCatalog)
    .where(and(eq(schema.mangadexCatalog.contentRating, rating), eq(schema.mangadexCatalog.year, year)))
    .get();
  return row?.n ?? 0;
}

/** Oldest year present for a rating (page 0 of the year-ascending list). */
async function deriveMinYear(ctx: RefreshContext, rating: string, storedMinYear: number): Promise<number> {
  const label = `${rating} min-year`;
  const { items } = await fetchCatalogPage(catalogPageUrl(rating, { 'order[year]': 'asc' }, 0), label).catch((e) => {
    ctx.log('error', `Catalog refresh failed (${label}): ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  });
  let derived = Infinity;
  for (const it of items) {
    const y = Number(it.attributes?.year);
    if (Number.isFinite(y) && y > 0 && y < derived) derived = y;
  }
  return Number.isFinite(derived) ? derived : storedMinYear || 1900;
}

/**
 * Full completeness pass for a rating: fetches every year from `fromYear` to
 * the current year in full. Each year is a small, fully pageable window, so —
 * unlike one big offset sweep — no title with a year can be hidden behind the
 * API's 10k result-window cap. Returns the number of titles that have a year;
 * titles without one sort past the cap in every year-ordered query and are
 * only reachable via updatedAt windows.
 */
async function yearPass(
  ctx: RefreshContext,
  db: Db,
  rating: string,
  fromYear: number,
  existing: Set<string>,
  c: RefreshCounters,
  now: string,
  totals: Map<string, number>,
): Promise<{ withYearTotal: number; capped: boolean }> {
  let withYearTotal = 0;
  let capped = false;
  for (let y = fromYear; y <= new Date().getFullYear(); y++) {
    if (ctx.isCancelled?.()) throw new JobCancelled();
    const label = `${rating} year=${y}`;
    let offset = 0;
    for (;;) {
      const { total, items } = await fetchPageVerified(catalogPageUrl(rating, { year: String(y) }, offset), `${label} offset=${offset}`, offset).catch((e) => {
        ctx.log('error', `Catalog refresh failed (${label} offset=${offset}): ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      });
      if (total !== undefined && offset === 0) withYearTotal += total;
      upsertItems(db, rating, items, existing, c, now);
      c.fetched += items.length;
      reportProgress(ctx, c, totals);
      if (items.length < PAGE_SIZE) break; // end of this year's list (re-verified)
      offset += PAGE_SIZE;
      if (offset > MAX_OFFSET) {
        ctx.log('warn', `Year ${y} of ${rating} exceeds the 10k result window; the rating will be rebuilt on the next refresh.`);
        capped = true;
        break;
      }
      await sleep(PAGE_DELAY_MS);
    }
  }
  return { withYearTotal, capped };
}

/**
 * Verify per-year completeness of a previously built rating: each year's DB
 * count is compared against the total MangaDex reports for it, and years short
 * by more than a small tolerance (metadata drift, e.g. a title's year being
 * corrected) are re-fetched in full. Returns the number of titles that have a
 * year, for reporting.
 */
async function yearAudit(
  ctx: RefreshContext,
  db: Db,
  rating: string,
  fromYear: number,
  existing: Set<string>,
  c: RefreshCounters,
  now: string,
  totals: Map<string, number>,
): Promise<number> {
  let withYearTotal = 0;
  for (let y = fromYear; y <= new Date().getFullYear(); y++) {
    if (ctx.isCancelled?.()) throw new JobCancelled();
    const label = `${rating} year=${y}`;
    const { total } = await fetchCatalogPage(catalogPageUrl(rating, { year: String(y) }, 0), label).catch((e) => {
      ctx.log('error', `Catalog refresh failed (${label}): ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    if (!total) continue;
    withYearTotal += total;
    const have = countByYear(db, rating, y);
    const tolerance = Math.max(3, Math.round(total * 0.01));
    if (have + tolerance >= total) continue;
    ctx.log('info', `Catalog ${rating} year=${y} is short (${have}/${total}); re-fetching the year.`);
    let offset = 0;
    for (;;) {
      const { items } = await fetchPageVerified(catalogPageUrl(rating, { year: String(y) }, offset), `${label} offset=${offset}`, offset).catch((e) => {
        ctx.log('error', `Catalog refresh failed (${label} offset=${offset}): ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      });
      upsertItems(db, rating, items, existing, c, now);
      c.fetched += items.length;
      reportProgress(ctx, c, totals);
      if (items.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await sleep(PAGE_DELAY_MS);
    }
    await sleep(PAGE_DELAY_MS);
  }
  return withYearTotal;
}

/**
 * Walk the top of the updatedAt-descending list (up to the API's 10k window).
 * Titles without a year sort past the cap in every year-ordered query and are
 * otherwise unreachable; this picks up the ones touched recently.
 */
async function updatedAtWindow(
  ctx: RefreshContext,
  db: Db,
  rating: string,
  existing: Set<string>,
  c: RefreshCounters,
  now: string,
  totals: Map<string, number>,
): Promise<void> {
  let offset = 0;
  for (;;) {
    if (ctx.isCancelled?.()) throw new JobCancelled();
    const label = `${rating} recent offset=${offset}`;
    const { total, items } = await fetchPageVerified(catalogPageUrl(rating, { 'order[updatedAt]': 'desc' }, offset), label, offset).catch((e) => {
      ctx.log('error', `Catalog refresh failed (${label}): ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    if (total !== undefined) totals.set(rating, total);
    upsertItems(db, rating, items, existing, c, now);
    c.fetched += items.length;
    reportProgress(ctx, c, totals);
    if (items.length < PAGE_SIZE) return; // end of list (re-verified)
    offset += PAGE_SIZE;
    if (offset > MAX_OFFSET) return; // window exhausted; older titles stay unreachable
    await sleep(PAGE_DELAY_MS);
  }
}

/**
 * Incremental pass for a previously built rating: pages updatedAt-desc from the
 * top until items older than `boundaryMs` appear or the list ends. The boundary
 * only advances when the whole list was walked (end of list); otherwise it is
 * kept so anything missed by pagination churn gets another chance next refresh.
 * Returns capped=true when the window exceeds the API's 10k limit — the caller
 * should mark the rating incomplete so a full build runs on the next refresh.
 */
async function deltaWindow(
  ctx: RefreshContext,
  db: Db,
  rating: string,
  boundaryMs: number,
  existing: Set<string>,
  c: RefreshCounters,
  now: string,
  totals: Map<string, number>,
): Promise<{ newBoundaryMs: number; capped: boolean }> {
  const nowMs = Date.parse(now);
  let offset = 0;
  for (;;) {
    if (ctx.isCancelled?.()) throw new JobCancelled();
    const label = `${rating} delta offset=${offset}`;
    const { total, items } = await fetchPageVerified(catalogPageUrl(rating, { 'order[updatedAt]': 'desc' }, offset), label, offset).catch((e) => {
      ctx.log('error', `Catalog refresh failed (${label}): ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    if (total !== undefined) totals.set(rating, total);
    upsertItems(db, rating, items, existing, c, now);
    c.fetched += items.length;
    reportProgress(ctx, c, totals);
    if (items.length < PAGE_SIZE) return { newBoundaryMs: nowMs, capped: false }; // end of list (re-verified): everything walked
    const newest = items[0]?.attributes?.updatedAt;
    if (newest && Date.parse(newest) < boundaryMs) return { newBoundaryMs: boundaryMs, capped: false }; // stopped at boundary: re-cover next time
    offset += PAGE_SIZE;
    if (offset > MAX_OFFSET) {
      ctx.log('warn', `Delta for ${rating} exceeds the 10k result window; a full build will run on the next refresh.`);
      return { newBoundaryMs: boundaryMs, capped: true };
    }
    await sleep(PAGE_DELAY_MS);
  }
}

/**
 * Fetch (or incrementally update) the adult-title catalog from MangaDex.
 *
 * MangaDex rejects `offset + limit > 10000`, so a rating's full title list can
 * never be paged in one query. Completeness is therefore built per year: each
 * `year=N` window is small enough to page exhaustively, keeping every title
 * with a year reachable no matter how large the rating grows. Titles without a
 * year sort past the cap in every year-ordered query and are only partially
 * reachable — the most recently updated ones come in via updatedAt windows.
 * Per-year counts are re-audited on every refresh so skipped years self-heal.
 * Requests run sequentially with a small delay between pages.
 */
export async function refreshCatalog(ctx: RefreshContext): Promise<{ added: number; updated: number; total: number }> {
  const db = getDb();
  const rec = readRefreshRecord();
  const perRating: Partial<Record<(typeof ADULT_RATINGS)[number], RatingState>> = rec.perRating ?? {};
  const existing = new Set(
    db.select({ id: schema.mangadexCatalog.mangaId }).from(schema.mangadexCatalog).all().map((r) => r.id),
  );
  const now = new Date().toISOString();
  const c: RefreshCounters = { added: 0, updated: 0, fetched: 0 };
  const totals = new Map<string, number>();
  let fullBuildRan = false;

  for (const rating of ADULT_RATINGS) {
    if (ctx.isCancelled?.()) throw new JobCancelled();
    // Grand total up front so progress reporting has a denominator.
    const { total: grand, items: head } = await fetchPageVerified(catalogPageUrl(rating, {}, 0), `${rating} status`, 0).catch((e) => {
      ctx.log('error', `Catalog refresh failed (${rating} status): ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    if (grand !== undefined) totals.set(rating, grand);
    upsertItems(db, rating, head, existing, c, now);
    c.fetched += head.length;

    const state = perRating[rating];
    if (rec.complete[rating] && state) {
      const minYear = await deriveMinYear(ctx, rating, state.minYear);
      await yearAudit(ctx, db, rating, minYear, existing, c, now, totals);
      const d = await deltaWindow(ctx, db, rating, state.boundaryMs, existing, c, now, totals);
      if (d.capped) {
        rec.complete[rating] = false; // full build on the next refresh
        delete perRating[rating];
      } else {
        perRating[rating] = { boundaryMs: d.newBoundaryMs, minYear };
      }
    } else {
      fullBuildRan = true;
      const minYear = await deriveMinYear(ctx, rating, state?.minYear ?? 0);
      const { capped } = await yearPass(ctx, db, rating, minYear, existing, c, now, totals);
      if (capped) {
        rec.complete[rating] = false;
      } else {
        await updatedAtWindow(ctx, db, rating, existing, c, now, totals);
        rec.complete[rating] = true;
        perRating[rating] = { boundaryMs: Date.parse(now), minYear };
      }
    }
  }

  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  writeRefreshRecord({ at: now, complete: rec.complete, perRating });
  invalidateCatalogCache();
  const count = db.select({ n: sql<number>`count(*)` }).from(schema.mangadexCatalog).get()?.n ?? 0;
  ctx.log('success', `MangaDex adult catalog ${fullBuildRan ? 'built' : 'refreshed'}: ${count} titles indexed (of ${total} on MangaDex; +${c.added} new, ${c.updated} updated)`);
  return { added: c.added, updated: c.updated, total: count };
}

/** Process-local cache of parsed catalog rows (rebuilt after refresh). */
interface CachedEntry extends CatalogEntry {
  /** Precomputed canonical forms + token sets of every comparable title. */
  scoredTitles: Array<{ raw: string; canon: string; tokens: Set<string> }>;
}
let cache: CachedEntry[] | null = null;

export function invalidateCatalogCache(): void {
  cache = null;
}

function loadEntries(): CachedEntry[] {
  if (cache) return cache;
  const rows = getDb().select().from(schema.mangadexCatalog).all();
  cache = rows.map((r) => {
    const entry: CatalogEntry = {
      mangaId: r.mangaId,
      titleEn: r.titleEn ?? undefined,
      originalTitle: r.originalTitle ?? undefined,
      altTitles: safeParse(r.altTitlesJson),
      descriptionEn: r.descriptionEn ?? undefined,
      year: r.year ?? undefined,
      coverFile: r.coverFile ?? undefined,
    };
    return { ...entry, scoredTitles: entryTitles(entry).map((raw) => { const canon = canonicalTitle(raw); return { raw, canon, tokens: new Set(canon.split(' ')) }; }) };
  });
  return cache;
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** True when two token sets share at least one token (iterates the smaller set). */
function sharesAnyToken(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (large.has(w)) return true;
  return false;
}
/**
 * Score a Kavita series name against the local adult catalog.
 * Returns up to MAX_CANDIDATES candidates shaped like live search results so
 * they can be merged into the normal autoMatch candidate pool.
 */
export function searchCatalog(kavitaTitle: string): CandidateMatch[] {
  const a = canonicalTitle(kavitaTitle);
  const queryTokens = new Set(a.split(' '));
  const scored = loadEntries()
    .map((entry) => {
      let best = { score: 0, title: '' };
      for (const t of entry.scoredTitles) {
        // Pre-filter: with zero shared tokens the containment branch is
        // impossible and the score caps at 0.5 * Levenshtein similarity —
        // unreachable above CATALOG_SCORE_FLOOR unless the strings are nearly
        // identical, which short titles can be (one-edit romanization). So skip
        // the O(n*m) distance only for long×long pairs; everything else keeps
        // full scoring.
        const s = !sharesAnyToken(queryTokens, t.tokens) && a.length > 12 && t.canon.length > 12 ? 0 : scoreCanonical(a, t.canon);
        if (s > best.score) best = { score: s, title: t.raw };
      }
      return { entry, ...best };
    })
    .filter((s) => s.score >= CATALOG_SCORE_FLOOR)
    .sort((a2, b2) => b2.score - a2.score)
    .slice(0, MAX_CANDIDATES);

  return scored.map(({ entry, score, title }) => {
    const coverUrl = entry.coverFile ? `${COVERS_BASE_URL}/covers/${entry.mangaId}/${entry.coverFile}` : undefined;
    const fromProvider: SearchResult = {
      providerId: 'mangadex',
      providerSeriesId: entry.mangaId,
      title,
      type: 'MANGA',
      year: entry.year,
      summary: entry.descriptionEn,
      coverUrl,
    };
    return {
      providerId: 'mangadex',
      providerSeriesId: entry.mangaId,
      title,
      type: 'MANGA',
      year: entry.year,
      summary: entry.descriptionEn,
      coverUrl,
      score,
      fromProvider,
    };
  });
}

/**
 * Catalog candidates eligible for a series. Series flagged mature in Kavita
 * may match fuzzily (down to CATALOG_SCORE_FLOOR); unflagged series only on an
 * exact canonical title match, so generic or short names can't pull adult
 * metadata onto family-friendly series via token-subset scoring.
 */
export function catalogCandidates(kavitaTitle: string, mature: boolean): CandidateMatch[] {
  const all = searchCatalog(kavitaTitle);
  return mature ? all : all.filter((c) => c.score >= 1.0);
}

/**
 * Resolve the primary cover of a catalog title and persist the file name so
 * later lookups are free. Returns the CDN URL (routed through the media proxy
 * for the frontend) or null when the title has no usable cover. The list
 * endpoint only carries cover relationship stubs, so each title needs one
 * extra request — hence resolution is lazy, at identify time.
 */
export async function resolveCatalogCover(mangaId: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/cover?manga%5B%5D=${mangaId}&limit=100`, { headers: HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ attributes?: { fileName?: string; volume?: number | string | null; locale?: string; updatedAt?: string } }>;
    };
    // Series-level covers have no volume; among re-uploads the newest wins.
    let fileName: string | undefined;
    let bestAt = '';
    for (const item of data?.data ?? []) {
      const attrs = item.attributes;
      if (!attrs?.fileName || attrs.volume != null) continue;
      const at = attrs.updatedAt ?? '';
      if (at >= bestAt) {
        fileName = attrs.fileName;
        bestAt = at;
      }
    }
    // Some titles only have volume-level covers (no series-level upload); fall
    // back to the lowest-numbered volume so catalog candidates still get a
    // thumbnail. Locale preference en > ja, newest re-upload wins within it.
    if (!fileName) {
      let bestVol = Infinity;
      let bestRank = 3;
      let bestVolAt = '';
      for (const item of data?.data ?? []) {
        const attrs = item.attributes;
        if (!attrs?.fileName || attrs.volume == null) continue;
        const vol = Number(attrs.volume);
        if (!Number.isFinite(vol)) continue;
        const locale = (attrs.locale ?? '').toLowerCase();
        const rank = locale === 'en' ? 0 : locale === 'ja' ? 1 : 2;
        const at = attrs.updatedAt ?? '';
        if (vol < bestVol || (vol === bestVol && (rank < bestRank || (rank === bestRank && at >= bestVolAt)))) {
          bestVol = vol;
          bestRank = rank;
          bestVolAt = at;
          fileName = attrs.fileName;
        }
      }
    }
    if (!fileName) return null;
    getDb()
      .update(schema.mangadexCatalog)
      .set({ coverFile: fileName })
      .where(eq(schema.mangadexCatalog.mangaId, mangaId))
      .run();
    // Keep the in-memory cache current without a full reload.
    if (cache) {
      const hit = cache.find((e) => e.mangaId === mangaId);
      if (hit) hit.coverFile = fileName;
    }
    return `${COVERS_BASE_URL}/covers/${mangaId}/${fileName}`;
  } catch {
    return null;
  }
}
