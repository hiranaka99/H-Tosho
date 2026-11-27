import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { downloadQueue } from "../downloader/engine.js";
import { registerDownloadPublicationGuard } from "../downloader/publishGuard.js";
import { registerJobLifecycleHook } from "../jobs/lifecycle.js";
import { jobQueue } from "../jobs/queue.js";
import { KavitaClient } from "../kavita/client.js";
import { queueDownloadedMatchDiscovery } from "../services/downloadDiscovery.js";
import {
  findDuplicateReports,
  invalidateDuplicateLibrary,
  prepareDuplicateCheck,
} from "../services/galleryDuplicates.js";
import { kavitaConnectionKey } from "../services/kavitaState.js";
import {
  getDownloaderSettings,
  getKavitaConnection,
} from "../services/settings.js";
import {
  createProtectedMerge,
  type KavitaMergePort,
  type KavitaMergeSession,
  type MergeAuxPort,
  type MergeDownloadPort,
  type MergeJobPort,
  type MergeSettingsPort,
} from "./protectedMerge.js";

export { createProtectedMerge, ProtectedMergeError } from "./protectedMerge.js";
export type * from "./types.js";

/** Production HTTP adapter over live Kavita connection settings. */
export function createHttpKavitaMergeAdapter(): KavitaMergePort {
  return {
    connectionKey: () => kavitaConnectionKey(getKavitaConnection().baseUrl),
    current: (): KavitaMergeSession | null => {
      const conn = getKavitaConnection();
      if (!conn.baseUrl || !conn.apiKey) return null;
      const client = new KavitaClient(conn.baseUrl, conn.apiKey);
      const connectionKey = kavitaConnectionKey(conn.baseUrl);
      return {
        connectionKey,
        getLibraries: () => client.getLibraries(),
        getSeries: (libraryId) => client.getSeries(libraryId),
        getSeriesById: (seriesId) => client.getSeriesById(seriesId),
        getChaptersBySeries: (seriesId) => client.getChaptersBySeries(seriesId),
        scanLibrary: (libraryId) => client.scanLibrary(libraryId),
        scanSeries: (libraryId, seriesId) =>
          client.scanSeries(libraryId, seriesId),
        deleteSeries: (seriesId) => client.deleteSeries(seriesId),
        updateSeriesMetadata: (seriesId, patch) =>
          client.updateSeriesMetadata(seriesId, patch),
        isTaskRunning: () => client.isTaskRunning(),
        getSeriesDto: (seriesId) => client.getSeriesDto(seriesId),
        getSeriesMetadata: (seriesId) => client.getSeriesMetadata(seriesId),
      };
    },
  };
}

const productionSettings: MergeSettingsPort = {
  getDownloaderPaths: () => {
    const dl = getDownloaderSettings();
    return {
      downloadDirectory: dl.downloadDirectory,
      libraryPathMappings: dl.libraryPathMappings ?? [],
    };
  },
};

/** Lazy closures avoid circular module-init coupling with `downloader/engine.ts`. */
const productionDownloads: MergeDownloadPort = {
  get: (id) => downloadQueue.get(id),
  findActive: (source, galleryId) =>
    downloadQueue.findActive(source, galleryId),
  findCompleted: (source, galleryId) =>
    downloadQueue.findCompleted(source, galleryId),
  hasPendingRetry: (id) => downloadQueue.hasPendingRetry(id),
  isRunning: (id) => downloadQueue.isRunning(id),
  enqueueForMerge: (plan) =>
    downloadQueue.enqueue(
      plan.source,
      plan.galleryId,
      plan.title,
      "cbz",
      undefined,
      plan.chapter,
      0,
      plan.mergeJobId,
      plan.url
    ),
  retry: (id) => downloadQueue.retry(id),
  cancel: (id) => downloadQueue.cancel(id),
  cancelByMergeJob: (mergeJobId) => {
    for (const task of getDb()
      .select({ id: schema.downloadQueue.id })
      .from(schema.downloadQueue)
      .where(eq(schema.downloadQueue.mergeJobId, mergeJobId))
      .all()) {
      downloadQueue.cancel(task.id);
    }
  },
  attachToMergeJob: (downloadIds, mergeJobId) => {
    if (!downloadIds.length) return;
    getDb()
      .update(schema.downloadQueue)
      .set({ mergeJobId })
      .where(inArray(schema.downloadQueue.id, [...downloadIds]))
      .run();
  },
  reassignMergeJob: (downloadId, fromMergeJobId, toMergeJobId) => {
    getDb()
      .update(schema.downloadQueue)
      .set({ mergeJobId: toMergeJobId })
      .where(
        and(
          eq(schema.downloadQueue.id, downloadId),
          eq(schema.downloadQueue.mergeJobId, fromMergeJobId)
        )
      )
      .run();
  },
  markOutputPublished: (oldPath, newPath) => {
    getDb()
      .update(schema.downloadQueue)
      .set({ outputPath: newPath, mergeJobId: null })
      .where(eq(schema.downloadQueue.outputPath, oldPath))
      .run();
  },
  subscribe: (listener) => downloadQueue.subscribe((task) => listener(task)),
  subscribeRemovals: (listener) => downloadQueue.subscribeRemovals(listener),
};

const productionJobs: MergeJobPort = {
  get: (id) => jobQueue.get(id),
  enqueueMergeJob: (command, initialState) =>
    jobQueue.enqueue("merge-series", command, initialState),
  setProgress: (jobId, current, total) =>
    jobQueue.setProgress(jobId, current, total),
  isCancelRequested: (jobId) => jobQueue.isCancelRequested(jobId),
  updateContext: (jobId, context) => {
    jobQueue.updateContext(jobId, context);
  },
  invalidateContextCache: (jobIds) => jobQueue.invalidateContextCache(jobIds),
};

const productionAux: MergeAuxPort = {
  checkDownloadDuplicates: async (plans, sourceFiles) => {
    const identities = await prepareDuplicateCheck(plans);
    const check = findDuplicateReports(identities, sourceFiles);
    return new Set(
      check.reports
        .filter((report) => report.matches.length)
        .map((report) => `${report.source}:${report.galleryId}`)
    );
  },
  invalidateDuplicateLibrary,
  queueMatchDiscovery: queueDownloadedMatchDiscovery,
};

/** Default wired Protected Merge module for server runtime callers. */
export const protectedMerge = createProtectedMerge({
  kavita: createHttpKavitaMergeAdapter(),
  settings: productionSettings,
  downloads: productionDownloads,
  jobs: productionJobs,
  aux: productionAux,
});

registerJobLifecycleHook("merge-series", protectedMerge.jobLifecycleHook);
registerDownloadPublicationGuard((target, commit, signal) =>
  protectedMerge.guardDownloadPublication(target, commit, signal)
);
