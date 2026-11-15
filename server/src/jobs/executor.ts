import { archiveMutations, archiveResource } from '../lib/mutations.js';
import { parseJobCommand, type JobPayloads, type JobExecutionState, type JobType } from '../contracts/jobs.js';
import { upsertMatch } from '../services/matchRecords.js';
import { rememberTargets, rememberLibraries, rememberAvailableLibraries, rememberSeriesLibrary, throwIfJobCancelled, type Target } from './context.js';
import { rescanLibraryContainingDir, rescanAndVerifyChapter, runKavitaLibraryScan, sourceSeriesIdsForMerge, removeSourceSeriesFromKavita, rescanAndVerifyMerge, pickSeriesStampName } from '../kavita/libraryOperations.js';
import { lastSegment, safeRealpath } from '../lib/paths.js';
import { libraryMutations } from '../lib/mutations.js';
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
import { applyResolvedSeriesMatch, applySeriesMatch, type ApplySeriesResult } from '../services/sync.js';
import { checkWatchedSearches } from '../services/watchedSearches.js';
import { scanMatchSuggestions } from '../services/matchSuggestions.js';
import { notify, formatPushedFields, providerName } from '../notify/dispatcher.js';
import { jobQueue, JobCancelled, type Job, type LogFn } from './queue.js';
import { listCbzFiles, mapKavitaPathToLocalPath, mergeCbzFiles, pathContains, editComicInfo, readComicInfo, resolveExistingFile, resolveSeriesHostDir, setComicInfoFields } from '../lib/cbz.js';
import { mapLimit } from '../lib/http.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import type { KavitaSeries } from '../kavita/types.js';
import { prepareMergeDownloads, validMergeChapter, validateMergeDownloads } from './mergeDownloads.js';

type JobFor<T extends JobType> = Omit<Job, 'type' | 'payload'> & { type: T; payload: JobPayloads[T] & JobExecutionState };
type ExecutableJob = { [T in JobType]: JobFor<T> }[JobType];

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



async function matchAndApply(
  client: KavitaClient,
  series: { id: number; name: string },
  libraryId: number | undefined,
  force: boolean,
  log?: LogFn,
  signal?: AbortSignal,
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
    const result = await applyResolvedSeriesMatch(client, {
      seriesId: series.id, providerId: best.providerId, providerSeriesId: best.providerSeriesId,
      score: best.score, confirm: false, signal, historyAction: force ? 'updated' : 'matched',
    }, meta);
    for (const warning of result.warnings) log?.('warn', warning);
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
    if (e instanceof JobCancelled) throw e;
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

/**
 * apply-series job: push one user-selected candidate onto a single series.
 * applySeriesMatch owns the flow and the match-row update; this wrapper adds
 * history and the job summary. Hard failures (missing folder,
 * provider down, rejected title) fail the job with that message — the match
 * row is left as-is, mirroring the old synchronous route's behavior.
 */
async function runApplySeries(client: KavitaClient, job: JobFor<'apply-series'>, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
  const p = job.payload;
  const seriesId = p.seriesId;
  let result: ApplySeriesResult;
  try {
    result = await applySeriesMatch(client, {
      seriesId,
      providerId: p.providerId,
      providerSeriesId: p.providerSeriesId,
      selectedTitle: p.selectedTitle,
      excludedFields: p.excludedFields,
      cover: p.cover,
      score: p.score ?? null,
      isCancelled: () => jobQueue.isCancelRequested(job.id),
      signal,
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
  log(ok && result.warnings.length === 0 ? 'success' : 'warn', `${result.name} -> ${p.providerId}${ok ? '' : ` — ${result.errors.join('; ')}`}`);
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
export function runJob(job: Job, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
  if (job.type === 'check-watched-searches' || job.type === 'scan-matchable' || job.type === 'clear-overrides') return executeJob(job, log, signal);
  // Broad scans, merges, deletes and path-only edits conflict with every series.
  const scoped = ['apply-series', 'sync-series', 'match-series', 'edit-comicinfo'].includes(job.type);
  const ids = [...(job.payload.seriesId === undefined ? [] : [job.payload.seriesId]), ...(job.payload.seriesIds ?? [])];
  return libraryMutations.run(scoped && ids.length ? ids.map(id => `series:${id}`) : ['*'], () => {
    throwIfJobCancelled(job.id);
    return executeJob(job, log, signal);
  }, signal);
}

async function executeJob(job: Job, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
  const command = parseJobCommand(job.type, job.payload);
  const typed = { ...job, type: command.type, payload: { ...job.payload, ...command.payload } } as ExecutableJob;
  invalidateDuplicateLibrary();
  switch (typed.type) {
    case 'scan-matchable': return scanMatchSuggestions({
      checkCancelled: () => throwIfJobCancelled(job.id),
      progress: (current, total) => jobQueue.setProgress(job.id, current, total),
      log,
    });
    case 'check-watched-searches': return runWatchedSearchJob(typed, log);
    case 'edit-comicinfo': return runEditComicInfoJob(typed, log, signal);
    case 'merge-series': return runMergeSeriesJob(typed, log, signal);
    case 'delete-series': return runDeleteSeriesJob(typed, log, signal);
    case 'apply-series': {
      const client = connectedClientOrNull();
      if (!client) throw new Error('Kavita is not configured');
      return runApplySeries(client, typed, log, signal);
    }
    default: return runMatchingJob(typed, log, signal);
  }
}

async function runMatchingJob(job: Job, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
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
    const r = await matchAndApply(client, t, t.libraryId, force, log, signal);
    summary.processed++;
    if (r.matched && r.errors.length === 0) summary.matched++;
    if (r.errors.length > 0) summary.failed++;
    done++;
    jobQueue.setProgress(job.id, done, targets.length);
  });

  return summary;
}

async function runWatchedSearchJob(job: JobFor<'check-watched-searches'>, log: LogFn): Promise<JobResult> {
  const r = await checkWatchedSearches(
    log,
    () => jobQueue.isCancelRequested(job.id),
    (current, total) => jobQueue.setProgress(job.id, current, total),
  );
  return { processed: r.checked, matched: 0, failed: r.failed, notified: r.notified, newGalleries: r.newGalleries };
}

async function runEditComicInfoJob(job: JobFor<'edit-comicinfo'>, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
  throwIfJobCancelled(job.id);
  const p = job.payload.path;
  if (!p) throw new Error('path required');
  const file = resolveExistingFile(p);
  if (!file) throw new Error(`File not found: ${p}`);
  throwIfJobCancelled(job.id);
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
  throwIfJobCancelled(job.id);
  const { previousSeriesName, xml } = await editComicInfo(file, job.payload, signal);
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

async function runMergeSeriesJob(job: JobFor<'merge-series'>, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
  let sourceFiles = job.payload.sourceFiles ?? [];
  validateMergeDownloads(job.payload.downloads);
  if (!sourceFiles.length && !job.payload.downloads?.length) throw new Error('At least one .cbz file or gallery is required');
  throwIfJobCancelled(job.id);
  for (const file of sourceFiles) if (!resolveExistingFile(file) || !file.toLowerCase().endsWith('.cbz')) throw new Error(`Source archive not found: ${file}`);
  for (const number of Object.values(job.payload.chapters ?? {})) if (!validMergeChapter(number)) throw new Error('Incoming chapter numbers must be positive numbers or blank');
  let targetDir = job.payload.targetDir;
  const renamedSeries = job.payload.seriesName?.trim();
  let stampName: string | undefined = renamedSeries;
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
    stampName ??= (await pickSeriesStampName(dir, new Set(sourceFiles.map((f) => path.resolve(f))))) ?? s.name;
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
  }, signal);
  throwIfJobCancelled(job.id);
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
  if (renamedSeries) {
    // Include every target archive, even chapters with no number edit and
    // incoming files whose first metadata write failed. A retry can repair
    // a partial rename without downloading completed galleries again.
    for (const file of listCbzFiles(targetDir)) {
      throwIfJobCancelled(job.id);
      const xml = await readComicInfo(file);
      if (!xml || parseComicInfo(xml).fields.Series !== renamedSeries) await setComicInfoFields(file, { Series: renamedSeries });
    }
    throwIfJobCancelled(job.id);
    if (job.payload.seriesId != null) {
      const client = connectedClientOrNull();
      if (!client) throw new Error('Kavita is required to finish the series rename. Retry the merge after reconnecting.');
      await client.updateSeriesMetadata(job.payload.seriesId, { name: renamedSeries });
      rememberTargets(job, [{ id: job.payload.seriesId, name: renamedSeries, libraryId: targetLibraryId! }]);
    }
    log('success', `Set merged series name to "${renamedSeries}" in all target archives`);
  }
  log('success', `Moved ${r.moved.length} file(s) into one folder as "${stampName ?? lastSegment(targetDir)}"; stamped chapter numbers on ${r.chaptered.length}`);
  await removeSourceSeriesFromKavita(sourceSeriesIds, log);
  await rescanAndVerifyMerge(targetDir, r.moved, log, { job, seriesId: job.payload.seriesId ?? null, libraryId: targetLibraryId, seriesName: job.payload.seriesId == null ? renamedSeries : undefined });
  invalidateDuplicateLibrary();
  return { processed: r.moved.length, matched: 0, failed: r.failed.length + chapterEditFailures };
}

async function runDeleteSeriesJob(job: JobFor<'delete-series'>, log: LogFn, signal?: AbortSignal): Promise<JobResult> {
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
  const archives = await archiveMutations.run([archiveResource(dir)], async () => {
    throwIfJobCancelled(job.id);
    const count = listCbzFiles(dir).length;
    log('info', `Deleting ${dir} (${count} archive(s))`);
    await fs.promises.rm(dir, { recursive: true });
    log('success', `Deleted ${dir}`);
    return count;
  }, signal);
  try {
    await client.scanLibrary(lib.id);
    log('info', `Requested Kavita rescan of "${lib.name}" so the series record is dropped`);
  } catch (e) {
    log('warn', `Kavita rescan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { deleted: archives };
}
