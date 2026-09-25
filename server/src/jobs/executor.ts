import { inArray } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  getCredentialMap,
  getDownloaderSettings,
  getKavitaConnection,
  clearLibraryOverrides,
  getLibraryOverride,
  providerOrderFor,
} from '../services/settings.js';
import { autoMatch, fetchProviderMetadata, type CandidateMatch } from '../match/autoMatcher.js';
import { applyToKavita, applySeriesMatch, checkAlignment, type ApplySeriesResult } from '../services/sync.js';
import { checkWatchedSearches } from '../services/watchedSearches.js';
import { notify, formatPushedFields, providerName } from '../notify/dispatcher.js';
import { jobQueue, JobCancelled, type Job, type LogFn } from './queue.js';
import { listCbzFiles, mergeCbzFiles, pathContains, readComicInfo, resolveExistingFile, resolveSeriesHostDir, rewriteZipEntry } from '../lib/cbz.js';
import { mapLimit, sleep } from '../lib/http.js';
import { parseComicInfo, renderComicInfoXml } from '../downloader/comicinfo.js';
import type { KavitaChapterDto } from '../kavita/types.js';

interface Target {
  id: number;
  name: string;
  libraryId?: number;
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
  series: { id: number; name: string },
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

  const outcome = await autoMatch(series, { providerOrder: order, credentials, enabledProviders });
  log?.('info', `${series.name}: ${outcome.candidates.length} candidate(s) across [${outcome.searchedProviders.join(', ')}]`);

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
    // The cover URL is applied inside applyToKavita: it prefers a Kavita-side
    // fetch (upload-by-url) and falls back to a local download + base64 apply.
    const result = await applyToKavita(client, series.id, meta, {
      coverUrl: meta.coverUrl,
      volumeCovers: meta.volumeCovers,
      title: series.name,
    });
    // Verify the push against Kavita's live state and record whether every
    // provider-managed field now matches (the "Aligned" flag).
    let aligned = false;
    try {
      const full = await client.getSeriesById(series.id);
      const kavitaMeta = await client.getSeriesMetadata(series.id);
      aligned = checkAlignment({ name: full.name, metadata: kavitaMeta }, meta).aligned;
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
      const name = providerName(best.providerId);
      await notify({
        title: result.errors.length ? `Sync failed — ${series.name}` : series.name,
        description: `${force ? 'Re-synced' : 'Matched'} to ${meta.url ? `[${name}](${meta.url})` : name} · ${Math.round(best.score * 100)}% confidence`,
        fields: [
          ...(result.pushed.length ? [{ name: 'Updated', value: formatPushedFields(result.pushed) }] : []),
          ...(result.errors.length ? [{ name: 'Errors', value: result.errors.join('\n') }] : []),
        ],
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
    const libraries = await client.getLibraries();
    const candidates = new Set<string>();
    // Walk both the literal path and its realpath: symlinked mount points resolve to one real path.
    for (const start of [dir, safeRealpath(dir)]) {
      let d = start;
      for (let i = 0; i < 3; i++) {
        const seg = lastSegment(d);
        if (!seg) break;
        candidates.add(seg.toLowerCase());
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
      }
    }
    const realDir = safeRealpath(dir);

    for (const lib of libraries) {
      const directLibrary = Boolean(lib.path && pathContains(safeRealpath(lib.path), realDir));
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
const SCAN_WAIT_TIMEOUT_MS = 30 * 60_000;
const SCAN_STATUS_POLL_MS = 5_000;
/**
 * Kavita enqueues scans asynchronously (Hangfire), so an idle isTaskRunning
 * answer right after the request is not proof the scan finished. Allow this
 * much time for the task to appear in the queue before trusting an idle read.
 */
const SCAN_TASK_GRACE_MS = 15_000;

/** Budget for waiting until a ComicInfo edit shows up in Kavita. Must outlive Kavita's 10-minute deferral of a series scan that arrives while another scan is still in flight, or the wait always times out before the deferred scan can run. */
function editVerifyTimeoutMs(): number {
  const v = Number(process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
}

/** fs.realpathSync that tolerates missing paths (bind mounts and not-yet-created dirs). */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Poll Kavita's task queue until no scan task is running or queued. An idle
 * answer right after a scan request is not proof the scan finished — the task
 * may not have appeared yet — so an idle reading only counts once a task was
 * observed, or once the grace window has passed. Returns true when the queue
 * drained (or status is unavailable), false when the deadline hit first.
 */
async function waitForKavitaTasksToDrain(
  client: KavitaClient,
  log: LogFn,
  what: string,
  deadline: number,
): Promise<boolean> {
  const graceUntil = Date.now() + SCAN_TASK_GRACE_MS;
  let sawTask = false;
  for (;;) {
    let running: boolean;
    try {
      running = await client.isTaskRunning();
    } catch (e) {
      log('warn', `Kavita task status unavailable (${e instanceof Error ? e.message : String(e)}); proceeding without waiting`);
      return true;
    }
    if (running) {
      sawTask = true;
    } else if (sawTask || Date.now() >= graceUntil) {
      return true;
    }
    if (Date.now() >= deadline) {
      log('warn', `Kavita scan for ${what} not confirmed complete after waiting — continuing`);
      return false;
    }
    await sleep(SCAN_STATUS_POLL_MS);
  }
}

/** True when Kavita's chapter number for a file equals the one we wrote (numeric comparison, so "3" matches "3.0"). */
function chapterNumberMatches(actual: string, expected: string): boolean {
  const a = actual.trim();
  const e = expected.trim();
  if (a === e) return true;
  const na = Number(a);
  const ne = Number(e);
  return Number.isFinite(na) && Number.isFinite(ne) && na === ne;
}

/**
 * Rescan a series until Kavita indexes `file` under the chapter number we just
 * wrote into its ComicInfo. A bare scan request is not enough: Kavita defers a
 * series scan by 10 minutes when another scan (a download-triggered or periodic
 * library scan) is still in flight, so "requested" can stay stale for a long
 * time — exactly how a renumbered archive kept its old chapter and merged into
 * a neighbor's. The wait must outlive that deferral; the check reads the
 * chapters-by-series list, which reflects what Kavita actually has.
 */
async function rescanAndVerifyChapter(
  client: KavitaClient,
  libraryId: number,
  seriesId: number,
  file: string,
  expectedNumber: string | null,
  log: LogFn,
): Promise<void> {
  const fileName = path.basename(file).toLowerCase();
  const deadline = Date.now() + editVerifyTimeoutMs();
  for (;;) {
    await client.scanSeries(libraryId, seriesId);
    log('info', `Requested Kavita rescan of series ${seriesId}`);
    await waitForKavitaTasksToDrain(client, log, `series ${seriesId}`, deadline);
    if (expectedNumber === null) return; // scan cycle complete; no number to check
    let chapters: KavitaChapterDto[] | null = null;
    try {
      chapters = await client.getChaptersBySeries(seriesId);
    } catch {
      /* chapter list unavailable — treat as not yet indexed */
    }
    if (chapters) {
      let found: string | null = null;
      outer: for (const ch of chapters) {
        for (const f of ch.files ?? []) {
          if (f.filePath && path.basename(f.filePath).toLowerCase() === fileName) {
            found = String(ch.number ?? '');
            break outer;
          }
        }
      }
      if (found !== null && chapterNumberMatches(found, expectedNumber)) {
        log('success', `Kavita has indexed ${fileName} as chapter ${expectedNumber}`);
        return;
      }
      log('info', found === null
        ? `${fileName} not indexed in Kavita yet — waiting for the scan`
        : `Kavita still shows ${fileName} as chapter "${found}" (expected "${expectedNumber}") — requesting another scan`);
    }
    if (Date.now() >= deadline) {
      log('warn', `Kavita did not index ${fileName} as chapter ${expectedNumber} within ${Math.round(editVerifyTimeoutMs() / 60_000)} minutes — run a manual scan in Kavita`);
      return;
    }
    await sleep(SCAN_STATUS_POLL_MS);
  }
}

/**
 * Trigger a Kavita library scan and wait for it to finish so newly ingested
 * folders become series before the matching pass runs. The scan covers every
 * in-scope library regardless of H-Tosho's per-library auto-match override —
 * that setting gates matching, not keeping Kavita's database fresh.
 * Completion is detected with GET /api/Server/is-task-running (true while any
 * task is running or queued): the wait ends once the flag turns off after
 * having been seen, or once the task never appeared within the grace window,
 * or at the deadline with a warning — matching proceeds either way.
 */
async function runKavitaLibraryScan(client: KavitaClient, libs: { id: number; name: string; lastModified?: string }[], jobId: number, log: LogFn): Promise<void> {
  if (libs.length === 0) return;
  if (libs.length === 1) {
    await client.scanLibrary(libs[0].id);
    log('info', `Requested Kavita scan of "${libs[0].name}"`);
  } else {
    await client.scanAllLibraries();
    log('info', `Requested Kavita scan of all ${libs.length} libraries`);
  }
  const deadline = Date.now() + SCAN_WAIT_TIMEOUT_MS;
  const graceUntil = Date.now() + SCAN_TASK_GRACE_MS;
  let sawTask = false;
  for (;;) {
    if (jobQueue.isCancelRequested(jobId)) throw new JobCancelled();
    let running: boolean;
    try {
      running = await client.isTaskRunning();
    } catch (e) {
      log('warn', `Kavita task status unavailable (${e instanceof Error ? e.message : String(e)}); proceeding without waiting`);
      return;
    }
    if (running) {
      sawTask = true;
    } else if (sawTask || Date.now() >= graceUntil) {
      return;
    }
    if (Date.now() >= deadline) {
      log('warn', `Kavita scan not confirmed complete after ${SCAN_WAIT_TIMEOUT_MS / 60_000} minutes; matching now, leftovers are picked up next cycle`);
      return;
    }
    await sleep(SCAN_STATUS_POLL_MS);
  }
}

/** Resolve the exact Kavita series records owning source folders before a merge moves them away. */
async function sourceSeriesIdsForMerge(sourceFiles: string[], targetDir: string, log: LogFn): Promise<number[]> {
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return [];
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/').toLowerCase();
    const target = norm(targetDir);
    const sourceDirs = new Set(sourceFiles.map((file) => norm(path.dirname(file))).filter((dir) => dir !== target && !target.startsWith(`${dir}/`)));
    if (sourceDirs.size === 0) return [];
    const downloadDirectory = getDownloaderSettings().downloadDirectory;
    const anchors = [...sourceDirs].map((dir) => path.dirname(dir));
    if (downloadDirectory) anchors.push(path.resolve(downloadDirectory));
    const ids: number[] = [];
    for (const lib of await client.getLibraries()) {
      let series;
      try {
        series = await client.getSeries(lib.id);
      } catch {
        continue;
      }
      for (const item of series) {
        const hostDir = resolveSeriesHostDir({ libraryPath: lib.path, folderPath: item.folderPath, anchors });
        if (hostDir && sourceDirs.has(norm(hostDir))) ids.push(item.id);
      }
    }
    return ids;
  } catch (error) {
    log('warn', `Kavita source-series lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Delete only the source series records resolved before their folders were moved. */
async function removeSourceSeriesFromKavita(seriesIds: number[], log: LogFn): Promise<void> {
  if (seriesIds.length === 0) return;
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return;
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    const deleted: number[] = [];
    for (const id of seriesIds) {
      try {
        await client.deleteSeries(id);
        deleted.push(id);
        log('info', `Removed stale Kavita series ${id} — its files now live in the merged folder`);
      } catch (error) {
        log('warn', `Could not delete Kavita series ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (deleted.length > 0) getDb().delete(schema.seriesMatches).where(inArray(schema.seriesMatches.kavitaSeriesId, deleted)).run();
  } catch (error) {
    log('warn', `Kavita series cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** Budget for merge verification. Kavita defers a series scan arriving while another scan is in flight by 10 minutes, so this must outlive that deferral plus a typical library scan — a shorter budget times out before the deferred scan can ever run. */
const MERGE_VERIFY_TIMEOUT_MS = 25 * 60_000;

/**
 * Rescan the merged folder and verify that every moved archive actually lands in
 * Kavita.
 *
 * Kavita scans are asynchronous, and a series scan requested while another scan is
 * in flight (e.g. the auto-sync scan fired by the last chapter's download) is
 * deferred by 10 minutes. Moving files while such a scan walks the tree can leave
 * later files behind: the in-flight pass has already enumerated the target folder,
 * and removeSourceSeriesFromKavita deletes the stale source series records. So fire
 * the scan, wait for Kavita's task queue to drain, check which of the moved files
 * are indexed by name, and repeat until every file is present (or the budget runs
 * out).
 *
 * `opts` carries the target series known from the job payload. When merging into an
 * existing Kavita series its library is authoritative: H-Tosho's host paths can
 * differ from Kavita's library path (bind mounts), where path matching alone never
 * finds the library and the rescan would be skipped silently.
 */
async function rescanAndVerifyMerge(
  targetDir: string,
  movedFiles: string[],
  log: LogFn,
  opts?: { seriesId?: number | null; libraryId?: number | null },
): Promise<void> {
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return;
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    const libraries = await client.getLibraries();
    let lib = opts?.libraryId != null ? libraries.find((l) => l.id === opts.libraryId) : undefined;
    if (!lib) {
      // Path matching with realpath normalization: symlinked mount points resolve to one real path.
      const realTarget = safeRealpath(targetDir);
      lib = libraries.find((l) => l.path && pathContains(safeRealpath(l.path), realTarget));
    }
    if (!lib) {
      // Fall back to folder-name matching, like rescanLibraryContainingDir.
      const candidates = new Set<string>();
      for (const start of [targetDir, safeRealpath(targetDir)]) {
        let d = start;
        for (let i = 0; i < 3; i++) {
          const seg = lastSegment(d);
          if (!seg) break;
          candidates.add(seg.toLowerCase());
          const parent = path.dirname(d);
          if (parent === d) break;
          d = parent;
        }
      }
      lib = libraries.find((l) => l.path && candidates.has(lastSegment(l.path).toLowerCase()));
    }
    if (!lib) {
      log('warn', 'No Kavita library contains this folder — verification skipped, the periodic scan will pick it up');
      return;
    }
    const library = lib;

    const targetName = lastSegment(targetDir).toLowerCase();
    const findSeries = async (): Promise<{ id: number; name: string } | undefined> => {
      if (opts?.seriesId != null) {
        try {
          const s = await client.getSeriesById(opts.seriesId);
          return { id: s.id, name: s.name };
        } catch {
          return undefined;
        }
      }
      const series = await client.getSeries(library.id);
      return series.find((s) => s.folderPath && lastSegment(s.folderPath).toLowerCase() === targetName);
    };
    // Verify by file name rather than book count: pre-existing books in the target
    // folder, or partial indexing by a concurrent scan, must not skew the check.
    const expectedNames = new Set(movedFiles.map((f) => path.basename(f).toLowerCase()));
    const indexedNames = async (seriesId: number): Promise<Set<string>> => {
      const chapters = await client.getChaptersBySeries(seriesId);
      const found = new Set<string>();
      for (const chapter of chapters) {
        for (const file of chapter.files ?? []) {
          if (file.filePath) found.add(path.basename(file.filePath).toLowerCase());
        }
      }
      return found;
    };

    const deadline = Date.now() + MERGE_VERIFY_TIMEOUT_MS;
    for (;;) {
      const series = await findSeries().catch(() => undefined);
      if (series) {
        await client.scanSeries(library.id, series.id);
        log('info', `Requested Kavita rescan of series "${series.name}"`);
      } else {
        await client.scanLibrary(library.id);
        log('info', `Requested Kavita rescan of "${library.name}"`);
      }
      // Wait for the scan to actually run: a check right after the request reads
      // stale state (Kavita defers requests while another scan is in flight), and
      // the loop would only re-request until the budget runs out.
      await waitForKavitaTasksToDrain(client, log, `series "${library.name}"`, deadline);

      const after = await findSeries().catch(() => undefined);
      let missing: string[] | null = null;
      if (after) {
        try {
          const indexed = await indexedNames(after.id);
          missing = [...expectedNames].filter((n) => !indexed.has(n));
        } catch {
          /* chapter list unavailable — treat as not yet indexed */
        }
      }
      if (missing !== null && missing.length === 0) {
        log('success', `Kavita has indexed all ${movedFiles.length} moved file(s) into the merged series`);
        return;
      }
      log('info', !after
        ? 'Merged series not registered in Kavita yet — waiting for the scan'
        : missing && missing.length > 0
          ? `Kavita is still indexing ${missing.length} of ${movedFiles.length} moved file(s): ${missing.join(', ')}`
          : 'Waiting for Kavita to finish writing the series');
      if (Date.now() >= deadline) {
        log('warn', missing && missing.length > 0
          ? `Kavita did not index ${missing.length} of ${movedFiles.length} moved file(s) within ${MERGE_VERIFY_TIMEOUT_MS / 60_000} minutes: ${missing.join(', ')} — run a manual scan in Kavita`
          : `Kavita merge verification timed out after ${MERGE_VERIFY_TIMEOUT_MS / 60_000} minutes — run a manual scan in Kavita`);
        return;
      }
      await sleep(SCAN_STATUS_POLL_MS);
    }
  } catch (e) {
    log('warn', `Kavita merge verification failed: ${e instanceof Error ? e.message : String(e)}`);
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

/**
 * apply-series job: push one user-selected candidate onto a single series.
 * applySeriesMatch owns the flow and the match-row update; this wrapper adds
 * history, notification, and the job summary. Hard failures (missing folder,
 * provider down, rejected title) fail the job with that message — the match
 * row is left as-is, mirroring the old synchronous route's behavior.
 */
async function runApplySeries(client: KavitaClient, job: Job, log: LogFn): Promise<Record<string, number>> {
  const p = job.payload;
  const seriesId = p.seriesId!;
  let result: ApplySeriesResult;
  try {
    result = await applySeriesMatch(client, {
      seriesId,
      providerId: p.providerId!,
      providerSeriesId: p.providerSeriesId!,
      selectedTitle: p.selectedTitle,
      excludedFields: p.excludedFields,
      cover: p.cover,
      score: p.score ?? null,
      isCancelled: () => jobQueue.isCancelRequested(job.id),
    });
  } catch (e) {
    if (e instanceof JobCancelled) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `Apply failed for series ${seriesId}: ${msg}`);
    throw new Error(msg);
  }
  const ok = result.errors.length === 0;
  recordHistory(seriesId, result.name, ok ? 'updated' : 'failed', {
    providerId: p.providerId!,
    score: p.score ?? null,
    pushed: result.pushed,
    coverUpdated: result.coverUpdated,
    volumeCoversUpdated: result.volumeCoversUpdated,
    errors: result.errors,
  });
  // Notification failures must not flip an already-applied match to failed —
  // the metadata push succeeded by the time we get here.
  try {
    const name = providerName(p.providerId!);
    await notify({
      title: ok ? result.name : `Sync failed — ${result.name}`,
      description: `Applied to ${result.meta.url ? `[${name}](${result.meta.url})` : name}`,
      fields: [
        ...(result.pushed.length ? [{ name: 'Updated', value: formatPushedFields(result.pushed) }] : []),
        ...(result.warnings.length ? [{ name: 'Notes', value: result.warnings.join('\n') }] : []),
        ...(result.errors.length ? [{ name: 'Errors', value: result.errors.join('\n') }] : []),
      ],
      coverUrl: result.meta.coverUrl,
      success: ok,
    });
  } catch (e) {
    log('warn', `Notification failed for ${result.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(ok ? 'success' : 'warn', `${result.name} -> ${p.providerId!}${ok ? '' : ` — ${result.errors.join('; ')}`}`);
  const summary: Record<string, number> = { processed: 1, matched: ok ? 1 : 0, failed: ok ? 0 : 1 };
  if (result.titleFilesUpdated > 0) summary.titleFilesUpdated = result.titleFilesUpdated;
  if (result.titleFilesVerified > 0) summary.titleFilesVerified = result.titleFilesVerified;
  return summary;
}

/** Concurrent series matched inside one match/sync job. Targets are independent (separate Kavita rows and provider lookups), so a few can run at once; the cap keeps provider rate limits (MAL) and Discord webhook bursts comfortable. */
const MATCH_CONCURRENCY = 3;

/** Run a queued job. Returns a small summary stored on the job row. */
export async function runJob(job: Job, log: LogFn): Promise<Record<string, number>> {
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
  // the write itself. The rescan below waits until Kavita has indexed the change
  // (when the series is known) so the job never reports success over stale data.
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
    const writtenNumber = parseComicInfo(xml).fields.Number?.trim() ?? '';
    if (job.payload.seriesId !== undefined) {
      const client = connectedClientOrNull();
      if (client) {
        const series = await client.getSeriesById(job.payload.seriesId);
        if (editedSeriesName) {
          await client.updateSeriesMetadata(series.id, { name: editedSeriesName });
          log('info', `Updated Kavita series name to "${editedSeriesName}"`);
        }
        // A bare scan request is not enough: Kavita defers it by 10 minutes while
        // another scan is in flight, and a job that reports success while Kavita
        // still shows the old chapter number is how renumbered archives end up
        // merged into their neighbor's chapter.
        await rescanAndVerifyChapter(client, series.libraryId, series.id, file, writtenNumber || null, log);
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
    let targetLibraryId: number | null = null;
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
      targetLibraryId = s.libraryId;
      // Match the Series value the existing files carry so Kavita groups the
      // merged files with them; fall back to the series name when unknown.
      stampName = (await pickSeriesStampName(dir, new Set(sourceFiles.map((f) => path.resolve(f))))) ?? s.name;
    }
    if (!targetDir) throw new Error('targetDir required');
    const sourceSeriesIds = await sourceSeriesIdsForMerge(sourceFiles, targetDir, log);
    log('info', `Merging ${sourceFiles.length} file(s) into ${targetDir}`);
    const r = await mergeCbzFiles(sourceFiles, targetDir, job.payload.chapters, stampName ?? lastSegment(targetDir));
    for (const f of r.failed) log('warn', `Skipped ${f.file}: ${f.error}`);
    if (r.moved.length === 0) throw new Error('No files could be moved — check the source paths');
    log('success', `Moved ${r.moved.length} file(s) into one folder as "${stampName ?? lastSegment(targetDir)}"; stamped chapter numbers on ${r.chaptered.length}`);
    await removeSourceSeriesFromKavita(sourceSeriesIds, log);
    await rescanAndVerifyMerge(targetDir, r.moved, log, { seriesId: job.payload.seriesId ?? null, libraryId: targetLibraryId });
    return { processed: r.moved.length, matched: 0, failed: r.failed.length };
  }

  // Identify dialog's "Apply & Sync": pushes one user-selected candidate onto
  // a single series. Unlike the match jobs above it, this carries per-dialog
  // options (title choice, field exclusions) and includes the ComicInfo.Series
  // rename flow, which waits for Kavita's scan — potentially minutes — so it
  // must run here rather than inside an HTTP request.
  if (job.type === 'apply-series') {
    const p = job.payload;
    if (p.seriesId === undefined || !p.providerId || !p.providerSeriesId) throw new Error('seriesId, providerId and providerSeriesId required');
    const client = connectedClientOrNull();
    if (!client) throw new Error('Kavita is not configured');
    return runApplySeries(client, job, log);
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
      // Refresh Kavita's database first: folders only become series once
      // Kavita itself has scanned them.
      await runKavitaLibraryScan(client, libs, job.id, log);
      // Full-table scans used to drag every metadataJson blob out of
      // seriesMatches just to build id/status sets — project only the columns
      // actually used.
      const known = new Set(
        getDb()
          .select({ kavitaSeriesId: schema.seriesMatches.kavitaSeriesId })
          .from(schema.seriesMatches)
          .all()
          .map((r) => r.kavitaSeriesId),
      );
      const liveIds = new Set<number>();
      for (const lib of libs) {
        if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        // Libraries with auto-matching disabled are skipped by the scan; their
        // series can still be matched manually via match-library / match-series.
        const autoMatchEnabled = getLibraryOverride(lib.id)?.autoMatch !== false;
        for (const s of series) {
          liveIds.add(s.id);
          if (autoMatchEnabled && !known.has(s.id)) targets.push({ id: s.id, name: s.name, libraryId: lib.id });
        }
      }
      // Prune local match rows whose Kavita series no longer exists (deleted in
      // Kavita, or re-imported under a new id after a folder rename/move). Stale
      // rows would otherwise keep counting toward the low-confidence badge even
      // though no library view can ever show them. Only safe on an unscoped
      // scan: every library was enumerated above, so anything missing is gone.
      if (job.payload.libraryId === undefined) {
        const orphans = getDb()
          .select({ kavitaSeriesId: schema.seriesMatches.kavitaSeriesId })
          .from(schema.seriesMatches)
          .all()
          .filter((r) => !liveIds.has(r.kavitaSeriesId));
        if (orphans.length > 0) {
          getDb()
            .delete(schema.seriesMatches)
            .where(inArray(schema.seriesMatches.kavitaSeriesId, orphans.map((r) => r.kavitaSeriesId)))
            .run();
          summary.pruned = orphans.length;
          log('info', `Pruned ${orphans.length} match row(s) for series no longer present in Kavita`);
        }
      }
      break;
    }
    case 'match-unmatched': {
      const allLibs = await client.getLibraries();
      // Same scoping as scan-new: explicit libraryId targets one library.
      const libs = job.payload.libraryId !== undefined ? allLibs.filter((l) => l.id === job.payload.libraryId) : allLibs;
      const rows = getDb()
        .select({ kavitaSeriesId: schema.seriesMatches.kavitaSeriesId, status: schema.seriesMatches.status })
        .from(schema.seriesMatches)
        .all();
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
        const rows = getDb()
          .select({ kavitaSeriesId: schema.seriesMatches.kavitaSeriesId, status: schema.seriesMatches.status })
          .from(schema.seriesMatches)
          .all();
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
      // Route through settings so its library-override cache is invalidated —
      // settings.ts is the module that caches reads of this table.
      clearLibraryOverrides(libIds);
      summary.cleared = libIds.length;
      return summary;
    }
    default:
      throw new Error('Unknown job type: ' + job.type);
  }

  log('info', `Processing ${targets.length} series`);

  const force = job.type === 'sync-series';
  // Progress counts completions, so it stays monotonic even when series finish
  // out of order. A cancel request stops new work at the next slot; already-
  // running series run to completion (same checkpoint semantics as before).
  let done = 0;
  await mapLimit(targets, MATCH_CONCURRENCY, async (t) => {
    if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
    const r = await matchAndApply(client, t, t.libraryId, force, log);
    summary.processed++;
    if (r.matched && r.errors.length === 0) summary.matched++;
    if (r.errors.length > 0) summary.failed++;
    done++;
    jobQueue.setProgress(job.id, done, targets.length);
  });

  return summary;
}