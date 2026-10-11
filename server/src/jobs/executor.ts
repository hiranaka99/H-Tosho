import { invalidateDuplicateLibrary } from '../services/galleryDuplicates.js';
import { eq, inArray } from 'drizzle-orm';
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
import { applyToKavita, applySeriesMatch, type ApplySeriesResult } from '../services/sync.js';
import { checkWatchedSearches } from '../services/watchedSearches.js';
import { notify, formatPushedFields, providerName } from '../notify/dispatcher.js';
import { jobQueue, JobCancelled, type Job, type JobContext, type LogFn } from './queue.js';
import { listCbzFiles, mapKavitaPathToLocalPath, mergeCbzFiles, pathContains, readComicInfo, resolveExistingFile, resolveSeriesHostDir, rewriteZipEntry, setComicInfoFields } from '../lib/cbz.js';
import { mapLimit, sleep } from '../lib/http.js';
import { parseComicInfo, renderComicInfoXml } from '../downloader/comicinfo.js';
import type { KavitaChapterDto, KavitaSeries } from '../kavita/types.js';
import { prepareMergeDownloads, validMergeChapter, validateMergeDownloads } from './mergeDownloads.js';

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

export interface JobResult {
  [key: string]: number | string[] | boolean | undefined;
  pushed?: string[];
  coverUpdated?: boolean;
  volumeCoversUpdated?: number;
}

function rememberContext(job: Job, context: JobContext): void {
  const saved = jobQueue.updateContext(job.id, context);
  if (saved) {
    job.context = saved;
    job.payload.context = saved;
  }
}

function throwIfJobCancelled(jobId: number): void {
  if (jobQueue.isCancelRequested(jobId)) throw new JobCancelled();
}

function rememberTargets(job: Job, targets: Target[]): void {
  const explicitIds = new Set([...(job.payload.seriesId !== undefined ? [job.payload.seriesId] : []), ...(job.payload.seriesIds ?? [])]);
  const libraryIds = new Set(targets.map((target) => target.libraryId));
  const resolvedExplicit = explicitIds.size > 0 && targets.filter((target) => explicitIds.has(target.id)).length === explicitIds.size;
  rememberContext(job, {
    series: targets.map(({ id, name }) => ({ id, name })),
    libraryId: job.payload.libraryId ?? job.context?.libraryId ?? (resolvedExplicit && libraryIds.size === 1 ? targets[0]?.libraryId : undefined),
  });
}

function rememberLibraries(job: Job, libraries: { id: number; name: string }[]): void {
  const libraryId = job.payload.libraryId ?? job.context?.libraryId ?? (libraries.length === 1 ? libraries[0].id : undefined);
  const library = libraries.find((entry) => entry.id === libraryId);
  rememberContext(job, { series: [], libraryId, libraryName: library?.name });
}

async function rememberAvailableLibraries(job: Job, client: KavitaClient): Promise<void> {
  if (job.context?.libraryName) return;
  try {
    rememberLibraries(job, await client.getLibraries());
  } catch {
    // Identity enrichment must not prevent the existing operation from running.
  }
}

async function rememberSeriesLibrary(job: Job, client: KavitaClient, series: Target): Promise<void> {
  rememberTargets(job, [series]);
  await rememberAvailableLibraries(job, client);
}


function upsertMatch(r: {
  kavitaSeriesId: number;
  status: string;
  providerId: string | null;
  providerSeriesId: string | null;
  matchScore: number | null;
  metadataJson: string | null;
  errorMessage: string | null;
}): void {
  const existing = getDb().select({
    confirmed: schema.seriesMatches.confirmed,
    providerId: schema.seriesMatches.providerId,
    providerSeriesId: schema.seriesMatches.providerSeriesId,
  }).from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, r.kavitaSeriesId)).get();
  // Re-matching may select a different candidate; an approval belongs only to
  // the exact provider identity. Re-syncing that identity preserves it.
  const confirmed = Boolean(r.providerId && r.providerSeriesId && existing?.confirmed
    && existing.providerId === r.providerId && existing.providerSeriesId === r.providerSeriesId);
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: r.kavitaSeriesId,
      status: r.status,
      providerId: r.providerId,
      providerSeriesId: r.providerSeriesId,
      matchScore: r.matchScore,
      confirmed,
      metadataJson: r.metadataJson,
      errorMessage: r.errorMessage,
      lastSyncedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.seriesMatches.kavitaSeriesId,
      set: {
        status: r.status,
        providerId: r.providerId,
        providerSeriesId: r.providerSeriesId,
        matchScore: r.matchScore,
        confirmed,
        metadataJson: r.metadataJson,
        errorMessage: r.errorMessage,
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
    const status = result.errors.length ? 'failed' : 'matched';
    upsertMatch({
      kavitaSeriesId: series.id,
      status,
      providerId: best.providerId,
      providerSeriesId: best.providerSeriesId,
      matchScore: best.score,
      metadataJson: JSON.stringify(meta),
      errorMessage: result.errors.length ? result.errors.join('; ') : null,
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
  jobId?: number,
): Promise<boolean> {
  const graceUntil = Date.now() + SCAN_TASK_GRACE_MS;
  let sawTask = false;
  for (;;) {
    if (jobId !== undefined) throwIfJobCancelled(jobId);
    if (Date.now() >= deadline) {
      log('warn', `Kavita scan for ${what} not confirmed complete after waiting — continuing`);
      return false;
    }
    let running: boolean;
    try {
      running = await client.isTaskRunning();
    } catch (e) {
      if (jobId !== undefined) throwIfJobCancelled(jobId);
      log('warn', `Kavita task status unavailable (${e instanceof Error ? e.message : String(e)}); proceeding without waiting`);
      return true;
    }
    if (jobId !== undefined) throwIfJobCancelled(jobId);
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
      if (!drained) throw timeoutError();
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
async function sourceSeriesIdsForMerge(sourceFiles: string[], targetDir: string, log: LogFn, job: Job): Promise<number[]> {
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
  opts: { job: Job; seriesId?: number | null; libraryId?: number | null },
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
      const found = series.find((s) => s.folderPath && lastSegment(s.folderPath).toLowerCase() === targetName);
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
async function runApplySeries(client: KavitaClient, job: Job, log: LogFn): Promise<JobResult> {
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
      onSeriesResolved: (series) => rememberSeriesLibrary(job, client, series),
    });
  } catch (e) {
    if (e instanceof JobCancelled) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `Apply failed for series ${seriesId}: ${msg}`);
    throw new Error(msg);
  }
  const ok = result.errors.length === 0;
  for (const warning of result.warnings) log('warn', warning);
  recordHistory(seriesId, result.name, ok ? 'updated' : 'failed', {
    providerId: p.providerId!,
    score: p.score ?? null,
    pushed: result.pushed,
    coverUpdated: result.coverUpdated,
    volumeCoversUpdated: result.volumeCoversUpdated,
    errors: result.errors,
    warnings: result.warnings,
  });
  // Notification failures must not flip an already-applied match to failed —
  // the metadata push succeeded by the time we get here.
  try {
    const name = providerName(p.providerId!);
    await notify({
      title: ok ? (result.warnings.length ? `Synced with warnings — ${result.name}` : result.name) : `Sync failed — ${result.name}`,
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
  log(ok && result.warnings.length === 0 ? 'success' : 'warn', `${result.name} -> ${p.providerId!}${ok ? '' : ` — ${result.errors.join('; ')}`}`);
  const summary: JobResult = {
    processed: 1, matched: ok ? 1 : 0, failed: ok ? 0 : 1,
    pushed: result.pushed,
    coverUpdated: result.coverUpdated,
    volumeCoversUpdated: result.volumeCoversUpdated,
  };
  if (result.warnings.length > 0) summary.warnings = result.warnings.length;
  if (result.titleFilesUpdated > 0) summary.titleFilesUpdated = result.titleFilesUpdated;
  if (result.titleFilesVerified > 0) summary.titleFilesVerified = result.titleFilesVerified;
  return summary;
}

/** Concurrent series matched inside one match/sync job. Targets are independent (separate Kavita rows and provider lookups), so a few can run at once; the cap keeps provider rate limits (MAL) and Discord webhook bursts comfortable. */
const MATCH_CONCURRENCY = 3;

/** Run a queued job. Returns a small summary stored on the job row. */
export async function runJob(job: Job, log: LogFn): Promise<JobResult> {
  // Any file/metadata job may change the archive index, including partial failures.
  invalidateDuplicateLibrary();
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
    throwIfJobCancelled(job.id);
    const p = job.payload.path;
    if (!p) throw new Error('path required');
    const file = resolveExistingFile(p);
    if (!file) throw new Error(`File not found: ${p}`);
    const existing = await readComicInfo(file);
    throwIfJobCancelled(job.id);
    const previousSeriesName = existing ? parseComicInfo(existing).fields.Series?.trim() : undefined;
    const editClient = job.payload.seriesId !== undefined ? connectedClientOrNull() : null;
    let originalSeries: KavitaSeries | undefined;
    if (editClient && job.payload.seriesId !== undefined) {
      try {
        originalSeries = await editClient.getSeriesById(job.payload.seriesId);
        await rememberSeriesLibrary(job, editClient, originalSeries);
      } catch {
        // Editing a local archive remains possible when Kavita is unavailable.
      }
    }
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
    throwIfJobCancelled(job.id);
    await rewriteZipEntry(file, 'ComicInfo.xml', Buffer.from(xml, 'utf8'));
    invalidateDuplicateLibrary();
    log('info', `Wrote ComicInfo.xml into ${file}`);
    throwIfJobCancelled(job.id);
    const editedSeriesName = parseComicInfo(xml).fields.Series?.trim();
    const seriesNameChanged = Boolean(editedSeriesName && editedSeriesName !== previousSeriesName);
    const writtenNumber = parseComicInfo(xml).fields.Number?.trim() ?? '';
    if (job.payload.seriesId !== undefined) {
      const client = editClient;
      if (client) {
        const series = originalSeries ?? await client.getSeriesById(job.payload.seriesId);
        rememberTargets(job, [series]);
        throwIfJobCancelled(job.id);
        if (seriesNameChanged && editedSeriesName) {
          await client.updateSeriesMetadata(series.id, { name: editedSeriesName });
          log('info', `Updated Kavita series name to "${editedSeriesName}"`);
        }
        // A bare scan request is not enough: Kavita defers it by 10 minutes while
        // another scan is in flight, and a job that reports success while Kavita
        // still shows the old chapter number is how renumbered archives end up
        // merged into their neighbor's chapter.
        await rescanAndVerifyChapter(client, series.libraryId, series.id, file, writtenNumber || null, log, job.id);
      }
    } else {
      await rescanLibraryContainingDir(path.dirname(file), log, editedSeriesName);
    }
    throwIfJobCancelled(job.id);
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
    let sourceFiles = job.payload.sourceFiles ?? [];
    validateMergeDownloads(job.payload.downloads);
    if (!sourceFiles.length && !job.payload.downloads?.length) throw new Error('At least one .cbz file or gallery is required');
    throwIfJobCancelled(job.id);
    for (const file of sourceFiles) if (!resolveExistingFile(file) || !file.toLowerCase().endsWith('.cbz')) throw new Error(`Source archive not found: ${file}`);
    for (const number of Object.values(job.payload.chapters ?? {})) if (!validMergeChapter(number)) throw new Error('Incoming chapter numbers must be positive numbers or blank');
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
      rememberTargets(job, [s]);
      const libraries = await client.getLibraries();
      const lib = libraries.find((l) => l.id === s.libraryId);
      rememberLibraries(job, libraries);
      const dl = getDownloaderSettings();
      const dir = resolveSeriesHostDir({
        libraryPath: lib?.path ?? null,
        folderPath: s.folderPath ?? null,
        anchors: dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : [],
        mappings: dl.libraryPathMappings,
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
    // The merge and existing chapter edits share one queue commitment. Check
    // every target edit before moving anything; incoming paths cannot expand
    // the set of archives eligible for in-place metadata edits.
    const existingEdits = Object.entries(job.payload.existingChapters ?? {});
    if (existingEdits.length > 0) {
      const targetArchives = new Set(listCbzFiles(targetDir).map(file => path.resolve(file)));
      for (const [file, number] of existingEdits) {
        if (!targetArchives.has(path.resolve(file))) throw new Error(`Chapter edit is not an existing target archive: ${file}`);
        if (!validMergeChapter(number)) {
          throw new Error('Existing chapter edits must be positive numbers or blank');
        }
      }
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.accessSync(targetDir, fs.constants.W_OK);
    const downloaded = await prepareMergeDownloads(job, log);
    sourceFiles = [...new Set([...sourceFiles, ...downloaded.files])];
    const chapters = { ...job.payload.chapters, ...downloaded.chapters };
    throwIfJobCancelled(job.id);
    const sourceSeriesIds = await sourceSeriesIdsForMerge(sourceFiles, targetDir, log, job);
    throwIfJobCancelled(job.id);
    log('info', `Merging ${sourceFiles.length} file(s) into ${targetDir}`);
    const r = await mergeCbzFiles(sourceFiles, targetDir, chapters, stampName ?? lastSegment(targetDir), (source, destination) => {
      // Keep download history and job retries pointing at the published archive,
      // including collision-renamed files. Completed galleries are reused.
      getDb().update(schema.downloadQueue).set({ outputPath: destination, mergeJobId: null }).where(eq(schema.downloadQueue.outputPath, source)).run();
      job.payload.sourceFiles = (job.payload.sourceFiles ?? []).map(file => file === source ? destination : file);
      if (job.payload.chapters?.[source] !== undefined) {
        job.payload.chapters = { ...job.payload.chapters, [destination]: job.payload.chapters[source] };
        if (source !== destination) delete job.payload.chapters[source];
      }
      jobQueue.updateMergeState(job.id, { sourceFiles: job.payload.sourceFiles, chapters: job.payload.chapters });
    });
    for (const f of r.failed) log('warn', `Skipped ${f.file}: ${f.error}`);
    if (r.moved.length === 0) throw new Error('No files could be moved — check the source paths');
    let chapterEditFailures = 0;
    for (const [file, number] of existingEdits) {
      throwIfJobCancelled(job.id);
      try {
        await setComicInfoFields(path.resolve(file), { Number: number.trim() });
        log('success', `Updated existing chapter number: ${path.basename(file)}`);
      } catch (error) {
        chapterEditFailures += 1;
        log('warn', `Could not update existing chapter ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log('success', `Moved ${r.moved.length} file(s) into one folder as "${stampName ?? lastSegment(targetDir)}"; stamped chapter numbers on ${r.chaptered.length}`);
    await removeSourceSeriesFromKavita(sourceSeriesIds, log);
    await rescanAndVerifyMerge(targetDir, r.moved, log, { job, seriesId: job.payload.seriesId ?? null, libraryId: targetLibraryId });
    invalidateDuplicateLibrary();
    return { processed: r.moved.length, matched: 0, failed: r.failed.length + chapterEditFailures };
  }

  // "Delete files" from a series card: removes the folder holding the series'
  // .cbz archives. The folder is re-resolved server-side from the series id —
  // the client never supplies a path — and must land strictly inside a known
  // library root before anything is removed. Kavita is then asked to rescan
  // the containing library so it drops the now-fileless series record (the
  // next scan-new run prunes the local match row as an orphan).
  if (job.type === 'delete-series') {
    const seriesId = job.payload.seriesId;
    if (seriesId == null) throw new Error('seriesId required');
    const client = connectedClientOrNull();
    if (!client) throw new Error('Kavita is not configured');
    let s: { id: number; name: string; libraryId: number; folderPath?: string };
    try {
      s = await client.getSeriesById(seriesId);
    } catch {
      throw new Error(`Kavita series ${seriesId} not found`);
    }
    rememberTargets(job, [s]);
    const libraries = await client.getLibraries();
    const lib = libraries.find((l) => l.id === s.libraryId);
    rememberLibraries(job, libraries);
    if (!lib) throw new Error(`Kavita library ${s.libraryId} not found`);
    const dl = getDownloaderSettings();
    const mappings = dl.libraryPathMappings ?? [];
    const dir = resolveSeriesHostDir({
      libraryPath: lib.path,
      folderPath: s.folderPath,
      anchors: dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : [],
      mappings,
    });
    if (!dir || !fs.existsSync(dir)) {
      throw new Error(`Could not locate the series folder for "${s.name}" on this machine`);
    }
    // Never delete a root itself: a series whose folder is the library (or
    // download) root would wipe the whole tree, not just its own files.
    const realDir = safeRealpath(dir);
    const trustedRoots = [
      ...(lib.paths ?? (lib.path ? [lib.path] : [])).map((r) => mapKavitaPathToLocalPath(r, mappings) ?? r),
      ...mappings.map((m) => m.localPath),
      ...(dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : []),
    ].map((r) => safeRealpath(r));
    if (trustedRoots.includes(realDir) || !trustedRoots.some((r) => pathContains(r, realDir))) {
      throw new Error(`Refusing to delete ${dir}: it is not strictly inside a known library root`);
    }
    const archives = listCbzFiles(dir).length;
    log('info', `Deleting ${dir} (${archives} archive(s))`);
    await fs.promises.rm(dir, { recursive: true });
    log('success', `Deleted ${dir}`);
    try {
      await client.scanLibrary(lib.id);
      log('info', `Requested Kavita rescan of "${lib.name}" so the series record is dropped`);
    } catch (e) {
      log('warn', `Kavita rescan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { deleted: archives };
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

  const resolveIds = async (ids: number[]): Promise<Target[]> => {
    const resolved = await Promise.allSettled(ids.map((id) => byId(id)));
    const found: Target[] = [];
    for (const result of resolved) if (result.status === 'fulfilled') found.push(result.value);
    rememberTargets(job, found);
    await rememberAvailableLibraries(job, client);
    const failure = resolved.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return found;
  };

  switch (job.type) {
    case 'scan-new': {
      const allLibs = await client.getLibraries();
      // An explicit libraryId (from the Libraries page) scopes the scan to one
      // library; the scheduled auto-scan enqueues without a payload and stays global.
      const libs = job.payload.libraryId !== undefined ? allLibs.filter((l) => l.id === job.payload.libraryId) : allLibs;
      rememberLibraries(job, libs);
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
        rememberTargets(job, targets);
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
      rememberLibraries(job, libs);
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
        rememberTargets(job, targets);
      }
      break;
    }
    case 'match-library': {
      const libraryId = job.payload.libraryId;
      if (libraryId === undefined) throw new Error('libraryId required');
      await rememberAvailableLibraries(job, client);
      const series = (await client.getSeries(libraryId)) as { id: number; name: string }[];
      for (const s of series) targets.push({ id: s.id, name: s.name, libraryId });
      rememberTargets(job, targets);
      break;
    }
    case 'match-series': {
      const ids =
        job.payload.seriesIds?.length ? job.payload.seriesIds : job.payload.seriesId !== undefined ? [job.payload.seriesId] : [];
      if (!ids.length) throw new Error('seriesId or seriesIds required');
      targets.push(...(await resolveIds(ids)));
      break;
    }
    case 'sync-series': {
      const ids = job.payload.seriesIds?.length ? job.payload.seriesIds : [];
      if (ids.length) {
        targets.push(...(await resolveIds(ids)));
      } else {
        const libraryId = job.payload.libraryId;
        if (libraryId === undefined) throw new Error('seriesIds or libraryId required');
        await rememberAvailableLibraries(job, client);
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
        rememberTargets(job, targets);
      }
      break;
    }
    case 'clear-overrides': {
      const libIds = job.payload.libraryId !== undefined ? [job.payload.libraryId] : [];
      await rememberAvailableLibraries(job, client);
      // Route through settings so its library-override cache is invalidated —
      // settings.ts is the module that caches reads of this table.
      clearLibraryOverrides(libIds);
      summary.cleared = libIds.length;
      return summary;
    }
    default:
      throw new Error('Unknown job type: ' + job.type);
  }

  rememberTargets(job, targets);
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
