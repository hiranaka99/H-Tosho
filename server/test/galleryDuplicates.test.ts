import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "htosho-duplicates-"));
process.env.HTOSHO_DATA_DIR = dataDir;
const { closeDb, initDb, getDb, schema } = await import("../src/db/index.js");
const {
  duplicateReasons,
  recordGalleryIdentity,
  prepareDuplicateCheck,
  findDuplicateReports,
  createDuplicateChecker,
  invalidateDuplicateLibrary,
  resolveDuplicateGallery,
  rememberDuplicateLibraryRoots,
  lookupLibraryMatches,
  findKnownLibraryDuplicateKeys,
} = await import("../src/services/galleryDuplicates.js");
const { setDownloaderSettings, setKavitaConnection, DEFAULT_DOWNLOADER } =
  await import("../src/services/settings.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const { downloadQueue } = await import("../src/downloader/engine.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { api } = await import("../src/routes/api.js");
const { buildZip } = await import("../src/downloader/zip.js");
const { createProtectedMerge } = await import("../src/merge/index.js");
import type { DoujinGallery } from "../src/downloader/types.js";
initDb();
const originalProviders = { ...doujinProviders };
const originalEnqueue = downloadQueue.enqueue;
const originalJobEnqueue = jobQueue.enqueue;
let queued = 0;
let folder = "";
const gallery = (
  source: "hitomi" | "nhentai",
  galleryId = "1",
  patch: Partial<DoujinGallery> = {}
): DoujinGallery => ({
  source,
  galleryId,
  title: "The Lantern Keeper",
  artists: ["Sample Artist"],
  language: "English",
  tags: [],
  pages: ["https://fixture.invalid/1.jpg", "https://fixture.invalid/2.jpg"],
  ...patch,
});
beforeEach(() => {
  for (const table of [
    schema.downloadQueue,
    schema.ownedGalleries,
    schema.galleryTags,
    schema.keyValueStore,
  ])
    getDb().delete(table).run();
  folder = fs.mkdtempSync(path.join(dataDir, "output-"));
  queued = 0;
  setKavitaConnection({ baseUrl: "", apiKey: "" });
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: folder });
  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    getGallery: async (id) => gallery("hitomi", id),
  };
  doujinProviders.nhentai = {
    ...originalProviders.nhentai,
    getGallery: async (id) => gallery("nhentai", id),
  };
  downloadQueue.enqueue = ((source, galleryId, title, outputFormat) => {
    queued++;
    return Number(
      getDb()
        .insert(schema.downloadQueue)
        .values({
          source,
          galleryId,
          title,
          outputFormat: outputFormat ?? "cbz",
          status: "queued",
        })
        .run().lastInsertRowid
    );
  }) as typeof downloadQueue.enqueue;
  jobQueue.enqueue = (() => ++queued) as typeof jobQueue.enqueue;
  invalidateDuplicateLibrary();
});
afterEach(() => {
  Object.assign(doujinProviders, originalProviders);
  downloadQueue.enqueue = originalEnqueue;
  jobQueue.enqueue = originalJobEnqueue;
});
after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
function owned(
  source: "hitomi" | "nhentai",
  id = "1",
  patch: Partial<DoujinGallery> = {}
) {
  recordGalleryIdentity(gallery(source, id, patch));
  getDb().insert(schema.ownedGalleries).values({ source, galleryId: id }).run();
}
function archive(
  name: string,
  title = "The Lantern Keeper",
  language = "en",
  artist = "Sample Artist"
) {
  const file = path.join(folder, name);
  fs.writeFileSync(
    file,
    buildZip([
      {
        name: "ComicInfo.xml",
        data: Buffer.from(
          `<ComicInfo><Title>${title}</Title><Artist>${artist}</Artist><LanguageISO>${language}</LanguageISO></ComicInfo>`
        ),
      },
      { name: "001.jpg", data: Buffer.from("image") },
      { name: "002.png", data: Buffer.from("image") },
    ])
  );
  return file;
}
async function post(endpoint: string, body: unknown) {
  return api.request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("merged Lovemare chapters show library ownership before download without fetching providers", async () => {
  let requests = 0;
  doujinProviders.hitomi.getGallery = async () => {
    requests++;
    throw Error("Lookup must not fetch a provider");
  };
  const merged = path.join(folder, "Lovemare");
  fs.mkdirSync(merged);
  for (const [_id, title, web] of [
    [
      "101",
      "Lovemare Jou",
      "https://hitomi.la/doujinshi/lovemare-jou-101.html",
    ],
    ["102", "Lovemare Ge", "https://hitomi.la/reader/102.html"],
  ]) {
    fs.writeFileSync(
      path.join(merged, `${title}.cbz`),
      buildZip([
        {
          name: "ComicInfo.xml",
          data: Buffer.from(
            `<ComicInfo><Series>Lovemare</Series><Title>${title}</Title><Writer>akatsuki myuuto</Writer><Web>${web}</Web><LanguageISO>ja</LanguageISO></ComicInfo>`
          ),
        },
        { name: "001.jpg", data: Buffer.from("image") },
      ])
    );
  }
  const items = ["Jou", "Ge", "Extra"].map((part, index) => ({
    source: "hitomi" as const,
    galleryId: String(101 + index),
    title: `Lovemare ${part}`,
    artists: ["akatsuki myuuto"],
    language: "Japanese",
    pageCount: 100,
  }));
  const response = await post("/downloads/library-matches", { items });
  assert.equal(response.status, 200);
  const { reports } = await response.json();
  assert.equal(requests, 0);
  assert.equal(reports[0].matches[0].confirmed, true);
  assert.equal(reports[1].matches[0].confirmed, true);
  assert.equal(reports[0].matches[0].status, "In library");
  assert.equal(
    reports[2].matches.length,
    0,
    "A different chapter by the same artist stays downloadable"
  );
  assert.equal(reports[0].matches[0].title, "Lovemare Jou");
});

test("merged chapters retain title matching across providers, without treating the series title as every chapter", async () => {
  const file = archive(
    "Chapter 01.cbz",
    "Lovemare Jou",
    "ja",
    "akatsuki myuuto"
  );
  const { setComicInfoFields } = await import("../src/lib/cbz.js");
  await setComicInfoFields(file, { Series: "Lovemare" });
  const items = [
    {
      ...gallery("nhentai", "201"),
      title: "Lovemare Jou",
      artists: ["akatsuki myuuto"],
      language: "Japanese",
      pageCount: 2,
    },
    {
      ...gallery("nhentai", "202"),
      title: "Lovemare Ge",
      artists: ["akatsuki myuuto"],
      language: "Japanese",
      pageCount: 2,
    },
  ];
  const check = await lookupLibraryMatches(items);
  assert.equal(check.reports[0].matches[0].path, file);
  assert.equal(check.reports[0].matches[0].confirmed, false);
  assert.equal(check.reports[1].matches.length, 0);
  assert.equal(
    (await lookupLibraryMatches([{ ...items[0], language: "English" }]))
      .reports[0].matches.length,
    0
  );
});

test("source links and generated filename IDs survive renamed metadata and reject lookalike hosts", async () => {
  const { setComicInfoFields } = await import("../src/lib/cbz.js");
  const file = archive("Renamed [hitomi-301].cbz", "Lovemare", "ja", "");
  await setComicInfoFields(file, {
    Web: "https://nhentai.net/g/401/; https://hitomi.la.example.com/reader/999.html",
  });
  const input = [
    gallery("hitomi", "301"),
    gallery("nhentai", "401"),
    gallery("hitomi", "999"),
  ];
  const check = await lookupLibraryMatches(input);
  assert.ok(check.reports[0].matches[0].confirmed);
  assert.ok(check.reports[1].matches[0].confirmed);
  assert.equal(check.reports[2].matches.length, 0);
  assert.equal(
    findDuplicateReports([input[0]]).reports[0].matches[0].confirmed,
    true,
    "Enqueue also checks exact local provenance"
  );
});

test("original chapter filenames remain metadata evidence after replacing the chapter title with the series title", async () => {
  archive("Lovemare Jou.cbz", "Lovemare", "ja", "akatsuki myuuto");
  const input = {
    ...gallery("nhentai", "701"),
    title: "Lovemare Jou",
    artists: ["akatsuki myuuto"],
    language: "Japanese",
    pageCount: 2,
  };
  const check = await lookupLibraryMatches([
    input,
    { ...input, galleryId: "702", title: "Lovemare Ge" },
  ]);
  assert.equal(check.reports[0].matches[0].confirmed, false);
  assert.equal(check.reports[1].matches.length, 0);
});

test("library lookup includes persisted ownership with cleared history and does not mark unseen result pairs owned", async () => {
  getDb()
    .insert(schema.ownedGalleries)
    .values({ source: "hitomi", galleryId: "1" })
    .run();
  const check = await lookupLibraryMatches([
    gallery("hitomi", "1", { artists: [] }),
    gallery("nhentai", "2", { title: "Unseen Work" }),
    gallery("hitomi", "3", { title: "Unseen Work" }),
  ]);
  assert.equal(check.reports[0].matches[0].confirmed, true);
  assert.equal(check.reports[0].matches[0].status, "Owned");
  assert.equal(check.reports[1].matches.length, 0);
  assert.equal(check.reports[2].matches.length, 0);
});

test("library lookup upgrades old cached archive records and validates untrusted result metadata", async () => {
  const file = archive("Old cache.cbz");
  const { setComicInfoFields } = await import("../src/lib/cbz.js");
  await setComicInfoFields(file, { Web: "https://hitomi.la/501" });
  const stat = fs.statSync(file);
  getDb()
    .insert(schema.keyValueStore)
    .values({
      key: `duplicate-file:${file}`,
      valueJson: JSON.stringify({
        source: "library",
        galleryId: file,
        path: file,
        title: "Old renamed title",
        artists: [],
        stamp: `${stat.mtimeMs}:${stat.size}`,
      }),
    })
    .run();
  assert.equal(
    (await lookupLibraryMatches([gallery("hitomi", "501")])).reports[0]
      .matches[0].confirmed,
    true
  );
  for (const items of [
    [],
    [null],
    [{ source: "unknown", galleryId: "1", title: "Title", artists: [] }],
    [{ ...gallery("hitomi"), artists: [7] }],
    [{ ...gallery("hitomi"), pageCount: -1 }],
  ])
    assert.equal(
      (await post("/downloads/library-matches", { items })).status,
      400
    );
});

test("normalizes source wrappers, punctuation, artist separators, Unicode and language aliases", () => {
  const a = gallery("hitomi", "1", {
    title: "(C100) [Circle] The Lantern Keeper [English] [Team]",
    artists: ["Ｓａｍｐｌｅ_Ａｒｔｉｓｔ"],
    pageCount: 2,
  });
  const b = gallery("nhentai", "2", { language: "eng", pageCount: 2 });
  assert.equal(duplicateReasons(a, b).length, 4);
});
test("does not collapse translations, different editions, chapter numbers, or artists", () => {
  const a = { ...gallery("hitomi"), pageCount: 2 };
  for (const patch of [
    { language: "Japanese" },
    { pageCount: 3 },
    { artists: ["Someone else"] },
    { title: "The Lantern Keeper 2" },
    { title: "The Lantern Keeper [2]" },
    { title: "The Lantern Keeper [Final]" },
    { artists: [] },
  ])
    assert.deepEqual(
      duplicateReasons(a, { ...gallery("nhentai"), pageCount: 2, ...patch }),
      []
    );
});
test("alternate titles match but missing language/page data stays possible metadata evidence", () => {
  const a = gallery("hitomi", "1", {
    title: "灯籠の守り人の物語",
    titleAlt: "The Lantern Keeper",
  });
  const reasons = duplicateReasons(a, {
    ...gallery("nhentai"),
    language: null,
  });
  assert.deepEqual(reasons, ["Same title", "Same artist"]);
});
test("renamed and re-annotated titles match only with the same artist and identical page count", () => {
  const library = {
    source: "library",
    galleryId: "x",
    path: "x",
    title: "(Mana) Ganyu",
    titleAlt: "(Mana) Ganyu",
    artists: ["mana"],
    pageCount: 20,
  };
  const result = (
    title: string,
    patch: Partial<DoujinGallery & { pageCount: number }> = {}
  ) => ({
    ...gallery("hitomi", "9", {
      title,
      artists: ["mana"],
      language: undefined,
    }),
    pageCount: 20,
    ...patch,
  });
  for (const title of [
    "Ganyu",
    "[mana] Ganyu (Genshin Impact) [English]",
    "(C99) [Circle (mana)] Ganyu (Genshin Impact) [Digital]",
    "【mana】 Ganyu",
    "ガンユウ | Ganyu",
  ])
    assert.deepEqual(
      duplicateReasons(result(title), library),
      ["Same title", "Same artist", "Same page count"],
      title
    );
  // Without an exact page count, a loose title is not evidence; nor is another artist's work.
  for (const [title, patch] of [
    ["Ganyu", { pageCount: undefined }],
    ["Ganyu", { pageCount: 21 }],
    ["Ganyu", { artists: ["someone"] }],
    ["Gan", {}],
  ] as const)
    assert.deepEqual(
      duplicateReasons(result(title, patch), library),
      [],
      `${title} ${JSON.stringify(patch)}`
    );
  // Part, sequel and numbering annotations are never stripped, even with equal page counts.
  for (const [a, b] of [
    ["Lovemare (Jou)", "Lovemare (Ge)"],
    ["Ganyu (2)", "Ganyu"],
    ["Ganyu (Zenpen)", "Ganyu (Kouhen)"],
    ["Ganyu (II)", "Ganyu"],
    ["Ganyu (Part 2)", "Ganyu"],
    ["Ganyu (Extra)", "Ganyu"],
    ["ガンユウ (上)", "ガンユウ (下)"],
    ["ガンユウ (後編)", "ガンユウ"],
    ["Ganyu 2", "Ganyu"],
    ["Ganyu After", "Ganyu"],
  ])
    assert.deepEqual(
      duplicateReasons(result(a), { ...library, title: b, titleAlt: b }),
      [],
      `${a} vs ${b}`
    );
  // A translation-group tag that merely contains 中 is still an annotation.
  assert.equal(
    duplicateReasons(result("ガンユウ [中国翻訳]"), {
      ...library,
      title: "ガンユウ",
      titleAlt: undefined,
    }).length,
    3
  );
});
test("a renamed library archive is a possible duplicate and keeps the gallery out of recommendations", async () => {
  archive("(Mana) Ganyu.cbz", "(Mana) Ganyu", "en", "mana");
  const item = {
    source: "hitomi" as const,
    galleryId: "2001",
    title: "Ganyu",
    artists: ["mana"],
    language: "English",
    pageCount: 2,
  };
  const check = await lookupLibraryMatches([
    item,
    { ...item, galleryId: "2002", pageCount: 3 },
    { ...item, galleryId: "2003", title: "Ganyu 2" },
  ]);
  assert.equal(check.reports[0].matches.length, 1);
  assert.equal(
    check.reports[0].matches[0].confirmed,
    false,
    "Metadata evidence is never a confirmed copy"
  );
  assert.equal(check.reports[1].matches.length, 0);
  assert.equal(check.reports[2].matches.length, 0);
  assert.deepEqual(
    [
      ...findKnownLibraryDuplicateKeys([
        item,
        { ...item, galleryId: "2002", pageCount: 3 },
      ]),
    ],
    ["hitomi:2001"]
  );
});
test("preview metadata alone does not make a gallery owned; paused work does, failed work does not", async () => {
  recordGalleryIdentity(gallery("hitomi"));
  const incoming = await prepareDuplicateCheck([
    { source: "nhentai", galleryId: "2" },
  ]);
  assert.equal(findDuplicateReports(incoming).reports[0].matches.length, 0);
  const id = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({ source: "hitomi", galleryId: "1", status: "paused" })
      .run().lastInsertRowid
  );
  assert.equal(findDuplicateReports(incoming).reports[0].matches[0].taskId, id);
  getDb().delete(schema.downloadQueue).run();
  getDb()
    .insert(schema.downloadQueue)
    .values({ source: "hitomi", galleryId: "1", status: "failed" })
    .run();
  assert.equal(findDuplicateReports(incoming).reports[0].matches.length, 0);
});
test("ownership and older tag profiles survive clearing queue history", async () => {
  getDb()
    .insert(schema.ownedGalleries)
    .values({ source: "hitomi", galleryId: "legacy" })
    .run();
  getDb()
    .insert(schema.galleryTags)
    .values({
      source: "hitomi",
      galleryId: "legacy",
      title: "The Lantern Keeper",
      artistsJson: '["Sample Artist"]',
      language: "English",
    })
    .run();
  owned("hitomi", "modern");
  const check = findDuplicateReports(
    await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }])
  );
  assert.equal(check.reports[0].matches.length, 2);
  assert.ok(
    check.reports[0].matches.every((match) => match.status === "Owned")
  );
});
test("local CBZ ComicInfo and actual page counts match independently of download history", async () => {
  const file = archive("Local.cbz");
  const input = await prepareDuplicateCheck([
    { source: "nhentai", galleryId: "2" },
  ]);
  const match = findDuplicateReports(input).reports[0].matches[0];
  assert.equal(match.path, file);
  assert.equal(match.pageCount, 2);
  assert.equal(match.source, "library");
  assert.equal(
    findDuplicateReports(input, [file]).reports[0].matches.length,
    0
  );
  fs.unlinkSync(file);
  assert.equal(findDuplicateReports(input).reports[0].matches.length, 0);
});
test("refresh removes stale local metadata and reports unreadable archives", async () => {
  const file = archive("Changed.cbz");
  assert.equal(
    findDuplicateReports(
      await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }])
    ).reports[0].matches.length,
    1
  );
  fs.writeFileSync(
    file,
    buildZip([{ name: "001.jpg", data: Buffer.from("image") }])
  );
  fs.writeFileSync(path.join(folder, "Broken.cbz"), "broken");
  const check = findDuplicateReports(
    await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }], true)
  );
  assert.equal(check.reports[0].matches.length, 0);
  assert.ok(check.warnings.some((warning) => warning.includes("Broken.cbz")));
});
test("batch catches equivalent galleries selected from different providers", async () => {
  const check = findDuplicateReports(
    await prepareDuplicateCheck([
      { source: "hitomi", galleryId: "1" },
      { source: "nhentai", galleryId: "2" },
    ])
  );
  assert.ok(
    check.reports.every(
      (report) =>
        report.matches.length === 1 &&
        report.matches[0].status === "In selection"
    )
  );
});
test("download API blocks possible duplicates without starting work and supports explicit override", async () => {
  owned("hitomi");
  const body = { source: "nhentai", galleryId: "2" };
  const blocked = await post("/downloads", body);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "possible-duplicate");
  assert.equal(queued, 0);
  assert.equal(
    (await post("/downloads", { ...body, allowDuplicate: "true" })).status,
    409
  );
  assert.equal(
    (await post("/downloads", { ...body, allowDuplicate: true })).status,
    202
  );
  assert.equal(queued, 1);
});
test("concurrent cross-source requests cannot both bypass review", async () => {
  const responses = await Promise.all([
    post("/downloads", { source: "hitomi", galleryId: "1" }),
    post("/downloads", { source: "nhentai", galleryId: "2" }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort((a, b) => a - b),
    [202, 409]
  );
  assert.equal(queued, 1);
});
test("same-source duplicate guards remain authoritative even with an override", async () => {
  getDb()
    .insert(schema.downloadQueue)
    .values({ source: "nhentai", galleryId: "2", status: "completed" })
    .run();
  assert.equal(
    (
      await post("/downloads", {
        source: "nhentai",
        galleryId: "2",
        allowDuplicate: true,
      })
    ).status,
    409
  );
  assert.equal(queued, 0);
});
test("merge API reviews duplicate downloads before queueing and persists per-gallery approval", async () => {
  owned("hitomi");
  const plan = {
    source: "nhentai",
    galleryId: "2",
    title: "Incoming",
    chapter: "1",
  };
  const body = { type: "merge-series", seriesId: 50, downloads: [plan] };
  assert.equal((await post("/jobs", body)).status, 409);
  assert.equal(queued, 0);
  assert.equal(
    (
      await post("/jobs", {
        ...body,
        downloads: [{ ...plan, allowDuplicate: true }],
      })
    ).status,
    202
  );
  assert.equal(queued, 1);
  assert.equal(
    (
      await post("/jobs", {
        ...body,
        downloads: [{ ...plan, allowDuplicate: "true" }],
      })
    ).status,
    400
  );
});
test("merge execution rechecks duplicates discovered after queueing before starting images", async () => {
  owned("hitomi");
  const targetDir = path.join(dataDir, "dup-merge-target");
  fs.mkdirSync(targetDir, { recursive: true });
  const merge = createProtectedMerge({
    kavita: {
      connectionKey: () => "https://dup.test",
      current: () => ({
        connectionKey: "https://dup.test",
        getLibraries: async () => [
          { id: 7, name: "Lib", path: dataDir, paths: [dataDir] },
        ],
        getSeries: async () => [
          { id: 50, libraryId: 7, name: "Target", folderPath: targetDir },
        ],
        getSeriesById: async () => ({
          id: 50,
          libraryId: 7,
          name: "Target",
          folderPath: targetDir,
        }),
        getChaptersBySeries: async () => [],
        scanLibrary: async () => {},
        scanSeries: async () => {},
        deleteSeries: async () => {},
        updateSeriesMetadata: async () => {},
        isTaskRunning: async () => false,
        getSeriesDto: async () => ({
          id: 50,
          libraryId: 7,
          name: "Target",
          folderPath: targetDir,
        }),
        getSeriesMetadata: async () => ({ seriesId: 50 }),
      }),
    },
    settings: {
      getDownloaderPaths: () => ({
        downloadDirectory: dataDir,
        libraryPathMappings: [],
      }),
    },
    downloads: {
      get: (id) => downloadQueue.get(id),
      findActive: (s, g) => downloadQueue.findActive(s, g),
      findCompleted: (s, g) => downloadQueue.findCompleted(s, g),
      hasPendingRetry: (id) => downloadQueue.hasPendingRetry(id),
      isRunning: (id) => downloadQueue.isRunning(id),
      enqueueForMerge: (p) =>
        downloadQueue.enqueue(
          p.source,
          p.galleryId,
          p.title,
          "cbz",
          undefined,
          p.chapter,
          0,
          p.mergeJobId,
          p.url
        ),
      retry: (id) => downloadQueue.retry(id),
      cancel: (id) => downloadQueue.cancel(id),
      cancelByMergeJob: () => {},
      attachToMergeJob: () => {},
      reassignMergeJob: () => {},
      markOutputPublished: () => {},
      subscribe: (l) => downloadQueue.subscribe((t) => l(t)),
      subscribeRemovals: (l) => downloadQueue.subscribeRemovals(l),
    },
    jobs: {
      get: (id) => jobQueue.get(id),
      enqueueMergeJob: (cmd, state) =>
        jobQueue.enqueue("merge-series", cmd, state),
      setProgress: (id, c, t) => jobQueue.setProgress(id, c, t),
      isCancelRequested: (id) => jobQueue.isCancelRequested(id),
      updateContext: (id, ctx) => {
        jobQueue.updateContext(id, ctx);
      },
      invalidateContextCache: (ids) => jobQueue.invalidateContextCache(ids),
    },
    aux: {
      checkDownloadDuplicates: async (plans, sourceFiles) => {
        const check = findDuplicateReports(
          await prepareDuplicateCheck(plans),
          sourceFiles
        );
        return new Set(
          check.reports
            .filter((r) => r.matches.length)
            .map((r) => `${r.source}:${r.galleryId}`)
        );
      },
    },
  });
  await assert.rejects(
    merge.executeMergeJob(
      {
        id: 1,
        type: "merge-series",
        payload: {
          seriesId: 50,
          downloads: [
            {
              source: "nhentai",
              galleryId: "2",
              title: "Incoming",
              chapter: "1",
            },
          ],
        },
        status: "running",
        progressCurrent: 0,
        progressTotal: 0,
        result: null,
        errorMessage: null,
        createdAt: "",
        startedAt: "",
        finishedAt: null,
      },
      () => {}
    ),
    /Possible duplicate/
  );
  assert.equal(queued, 0);
});
test("duplicate API validates size and providers without fetching galleries", async () => {
  assert.equal(
    (await post("/downloads/duplicates", { items: [] })).status,
    400
  );
  assert.equal(
    (
      await post("/downloads/duplicates", {
        items: [{ source: "unknown", galleryId: "1" }],
      })
    ).status,
    400
  );
  assert.equal(
    (
      await post("/downloads/duplicates", {
        items: Array.from({ length: 101 }, () => ({
          source: "hitomi",
          galleryId: "1",
        })),
      })
    ).status,
    400
  );
});

test("fresh preflight metadata is reused by the worker without a second provider request", async () => {
  let calls = 0;
  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    getGallery: async (id) => {
      calls++;
      return gallery("hitomi", id);
    },
  };
  await prepareDuplicateCheck([{ source: "hitomi", galleryId: "cache" }]);
  await resolveDuplicateGallery("hitomi", "cache", true);
  assert.equal(calls, 1);
});
test("expired metadata is refreshed rather than supplying stale CDN URLs", async (t) => {
  let calls = 0;
  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    getGallery: async (id) => {
      calls++;
      return gallery("hitomi", id);
    },
  };
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await resolveDuplicateGallery("hitomi", "expired");
  t.mock.timers.tick(61_000);
  await resolveDuplicateGallery("hitomi", "expired", true);
  assert.equal(calls, 2);
});

test("normal library browsing supplies persistent local roots without querying Kavita during download", async () => {
  const file = archive("FromLibrary.cbz");
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: path.join(folder, "Downloads"),
  });
  setKavitaConnection({
    baseUrl: "https://offline-kavita.invalid",
    apiKey: "fixture",
  });
  rememberDuplicateLibraryRoots([{ id: 1, name: "Fixture", paths: [folder] }]);
  const matches = findDuplicateReports(
    await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }])
  ).reports[0].matches;
  assert.equal(matches[0].path, file);
  setKavitaConnection({
    baseUrl: "https://another-kavita.invalid",
    apiKey: "fixture",
  });
  const other = findDuplicateReports(
    await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }])
  );
  assert.equal(other.reports[0].matches.length, 0);
  assert.ok(
    other.warnings.some((warning) => warning.includes("not indexed yet"))
  );
});

test("a shared batch checker sees each enqueued item exactly like a fresh per-item check", async () => {
  const [first, second] = await prepareDuplicateCheck([
    { source: "hitomi", galleryId: "1" },
    { source: "nhentai", galleryId: "2" },
  ]);
  const checker = createDuplicateChecker();
  assert.equal(checker.check([first]).reports[0].matches.length, 0);
  const id = Number(
    getDb()
      .insert(schema.downloadQueue)
      .values({ source: "hitomi", galleryId: "1", status: "queued" })
      .run().lastInsertRowid
  );
  checker.noteQueued(first, id);
  const shared = checker.check([second]);
  assert.deepEqual(shared, findDuplicateReports([second]));
  assert.equal(shared.reports[0].matches[0].taskId, id);
  assert.equal(shared.reports[0].matches[0].status, "queued");
});
test("library scans prune identities for deleted archives and untracked galleries", async () => {
  const kept = archive("Kept.cbz");
  const removed = archive("Removed.cbz");
  await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }]);
  const keys = () =>
    getDb()
      .select({ key: schema.keyValueStore.key })
      .from(schema.keyValueStore)
      .all()
      .map((row) => row.key);
  assert.ok(keys().includes(`duplicate-file:${removed}`));
  fs.unlinkSync(removed);
  for (const id of ["orphan", "tracked"])
    getDb()
      .insert(schema.keyValueStore)
      .values({
        key: `duplicate-gallery:hitomi:${id}`,
        valueJson: JSON.stringify({
          source: "hitomi",
          galleryId: id,
          title: "Another Work",
          artists: ["Sample Artist"],
        }),
      })
      .run();
  getDb()
    .insert(schema.ownedGalleries)
    .values({ source: "hitomi", galleryId: "tracked" })
    .run();
  await prepareDuplicateCheck([{ source: "nhentai", galleryId: "2" }], true);
  const after = keys();
  assert.ok(after.includes(`duplicate-file:${kept}`));
  assert.ok(!after.includes(`duplicate-file:${removed}`));
  assert.ok(
    !after.includes("duplicate-gallery:hitomi:orphan"),
    "untracked preview identities are pruned"
  );
  assert.ok(after.includes("duplicate-gallery:hitomi:tracked"));
  assert.ok(
    after.includes("duplicate-gallery:nhentai:2"),
    "an identity recorded for the pending enqueue survives"
  );
});
