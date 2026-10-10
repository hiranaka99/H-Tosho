import { eq } from 'drizzle-orm';
import path from 'node:path';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  KavitaPublicationStatus,
  type SeriesMetadataPayload,
} from '../kavita/types.js';
import type { SeriesMetadata, VolumeCover } from '../providers/types.js';
import type { KavitaVolume, KavitaSeries, KavitaSeriesMetadataDto } from '../kavita/types.js';
import { fetchProviderMetadata } from '../match/autoMatcher.js';
import { listCbzFiles, resolveSeriesHostDir, setSeriesTitleInCbzFiles } from '../lib/cbz.js';
import { mapLimit } from '../lib/http.js';
import { invalidateSeriesArtists } from './seriesArtists.js';
import { getCredentialMap, getDownloaderSettings } from './settings.js';
import { jobQueue, JobCancelled } from '../jobs/queue.js';

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
  // An empty string is meaningful: the provider's description was tag blocks
  // only, so any stale summary (e.g. an old raw tag table) must be cleared.
  if (meta.summary !== undefined) payload.summary = meta.summary;
  if (meta.genres.length) payload.genres = meta.genres;
  if (meta.tags.length) payload.tags = meta.tags;
  if (meta.writers.length) payload.writers = meta.writers;
  if (meta.artists.length) payload.artists = meta.artists;
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
  summary: 'summary',
  genres: 'genres',
  tags: 'tags',
  writers: 'writers',
  artists: 'artists',
  releaseDate: 'releaseYear',
  language: 'language',
  status: 'publicationStatus',
  url: 'webLinks',
};

/**
 * Apply matched metadata to a Kavita series:
 * 1. Read/merge/write identity and metadata fields
 * 2. Stage, apply, and lock the cover image (if enabled + available)
 * 3. Push and lock per-volume covers on matching Kavita volumes (if enabled + available)
 * 4. Record sync history + fire notifications
 */
export async function applyToKavita(
  client: KavitaClient,
  seriesId: number,
  meta: SeriesMetadata,
  opts: {
    /** Provider cover URL. Kavita is asked to fetch it server-side first; falls back to a local download + base64 apply. */
    coverUrl?: string;
    /** Pre-downloaded cover image. Optional; used as fallback and by callers that only have bytes. */
    cover?: Buffer | null;
    volumeCovers?: VolumeCover[];
    title: string;
    /** Fields the user deselected in the identify dialog (EXCLUDABLE_FIELDS keys). */
    excludedFields?: string[];
    /** CBZ chapters whose ComicInfo.Series the caller rewrote to the applied title. */
    titleFiles?: number;
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
  let currentMetadata: KavitaSeriesMetadataDto | undefined;
  if (payload.tags) {
    try {
      currentMetadata = await client.getSeriesMetadata(seriesId);
      payload.tags = mergeTagLists((currentMetadata.tags ?? []).map((t) => t.title).filter((t): t is string => Boolean(t)), payload.tags);
    } catch {
      /* series without a metadata row yet — push provider tags as-is */
    }
  }
  const fields = Object.keys(payload).filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
  if (fields.length) {
    try {
      await client.updateSeriesMetadata(seriesId, payload, { metadata: currentMetadata });
      pushed.push(...fields);
    } catch (err) {
      errors.push(`metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Recent Kavita builds apply /Series/update renames (verified on 0.9.1), but
  // older ones silently ignore the name change — verify the write landed so
  // sync history never claims a rename that didn't happen.
  if (payload.name !== undefined) {
    try {
      const current = await client.getSeriesById(seriesId);
      if ((current.name ?? '').trim() !== String(payload.name).trim()) {
        const i = pushed.indexOf('name');
        if (i !== -1) pushed.splice(i, 1);
        warnings.push(
          `Kavita did not apply the series rename — it still shows "${current.name ?? '?'}"; retry the sync`,
        );
      }
    } catch (err) {
      const i = pushed.indexOf('name');
      if (i !== -1) pushed.splice(i, 1);
      warnings.push(`Could not verify the title in Kavita: ${err instanceof Error ? err.message : String(err)}. Check the series title before retrying.`);
    }
  }

  if (opts.coverUrl || (opts.cover && opts.cover.length > 0)) {
    try {
      if (opts.coverUrl) {
        await applyCover(
          client,
          opts.coverUrl,
          (url) => client.updateSeriesCoverFromUrl(seriesId, url, true),
          (image) => client.updateSeriesCover(seriesId, image, true),
          opts.cover,
        );
      } else {
        await client.updateSeriesCover(seriesId, opts.cover!, true);
      }
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

  const db = getDb();
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

/**
 * Download a cover from a provider URL, returning null on failure.
 */
async function fetchCover(client: KavitaClient, url?: string): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const buf = await client.downloadImage(url);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Push one cover image onto Kavita, preferring a Kavita-side fetch
 * (upload-by-url): Kavita downloads the image from its own network, which
 * works for provider CDNs that block H-Tosho's host. The fallback to a local
 * download + base64 apply must stay: some provider CDNs require a Referer
 * header Kavita cannot send, so only H-Tosho's own fetch can retrieve them.
 * `localImage` (an already-downloaded buffer) short-circuits that re-download.
 */
async function applyCover(
  client: KavitaClient,
  url: string,
  applyFromUrl: (url: string) => Promise<void>,
  applyBuffer: (image: Buffer) => Promise<void>,
  localImage?: Buffer | null,
): Promise<void> {
  try {
    await applyFromUrl(url);
    return;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const image = localImage && localImage.length > 0 ? localImage : await fetchCover(client, url);
    if (!image) {
      throw new Error(`cover fetch by Kavita failed (${reason}) and local download failed`);
    }
    await applyBuffer(image);
  }
}
/**
 * Download, push, and lock per-volume covers onto matching Kavita volumes.
 * Failures are reported per volume (never aborting the remaining ones); a
 * missing or unmatched volume simply goes without a cover.
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
  // Up to three covers in flight; each apply is up to two network ops and
  // failures are collected per volume without aborting the rest. mapLimit
  // keeps the final error list in volume order.
  const results = await mapLimit(matchVolumeCovers(volumes, covers), 3, async (assignment) => {
    try {
      await applyCover(
        client,
        assignment.url,
        (url) => client.updateVolumeCoverFromUrl(assignment.volumeId, url, true),
        (image) => client.updateVolumeCover(assignment.volumeId, image, true),
      );
      return null;
    } catch (err) {
      return `vol ${assignment.number}: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  const errors = results.filter((error): error is string => error !== null);
  return { updated: results.length - errors.length, errors };
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
      (v) => !used.has(v.id) && v.number !== undefined && Number.isFinite(v.number) && v.number === cover.number,
    );
    if (!vol) continue;
    used.add(vol.id);
    out.push({ volumeId: vol.id, number: cover.number, url: cover.url });
  }
  return out;
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
  const known = new Set(
    getDb()
      .select({ kavitaSeriesId: schema.seriesMatches.kavitaSeriesId })
      .from(schema.seriesMatches)
      .all()
      .map((r) => r.kavitaSeriesId),
  );
  const fresh = series.filter((s) => !seenIds.has(s.id) && !known.has(s.id));
  const seriesIds = fresh.map((s) => s.id);
  if (fresh.length > 0) jobQueue.enqueue('match-series', { libraryId, seriesIds, context: { libraryId, series: fresh.map(({ id, name }) => ({ id, name })) } });
  return seriesIds;
}

export interface ApplySeriesOptions {
  seriesId: number;
  providerId: string;
  providerSeriesId: string;
  /** ComicInfo.Series value chosen in the identify dialog; must be one of meta.titleOptions. */
  selectedTitle?: string;
  excludedFields?: string[];
  /** Push the series cover + volume covers (default true). */
  cover?: boolean;
  /** Match score from the dialog's candidate; kept on the match row. */
  score?: number | null;
  /** Job cancellation probe. */
  isCancelled?: () => boolean;
  /** Preserve the authoritative target before any title or file mutation. */
  onSeriesResolved?: (series: KavitaSeries) => void | Promise<void>;
}

export interface ApplySeriesResult {
  /** Name Kavita displays after this sync (notifications/history). */
  name: string;
  pushed: string[];
  errors: string[];
  warnings: string[];
  titleFilesUpdated: number;
  titleFilesVerified: number;
  coverUpdated: boolean;
  volumeCoversUpdated: number;
  meta: SeriesMetadata;
}

/**
 * Apply a user-selected candidate to one Kavita series — the full flow behind
 * the identify dialog's "Apply & Sync": fetch provider metadata, rewrite
 * ComicInfo.Series in every chapter when the title is selected (the files must
 * agree with the record or Kavita's next scan would split the folder), rename
 * the record through /Series/update, push the remaining metadata + covers,
 * and update the local match row. Runs as a background job:
 * the CBZ rewrites touch every chapter of the series, far longer than any HTTP
 * gateway tolerates on a held-open request (that is what used to surface as
 * "HTTP 504").
 */
export async function applySeriesMatch(client: KavitaClient, opts: ApplySeriesOptions): Promise<ApplySeriesResult> {
  const seriesId = opts.seriesId;
  if (opts.isCancelled?.()) throw new JobCancelled();
  const series = await client.getSeriesById(seriesId);
  await opts.onSeriesResolved?.(series);
  const { credentials } = getCredentialMap();
  const meta = await fetchProviderMetadata(opts.providerId, opts.providerSeriesId, credentials);
  const selectedTitle = opts.selectedTitle?.trim();
  if (selectedTitle) {
    const allowedTitles = meta.titleOptions ?? [meta.title];
    if (!allowedTitles.includes(selectedTitle)) throw new Error('selectedTitle is not provided by this metadata source');
    meta.title = selectedTitle;
  }
  let titleFilesUpdated = 0;
  let titleFilesVerified = 0;
  // A checked TITLE means "make the series title this". The two halves should
  // agree: rewrite ComicInfo.Series in every locally accessible chapter, then
  // rename the Kavita record. If Kavita's files are not mounted into H-Tosho,
  // skip only the rename rather than failing the entire metadata/cover match;
  // renaming Kavita alone would let its next scan split the series.
  const excludedFields = [...(opts.excludedFields ?? [])];
  const preflightWarnings: string[] = [];
  const newTitle = meta.title.trim();
  if (newTitle && !excludedFields.includes('title') && newTitle !== series.name.trim()) {
    const libraries = await client.getLibraries();
    const library = libraries.find((entry) => entry.id === series.libraryId);
    const dl = getDownloaderSettings();
    const dir = resolveSeriesHostDir({
      libraryPath: library?.path,
      folderPath: series.folderPath,
      anchors: dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : [],
      mappings: dl.libraryPathMappings,
    });
    const files = dir ? listCbzFiles(dir) : [];
    if (!dir || files.length === 0) {
      excludedFields.push('title');
      preflightWarnings.push(
        `Title was not changed because H-Tosho cannot access this series' CBZ files. Kavita folder: ${series.folderPath ?? '(not reported)'}. H-Tosho download directory: ${dl.downloadDirectory || '(not configured)'}. Mount the series' library folder into H-Tosho (or configure the shared download directory), then retry Apply & Sync. Other selected metadata and covers were still synced.`,
      );
    } else {
      const rewrite = await setSeriesTitleInCbzFiles(files, newTitle);
      titleFilesUpdated = rewrite.changed;
      titleFilesVerified = rewrite.verified;
    }
  }
  // Per-dialog overrides: deselected fields are skipped, and unchecking Cover
  // skips the series cover + volume covers. A title is also skipped when its
  // CBZ files are inaccessible, preventing Kavita's next scan from splitting
  // the series while still allowing the match and all other fields to apply.
  const pushCovers = opts.cover !== false;
  const result = await applyToKavita(client, seriesId, meta, {
    coverUrl: pushCovers ? meta.coverUrl : undefined,
    volumeCovers: pushCovers ? meta.volumeCovers : undefined,
    excludedFields,
    title: meta.title,
    titleFiles: titleFilesUpdated || undefined,
  });
  result.warnings.unshift(...preflightWarnings);
  // History/notifications show the name Kavita displays after this sync.
  const renamed = !excludedFields.includes('title') && newTitle !== series.name.trim() && result.pushed.includes('name');
  invalidateSeriesArtists(seriesId);
  const db = getDb();
  // The dialog sends the applied candidate's current score; keep the stored
  // value when absent (older clients).
  const existingRow = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
  const sentScore = typeof opts.score === 'number' && Number.isFinite(opts.score) ? Math.min(1, Math.max(0, opts.score)) : undefined;
  const matchScore = sentScore ?? existingRow?.matchScore ?? null;
  const sameCandidate = existingRow?.providerId === opts.providerId && existingRow?.providerSeriesId === opts.providerSeriesId;
  const confirmed = result.errors.length === 0 || (sameCandidate && existingRow?.confirmed === true);
  db.insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: seriesId,
      status: result.errors.length ? 'failed' : 'matched',
      providerId: opts.providerId,
      providerSeriesId: opts.providerSeriesId,
      matchScore,
      confirmed,
      metadataJson: JSON.stringify(meta),
      errorMessage: result.errors.length ? result.errors.join('; ') : null,
      lastSyncedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.seriesMatches.kavitaSeriesId,
      set: {
        status: result.errors.length ? 'failed' : 'matched',
        providerId: opts.providerId,
        providerSeriesId: opts.providerSeriesId,
        matchScore,
        confirmed,
        metadataJson: JSON.stringify(meta),
        errorMessage: result.errors.length ? result.errors.join('; ') : null,
        lastSyncedAt: new Date().toISOString(),
      },
    })
    .run();
  return {
    name: renamed ? newTitle : series.name,
    pushed: result.pushed,
    errors: result.errors,
    warnings: result.warnings,
    titleFilesUpdated,
    titleFilesVerified,
    coverUpdated: result.coverUpdated,
    volumeCoversUpdated: result.volumeCoversUpdated,
    meta,
  };
}
