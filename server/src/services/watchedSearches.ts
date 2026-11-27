import { and, asc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "../db/index.js";
import { getDoujinProvider } from "../downloader/providers.js";
import type { DoujinSearchResult } from "../downloader/types.js";
import type { DoujinSource } from "../contracts/doujin.js";
import { JobCancelled, type LogFn } from "../jobs/queue.js";
import { notify, NotificationFailure } from "../notify/dispatcher.js";
import {
  getNotificationSettings,
  getWatchedSearchIntervalMinutes,
} from "./settings.js";
import type { NotificationSettings } from "../contracts/notifications.js";
import {
  findBetterEditions,
  type BetterEditionOf,
} from "./galleryDuplicates.js";
import {
  effectiveFollowingInterval,
  FOLLOWING_INTERVAL_MINUTES,
  FOLLOWING_SEARCH_LIMIT,
  FOLLOWING_TARGET_LIMIT,
  type CheckWatchedSearchesCommand,
  type FollowingFeedOptions,
  type FollowingInterval,
  type WatchedGalleryFeed,
  type WatchedNewGallery,
  type WatchedSearch,
  type WatchedSearchFolder,
  type WatchedSearchFolderPatch,
  type WatchedSearchPatch,
  type WatchedSearchResultItem,
  NOTIFICATION_MODES,
  type NotificationMode,
} from "../contracts/following.js";

/**
 * Watched searches: saved doujin queries (source + search-box syntax) that are
 * re-run periodically. Galleries already reported for a search are tracked in
 * `watched_search_seen`; only genuinely new results trigger a Discord ping.
 * The first check seeds the seen set silently so saving a watch never spams
 * the channel with the search's existing backlog.
 */

/** Unknown or invalid provider counts stay absent rather than displaying zero pages. */
function pageCountMetadata(value: unknown): { pageCount?: number } {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { pageCount: value }
    : {};
}

/** Per-search cap on remembered gallery ids so the table cannot grow unbounded. */
const SEEN_RETENTION = 2000;
const SEEN_PRUNE_TO = 1500;
/** Cap on the persisted "new since last check" list shown in the UI. */
const LAST_RESULTS_MAX = 50;

/** Decode the persisted new-results JSON; malformed payloads degrade to []. */
function decodeLastResults(json: string | null): WatchedSearchResultItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: WatchedSearchResultItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.galleryId !== "string" || typeof r.title !== "string")
        continue;
      out.push({
        galleryId: r.galleryId,
        title: r.title,
        ...(typeof r.url === "string" ? { url: r.url } : {}),
        ...(typeof r.coverUrl === "string" ? { coverUrl: r.coverUrl } : {}),
        ...pageCountMetadata(r.pageCount),
      });
    }
    return out.slice(0, LAST_RESULTS_MAX);
  } catch {
    return [];
  }
}

type WatchRow = typeof schema.watchedSearches.$inferSelect;
const ownedWatches = new Set<number>();
const SCHEDULE_BATCH_SIZE = 20;
const SCHEDULE_SWEEP_MS = 15_000;
const scheduleListeners = new Set<() => void>();

function notifyWatchedScheduleChanged(): void {
  for (const listener of scheduleListeners) {
    try {
      listener();
    } catch {
      /* listener errors must not break watch mutations */
    }
  }
}

export function onWatchedScheduleChange(listener: () => void): () => void {
  scheduleListeners.add(listener);
  return () => {
    scheduleListeners.delete(listener);
  };
}

export class FollowingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message);
  }
}

function rowToWatch(
  row: WatchRow,
  seenCount: number,
  globalMinutes: number
): WatchedSearch {
  const effectiveIntervalMinutes = effectiveFollowingInterval(
    globalMinutes,
    row.pausedAt,
    row.intervalMinutes as FollowingInterval | null
  );
  return {
    id: row.id,
    source: row.source as DoujinSource,
    query: row.query,
    displayName: row.displayName,
    folderId: row.folderId,
    pausedAt: row.pausedAt,
    intervalMinutes: row.intervalMinutes as FollowingInterval | null,
    effectiveIntervalMinutes,
    notificationMode: row.notificationMode as NotificationMode,
    nextCheckAt: effectiveIntervalMinutes > 0 ? row.nextCheckAt : null,
    revision: row.revision,
    coverageLimit: FOLLOWING_SEARCH_LIMIT,
    lastCheckedAt: row.lastCheckedAt,
    lastResultCount: row.lastResultCount,
    lastNewCount: row.lastNewCount,
    lastFindsAt: row.lastFindsAt,
    lastAttemptedAt: row.lastAttemptedAt,
    lastFailedAt: row.lastFailedAt,
    lastError: row.lastError,
    seenCount,
    lastResults: decodeLastResults(row.lastResultsJson),
  };
}

export function getWatchedSearch(id: number): WatchedSearch | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(schema.watchedSearches)
    .where(eq(schema.watchedSearches.id, id))
    .get();
  if (!row) return undefined;
  const count = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.watchedSearchSeen)
    .where(eq(schema.watchedSearchSeen.searchId, id))
    .get();
  return rowToWatch(
    row,
    Number(count?.n ?? 0),
    getWatchedSearchIntervalMinutes()
  );
}

/** True when every id names an existing watch (one query, for bulk request validation). */
export function watchedSearchesExist(ids: number[]): boolean {
  const unique = [...new Set(ids)];
  if (!unique.length) return true;
  const table = schema.watchedSearches;
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .where(inArray(table.id, unique))
    .get();
  return Number(row?.n ?? 0) === unique.length;
}

export function listWatchedSearches(): WatchedSearch[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.watchedSearches)
    .orderBy(asc(schema.watchedSearches.id))
    .all();
  const seenCounts = new Map(
    db
      .select({
        searchId: schema.watchedSearchSeen.searchId,
        n: sql<number>`count(*)`,
      })
      .from(schema.watchedSearchSeen)
      .groupBy(schema.watchedSearchSeen.searchId)
      .all()
      .map((row) => [row.searchId, Number(row.n)] as const)
  );
  const globalMinutes = getWatchedSearchIntervalMinutes();
  return rows.map((row) =>
    rowToWatch(row, seenCounts.get(row.id) ?? 0, globalMinutes)
  );
}

/** Add a watch idempotently, with its first automatic attempt persisted. */
export function addWatchedSearch(
  source: DoujinSource,
  query: string
): WatchedSearch {
  query = query.trim();
  if (!query) throw new FollowingError("query is required", 400);
  const db = getDb();
  const minutes = getWatchedSearchIntervalMinutes();
  db.insert(schema.watchedSearches)
    .values({
      source,
      query,
      nextCheckAt:
        minutes > 0
          ? new Date(Date.now() + minutes * 60_000).toISOString()
          : null,
    })
    .onConflictDoNothing()
    .run();
  const row = db
    .select()
    .from(schema.watchedSearches)
    .where(
      and(
        eq(schema.watchedSearches.source, source),
        eq(schema.watchedSearches.query, query)
      )
    )
    .get()!;
  notifyWatchedScheduleChanged();
  return getWatchedSearch(row.id)!;
}

export function updateWatchedSearch(
  id: number,
  patch: WatchedSearchPatch
): WatchedSearch {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some(
      (key) =>
        ![
          "expectedRevision",
          "displayName",
          "folderId",
          "paused",
          "intervalMinutes",
          "notificationMode",
        ].includes(key)
    ) ||
    !Number.isSafeInteger(patch.expectedRevision) ||
    patch.expectedRevision < 0
  )
    throw new FollowingError(
      "Provide a valid watch patch and expectedRevision.",
      400
    );
  if (
    patch.displayName !== undefined &&
    patch.displayName !== null &&
    (typeof patch.displayName !== "string" ||
      patch.displayName.trim().length > 120)
  )
    throw new FollowingError(
      "Watch names must be at most 120 characters.",
      400
    );
  if (
    patch.folderId !== undefined &&
    patch.folderId !== null &&
    (!Number.isSafeInteger(patch.folderId) || patch.folderId < 1)
  )
    throw new FollowingError("Invalid folder id.", 400);
  if (patch.paused !== undefined && typeof patch.paused !== "boolean")
    throw new FollowingError("paused must be a boolean.", 400);
  if (
    patch.intervalMinutes !== undefined &&
    patch.intervalMinutes !== null &&
    !FOLLOWING_INTERVAL_MINUTES.includes(patch.intervalMinutes)
  )
    throw new FollowingError("Invalid watch interval.", 400);
  if (
    patch.notificationMode !== undefined &&
    !NOTIFICATION_MODES.includes(patch.notificationMode)
  )
    throw new FollowingError("Invalid notification mode.", 400);
  const db = getDb();
  let changedSchedule = false;
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(schema.watchedSearches)
      .where(eq(schema.watchedSearches.id, id))
      .get();
    if (!row) throw new FollowingError("Watched search not found.", 404);
    if (row.revision !== patch.expectedRevision)
      throw new FollowingError("Watch changed. Refresh and try again.", 409);
    if (
      patch.folderId != null &&
      !tx
        .select({ id: schema.watchedSearchFolders.id })
        .from(schema.watchedSearchFolders)
        .where(eq(schema.watchedSearchFolders.id, patch.folderId))
        .get()
    )
      throw new FollowingError("Folder not found.", 404);
    const pausedAt =
      patch.paused === undefined
        ? row.pausedAt
        : patch.paused
          ? (row.pausedAt ?? new Date().toISOString())
          : null;
    const intervalMinutes =
      patch.intervalMinutes === undefined
        ? row.intervalMinutes
        : patch.intervalMinutes;
    const reschedule =
      pausedAt !== row.pausedAt || intervalMinutes !== row.intervalMinutes;
    changedSchedule = reschedule;
    const minutes = effectiveFollowingInterval(
      getWatchedSearchIntervalMinutes(),
      pausedAt,
      intervalMinutes as FollowingInterval | null
    );
    tx.update(schema.watchedSearches)
      .set({
        revision: row.revision + 1,
        pausedAt,
        intervalMinutes,
        ...(patch.notificationMode !== undefined
          ? { notificationMode: patch.notificationMode }
          : {}),
        ...(patch.displayName !== undefined
          ? { displayName: patch.displayName?.trim() || null }
          : {}),
        ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        ...(reschedule
          ? {
              nextCheckAt:
                minutes > 0
                  ? new Date(Date.now() + minutes * 60_000).toISOString()
                  : null,
            }
          : {}),
      })
      .where(
        and(
          eq(schema.watchedSearches.id, id),
          eq(schema.watchedSearches.revision, patch.expectedRevision)
        )
      )
      .run();
  });
  if (changedSchedule) notifyWatchedScheduleChanged();
  return getWatchedSearch(id)!;
}

/** Remove monitoring and seen IDs while retaining readable discovery/review history. */
export function removeWatchedSearch(
  id: number,
  expectedRevision: number
): boolean {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new FollowingError("Provide expectedRevision.", 400);
  const removed = getDb().transaction((tx) => {
    const row = tx
      .select()
      .from(schema.watchedSearches)
      .where(eq(schema.watchedSearches.id, id))
      .get();
    if (!row) return false;
    if (row.revision !== expectedRevision)
      throw new FollowingError("Watch changed. Refresh and try again.", 409);
    tx.update(schema.watchedSearchNew)
      .set({ watchLabel: row.displayName ?? row.query })
      .where(eq(schema.watchedSearchNew.searchId, id))
      .run();
    tx.delete(schema.watchedSearchSeen)
      .where(eq(schema.watchedSearchSeen.searchId, id))
      .run();
    tx.delete(schema.watchedSearches)
      .where(eq(schema.watchedSearches.id, id))
      .run();
    return true;
  });
  if (removed) notifyWatchedScheduleChanged();
  return removed;
}

export function listWatchedSearchFolders(): WatchedSearchFolder[] {
  return getDb()
    .select()
    .from(schema.watchedSearchFolders)
    .orderBy(
      asc(schema.watchedSearchFolders.position),
      asc(schema.watchedSearchFolders.id)
    )
    .all();
}

export function addWatchedSearchFolder(name: string): WatchedSearchFolder {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
    throw new FollowingError("Folder names require 1–120 characters.", 400);
  return getDb().transaction((tx) => {
    const max = tx
      .select({
        position: sql<number>`coalesce(max(${schema.watchedSearchFolders.position}), -1)`,
      })
      .from(schema.watchedSearchFolders)
      .get();
    return tx
      .insert(schema.watchedSearchFolders)
      .values({ name: name.trim(), position: Number(max?.position ?? -1) + 1 })
      .returning()
      .get();
  });
}

export function patchWatchedSearchFolder(
  id: number,
  patch: WatchedSearchFolderPatch
): WatchedSearchFolder {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some(
      (key) => !["expectedRevision", "name", "position"].includes(key)
    ) ||
    !Number.isSafeInteger(patch.expectedRevision) ||
    patch.expectedRevision < 0
  )
    throw new FollowingError(
      "Provide a valid folder patch and expectedRevision.",
      400
    );
  if (
    patch.name !== undefined &&
    (typeof patch.name !== "string" ||
      !patch.name.trim() ||
      patch.name.trim().length > 120)
  )
    throw new FollowingError("Folder names require 1–120 characters.", 400);
  if (
    patch.position !== undefined &&
    (!Number.isSafeInteger(patch.position) || patch.position < 0)
  )
    throw new FollowingError("Invalid folder position.", 400);
  return getDb().transaction((tx) => {
    const folders = tx
      .select()
      .from(schema.watchedSearchFolders)
      .orderBy(
        asc(schema.watchedSearchFolders.position),
        asc(schema.watchedSearchFolders.id)
      )
      .all();
    const currentIndex = folders.findIndex((folder) => folder.id === id);
    if (currentIndex < 0) throw new FollowingError("Folder not found.", 404);
    const row = folders[currentIndex];
    if (row.revision !== patch.expectedRevision)
      throw new FollowingError("Folder changed. Refresh and try again.", 409);
    if (patch.position !== undefined && patch.position >= folders.length)
      throw new FollowingError("Invalid folder position.", 400);
    if (patch.position !== undefined) {
      folders.splice(currentIndex, 1);
      folders.splice(patch.position, 0, row);
    }
    const updatedAt = new Date().toISOString();
    for (let position = 0; position < folders.length; position++) {
      const folder = folders[position];
      if (folder.id !== id && folder.position === position) continue;
      tx.update(schema.watchedSearchFolders)
        .set({
          position,
          revision: folder.revision + 1,
          updatedAt,
          ...(folder.id === id && patch.name !== undefined
            ? { name: patch.name.trim() }
            : {}),
        })
        .where(
          and(
            eq(schema.watchedSearchFolders.id, folder.id),
            eq(schema.watchedSearchFolders.revision, folder.revision)
          )
        )
        .run();
    }
    return tx
      .select()
      .from(schema.watchedSearchFolders)
      .where(eq(schema.watchedSearchFolders.id, id))
      .get()!;
  });
}

export function removeWatchedSearchFolder(
  id: number,
  expectedRevision: number
): boolean {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new FollowingError("Provide expectedRevision.", 400);
  return getDb().transaction((tx) => {
    const row = tx
      .select()
      .from(schema.watchedSearchFolders)
      .where(eq(schema.watchedSearchFolders.id, id))
      .get();
    if (!row) return false;
    if (row.revision !== expectedRevision)
      throw new FollowingError("Folder changed. Refresh and try again.", 409);
    tx.update(schema.watchedSearches)
      .set({
        folderId: null,
        revision: sql`${schema.watchedSearches.revision} + 1`,
      })
      .where(eq(schema.watchedSearches.folderId, id))
      .run();
    tx.delete(schema.watchedSearchFolders)
      .where(eq(schema.watchedSearchFolders.id, id))
      .run();
    return true;
  });
}

/** Preserve future work on restart; spread overdue work across bounded sweeps. */
export function initializeWatchedSchedule(now = Date.now()): void {
  const minutes = getWatchedSearchIntervalMinutes();
  getDb().transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.watchedSearches)
      .orderBy(
        asc(schema.watchedSearches.nextCheckAt),
        asc(schema.watchedSearches.id)
      )
      .all();
    let overdue = 0;
    for (const row of rows) {
      const effective = effectiveFollowingInterval(
        minutes,
        row.pausedAt,
        row.intervalMinutes as FollowingInterval | null
      );
      if (effective === 0) {
        if (row.nextCheckAt !== null)
          tx.update(schema.watchedSearches)
            .set({ nextCheckAt: null })
            .where(eq(schema.watchedSearches.id, row.id))
            .run();
      } else if (
        row.nextCheckAt === null ||
        !Number.isFinite(Date.parse(row.nextCheckAt)) ||
        Date.parse(row.nextCheckAt) <= now
      ) {
        const nextCheckAt = new Date(
          now + Math.floor(overdue++ / SCHEDULE_BATCH_SIZE) * SCHEDULE_SWEEP_MS
        ).toISOString();
        tx.update(schema.watchedSearches)
          .set({ nextCheckAt })
          .where(eq(schema.watchedSearches.id, row.id))
          .run();
      }
    }
  });
  notifyWatchedScheduleChanged();
}

export function rescheduleWatchedSearches(now = Date.now()): void {
  const minutes = getWatchedSearchIntervalMinutes();
  getDb().transaction((tx) => {
    for (const row of tx.select().from(schema.watchedSearches).all()) {
      const effective = effectiveFollowingInterval(
        minutes,
        row.pausedAt,
        row.intervalMinutes as FollowingInterval | null
      );
      tx.update(schema.watchedSearches)
        .set({
          nextCheckAt:
            effective > 0
              ? new Date(now + effective * 60_000).toISOString()
              : null,
        })
        .where(eq(schema.watchedSearches.id, row.id))
        .run();
    }
  });
  notifyWatchedScheduleChanged();
}

export function dueWatchedSearchIds(
  now = Date.now(),
  limit = SCHEDULE_BATCH_SIZE
): number[] {
  if (
    getWatchedSearchIntervalMinutes() === 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    return [];
  const table = schema.watchedSearches;
  return getDb()
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        sql`${table.pausedAt} IS NULL`,
        lte(table.nextCheckAt, new Date(now).toISOString()),
        ownedWatches.size ? notInArray(table.id, [...ownedWatches]) : undefined
      )
    )
    .orderBy(asc(table.nextCheckAt), asc(table.id))
    .limit(Math.min(limit, FOLLOWING_TARGET_LIMIT))
    .all()
    .map((row) => row.id);
}

/** Epoch ms of the earliest due/upcoming watch check, or null when automatic checks are inactive. */
export function nextWatchedSearchDueAt(now = Date.now()): number | null {
  if (getWatchedSearchIntervalMinutes() === 0) return null;
  const table = schema.watchedSearches;
  const row = getDb()
    .select({ nextCheckAt: table.nextCheckAt })
    .from(table)
    .where(
      and(
        sql`${table.pausedAt} IS NULL`,
        sql`${table.nextCheckAt} IS NOT NULL`,
        ownedWatches.size ? notInArray(table.id, [...ownedWatches]) : undefined
      )
    )
    .orderBy(asc(table.nextCheckAt))
    .limit(1)
    .get();
  if (!row?.nextCheckAt) return null;
  const ms = Date.parse(row.nextCheckAt);
  return Number.isFinite(ms) ? Math.max(now, ms) : now;
}

/**
 * Pure diff: which current results are new for a watch. First runs seed the
 * seen set without reporting (no backlog spam); later runs report exactly the
 * ids never seen before.
 */
export function diffSeenResults(
  firstRun: boolean,
  currentIds: string[],
  seenIds: Set<string>
): string[] {
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
export function isStaleUpload(
  uploadedAt: string | undefined,
  now: number = Date.now()
): boolean {
  if (!uploadedAt) return false;
  const t = Date.parse(uploadedAt);
  return !Number.isNaN(t) && now - t > STALE_UPLOAD_MAX_AGE_MS;
}

interface CheckResult {
  checked: number;
  notified: number;
  newGalleries: number;
  failed: number;
  notificationFailed: number;
  notificationUnknown: number;
  betterEditions: number;
}

/** Manual checks include explicit paused targets; scheduled work must still be due. */
export async function checkWatchedSearches(
  log: LogFn,
  isCancelled?: () => boolean,
  onProgress?: (current: number, total: number) => void,
  command: CheckWatchedSearchesCommand = {}
): Promise<CheckResult> {
  const db = getDb();
  const mode = command.mode ?? "manual";
  const explicit = command.watchIds !== undefined;
  const table = schema.watchedSearches;
  const targets = explicit
    ? [...new Set(command.watchIds)]
    : mode === "due"
      ? dueWatchedSearchIds()
      : db
          .select({ id: table.id })
          .from(table)
          .where(sql`${table.pausedAt} IS NULL`)
          .orderBy(asc(table.id))
          .all()
          .map((row) => row.id);
  const result: CheckResult = {
    checked: 0,
    notified: 0,
    newGalleries: 0,
    failed: 0,
    notificationFailed: 0,
    notificationUnknown: 0,
    betterEditions: 0,
  };
  /** Every fresh find, for one better-edition check against the library after all lanes finish. */
  const freshFinds = new Map<string, DoujinSearchResult>();
  const notifications = new Map<
    string,
    {
      gallery: DoujinSearchResult;
      source: string;
      settings: NotificationSettings;
      watches: { id: number; revision: number }[];
    }
  >();
  /** Per-target finds to notify, merged in target order once every lane finishes. */
  const foundByTarget = new Map<
    number,
    {
      key: string;
      gallery: DoujinSearchResult;
      source: string;
      watch: { id: number; revision: number };
    }[]
  >();
  let started = 0;
  const checkTarget = async (id: number): Promise<void> => {
    if (isCancelled?.()) throw new JobCancelled();
    onProgress?.(started++, targets.length);
    if (isCancelled?.()) throw new JobCancelled();
    if (ownedWatches.has(id)) {
      log("warn", `Watch ${id} is already being checked; skipped`);
      return;
    }
    const watch = db.select().from(table).where(eq(table.id, id)).get();
    if (!watch || (!explicit && watch.pausedAt !== null)) return;
    if (
      mode === "due" &&
      (effectiveFollowingInterval(
        getWatchedSearchIntervalMinutes(),
        watch.pausedAt,
        watch.intervalMinutes as FollowingInterval | null
      ) === 0 ||
        watch.nextCheckAt === null ||
        Date.parse(watch.nextCheckAt) > Date.now() ||
        !Number.isFinite(Date.parse(watch.nextCheckAt)))
    )
      return;
    ownedWatches.add(id);
    try {
      let results: DoujinSearchResult[];
      try {
        const provider = getDoujinProvider(watch.source);
        if (!provider) throw new Error(`Unknown source: ${watch.source}`);
        results = (
          await provider.search(watch.query, FOLLOWING_SEARCH_LIMIT)
        ).slice(0, FOLLOWING_SEARCH_LIMIT);
      } catch (error) {
        if (isCancelled?.()) throw new JobCancelled();
        const latest = db.select().from(table).where(eq(table.id, id)).get();
        if (
          !latest ||
          latest.revision !== watch.revision ||
          (mode === "due" &&
            (getWatchedSearchIntervalMinutes() === 0 ||
              latest.pausedAt !== null ||
              latest.nextCheckAt === null ||
              Date.parse(latest.nextCheckAt) > Date.now()))
        )
          return;
        const now = Date.now(),
          attemptedAt = new Date(now).toISOString();
        const minutes = effectiveFollowingInterval(
          getWatchedSearchIntervalMinutes(),
          latest.pausedAt,
          latest.intervalMinutes as FollowingInterval | null
        );
        const message = error instanceof Error ? error.message : String(error);
        db.update(table)
          .set({
            lastError: message,
            lastAttemptedAt: attemptedAt,
            lastFailedAt: attemptedAt,
            nextCheckAt:
              minutes > 0
                ? new Date(now + minutes * 60_000).toISOString()
                : null,
          })
          .where(and(eq(table.id, id), eq(table.revision, watch.revision)))
          .run();
        result.failed++;
        log("error", `Watch ${id} "${watch.query}" failed: ${message}`);
        return;
      }
      if (isCancelled?.()) throw new JobCancelled();
      const latest = db.select().from(table).where(eq(table.id, id)).get();
      if (
        !latest ||
        latest.revision !== watch.revision ||
        (mode === "due" &&
          (getWatchedSearchIntervalMinutes() === 0 ||
            latest.pausedAt !== null ||
            latest.nextCheckAt === null ||
            Date.parse(latest.nextCheckAt) > Date.now()))
      )
        return;
      const now = Date.now(),
        checkedAt = new Date(now).toISOString();
      const byId = new Map(
        results.map((gallery) => [gallery.galleryId, gallery])
      );
      const ids = [...byId.keys()];
      const firstRun = latest.lastCheckedAt === null;
      const seenIds = ids.length
        ? new Set(
            db
              .select({ galleryId: schema.watchedSearchSeen.galleryId })
              .from(schema.watchedSearchSeen)
              .where(
                and(
                  eq(schema.watchedSearchSeen.searchId, id),
                  inArray(schema.watchedSearchSeen.galleryId, ids)
                )
              )
              .all()
              .map((row) => row.galleryId)
          )
        : new Set<string>();
      const newIds = diffSeenResults(firstRun, ids, seenIds);
      const freshIds = newIds.filter(
        (galleryId) => !isStaleUpload(byId.get(galleryId)?.uploadedAt, now)
      );
      const lastResults: WatchedSearchResultItem[] = freshIds
        .slice(0, LAST_RESULTS_MAX)
        .map((galleryId) => {
          const gallery = byId.get(galleryId)!;
          return {
            galleryId,
            title: gallery.title || galleryId,
            ...(gallery.url ? { url: gallery.url } : {}),
            ...(gallery.coverUrl ? { coverUrl: gallery.coverUrl } : {}),
            ...pageCountMetadata(gallery.pageCount),
          };
        });
      const minutes = effectiveFollowingInterval(
        getWatchedSearchIntervalMinutes(),
        latest.pausedAt,
        latest.intervalMinutes as FollowingInterval | null
      );
      db.transaction((tx) => {
        // No await occurs between the final ownership/revision check and commit.
        if (ids.length)
          tx.insert(schema.watchedSearchSeen)
            .values(
              ids.map((galleryId) => ({
                searchId: id,
                source: latest.source,
                galleryId,
              }))
            )
            .onConflictDoNothing()
            .run();
        pruneSeen(id, tx);
        if (freshIds.length) {
          const reviewedRows = tx
            .select({
              galleryId: schema.watchedSearchNew.galleryId,
              reviewedAt: schema.watchedSearchNew.reviewedAt,
            })
            .from(schema.watchedSearchNew)
            .where(
              and(
                eq(schema.watchedSearchNew.source, latest.source),
                inArray(schema.watchedSearchNew.galleryId, freshIds),
                sql`${schema.watchedSearchNew.reviewedAt} IS NOT NULL`
              )
            )
            .all();
          const reviewedByGallery = new Map(
            reviewedRows.map((row) => [row.galleryId, row.reviewedAt])
          );
          tx.insert(schema.watchedSearchNew)
            .values(
              freshIds.map((galleryId) => {
                const gallery = byId.get(galleryId)!;
                return {
                  searchId: id,
                  source: latest.source,
                  query: latest.query,
                  watchLabel: latest.displayName ?? latest.query,
                  galleryId,
                  title: gallery.title || galleryId,
                  url: gallery.url ?? null,
                  coverUrl: gallery.coverUrl ?? null,
                  ...pageCountMetadata(gallery.pageCount),
                  artistsJson: JSON.stringify(gallery.artists ?? []),
                  language: gallery.language ?? null,
                  reviewedAt: reviewedByGallery.get(galleryId) ?? null,
                  foundAt: checkedAt,
                };
              })
            )
            .onConflictDoNothing()
            .run();
        }
        // Only metadata already present in search results is used; never hydrate galleries.
        const enrichableIds = [...byId.values()]
          .filter((g) => g.artists?.length || g.language)
          .map((g) => g.galleryId);
        if (enrichableIds.length) {
          const existingIds = new Set(
            tx
              .select({ galleryId: schema.watchedSearchNew.galleryId })
              .from(schema.watchedSearchNew)
              .where(
                and(
                  eq(schema.watchedSearchNew.source, latest.source),
                  inArray(schema.watchedSearchNew.galleryId, enrichableIds)
                )
              )
              .all()
              .map((row) => row.galleryId)
          );
          for (const galleryId of existingIds) {
            const gallery = byId.get(galleryId);
            if (!gallery || (!gallery.artists?.length && !gallery.language))
              continue;
            tx.update(schema.watchedSearchNew)
              .set({
                ...(gallery.artists?.length
                  ? { artistsJson: JSON.stringify(gallery.artists) }
                  : {}),
                ...(gallery.language ? { language: gallery.language } : {}),
              })
              .where(
                and(
                  eq(schema.watchedSearchNew.source, latest.source),
                  eq(schema.watchedSearchNew.galleryId, gallery.galleryId)
                )
              )
              .run();
          }
        }
        tx.update(table)
          .set({
            lastCheckedAt: checkedAt,
            lastAttemptedAt: checkedAt,
            lastError: null,
            lastNewCount: freshIds.length,
            lastResultCount: ids.length,
            nextCheckAt:
              minutes > 0
                ? new Date(now + minutes * 60_000).toISOString()
                : null,
            ...(firstRun || lastResults.length
              ? { lastResultsJson: JSON.stringify(lastResults) }
              : {}),
            ...(freshIds.length ? { lastFindsAt: checkedAt } : {}),
          })
          .where(and(eq(table.id, id), eq(table.revision, latest.revision)))
          .run();
      });
      result.checked++;
      result.newGalleries += freshIds.length;
      for (const galleryId of freshIds)
        freshFinds.set(
          JSON.stringify([latest.source, galleryId]),
          byId.get(galleryId)!
        );
      if (
        latest.pausedAt === null &&
        latest.notificationMode === "immediate" &&
        !(mode === "due" && getWatchedSearchIntervalMinutes() === 0)
      ) {
        foundByTarget.set(
          id,
          freshIds.map((galleryId) => ({
            key: JSON.stringify([latest.source, galleryId]),
            gallery: byId.get(galleryId)!,
            source: latest.source,
            watch: { id: latest.id, revision: latest.revision },
          }))
        );
      }
      if (newIds.length > freshIds.length)
        log(
          "warn",
          `Watch ${id} "${latest.query}": suppressed ${newIds.length - freshIds.length} old upload(s) re-entering the result window (provider index hiccup)`
        );
      log(
        firstRun ? "info" : "success",
        `Watch ${id} "${latest.query}": ${ids.length} result(s), ${freshIds.length} new${firstRun ? " (seeded)" : ""}`
      );
      if (isCancelled?.()) throw new JobCancelled();
    } finally {
      ownedWatches.delete(id);
    }
  };
  // Providers rate-limit independently, so each source runs as its own serial
  // lane and lanes run concurrently (target order is kept within a lane).
  const sources = new Map<number, string>();
  for (let i = 0; i < targets.length; i += 500) {
    const chunk = targets.slice(i, i + 500);
    for (const row of db
      .select({ id: table.id, source: table.source })
      .from(table)
      .where(inArray(table.id, chunk))
      .all())
      sources.set(row.id, row.source);
  }
  const lanes = new Map<string, number[]>();
  for (const id of targets) {
    const source = sources.get(id) ?? "";
    const lane = lanes.get(source);
    if (lane) lane.push(id);
    else lanes.set(source, [id]);
  }
  let laneFailed = false;
  try {
    const settled = await Promise.allSettled(
      [...lanes.values()].map(async (lane) => {
        for (const id of lane) {
          // One lane's failure or cancellation stops the others at their next target.
          if (laneFailed) return;
          try {
            await checkTarget(id);
          } catch (error) {
            laneFailed = true;
            throw error;
          }
        }
      })
    );
    const failure = settled.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected"
    );
    if (failure) throw failure.reason;
    for (const id of targets) {
      for (const found of foundByTarget.get(id) ?? []) {
        const candidate = notifications.get(found.key) ?? {
          gallery: found.gallery,
          source: found.source,
          settings: getNotificationSettings(),
          watches: [],
        };
        candidate.watches.push(found.watch);
        notifications.set(found.key, candidate);
      }
    }
    // Finds that improve on an owned copy (uncensored/decensored editions) are
    // recorded on the discovery so Home, the feed and Discord can call them out.
    const betterEditions = await recordBetterEditions(
      [...freshFinds.values()],
      log
    );
    result.betterEditions = betterEditions.size;
    // Discoveries and check results are committed before Discord is contacted.
    // The normal Task records outcomes; there is no delivery queue or backlog replay.
    for (const candidate of notifications.values()) {
      if (isCancelled?.()) throw new JobCancelled();
      const watchIds = [
        ...new Set(candidate.watches.map((snapshot) => snapshot.id)),
      ];
      const watchesById = new Map<
        number,
        {
          id: number;
          revision: number;
          pausedAt: string | null;
          notificationMode: string;
          displayName: string | null;
          query: string;
        }
      >();
      for (let i = 0; i < watchIds.length; i += 500) {
        for (const watch of db
          .select({
            id: table.id,
            revision: table.revision,
            pausedAt: table.pausedAt,
            notificationMode: table.notificationMode,
            displayName: table.displayName,
            query: table.query,
          })
          .from(table)
          .where(inArray(table.id, watchIds.slice(i, i + 500)))
          .all()) {
          watchesById.set(watch.id, watch);
        }
      }
      const current = candidate.watches.flatMap((snapshot) => {
        const watch = watchesById.get(snapshot.id);
        return watch &&
          watch.revision === snapshot.revision &&
          watch.pausedAt === null &&
          watch.notificationMode === "immediate"
          ? [watch]
          : [];
      });
      if (!current.length) continue;
      const discoveries = schema.watchedSearchNew;
      const identity = and(
        eq(discoveries.source, candidate.source),
        eq(discoveries.galleryId, candidate.gallery.galleryId)
      );
      const claimed = db.transaction((tx) => {
        if (
          tx
            .select({ id: discoveries.id })
            .from(discoveries)
            .where(
              and(
                identity,
                sql`${discoveries.notificationAttemptedAt} IS NOT NULL`
              )
            )
            .get()
        )
          return false;
        return (
          tx
            .update(discoveries)
            .set({
              notificationAttemptedAt: new Date(Date.now()).toISOString(),
            })
            .where(identity)
            .run().changes > 0
        );
      });
      if (!claimed) continue;
      const gallery = candidate.gallery;
      const label = [
        ...new Set(current.map((watch) => watch.displayName ?? watch.query)),
      ].join(", ");
      const escape = (value: string, limit: number) =>
        value.slice(0, limit).replace(/[\\`*_~[\]()<>]/g, "\\$&");
      const title = escape(gallery.title, 100);
      const url =
        gallery.url && /^https?:\/\//i.test(gallery.url)
          ? gallery.url.replace(/[()\s]/g, encodeURIComponent)
          : null;
      const better = betterEditions.get(
        `${candidate.source}:${gallery.galleryId}`
      );
      try {
        const outcome = await notify(
          {
            title: better ? "Better edition in Following" : "New in Following",
            success: true,
            description: `${better ? "Uncensored edition of a gallery you own" : "1 new gallery"}\n${url && url.length < 300 ? `[${title}](${url})` : title}${better ? `\nYou own: ${escape(better.title, 160)}` : ""}\nVia ${escape(label, 180)}`,
          },
          {
            revision: candidate.settings.revision,
            destinationIdentity: candidate.settings.destinationIdentity,
          }
        );
        if (outcome.status === "delivered") {
          result.notified++;
          log(
            "success",
            `Discord notification sent for ${gallery.title} · ${label}`
          );
        }
      } catch (error) {
        const unknown =
          !(error instanceof NotificationFailure) ||
          error.outcome === "unknown";
        if (unknown) result.notificationUnknown++;
        else result.notificationFailed++;
        log(
          "warn",
          `Discord ${unknown ? "delivery uncertain" : "notification failed"} for ${gallery.title}: ${error instanceof NotificationFailure ? error.message : "No delivery confirmation."}`
        );
      }
    }
    onProgress?.(targets.length, targets.length);
    return result;
  } finally {
    notifyWatchedScheduleChanged();
  }
}

/** Check fresh finds against the library once; a failed check never fails the watch check. */
async function recordBetterEditions(
  finds: DoujinSearchResult[],
  log: LogFn
): Promise<Map<string, BetterEditionOf>> {
  if (!finds.length) return new Map();
  let better: Map<string, BetterEditionOf>;
  try {
    better = await findBetterEditions(
      finds.map((gallery) => ({
        source: gallery.source,
        galleryId: gallery.galleryId,
        title: gallery.title,
        artists: gallery.artists ?? [],
        language: gallery.language,
        ...pageCountMetadata(gallery.pageCount),
        tags: gallery.tags ?? [],
      }))
    );
  } catch (error) {
    log(
      "warn",
      `Could not compare new finds with your library for better editions: ${error instanceof Error ? error.message : String(error)}`
    );
    return new Map();
  }
  if (!better.size) return better;
  const table = schema.watchedSearchNew;
  getDb().transaction((tx) => {
    for (const [key, owned] of better) {
      const [source, ...rest] = key.split(":");
      tx.update(table)
        .set({ betterEditionJson: JSON.stringify({ title: owned.title }) })
        .where(
          and(eq(table.source, source), eq(table.galleryId, rest.join(":")))
        )
        .run();
    }
  });
  const findByKey = new Map(
    finds.map((gallery) => [`${gallery.source}:${gallery.galleryId}`, gallery])
  );
  for (const [key, owned] of better)
    log(
      "success",
      `Better edition found: ${findByKey.get(key)?.title ?? key} improves on “${owned.title}”`
    );
  return better;
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
  for (let i = 0; i < ids.length; i += 500) {
    db.delete(schema.watchedSearchSeen)
      .where(inArray(schema.watchedSearchSeen.id, ids.slice(i, i + 500)))
      .run();
  }
}

type FeedRow = Pick<
  typeof schema.watchedSearchNew.$inferSelect,
  | "source"
  | "galleryId"
  | "title"
  | "url"
  | "coverUrl"
  | "pageCount"
  | "query"
  | "watchLabel"
  | "foundAt"
  | "searchId"
  | "artistsJson"
  | "language"
  | "reviewedAt"
  | "betterEditionJson"
>;

function betterEditionOf(
  json: string | null
): WatchedNewGallery["betterEditionOf"] {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as { title?: unknown };
    return typeof value?.title === "string"
      ? { title: value.title }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read current labels/membership when possible and snapshots after watch removal. */
function feedItem(
  r: FeedRow,
  watch: Pick<WatchRow, "displayName" | "query"> | undefined
): WatchedNewGallery {
  let artists: string[] = [];
  try {
    const values: unknown = JSON.parse(r.artistsJson);
    if (Array.isArray(values))
      artists = values.filter(
        (artist): artist is string => typeof artist === "string"
      );
  } catch {
    /* Old metadata may be incomplete. */
  }
  return {
    source: r.source as DoujinSource,
    galleryId: r.galleryId,
    title: r.title,
    ...(r.url ? { url: r.url } : {}),
    ...(r.coverUrl ? { coverUrl: r.coverUrl } : {}),
    ...pageCountMetadata(r.pageCount),
    query: r.query,
    watchLabel: watch
      ? (watch.displayName ?? watch.query)
      : r.watchLabel || r.query,
    watchRemoved: !watch,
    foundAt: r.foundAt,
    searchId: r.searchId,
    artists,
    ...(r.language ? { language: r.language } : {}),
    reviewedAt: r.reviewedAt,
    ...(betterEditionOf(r.betterEditionJson)
      ? { betterEditionOf: betterEditionOf(r.betterEditionJson) }
      : {}),
  };
}

function queryGalleryFeed(
  options: FollowingFeedOptions = {},
  includeWatches = true
): WatchedGalleryFeed {
  const db = getDb(),
    table = schema.watchedSearchNew,
    watch = schema.watchedSearches;
  const filters = and(
    options.source ? eq(table.source, options.source) : undefined,
    options.searchId !== undefined
      ? eq(table.searchId, options.searchId)
      : undefined,
    options.folderId === "unfiled"
      ? sql`NOT EXISTS (SELECT 1 FROM ${watch} WHERE ${watch.id} = ${table.searchId} AND ${watch.folderId} IS NOT NULL)`
      : options.folderId !== undefined
        ? sql`EXISTS (SELECT 1 FROM ${watch} WHERE ${watch.id} = ${table.searchId} AND ${watch.folderId} = ${options.folderId})`
        : undefined
  );
  // Folder membership, source, and watch filters apply before winner selection.
  // Winners only project narrow key/filter columns inside the materialized CTE;
  // wide text/JSON columns are joined only for the returned page.
  const rows = db.all<{
    total: number;
    inbox_count: number;
    better_count: number;
    id: number | null;
    search_id: number;
    source: string;
    query: string;
    watch_label: string;
    gallery_id: string;
    title: string;
    url: string | null;
    cover_url: string | null;
    page_count: number | null;
    artists_json: string;
    language: string | null;
    reviewed_at: string | null;
    better_edition_json: string | null;
    found_at: string;
  }>(sql`WITH winners AS MATERIALIZED (
      SELECT id, found_at, reviewed_at, has_better FROM (
        SELECT id, found_at, reviewed_at, (better_edition_json IS NOT NULL) AS has_better,
          ROW_NUMBER() OVER (PARTITION BY source, gallery_id ORDER BY found_at DESC, id DESC) AS n
        FROM watched_search_new ${filters ? sql`WHERE ${filters}` : sql``}
      ) WHERE n = 1
    ),
    counts AS (SELECT count(*) AS total, coalesce(sum(CASE WHEN reviewed_at IS NULL THEN 1 ELSE 0 END), 0) AS inbox_count,
      coalesce(sum(CASE WHEN reviewed_at IS NULL AND has_better = 1 THEN 1 ELSE 0 END), 0) AS better_count FROM winners),
    page AS (
      SELECT id, found_at FROM winners ${options.view === "inbox" ? sql`WHERE reviewed_at IS NULL` : sql``}
      ORDER BY found_at DESC, id DESC LIMIT ${options.limit ?? 100} OFFSET ${options.offset ?? 0}
    )
    SELECT counts.total AS total, counts.inbox_count AS inbox_count, counts.better_count AS better_count,
      w.id, w.search_id, w.source, w.query, w.watch_label, w.gallery_id, w.title, w.url, w.cover_url,
      w.page_count, w.artists_json, w.language, w.reviewed_at, w.better_edition_json, w.found_at
    FROM counts
    LEFT JOIN page ON 1
    LEFT JOIN watched_search_new w ON w.id = page.id
    ORDER BY page.found_at DESC, page.id DESC`);
  const counts = {
    total: Number(rows[0]?.total ?? 0),
    inboxCount: Number(rows[0]?.inbox_count ?? 0),
    betterEditionCount: Number(rows[0]?.better_count ?? 0),
  };
  // Watch labels only; lastResultsJson blobs are not needed here.
  const current = new Map(
    db
      .select({
        id: watch.id,
        query: watch.query,
        source: watch.source,
        displayName: watch.displayName,
        folderId: watch.folderId,
      })
      .from(watch)
      .all()
      .map((row) => [row.id, row] as const)
  );
  const items = rows
    .filter((row) => row.id !== null)
    .map((row) =>
      feedItem(
        {
          source: row.source,
          galleryId: row.gallery_id,
          title: row.title,
          url: row.url,
          coverUrl: row.cover_url,
          pageCount: row.page_count,
          query: row.query,
          watchLabel: row.watch_label,
          foundAt: row.found_at,
          searchId: row.search_id,
          artistsJson: row.artists_json,
          language: row.language,
          reviewedAt: row.reviewed_at,
          betterEditionJson: row.better_edition_json,
        },
        current.get(row.search_id)
      )
    );
  const watches: WatchedGalleryFeed["watches"] = [];
  if (includeWatches) {
    for (const row of current.values())
      watches.push({
        id: row.id,
        query: row.query,
        source: row.source as DoujinSource,
        watchLabel: row.displayName ?? row.query,
        folderId: row.folderId,
        removed: false,
      });
    const retained = db
      .select({
        id: table.searchId,
        query: table.query,
        source: table.source,
        watchLabel: table.watchLabel,
      })
      .from(table)
      .where(
        sql`NOT EXISTS (SELECT 1 FROM ${watch} WHERE ${watch.id} = ${table.searchId})`
      )
      .groupBy(table.searchId)
      .orderBy(table.searchId)
      .all();
    for (const row of retained)
      watches.push({
        ...row,
        source: row.source as DoujinSource,
        watchLabel: row.watchLabel || row.query,
        folderId: null,
        removed: true,
      });
    watches.sort((a, b) => a.id - b.id);
  }
  return {
    items,
    total: Number(options.view === "inbox" ? counts.inboxCount : counts.total),
    inboxCount: Number(counts.inboxCount),
    historyCount: Number(counts.total),
    betterEditionCount: counts.betterEditionCount,
    watches,
  };
}

export function listGalleryFeed(
  options: FollowingFeedOptions = {}
): WatchedGalleryFeed {
  return queryGalleryFeed(options, true);
}

export function listNewGalleries(limit = 100): WatchedNewGallery[] {
  return queryGalleryFeed({ limit }, false).items;
}

/** Review is shared by every watch that discovered this provider/gallery identity. */
export function setGalleriesReviewed(
  items: { source: DoujinSource; galleryId: string }[],
  reviewed: boolean
): boolean {
  const table = schema.watchedSearchNew;
  return getDb().transaction((tx) => {
    for (const item of items)
      if (
        !tx
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.source, item.source),
              eq(table.galleryId, item.galleryId)
            )
          )
          .get()
      )
        return false;
    const reviewedAt = reviewed ? new Date().toISOString() : null;
    for (const item of items)
      tx.update(table)
        .set({ reviewedAt })
        .where(
          and(
            eq(table.source, item.source),
            eq(table.galleryId, item.galleryId)
          )
        )
        .run();
    return true;
  });
}

/**
 * One-shot migration for databases upgraded from a build without the "recently
 * added" feed: watches whose lastResultsJson was written by an older build never
 * had their finds persisted to watched_search_new. Replay those entries with
 * foundAt = the reporting finds timestamp (or legacy lastCheckedAt). Idempotent — the
 * unique index makes replays of already-persisted finds no-ops, so this is safe
 * to run on every startup; it returns how many rows were actually inserted.
 */
/**
 * Set once a replay has completed. Current builds persist every reported find to
 * watched_search_new in the same transaction as lastResultsJson, so later boots
 * have nothing to replay.
 */
const BACKFILL_DONE_KEY = "watched-new-backfill:v1";

export function backfillNewGalleries(): number {
  const db = getDb();
  if (
    db
      .select({ key: schema.keyValueStore.key })
      .from(schema.keyValueStore)
      .where(eq(schema.keyValueStore.key, BACKFILL_DONE_KEY))
      .get()
  )
    return 0;
  return db.transaction((tx) => {
    const inserted = replayLegacyLastResults(tx);
    tx.insert(schema.keyValueStore)
      .values({
        key: BACKFILL_DONE_KEY,
        valueJson: JSON.stringify({ completedAt: new Date().toISOString() }),
      })
      .onConflictDoNothing()
      .run();
    return inserted;
  });
}

function replayLegacyLastResults(db: Db): number {
  const rows = db
    .select({
      id: schema.watchedSearches.id,
      source: schema.watchedSearches.source,
      query: schema.watchedSearches.query,
      displayName: schema.watchedSearches.displayName,
      lastResultsJson: schema.watchedSearches.lastResultsJson,
      lastFindsAt: schema.watchedSearches.lastFindsAt,
      lastCheckedAt: schema.watchedSearches.lastCheckedAt,
    })
    .from(schema.watchedSearches)
    .where(sql`${schema.watchedSearches.lastResultsJson} IS NOT NULL`)
    .all();
  let inserted = 0;
  for (const row of rows) {
    const items = decodeLastResults(row.lastResultsJson);
    if (items.length === 0) continue;
    const foundAt =
      row.lastFindsAt ?? row.lastCheckedAt ?? new Date().toISOString();
    // Review is shared per gallery identity: one lookup per watch, not per find.
    const reviewed = new Map(
      db
        .select({
          galleryId: schema.watchedSearchNew.galleryId,
          reviewedAt: schema.watchedSearchNew.reviewedAt,
        })
        .from(schema.watchedSearchNew)
        .where(
          and(
            eq(schema.watchedSearchNew.source, row.source),
            inArray(schema.watchedSearchNew.galleryId, [
              ...new Set(items.map((item) => item.galleryId)),
            ]),
            sql`${schema.watchedSearchNew.reviewedAt} IS NOT NULL`
          )
        )
        .all()
        .map((found) => [found.galleryId, found.reviewedAt] as const)
    );
    const res = db
      .insert(schema.watchedSearchNew)
      .values(
        items.map((r) => ({
          searchId: row.id,
          source: row.source,
          query: row.query,
          watchLabel: row.displayName ?? row.query,
          galleryId: r.galleryId,
          title: r.title,
          ...(r.url ? { url: r.url } : {}),
          ...(r.coverUrl ? { coverUrl: r.coverUrl } : {}),
          ...pageCountMetadata(r.pageCount),
          reviewedAt: reviewed.get(r.galleryId) ?? null,
          foundAt,
        }))
      )
      .onConflictDoNothing()
      .run();
    inserted += Number(res.changes ?? 0);
  }
  return inserted;
}
