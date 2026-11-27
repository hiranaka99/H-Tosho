import fs from "node:fs/promises";
import path from "node:path";
import type { DownloadDiscoveryCommand } from "../contracts/jobs.js";
import { jobQueue, JobCancelled, type Job, type LogFn } from "../jobs/queue.js";
import {
  rememberLibraries,
  rememberTargets,
  throwIfJobCancelled,
} from "../jobs/context.js";
import { KavitaClient } from "../kavita/client.js";
import {
  libraryContainingPath,
  mapKavitaPathToLocalPath,
  mapLocalPathToKavita,
} from "../kavita/libraryPaths.js";
import { waitForScan } from "../kavita/scans.js";
import { pathContains } from "../lib/paths.js";
import { sleep } from "../lib/http.js";
import { getDownloaderSettings, getKavitaConnection } from "./settings.js";
import {
  currentMatchConnection,
  scanMatchSuggestions,
} from "./matchSuggestions.js";

/** Persist follow-up work; provider availability must never hold a download open. */
export function queueDownloadedMatchDiscovery(
  outputPath: string,
  seriesName?: string
): number | undefined {
  const connection = getKavitaConnection();
  if (!connection.baseUrl || !connection.apiKey) return;
  const command: DownloadDiscoveryCommand = {
    path: path.resolve(outputPath),
    connectionKey: currentMatchConnection(),
    ...(seriesName?.trim() ? { seriesName: seriesName.trim() } : {}),
  };
  // A completion during a running check needs a follow-up, but queued checks can coalesce.
  const queued = jobQueue
    .active()
    .find(
      (job) =>
        job.type === "scan-downloaded" &&
        job.status === "queued" &&
        job.payload.path === command.path &&
        job.payload.connectionKey === command.connectionKey
    );
  return queued?.id ?? jobQueue.enqueue("scan-downloaded", command);
}

/** Import only the completed output, then discover review candidates without applying them. */
export async function runDownloadedMatchDiscovery(
  job: Job & { payload: DownloadDiscoveryCommand },
  log: LogFn,
  signal?: AbortSignal
) {
  const check = () => {
    throwIfJobCancelled(job.id);
    if (signal?.aborted) throw new JobCancelled();
    if (currentMatchConnection() !== job.payload.connectionKey)
      throw new Error(
        "Kavita connection changed after this download. Retry with the original connection."
      );
  };
  check();
  const connection = getKavitaConnection();
  if (!connection.baseUrl || !connection.apiKey)
    throw new Error("Kavita is not configured");
  const client = new KavitaClient(connection.baseUrl, connection.apiKey);
  const mappings = getDownloaderSettings().libraryPathMappings ?? [];
  const libraries = await client.getLibraries();
  check();
  const library = libraryContainingPath(libraries, job.payload.path, mappings);
  if (!library)
    throw new Error(
      "Could not locate the Kavita library folder for this download. Check the shared mount and library folder mappings, then retry."
    );
  rememberLibraries(job, [library]);
  jobQueue.setProgress(job.id, 0, 1);
  const isArchive = job.payload.path.toLowerCase().endsWith(".cbz");
  const outputDir = isArchive
    ? path.dirname(job.payload.path)
    : job.payload.path;
  const realpathCache = new Map<string, string>();
  const realpathAsync = async (filePath: string): Promise<string> => {
    const resolved = path.resolve(filePath);
    const hit = realpathCache.get(resolved);
    if (hit !== undefined) return hit;
    let real = resolved;
    try {
      real = await fs.realpath(resolved);
    } catch {
      /* path may not exist on this host yet */
    }
    realpathCache.set(resolved, real);
    return real;
  };
  const stripTrailing = (value: string) => {
    const cleaned = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
  };
  await Promise.all(
    mappings.map((mapping) => realpathAsync(mapping.localPath))
  );
  const targetDir = stripTrailing(await realpathAsync(outputDir));
  const targetFile = stripTrailing(await realpathAsync(job.payload.path));
  const normalize = async (value: string): Promise<string> => {
    const mapped = mapKavitaPathToLocalPath(value, mappings) ?? value;
    const pure = stripTrailing(path.resolve(mapped));
    if (pure === targetDir || pure === targetFile) return pure;
    return stripTrailing(await realpathAsync(mapped));
  };
  await client.scanFolder(
    library.id,
    mapLocalPathToKavita(outputDir, mappings)
  );
  check();
  log("info", `Requested Kavita import of ${outputDir}`);
  // Kavita can defer a scan while another is running. Keep the job visible and
  // cancellable until the new record appears; do not mistake an idle read for no match.
  const deadline = Date.now() + 20 * 60_000;
  const scanned = await waitForScan(client, {
    deadline,
    pollMs: 2_000,
    checkCancelled: check,
    signal,
  });
  check();
  if (scanned !== "completed")
    throw new Error(
      `Kavita import ${scanned === "timed-out" ? "timed out" : "status could not be verified"}. Retry this discovery job after checking Kavita.`
    );
  for (;;) {
    check();
    const series = await client.getSeries(library.id);
    check();
    const targets = [];
    for (const item of series) {
      let found =
        !!item.folderPath && (await normalize(item.folderPath)) === targetDir;
      // ComicInfo.Series can group this download into a series in another folder.
      // Verify its files rather than trusting an equal title or guessing by folder name.
      if (
        !found &&
        job.payload.seriesName &&
        item.name.trim().toLowerCase() ===
          job.payload.seriesName.trim().toLowerCase()
      ) {
        const chapters = await client.getChaptersBySeries(item.id);
        check();
        for (const chapter of chapters) {
          for (const file of chapter.files ?? []) {
            if (!file.filePath) continue;
            const normPath = await normalize(file.filePath);
            if (
              isArchive
                ? normPath === targetFile
                : pathContains(targetDir, normPath)
            ) {
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      if (found) targets.push({ ...item, libraryName: library.name });
    }
    if (targets.length) {
      rememberTargets(job, targets);
      return scanMatchSuggestions({
        targets,
        checkCancelled: check,
        log,
        signal,
        progress: (current, total) =>
          jobQueue.setProgress(job.id, current, total),
      });
    }
    if (Date.now() >= deadline)
      throw new Error(
        "Kavita has not indexed this downloaded gallery yet. Check its library and retry this discovery job."
      );
    await sleep(Math.min(5_000, deadline - Date.now()));
  }
}
