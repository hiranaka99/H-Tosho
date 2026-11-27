import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import type { DoujinSource } from "../src/contracts/doujin.js";
import type { DownloadTask } from "../src/contracts/downloads.js";
import type {
  KavitaChapterDto,
  KavitaLibrary,
  KavitaSeries,
} from "../src/kavita/types.js";
import type {
  KavitaMergePort,
  MergeDownloadPort,
  ProtectedMerge,
} from "../src/merge/types.js";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-protected-merge-")
);
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb, getDb, schema } = await import("../src/db/index.js");
const { createProtectedMerge, protectedMerge, ProtectedMergeError } =
  await import("../src/merge/index.js");
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } =
  await import("../src/services/settings.js");
const { getFieldPolicy, saveFieldPolicy } =
  await import("../src/services/fieldPolicies.js");
const { listMetadataHistory, metadataHistoryDetail } =
  await import("../src/services/metadataHistory.js");
const { buildZip } = await import("../src/downloader/zip.js");
const { parseComicInfo } = await import("../src/downloader/comicinfo.js");
const { readComicInfo, editComicInfo, hashArchiveFile } =
  await import("../src/lib/cbz.js");
const { archiveMutations, archiveResource, libraryMutations } =
  await import("../src/lib/mutations.js");
const { jobQueue, JobCancelled } = await import("../src/jobs/queue.js");
const { registerDownloadPublicationGuard } =
  await import("../src/downloader/publishGuard.js");
const { registerJobLifecycleHook } = await import("../src/jobs/lifecycle.js");
const { downloadQueue } = await import("../src/downloader/engine.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const { api: previewApi } =
  await import("../src/routes/api/mergeProtection.js");
const { api: downloadsApi } = await import("../src/routes/api/downloads.js");
const { api: rootApi } = await import("../src/routes/api.js");

initDb();
const originalFetch = globalThis.fetch;
const originalProvider = doujinProviders.hitomi;
afterEach(() => {
  globalThis.fetch = originalFetch;
  doujinProviders.hitomi = originalProvider;
});
after(async () => {
  await downloadQueue.shutdown(500);
});

let nextId = 1000;

function writeCbz(
  file: string,
  xml: string,
  extra: { name: string; data: Buffer }[] = []
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    buildZip([...extra, { name: "ComicInfo.xml", data: Buffer.from(xml) }])
  );
}

async function comicFields(file: string) {
  return parseComicInfo((await readComicInfo(file))!).fields;
}

interface FakeKavitaState {
  connectionKey: string;
  configured: boolean;
  libraries: KavitaLibrary[];
  series: KavitaSeries[];
  files: Map<number, string[]>;
  taskPending: boolean;
  chapterCalls: number[];
  deletedSeries: number[];
  libraryScans: number[];
  seriesScans: number[];
  titleUpdates: { seriesId: number; name: string }[];
  onGetChapters?: (seriesId: number) => Promise<void> | void;
  onScanLibrary?: (libraryId: number) => Promise<void> | void;
  onScanSeries?: (libraryId: number, seriesId: number) => Promise<void> | void;
  onUpdateTitle?: (seriesId: number, name: string) => Promise<void> | void;
}

function createInMemoryKavita(
  initial: Partial<FakeKavitaState> & { root: string }
): {
  state: FakeKavitaState;
  port: KavitaMergePort;
} {
  const state: FakeKavitaState = {
    connectionKey: initial.connectionKey ?? "https://protected-merge.test",
    configured: initial.configured ?? true,
    libraries: initial.libraries ?? [
      {
        id: 7,
        name: "Library",
        path: initial.root,
        paths: [initial.root],
        type: 0,
      },
    ],
    series: initial.series ?? [],
    files: initial.files ?? new Map(),
    taskPending: initial.taskPending ?? false,
    chapterCalls: [],
    deletedSeries: [],
    libraryScans: [],
    seriesScans: [],
    titleUpdates: [],
  };
  const port: KavitaMergePort = {
    connectionKey: () => (state.configured ? state.connectionKey : ""),
    current: () => {
      if (!state.configured) return null;
      const snapshotKey = state.connectionKey;
      return {
        connectionKey: snapshotKey,
        getLibraries: async () => state.libraries,
        getSeries: async (libraryId) =>
          state.series.filter((s) => s.libraryId === libraryId),
        getSeriesById: async (seriesId) => {
          const hit = state.series.find((s) => s.id === seriesId);
          if (!hit) throw new Error(`Series ${seriesId} not found`);
          return hit;
        },
        getChaptersBySeries: async (seriesId): Promise<KavitaChapterDto[]> => {
          state.chapterCalls.push(seriesId);
          await state.onGetChapters?.(seriesId);
          return (state.files.get(seriesId) ?? []).map((filePath, i) => ({
            id: i + 1,
            files: [{ id: i + 1, filePath }],
          }));
        },
        scanLibrary: async (libraryId) => {
          state.libraryScans.push(libraryId);
          state.taskPending = true;
          await state.onScanLibrary?.(libraryId);
        },
        scanSeries: async (libraryId, seriesId) => {
          state.seriesScans.push(seriesId);
          state.taskPending = true;
          await state.onScanSeries?.(libraryId, seriesId);
        },
        deleteSeries: async (seriesId) => {
          state.deletedSeries.push(seriesId);
          state.series = state.series.filter((s) => s.id !== seriesId);
          state.files.delete(seriesId);
        },
        updateSeriesMetadata: async (seriesId, patch) => {
          state.titleUpdates.push({ seriesId, name: patch.name });
          await state.onUpdateTitle?.(seriesId, patch.name);
          const hit = state.series.find((s) => s.id === seriesId);
          if (hit) hit.name = patch.name;
        },
        isTaskRunning: async () => {
          if (state.taskPending) {
            state.taskPending = false;
            return true;
          }
          return false;
        },
        getSeriesDto: async (seriesId) => {
          const hit = state.series.find((s) => s.id === seriesId);
          if (!hit) throw new Error(`Series ${seriesId} not found`);
          return {
            id: hit.id,
            libraryId: hit.libraryId,
            name: hit.name,
            folderPath: hit.folderPath,
          };
        },
        getSeriesMetadata: async (seriesId) => ({
          seriesId,
          summary: "Fixture summary",
        }),
        // Merges never capture covers; any cover read is a test failure.
        getServerInfo: async () => {
          throw new Error("Protected Merge must not read cover history");
        },
        getSeriesCoverForHistory: async () => {
          throw new Error("Protected Merge must not read cover history");
        },
        getVolumeCoverForHistory: async () => {
          throw new Error("Protected Merge must not read cover history");
        },
        getVolumeForCoverHistory: async () => {
          throw new Error("Protected Merge must not read cover history");
        },
      };
    },
  };
  return { state, port };
}

/** In-memory + SQLite-backed download adapter so tests drive download staging without real HTTP image transfers. */
function createScriptedDownloads(root: string): {
  port: MergeDownloadPort;
  enqueued: {
    id: number;
    source: DoujinSource;
    galleryId: string;
    title: string;
    chapter?: number;
    mergeJobId: number;
  }[];
  cancelledIds: number[];
  completeTask: (id: number, file: string, xml?: string) => void;
  failTask: (id: number, message: string) => void;
  onEnqueue?: (
    id: number,
    plan: {
      source: DoujinSource;
      galleryId: string;
      title: string;
      chapter?: number;
      mergeJobId: number;
    }
  ) => void;
} {
  const listeners = new Set<(task: DownloadTask) => void>();
  const removalListeners = new Set<(ids: number[]) => void>();
  const enqueued: {
    id: number;
    source: DoujinSource;
    galleryId: string;
    title: string;
    chapter?: number;
    mergeJobId: number;
  }[] = [];
  const cancelledIds: number[] = [];

  const readTask = (id: number): DownloadTask | null => downloadQueue.get(id);
  const emit = (id: number) => {
    const task = readTask(id);
    if (!task) return;
    for (const listener of listeners) listener(task);
  };

  const api = {
    enqueued,
    cancelledIds,
    onEnqueue: undefined as
      | ((
          id: number,
          plan: {
            source: DoujinSource;
            galleryId: string;
            title: string;
            chapter?: number;
            mergeJobId: number;
          }
        ) => void)
      | undefined,
    completeTask(
      id: number,
      file: string,
      xml = "<ComicInfo><Series>Incoming</Series></ComicInfo>"
    ) {
      if (!fs.existsSync(file))
        writeCbz(file, xml, [{ name: "001.jpg", data: Buffer.from("img") }]);
      getDb()
        .update(schema.downloadQueue)
        .set({ status: "completed", outputPath: file, outputFormat: "cbz" })
        .where(eq(schema.downloadQueue.id, id))
        .run();
      emit(id);
    },
    failTask(id: number, message: string) {
      getDb()
        .update(schema.downloadQueue)
        .set({
          status: "failed",
          errorMessage: message,
          errorCode: "unknown",
          retryAt: null,
        })
        .where(eq(schema.downloadQueue.id, id))
        .run();
      emit(id);
    },
    port: {
      get: (id: number) => readTask(id),
      findActive: (source: DoujinSource, galleryId: string) =>
        downloadQueue.findActive(source, galleryId),
      findCompleted: (source: DoujinSource, galleryId: string) =>
        downloadQueue.findCompleted(source, galleryId),
      hasPendingRetry: (id: number) => downloadQueue.hasPendingRetry(id),
      isRunning: (id: number) => downloadQueue.isRunning(id),
      enqueueForMerge: (plan) => {
        const res = getDb()
          .insert(schema.downloadQueue)
          .values({
            source: plan.source,
            galleryId: plan.galleryId,
            title: plan.title,
            status: "queued",
            outputFormat: "cbz",
            chapterNumber: plan.chapter ?? null,
            mergeJobId: plan.mergeJobId,
            sourceUrl: plan.url ?? null,
          })
          .run();
        const id = Number(res.lastInsertRowid);
        enqueued.push({ id, ...plan });
        queueMicrotask(() => {
          if (api.onEnqueue) {
            api.onEnqueue(id, plan);
          } else {
            const out = path.join(
              root,
              "downloads",
              `${plan.galleryId}-${id}.cbz`
            );
            api.completeTask(id, out);
          }
        });
        return id;
      },
      retry: (id: number) => {
        const row = readTask(id);
        if (!row) return false;
        getDb()
          .update(schema.downloadQueue)
          .set({
            status: "queued",
            errorMessage: null,
            errorCode: null,
            retryAt: null,
          })
          .where(eq(schema.downloadQueue.id, id))
          .run();
        queueMicrotask(() => {
          if (api.onEnqueue) {
            api.onEnqueue(id, {
              source: row.source,
              galleryId: row.galleryId,
              title: row.title ?? row.galleryId,
              chapter: row.chapterNumber ?? undefined,
              mergeJobId: row.mergeJobId ?? 0,
            });
          } else {
            const out = path.join(
              root,
              "downloads",
              `${row.galleryId}-${id}.cbz`
            );
            api.completeTask(id, out);
          }
        });
        return true;
      },
      cancel: (id: number) => {
        cancelledIds.push(id);
        getDb()
          .update(schema.downloadQueue)
          .set({
            status: "failed",
            errorMessage: "Cancelled by user",
            errorCode: "cancelled",
            retryAt: null,
          })
          .where(eq(schema.downloadQueue.id, id))
          .run();
        emit(id);
        return true;
      },
      cancelByMergeJob: (mergeJobId: number) => {
        for (const row of getDb()
          .select({ id: schema.downloadQueue.id })
          .from(schema.downloadQueue)
          .where(eq(schema.downloadQueue.mergeJobId, mergeJobId))
          .all()) {
          api.port.cancel(row.id);
        }
      },
      attachToMergeJob: (
        downloadIds: readonly number[],
        mergeJobId: number
      ) => {
        if (!downloadIds.length) return;
        getDb()
          .update(schema.downloadQueue)
          .set({ mergeJobId })
          .where(inArray(schema.downloadQueue.id, [...downloadIds]))
          .run();
      },
      reassignMergeJob: (
        downloadId: number,
        fromMergeJobId: number,
        toMergeJobId: number
      ) => {
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
      markOutputPublished: (oldPath: string, newPath: string) => {
        getDb()
          .update(schema.downloadQueue)
          .set({ outputPath: newPath, mergeJobId: null })
          .where(eq(schema.downloadQueue.outputPath, oldPath))
          .run();
      },
      subscribe: (listener: (task: DownloadTask) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeRemovals: (listener: (ids: number[]) => void) => {
        removalListeners.add(listener);
        return () => removalListeners.delete(listener);
      },
    } as MergeDownloadPort,
  };
  return api;
}

function makeFixture(
  label: string,
  opts?: {
    mappings?: { kavitaPath: string; localPath: string }[];
    chapterCacheTtlMs?: number;
  }
) {
  const root = path.join(dataDir, label);
  fs.mkdirSync(root, { recursive: true });
  const connectionKey = "https://protected-merge.test";
  setKavitaConnection({ baseUrl: connectionKey, apiKey: "fixture" });
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: root,
    libraryPathMappings: opts?.mappings ?? [],
  });

  const sourceId = nextId++;
  const targetId = nextId++;
  const source = path.join(root, "Source", "Chapter.cbz");
  const targetDir = path.join(root, "Target");
  const targetFile = path.join(targetDir, "Existing.cbz");
  writeCbz(
    source,
    "<ComicInfo><Series>Source</Series><Writer>Keep</Writer></ComicInfo>",
    [{ name: "001.jpg", data: Buffer.from("src") }]
  );
  writeCbz(
    targetFile,
    "<ComicInfo><Series>Target</Series><Number>12</Number><Writer>Keep</Writer></ComicInfo>",
    [{ name: "001.jpg", data: Buffer.from("tgt") }]
  );

  const kavita = createInMemoryKavita({
    root,
    connectionKey,
    series: [
      {
        id: sourceId,
        libraryId: 7,
        name: "Source",
        folderPath: path.dirname(source),
      },
      { id: targetId, libraryId: 7, name: "Target", folderPath: targetDir },
    ],
    files: new Map([
      [sourceId, [source]],
      [targetId, [targetFile]],
    ]),
  });

  // Default scan handler indexes every .cbz currently in targetDir under the target series.
  kavita.state.onScanSeries = (_libId, sid) => {
    const existingFiles = fs.existsSync(targetDir)
      ? fs
          .readdirSync(targetDir)
          .filter((f) => f.endsWith(".cbz"))
          .map((f) => path.join(targetDir, f))
      : [];
    kavita.state.files.set(sid, existingFiles);
  };
  kavita.state.onScanLibrary = () => {
    const existingFiles = fs.existsSync(targetDir)
      ? fs
          .readdirSync(targetDir)
          .filter((f) => f.endsWith(".cbz"))
          .map((f) => path.join(targetDir, f))
      : [];
    const target = kavita.state.series.find((s) => s.folderPath === targetDir);
    if (target) kavita.state.files.set(target.id, existingFiles);
  };

  const downloads = createScriptedDownloads(root);
  const discoveryQueued: { targetDir: string; seriesName?: string }[] = [];
  let duplicateKeys = new Set<string>();
  let clockNow = 1_000_000;

  const merge: ProtectedMerge = createProtectedMerge(
    {
      kavita: kavita.port,
      settings: {
        getDownloaderPaths: () => ({
          downloadDirectory: root,
          libraryPathMappings: opts?.mappings ?? [],
        }),
      },
      downloads: downloads.port,
      jobs: {
        get: (id) => jobQueue.get(id),
        enqueueMergeJob: (command, initialState) =>
          jobQueue.enqueue("merge-series", command, initialState),
        setProgress: (jobId, current, total) =>
          jobQueue.setProgress(jobId, current, total),
        isCancelRequested: (jobId) => jobQueue.isCancelRequested(jobId),
        updateContext: (jobId, context) => {
          jobQueue.updateContext(jobId, context);
        },
        invalidateContextCache: (ids) => jobQueue.invalidateContextCache(ids),
      },
      libraryIndex: {
        checkDownloadDuplicates: async () => duplicateKeys,
        invalidateDuplicateLibrary: () => {},
        queueMatchDiscovery: (dir, name) => {
          discoveryQueued.push({ targetDir: dir, seriesName: name });
        },
      },
    },
    {
      chapterCacheTtlMs: opts?.chapterCacheTtlMs ?? 5_000,
      downloadFallbackPollMs: 50,
      scanPollMs: 10,
      scanGraceMs: 20,
      mergeVerifyTimeoutMs: 500,
      now: () => clockNow,
      sleep: async (ms) => {
        clockNow += ms;
      },
    }
  );

  // Register this instance's lifecycle hook so retry, clearFailed and cancel tests use it.
  registerJobLifecycleHook("merge-series", merge.jobLifecycleHook);

  return {
    root,
    sourceId,
    targetId,
    source,
    targetDir,
    targetFile,
    kavita: kavita.state,
    downloads,
    discoveryQueued,
    merge,
    setDuplicateKeys: (keys: string[]) => {
      duplicateKeys = new Set(keys);
    },
    advanceClock: (ms: number) => {
      clockNow += ms;
    },
  };
}

// =========================================================================
// 1. Preview & Authority Resolution
// =========================================================================

test("preview resolves source and target Field Policies and blocks protected implicit source restamping", async () => {
  const f = makeFixture("path-only");
  await saveFieldPolicy(f.sourceId, ["title", "summary"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);

  const preview = await f.merge.preview({
    sourceFiles: [f.source],
    targetDir: f.targetDir,
  });
  assert.equal(preview.canQueue, false);
  assert.deepEqual(preview.inheritedFields, ["title", "summary", "tags"]);
  assert.deepEqual(
    preview.series.map((s) => [s.seriesId, s.role, s.titleChange]),
    [
      [f.sourceId, "source", true],
      [f.targetId, "target", false],
    ]
  );
  assert.equal(fs.existsSync(f.source), true);
  assert.match((await readComicInfo(f.source))!, /<Series>Source<\/Series>/);
});

test("matching Kavita series names never bypass protected ComicInfo.Series changes or malformed XML", async () => {
  const f = makeFixture("xml-title");
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  f.kavita.series = [
    {
      id: f.sourceId,
      libraryId: 7,
      name: "Target",
      folderPath: path.dirname(f.source),
    },
    { id: f.targetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ];
  for (const xml of [
    "<ComicInfo><Series>Different XML</Series></ComicInfo>",
    "<ComicInfo><Writer>Only credits</Writer></ComicInfo>",
  ]) {
    writeCbz(f.source, xml);
    assert.equal(
      (
        await f.merge.preview({
          sourceFiles: [f.source],
          targetDir: f.targetDir,
        })
      ).canQueue,
      false
    );
  }
  writeCbz(
    f.source,
    "<ComicInfo><Series>Target</Series><Series>Other</Series></ComicInfo>"
  );
  await assert.rejects(
    f.merge.preview({ sourceFiles: [f.source], targetDir: f.targetDir }),
    /malformed|ambiguous/
  );
});

test("unchanged protected target permits adding a genuinely unassociated archive", async () => {
  const f = makeFixture("unassociated");
  await saveFieldPolicy(f.targetId, ["title", "cover"], 0);
  f.kavita.files.set(f.sourceId, []);

  const preview = await f.merge.preview({
    seriesId: f.targetId,
    sourceFiles: [f.source],
  });
  assert.equal(preview.canQueue, true);
  assert.equal(preview.unassociatedArchives, 1);
  assert.deepEqual(preview.inheritedFields, ["title", "cover"]);
  assert.match(preview.warnings.join(" "), /no indexed series policy/);
});

test("invalid requests, escaping symlinks, ambiguous ownership, unmapped sources, and corrupt archives fail closed", async () => {
  const f = makeFixture("fail-closed");
  await assert.rejects(
    f.merge.preview({
      targetDir: f.targetDir,
      mergeProtection: { connectionKey: "fake" },
    }),
    (err) => err instanceof ProtectedMergeError && err.status === 400
  );
  await assert.rejects(
    f.merge.preview({
      targetDir: f.targetDir,
      sourceFiles: [f.source],
      sourceSeriesIds: [999999],
    }),
    /does not own/
  );
  await assert.rejects(
    f.merge.preview({
      targetDir: path.dirname(dataDir),
      sourceFiles: [f.source],
    }),
    /allowed/
  );

  // Escaping symlink outside allowed roots is rejected before creating directories.
  const outside = path.join(dataDir, "outside-symlink-target");
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(f.root, "Link");
  fs.symlinkSync(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    f.merge.preview({
      sourceFiles: [f.source],
      targetDir: path.join(link, "Not created"),
    }),
    /allowed/
  );
  assert.equal(fs.existsSync(path.join(outside, "Not created")), false);

  // Archive indexed under multiple series fails closed.
  f.kavita.files.set(f.targetId, [f.targetFile, f.source]);
  await assert.rejects(
    f.merge.preview({ targetDir: f.targetDir, sourceFiles: [f.source] }),
    /multiple series/
  );

  // Corrupt zip fails closed.
  f.kavita.files.set(f.targetId, [f.targetFile]);
  fs.writeFileSync(f.source, "corrupt zip");
  await assert.rejects(
    f.merge.preview({ targetDir: f.targetDir, sourceFiles: [f.source] })
  );

  // Unmapped Kavita library paths fail closed rather than treating sources as unassociated.
  writeCbz(f.source, "<ComicInfo><Series>Source</Series></ComicInfo>");
  f.kavita.libraries = [
    {
      id: 7,
      name: "Remote",
      path: "/unmounted-kavita-library",
      paths: ["/unmounted-kavita-library"],
      type: 0,
    },
  ];
  f.kavita.series = [
    {
      id: f.sourceId,
      libraryId: 7,
      name: "Source",
      folderPath: "/unmounted-kavita-library/Source",
    },
  ];
  f.kavita.files = new Map([
    [f.sourceId, ["/unmounted-kavita-library/Source/Chapter.cbz"]],
  ]);
  await assert.rejects(
    f.merge.preview({ sourceFiles: [f.source], targetDir: f.targetDir }),
    /Map Kavita library paths/
  );
});

test("preview skips unrelated mapped series chapters and still inspects unmapped series", async () => {
  const f = makeFixture("scoped-chapters");
  const unrelatedId = nextId++;
  const unrelatedDir = path.join(f.root, "UnrelatedMapped");
  fs.mkdirSync(unrelatedDir, { recursive: true });
  f.kavita.series.push({
    id: unrelatedId,
    libraryId: 7,
    name: "Completely Different",
    folderPath: unrelatedDir,
  });
  f.kavita.files.set(unrelatedId, [path.join(unrelatedDir, "Other.cbz")]);

  await f.merge.preview({ sourceFiles: [f.source], targetDir: f.targetDir });
  assert.equal(f.kavita.chapterCalls.includes(unrelatedId), false);
  assert.ok(
    f.kavita.chapterCalls.includes(f.sourceId) &&
      f.kavita.chapterCalls.includes(f.targetId)
  );

  f.kavita.chapterCalls.length = 0;
  f.kavita.series = [
    ...f.kavita.series.filter((s) => s.id !== unrelatedId),
    { id: unrelatedId, libraryId: 7, name: "Unmapped", folderPath: undefined },
  ];
  f.kavita.files.set(unrelatedId, ["/unmapped-lib/Unmapped/Book.cbz"]);
  await assert.rejects(
    f.merge.preview({ sourceFiles: [f.source], targetDir: f.targetDir }),
    /Map Kavita library paths/
  );
  assert.equal(f.kavita.chapterCalls.includes(unrelatedId), true);
});

// =========================================================================
// 2. Full Merge Execution, Rescan Verification, Rename & Cleanup
// =========================================================================

test("executeMergeJob rejects a title lock committed after queueing before moving any file", async () => {
  const f = makeFixture("after-enqueue");
  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
    sourceSeriesIds: [f.sourceId],
  });
  await saveFieldPolicy(f.sourceId, ["title"], 0);

  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(id)!, () => {}),
    /protected/
  );
  assert.equal(fs.existsSync(f.source), true);
  assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
});

test("executeMergeJob commits existing chapter edits, incoming chapters, metadata history, source cleanup, and Field Policy inheritance", async () => {
  const f = makeFixture("full-merge");
  await saveFieldPolicy(f.sourceId, ["summary", "cover"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);
  const cleared = path.join(f.targetDir, "Cleared.cbz");
  writeCbz(
    cleared,
    "<ComicInfo><Series>Target</Series><Number>8</Number></ComicInfo>"
  );
  f.kavita.files.set(f.targetId, [f.targetFile, cleared]);

  const id = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    sourceFiles: [f.source],
    chapters: { [f.source]: "13" },
    existingChapters: { [f.targetFile]: "7.5", [cleared]: "" },
  });
  const result = await f.merge.executeMergeJob(jobQueue.get(id)!, () => {});
  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  assert.equal(fs.existsSync(f.source), false);
  assert.equal((await comicFields(f.targetFile)).Number, "7.5");
  assert.equal((await comicFields(cleared)).Number ?? "", "");
  const movedPath = path.join(f.targetDir, "Chapter.cbz");
  assert.equal((await comicFields(movedPath)).Series, "Target");
  assert.equal((await comicFields(movedPath)).Number, "13");
  assert.deepEqual(f.kavita.deletedSeries, [f.sourceId]);
  assert.deepEqual(getFieldPolicy(f.targetId).lockedFields, [
    "summary",
    "tags",
    "cover",
  ]);

  const operation = listMetadataHistory(f.targetId).items[0];
  assert.equal(operation.origin, "merge-metadata");
  const detail = metadataHistoryDetail(f.targetId, operation.id)!;
  assert.equal(detail.archives.length, 3);
  assert.equal(
    detail.archives.find((a) => a.target === "Existing.cbz")!.status,
    "observed"
  );
});

test("invalid existing chapter edits fail before moving any incoming archive", async () => {
  const f = makeFixture("invalid-existing-edits");
  const badPathId = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
    existingChapters: { [f.source]: "4" },
  });
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(badPathId)!, () => {}),
    /not an existing target archive/
  );
  assert.equal(fs.existsSync(f.source), true);
  assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
});

test("deferred Kavita library scan triggers follow-up series rescan until all moved archives land", async () => {
  const f = makeFixture("deferred-scan");
  const newTarget = path.join(f.root, "Promeia");
  fs.mkdirSync(newTarget, { recursive: true });
  const sources = [1, 2, 3].map((n) => {
    const file = path.join(f.root, `src-${n}`, `Chapter ${n}.cbz`);
    writeCbz(file, "<ComicInfo><Series>Old Name</Series></ComicInfo>");
    return file;
  });
  const moved = sources.map((s) => path.join(newTarget, path.basename(s)));
  const newSeriesId = nextId++;
  let libScans = 0;
  f.kavita.onScanLibrary = () => {
    libScans += 1;
    if (!f.kavita.series.some((s) => s.id === newSeriesId)) {
      f.kavita.series.push({
        id: newSeriesId,
        libraryId: 7,
        name: "Promeia",
        folderPath: newTarget,
      });
    }
    // First scan misses chapter 3 (simulating an in-flight scan dropping our request).
    f.kavita.files.set(newSeriesId, libScans === 1 ? moved.slice(0, 2) : moved);
  };
  f.kavita.onScanSeries = (_libId, sid) => {
    f.kavita.files.set(sid, moved);
  };

  const id = jobQueue.enqueue("merge-series", {
    targetDir: newTarget,
    sourceFiles: sources,
  });
  const result = await f.merge.executeMergeJob(jobQueue.get(id)!, () => {});
  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  assert.equal(f.kavita.libraryScans.length, 1);
  assert.deepEqual(f.kavita.seriesScans, [newSeriesId]);
  assert.deepEqual(fs.readdirSync(newTarget).sort(), [
    "Chapter 1.cbz",
    "Chapter 2.cbz",
    "Chapter 3.cbz",
  ]);
});

test("merge verification is not satisfied by books already in the target series", async () => {
  const f = makeFixture("verify-not-skewed");
  const source2 = path.join(path.dirname(f.source), "Chapter 2.cbz");
  writeCbz(source2, "<ComicInfo><Series>Source</Series></ComicInfo>");
  f.kavita.files.set(f.sourceId, [f.source, source2]);
  const moved = [f.source, source2].map((file) =>
    path.join(f.targetDir, path.basename(file))
  );
  let scans = 0;
  f.kavita.onScanSeries = (_libId, sid) => {
    scans += 1;
    // The first scan indexes as many books as were moved, but one of them is
    // the pre-existing book: a count alone would wrongly call this verified.
    f.kavita.files.set(
      sid,
      scans === 1 ? [f.targetFile, moved[0]] : [f.targetFile, ...moved]
    );
  };

  const id = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    sourceFiles: [f.source, source2],
  });
  const result = await f.merge.executeMergeJob(jobQueue.get(id)!, () => {});
  assert.deepEqual(result, { processed: 2, matched: 0, failed: 0 });
  assert.deepEqual(f.kavita.seriesScans, [f.targetId, f.targetId]);
  assert.equal(f.kavita.libraryScans.length, 0);
});

test("bind-mount path mapping rescans and verifies existing target series", async () => {
  const hostRoot = path.join(dataDir, "bind-mount");
  const f = makeFixture("bind-mount-host", {
    mappings: [{ kavitaPath: "/media/Doujins", localPath: hostRoot }],
  });
  const targetDir = path.join(hostRoot, "BindTarget");
  const existing = path.join(targetDir, "Existing.cbz");
  const src = path.join(hostRoot, "Incoming", "Part 2.cbz");
  writeCbz(
    existing,
    "<ComicInfo><Series>BindTarget</Series><Number>1</Number></ComicInfo>"
  );
  writeCbz(src, "<ComicInfo><Series>Incoming</Series></ComicInfo>");
  const bindSeriesId = nextId++;
  f.kavita.libraries = [
    {
      id: 7,
      name: "Doujins",
      path: "/media/Doujins",
      paths: ["/media/Doujins"],
      type: 0,
    },
  ];
  f.kavita.series = [
    {
      id: bindSeriesId,
      libraryId: 7,
      name: "BindTarget",
      folderPath: "/media/Doujins/BindTarget",
    },
  ];
  f.kavita.files = new Map([
    [bindSeriesId, ["/media/Doujins/BindTarget/Existing.cbz"]],
  ]);
  f.kavita.onScanSeries = (_libId, sid) => {
    f.kavita.files.set(sid, [
      "/media/Doujins/BindTarget/Existing.cbz",
      "/media/Doujins/BindTarget/Part 2.cbz",
    ]);
  };

  const id = jobQueue.enqueue("merge-series", {
    seriesId: bindSeriesId,
    sourceFiles: [src],
    chapters: { [src]: "2" },
  });
  const result = await f.merge.executeMergeJob(jobQueue.get(id)!, () => {});
  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  assert.deepEqual(f.kavita.seriesScans, [bindSeriesId]);
  assert.equal(
    (await comicFields(path.join(targetDir, "Part 2.cbz"))).Number,
    "2"
  );
});

test("rename updates every archive and Kavita title; failed Kavita rename retries cleanly without double moving", async () => {
  const f = makeFixture("rename-retry");
  let failRename = true;
  f.kavita.onUpdateTitle = () => {
    if (failRename) throw new Error("Kavita 503");
  };

  const id = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    sourceFiles: [f.source],
    seriesName: "  Collected & Renamed  ",
  });
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(id)!, () => {}),
    /503/
  );
  assert.equal((await comicFields(f.targetFile)).Series, "Collected & Renamed");
  assert.equal(f.kavita.seriesScans.length, 0);

  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  const retryId = jobQueue.retryJob(id)!;
  failRename = false;
  const result = await f.merge.executeMergeJob(
    jobQueue.get(retryId)!,
    () => {}
  );
  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  assert.equal(f.kavita.titleUpdates.at(-1)!.name, "Collected & Renamed");
  assert.equal(fs.readdirSync(f.targetDir).length, 2);
});

test("vacant source cleanup rechecks an ID regrouped into target while chapter lookup is in flight", async () => {
  const f = makeFixture("cleanup-regroup");
  let regrouped = false;
  f.kavita.onGetChapters = (sid) => {
    if (sid === f.sourceId && !fs.existsSync(f.source) && !regrouped) {
      regrouped = true;
      const moved = path.join(f.targetDir, path.basename(f.source));
      f.kavita.series = [
        {
          id: f.sourceId,
          libraryId: 7,
          name: "Target",
          folderPath: f.targetDir,
        },
      ];
      f.kavita.files = new Map([[f.sourceId, [f.targetFile, moved]]]);
    }
  };
  await saveFieldPolicy(f.sourceId, ["summary"], 0);
  await saveFieldPolicy(f.targetId, ["cover"], 0);

  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const result = await f.merge.executeMergeJob(jobQueue.get(id)!, () => {});
  assert.equal(result.processed, 1);
  assert.equal(
    f.kavita.deletedSeries.includes(f.sourceId),
    false,
    "regrouped source ID is never deleted"
  );
  assert.deepEqual(getFieldPolicy(f.sourceId).lockedFields, [
    "summary",
    "cover",
  ]);
});

test("per-archive publication guard observes a mid-step Field Policy lock while reusing chapter cache", async () => {
  const f = makeFixture("mid-step-lock");
  const source2 = path.join(f.root, "Source", "Chapter 2.cbz");
  writeCbz(source2, "<ComicInfo><Series>Target</Series></ComicInfo>");
  writeCbz(f.source, "<ComicInfo><Series>Target</Series></ComicInfo>");
  f.kavita.series = [
    {
      id: f.sourceId,
      libraryId: 7,
      name: "Target",
      folderPath: path.dirname(f.source),
    },
    { id: f.targetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ];
  f.kavita.files.set(f.sourceId, [f.source, source2]);

  // After the first file moves, lock title and mutate chapter 2's XML to conflict.
  const origMark = f.downloads.port.markOutputPublished;
  f.downloads.port.markOutputPublished = (oldPath, newPath) => {
    origMark(oldPath, newPath);
    if (oldPath === f.source) {
      getDb()
        .insert(schema.seriesFieldPolicies)
        .values({
          connectionKey: f.kavita.connectionKey,
          seriesId: f.sourceId,
          lockedFieldsJson: JSON.stringify(["title"]),
          revision: 1,
          updatedAt: new Date().toISOString(),
        })
        .run();
      writeCbz(
        source2,
        "<ComicInfo><Series>Changed Mid-Merge</Series></ComicInfo>"
      );
    }
  };

  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source, source2],
  });
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(id)!, () => {}),
    /partially committed|protected/
  );
  assert.equal(
    fs.existsSync(source2),
    true,
    "locked second archive was not moved"
  );
});

test("cross-volume EXDEV copy interruption keeps original and never publishes a partial target archive", async () => {
  const f = makeFixture("cross-volume");
  const destination = path.join(f.targetDir, path.basename(f.source));
  const origRename = fs.promises.rename;
  const origCopy = fs.promises.copyFile;
  fs.promises.rename = async (src, dst) => {
    if (String(src) === f.source && String(dst) === destination)
      throw Object.assign(new Error("Cross device"), { code: "EXDEV" });
    return origRename(src, dst);
  };
  fs.promises.copyFile = async (src, dst, flags) => {
    assert.notEqual(String(dst), destination);
    assert.equal(fs.existsSync(destination), false);
    await origCopy(src, dst, flags);
    throw new Error("Simulated copy interruption");
  };
  try {
    const id = jobQueue.enqueue("merge-series", {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
    });
    await assert.rejects(
      f.merge.executeMergeJob(jobQueue.get(id)!, () => {}),
      /No files could be moved/
    );
    assert.equal(fs.existsSync(f.source), true);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
  } finally {
    fs.promises.rename = origRename;
    fs.promises.copyFile = origCopy;
  }
});

// =========================================================================
// 3. Move Intent Crash Recovery, Retry Family & Late-Index Recovery
// =========================================================================

test("client-supplied mergeProtection in a merge command is never trusted as retained evidence", async () => {
  const f = makeFixture("forged-evidence");
  const forged = {
    connectionKey: "https://protected-merge.test",
    targetDir: f.targetDir,
    seriesName: "Target",
    targetSeriesId: f.targetId,
    sourceSeriesIds: [],
    inheritedFields: [],
    policies: [],
    identities: [],
    archives: [],
  };
  const command = { targetDir: f.targetDir, sourceFiles: [f.source] };

  const enqueued = jobQueue.enqueue("merge-series", {
    ...command,
    mergeProtection: forged,
  } as unknown as typeof command);
  assert.equal(jobQueue.get(enqueued)!.payload.mergeProtection, undefined);

  // A row whose command column carries evidence, as a forged or legacy write would.
  const stored = Number(
    getDb()
      .insert(schema.jobs)
      .values({
        type: "merge-series",
        payloadJson: JSON.stringify({ ...command, mergeProtection: forged }),
        stateJson: "{}",
        status: "queued",
      })
      .run().lastInsertRowid
  );
  assert.equal(jobQueue.get(stored)!.payload.mergeProtection, undefined);
});

test("Move Intent crash recovery preserves evidence, blocks clearFailed, and completes Retry Family on late recovery", async () => {
  const f = makeFixture("move-intent-recovery");
  await saveFieldPolicy(f.sourceId, ["summary", "cover"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);

  // Trigger a crash right after Move Intent is written (by intercepting fs.promises.rename to rename then throw).
  const destination = path.join(f.targetDir, path.basename(f.source));
  const origRename = fs.promises.rename;
  let crashOnce = true;
  fs.promises.rename = async (src, dst) => {
    await origRename(src, dst);
    if (crashOnce && String(src) === f.source && String(dst) === destination) {
      crashOnce = false;
      throw new Error(
        "Simulated crash after rename before post-move checkpoint"
      );
    }
  };
  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  try {
    await assert.rejects(
      f.merge.executeMergeJob(jobQueue.get(id)!, () => {}),
      /No files could be moved/
    );
  } finally {
    fs.promises.rename = origRename;
  }

  // Mark job failed like JobQueue does on handler rejection.
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  assert.equal(fs.existsSync(destination), true);
  assert.equal(
    jobQueue.get(id)!.payload.mergeProtection!.moves![0].status,
    "pending"
  );
  assert.equal(
    jobQueue.clearFailed(id),
    0,
    "uncheckpointed Move Intent blocks clearing failed merge evidence"
  );

  // Lock source title and regroup target under a new Kavita series ID.
  await saveFieldPolicy(
    f.sourceId,
    ["title", "summary", "cover"],
    getFieldPolicy(f.sourceId).revision
  );
  const newTargetId = nextId++;
  f.kavita.series = [
    { id: newTargetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ];
  f.kavita.files = new Map([[newTargetId, [f.targetFile, destination]]]);

  // Retry repairs the pending Move Intent, then stops before XML restamping due to the title lock.
  const retryId = jobQueue.retryJob(id)!;
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(retryId)!, () => {}),
    /protected/
  );
  assert.deepEqual(jobQueue.get(retryId)!.payload.sourceFiles, [destination]);
  assert.equal(
    jobQueue.get(retryId)!.payload.mergeProtection!.moves![0].status,
    "published"
  );
  assert.match((await readComicInfo(destination))!, /<Series>Source<\/Series>/);

  // Late-index recovery inherits union of locks onto newTargetId and updates the entire Retry Family atomically.
  await libraryMutations.run([`series:${newTargetId}`], () =>
    f.merge.recoverSeriesWithinLock(newTargetId)
  );
  assert.deepEqual(getFieldPolicy(newTargetId).lockedFields, [
    "title",
    "summary",
    "tags",
    "cover",
  ]);
  assert.deepEqual(jobQueue.get(id)!.payload.sourceFiles, [destination]);
  assert.equal(
    jobQueue.get(id)!.payload.mergeProtection!.completedTargetSeriesId,
    newTargetId
  );
  assert.equal(
    jobQueue.clearFailed(id),
    1,
    "completed Retry Family releases failed row for cleanup"
  );

  // Later explicit unlock stays unlocked on subsequent recovery calls.
  await saveFieldPolicy(newTargetId, [], getFieldPolicy(newTargetId).revision);
  await f.merge.recoverSeries(newTargetId);
  assert.deepEqual(getFieldPolicy(newTargetId).lockedFields, []);
});

test("late-index recovery skips Kavita when no pending merge exists and runs safely inside held archive locks", async () => {
  const f = makeFixture("late-recovery-probe");
  getDb().delete(schema.jobs).where(eq(schema.jobs.type, "merge-series")).run();
  const unrelatedId = nextId++;
  f.kavita.chapterCalls.length = 0;

  // Hold libraryMutations exclusively: unlocked recoverSeries must fast-path without waiting on lock or Kavita.
  const gate = Promise.withResolvers<void>();
  const holder = libraryMutations.run(["*"], () => gate.promise);
  try {
    await f.merge.recoverSeries(unrelatedId);
    assert.deepEqual(f.kavita.chapterCalls, []);
  } finally {
    gate.resolve();
    await holder;
  }

  // Now create a pending Move Intent whose file moved to targetDir and verify recoverSeriesWithinLock never deadlocks under archiveMutations.
  await saveFieldPolicy(f.sourceId, ["summary"], 0);
  const destination = path.join(f.targetDir, path.basename(f.source));
  const sha256 = await hashArchiveFile(f.source);
  const jobId = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const state = {
    connectionKey: f.kavita.connectionKey,
    sourceSeriesIds: [f.sourceId],
    targetSeriesId: f.targetId,
    policies: [
      { seriesId: f.sourceId, revision: 1, lockedFields: ["summary"] },
    ],
    inheritedFields: ["summary"],
    seriesName: "Target",
    targetDir: f.targetDir,
    libraryId: 7,
    archives: [{ path: f.source, seriesId: f.sourceId }],
    identities: [
      {
        seriesId: f.sourceId,
        libraryId: 7,
        folderPath: path.dirname(f.source),
      },
    ],
    rootJobId: jobId,
    moves: [{ source: f.source, destination, sha256, status: "pending" }],
  };
  getDb()
    .update(schema.jobs)
    .set({
      status: "failed",
      stateJson: JSON.stringify({
        mergeProtection: state,
        sourceFiles: [f.source],
      }),
    })
    .where(eq(schema.jobs.id, jobId))
    .run();
  fs.renameSync(f.source, destination);
  const newTarget = nextId++;
  f.kavita.series = [
    { id: newTarget, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ];
  f.kavita.files = new Map([[newTarget, [f.targetFile, destination]]]);

  await libraryMutations.run([`series:${newTarget}`], () =>
    archiveMutations.run([archiveResource(destination)], () =>
      f.merge.recoverSeriesWithinLock(newTarget)
    )
  );
  assert.deepEqual(getFieldPolicy(newTarget).lockedFields, ["summary"]);
  assert.equal(
    jobQueue.get(jobId)!.payload.mergeProtection!.moves![0].status,
    "published"
  );
});

test("connection switch or archive ownership drift invalidates retained Protected Merge evidence", async () => {
  const f = makeFixture("drift");
  // Trigger a failure after phase 1 persists mergeProtection (by making download staging fail).
  f.downloads.onEnqueue = (dlId) => f.downloads.failTask(dlId, "boom");
  const idWithDl = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
    downloads: [
      { source: "hitomi", galleryId: "drift-dl", title: "Drift", chapter: "2" },
    ],
  });
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(idWithDl)!, () => {}),
    /boom/
  );
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, idWithDl))
    .run();

  // Switch connection key: retrying must reject.
  const retry1 = jobQueue.retryJob(idWithDl)!;
  f.kavita.connectionKey = "https://other-kavita.test";
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(retry1)!, () => {}),
    /connection changed/
  );

  // Restore connection key, reassign source archive to another series: must reject.
  f.kavita.connectionKey = "https://protected-merge.test";
  const otherId = nextId++;
  f.kavita.series = [
    {
      id: otherId,
      libraryId: 7,
      name: "Other",
      folderPath: path.dirname(f.source),
    },
    { id: f.targetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ];
  f.kavita.files = new Map([
    [otherId, [f.source]],
    [f.targetId, [f.targetFile]],
  ]);
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(retry1)!, () => {}),
    /ownership changed/
  );
});

// =========================================================================
// 4. Download Staging, Registration & Publication Guard
// =========================================================================

test("executeMergeJob stages downloads as CBZ, handles name collisions, retries cleanly, and queues discovery", async () => {
  const f = makeFixture("download-staging");
  const collision = path.join(f.targetDir, "fresh-a.cbz");
  writeCbz(
    collision,
    "<ComicInfo><Series>Target</Series><Number>20</Number></ComicInfo>"
  );
  f.kavita.files.set(f.targetId, [f.targetFile, collision]);

  let failSecond = true;
  f.downloads.onEnqueue = (dlId, plan) => {
    if (plan.galleryId === "fresh-b" && failSecond) {
      f.downloads.failTask(dlId, "transient 404");
      return;
    }
    const out = path.join(f.root, "staged", `${plan.galleryId}.cbz`);
    f.downloads.completeTask(
      dlId,
      out,
      `<ComicInfo><Series>${plan.title}</Series></ComicInfo>`
    );
  };

  const id = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    existingChapters: { [f.targetFile]: "9" },
    downloads: [
      {
        source: "hitomi",
        galleryId: "fresh-a",
        title: "Fresh A",
        chapter: "14.5",
      },
      {
        source: "hitomi",
        galleryId: "fresh-b",
        title: "Fresh B",
        chapter: "15",
      },
    ],
  });

  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(id)!, () => {}),
    /Download failed.*Fresh B/
  );
  assert.equal(
    (await comicFields(f.targetFile)).Number,
    "12",
    "existing chapters untouched when download fails"
  );
  assert.equal(f.kavita.seriesScans.length, 0);

  // Retry reuses completed fresh-a and retries failed fresh-b under the same task IDs.
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  const checkpoints = jobQueue.get(id)!.payload.mergeDownloadIds!;
  const retryId = jobQueue.retryJob(id)!;
  failSecond = false;
  const result = await f.merge.executeMergeJob(
    jobQueue.get(retryId)!,
    () => {}
  );
  assert.deepEqual(result, { processed: 2, matched: 0, failed: 0 });
  assert.deepEqual(
    jobQueue.get(retryId)!.payload.mergeDownloadIds,
    checkpoints
  );
  assert.equal((await comicFields(f.targetFile)).Number, "9");
  const taskA = downloadQueue.findCompleted("hitomi", "fresh-a")!;
  assert.ok(
    taskA.outputPath!.endsWith(" (2).cbz"),
    "collision-renamed destination updates download history"
  );
  assert.equal((await comicFields(taskA.outputPath!)).Number, "14.5");
  assert.equal(f.discoveryQueued.length, 1);
});

test("a merge retry replaces a failed independent download without changing its original task", async () => {
  const f = makeFixture("independent-retry");
  const independentId = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "failed-independent",
        status: "failed",
        outputFormat: "cbz",
        errorMessage: "Cancelled by user",
      })
      .run().lastInsertRowid
  );
  // A retried merge carries the checkpoint from its failed attempt.
  const id = jobQueue.enqueue(
    "merge-series",
    {
      seriesId: f.targetId,
      downloads: [
        {
          source: "hitomi",
          galleryId: "failed-independent",
          title: "Independent",
          chapter: "21",
        },
      ],
    },
    { mergeDownloadIds: { "hitomi:failed-independent": independentId } }
  );

  const result = await f.merge.executeMergeJob(jobQueue.get(id)!, () => {});
  assert.equal(result.processed, 1);
  const original = downloadQueue.get(independentId)!;
  assert.equal(original.status, "failed");
  assert.equal(original.errorMessage, "Cancelled by user");
  assert.equal(original.mergeJobId, null);
  assert.equal(f.downloads.cancelledIds.includes(independentId), false);
  const replacement = downloadQueue.findCompleted(
    "hitomi",
    "failed-independent"
  )!;
  assert.notEqual(replacement.id, independentId);
  assert.equal(path.dirname(replacement.outputPath!), f.targetDir);
});

test("cancelling a merge stops only owned downloads and waiting on an independent download never holds libraryMutations", async () => {
  const f = makeFixture("cancel-and-lock-order");
  const jobId = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    downloads: [
      {
        source: "hitomi",
        galleryId: "owned-wait",
        title: "Owned",
        chapter: "1",
      },
      {
        source: "hitomi",
        galleryId: "indep-wait",
        title: "Independent",
        chapter: "2",
      },
    ],
  });
  const ownedDl = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "owned-wait",
        status: "paused",
        outputFormat: "cbz",
        mergeJobId: jobId,
      })
      .run().lastInsertRowid
  );
  const indepDl = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "indep-wait",
        status: "paused",
        outputFormat: "cbz",
      })
      .run().lastInsertRowid
  );
  getDb()
    .update(schema.jobs)
    .set({
      status: "running",
      stateJson: JSON.stringify({
        mergeDownloadIds: { "hitomi:owned-wait": ownedDl },
      }),
    })
    .where(eq(schema.jobs.id, jobId))
    .run();

  const running = f.merge.executeMergeJob(jobQueue.get(jobId)!, () => {});
  const rejected = assert.rejects(running, JobCancelled);

  // While staging waits, libraryMutations must NOT be held!
  await libraryMutations.run(["*"], async () => {});
  assert.equal(jobQueue.cancel(jobId), true);
  await rejected;
  assert.equal(downloadQueue.get(ownedDl)!.errorMessage, "Cancelled by user");
  assert.equal(
    downloadQueue.get(indepDl)!.status,
    "paused",
    "independent download stays untouched"
  );

  // Another active merge retains ownership of its queued gallery.
  const otherJobId = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    downloads: [
      {
        source: "hitomi",
        galleryId: "other-owned",
        title: "Other",
        chapter: "1",
      },
    ],
  });
  getDb()
    .update(schema.jobs)
    .set({ status: "running" })
    .where(eq(schema.jobs.id, otherJobId))
    .run();
  getDb()
    .insert(schema.downloadQueue)
    .values({
      source: "hitomi",
      galleryId: "other-owned",
      status: "paused",
      outputFormat: "cbz",
      mergeJobId: otherJobId,
    })
    .run();
  const conflictJobId = jobQueue.enqueue("merge-series", {
    seriesId: f.targetId,
    downloads: [
      {
        source: "hitomi",
        galleryId: "other-owned",
        title: "Other",
        chapter: "1",
      },
    ],
  });
  await assert.rejects(
    f.merge.executeMergeJob(jobQueue.get(conflictJobId)!, () => {}),
    /already assigned to merge job/
  );
});

test("registerMergedDownloads reviews, rechecks, rejects async enqueue, and links siblings synchronously", async () => {
  const f = makeFixture("register-merged");
  const dl1 = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "reg-1",
        status: "queued",
        outputFormat: "cbz",
      })
      .run().lastInsertRowid
  );
  const dl2 = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "reg-2",
        status: "queued",
        outputFormat: "cbz",
      })
      .run().lastInsertRowid
  );

  // Async enqueue callback is rejected at runtime (and type-level via SyncOnly).
  await assert.rejects(
    f.merge.registerMergedDownloads("Target", {
      prepare: async () => "ready",
      enqueue: (async () => "bad") as unknown as () => string,
    }),
    /synchronous/
  );

  const count = await f.merge.registerMergedDownloads("Target", {
    prepare: async () => [dl1, dl2],
    enqueue: (ids, attach) => {
      attach({
        downloadId: ids[0],
        source: "hitomi",
        galleryId: "reg-1",
        title: "One",
        chapter: "1",
        allowDuplicate: true,
      });
      attach({
        downloadId: ids[1],
        source: "hitomi",
        galleryId: "reg-2",
        title: "Two",
        chapter: "2",
        allowDuplicate: true,
      });
      return ids.length;
    },
  });
  assert.equal(count, 2);
  const t1 = downloadQueue.get(dl1)!;
  const t2 = downloadQueue.get(dl2)!;
  assert.ok(t1.mergeJobId != null && t1.mergeJobId === t2.mergeJobId);
  const job = jobQueue.get(t1.mergeJobId!)!;
  assert.equal(job.payload.mergeProtection!.targetSeriesId, f.targetId);
  assert.equal(Object.keys(job.payload.mergeDownloadIds!).length, 2);
});

test("registerMergedDownloads reuses chapter listings for its recheck only within the cache lifetime", async () => {
  const f = makeFixture("register-chapter-cache", { chapterCacheTtlMs: 1_000 });
  const register = (prepare: () => Promise<number>) =>
    f.merge.registerMergedDownloads("Target", {
      prepare,
      enqueue: (value) => value,
    });

  f.kavita.chapterCalls.length = 0;
  await register(async () => 0);
  const reviewOnly = f.kavita.chapterCalls.length;
  assert.ok(reviewOnly > 0);

  f.kavita.chapterCalls.length = 0;
  await register(async () => {
    f.advanceClock(1_001);
    return 0;
  });
  assert.equal(
    f.kavita.chapterCalls.length,
    reviewOnly * 2,
    "a recheck after the cache lifetime reads chapter listings again"
  );
});

test("registerMergedDownloads cancels downloads attached by a failed or async enqueue step instead of leaving them unlinked", async () => {
  const f = makeFixture("register-merged-failure");
  const queued = (galleryId: string) =>
    Number(
      getDb()
        .insert(schema.downloadQueue)
        .values({
          source: "hitomi",
          galleryId,
          status: "queued",
          outputFormat: "cbz",
        })
        .run().lastInsertRowid
    );
  const entry = (downloadId: number, galleryId: string) => ({
    downloadId,
    source: "hitomi" as const,
    galleryId,
    title: galleryId,
    chapter: "1",
    allowDuplicate: true,
  });

  const thrownId = queued("fail-sync");
  await assert.rejects(
    f.merge.registerMergedDownloads("Target", {
      prepare: async () => thrownId,
      enqueue: (id, attach) => {
        attach(entry(id, "fail-sync"));
        throw new Error("second insert failed");
      },
    }),
    /second insert failed/
  );

  const beforeAwaitId = queued("fail-async-before");
  const afterAwaitId = queued("fail-async-after");
  let lateAttach: Promise<unknown> | undefined;
  await assert.rejects(
    f.merge.registerMergedDownloads("Target", {
      prepare: async () => null,
      enqueue: ((
        _prepared: null,
        attach: (e: ReturnType<typeof entry>) => void
      ) => {
        attach(entry(beforeAwaitId, "fail-async-before"));
        lateAttach = (async () => {
          await Promise.resolve();
          attach(entry(afterAwaitId, "fail-async-after"));
        })();
        return lateAttach;
      }) as unknown as () => string,
    }),
    /synchronous/
  );
  await assert.rejects(lateAttach!, /after merged registration/);

  for (const id of [thrownId, beforeAwaitId, afterAwaitId]) {
    assert.ok(
      f.downloads.cancelledIds.includes(id),
      `download #${id} must not download as an unprotected plain task`
    );
    assert.equal(downloadQueue.get(id)!.mergeJobId, null);
  }
});

test("registerMergedDownloads cancels every attached download and keeps the original error when one cancel fails", async () => {
  const f = makeFixture("register-merged-cancel-failure");
  const ids = ["cancel-a", "cancel-b"].map((galleryId) =>
    Number(
      getDb()
        .insert(schema.downloadQueue)
        .values({
          source: "hitomi",
          galleryId,
          status: "queued",
          outputFormat: "cbz",
        })
        .run().lastInsertRowid
    )
  );
  const cancel = f.downloads.port.cancel;
  f.downloads.port.cancel = (id) => {
    if (id === ids[0]) throw new Error("cancel failed");
    return cancel(id);
  };
  try {
    await assert.rejects(
      f.merge.registerMergedDownloads("Target", {
        prepare: async () => ids,
        enqueue: (prepared, attach) => {
          for (const [index, downloadId] of prepared.entries())
            attach({
              downloadId,
              source: "hitomi",
              galleryId: `cancel-${"ab"[index]}`,
              title: "Cancel",
              chapter: "1",
              allowDuplicate: true,
            });
          throw new Error("enqueue step failed");
        },
      }),
      /enqueue step failed/
    );
    assert.ok(f.downloads.cancelledIds.includes(ids[1]));
  } finally {
    f.downloads.port.cancel = cancel;
  }
});

test("guardDownloadPublication fast-paths normal downloads, blocks failed merges, and guards legacy mergeFolder rows", async () => {
  const f = makeFixture("publish-guard");
  const normalId = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "normal",
        status: "downloading",
        outputFormat: "cbz",
      })
      .run().lastInsertRowid
  );
  f.kavita.chapterCalls.length = 0;
  const out = await f.merge.guardDownloadPublication(
    { downloadId: normalId, targetDir: f.root },
    async () => "ok"
  );
  assert.equal(out, "ok");
  assert.equal(
    f.kavita.chapterCalls.length,
    0,
    "normal download skips Kavita completely"
  );

  // Cancelled merge job rejects publication.
  const cancelledJob = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  jobQueue.cancel(cancelledJob);
  const linkedId = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "linked",
        status: "downloading",
        outputFormat: "cbz",
        mergeJobId: cancelledJob,
      })
      .run().lastInsertRowid
  );
  await assert.rejects(
    f.merge.guardDownloadPublication(
      { downloadId: linkedId, targetDir: f.root },
      async () => "nope"
    ),
    /Cancelled by user/
  );

  // Legacy mergeFolder row allows unchanged protected target and blocks conflicting title lock.
  await saveFieldPolicy(f.targetId, ["title", "cover"], 0);
  const legacyId = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({
        source: "hitomi",
        galleryId: "legacy",
        status: "downloading",
        outputFormat: "cbz",
        mergeFolder: "Target",
      })
      .run().lastInsertRowid
  );
  assert.equal(
    await f.merge.guardDownloadPublication(
      {
        downloadId: legacyId,
        targetDir: f.targetDir,
        legacyMergeFolder: "Target",
      },
      async () => "published"
    ),
    "published"
  );
  writeCbz(
    f.targetFile,
    "<ComicInfo><Series>Different Protected</Series></ComicInfo>"
  );
  await assert.rejects(
    f.merge.guardDownloadPublication(
      {
        downloadId: legacyId,
        targetDir: f.targetDir,
        legacyMergeFolder: "Target",
      },
      async () => "nope"
    ),
    /protected/
  );
});

test("the download engine publishes a legacy merged download only through the installed guard", async () => {
  const f = makeFixture("engine-legacy-guard");
  // Only rows created here may be picked up by the shared engine.
  getDb().delete(schema.downloadQueue).run();
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: f.root,
    maxConcurrentDownloads: 1,
    maxImageConcurrency: 1,
    requestDelayMs: 0,
    autoSyncKavita: false,
  });
  registerDownloadPublicationGuard((target, commit, signal) =>
    f.merge.guardDownloadPublication(target, commit, signal)
  );
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  doujinProviders.hitomi = {
    ...originalProvider,
    getGallery: async (galleryId) => ({
      source: "hitomi",
      galleryId,
      title: "Incoming",
      artists: [],
      tags: [],
      pages: ["https://image.merge/page.jpg"],
    }),
  };
  globalThis.fetch = async (input) => {
    if (!String(input).startsWith("https://image.merge/"))
      throw new Error(`Unexpected fetch: ${String(input)}`);
    requested.resolve();
    await release.promise;
    return new Response("image");
  };

  const id = downloadQueue.enqueue(
    "hitomi",
    "engine-legacy",
    "Incoming",
    "cbz",
    "Target"
  );
  const settled = new Promise<void>((resolve) => {
    const done = () => {
      const task = downloadQueue.get(id);
      return (
        !!task &&
        (task.status === "completed" || task.status === "failed") &&
        !downloadQueue.isRunning(id)
      );
    };
    const unsubscribe = downloadQueue.subscribe(() => {
      if (done()) {
        unsubscribe();
        resolve();
      }
    });
    if (done()) {
      unsubscribe();
      resolve();
    }
  });
  try {
    await requested.promise;
    // Protection changes while the images are still transferring.
    await saveFieldPolicy(f.targetId, ["title"], 0);
    writeCbz(
      f.targetFile,
      "<ComicInfo><Series>Protected different XML</Series></ComicInfo>"
    );
    release.resolve();
    await settled;
    assert.equal(downloadQueue.get(id)!.status, "failed");
    assert.match(downloadQueue.get(id)!.errorMessage!, /protected/i);
    assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
  } finally {
    release.resolve();
    await settled;
    registerDownloadPublicationGuard((target, commit, signal) =>
      protectedMerge.guardDownloadPublication(target, commit, signal)
    );
  }
});

test("the download engine hands every publication, CBZ and folder, to the guard with its merge job", async () => {
  const f = makeFixture("engine-guard-targets");
  getDb().delete(schema.downloadQueue).run();
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: f.root,
    maxConcurrentDownloads: 1,
    maxImageConcurrency: 1,
    requestDelayMs: 0,
    autoSyncKavita: false,
  });
  const seen: { downloadId: number; mergeJobId?: number | null }[] = [];
  registerDownloadPublicationGuard((target, commit) => {
    seen.push({ downloadId: target.downloadId, mergeJobId: target.mergeJobId });
    return commit();
  });
  doujinProviders.hitomi = {
    ...originalProvider,
    getGallery: async (galleryId) => ({
      source: "hitomi",
      galleryId,
      title: galleryId,
      artists: [],
      tags: [],
      pages: ["https://image.guard/page.jpg"],
    }),
  };
  globalThis.fetch = async (input) => {
    if (!String(input).startsWith("https://image.guard/"))
      throw new Error(`Unexpected fetch: ${String(input)}`);
    return new Response("image");
  };
  const settled = (id: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        const task = downloadQueue.get(id);
        return (
          !!task &&
          (task.status === "completed" || task.status === "failed") &&
          !downloadQueue.isRunning(id)
        );
      };
      const unsubscribe = downloadQueue.subscribe(() => {
        if (done()) {
          unsubscribe();
          resolve();
        }
      });
      if (done()) {
        unsubscribe();
        resolve();
      }
    });
  try {
    const mergeJobId = jobQueue.enqueue("merge-series", {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
    });
    const staged = downloadQueue.enqueue(
      "hitomi",
      "guard-staged",
      "Staged",
      "cbz",
      undefined,
      1,
      0,
      mergeJobId
    );
    await settled(staged);
    const folder = downloadQueue.enqueue(
      "hitomi",
      "guard-folder",
      "Folder",
      "folder"
    );
    await settled(folder);
    assert.equal(downloadQueue.get(staged)!.status, "completed");
    assert.equal(downloadQueue.get(folder)!.status, "completed");
    assert.deepEqual(seen, [
      { downloadId: staged, mergeJobId },
      { downloadId: folder, mergeJobId: null },
    ]);
  } finally {
    registerDownloadPublicationGuard((target, commit, signal) =>
      protectedMerge.guardDownloadPublication(target, commit, signal)
    );
  }
});

test("deliberate ComicInfo authoring retains series Field Policy", async () => {
  const f = makeFixture("manual-authoring");
  await saveFieldPolicy(f.sourceId, ["title", "summary"], 0);
  await editComicInfo(f.source, {
    fields: { Series: "Deliberate manual title" },
  });
  assert.match((await readComicInfo(f.source))!, /Deliberate manual title/);
  assert.deepEqual(getFieldPolicy(f.sourceId).lockedFields, [
    "title",
    "summary",
  ]);
});

// =========================================================================
// 5. Thin HTTP Route Smoke Checks
// =========================================================================

test("HTTP routes: /merge-protection/preview, /jobs validation, /series/:id/field-locks fast-path, and /downloads/merged", async () => {
  const f = makeFixture("http-smoke");
  // Clear scripted-test rows so downloadQueue.pump() only processes tasks created by this smoke test.
  getDb().delete(schema.downloadQueue).run();
  registerJobLifecycleHook("merge-series", protectedMerge.jobLifecycleHook);
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/Library/libraries"))
      return Response.json(
        f.kavita.libraries.map((l) => ({ ...l, folders: l.paths }))
      );
    if (url.includes("/api/Series/all-v2"))
      return Response.json(f.kavita.series);
    if (url.includes("/api/Search/chapters-by-series")) {
      const sid = Number(new URL(url).searchParams.get("seriesId"));
      return Response.json(
        (f.kavita.files.get(sid) ?? []).map((filePath) => ({
          files: [{ filePath }],
        }))
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // Preview route is read-only and rejects forged state.
  const previewRes = await previewApi.request("/merge-protection/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetDir: f.targetDir,
      sourceFiles: [f.source],
      sourceSeriesIds: [f.sourceId],
    }),
  });
  assert.equal(previewRes.status, 200);
  assert.equal(
    ((await previewRes.json()) as { canQueue: boolean }).canQueue,
    false
  );

  const forgedRes = await previewApi.request("/merge-protection/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetDir: f.targetDir, mergeProtection: {} }),
  });
  assert.equal(forgedRes.status, 400);

  // /jobs rejects malformed seriesName and downloads.
  const badNameRes = await rootApi.request("/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "merge-series",
      seriesId: f.targetId,
      seriesName: "   ",
      downloads: [
        { source: "hitomi", galleryId: "x", title: "X", chapter: "1" },
      ],
    }),
  });
  assert.equal(badNameRes.status, 400);

  // GET /series/:id/field-locks does not wait on libraryMutations when no incomplete merge exists.
  getDb().delete(schema.jobs).where(eq(schema.jobs.type, "merge-series")).run();
  const gate = Promise.withResolvers<void>();
  const holder = libraryMutations.run(["*"], () => gate.promise);
  try {
    const locksRes = await rootApi.request(`/series/${f.sourceId}/field-locks`);
    assert.equal(locksRes.status, 200);
    assert.deepEqual(await locksRes.json(), {
      lockedFields: ["title"],
      revision: 1,
    });
  } finally {
    gate.resolve();
    await holder;
  }

  // POST /downloads/merged creates sibling tasks linked to one merge-series job; cancelling cancels owned tasks.
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: f.root,
    maxConcurrentDownloads: 2,
    maxImageConcurrency: 1,
    requestDelayMs: 0,
    autoSyncKavita: false,
  });
  const release = Promise.withResolvers<void>();
  doujinProviders.hitomi = {
    ...originalProvider,
    getGallery: async (galleryId) => ({
      source: "hitomi",
      galleryId,
      title: galleryId,
      artists: [],
      tags: [],
      pages: ["https://img.smoke/p.jpg"],
    }),
  };
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("https://img.smoke/")) {
      await release.promise;
      return new Response("image");
    }
    return baseFetch(input);
  };
  const mergedRes = await downloadsApi.request("/downloads/merged", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mergeFolder: "Target",
      items: [
        {
          source: "hitomi",
          galleryId: "smoke-a",
          chapter: 1,
          allowDuplicate: true,
        },
        {
          source: "hitomi",
          galleryId: "smoke-b",
          chapter: 2,
          allowDuplicate: true,
        },
      ],
    }),
  });
  assert.equal(mergedRes.status, 202);
  const { items } = (await mergedRes.json()) as { items: { id: number }[] };
  assert.equal(items.length, 2);
  const mergeJobId = downloadQueue.get(items[0].id)!.mergeJobId!;
  assert.equal(downloadQueue.get(items[1].id)!.mergeJobId, mergeJobId);
  // Job-backed downloads only stage: the merge job, not the engine, publishes into the series folder.
  assert.ok(
    items.every((item) => downloadQueue.get(item.id)!.mergeFolder === null)
  );
  const waitDone = items.map(
    (item) =>
      new Promise<void>((resolve) => {
        const unsub = downloadQueue.subscribe((task) => {
          if (
            task.id === item.id &&
            (task.status === "completed" || task.status === "failed") &&
            !downloadQueue.isRunning(item.id)
          ) {
            unsub();
            resolve();
          }
        });
        const cur = downloadQueue.get(item.id);
        if (
          cur &&
          (cur.status === "completed" || cur.status === "failed") &&
          !downloadQueue.isRunning(item.id)
        ) {
          unsub();
          resolve();
        }
      })
  );
  try {
    assert.equal(jobQueue.cancel(mergeJobId), true);
    release.resolve();
    await Promise.all(waitDone);
    assert.ok(
      items.every(
        (item) => downloadQueue.get(item.id)!.state.type === "cancelled"
      )
    );
  } finally {
    release.resolve();
    await Promise.all(waitDone);
  }
});
