import { waitForScan, type ScanOutcome } from './scans.js';
import path from 'node:path';
import { KavitaClient } from './client.js';
import type { KavitaChapterDto } from './types.js';
import { getDownloaderSettings, getKavitaConnection } from '../services/settings.js';
import { listCbzFiles, readComicInfo } from '../lib/cbz.js';
import { lastSegment, pathContains, safeRealpath } from '../lib/paths.js';
import { mapKavitaPathToLocalPath, resolveSeriesHostDir } from './libraryPaths.js';
import { getDb, schema } from '../db/index.js';
import { inArray } from 'drizzle-orm';
import { sleep } from '../lib/http.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { JobCancelled, type Job, type LogFn } from '../jobs/queue.js';
import { rememberTargets, rememberLibraries, throwIfJobCancelled } from '../jobs/context.js';
/** Best-effort Kavita refresh after a local ComicInfo edit. */
export async function rescanLibraryContainingDir(dir: string, log: LogFn, seriesName?: string): Promise<void> {
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
    const mappings = getDownloaderSettings().libraryPathMappings ?? [];
    const inMappedRoot = mappings.some((m) => pathContains(safeRealpath(m.localPath), realDir));

    for (const lib of libraries) {
      const directLibrary = (lib.paths ?? (lib.path ? [lib.path] : [])).some((root) =>
        pathContains(safeRealpath(mapKavitaPathToLocalPath(root, mappings) ?? root), realDir));
      const libRootName = lib.path ? lastSegment(lib.path).toLowerCase() : '';
      const matchingLibrary = directLibrary || (!inMappedRoot && Boolean(libRootName && candidates.has(libRootName)));
      let series;
      try {
        series = await client.getSeries(lib.id);
      } catch {
        continue;
      }
      const hit = series.find((s) => {
        if (!s.folderPath) return false;
        const mapped = mapKavitaPathToLocalPath(s.folderPath, mappings);
        return mapped ? safeRealpath(mapped) === realDir : !inMappedRoot && candidates.has(lastSegment(s.folderPath).toLowerCase());
      });
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
// Leave time for a deferred series scan to run before requesting another one.
const EDIT_RESCAN_RETRY_MS = 10 * 60_000;
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

/**
 * Poll Kavita's task queue until no scan task is running or queued. An idle
 * answer right after a scan request is not proof the scan finished — the task
 * may not have appeared yet — so an idle reading only counts once a task was
 * observed, or once the grace window has passed. Returns true when the queue
 * drained (or status is unavailable), false when the deadline hit first.
 */
export async function waitForKavitaTasksToDrain(
  client: KavitaClient, log: LogFn, what: string, deadline: number, jobId?: number,
): Promise<ScanOutcome> {
  const outcome = await waitForScan(client, { deadline, pollMs: SCAN_STATUS_POLL_MS,
    graceMs: SCAN_TASK_GRACE_MS, checkCancelled: jobId === undefined ? undefined : () => throwIfJobCancelled(jobId) });
  if (outcome !== 'completed') log('warn', `Kavita scan for ${what}: ${outcome}`);
  return outcome;
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
export async function rescanAndVerifyChapter(
  client: KavitaClient,
  libraryId: number,
  seriesId: number,
  file: string,
  expectedNumber: string | null,
  log: LogFn,
  jobId: number,
): Promise<void> {
  const fileName = path.basename(file).toLowerCase();
  const timeoutMs = editVerifyTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const target = expectedNumber === null ? fileName : `${fileName} as chapter ${expectedNumber}`;
  const timeoutError = () => new Error(
    `Kavita did not confirm ${target} within ${timeoutMs / 60_000} minutes. ComicInfo.xml was saved — run a manual scan in Kavita`,
  );
  let nextScanAt = 0;
  for (;;) {
    throwIfJobCancelled(jobId);
    if (Date.now() >= deadline) throw timeoutError();
    if (Date.now() >= nextScanAt) {
      await client.scanSeries(libraryId, seriesId);
      nextScanAt = Date.now() + EDIT_RESCAN_RETRY_MS;
      log('info', `Requested Kavita rescan of series ${seriesId}`);
      throwIfJobCancelled(jobId);
      const drained = await waitForKavitaTasksToDrain(client, log, `series ${seriesId}`, deadline, jobId);
      throwIfJobCancelled(jobId);
      if (drained === 'timed-out') throw timeoutError();
      if (drained === 'status-unavailable' && expectedNumber === null) throw new Error('ComicInfo.xml was saved, but Kavita scan status could not be verified. Retry after checking the connection.');
      if (expectedNumber === null) return; // scan cycle complete; no number to check
    }
    let chapters: KavitaChapterDto[];
    try {
      chapters = await client.getChaptersBySeries(seriesId);
    } catch (error) {
      throwIfJobCancelled(jobId);
      // A deleted/recreated series can return 401 here even with a valid key.
      // Another scan against the same stale ID cannot repair that lookup.
      throw new Error(`Could not verify chapter indexing for Kavita series ${seriesId}: ${error instanceof Error ? error.message : String(error)}. ComicInfo.xml was saved — refresh the library and check the current series in Kavita`);
    }
    throwIfJobCancelled(jobId);
    if (chapters) {
      const matches = chapters.filter((ch) => (ch.files ?? []).some(
        (f) => f.filePath && path.basename(f.filePath).toLowerCase() === fileName,
      ));
      const found = matches.length ? String(matches[0].number ?? '') : null;
      // Kavita can attach a renumbered file to its new chapter without removing
      // the old chapter's file entry. Check every match so response order cannot
      // turn that inconsistency into either endless retries or false success.
      if (found !== null && matches.some((ch) => !chapterNumberMatches(String(ch.number ?? ''), found))) {
        const entries = matches.map((ch) => `chapter ${ch.number ?? ''} (ID ${ch.id})`).join(', ');
        throw new Error(`Kavita indexes ${fileName} under conflicting chapters: ${entries}. ComicInfo.xml was saved — resolve the duplicate chapter entries in Kavita before retrying`);
      }
      if (found !== null && expectedNumber !== null && chapterNumberMatches(found, expectedNumber)) {
        log('success', `Kavita has indexed ${fileName} as chapter ${expectedNumber}`);
        return;
      }
      log('info', found === null
        ? `${fileName} not indexed in Kavita yet — waiting for the scan`
        : `Kavita still shows ${fileName} as chapter "${found}" (expected "${expectedNumber}") — waiting for the scan`);
    }
    if (Date.now() >= deadline) throw timeoutError();
    await sleep(Math.min(SCAN_STATUS_POLL_MS, deadline - Date.now()));
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
export async function runKavitaLibraryScan(client: KavitaClient, libs: { id: number; name: string; lastModified?: string }[], jobId: number, log: LogFn): Promise<void> {
  if (libs.length === 0) return;
  if (libs.length === 1) {
    await client.scanLibrary(libs[0].id);
    log('info', `Requested Kavita scan of "${libs[0].name}"`);
  } else {
    await client.scanAllLibraries();
    log('info', `Requested Kavita scan of all ${libs.length} libraries`);
  }
  await waitForKavitaTasksToDrain(client, log, 'library scan', Date.now() + SCAN_WAIT_TIMEOUT_MS, jobId);
}

/** Resolve the exact Kavita series records owning source folders before a merge moves them away. */
export async function sourceSeriesIdsForMerge(sourceFiles: string[], targetDir: string, log: LogFn, job: Job): Promise<number[]> {
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return [];
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/').toLowerCase();
    const target = norm(targetDir);
    const sourceDirs = new Set(sourceFiles.map((file) => norm(path.dirname(file))).filter((dir) => dir !== target && !target.startsWith(`${dir}/`)));
    const dl = getDownloaderSettings();
    const downloadDirectory = dl.downloadDirectory;
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
        const hostDir = resolveSeriesHostDir({ libraryPath: lib.path, folderPath: item.folderPath, anchors, mappings: dl.libraryPathMappings });
        if (hostDir && sourceDirs.has(norm(hostDir))) {
          rememberTargets(job, [{ id: item.id, name: item.name, libraryId: lib.id }]);
          ids.push(item.id);
        }
        if (hostDir && norm(hostDir) === target) {
          rememberTargets(job, [{ id: item.id, name: item.name, libraryId: lib.id }]);
          rememberLibraries(job, [lib]);
        }
      }
    }
    return ids;
  } catch (error) {
    log('warn', `Kavita source-series lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Delete only the source series records resolved before their folders were moved. */
export async function removeSourceSeriesFromKavita(seriesIds: number[], log: LogFn): Promise<void> {
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
export async function rescanAndVerifyMerge(
  targetDir: string,
  movedFiles: string[],
  log: LogFn,
  opts: { job: Job; seriesId?: number | null; libraryId?: number | null; seriesName?: string },
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
      const mappings = getDownloaderSettings().libraryPathMappings ?? [];
      lib = libraries.find((l) => (l.paths ?? (l.path ? [l.path] : [])).some((root) =>
        pathContains(safeRealpath(mapKavitaPathToLocalPath(root, mappings) ?? root), realTarget)));
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
    rememberLibraries(opts.job, [library]);
    const renamedIds = new Set<number>();
    const renameSeries = async (series: { id: number; name: string } | undefined) => {
      if (!series || !opts.seriesName || renamedIds.has(series.id)) return;
      throwIfJobCancelled(opts.job.id);
      await client.updateSeriesMetadata(series.id, { name: opts.seriesName });
      renamedIds.add(series.id);
      rememberTargets(opts.job, [{ id: series.id, name: opts.seriesName, libraryId: library.id }]);
      log('success', `Set Kavita series name to "${opts.seriesName}"`);
    };

    const targetName = lastSegment(targetDir).toLowerCase();
    const findSeries = async (): Promise<{ id: number; name: string } | undefined> => {
      if (opts?.seriesId != null) {
        try {
          const s = await client.getSeriesById(opts.seriesId);
          rememberTargets(opts.job, [{ id: s.id, name: s.name, libraryId: library.id }]);
          return { id: s.id, name: s.name };
        } catch {
          return undefined;
        }
      }
      const series = await client.getSeries(library.id);
      const candidates = series.filter((s) => s.folderPath && lastSegment(s.folderPath).toLowerCase() === targetName);
      const normalize = (value: string) => {
        const resolved = safeRealpath(value).replace(/\\/g, '/').replace(/\/+$/, '');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      const mappings = getDownloaderSettings().libraryPathMappings ?? [];
      // Two artist folders may contain a series with the same folder name.
      // Prefer the exact mapped destination before changing its Kavita name.
      const found = candidates.find(s => normalize(mapKavitaPathToLocalPath(s.folderPath!, mappings) ?? s.folderPath!) === normalize(targetDir))
        ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (found) rememberTargets(opts.job, [{ id: found.id, name: found.name, libraryId: library.id }]);
      return found;
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
      await renameSeries(series);
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
      await waitForKavitaTasksToDrain(client, log, `series "${library.name}"`, deadline, opts.job.id);

      const after = await findSeries().catch(() => undefined);
      await renameSeries(after);
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
    if (e instanceof JobCancelled) throw e;
    if (opts.seriesName) throw new Error(`Archives were merged, but Kavita could not confirm the series name. Retry the merge: ${e instanceof Error ? e.message : String(e)}`);
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
export async function pickSeriesStampName(dir: string, exclude: Set<string>): Promise<string | null> {
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
