import { waitForScan, type ScanOutcome } from "./scans.js";
import path from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import { KavitaClient } from "./client.js";
import type { KavitaChapterDto } from "./types.js";
import {
  getDownloaderSettings,
  getKavitaConnection,
} from "../services/settings.js";
import { lastSegment, pathContains } from "../lib/paths.js";
import { mapKavitaPathToLocalPath } from "./libraryPaths.js";
import { sleep } from "../lib/http.js";
import { type LogFn } from "../jobs/queue.js";
import { throwIfJobCancelled } from "../jobs/context.js";
const realpathAsync = promisify(fs.realpath);
async function safeRealpathAsync(targetPath: string): Promise<string> {
  try {
    return await realpathAsync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function normLocalPath(targetPath: string): string {
  const clean = path
    .resolve(targetPath)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? clean.toLowerCase() : clean;
}

/** Best-effort Kavita refresh after a local ComicInfo edit. */
export async function rescanLibraryContainingDir(
  dir: string,
  log: LogFn,
  seriesName?: string
): Promise<void> {
  try {
    const conn = getKavitaConnection();
    if (!conn.baseUrl || !conn.apiKey) return;
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    const libraries = await client.getLibraries();
    const realDir = await safeRealpathAsync(dir);
    const normDir = normLocalPath(dir);
    const candidates = new Set<string>();
    // Walk both the literal path and its realpath: symlinked mount points resolve to one real path.
    for (const start of [dir, realDir]) {
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
    const mappings = getDownloaderSettings().libraryPathMappings ?? [];
    const mappedLocalRoots = await Promise.all(
      mappings.map((m) => safeRealpathAsync(m.localPath))
    );
    const inMappedRoot = mappedLocalRoots.some((root) =>
      pathContains(root, realDir)
    );

    const evaluated = await Promise.all(
      libraries.map(async (lib) => {
        const rootPaths = await Promise.all(
          (lib.paths ?? (lib.path ? [lib.path] : [])).map((root) =>
            safeRealpathAsync(mapKavitaPathToLocalPath(root, mappings) ?? root)
          )
        );
        const directLibrary = rootPaths.some((root) =>
          pathContains(root, realDir)
        );
        const libRootName = lib.path ? lastSegment(lib.path).toLowerCase() : "";
        const matchingLibrary =
          directLibrary ||
          (!inMappedRoot &&
            Boolean(libRootName && candidates.has(libRootName)));
        return { lib, directLibrary, matchingLibrary };
      })
    );
    const ordered = evaluated
      .filter(({ directLibrary }) => !inMappedRoot || directLibrary)
      .sort((a, b) => Number(b.matchingLibrary) - Number(a.matchingLibrary));

    for (const { lib, matchingLibrary } of ordered) {
      let series;
      try {
        series = await client.getSeries(lib.id);
      } catch {
        continue;
      }
      let hit: (typeof series)[number] | undefined;
      for (const s of series) {
        if (!s.folderPath) continue;
        const mapped = mapKavitaPathToLocalPath(s.folderPath, mappings);
        if (!mapped) {
          if (
            !inMappedRoot &&
            candidates.has(lastSegment(s.folderPath).toLowerCase())
          ) {
            hit = s;
            break;
          }
          continue;
        }
        if (
          normLocalPath(mapped) === normDir ||
          (await safeRealpathAsync(mapped)) === realDir
        ) {
          hit = s;
          break;
        }
      }
      if (hit) {
        if (seriesName) {
          await client.updateSeriesMetadata(hit.id, { name: seriesName });
          log("info", `Updated Kavita series name to "${seriesName}"`);
        }
        await client.scanSeries(lib.id, hit.id);
        log(
          "info",
          `Requested Kavita rescan of series "${seriesName || hit.name}"`
        );
        return;
      }
      if (matchingLibrary) {
        await client.scanLibrary(lib.id);
        log("info", `Requested Kavita rescan of "${lib.name}"`);
        return;
      }
    }
    log(
      "warn",
      "No Kavita library contains this folder — rescan skipped, the periodic scan will pick it up"
    );
  } catch (e) {
    log(
      "warn",
      `Kavita rescan failed: ${e instanceof Error ? e.message : String(e)}`
    );
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
  client: KavitaClient,
  log: LogFn,
  what: string,
  deadline: number,
  jobId?: number
): Promise<ScanOutcome> {
  const outcome = await waitForScan(client, {
    deadline,
    pollMs: SCAN_STATUS_POLL_MS,
    graceMs: SCAN_TASK_GRACE_MS,
    checkCancelled:
      jobId === undefined ? undefined : () => throwIfJobCancelled(jobId),
  });
  if (outcome !== "completed")
    log("warn", `Kavita scan for ${what}: ${outcome}`);
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
  jobId: number
): Promise<void> {
  const fileName = path.basename(file).toLowerCase();
  const timeoutMs = editVerifyTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const target =
    expectedNumber === null
      ? fileName
      : `${fileName} as chapter ${expectedNumber}`;
  const timeoutError = () =>
    new Error(
      `Kavita did not confirm ${target} within ${timeoutMs / 60_000} minutes. ComicInfo.xml was saved — run a manual scan in Kavita`
    );
  let nextScanAt = 0;
  for (;;) {
    throwIfJobCancelled(jobId);
    if (Date.now() >= deadline) throw timeoutError();
    if (Date.now() >= nextScanAt) {
      await client.scanSeries(libraryId, seriesId);
      nextScanAt = Date.now() + EDIT_RESCAN_RETRY_MS;
      log("info", `Requested Kavita rescan of series ${seriesId}`);
      throwIfJobCancelled(jobId);
      const drained = await waitForKavitaTasksToDrain(
        client,
        log,
        `series ${seriesId}`,
        deadline,
        jobId
      );
      throwIfJobCancelled(jobId);
      if (drained === "timed-out") throw timeoutError();
      if (drained === "status-unavailable" && expectedNumber === null)
        throw new Error(
          "ComicInfo.xml was saved, but Kavita scan status could not be verified. Retry after checking the connection."
        );
      if (expectedNumber === null) return; // scan cycle complete; no number to check
    }
    let chapters: KavitaChapterDto[];
    try {
      chapters = await client.getChaptersBySeries(seriesId);
    } catch (error) {
      throwIfJobCancelled(jobId);
      // A deleted/recreated series can return 401 here even with a valid key.
      // Another scan against the same stale ID cannot repair that lookup.
      throw new Error(
        `Could not verify chapter indexing for Kavita series ${seriesId}: ${error instanceof Error ? error.message : String(error)}. ComicInfo.xml was saved — refresh the library and check the current series in Kavita`
      );
    }
    throwIfJobCancelled(jobId);
    if (chapters) {
      const matches = chapters.filter((ch) =>
        (ch.files ?? []).some(
          (f) =>
            f.filePath && path.basename(f.filePath).toLowerCase() === fileName
        )
      );
      const found = matches.length ? String(matches[0].number ?? "") : null;
      // Kavita can attach a renumbered file to its new chapter without removing
      // the old chapter's file entry. Check every match so response order cannot
      // turn that inconsistency into either endless retries or false success.
      if (
        found !== null &&
        matches.some(
          (ch) => !chapterNumberMatches(String(ch.number ?? ""), found)
        )
      ) {
        const entries = matches
          .map((ch) => `chapter ${ch.number ?? ""} (ID ${ch.id})`)
          .join(", ");
        throw new Error(
          `Kavita indexes ${fileName} under conflicting chapters: ${entries}. ComicInfo.xml was saved — resolve the duplicate chapter entries in Kavita before retrying`
        );
      }
      if (
        found !== null &&
        expectedNumber !== null &&
        chapterNumberMatches(found, expectedNumber)
      ) {
        log(
          "success",
          `Kavita has indexed ${fileName} as chapter ${expectedNumber}`
        );
        return;
      }
      log(
        "info",
        found === null
          ? `${fileName} not indexed in Kavita yet — waiting for the scan`
          : `Kavita still shows ${fileName} as chapter "${found}" (expected "${expectedNumber}") — waiting for the scan`
      );
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
export async function runKavitaLibraryScan(
  client: KavitaClient,
  libs: { id: number; name: string; lastModified?: string }[],
  jobId: number,
  log: LogFn
): Promise<void> {
  if (libs.length === 0) return;
  if (libs.length === 1) {
    await client.scanLibrary(libs[0].id);
    log("info", `Requested Kavita scan of "${libs[0].name}"`);
  } else {
    await client.scanAllLibraries();
    log("info", `Requested Kavita scan of all ${libs.length} libraries`);
  }
  await waitForKavitaTasksToDrain(
    client,
    log,
    "library scan",
    Date.now() + SCAN_WAIT_TIMEOUT_MS,
    jobId
  );
}
