import { asc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinSearchResult, DoujinSource } from '../downloader/types.js';
import type { LogFn } from '../jobs/queue.js';
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
      });
    }
    return out.slice(0, LAST_RESULTS_MAX);
  } catch {
    return [];
  }
}

export function listWatchedSearches(): WatchedSearch[] {
  const db = getDb();
  const rows = db.select().from(schema.watchedSearches).orderBy(asc(schema.watchedSearches.id)).all();
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    query: r.query,
    lastCheckedAt: r.lastCheckedAt,
    lastResultCount: r.lastResultCount,
    seenCount: db.select().from(schema.watchedSearchSeen).where(eq(schema.watchedSearchSeen.searchId, r.id)).all().length,
    lastResults: decodeLastResults(r.lastResultsJson),
  }));
}

/** Add a watch; an identical source+query pair is returned as-is (idempotent). */
export function addWatchedSearch(source: DoujinSource, query: string): WatchedSearch {
  const db = getDb();
  const existing = db.select().from(schema.watchedSearches).where(eq(schema.watchedSearches.source, source)).all().find((r) => r.query === query);
  if (existing) {
    return listWatchedSearches().find((s) => s.id === existing.id) ?? {
      id: existing.id,
      source: existing.source,
      query: existing.query,
      lastCheckedAt: existing.lastCheckedAt,
      lastResultCount: existing.lastResultCount,
      seenCount: 0,
      lastResults: [],
    };
  }
  const res = db.insert(schema.watchedSearches).values({ source, query }).run();
  const id = Number(res.lastInsertRowid);
  return listWatchedSearches().find((s) => s.id === id)!;
}

/** Remove a watch and its seen history. Returns false when the id is unknown. */
export function removeWatchedSearch(id: number): boolean {
  const db = getDb();
  const row = db.select().from(schema.watchedSearches).where(eq(schema.watchedSearches.id, id)).get();
  if (!row) return false;
  db.delete(schema.watchedSearchSeen).where(eq(schema.watchedSearchSeen.searchId, id)).run();
  db.delete(schema.watchedSearches).where(eq(schema.watchedSearches.id, id)).run();
  return true;
}

/** Number of saved watches (used by the poll scheduler to decide whether to run). */
export function countWatchedSearches(): number {
  return getDb().select().from(schema.watchedSearches).all().length;
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
    if (isCancelled?.()) throw new Error('Job cancelled');
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
        .select()
        .from(schema.watchedSearchSeen)
        .where(eq(schema.watchedSearchSeen.searchId, s.id))
        .all()
        .map((r) => r.galleryId),
    );
    const newIds = diffSeenResults(firstRun, ids, seenIds);
    result.newGalleries += newIds.length;

    // Remember every current result so a gallery that leaves and re-enters the
    // top-N is not reported twice.
    for (const id of ids) {
      getDb()
        .insert(schema.watchedSearchSeen)
        .values({ searchId: s.id, source: s.source, galleryId: id })
        .onConflictDoNothing()
        .run();
    }

    if (!firstRun && newIds.length > 0) {
      const label = SOURCE_LABELS[s.source] ?? s.source;
      // Markdown links render as clean clickable titles in Discord; raw URLs cluttered the embed.
      const lines = newIds.slice(0, NOTIFY_MAX_LISTED).map((id) => {
        const r = results.find((x) => x.galleryId === id);
        const title = r?.title || id;
        return r?.url ? `**[${title}](${r.url})**` : `**${title}**`;
      });
      if (newIds.length > NOTIFY_MAX_LISTED) lines.push(`*+${newIds.length - NOTIFY_MAX_LISTED} more*`);
      const cover = results.find((x) => newIds.includes(x.galleryId))?.coverUrl;
      try {
        await notify({
          title: `New on ${label}`,
          description: `${newIds.length} new result(s) for \`${s.query}\`\n\n${lines.join('\n')}`,
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
      : newIds.slice(0, LAST_RESULTS_MAX).map((id) => {
          const r = results.find((x) => x.galleryId === id);
          return {
            galleryId: id,
            title: r?.title || id,
            ...(r?.url ? { url: r.url } : {}),
            ...(r?.coverUrl ? { coverUrl: r.coverUrl } : {}),
          };
        });
    const lastResultsJson = firstRun || lastResults.length > 0 ? JSON.stringify(lastResults) : null;

    pruneSeen(s.id);
    getDb()
      .update(schema.watchedSearches)
      .set({ lastCheckedAt: new Date().toISOString(), lastResultCount: ids.length, ...(lastResultsJson !== null ? { lastResultsJson } : {}) })
      .where(eq(schema.watchedSearches.id, s.id))
      .run();
    log(firstRun ? 'info' : 'success', `Watch ${s.id} "${s.query}": ${ids.length} result(s), ${newIds.length} new${firstRun ? ' (seeded)' : ''}`);
  }
  onProgress?.(searches.length, searches.length);
  return result;
}

/** Keep the seen table bounded: drop the oldest rows beyond the retention cap. */
function pruneSeen(searchId: number): void {
  const db = getDb();
  const count = db.select().from(schema.watchedSearchSeen).where(eq(schema.watchedSearchSeen.searchId, searchId)).all().length;
  if (count <= SEEN_RETENTION) return;
  const excess = count - SEEN_PRUNE_TO;
  const oldest = db
    .select()
    .from(schema.watchedSearchSeen)
    .where(eq(schema.watchedSearchSeen.searchId, searchId))
    .orderBy(asc(schema.watchedSearchSeen.id))
    .limit(excess)
    .all();
  const ids = oldest.map((r) => r.id);
  db.delete(schema.watchedSearchSeen).where(inArray(schema.watchedSearchSeen.id, ids)).run();
}
