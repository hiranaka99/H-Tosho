import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { getDownloaderSettings, type DownloaderSettings } from "./settings.js";
import { getDoujinProvider } from "../downloader/providers.js";
import type { DoujinSearchResult } from "../downloader/types.js";
import {
  getRecommendationFeedback,
  normalizeArtist,
  normalizeTag,
} from "./recommendationFeedback.js";
import {
  createKnownLibraryDuplicateState,
  findKnownLibraryDuplicateKeys,
  type KnownLibraryDuplicateState,
} from "./galleryDuplicates.js";

type GalleryKey = { source: string; galleryId: string };

/**
 * Exclusion state read once and shared by every eligibility pass of one
 * refresh/response, instead of re-scanning the exclusion tables per call.
 */
export interface EligibilityContext {
  /** Owned galleries (always complete — the UI badges any search result with it). */
  owned: Set<string>;
  /** Dismissed galleries (always complete). */
  dismissed: Set<string>;
  /** Completed or in-flight downloads. Scoped to the requested keys when built with a scope. */
  activeDownloads: Set<string>;
  /** Unreviewed Following finds. Scoped like `activeDownloads`. */
  unreviewedFollowing: Set<string>;
  /** Galleries with recorded download metadata. Scoped like `activeDownloads`. */
  tagged: Set<string>;
  settings: DownloaderSettings;
  mutedArtists: Set<string>;
  mutedTags: Set<string>;
  /** Lazy snapshot of known library duplicate indexes, reused across passes in one roll. */
  duplicateState?: KnownLibraryDuplicateState | null;
}

const keyOf = (row: GalleryKey) => `${row.source}:${row.galleryId}`;
/** Bound-parameter batch size, far below SQLite's variable limit. */
const KEY_CHUNK = 500;

/** Exact-key lookup: group by source and query indexed (source, gallery_id) chunks. */
function scopedKeys(
  scope: GalleryKey[],
  lookup: (source: string, galleryIds: string[]) => GalleryKey[]
): Set<string> {
  const bySource = new Map<string, Set<string>>();
  for (const item of scope) {
    if (!item.galleryId) continue;
    const ids = bySource.get(item.source);
    if (ids) ids.add(item.galleryId);
    else bySource.set(item.source, new Set([item.galleryId]));
  }
  const out = new Set<string>();
  for (const [source, idSet] of bySource) {
    const ids = [...idSet];
    for (let i = 0; i < ids.length; i += KEY_CHUNK) {
      for (const row of lookup(source, ids.slice(i, i + KEY_CHUNK)))
        out.add(keyOf(row));
    }
  }
  return out;
}

const ACTIVE_STATUSES = ["completed", "queued", "downloading", "paused"];

/**
 * Snapshot the exclusion inputs. Without `scope`, every table is read in full
 * (generation needs the complete sets for its search exclusions). With `scope`,
 * download/Following/tag exclusions are looked up only for those galleries.
 */
export function buildEligibilityContext(
  scope?: GalleryKey[]
): EligibilityContext {
  const db = getDb();
  const owned = new Set(
    db
      .select({
        source: schema.ownedGalleries.source,
        galleryId: schema.ownedGalleries.galleryId,
      })
      .from(schema.ownedGalleries)
      .all()
      .map(keyOf)
  );
  const dismissed = new Set(
    db
      .select({
        source: schema.dismissedGalleries.source,
        galleryId: schema.dismissedGalleries.galleryId,
      })
      .from(schema.dismissedGalleries)
      .all()
      .map(keyOf)
  );
  let activeDownloads: Set<string>;
  let unreviewedFollowing: Set<string>;
  let tagged: Set<string>;
  if (scope) {
    activeDownloads = scopedKeys(scope, (source, ids) =>
      db
        .select({
          source: schema.downloadQueue.source,
          galleryId: schema.downloadQueue.galleryId,
        })
        .from(schema.downloadQueue)
        .where(
          and(
            eq(schema.downloadQueue.source, source),
            inArray(schema.downloadQueue.galleryId, ids),
            inArray(schema.downloadQueue.status, ACTIVE_STATUSES)
          )
        )
        .all()
    );
    unreviewedFollowing = scopedKeys(scope, (source, ids) =>
      db
        .select({
          source: schema.watchedSearchNew.source,
          galleryId: schema.watchedSearchNew.galleryId,
        })
        .from(schema.watchedSearchNew)
        .where(
          and(
            eq(schema.watchedSearchNew.source, source),
            inArray(schema.watchedSearchNew.galleryId, ids),
            isNull(schema.watchedSearchNew.reviewedAt)
          )
        )
        .all()
    );
    tagged = scopedKeys(scope, (source, ids) =>
      db
        .select({
          source: schema.galleryTags.source,
          galleryId: schema.galleryTags.galleryId,
        })
        .from(schema.galleryTags)
        .where(
          and(
            eq(schema.galleryTags.source, source),
            inArray(schema.galleryTags.galleryId, ids)
          )
        )
        .all()
    );
  } else {
    activeDownloads = new Set(
      db
        .select({
          source: schema.downloadQueue.source,
          galleryId: schema.downloadQueue.galleryId,
        })
        .from(schema.downloadQueue)
        .where(inArray(schema.downloadQueue.status, ACTIVE_STATUSES))
        .all()
        .map(keyOf)
    );
    unreviewedFollowing = new Set(
      db
        .select({
          source: schema.watchedSearchNew.source,
          galleryId: schema.watchedSearchNew.galleryId,
        })
        .from(schema.watchedSearchNew)
        .where(isNull(schema.watchedSearchNew.reviewedAt))
        .all()
        .map(keyOf)
    );
    tagged = new Set(
      db
        .select({
          source: schema.galleryTags.source,
          galleryId: schema.galleryTags.galleryId,
        })
        .from(schema.galleryTags)
        .all()
        .map(keyOf)
    );
  }
  const feedback = getRecommendationFeedback();
  return {
    owned,
    dismissed,
    activeDownloads,
    unreviewedFollowing,
    tagged,
    settings: getDownloaderSettings(),
    mutedArtists: new Set(feedback.mutedArtists.map(normalizeArtist)),
    mutedTags: new Set(feedback.mutedTags.map(normalizeTag)),
  };
}

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");

/**
 * Every selection source passes this policy, including cached cards and history.
 * Pass the refresh's shared `context` to avoid re-reading exclusion state; without
 * one, a context scoped to `items` is built.
 */
export async function eligibleRecommendations<T extends DoujinSearchResult>(
  items: T[],
  context?: EligibilityContext
): Promise<T[]> {
  if (items.length === 0) return [];
  const ctx = context ?? buildEligibilityContext(items);
  const { settings, mutedArtists, mutedTags } = ctx;
  const excluded = (key: string) =>
    ctx.owned.has(key) ||
    ctx.dismissed.has(key) ||
    ctx.tagged.has(key) ||
    ctx.activeDownloads.has(key) ||
    ctx.unreviewedFollowing.has(key);
  const bannedEntries = settings.hitomiBannedTags.map((raw) => {
    const entry = normalize(raw);
    const colon = entry.indexOf(":");
    return {
      entry,
      namespace: colon < 0 ? "" : entry.slice(0, colon),
      value: colon < 0 ? entry : entry.slice(colon + 1),
    };
  });
  const passesLocalPolicy = items.filter((item) => {
    if (
      item.source !== "hitomi" ||
      !item.galleryId ||
      !item.title ||
      !Array.isArray(item.tags) ||
      !Array.isArray(item.artists) ||
      excluded(`${item.source}:${item.galleryId}`)
    )
      return false;
    if (item.artists.some((a) => mutedArtists.has(normalizeArtist(a))))
      return false;
    if (item.tags.some((t) => mutedTags.has(normalizeTag(t)))) return false;
    if (!bannedEntries.length) return true;
    const fields = new Set(
      [...item.tags, ...item.artists, item.title].map(normalize)
    );
    const artists = new Set(item.artists.map(normalize));
    for (const { entry, namespace, value } of bannedEntries) {
      if (
        namespace === "artist"
          ? artists.has(value)
          : fields.has(value) || fields.has(entry)
      )
        return false;
    }
    return true;
  });
  // The duplicate index is the costliest check, so it only sees items that survived the cheap ones.
  let libraryDuplicates = new Set<string>();
  if (passesLocalPolicy.length > 0) {
    if (ctx.duplicateState === undefined)
      ctx.duplicateState = createKnownLibraryDuplicateState();
    libraryDuplicates = findKnownLibraryDuplicateKeys(
      passesLocalPolicy,
      ctx.duplicateState
    );
  }
  const allowed = libraryDuplicates.size
    ? passesLocalPolicy.filter(
        (item) => !libraryDuplicates.has(`${item.source}:${item.galleryId}`)
      )
    : passesLocalPolicy;
  if (allowed.length === 0 || settings.hitomiBannedTags.length === 0)
    return allowed;
  const provider = getDoujinProvider("hitomi");
  if (!provider?.filterRecommendations) return allowed;
  try {
    const filtered = await provider.filterRecommendations(allowed);
    const keys = new Set(
      filtered.map((item) => `${item.source}:${item.galleryId}`)
    );
    return allowed.filter((item) =>
      keys.has(`${item.source}:${item.galleryId}`)
    );
  } catch (error) {
    // A failed exclusion lookup is not permission to recommend excluded content.
    console.warn("[recommendations] exclusion check unavailable:", error);
    return [];
  }
}
