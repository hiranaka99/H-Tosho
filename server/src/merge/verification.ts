import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { JobCancelled } from "../jobs/lifecycle.js";
import type { LogFn } from "../jobs/queue.js";
import { kavitaNormalizeName } from "../kavita/client.js";
import { mapKavitaPathToLocalPath } from "../kavita/libraryPaths.js";
import { waitForScan } from "../kavita/scans.js";
import type { KavitaChapterDto } from "../kavita/types.js";
import { mapLimit } from "../lib/http.js";
import { archiveResourceAsync } from "../lib/mutations.js";
import { lastSegment, pathContains } from "../lib/paths.js";
import type {
  KavitaMergeClient,
  MergeJobPort,
  MergeSettingsPort,
  ResolvedMergeTiming,
} from "./types.js";

const realpathAsync = promisify(fs.realpath);
async function safeRealpathAsync(targetPath: string): Promise<string> {
  try {
    return await realpathAsync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/** Delete only the source series records resolved before their folders were moved. */
export async function removeVacantSourceSeries(
  client: KavitaMergeClient,
  settings: MergeSettingsPort,
  seriesIds: number[],
  log: LogFn,
  targetDir: string,
  beforeDelete: (seriesId: number) => Promise<boolean>
): Promise<void> {
  if (seriesIds.length === 0) return;
  const deleted: number[] = [];
  const mappings = settings.getDownloaderPaths().libraryPathMappings ?? [];
  const targetKey = await archiveResourceAsync(targetDir);
  for (const id of seriesIds) {
    if (!(await beforeDelete(id))) continue;
    try {
      const chapters = await client.getChaptersBySeries(id);
      let remaining = false;
      for (const chapter of chapters) {
        for (const file of chapter.files ?? []) {
          if (!file.filePath) continue;
          const local =
            mapKavitaPathToLocalPath(file.filePath, mappings) ?? file.filePath;
          const exists = await fs.promises.access(local).then(
            () => true,
            () => false
          );
          if (
            exists &&
            !pathContains(targetKey, await archiveResourceAsync(local))
          ) {
            remaining = true;
            break;
          }
        }
        if (remaining) break;
      }
      if (remaining) continue;
    } catch (error) {
      if (error instanceof JobCancelled) throw error;
      log(
        "warn",
        `Could not verify vacant source series ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    // An asynchronous scan can regroup a source ID into the target while the chapter lookup is in flight.
    if (!(await beforeDelete(id))) continue;
    try {
      await client.deleteSeries(id);
      deleted.push(id);
      log(
        "info",
        `Removed stale Kavita series ${id} — its files now live in the merged folder`
      );
    } catch (error) {
      if (error instanceof JobCancelled) throw error;
      log(
        "warn",
        `Could not delete Kavita series ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (deleted.length > 0) {
    getDb()
      .delete(schema.seriesMatches)
      .where(inArray(schema.seriesMatches.kavitaSeriesId, deleted))
      .run();
  }
}

/**
 * Rescan the merged folder and verify that every moved archive lands in Kavita
 * under one unambiguous series identity, outliving Kavita's 10-minute scan deferral.
 */
export async function rescanAndVerifyMerge(
  client: KavitaMergeClient,
  settings: MergeSettingsPort,
  jobs: MergeJobPort,
  timing: ResolvedMergeTiming,
  targetDir: string,
  movedFiles: string[],
  log: LogFn,
  opts: {
    jobId: number;
    seriesId?: number | null;
    libraryId?: number | null;
    seriesName?: string;
    signal?: AbortSignal;
    beforeRename?: (seriesId: number) => Promise<void>;
  }
): Promise<{ id: number; libraryId: number; name: string } | undefined> {
  const checkCancelled = () => {
    if (opts.signal?.aborted || jobs.isCancelRequested(opts.jobId))
      throw new JobCancelled();
  };
  try {
    const libraries = await client.getLibraries();
    const mappings = settings.getDownloaderPaths().libraryPathMappings ?? [];
    let lib =
      opts.libraryId != null
        ? libraries.find((l) => l.id === opts.libraryId)
        : undefined;
    if (!lib) {
      const realTarget = await safeRealpathAsync(targetDir);
      for (const candidate of libraries) {
        const rootPaths = await Promise.all(
          (candidate.paths ?? (candidate.path ? [candidate.path] : [])).map(
            (root) =>
              safeRealpathAsync(
                mapKavitaPathToLocalPath(root, mappings) ?? root
              )
          )
        );
        if (rootPaths.some((root) => pathContains(root, realTarget))) {
          lib = candidate;
          break;
        }
      }
    }
    if (!lib) {
      log(
        "warn",
        "No mapped Kavita library contains this output folder — archives remain outside indexed series policy coverage"
      );
      return;
    }
    const library = lib;
    jobs.updateContext(opts.jobId, {
      series: [],
      libraryId: library.id,
      libraryName: library.name,
    });
    const renamedIds = new Set<number>();
    const renameSeries = async (
      series: { id: number; name: string } | undefined
    ) => {
      if (!series || !opts.seriesName || renamedIds.has(series.id)) return;
      checkCancelled();
      if (series.name === opts.seriesName) return;
      await opts.beforeRename?.(series.id);
      await client.updateSeriesMetadata(series.id, { name: opts.seriesName });
      const observed = await client.getSeriesById(series.id);
      if (observed.id !== series.id || observed.libraryId !== library.id) {
        throw new Error(
          "Kavita returned a changed series identity after merge rename"
        );
      }
      series.name = observed.name;
      renamedIds.add(series.id);
      jobs.updateContext(opts.jobId, {
        series: [{ id: series.id, name: series.name }],
        libraryId: library.id,
      });
      log(
        series.name === opts.seriesName ? "success" : "warn",
        series.name === opts.seriesName
          ? `Set Kavita series name to "${series.name}"`
          : "Kavita did not confirm the requested merge title"
      );
    };

    const [expectedList, realTargetDir] = await Promise.all([
      mapLimit(movedFiles, 16, archiveResourceAsync),
      archiveResourceAsync(targetDir),
    ]);
    const expectedNames = new Set(expectedList);
    const dirKeyCache = new Map<string, string>();
    const cachedDirKey = async (localPath: string): Promise<string> => {
      const hit = dirKeyCache.get(localPath);
      if (hit !== undefined) return hit;
      const key = await archiveResourceAsync(localPath);
      dirKeyCache.set(localPath, key);
      return key;
    };
    const toIndexedSet = async (
      chapters: KavitaChapterDto[]
    ): Promise<Set<string>> => {
      const paths = chapters.flatMap((chapter) =>
        (chapter.files ?? [])
          .map((f) => f.filePath)
          .filter((fp): fp is string => !!fp)
      );
      const keys = await mapLimit(paths, 16, (fp) =>
        archiveResourceAsync(mapKavitaPathToLocalPath(fp, mappings) ?? fp)
      );
      return new Set(keys);
    };
    const indexedNames = async (seriesId: number): Promise<Set<string>> =>
      toIndexedSet(await client.getChaptersBySeries(seriesId));

    const targetNormName = kavitaNormalizeName(
      opts.seriesName ?? lastSegment(targetDir)
    );
    const findSeries = async (): Promise<
      { id: number; name: string; indexedFiles?: Set<string> } | undefined
    > => {
      if (opts.seriesId != null) {
        try {
          const s = await client.getSeriesById(opts.seriesId);
          jobs.updateContext(opts.jobId, {
            series: [{ id: s.id, name: s.name }],
            libraryId: library.id,
          });
          return { id: s.id, name: s.name };
        } catch {
          // A verified regroup may replace the numeric target ID; fall back to exact indexed ownership.
        }
      }
      const series = await client.getSeries(library.id);
      const likely: typeof series = [];
      const rest: typeof series = [];
      await Promise.all(
        series.map(async (item) => {
          const mapped = item.folderPath
            ? mapKavitaPathToLocalPath(item.folderPath, mappings)
            : null;
          if (!mapped) {
            likely.push(item);
            return;
          }
          const dirKey = await cachedDirKey(mapped);
          if (
            pathContains(realTargetDir, dirKey) ||
            pathContains(dirKey, realTargetDir) ||
            (targetNormName &&
              kavitaNormalizeName(item.name) === targetNormName)
          ) {
            likely.push(item);
          } else {
            rest.push(item);
          }
        })
      );
      const inspectGroup = async (group: typeof series) => {
        const hits: { id: number; name: string; indexedFiles: Set<string> }[] =
          [];
        await mapLimit(group, 8, async (item) => {
          const indexed = await toIndexedSet(
            await client.getChaptersBySeries(item.id)
          );
          for (const fileKey of expectedNames) {
            if (indexed.has(fileKey)) {
              hits.push({
                id: item.id,
                name: item.name,
                indexedFiles: indexed,
              });
              break;
            }
          }
        });
        return hits;
      };
      let candidates = await inspectGroup(likely);
      if (candidates.length === 0 && rest.length > 0)
        candidates = await inspectGroup(rest);
      if (candidates.length > 1)
        throw new Error("Moved archives are indexed under multiple series");
      const found = candidates[0];
      if (found)
        jobs.updateContext(opts.jobId, {
          series: [{ id: found.id, name: found.name }],
          libraryId: library.id,
        });
      return found;
    };

    const deadline = timing.now() + timing.mergeVerifyTimeoutMs;
    let series = await findSeries().catch(() => undefined);
    for (;;) {
      await renameSeries(series);
      if (series) {
        await client.scanSeries(library.id, series.id);
        log("info", `Requested Kavita rescan of series "${series.name}"`);
      } else {
        await client.scanLibrary(library.id);
        log("info", `Requested Kavita rescan of "${library.name}"`);
      }
      const outcome = await waitForScan(client, {
        deadline,
        pollMs: timing.scanPollMs,
        graceMs: timing.scanGraceMs,
        checkCancelled,
        signal: opts.signal,
        now: timing.now,
        sleep: timing.sleep,
      });
      if (outcome !== "completed")
        log("warn", `Kavita scan for series "${library.name}": ${outcome}`);

      const after = await findSeries().catch(() => undefined);
      await renameSeries(after);
      let missing: string[] | null = null;
      if (after) {
        try {
          const indexed = after.indexedFiles ?? (await indexedNames(after.id));
          missing = [...expectedNames].filter((n) => !indexed.has(n));
        } catch {
          /* chapter list unavailable — treat as not yet indexed */
        }
      }
      if (missing !== null && missing.length === 0) {
        log(
          "success",
          `Kavita has indexed all ${movedFiles.length} moved file(s) into the merged series`
        );
        return { id: after!.id, libraryId: library.id, name: after!.name };
      }
      log(
        "info",
        !after
          ? "Merged series not registered in Kavita yet — waiting for the scan"
          : missing && missing.length > 0
            ? `Kavita is still indexing ${missing.length} of ${movedFiles.length} moved file(s): ${missing.join(", ")}`
            : "Waiting for Kavita to finish writing the series"
      );
      if (timing.now() >= deadline) {
        log(
          "warn",
          missing && missing.length > 0
            ? `Kavita did not index ${missing.length} of ${movedFiles.length} moved file(s) within ${timing.mergeVerifyTimeoutMs / 60_000} minutes: ${missing.join(", ")} — run a manual scan in Kavita`
            : `Kavita merge verification timed out after ${timing.mergeVerifyTimeoutMs / 60_000} minutes — run a manual scan in Kavita`
        );
        return;
      }
      series = after;
      await timing.sleep(timing.scanPollMs, opts.signal);
    }
  } catch (error) {
    if (error instanceof JobCancelled) throw error;
    throw new Error(
      `Archives were merged, but Kavita could not verify their target identity. Retry the merge: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
