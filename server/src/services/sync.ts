import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  KavitaPublicationStatus,
  type SeriesMetadataPayload,
} from '../kavita/types.js';
import type { SeriesMetadata, VolumeCover } from '../providers/types.js';
import type { KavitaVolume } from '../kavita/types.js';
import { getKavitaConnection, getNotificationSettings } from './settings.js';
import { notify } from '../notify/dispatcher.js';
import { jobQueue } from '../jobs/queue.js';

/** Fields H-Tosho can push to a Kavita series. */
export interface ApplyResult {
  seriesId: number;
  pushed: string[];
  coverUpdated: boolean;
  /** Number of volume covers successfully pushed. */
  volumeCoversUpdated: number;
  errors: string[];
  /** Non-fatal notes, e.g. fields the server accepted but did not apply. */
  warnings: string[];
}

/** A provider volume cover paired with the Kavita volume it maps onto. */
export interface VolumeCoverAssignment {
  /** Kavita volume id to upload to. */
  volumeId: number;
  /** Matched volume number. */
  number: number;
  /** Provider CDN URL to download from. */
  url: string;
}

const PUBLICATION_STATUS: Record<NonNullable<SeriesMetadata['status']>, KavitaPublicationStatus | undefined> = {
  ONGOING: KavitaPublicationStatus.Ongoing,
  HIATUS: KavitaPublicationStatus.Hiatus,
  COMPLETED: KavitaPublicationStatus.Completed,
  CANCELLED: KavitaPublicationStatus.Cancelled,
  UNKNOWN: undefined,
};

function releaseYear(meta: SeriesMetadata): number | undefined {
  if (meta.year && meta.year >= 1 && meta.year <= 9999) return meta.year;
  if (!meta.releaseDate) return undefined;
  const year = Number(meta.releaseDate.slice(0, 4));
  return year >= 1 && year <= 9999 ? year : undefined;
}

/** Map a unified SeriesMetadata onto a Kavita series metadata payload. */
export function buildSeriesPayload(meta: SeriesMetadata): SeriesMetadataPayload {
  const payload: SeriesMetadataPayload = {};
  if (meta.title) payload.name = meta.title;
  if (meta.sortTitle) payload.sortName = meta.sortTitle;
  if (meta.summary) payload.summary = meta.summary;
  if (meta.genres.length) payload.genres = meta.genres;
  if (meta.tags.length) payload.tags = meta.tags;
  if (meta.writers.length) payload.writers = meta.writers;
  if (meta.artists.length) payload.artists = meta.artists;
  if (meta.publishers.length) payload.publishers = meta.publishers;
  const year = releaseYear(meta);
  if (year !== undefined) payload.releaseYear = year;
  if (meta.language) payload.language = meta.language;
  if (meta.status && PUBLICATION_STATUS[meta.status] !== undefined) {
    payload.publicationStatus = PUBLICATION_STATUS[meta.status];
  }
  if (meta.url) payload.webLinks = meta.url;
  return payload;
}
/**
 * Union of the series' existing tags and incoming provider tags, deduplicated
 * case-insensitively (the first spelling wins, so existing tags keep their
 * casing). Whitespace-only entries are dropped.
 */
export function mergeTagLists(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...incoming]) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** User-selectable sync fields (identify dialog checkboxes) -> payload property names. */
const EXCLUDABLE_FIELDS: Record<string, string> = {
  title: 'name',
  sortTitle: 'sortName',
  summary: 'summary',
  genres: 'genres',
  tags: 'tags',
  writers: 'writers',
  artists: 'artists',
  publishers: 'publishers',
  releaseDate: 'releaseYear',
  language: 'language',
  status: 'publicationStatus',
  url: 'webLinks',
};

/**
 * Apply matched metadata to a Kavita series:
 * 1. Read/merge/write identity and metadata fields
 * 2. Stage and apply cover image (if enabled + available)
 * 3. Push per-volume covers onto matching Kavita volumes (if enabled + available)
 * 4. Record sync history + fire notifications
 */
export async function applyToKavita(
  client: KavitaClient,
  seriesId: number,
  meta: SeriesMetadata,
  opts: {
    cover: Buffer | null;
    volumeCovers?: VolumeCover[];
    title: string;
    /** Fields the user deselected in the identify dialog (EXCLUDABLE_FIELDS keys). */
    excludedFields?: string[];
  },
): Promise<ApplyResult> {
  const errors: string[] = [];
  const pushed: string[] = [];
  const warnings: string[] = [];
  let coverUpdated = false;
  let volumeCoversUpdated = 0;

  const payload = buildSeriesPayload(meta);
  // Drop fields the user explicitly deselected for this sync.
  for (const f of opts.excludedFields ?? []) {
    const prop = EXCLUDABLE_FIELDS[f];
    if (prop) delete payload[prop as keyof typeof payload];
  }
  // Merge provider tags with the series' existing Kavita tags instead of
  // replacing them (Kavita's metadata update is a full-field write).
  if (payload.tags) {
    try {
      const current = await client.getSeriesMetadata(seriesId);
      payload.tags = mergeTagLists((current.tags ?? []).map((t) => t.title).filter((t): t is string => Boolean(t)), payload.tags);
    } catch {
      /* series without a metadata row yet — push provider tags as-is */
    }
  }
  const fields = Object.keys(payload).filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
  if (fields.length) {
    try {
      await client.updateSeriesMetadata(seriesId, payload);
      pushed.push(...fields);
    } catch (err) {
      errors.push(`metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Kavita v0.9 silently ignores series name updates — the name follows the
  // folder path and only 0.10+ applies renames via /Series/update. Verify the
  // write landed so sync history never claims a rename that didn't happen.
  if (payload.name !== undefined) {
    try {
      const current = await client.getSeriesById(seriesId);
      if ((current.name ?? '').trim() !== String(payload.name).trim()) {
        const i = pushed.indexOf('name');
        if (i !== -1) pushed.splice(i, 1);
        warnings.push(
          'Kavita did not apply the series name (v0.9 derives it from the folder path; renaming via API requires 0.10+)',
        );
      }
    } catch {
      /* verification is best-effort; keep the reported push */
    }
  }

  if (opts.cover && opts.cover.length > 0) {
    try {
      await client.updateSeriesCover(seriesId, opts.cover, false);
      coverUpdated = true;
      pushed.push('cover');
    } catch (err) {
      errors.push(`cover: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.volumeCovers?.length) {
    const volResult = await applyVolumeCovers(client, seriesId, opts.volumeCovers);
    volumeCoversUpdated = volResult.updated;
    errors.push(...volResult.errors);
    if (volResult.updated > 0) pushed.push(`volumeCovers:${volResult.updated}`);
  }

  // Persist history
  const db = getDb();
  db.insert(schema.syncHistory)
    .values({
      kavitaSeriesId: seriesId,
      seriesTitle: opts.title,
      action: errors.length ? 'failed' : 'updated',
      detailsJson: JSON.stringify({ provider: meta.providerId, pushed, coverUpdated, volumeCoversUpdated, errors, warnings }),
    })
    .run();

  // Notifications (fire-and-forget)
  const notif = getNotificationSettings();
  if (notif.discord.enabled) {
    notify({
      title: errors.length ? `Sync failed: ${opts.title}` : `Updated: ${opts.title}`,
      body: `${meta.providerId} - ${pushed.join(', ') || 'no fields'}`,
      coverUrl: meta.coverUrl ?? undefined,
      success: errors.length === 0,
    }).catch(() => {});
  }

  // Update match row
  const row = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
  if (row) {
    db.update(schema.seriesMatches)
      .set({
        status: errors.length ? 'failed' : 'matched',
        lastSyncedAt: new Date().toISOString(),
        errorMessage: errors.length ? errors.join('; ') : null,
      })
      .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
      .run();
  }

  return { seriesId, pushed, coverUpdated, volumeCoversUpdated, errors, warnings };
}

/** Download a cover from a provider URL, returning null on failure. */
export async function fetchCover(client: KavitaClient, url?: string): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const buf = await client.downloadImage(url);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
/**
 * Download and push per-volume covers onto matching Kavita volumes. Failures
 * are reported per volume (never aborting the remaining ones); a missing or
 * unmatched volume simply goes without a cover.
 */
export async function applyVolumeCovers(
  client: KavitaClient,
  seriesId: number,
  covers: VolumeCover[],
): Promise<{ updated: number; errors: string[] }> {
  let volumes: KavitaVolume[];
  try {
    volumes = await client.getVolumes(seriesId);
  } catch (err) {
    return { updated: 0, errors: [`volumes: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors: string[] = [];
  let updated = 0;
  for (const assignment of matchVolumeCovers(volumes, covers)) {
    const image = await fetchCover(client, assignment.url);
    if (!image) {
      errors.push(`vol ${assignment.number}: cover download failed`);
      continue;
    }
    try {
      await client.updateVolumeCover(assignment.volumeId, image, false);
      updated += 1;
    } catch (err) {
      errors.push(`vol ${assignment.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { updated, errors };
}

/**
 * Pair provider volume covers with Kavita volumes by volume number. Kavita's
 * `minNumber` is the volume number; entries without a usable number are
 * skipped. Each Kavita volume and each provider cover is used at most once.
 */
export function matchVolumeCovers(volumes: KavitaVolume[], covers: VolumeCover[]): VolumeCoverAssignment[] {
  const out: VolumeCoverAssignment[] = [];
  const used = new Set<number>();
  for (const cover of covers) {
    const vol = volumes.find(
      (v) => !used.has(v.id) && v.number !== undefined && Number.isFinite(v.number) && Math.round(v.number) === cover.number,
    );
    if (!vol) continue;
    used.add(vol.id);
    out.push({ volumeId: vol.id, number: cover.number, url: cover.url });
  }
  return out;
}

export function getConnectedClient(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}

/**
 * Diff a library's current series against a pre-rescan snapshot and enqueue a
 * match-series job for exactly the titles that appeared — new to Kavita AND
 * never processed by H-Tosho before. Existing series are never re-matched.
 * Returns the enqueued series IDs (empty when nothing is new).
 */
export async function enqueueMatchForNewSeries(
  client: Pick<KavitaClient, 'getSeries'>,
  libraryId: number,
  seenIds: ReadonlySet<number>,
): Promise<number[]> {
  const series = await client.getSeries(libraryId);
  const known = new Set(getDb().select().from(schema.seriesMatches).all().map((r) => r.kavitaSeriesId));
  const fresh = series.filter((s) => !seenIds.has(s.id) && !known.has(s.id)).map((s) => s.id);
  if (fresh.length > 0) jobQueue.enqueue('match-series', { seriesIds: fresh });
  return fresh;
}