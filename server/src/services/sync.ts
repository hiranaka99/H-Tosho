import { eq } from 'drizzle-orm';
import path from 'node:path';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  KavitaPublicationStatus,
  type SeriesMetadataPayload,
} from '../kavita/types.js';
import type { SeriesMetadata, VolumeCover } from '../providers/types.js';
import type { KavitaVolume, KavitaSeriesMetadataDto } from '../kavita/types.js';
import { fetchProviderMetadata } from '../match/autoMatcher.js';
import { listCbzFiles, resolveSeriesHostDir, setSeriesTitleInCbzFiles } from '../lib/cbz.js';
import { sleep } from '../lib/http.js';
import { invalidateSeriesArtists } from './seriesArtists.js';
import { getKavitaConnection, getNotificationSettings, getCredentialMap, getDownloaderSettings } from './settings.js';
import { notify, formatPushedFields, providerName } from '../notify/dispatcher.js';
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
/**
 * Alignment check: a matched series is "aligned" when every metadata field
 * its provider supplies matches Kavita's current values. List fields compare
 * order-insensitively and ignore punctuation placement ("Girl's Love" vs
 * "Girls' Love"); tags use subset semantics because sync merges instead of
 * replacing; fields the provider does not supply are skipped.
 */
export function checkAlignment(
  kavita: { name: string; metadata: KavitaSeriesMetadataDto | null },
  meta: SeriesMetadata,
): { aligned: boolean; mismatched: string[] } {
  const k = kavita.metadata;
  const mismatched: string[] = [];
  const norm = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  // List items are compared after stripping non-alphanumerics, so apostrophe
  // placement and punctuation variants do not count as drift.
  const listKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const sameSet = (a: Array<string | null>, b: string[]) => {
    const sa = new Set(a.map((x) => listKey(x ?? '')).filter(Boolean));
    const sb = b.map(listKey).filter(Boolean);
    return sa.size === sb.length && sb.every((x) => sa.has(x));
  };

  if (meta.title && norm(kavita.name) !== norm(meta.title)) mismatched.push('title');
  if (meta.summary !== undefined && norm(k?.summary) !== norm(meta.summary)) mismatched.push('summary');
  if (meta.genres.length && !sameSet((k?.genres ?? []).map((g) => g.title), meta.genres)) mismatched.push('genres');
  if (meta.tags.length) {
    const have = new Set((k?.tags ?? []).map((t) => listKey(t.title ?? '')).filter(Boolean));
    if (!meta.tags.every((t) => have.has(listKey(t)))) mismatched.push('tags');
  }
  if (meta.writers.length && !sameSet((k?.writers ?? []).map((p) => p.name), meta.writers)) mismatched.push('writers');
  // H-Tosho writes provider artists into Kavita's penciller role.
  if (meta.artists.length && !sameSet((k?.pencillers ?? []).map((p) => p.name), meta.artists)) mismatched.push('artists');
  const year = releaseYear(meta);
  if (year !== undefined && (k?.releaseYear ?? 0) !== year) mismatched.push('releaseDate');
  if (meta.language && norm(k?.language) !== norm(meta.language)) mismatched.push('language');
  if (meta.status) {
    const status = PUBLICATION_STATUS[meta.status];
    if (status !== undefined && (k?.publicationStatus ?? -1) !== status) mismatched.push('status');
  }
  if (meta.url && norm(k?.webLinks) !== norm(meta.url)) mismatched.push('url');

  return { aligned: mismatched.length === 0, mismatched };
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
      detailsJson: JSON.stringify({ provider: meta.providerId, pushed, coverUpdated, volumeCoversUpdated, ...(opts.titleFiles ? { titleFiles: opts.titleFiles } : {}), errors, warnings }),
    })
    .run();

  // Notifications (fire-and-forget)
  const notif = getNotificationSettings();
  if (notif.discord.enabled) {
    const name = providerName(meta.providerId);
    notify({
      title: errors.length ? `Sync failed — ${opts.title}` : opts.title,
      description: meta.url ? `Metadata synced to Kavita from [${name}](${meta.url})` : `Metadata synced to Kavita from ${name}`,
      fields: [
        ...(pushed.length ? [{ name: 'Updated', value: formatPushedFields(pushed) }] : []),
        ...(warnings.length ? [{ name: 'Notes', value: warnings.join('\n') }] : []),
        ...(errors.length ? [{ name: 'Errors', value: errors.join('\n') }] : []),
      ],
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

const RENAME_SCAN_TIMEOUT_MS = 5 * 60_000;
const RENAME_SCAN_POLL_MS = 5_000;

/**
 * Wait for Kavita to register a renamed series after ComicInfo.Series was
 * rewritten in the files. Changing the Series value does not rename the
 * existing record: on its next scan Kavita creates a NEW entry in the same
 * folder and detaches the books from the old one, so the caller must find that
 * new entry before pushing the remaining metadata onto it.
 *
 * Fires a library scan (the only pass Kavita is guaranteed to run that
 * re-groups the folder by ComicInfo.Series), then polls the series list until
 * an entry with a previously unseen id appears in the same folder. When the
 * budget runs out, falls back to the original id if Kavita renamed the record
 * in place; otherwise returns null so the caller can apply to the old entry
 * and report that a manual scan is needed.
 */
async function waitForRenamedSeriesEntry(
  client: KavitaClient,
  libraryId: number,
  folderPath: string | undefined,
  oldSeriesId: number,
  expectedTitle: string,
  isCancelled?: () => boolean,
): Promise<{ id: number; name: string; isNew: boolean } | null> {
  const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/');
  const target = folderPath ? norm(folderPath) : '';
  const inFolder = (s: { id: number; folderPath?: string }) => s.id !== oldSeriesId && (!target || (s.folderPath !== undefined && norm(s.folderPath) === target));
  const wantTitle = expectedTitle.trim().toLowerCase();

  // Snapshot the folder's pre-scan entries so an existing sibling series cannot
  // be mistaken for the rename.
  let known: Set<number> | null = null;
  const deadline = Date.now() + RENAME_SCAN_TIMEOUT_MS;
  while (known === null) {
    if (isCancelled?.()) throw new JobCancelled();
    try {
      known = new Set((await client.getSeries(libraryId)).filter(inFolder).map((s) => s.id));
    } catch {
      if (Date.now() >= deadline) return null;
      await sleep(RENAME_SCAN_POLL_MS);
    }
  }

  try {
    await client.scanLibrary(libraryId);
  } catch {
    /* scan request failed — the poll below times out and the caller falls back */
  }

  let failures = 0;
  for (;;) {
    if (isCancelled?.()) throw new JobCancelled();
    let series: Array<{ id: number; name?: string | null; folderPath?: string }> | null = null;
    try {
      series = await client.getSeries(libraryId);
      failures = 0;
    } catch {
      failures += 1;
    }
    if (series) {
      const candidates = series.filter((s) => inFolder(s) && !known.has(s.id));
      // Prefer the entry Kavita named after the new Series value. The single-
      // candidate fallback is only safe when the folder is known, so an unknown
      // folderPath never adopts an unrelated new series.
      const pick =
        candidates.find((s) => (s.name ?? '').trim().toLowerCase() === wantTitle) ??
        (target && candidates.length === 1 ? candidates[0] : undefined);
      if (pick) return { id: pick.id, name: pick.name ?? expectedTitle, isNew: true };
    } else if (failures >= 3 || Date.now() >= deadline) {
      break; // Kavita unreachable — stop polling and fall back below
    }
    if (Date.now() >= deadline) break;
    await sleep(RENAME_SCAN_POLL_MS);
  }

  // No new sibling appeared. Kavita may have renamed the record in place
  // instead of splitting it — then the original id is still the right target.
  try {
    const current = await client.getSeriesById(oldSeriesId);
    if ((current.name ?? '').trim().toLowerCase() === wantTitle) return { id: oldSeriesId, name: current.name, isNew: false };
  } catch {
    /* record gone — nothing left to target */
  }
  return null;
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
  /** Job cancellation probe — checked while waiting for Kavita's scan. */
  isCancelled?: () => boolean;
}

export interface ApplySeriesResult {
  /** The entry Kavita now uses for this folder (a new id when a rename split it). */
  effectiveSeriesId: number;
  /** Name of the effective entry (notifications/history). */
  name: string;
  pushed: string[];
  errors: string[];
  warnings: string[];
  titleFilesUpdated: number;
  titleFilesVerified: number;
  coverUpdated: boolean;
  volumeCoversUpdated: number;
  aligned: boolean;
  meta: SeriesMetadata;
}

/**
 * Apply a user-selected candidate to one Kavita series — the full flow behind
 * the identify dialog's "Apply & Sync": fetch provider metadata, optionally
 * rewrite ComicInfo.Series in every chapter and wait for Kavita to register
 * the rename as a new entry, push the remaining metadata + covers, verify
 * alignment, and update the local match row. Runs as a background job: the
 * scan wait can take minutes, far longer than any HTTP gateway tolerates on a
 * held-open request (that is what used to surface as "HTTP 504").
 */
export async function applySeriesMatch(client: KavitaClient, opts: ApplySeriesOptions): Promise<ApplySeriesResult> {
  const seriesId = opts.seriesId;
  if (opts.isCancelled?.()) throw new JobCancelled();
  const series = await client.getSeriesById(seriesId);
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
  // A checked TITLE means "make the series title this". Kavita derives the
  // display name from ComicInfo.Series, and a changed Series value makes its
  // next scan register the files as a NEW series entry — it does not rename
  // the existing record. The order is therefore fixed:
  //   1. rewrite ComicInfo.Series in every chapter of the series,
  //   2. scan the library and wait until the new entry appears,
  //   3. push the remaining metadata onto that new entry (the title itself
  //      never goes through the API).
  let effectiveSeriesId = seriesId;
  let effectiveName = series.name;
  const renameNotes: string[] = [];
  const excludedFields = [...(opts.excludedFields ?? [])];
  const newTitle = meta.title.trim();
  if (newTitle && !excludedFields.includes('title') && newTitle !== series.name.trim()) {
    const libraries = await client.getLibraries();
    const library = libraries.find((entry) => entry.id === series.libraryId);
    const dl = getDownloaderSettings();
    const dir = resolveSeriesHostDir({
      libraryPath: library?.path,
      folderPath: series.folderPath,
      anchors: dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : [],
    });
    if (!dir) throw new Error(`Could not locate the series folder for "${series.name}" on this machine`);
    const files = listCbzFiles(dir);
    if (files.length === 0) throw new Error(`No CBZ chapters found for "${series.name}"`);
    // Step 1: every chapter carries the new Series value before Kavita scans.
    const rewrite = await setSeriesTitleInCbzFiles(files, newTitle);
    titleFilesUpdated = rewrite.changed;
    titleFilesVerified = rewrite.verified;
    excludedFields.push('title');
    // Step 2: scan the library and wait for Kavita to register the renamed
    // files as a new entry in the same folder.
    const fresh = await waitForRenamedSeriesEntry(client, series.libraryId, series.folderPath, seriesId, newTitle, opts.isCancelled);
    if (fresh?.isNew) {
      effectiveSeriesId = fresh.id;
      effectiveName = fresh.name;
      renameNotes.push(`Kavita registered the rename as a new series entry — metadata is applied to it`);
      // The old record lost its books on the scan — remove it so the library
      // keeps one entry for this folder. Guarded: only while it still exists
      // and holds no books.
      try {
        const chapters = await client.getChaptersBySeries(seriesId);
        if (chapters.length === 0) await client.deleteSeries(seriesId);
      } catch {
        /* best-effort — a stale record would linger until the next full scan */
      }
    } else if (!fresh) {
      renameNotes.push('Kavita has not registered the renamed series yet — metadata was applied to the previous entry; run a library scan in Kavita and re-sync');
    }
  }
  // Per-dialog overrides: deselected fields are skipped, and unchecking Cover
  // skips the series cover + volume covers.
  const pushCovers = opts.cover !== false;
  const cover = pushCovers ? await fetchCover(client, meta.coverUrl) : null;
  // Step 3: the remaining metadata lands on the entry Kavita now uses for
  // this folder — the new one when the rename split it.
  const result = await applyToKavita(client, effectiveSeriesId, meta, {
    cover,
    volumeCovers: pushCovers ? meta.volumeCovers : undefined,
    excludedFields,
    title: meta.title,
    titleFiles: titleFilesUpdated || undefined,
  });
  if (renameNotes.length) result.warnings.push(...renameNotes);
  invalidateSeriesArtists(effectiveSeriesId);
  if (effectiveSeriesId !== seriesId) invalidateSeriesArtists(seriesId);
  // Verify the push against Kavita's live state and record whether every
  // provider-managed field now matches (the "Aligned" flag).
  let aligned = false;
  try {
    const full = await client.getSeriesById(effectiveSeriesId);
    const kavitaMeta = await client.getSeriesMetadata(effectiveSeriesId);
    aligned = checkAlignment({ name: full.name, metadata: kavitaMeta }, meta).aligned;
  } catch {
    /* series without a metadata row yet — stays unaligned */
  }
  const db = getDb();
  // The dialog sends the applied candidate's current score; keep the stored
  // value when absent (older clients).
  const existingRow = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
  const sentScore = typeof opts.score === 'number' && Number.isFinite(opts.score) ? Math.min(1, Math.max(0, opts.score)) : undefined;
  const matchScore = sentScore ?? existingRow?.matchScore ?? null;
  db.insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: effectiveSeriesId,
      status: result.errors.length ? 'failed' : 'matched',
      providerId: opts.providerId,
      providerSeriesId: opts.providerSeriesId,
      matchScore,
      aligned,
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
        aligned,
        metadataJson: JSON.stringify(meta),
        errorMessage: result.errors.length ? result.errors.join('; ') : null,
        lastSyncedAt: new Date().toISOString(),
      },
    })
    .run();
  // The rename moved this series to a new Kavita id — drop the match row that
  // still points at the old record so it cannot resurface as stale.
  if (effectiveSeriesId !== seriesId) {
    db.delete(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).run();
  }
  return {
    effectiveSeriesId,
    name: effectiveName,
    pushed: result.pushed,
    errors: result.errors,
    warnings: result.warnings,
    titleFilesUpdated,
    titleFilesVerified,
    coverUpdated: result.coverUpdated,
    volumeCoversUpdated: result.volumeCoversUpdated,
    aligned,
    meta,
  };
}