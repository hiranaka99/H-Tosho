import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema, type Db } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinSearchResult, DoujinSource } from '../downloader/types.js';
import { JobCancelled, type LogFn } from '../jobs/queue.js';
import { notify } from '../notify/dispatcher.js';

/**
 * Watched searches: saved doujin queries (source + search-box syntax) that are
 * re-run periodically. Galleries already reported for a search are tracked in
 * `watched_search_seen`; only genuinely new results trigger a Discord ping.
 * The first check seeds the seen set silently so saving a watch never spams
 * the channel with the search's existing backlog.
 */

export interface WatchedSearch {
  id: number;
  source: string;
  query: string;
  lastCheckedAt: string | null;
  lastResultCount: number | null;
  seenCount: number;
  /** New galleries from the last check that found something; empty otherwise. */
  lastResults: WatchedSearchNewResult[];
}

/** One gallery in a watch's "new since last check" list. */
export interface WatchedSearchNewResult {
  galleryId: string;
  title: string;
  url?: string;
  coverUrl?: string;
  pageCount?: number;
}

/** Unknown or invalid provider counts stay absent rather than displaying zero pages. */
function pageCountMetadata(value: unknown): { pageCount?: number } {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? { pageCount: value } : {};
}

const SOURCE_LABELS: Record<string, string> = { hitomi: 'Hitomi.la', nhentai: 'nHentai' };
/** How many results each check considers (enough for any realistic watch). */
const SEARCH_LIMIT = 50;
/** Per-search cap on remembered gallery ids so the table cannot grow unbounded. */
const SEEN_RETENTION = 2000;
const SEEN_PRUNE_TO = 1500;
/** New results listed in the Discord ping (the rest are counted only). */
const NOTIFY_MAX_LISTED = 10;
/** Cap on the persisted "new since last check" list shown in the UI. */
const LAST_RESULTS_MAX = 50;
/** Cap on the persisted "recently added" feed so the table cannot grow unbounded. */
const NEW_RETENTION = 1000;
const NEW_PRUNE_TO = 750;

/** Decode the persisted new-results JSON; malformed payloads degrade to []. */
function decodeLastResults(json: string | null): WatchedSearchNewResult[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: WatchedSearchNewResult[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      if (typeof r.galleryId !== 'string' || typeof r.title !== 'string') continue;
      out.push({
        galleryId: r.galleryId,
        title: r.title,
        ...(typeof r.url === 'string' ? { url: r.url } : {}),
        ...(typeof r.coverUrl === 'string' ? { coverUrl: r.coverUrl } : {}),
        ...pageCountMetadata(r.pageCount),
      });
    }
    return out.slice(0, LAST_RESULTS_MAX);
  } catch {
    return [];
  }
}

/** Build the API shape for one watch row, counting its seen rows. */
function rowToWatch(row: typeof schema.watchedSearches.$inferSelect): WatchedSearch {
  const counted = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.watchedSearchSeen)
    .where(eq(schema.watchedSearchSeen.searchId, row.id))
    .get();
  return {
    id: row.id,
    source: row.source,
    query: row.query,
    lastCheckedAt: row.lastCheckedAt,
    lastResultCount: row.lastResultCount,
    seenCount: Number(counted?.n ?? 0),
    lastResults: decodeLastResults(row.lastResultsJson),
  };
}

export function listWatchedSearches(): WatchedSearch[] {
  const db = getDb();
  const rows = db.select().from(schema.watchedSearches).orderBy(asc(schema.watchedSearches.id)).all();
  // One grouped count for every watch instead of a per-watch full-row scan of
  // watched_search_seen just to call .all().length.
  const seenCounts = new Map(
    db
      .select({ searchId: schema.watchedSearchSeen.searchId, n: sql<number>`count(*)` })
      .from(schema.watchedSearchSeen)
      .groupBy(schema.watchedSearchSeen.searchId)
      .all()
      .map((r) => [r.searchId, Number(r.n)] as const),
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    query: r.query,
    lastCheckedAt: r.lastCheckedAt,
    lastResultCount: r.lastResultCount,
    seenCount: seenCounts.get(r.id) ?? 0,
    lastResults: decodeLastResults(r.lastResultsJson),
  }));
}

/** Add a watch; an identical source+query pair is returned as-is (idempotent). */
export function addWatchedSearch(source: DoujinSource, query: string): WatchedSearch {
  const db = getDb();
  // Point query on the unique (source, query) pair instead of pulling every
  // watch row and .find()-ing twice over.
  const existing = db
    .select()
    .from(schema.watchedSearches)
    .where(and(eq(schema.watchedSearches.source, source), eq(schema.watchedSearches.query, query)))
    .get();
  if (existing) return rowToWatch(existing);
  const res = db.insert(schema.watchedSearches).values({ source, query }).run();
  const row = db.select().from(schema.watchedSearches).where(eq(schema.watchedSearches.id, Number(res.lastInsertRowid))).get()!;
  return rowToWatch(row);
}

/** Remove a watch, its seen history, and its "recently added" entries. Returns false when the id is unknown. */
export function removeWatchedSearch(id: number): boolean {
  const db = getDb();
  const row = db.select().from(schema.watchedSearches).where(eq(schema.watchedSearches.id, id)).get();
  if (!row) return false;
  db.delete(schema.watchedSearchSeen).where(eq(schema.watchedSearchSeen.searchId, id)).run();
  db.delete(schema.watchedSearchNew).where(eq(schema.watchedSearchNew.searchId, id)).run();
  db.delete(schema.watchedSearches).where(eq(schema.watchedSearches.id, id)).run();
  return true;
}

/** Number of saved watches (used by the poll scheduler to decide whether to run). */
export function countWatchedSearches(): number {
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.watchedSearches)
    .get();
  return Number(row?.n ?? 0);
}

/**
 * Pure diff: which current results are new for a watch. First runs seed the
 * seen set without reporting (no backlog spam); later runs report exactly the
 * ids never seen before.
 */
export function diffSeenResults(firstRun: boolean, currentIds: string[], seenIds: Set<string>): string[] {
  if (firstRun) return [];
  return currentIds.filter((id) => !seenIds.has(id));
}

/**
 * Upload-age threshold for "new" results. Provider index hiccups (e.g. hitomi.la
 * serving a mid-rebuild search window) can push old galleries back into the top-N;
 * those are not real releases, so results uploaded longer ago are suppressed from
 * pings and feeds. Unknown dates fail open — a missing field never hides a find.
 */
const STALE_UPLOAD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** True when the result's upload date is older than the staleness threshold; unknown dates are not stale. */
export function isStaleUpload(uploadedAt: string | undefined, now: number = Date.now()): boolean {
  if (!uploadedAt) return false;
  const t = Date.parse(uploadedAt);
  return !Number.isNaN(t) && now - t > STALE_UPLOAD_MAX_AGE_MS;
}

interface CheckResult {
  checked: number;
  notified: number;
  newGalleries: number;
}

/** Re-run every watch once and Discord-ping about new results. */
export async function checkWatchedSearches(
  log: LogFn,
  isCancelled?: () => boolean,
  onProgress?: (current: number, total: number) => void,
): Promise<CheckResult> {
  const searches = listWatchedSearches();
  const result: CheckResult = { checked: 0, notified: 0, newGalleries: 0 };
  for (let i = 0; i < searches.length; i++) {
    if (isCancelled?.()) throw new JobCancelled();
    const s = searches[i];
    onProgress?.(i, searches.length);
    const provider = getDoujinProvider(s.source as DoujinSource);
    if (!provider) {
      log('warn', `Watch ${s.id} (${s.source}) has no such source; skipped`);
      continue;
    }
    let results: DoujinSearchResult[];
    try {
      results = await provider.search(s.query, SEARCH_LIMIT);
    } catch (e) {
      log('error', `Watch ${s.id} "${s.query}" failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    result.checked++;
    const ids = results.map((r) => r.galleryId);
    const firstRun = s.lastCheckedAt === null;
    const seenIds = new Set(
      getDb()
        // Only the gallery id is needed; pulling full seen rows (timestamps,
        // source) just to build a Set of ids is wasted I/O.
        .select({ galleryId: schema.watchedSearchSeen.galleryId })
        .from(schema.watchedSearchSeen)
        .where(eq(schema.watchedSearchSeen.searchId, s.id))
        .all()
        .map((r) => r.galleryId),
    );
    const newIds = diffSeenResults(firstRun, ids, seenIds);
    // Provider index hiccups (e.g. hitomi.la serving a mid-rebuild search window)
    // can push old galleries back into the top-N; those are not real releases.
    // Suppress them from pings and feeds — the seen insert below still remembers
    // them, so a settled index does not re-report them.
    const uploadedById: Record<string, string | undefined> = {};
    for (const r of results) uploadedById[r.galleryId] = r.uploadedAt;
    const staleIds = new Set(newIds.filter((id) => isStaleUpload(uploadedById[id])));
    const freshNewIds = newIds.filter((id) => !staleIds.has(id));
    if (staleIds.size > 0) {
      log('warn', `Watch ${s.id} "${s.query}": suppressed ${staleIds.size} old upload(s) re-entering the result window (provider index hiccup)`);
    }
    result.newGalleries += freshNewIds.length;
    if (!firstRun && freshNewIds.length > 0) {
      const label = SOURCE_LABELS[s.source] ?? s.source;
      // Markdown links render as clean clickable titles in Discord; raw URLs cluttered the embed.
      const lines = freshNewIds.slice(0, NOTIFY_MAX_LISTED).map((id) => {
        const r = results.find((x) => x.galleryId === id);
        const title = r?.title || id;
        return r?.url ? `**[${title}](${r.url})**` : `**${title}**`;
      });
      if (freshNewIds.length > NOTIFY_MAX_LISTED) lines.push(`*+${freshNewIds.length - NOTIFY_MAX_LISTED} more*`);
      const cover = results.find((x) => freshNewIds.includes(x.galleryId))?.coverUrl;
      try {
        await notify({
          title: `New on ${label}`,
          description: `${freshNewIds.length} new result(s) for \`${s.query}\`\n\n${lines.join('\n')}`,
          coverUrl: cover,
          success: true,
        });
        result.notified++;
      } catch (e) {
        log('error', `Discord notification for watch ${s.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // In-app "new since last check" list: a seeding run stores an empty list;
    // later runs replace it only when they actually found something new, so
    // the previous finds stay visible across quiet checks.
    const lastResults: WatchedSearchNewResult[] = firstRun
      ? []
      : freshNewIds.slice(0, LAST_RESULTS_MAX).map((id) => {
          const r = results.find((x) => x.galleryId === id);
          return {
            galleryId: id,
            title: r?.title || id,
            ...(r?.url ? { url: r.url } : {}),
            ...(r?.coverUrl ? { coverUrl: r.coverUrl } : {}),
            ...pageCountMetadata(r?.pageCount),
          };
        });
    const lastResultsJson = firstRun || lastResults.length > 0 ? JSON.stringify(lastResults) : null;
    // One transaction per watch: the seen inserts, the retention prune, and the
    // last-checked bookkeeping land together or not at all. The seen rows go in
    // as one multi-row insert; the unique index idx_watched_search_seen_unique
    // on (search_id, source, gallery_id) keeps the dedupe instead of a per-row
    // ON CONFLICT loop (up to 50 statements per watch per check before).
    getDb().transaction((tx) => {
      // Remember every current result so a gallery that leaves and re-enters the
      // top-N is not reported twice.
      if (ids.length > 0) {
        tx.insert(schema.watchedSearchSeen)
          .values(ids.map((id) => ({ searchId: s.id, source: s.source, galleryId: id })))
          .onConflictDoNothing()
          .run();
      }
      pruneSeen(s.id, tx);
      // Persist everything reported as new for the "Recently added" feed; the
      // unique index idx_watched_search_new_unique keeps re-discoveries from
      // duplicating rows.
      if (!firstRun && freshNewIds.length > 0) {
        const foundAt = new Date().toISOString();
        tx.insert(schema.watchedSearchNew)
          .values(freshNewIds.map((id) => {
            const r = results.find((x) => x.galleryId === id);
            return {
              searchId: s.id,
              source: s.source,
              query: s.query,
              galleryId: id,
              title: r?.title || id,
              ...(r?.url ? { url: r.url } : {}),
              ...(r?.coverUrl ? { coverUrl: r.coverUrl } : {}),
              ...pageCountMetadata(r?.pageCount),
              foundAt,
            };
          }))
          .onConflictDoNothing()
          .run();
        pruneNew(tx);
      }
      tx.update(schema.watchedSearches)
        .set({ lastCheckedAt: new Date().toISOString(), lastResultCount: ids.length, ...(lastResultsJson !== null ? { lastResultsJson } : {}) })
        .where(eq(schema.watchedSearches.id, s.id))
        .run();
    });
    log(firstRun ? 'info' : 'success', `Watch ${s.id} "${s.query}": ${ids.length} result(s), ${freshNewIds.length} new${firstRun ? ' (seeded)' : ''}`);
  }
  onProgress?.(searches.length, searches.length);
  return result;
}

/** Keep the seen table bounded: drop the oldest rows beyond the retention cap. */
function pruneSeen(searchId: number, db: Db): void {
  // COUNT instead of loading every seen row just to call .all().length.
  const counted = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.watchedSearchSeen)
    .where(eq(schema.watchedSearchSeen.searchId, searchId))
    .get();
  const count = Number(counted?.n ?? 0);
  if (count <= SEEN_RETENTION) return;
  const excess = count - SEEN_PRUNE_TO;
  const oldest = db
    .select({ id: schema.watchedSearchSeen.id })
    .from(schema.watchedSearchSeen)
    .where(eq(schema.watchedSearchSeen.searchId, searchId))
    .orderBy(asc(schema.watchedSearchSeen.id))
    .limit(excess)
    .all();
  const ids = oldest.map((r) => r.id);
  db.delete(schema.watchedSearchSeen).where(inArray(schema.watchedSearchSeen.id, ids)).run();
}

/** Keep the "recently added" feed bounded: drop the oldest rows beyond the retention cap. */
function pruneNew(db: Db): void {
  const counted = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.watchedSearchNew)
    .get();
  const count = Number(counted?.n ?? 0);
  if (count <= NEW_RETENTION) return;
  const excess = count - NEW_PRUNE_TO;
  const oldest = db
    .select({ id: schema.watchedSearchNew.id })
    .from(schema.watchedSearchNew)
    .orderBy(asc(schema.watchedSearchNew.id))
    .limit(excess)
    .all();
  const ids = oldest.map((r) => r.id);
  db.delete(schema.watchedSearchNew).where(inArray(schema.watchedSearchNew.id, ids)).run();
}

/** One gallery in the "recently added" feed. */
export interface WatchedSearchNewGallery {
  source: string;
  galleryId: string;
  title: string;
  url?: string;
  coverUrl?: string;
  pageCount?: number;
  /** The watch query that found the gallery. */
  query: string;
  /** ISO 8601 timestamp of the check that first reported it. */
  foundAt: string;
}

/**
 * Newest-first feed of galleries any watch reported as new. A gallery found by
 * several watches appears once (its newest discovery wins).
 */
export function listNewGalleries(limit = 100): WatchedSearchNewGallery[] {
  const db = getDb();
  // Fetch a wider window than needed so cross-watch dedupe still fills the page.
  const rows = db
    .select()
    .from(schema.watchedSearchNew)
    .orderBy(desc(schema.watchedSearchNew.foundAt), desc(schema.watchedSearchNew.id))
    .limit(limit * 3)
    .all();
  const seen = new Set<string>();
  const out: WatchedSearchNewGallery[] = [];
  for (const r of rows) {
    const key = `${r.source}:${r.galleryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: r.source,
      galleryId: r.galleryId,
      title: r.title,
      ...(r.url ? { url: r.url } : {}),
      ...(r.coverUrl ? { coverUrl: r.coverUrl } : {}),
      ...pageCountMetadata(r.pageCount),
      query: r.query,
      foundAt: r.foundAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One-shot migration for databases upgraded from a build without the "recently
 * added" feed: watches whose lastResultsJson was written by an older build never
 * had their finds persisted to watched_search_new. Replay those entries with
 * foundAt = the check that reported them (lastCheckedAt). Idempotent — the
 * unique index makes replays of already-persisted finds no-ops, so this is safe
 * to run on every startup; it returns how many rows were actually inserted.
 */
export function backfillNewGalleries(): number {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.watchedSearches)
    .where(sql`${schema.watchedSearches.lastResultsJson} IS NOT NULL`)
    .all();
  let inserted = 0;
  for (const row of rows) {
    const items = decodeLastResults(row.lastResultsJson);
    if (items.length === 0) continue;
    const foundAt = row.lastCheckedAt ?? new Date().toISOString();
    const res = db
      .insert(schema.watchedSearchNew)
      .values(items.map((r) => ({
        searchId: row.id,
        source: row.source,
        query: row.query,
        galleryId: r.galleryId,
        title: r.title,
        ...(r.url ? { url: r.url } : {}),
        ...(r.coverUrl ? { coverUrl: r.coverUrl } : {}),
        ...pageCountMetadata(r.pageCount),
        foundAt,
      })))
      .onConflictDoNothing()
      .run();
    inserted += Number(res.changes ?? 0);
  }
  return inserted;
}
