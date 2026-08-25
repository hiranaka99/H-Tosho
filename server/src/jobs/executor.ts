import { eq, inArray } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  getCredentialMap,
  getDownloaderSettings,
  getKavitaConnection,
  getLibraryOverride,
  getProviderPriorities,
  providerOrderFor,
} from '../services/settings.js';
import { autoMatch, fetchProviderMetadata, type CandidateMatch } from '../match/autoMatcher.js';
import { catalogCandidates, catalogNeedsRefresh, isMatureAgeRating, refreshCatalog } from '../match/mangadexCatalog.js';
import { applyToKavita, checkAlignment, fetchCover } from '../services/sync.js';
import { checkWatchedSearches } from '../services/watchedSearches.js';
import { notify } from '../notify/dispatcher.js';
import { jobQueue, JobCancelled, type Job, type LogFn } from './queue.js';
import { listCbzFiles, mergeCbzFiles, readComicInfo, resolveExistingFile, resolveSeriesHostDir, rewriteZipEntry } from '../lib/cbz.js';
import { parseComicInfo, renderComicInfoXml } from '../downloader/comicinfo.js';

interface Target {
  id: number;
  name: string;
  libraryId?: number;
  /** Series is flagged mature in Kavita (eligible for fuzzy adult-catalog matching). */
  mature?: boolean;
}

interface MatchResult {
  seriesId: number;
  title: string;
  matched: boolean;
  errors: string[];
  coverUrl?: string;
}


function upsertMatch(r: {
  kavitaSeriesId: number;
  status: string;
  providerId: string | null;
  providerSeriesId: string | null;
  matchScore: number | null;
  metadataJson: string | null;
  errorMessage: string | null;
  aligned?: boolean;
}): void {
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: r.kavitaSeriesId,
      status: r.status,
      providerId: r.providerId,
      providerSeriesId: r.providerSeriesId,
      matchScore: r.matchScore,
      metadataJson: r.metadataJson,
      errorMessage: r.errorMessage,
      aligned: r.aligned ?? false,
      lastSyncedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.seriesMatches.kavitaSeriesId,
      set: {
        status: r.status,
        providerId: r.providerId,
        providerSeriesId: r.providerSeriesId,
        matchScore: r.matchScore,
        metadataJson: r.metadataJson,
        errorMessage: r.errorMessage,
        aligned: r.aligned ?? false,
        lastSyncedAt: new Date().toISOString(),
      },
    })
    .run();
}

function recordHistory(seriesId: number, title: string | null, action: string, details: unknown): void {
  getDb()
    .insert(schema.syncHistory)
    .values({ kavitaSeriesId: seriesId, seriesTitle: title, action, detailsJson: JSON.stringify(details) })
    .run();
}

async function matchAndApply(
  client: KavitaClient,
  series: { id: number; name: string; mature?: boolean },
  libraryId: number | undefined,
  force: boolean,
  log?: LogFn,
): Promise<MatchResult> {
  const base: MatchResult = { seriesId: series.id, title: series.name, matched: false, errors: [] };
  const { credentials, enabledProviders } = getCredentialMap();
  const order = providerOrderFor(libraryId, enabledProviders);

  if (order.length === 0) {
    base.errors.push('No providers enabled/configured');
    upsertMatch({
      kavitaSeriesId: series.id,
      status: 'unmatched',
      providerId: null,
      providerSeriesId: null,
      matchScore: null,
      metadataJson: null,
      errorMessage: base.errors.join('; '),
    });
    return base;
  }

  // The local MangaDex adult catalog covers chapterless titles that are
  // invisible to live title search. Unflagged series only get exact-title
  // catalog candidates (see catalogCandidates).
  const extraCandidates = order.includes('mangadex') ? catalogCandidates(series.name, !!series.mature) : [];
  const outcome = await autoMatch(series, { providerOrder: order, credentials, enabledProviders, extraCandidates });
  log?.('info', `${series.name}: ${outcome.candidates.length} candidate(s) across [${outcome.searchedProviders.join(', ')}]${extraCandidates.length ? ` +${extraCandidates.length} catalog` : ''}`);

  const best: CandidateMatch | null = outcome.best;
  if (!outcome.matched || !best) {
    base.errors.push('No confident match found');
    upsertMatch({
      kavitaSeriesId: series.id,
      status: 'unmatched',
      providerId: null,
      providerSeriesId: null,
      matchScore: best ? best.score : null,
      metadataJson: null,
      errorMessage: null,
    });
    return base;
  }

  base.matched = true;
  try {
    const meta = await fetchProviderMetadata(best.providerId, best.providerSeriesId, credentials);
    const cover = await fetchCover(client, meta.coverUrl);
    const result = await applyToKavita(client, series.id, meta, {
      cover,
      volumeCovers: meta.volumeCovers,
      title: series.name,
    });
    // Verify the push against Kavita's live state and record whether every
    // provider-managed field now matches (the "Aligned" flag).
    let aligned = false;
    try {
      const full = await client.getSeriesById(series.id);
      const kavitaMeta = await client.getSeriesMetadata(series.id);
      aligned = checkAlignment({ name: full.name, sortName: full.sortName, metadata: kavitaMeta }, meta).aligned;
    } catch {
      /* series without a metadata row yet — stays unaligned */
    }

    const status = result.errors.length ? 'failed' : 'matched';
    upsertMatch({
      kavitaSeriesId: series.id,
      status,
      providerId: best.providerId,
      providerSeriesId: best.providerSeriesId,
      matchScore: best.score,
      metadataJson: JSON.stringify(meta),
      errorMessage: result.errors.length ? result.errors.join('; ') : null,
      aligned,
    });
    recordHistory(series.id, series.name, result.errors.length ? 'failed' : force ? 'updated' : 'matched', {
      providerId: best.providerId,
      score: best.score,
      pushed: result.pushed,
      coverUpdated: result.coverUpdated,
      volumeCoversUpdated: result.volumeCoversUpdated,
      errors: result.errors,
    });
    base.errors = result.errors;
    base.coverUrl = meta.coverUrl ?? best.coverUrl;

    // Notification failures must not flip an already-applied match to failed —
    // the metadata push succeeded by the time we get here.
    try {
      await notify({
        title: `${force ? 'Updated' : 'Matched'}: ${series.name}`,
        body: `Matched to ${best.providerId} (${Math.round(best.score * 100)}%). Pushed: ${
          result.pushed.length ? result.pushed.join(', ') : 'none'
        }${result.errors.length ? ' — errors: ' + result.errors.join('; ') : ''}`,
        coverUrl: meta.coverUrl ?? best.coverUrl,
        success: result.errors.length === 0,
      });
    } catch (e) {
      log?.('warn', `Notification failed for ${series.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    log?.(result.errors.length ? 'warn' : 'success', `${series.name} -> ${best.providerId} (${Math.round(best.score * 100)}%)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    base.errors.push(msg);
    upsertMatch({
      kavitaSeriesId: series.id,
      status: 'failed',
      providerId: best.providerId,
      providerSeriesId: best.providerSeriesId,
      matchScore: best.score,
      metadataJson: null,
      errorMessage: msg,
    });
    log?.('error', `${series.name}: ${msg}`);
  }
  return base;
}

function connectedClientOrNull(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}

/** Last path segment, tolerant of both separator styles (works cross-platform). */
function lastSegment(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? '';
}

/** Best-effort Kavita refresh after a local ComicInfo edit. */
async function rescanLibraryContainingDir(dir: string, log: LogFn, seriesName?: string): Promise<void> {
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return;
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/');
    const libraries = await client.getLibraries();
    const candidates = new Set<string>();
    let d = dir;
    for (let i = 0; i < 3; i++) {
      const seg = lastSegment(d);
      if (!seg) break;
      candidates.add(seg.toLowerCase());
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }

    for (const lib of libraries) {
      const directLibrary = Boolean(lib.path && norm(dir).startsWith(norm(lib.path)));
      const libRootName = lib.path ? lastSegment(lib.path).toLowerCase() : '';
      const matchingLibrary = directLibrary || Boolean(libRootName && candidates.has(libRootName));
      let series;
      try {
        series = await client.getSeries(lib.id);
      } catch {
        continue;
      }
      const hit = series.find((s) => s.folderPath && candidates.has(lastSegment(s.folderPath).toLowerCase()));
      if (hit) {
        if (seriesName) {
          await client.updateSeriesMetadata(hit.id, { name: seriesName });
          log('info', `Updated Kavita series name to "${seriesName}"`);
        }
        await client.scanSeries(lib.id, hit.id);
        log('info', `Requested Kavita rescan of series "${seriesName || hit.name}"`);
        return;
      }
      if (matchingLibrary) {
        await client.scanLibrary(lib.id);
        log('info', `Requested Kavita rescan of "${lib.name}"`);
        return;
      }
    }
    log('warn', 'No Kavita library contains this folder — rescan skipped, the periodic scan will pick it up');
  } catch (e) {
    log('warn', `Kavita rescan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * After a merge, delete the Kavita series that belonged to the pre-merge source folders.
 * Kavita's scan reattaches moved files to their original series records instead of
 * consolidating them into the target folder's series, so without this step one stale
 * series would linger per source folder. The target folder itself is exempt — its
 * series becomes the merged series. Best-effort: a dead/unconfigured Kavita just means
 * the stale series stays until it is removed manually.
 */
async function removeSourceSeriesFromKavita(sourceFiles: string[], targetDir: string, log: LogFn): Promise<void> {
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return;
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    // Distinct source folders that are neither the merge target nor an ancestor of it.
    const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/');
    const target = norm(targetDir);
    const sourceDirs = new Set<string>();
    for (const f of sourceFiles) {
      const d = norm(path.dirname(f));
      if (d === target || target.startsWith(d + '/')) continue;
      sourceDirs.add(d);
    }
    if (sourceDirs.size === 0) return;
    const names = new Set([...sourceDirs].map((d) => lastSegment(d).toLowerCase()));
    const libraries = await client.getLibraries();
    const deleted: number[] = [];
    for (const lib of libraries) {
      let series;
      try {
        series = await client.getSeries(lib.id);
      } catch {
        continue; // one unreachable library must not block the rest
      }
      for (const s of series) {
        if (!s.folderPath || !names.has(lastSegment(s.folderPath).toLowerCase())) continue;
        try {
          await client.deleteSeries(s.id);
          deleted.push(s.id);
          log('info', `Removed stale Kavita series "${s.name}" (id ${s.id}) — its files now live in the merged folder`);
        } catch (e) {
          log('warn', `Could not delete Kavita series ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (deleted.length > 0) {
      getDb().delete(schema.seriesMatches).where(inArray(schema.seriesMatches.kavitaSeriesId, deleted)).run();
    }
  } catch (e) {
    log('warn', `Kavita series cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The ComicInfo.Series value Kavita uses to group a series' files. When the
 * series' existing archives all agree on one value, new files must carry the
 * same value or Kavita splits the folder into separate series; otherwise fall
 * back to null so the caller can use the series name. Files being merged are
 * excluded — their current values are what we are about to overwrite.
 */
async function pickSeriesStampName(dir: string, exclude: Set<string>): Promise<string | null> {
  let files: string[];
  try {
    files = listCbzFiles(dir);
  } catch {
    return null;
  }
  const values = new Set<string>();
  for (const f of files) {
    if (exclude.has(path.resolve(f))) continue;
    try {
      const xml = await readComicInfo(f);
      const v = xml ? parseComicInfo(xml).fields.Series?.trim() : '';
      if (v) values.add(v);
    } catch {
      /* unreadable archive — ignore */
    }
  }
  return values.size === 1 ? [...values][0] : null;
}

/** Run a queued job. Returns a small summary stored on the job row. */
export async function runJob(job: Job, log: LogFn): Promise<Record<string, number>> {
  // The MangaDex catalog refresh talks to MangaDex only — no Kavita needed.
  if (job.type === 'mangadex-catalog') {
    const r = await refreshCatalog({
      log,
      onProgress: (current, total) => jobQueue.setProgress(job.id, current, total),
      isCancelled: () => jobQueue.isCancelRequested(job.id),
    });
    return { processed: 0, matched: 0, failed: 0, added: r.added, updated: r.updated, indexed: r.total };
  }

  // Watched-search checks talk to doujin sources only — no Kavita needed.
  if (job.type === 'check-watched-searches') {
    const r = await checkWatchedSearches(
      log,
      () => jobQueue.isCancelRequested(job.id),
      (current, total) => jobQueue.setProgress(job.id, current, total),
    );
    return { processed: r.checked, matched: 0, failed: 0, notified: r.notified, newGalleries: r.newGalleries };
  }

  // ComicInfo edits rewrite a local archive — no Kavita connection needed for
  // the write itself; the rescan below is best-effort.
  if (job.type === 'edit-comicinfo') {
    const p = job.payload.path;
    if (!p) throw new Error('path required');
    const file = resolveExistingFile(p);
    if (!file) throw new Error(`File not found: ${p}`);
    const existing = await readComicInfo(file);
    let xml: string;
    if (typeof job.payload.xml === 'string' && job.payload.xml.trim()) {
      // Raw-XML mode — the client rendered the document, use it verbatim.
      xml = job.payload.xml;
    } else {
      const doc = existing ? parseComicInfo(existing) : { order: [], fields: {}, rawInner: {} };
      const edited = Object.keys(job.payload.fields ?? {});
      xml = renderComicInfoXml({
        values: { ...doc.fields, ...(job.payload.fields ?? {}) },
        order: doc.order,
        rawInner: doc.rawInner,
        edited,
      });
    }
    await rewriteZipEntry(file, 'ComicInfo.xml', Buffer.from(xml, 'utf8'));
    log('info', `Wrote ComicInfo.xml into ${file}`);
    const editedSeriesName = parseComicInfo(xml).fields.Series?.trim();
    if (job.payload.seriesId !== undefined) {
      const client = connectedClientOrNull();
      if (client) {
        const series = await client.getSeriesById(job.payload.seriesId);
        if (editedSeriesName) {
          await client.updateSeriesMetadata(series.id, { name: editedSeriesName });
          log('info', `Updated Kavita series name to "${editedSeriesName}"`);
        }
        await client.scanSeries(series.libraryId, series.id);
        log('info', `Requested Kavita rescan of series "${editedSeriesName || series.name}"`);
      }
    } else {
      await rescanLibraryContainingDir(path.dirname(file), log, editedSeriesName);
    }
    return { processed: 1, matched: 0, failed: 0 };
  }

  // Series merge moves local archives into one folder, stamps the shared series
  // name + chapter numbers, and deletes the stale source-folder Kavita series —
  // Kavita's scan reattaches moved files to their original series records instead
  // of consolidating, and differing ComicInfo.Series values split a folder into
  // multiple series. The rescan below then folds everything into one series.
  // The target is either an explicit folder (targetDir) or an existing Kavita
  // series ("library item", seriesId) whose folder the files are moved into.
  if (job.type === 'merge-series') {
    const sourceFiles = job.payload.sourceFiles ?? [];
    if (sourceFiles.length < 1) throw new Error('At least one .cbz file is required');
    let targetDir = job.payload.targetDir;
    let stampName: string | undefined;
    if (job.payload.seriesId != null) {
      const client = connectedClientOrNull();
      if (!client) throw new Error('Kavita is not configured');
      let s: { id: number; name: string; libraryId: number; folderPath?: string };
      try {
        s = await client.getSeriesById(job.payload.seriesId);
      } catch {
        throw new Error(`Kavita series ${job.payload.seriesId} not found`);
      }
      const libraries = await client.getLibraries();
      const lib = libraries.find((l) => l.id === s.libraryId);
      const dl = getDownloaderSettings();
      const dir = resolveSeriesHostDir({
        libraryPath: lib?.path ?? null,
        folderPath: s.folderPath ?? null,
        anchors: dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : [],
      });
      if (!dir || !fs.existsSync(dir)) {
        throw new Error(`Could not locate the series folder for "${s.name}" on this machine`);
      }
      targetDir = dir;
      // Match the Series value the existing files carry so Kavita groups the
      // merged files with them; fall back to the series name when unknown.
      stampName = (await pickSeriesStampName(dir, new Set(sourceFiles.map((f) => path.resolve(f))))) ?? s.name;
    }
    if (!targetDir) throw new Error('targetDir required');
    log('info', `Merging ${sourceFiles.length} file(s) into ${targetDir}`);
    const r = await mergeCbzFiles(sourceFiles, targetDir, job.payload.chapters, stampName ?? lastSegment(targetDir));
    for (const f of r.failed) log('warn', `Skipped ${f.file}: ${f.error}`);
    if (r.moved.length === 0) throw new Error('No files could be moved — check the source paths');
    log('success', `Moved ${r.moved.length} file(s) into one folder as "${stampName ?? lastSegment(targetDir)}"; stamped chapter numbers on ${r.chaptered.length}`);
    await removeSourceSeriesFromKavita(sourceFiles, targetDir, log);
    await rescanLibraryContainingDir(targetDir, log);
    return { processed: r.moved.length, matched: 0, failed: r.failed.length };
  }

  const client = connectedClientOrNull();
  if (!client) throw new Error('Kavita is not configured');

  const summary: Record<string, number> = { processed: 0, matched: 0, failed: 0 };
  const targets: Target[] = [];

  const byId = async (id: number): Promise<Target> => {
    const s = (await client.getSeriesById(id)) as { id: number; name: string; libraryId: number };
    return { id: s.id, name: s.name, libraryId: s.libraryId };
  };

  switch (job.type) {
    case 'scan-new': {
      const allLibs = await client.getLibraries();
      // An explicit libraryId (from the Libraries page) scopes the scan to one
      // library; the scheduled auto-scan enqueues without a payload and stays global.
      const libs = job.payload.libraryId !== undefined ? allLibs.filter((l) => l.id === job.payload.libraryId) : allLibs;
      summary.libraries = libs.length;
      const known = new Set(getDb().select().from(schema.seriesMatches).all().map((r) => r.kavitaSeriesId));
      for (const lib of libs) {
        // Libraries with auto-matching disabled are skipped by the scan; their
        // series can still be matched manually via match-library / match-series.
        if (getLibraryOverride(lib.id)?.autoMatch === false) continue;
        if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        for (const s of series) if (!known.has(s.id)) targets.push({ id: s.id, name: s.name, libraryId: lib.id });
      }
      break;
    }
    case 'match-unmatched': {
      const allLibs = await client.getLibraries();
      // Same scoping as scan-new: explicit libraryId targets one library.
      const libs = job.payload.libraryId !== undefined ? allLibs.filter((l) => l.id === job.payload.libraryId) : allLibs;
      const rows = getDb().select().from(schema.seriesMatches).all();
      const statusBySeries = new Map(rows.map((r) => [r.kavitaSeriesId, r.status]));
      for (const lib of libs) {
        if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        for (const s of series) {
          // O(1) lookup instead of a per-series rows.find scan.
          if (statusBySeries.get(s.id) !== 'matched') targets.push({ id: s.id, name: s.name, libraryId: lib.id });
        }
      }
      break;
    }
    case 'match-library': {
      const libraryId = job.payload.libraryId;
      if (libraryId === undefined) throw new Error('libraryId required');
      const series = (await client.getSeries(libraryId)) as { id: number; name: string }[];
      for (const s of series) targets.push({ id: s.id, name: s.name, libraryId });
      break;
    }
    case 'match-series': {
      const ids =
        job.payload.seriesIds?.length ? job.payload.seriesIds : job.payload.seriesId !== undefined ? [job.payload.seriesId] : [];
      if (!ids.length) throw new Error('seriesId or seriesIds required');
      targets.push(...(await Promise.all(ids.map((id) => byId(id)))));
      break;
    }
    case 'sync-series': {
      const ids = job.payload.seriesIds?.length ? job.payload.seriesIds : [];
      if (ids.length) {
        targets.push(...(await Promise.all(ids.map((id) => byId(id)))));
      } else {
        const libraryId = job.payload.libraryId;
        if (libraryId === undefined) throw new Error('seriesIds or libraryId required');
        const rows = getDb().select().from(schema.seriesMatches).all();
        const matchedIds = new Set(rows.filter((r) => r.status === 'matched').map((r) => r.kavitaSeriesId));
        const series = (await client.getSeries(libraryId)) as { id: number; name: string }[];
        for (const s of series) {
          if (matchedIds.has(s.id)) {
            targets.push({ id: s.id, name: s.name, libraryId });
          }
        }
      }
      break;
    }
    case 'clear-overrides': {
      const libIds = job.payload.libraryId !== undefined ? [job.payload.libraryId] : [];
      for (const libId of libIds) {
        getDb().delete(schema.libraryOverrides).where(eq(schema.libraryOverrides.libraryId, libId)).run();
      }
      summary.cleared = libIds.length;
      return summary;
    }
    default:
      throw new Error('Unknown job type: ' + job.type);
  }

  // Every series can match against the local MangaDex adult catalog, which
  // covers chapterless titles invisible to live search; flagged-mature series
  // fuzzily, others only on exact title match (see catalogCandidates). Detect
  // maturity first; batch jobs refresh the catalog inline when empty or stale
  // (single-series jobs never block on a multi-minute build).
  if (getCredentialMap().enabledProviders.includes('mangadex')) {
    let matureCount = 0;
    // Bounded concurrency — sequential metadata calls took 20-60 s on large
    // libraries before matching could even start.
    const METADATA_CONCURRENCY = 5;
    let nextTarget = 0;
    const detectMaturity = async (): Promise<void> => {
      while (nextTarget < targets.length) {
        const t = targets[nextTarget++];
        try {
          if (isMatureAgeRating((await client.getSeriesMetadata(t.id)).ageRating)) {
            t.mature = true;
            matureCount++;
          }
        } catch {
          /* series without a metadata row yet */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, targets.length) }, () => detectMaturity()));
    log('info', `${matureCount} of ${targets.length} target(s) flagged mature`);
    if (catalogNeedsRefresh()) {
      if (job.type === 'match-series') {
        log('warn', 'MangaDex adult catalog is empty or stale; exact-title catalog matches are unavailable until it is built. Build it from Settings → Metadata providers.');
      } else {
        log('info', 'Refreshing MangaDex adult catalog before matching...');
        await refreshCatalog({
          log,
          onProgress: (current, total) => jobQueue.setProgress(job.id, current, total),
          isCancelled: () => jobQueue.isCancelRequested(job.id),
        });
      }
    }
  }
  jobQueue.setProgress(job.id, 0, targets.length);
  log('info', `Processing ${targets.length} series`);

  const force = job.type === 'sync-series';
  for (let i = 0; i < targets.length; i++) {
    if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
    const t = targets[i];
    const r = await matchAndApply(client, t, t.libraryId, force, log);
    summary.processed++;
    if (r.matched && r.errors.length === 0) summary.matched++;
    if (r.errors.length > 0) summary.failed++;
    jobQueue.setProgress(job.id, i + 1, targets.length);
  }

  return summary;
}