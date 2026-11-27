import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { eq } from "drizzle-orm";
import type { KavitaClient } from "../src/kavita/client.js";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-merge-protection-")
);
process.env.HTOSHO_DATA_DIR = dataDir;
// DB/settings snapshot HTOSHO_DATA_DIR at module load; exercise that isolated loading boundary.
const { initDb, getDb, schema } = await import("../src/db/index.js");
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } =
  await import("../src/services/settings.js");
const { getFieldPolicy, saveFieldPolicy, inheritFieldPoliciesOwned } =
  await import("../src/services/fieldPolicies.js");
const {
  resolveMergeProtection,
  requireMergeProtection,
  parseMergeProtectionRequest,
  recoverMergeProtectionForSeriesOwned,
} = await import("../src/services/mergeProtection.js");
const { buildZip } = await import("../src/downloader/zip.js");
const { mergeCbzFiles, readComicInfo, editComicInfo, hashArchiveFile } =
  await import("../src/lib/cbz.js");
const { archiveMutations, archiveResource, libraryMutations } =
  await import("../src/lib/mutations.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { readJobPayload } = await import("../src/jobs/storage.js");
const { parseJobCommand } = await import("../src/contracts/jobs.js");
const { runJob } = await import("../src/jobs/executor.js");
const { api: previewApi } =
  await import("../src/routes/api/mergeProtection.js");
const { removeSourceSeriesFromKavita } =
  await import("../src/kavita/libraryOperations.js");
const { DownloadQueue, downloadQueue } =
  await import("../src/downloader/engine.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const { api: downloadsApi } = await import("../src/routes/api/downloads.js");
const originalProvider = doujinProviders.hitomi;
initDb();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  doujinProviders.hitomi = originalProvider;
});
let nextId = 1000;
interface ProtectionFixture {
  root: string;
  sourceId: number;
  targetId: number;
  source: string;
  targetDir: string;
  targetFile: string;
  files: Map<number, string[]>;
  client: KavitaClient;
  replaceSeries: (
    series: {
      id: number;
      libraryId: number;
      name: string;
      folderPath: string;
    }[]
  ) => void;
}
function fixture(label: string): ProtectionFixture {
  const root = path.join(dataDir, label);
  fs.mkdirSync(root, { recursive: true });
  setKavitaConnection({
    baseUrl: "https://merge-protection.test",
    apiKey: "fixture",
  });
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: root,
    libraryPathMappings: [],
  });
  const sourceId = nextId++,
    targetId = nextId++;
  const source = path.join(root, "Source", "Chapter.cbz"),
    targetDir = path.join(root, "Target"),
    targetFile = path.join(targetDir, "Existing.cbz");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    source,
    buildZip([
      {
        name: "ComicInfo.xml",
        data: Buffer.from(
          "<ComicInfo><Series>Source</Series><Writer>Keep</Writer></ComicInfo>"
        ),
      },
    ])
  );
  fs.writeFileSync(
    targetFile,
    buildZip([
      {
        name: "ComicInfo.xml",
        data: Buffer.from("<ComicInfo><Series>Target</Series></ComicInfo>"),
      },
    ])
  );
  let series = [
    {
      id: sourceId,
      libraryId: 7,
      name: "Source",
      folderPath: path.dirname(source),
    },
    { id: targetId, libraryId: 7, name: "Target", folderPath: targetDir },
  ];
  const files = new Map<number, string[]>([
    [sourceId, [source]],
    [targetId, [targetFile]],
  ]);
  const client = {
    getLibraries: async () => [
      { id: 7, name: "Library", path: root, paths: [root] },
    ],
    getSeries: async () => series,
    getChaptersBySeries: async (id: number) =>
      (files.get(id) ?? []).map((file) => ({ files: [{ filePath: file }] })),
  } as unknown as KavitaClient;
  return {
    root,
    sourceId,
    targetId,
    source,
    targetDir,
    targetFile,
    files,
    client,
    replaceSeries: (value: typeof series) => {
      series = value;
    },
  };
}

test("path-only merges resolve both indexed policies and reject protected implicit source restamping", async () => {
  const f = fixture("path-only");
  await saveFieldPolicy(f.sourceId, ["title", "summary"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);
  const checked = await resolveMergeProtection(f.client, {
    sourceFiles: [f.source],
    targetDir: f.targetDir,
  });
  assert.equal(checked.preview.canQueue, false);
  assert.deepEqual(checked.preview.inheritedFields, [
    "title",
    "summary",
    "tags",
  ]);
  assert.deepEqual(
    checked.preview.series.map((series) => [
      series.seriesId,
      series.role,
      series.titleChange,
    ]),
    [
      [f.sourceId, "source", true],
      [f.targetId, "target", false],
    ]
  );
  assert.throws(() => requireMergeProtection(checked.preview), /protected/);
  assert.equal(fs.existsSync(f.source), true);
  assert.equal(
    (await readComicInfo(f.source))!.includes("<Series>Source</Series>"),
    true
  );
});

test("matching native names do not bypass changing or adding protected ComicInfo.Series", async () => {
  const f = fixture("xml-title");
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  f.replaceSeries([
    {
      id: f.sourceId,
      libraryId: 7,
      name: "Target",
      folderPath: path.dirname(f.source),
    },
    { id: f.targetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  for (const xml of [
    "<ComicInfo><Series>Different XML</Series></ComicInfo>",
    "<ComicInfo><Writer>Only credits</Writer></ComicInfo>",
  ]) {
    fs.writeFileSync(
      f.source,
      buildZip([{ name: "ComicInfo.xml", data: Buffer.from(xml) }])
    );
    assert.equal(
      (
        await resolveMergeProtection(f.client, {
          sourceFiles: [f.source],
          targetDir: f.targetDir,
        })
      ).preview.canQueue,
      false
    );
  }
  fs.writeFileSync(
    f.source,
    buildZip([
      {
        name: "ComicInfo.xml",
        data: Buffer.from(
          "<ComicInfo><Series>Target</Series><Series>Other</Series></ComicInfo>"
        ),
      },
    ])
  );
  await assert.rejects(
    resolveMergeProtection(f.client, {
      sourceFiles: [f.source],
      targetDir: f.targetDir,
    }),
    /malformed|ambiguous/
  );
});

test("unchanged protected target grouping permits adding a genuinely unassociated archive", async () => {
  const f = fixture("unassociated");
  await saveFieldPolicy(f.targetId, ["title", "cover"], 0);
  f.files.set(f.sourceId, []);
  const checked = await resolveMergeProtection(f.client, {
    seriesId: f.targetId,
    sourceFiles: [f.source],
  });
  assert.equal(checked.preview.canQueue, true);
  assert.equal(checked.preview.unassociatedArchives, 1);
  assert.deepEqual(checked.preview.inheritedFields, ["title", "cover"]);
  assert.match(checked.preview.warnings.join(" "), /no indexed series policy/);
});

test("source hints, disallowed paths, ambiguous ownership and unreadable archive metadata fail closed", async () => {
  const f = fixture("fail-closed");
  await assert.rejects(
    resolveMergeProtection(f.client, {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
      sourceSeriesIds: [999999],
    }),
    /does not own/
  );
  await assert.rejects(
    resolveMergeProtection(f.client, {
      targetDir: path.dirname(dataDir),
      sourceFiles: [f.source],
    }),
    /allowed/
  );
  f.files.set(f.targetId, [f.targetFile, f.source]);
  await assert.rejects(
    resolveMergeProtection(f.client, {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
    }),
    /multiple series/
  );
  f.files.set(f.targetId, [f.targetFile]);
  fs.writeFileSync(f.source, "corrupt zip");
  await assert.rejects(
    resolveMergeProtection(f.client, {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
    })
  );
});

test("the real executor rejects a title lock committed after queueing before moving any file", async () => {
  const f = fixture("after-enqueue");
  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
    sourceSeriesIds: [f.sourceId],
  });
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/Library/libraries"))
      return Response.json([
        { id: 7, name: "Library", folders: [f.root], type: 0 },
      ]);
    if (url.includes("/api/Series/all-v2"))
      return Response.json([
        {
          id: f.sourceId,
          libraryId: 7,
          name: "Source",
          folderPath: path.dirname(f.source),
        },
        {
          id: f.targetId,
          libraryId: 7,
          name: "Target",
          folderPath: f.targetDir,
        },
      ]);
    if (url.includes("/api/Search/chapters-by-series"))
      return Response.json(
        (
          f.files.get(Number(new URL(url).searchParams.get("seriesId"))) ?? []
        ).map((file) => ({ files: [{ filePath: file }] }))
      );
    throw Error(`Unexpected mutation: ${url}`);
  };
  await assert.rejects(
    runJob(jobQueue.get(id)!, () => {}),
    /protected/
  );
  assert.equal(fs.existsSync(f.source), true);
  assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
});

test("publication guard observes an archive changed after preflight without nesting its archive owner", async () => {
  const f = fixture("publication-race");
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  f.replaceSeries([
    {
      id: f.sourceId,
      libraryId: 7,
      name: "Target",
      folderPath: path.dirname(f.source),
    },
    { id: f.targetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  fs.writeFileSync(
    f.source,
    buildZip([
      {
        name: "ComicInfo.xml",
        data: Buffer.from("<ComicInfo><Series>Target</Series></ComicInfo>"),
      },
    ])
  );
  const before = await resolveMergeProtection(f.client, {
    sourceFiles: [f.source],
    targetDir: f.targetDir,
  });
  assert.equal(before.preview.canQueue, true);
  const gate = Promise.withResolvers<void>();
  const owner = archiveMutations.run([archiveResource(f.source)], async () => {
    await gate.promise;
    fs.writeFileSync(
      f.source,
      buildZip([
        {
          name: "ComicInfo.xml",
          data: Buffer.from(
            "<ComicInfo><Series>Changed while queued</Series></ComicInfo>"
          ),
        },
      ])
    );
  });
  const merging = mergeCbzFiles(
    [f.source],
    f.targetDir,
    undefined,
    "Target",
    undefined,
    undefined,
    async () => {
      const checked = await resolveMergeProtection(
        f.client,
        { sourceFiles: [f.source], targetDir: f.targetDir },
        before.state
      );
      requireMergeProtection(checked.preview);
    }
  );
  gate.resolve();
  await owner;
  const result = await merging;
  assert.equal(result.moved.length, 0);
  assert.match(result.failed[0].error, /protected/);
  assert.equal(fs.existsSync(f.source), true);
});

test("durable source evidence survives regroup/new ID, retry and state-column restart without accepting client state", async () => {
  const f = fixture("durable");
  await saveFieldPolicy(f.sourceId, ["summary", "cover"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);
  const before = await resolveMergeProtection(f.client, {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const moved = path.join(f.targetDir, path.basename(f.source));
  fs.renameSync(f.source, moved);
  before.state.archives[0].path = moved;
  const newId = nextId++;
  f.replaceSeries([
    { id: newId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  f.files.clear();
  f.files.set(newId, [f.targetFile, moved]);
  const checked = await resolveMergeProtection(
    f.client,
    { targetDir: f.targetDir, sourceFiles: [moved] },
    before.state
  );
  await libraryMutations.run([`series:${newId}`], async () => {
    inheritFieldPoliciesOwned(
      newId,
      checked.state.inheritedFields,
      checked.state.connectionKey
    );
  });
  assert.deepEqual(getFieldPolicy(newId).lockedFields, [
    "summary",
    "tags",
    "cover",
  ]);
  const command = { targetDir: f.targetDir, sourceFiles: [moved] };
  assert.equal(
    readJobPayload(
      "merge-series",
      JSON.stringify({ ...command, mergeProtection: checked.state })
    ).payload.mergeProtection,
    undefined
  );
  const id = jobQueue.enqueue("merge-series", command);
  jobQueue.updateMergeState(id, {
    mergeProtection: checked.state,
    sourceFiles: [moved],
  });
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  const retried = jobQueue.get(jobQueue.retryJob(id)!)!;
  const row = getDb()
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, retried.id))
    .get()!;
  const decoded = readJobPayload(row.type, row.payloadJson, row.stateJson);
  const resumed = await resolveMergeProtection(
    f.client,
    { targetDir: f.targetDir, sourceFiles: [moved] },
    decoded.payload.mergeProtection
  );
  assert.deepEqual(resumed.state.sourceSeriesIds, [f.sourceId]);
  assert.equal(resumed.state.targetSeriesId, newId);
  assert.deepEqual(resumed.state.inheritedFields, ["summary", "tags", "cover"]);
});

test("connection changes and changed indexed source ownership invalidate retained merge evidence", async () => {
  const f = fixture("identity-change");
  const before = await resolveMergeProtection(f.client, {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  setKavitaConnection({
    baseUrl: "https://other-merge.test",
    apiKey: "fixture",
  });
  await assert.rejects(
    resolveMergeProtection(
      f.client,
      { targetDir: f.targetDir, sourceFiles: [f.source] },
      before.state
    ),
    /connection changed/
  );
  setKavitaConnection({
    baseUrl: "https://merge-protection.test",
    apiKey: "fixture",
  });
  const other = nextId++;
  f.replaceSeries([
    {
      id: other,
      libraryId: 7,
      name: "Unrelated",
      folderPath: path.dirname(f.source),
    },
    { id: f.targetId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  f.files.delete(f.sourceId);
  f.files.set(other, [f.source]);
  await assert.rejects(
    resolveMergeProtection(
      f.client,
      { targetDir: f.targetDir, sourceFiles: [f.source] },
      before.state
    ),
    /ownership changed/
  );
});

test("a late indexed target receives failed-merge protection once, and a later explicit unlock stays unlocked", async () => {
  const f = fixture("late-index");
  await saveFieldPolicy(f.sourceId, ["summary", "cover"], 0);
  const checked = await resolveMergeProtection(f.client, {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const moved = path.join(f.targetDir, path.basename(f.source));
  fs.renameSync(f.source, moved);
  checked.state.archives[0].path = moved;
  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [moved],
  });
  jobQueue.updateMergeState(id, { mergeProtection: checked.state });
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  const newId = nextId++;
  f.replaceSeries([
    { id: newId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  f.files.clear();
  f.files.set(newId, [f.targetFile, moved]);
  await libraryMutations.run([`series:${newId}`], () =>
    recoverMergeProtectionForSeriesOwned(f.client, newId)
  );
  assert.deepEqual(getFieldPolicy(newId).lockedFields, ["summary", "cover"]);
  await saveFieldPolicy(newId, [], getFieldPolicy(newId).revision);
  await libraryMutations.run([`series:${newId}`], () =>
    recoverMergeProtectionForSeriesOwned(f.client, newId)
  );
  assert.deepEqual(getFieldPolicy(newId).lockedFields, []);
});

test("deliberate ComicInfo authoring remains available and retains its series policy", async () => {
  const f = fixture("manual-authoring");
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

test("request/parser validation rejects client evidence and bounded duplicate source IDs", () => {
  assert.throws(
    () =>
      parseMergeProtectionRequest({
        targetDir: dataDir,
        mergeProtection: { connectionKey: "fake" },
      }),
    /Unknown/
  );
  for (const ids of [
    [1, 1],
    [0],
    [1.5],
    Array.from({ length: 501 }, (_, i) => i + 1),
  ])
    assert.throws(
      () =>
        parseJobCommand("merge-series", {
          targetDir: dataDir,
          sourceFiles: [path.join(dataDir, "a.cbz")],
          sourceSeriesIds: ids,
        }),
      /sourceSeriesIds/
    );
  const parsed = parseJobCommand("merge-series", {
    targetDir: dataDir,
    sourceFiles: [path.join(dataDir, "a.cbz")],
    mergeProtection: { connectionKey: "fake" },
  });
  assert.equal("mergeProtection" in parsed.payload, false);
});

test("real protection preview endpoint is read-only and rejects forged policy scope", async () => {
  const f = fixture("preview-route");
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  installKavitaFetch(f);
  const jobsBefore = getDb().select().from(schema.jobs).all().length;
  const response = await previewApi.request("/merge-protection/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetDir: f.targetDir,
      sourceFiles: [f.source],
      sourceSeriesIds: [f.sourceId],
    }),
  });
  assert.equal(response.status, 200);
  const preview = (await response.json()) as {
    canQueue: boolean;
    series: { seriesId: number; lockedFields: string[] }[];
  };
  assert.equal(preview.canQueue, false);
  assert.deepEqual(
    preview.series.find((series) => series.seriesId === f.sourceId)!
      .lockedFields,
    ["title"]
  );
  assert.equal(getDb().select().from(schema.jobs).all().length, jobsBefore);
  assert.equal(fs.existsSync(f.source), true);
  const forged = await previewApi.request("/merge-protection/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetDir: f.targetDir, mergeProtection: {} }),
  });
  assert.equal(forged.status, 400);
  assert.match(((await forged.json()) as { error: string }).error, /Unknown/);
});

function installKavitaFetch(
  f: ProtectionFixture,
  image: () => Promise<Response> = async () => new Response("image")
): void {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/Series/metadata"))
      return Response.json({
        seriesId: Number(new URL(url).searchParams.get("seriesId")),
        summary: "Fixture summary",
      });
    if (url.startsWith("https://image.merge/")) return image();
    if (url.includes("/api/Library/libraries"))
      return Response.json([
        { id: 7, name: "Library", folders: [f.root], type: 0 },
      ]);
    if (url.includes("/api/Series/all-v2"))
      return Response.json(await f.client.getSeries(7));
    if (url.includes("/api/Search/chapters-by-series"))
      return Response.json(
        (
          f.files.get(Number(new URL(url).searchParams.get("seriesId"))) ?? []
        ).map((file) => ({ files: [{ filePath: file }] }))
      );
    const id = /\/api\/Series\/(\d+)$/.exec(url)?.[1];
    if (id)
      return Response.json(
        (await f.client.getSeries(7)).find((series) => series.id === Number(id))
      );
    throw Error(`Unexpected request: ${url}`);
  };
}

function terminal(
  queue: InstanceType<typeof DownloadQueue>,
  id: number
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = queue.subscribe((task) => {
    if (
      task.id === id &&
      (task.status === "completed" || task.status === "failed") &&
      !queue.isRunning(id)
    ) {
      unsubscribe();
      resolve();
    }
  });
  const current = queue.get(id);
  if (
    current &&
    (current.status === "completed" || current.status === "failed") &&
    !queue.isRunning(id)
  ) {
    unsubscribe();
    resolve();
  }
  return promise;
}

test(
  "legacy merged download publication rechecks title protection set during image transfer",
  { timeout: 6000 },
  async () => {
    const f = fixture("legacy-publish");
    const requested = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
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
    installKavitaFetch(f, async () => {
      requested.resolve();
      await release.promise;
      return new Response("image");
    });
    const queue = new DownloadQueue(() => ({
      ...DEFAULT_DOWNLOADER,
      downloadDirectory: f.root,
      maxConcurrentDownloads: 1,
      maxImageConcurrency: 1,
      requestDelayMs: 0,
      autoSyncKavita: false,
    }));
    const id = queue.enqueue(
      "hitomi",
      "legacy-publish",
      "Incoming",
      "cbz",
      "Target"
    );
    const settled = terminal(queue, id);
    try {
      await requested.promise;
      await saveFieldPolicy(f.targetId, ["title"], 0);
      fs.writeFileSync(
        f.targetFile,
        buildZip([
          {
            name: "ComicInfo.xml",
            data: Buffer.from(
              "<ComicInfo><Series>Protected different XML</Series></ComicInfo>"
            ),
          },
        ])
      );
      release.resolve();
      await settled;
      assert.equal(queue.get(id)!.status, "failed");
      assert.match(queue.get(id)!.errorMessage!, /protected/);
      assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
    } finally {
      release.resolve();
      await settled;
    }
  }
);

test(
  "legacy merged download can add a new archive to an unchanged title-protected target",
  { timeout: 6000 },
  async () => {
    const f = fixture("legacy-unchanged");
    await saveFieldPolicy(f.targetId, ["title", "cover"], 0);
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
    installKavitaFetch(f);
    const queue = new DownloadQueue(() => ({
      ...DEFAULT_DOWNLOADER,
      downloadDirectory: f.root,
      maxConcurrentDownloads: 1,
      maxImageConcurrency: 1,
      requestDelayMs: 0,
      autoSyncKavita: false,
    }));
    const id = queue.enqueue(
      "hitomi",
      "legacy-unchanged",
      "Incoming",
      "cbz",
      "Target"
    );
    await terminal(queue, id);
    assert.equal(queue.get(id)!.status, "completed");
    assert.match((await readComicInfo(queue.get(id)!.outputPath!))!, /Target/);
    assert.deepEqual(getFieldPolicy(f.targetId).lockedFields, [
      "title",
      "cover",
    ]);
  }
);

test(
  "direct merged-download API registers sibling task IDs with one durable protected merge job",
  { timeout: 6000 },
  async () => {
    const f = fixture("direct-group");
    const release = Promise.withResolvers<void>();
    setDownloaderSettings({
      ...DEFAULT_DOWNLOADER,
      downloadDirectory: f.root,
      maxConcurrentDownloads: 2,
      maxImageConcurrency: 1,
      requestDelayMs: 0,
      autoSyncKavita: false,
    });
    doujinProviders.hitomi = {
      ...originalProvider,
      getGallery: async (galleryId) => ({
        source: "hitomi",
        galleryId,
        title: galleryId,
        artists: [],
        tags: [],
        pages: ["https://image.merge/page.jpg"],
      }),
    };
    installKavitaFetch(f, async () => {
      await release.promise;
      return new Response("image");
    });
    const response = await downloadsApi.request("/downloads/merged", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mergeFolder: "Target",
        items: [
          {
            source: "hitomi",
            galleryId: "direct-a",
            chapter: 1,
            allowDuplicate: true,
          },
          {
            source: "hitomi",
            galleryId: "direct-b",
            chapter: 2,
            allowDuplicate: true,
          },
        ],
      }),
    });
    const items = ((await response.json()) as { items: { id: number }[] })
      .items;
    assert.equal(response.status, 202);
    assert.equal(items.length, 2);
    const tasks = items.map((item) => downloadQueue.get(item.id)!);
    const jobId = tasks[0].mergeJobId!;
    assert.equal(tasks[1].mergeJobId, jobId);
    assert.ok(tasks.every((task) => task.mergeFolder === null));
    const job = jobQueue.get(jobId)!;
    assert.equal(job.type, "merge-series");
    assert.equal(job.payload.mergeProtection!.targetSeriesId, f.targetId);
    assert.equal(Object.keys(job.payload.mergeDownloadIds!).length, 2);
    const settled = tasks.map((task) => terminal(downloadQueue, task.id));
    release.resolve();
    await Promise.all(settled);
    assert.deepEqual(
      fs.readdirSync(f.targetDir),
      ["Existing.cbz"],
      "downloads only stage; protected final publication belongs to the merge executor"
    );
  }
);

test(
  "a merge waiting for an independent legacy download does not own the library and deadlock its publisher",
  { timeout: 6000 },
  async () => {
    const f = fixture("legacy-await");
    const requested = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    setDownloaderSettings({
      ...DEFAULT_DOWNLOADER,
      downloadDirectory: f.root,
      maxConcurrentDownloads: 1,
      maxImageConcurrency: 1,
      requestDelayMs: 0,
      autoSyncKavita: false,
    });
    doujinProviders.hitomi = {
      ...originalProvider,
      getGallery: async (galleryId) => ({
        source: "hitomi",
        galleryId,
        title: "Waiting gallery",
        artists: [],
        tags: [],
        pages: ["https://image.merge/page.jpg"],
      }),
    };
    installKavitaFetch(f, async () => {
      requested.resolve();
      await release.promise;
      return new Response("image");
    });
    const taskId = downloadQueue.enqueue(
      "hitomi",
      "legacy-await",
      "Waiting gallery",
      "cbz",
      "Target"
    );
    const terminalTask = terminal(downloadQueue, taskId);
    await requested.promise;
    const id = jobQueue.enqueue("merge-series", {
      seriesId: f.targetId,
      downloads: [
        {
          source: "hitomi",
          galleryId: "legacy-await",
          title: "Waiting gallery",
          chapter: "2",
        },
      ],
    });
    getDb()
      .update(schema.jobs)
      .set({ status: "running" })
      .where(eq(schema.jobs.id, id))
      .run();
    const running = runJob(jobQueue.get(id)!, () => {});
    const rejected = assert.rejects(running, /cancelled/i);
    try {
      await libraryMutations.run(["*"], async () => {});
      jobQueue.cancel(id);
      release.resolve();
      await rejected;
      await terminalTask;
      assert.equal(
        downloadQueue.get(taskId)!.status,
        "completed",
        "independent legacy publisher is not cancelled by the waiting merge"
      );
    } finally {
      jobQueue.cancel(id);
      release.resolve();
      await terminalTask;
    }
  }
);

test("restart repairs an uncheckpointed publication, retains its evidence, and completes the retry family", async () => {
  const f = fixture("pending-restart");
  await saveFieldPolicy(f.sourceId, ["summary", "cover"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);
  const checked = await resolveMergeProtection(f.client, {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const destination = path.join(f.targetDir, path.basename(f.source));
  const sha256 = await hashArchiveFile(f.source);
  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  checked.state.rootJobId = id;
  checked.state.moves = [
    { source: f.source, destination, sha256, status: "pending" },
  ];
  jobQueue.updateMergeState(id, {
    mergeProtection: checked.state,
    sourceFiles: [f.source],
  });
  fs.renameSync(f.source, destination);
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  assert.equal(
    jobQueue.clearFailed(id),
    0,
    "an uncheckpointed publication cannot erase retained source protection"
  );
  await saveFieldPolicy(
    f.sourceId,
    ["title", "summary", "cover"],
    getFieldPolicy(f.sourceId).revision
  );
  const target = nextId++;
  f.replaceSeries([
    { id: target, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  f.files.clear();
  f.files.set(target, [f.targetFile, destination]);
  installKavitaFetch(f);
  const retry = jobQueue.retryJob(id)!;
  await assert.rejects(
    runJob(jobQueue.get(retry)!, () => {}),
    /protected/
  );
  assert.deepEqual(jobQueue.get(retry)!.payload.sourceFiles, [destination]);
  assert.equal(
    jobQueue.get(retry)!.payload.mergeProtection!.moves![0].status,
    "published"
  );
  assert.match(
    (await readComicInfo(destination))!,
    /<Series>Source<\/Series>/,
    "title protection stops the retry before XML restamping"
  );
  await libraryMutations.run([`series:${target}`], () =>
    recoverMergeProtectionForSeriesOwned(f.client, target)
  );
  assert.deepEqual(getFieldPolicy(target).lockedFields, [
    "title",
    "summary",
    "tags",
    "cover",
  ]);
  assert.deepEqual(jobQueue.get(id)!.payload.sourceFiles, [destination]);
  assert.equal(
    jobQueue.get(id)!.payload.mergeProtection!.completedTargetSeriesId,
    target
  );
  assert.equal(
    jobQueue.clearFailed(id),
    1,
    "verified inheritance releases only the completed retry-family evidence"
  );
});

test("late index recovery recognizes a moved archive even when its original checkpoint path vanished", async () => {
  const f = fixture("late-pending");
  await saveFieldPolicy(f.sourceId, ["summary", "cover"], 0);
  const checked = await resolveMergeProtection(f.client, {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const destination = path.join(f.targetDir, path.basename(f.source));
  const sha256 = await hashArchiveFile(f.source);
  const id = jobQueue.enqueue("merge-series", {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  checked.state.rootJobId = id;
  checked.state.moves = [
    { source: f.source, destination, sha256, status: "pending" },
  ];
  jobQueue.updateMergeState(id, {
    mergeProtection: checked.state,
    sourceFiles: [f.source],
  });
  fs.renameSync(f.source, destination);
  getDb()
    .update(schema.jobs)
    .set({ status: "failed" })
    .where(eq(schema.jobs.id, id))
    .run();
  const target = nextId++;
  f.replaceSeries([
    { id: target, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  f.files.clear();
  f.files.set(target, [f.targetFile, destination]);
  await libraryMutations.run([`series:${target}`], () =>
    recoverMergeProtectionForSeriesOwned(f.client, target)
  );
  assert.deepEqual(getFieldPolicy(target).lockedFields, ["summary", "cover"]);
  assert.deepEqual(jobQueue.get(id)!.payload.sourceFiles, [destination]);
  assert.equal(
    jobQueue.get(id)!.payload.mergeProtection!.moves![0].status,
    "published"
  );
});

test("a verified regroup can reuse a source ID without losing either source or previous target locks", async () => {
  const f = fixture("same-source-id");
  await saveFieldPolicy(f.sourceId, ["summary"], 0);
  await saveFieldPolicy(f.targetId, ["cover"], 0);
  const checked = await resolveMergeProtection(f.client, {
    targetDir: f.targetDir,
    sourceFiles: [f.source],
  });
  const destination = path.join(f.targetDir, path.basename(f.source));
  fs.renameSync(f.source, destination);
  checked.state.archives[0].path = destination;
  f.replaceSeries([
    { id: f.sourceId, libraryId: 7, name: "Target", folderPath: f.targetDir },
  ]);
  f.files.clear();
  f.files.set(f.sourceId, [f.targetFile, destination]);
  const regrouped = await resolveMergeProtection(
    f.client,
    { targetDir: f.targetDir, sourceFiles: [destination] },
    checked.state
  );
  assert.equal(regrouped.state.targetSeriesId, f.sourceId);
  assert.deepEqual(regrouped.state.inheritedFields, ["summary", "cover"]);
});

test("policy transfer atomically rereads newer source locks and does not resurrect a source unlock", async () => {
  const f = fixture("union-race");
  const source = await saveFieldPolicy(f.sourceId, ["summary"], 0);
  await saveFieldPolicy(f.targetId, ["tags"], 0);
  const evidence = [
    { seriesId: f.sourceId, lockedFields: source.lockedFields },
  ];
  await saveFieldPolicy(f.sourceId, ["title", "summary"], source.revision);
  await libraryMutations.run([`series:${f.targetId}`], async () =>
    inheritFieldPoliciesOwned(
      f.targetId,
      source.lockedFields,
      "https://merge-protection.test",
      evidence
    )
  );
  assert.deepEqual(getFieldPolicy(f.targetId).lockedFields, [
    "title",
    "summary",
    "tags",
  ]);
  const another = nextId++;
  await saveFieldPolicy(f.sourceId, [], getFieldPolicy(f.sourceId).revision);
  await libraryMutations.run([`series:${another}`], async () =>
    inheritFieldPoliciesOwned(
      another,
      source.lockedFields,
      "https://merge-protection.test",
      evidence
    )
  );
  assert.deepEqual(getFieldPolicy(another).lockedFields, []);
});

test("vacant-source cleanup rechecks an ID that became the merged target while chapter ownership was loading", async () => {
  const f = fixture("cleanup-regroup");
  const destination = path.join(f.targetDir, path.basename(f.source));
  fs.renameSync(f.source, destination);
  f.files.set(f.sourceId, [destination]);
  installKavitaFetch(f);
  const delegate = globalThis.fetch;
  let currentTarget = f.targetId;
  let deletes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "DELETE") deletes++;
    const response = await delegate(input, init);
    if (
      String(input).includes(
        `/api/Search/chapters-by-series?seriesId=${f.sourceId}`
      )
    )
      currentTarget = f.sourceId;
    return response;
  };
  await removeSourceSeriesFromKavita(
    [f.sourceId],
    () => {},
    f.targetDir,
    async (id) => id !== currentTarget
  );
  assert.equal(deletes, 0);
  assert.equal(fs.existsSync(destination), true);
});

test("gallery/path-only merges cannot treat an unmapped indexed source as a new unassociated archive", async () => {
  const f = fixture("unmapped-source");
  await saveFieldPolicy(f.sourceId, ["title"], 0);
  const client = {
    getLibraries: async () => [
      {
        id: 7,
        name: "Remote library",
        path: "/unmounted-kavita-library",
        paths: ["/unmounted-kavita-library"],
      },
    ],
    getSeries: async () => [
      {
        id: f.sourceId,
        libraryId: 7,
        name: "Source",
        folderPath: "/unmounted-kavita-library/Source",
      },
    ],
    getChaptersBySeries: async () => [
      { files: [{ filePath: "/unmounted-kavita-library/Source/Chapter.cbz" }] },
    ],
  } as unknown as KavitaClient;
  await assert.rejects(
    resolveMergeProtection(client, {
      sourceFiles: [f.source],
      targetDir: f.targetDir,
    }),
    /Map Kavita library paths/
  );
});

test("a new target behind an escaping symlink is rejected before any archives move", async () => {
  const f = fixture("symlink-target");
  const outside = path.join(dataDir, "outside-symlink-target");
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(f.root, "Link");
  fs.symlinkSync(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    resolveMergeProtection(f.client, {
      sourceFiles: [f.source],
      targetDir: path.join(link, "Not created"),
    }),
    /allowed/
  );
  assert.equal(fs.existsSync(f.source), true);
  assert.equal(fs.existsSync(path.join(outside, "Not created")), false);
});

test("cross-volume move interruption keeps the original and never publishes a partial target archive", async () => {
  const f = fixture("cross-volume");
  const destination = path.join(f.targetDir, path.basename(f.source));
  const rename = fs.promises.rename,
    copy = fs.promises.copyFile;
  fs.promises.rename = async (source, target) => {
    if (String(source) === f.source && String(target) === destination)
      throw Object.assign(new Error("Cross device"), { code: "EXDEV" });
    return rename(source, target);
  };
  fs.promises.copyFile = async (source, target, flags) => {
    assert.notEqual(String(target), destination);
    assert.equal(fs.existsSync(destination), false);
    await copy(source, target, flags);
    throw new Error("Simulated copy interruption");
  };
  try {
    const result = await mergeCbzFiles(
      [f.source],
      f.targetDir,
      undefined,
      "Target"
    );
    assert.equal(result.moved.length, 0);
    assert.match(result.failed[0].error, /copy interruption/);
    assert.equal(fs.existsSync(f.source), true);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
  } finally {
    fs.promises.rename = rename;
    fs.promises.copyFile = copy;
  }
});

test(
  "canceling a newly queued direct merge cancels only its owned staged download tasks",
  { timeout: 6000 },
  async () => {
    const f = fixture("queued-group-cancel");
    const release = Promise.withResolvers<void>();
    setDownloaderSettings({
      ...DEFAULT_DOWNLOADER,
      downloadDirectory: f.root,
      maxConcurrentDownloads: 2,
      maxImageConcurrency: 1,
      requestDelayMs: 0,
      autoSyncKavita: false,
    });
    doujinProviders.hitomi = {
      ...originalProvider,
      getGallery: async (galleryId) => ({
        source: "hitomi",
        galleryId,
        title: galleryId,
        artists: [],
        tags: [],
        pages: ["https://image.merge/page.jpg"],
      }),
    };
    installKavitaFetch(f, async () => {
      await release.promise;
      return new Response("image");
    });
    const response = await downloadsApi.request("/downloads/merged", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mergeFolder: "Target",
        items: ["cancel-a", "cancel-b"].map((galleryId) => ({
          source: "hitomi",
          galleryId,
          allowDuplicate: true,
        })),
      }),
    });
    assert.equal(response.status, 202);
    const result = (await response.json()) as { items: { id: number }[] };
    const tasks = result.items.map((item) => downloadQueue.get(item.id)!);
    const completion = tasks.map((task) => terminal(downloadQueue, task.id));
    try {
      assert.equal(jobQueue.cancel(tasks[0].mergeJobId!), true);
      release.resolve();
      await Promise.all(completion);
      assert.ok(
        tasks.every(
          (task) => downloadQueue.get(task.id)!.state.type === "cancelled"
        )
      );
      assert.deepEqual(fs.readdirSync(f.targetDir), ["Existing.cbz"]);
    } finally {
      release.resolve();
      await Promise.all(completion);
    }
  }
);

test(
  "late policy recovery can run inside existing archive ownership without reacquiring its coordinator",
  { timeout: 6000 },
  async () => {
    const f = fixture("already-owned-recovery");
    await saveFieldPolicy(f.sourceId, ["summary"], 0);
    const checked = await resolveMergeProtection(f.client, {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
    });
    const destination = path.join(f.targetDir, path.basename(f.source));
    const sha256 = await hashArchiveFile(f.source);
    const id = jobQueue.enqueue("merge-series", {
      targetDir: f.targetDir,
      sourceFiles: [f.source],
    });
    checked.state.rootJobId = id;
    checked.state.moves = [
      { source: f.source, destination, sha256, status: "pending" },
    ];
    jobQueue.updateMergeState(id, {
      mergeProtection: checked.state,
      sourceFiles: [f.source],
    });
    fs.renameSync(f.source, destination);
    const target = nextId++;
    f.replaceSeries([
      { id: target, libraryId: 7, name: "Target", folderPath: f.targetDir },
    ]);
    f.files.clear();
    f.files.set(target, [f.targetFile, destination]);
    await libraryMutations.run([`series:${target}`], () =>
      archiveMutations.run([archiveResource(destination)], () =>
        recoverMergeProtectionForSeriesOwned(f.client, target)
      )
    );
    assert.deepEqual(getFieldPolicy(target).lockedFields, ["summary"]);
  }
);
