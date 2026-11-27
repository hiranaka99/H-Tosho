import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type {
  DoujinGallery,
  DoujinSearchResult,
} from "../src/downloader/types.js";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-better-editions-")
);
process.env.HTOSHO_DATA_DIR = dataDir;
const { closeDb, getDb, initDb, schema } = await import("../src/db/index.js");
const {
  betterEditionReasons,
  findBetterEditions,
  findDuplicateReports,
  findKnownLibraryDuplicateKeys,
  invalidateDuplicateLibrary,
  lookupLibraryMatches,
  recordGalleryIdentity,
} = await import("../src/services/galleryDuplicates.js");
const { censorshipEdition, withoutCensorshipLabels, unifiedTitleKey } =
  await import("../src/services/unifiedTitle.js");
const { setDownloaderSettings, setKavitaConnection, DEFAULT_DOWNLOADER } =
  await import("../src/services/settings.js");
const { addWatchedSearch, checkWatchedSearches, listGalleryFeed } =
  await import("../src/services/watchedSearches.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const { buildZip } = await import("../src/downloader/zip.js");
initDb();

const originalProviders = { ...doujinProviders };
let folder = "";
let results: DoujinSearchResult[] = [];
const identity = (title: string, patch: Record<string, unknown> = {}) => ({
  source: "nhentai",
  galleryId: "9",
  title,
  artists: ["Sample Artist"],
  language: "English",
  pageCount: 20,
  ...patch,
});
function archive(name: string, title: string, tags = "", pages = 2) {
  const file = path.join(folder, name);
  const images = Array.from({ length: pages }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}.jpg`,
    data: Buffer.from("image"),
  }));
  fs.writeFileSync(
    file,
    buildZip([
      {
        name: "ComicInfo.xml",
        data: Buffer.from(
          `<ComicInfo><Title>${title}</Title><Artist>Sample Artist</Artist><LanguageISO>en</LanguageISO>${tags ? `<Tags>${tags}</Tags>` : ""}</ComicInfo>`
        ),
      },
      ...images,
    ])
  );
  return file;
}
beforeEach(() => {
  for (const table of [
    schema.downloadQueue,
    schema.ownedGalleries,
    schema.galleryTags,
    schema.keyValueStore,
    schema.watchedSearches,
    schema.watchedSearchSeen,
    schema.watchedSearchNew,
  ])
    getDb().delete(table).run();
  folder = fs.mkdtempSync(path.join(dataDir, "library-"));
  setKavitaConnection({ baseUrl: "", apiKey: "" });
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: folder });
  results = [];
  doujinProviders.nhentai = {
    ...originalProviders.nhentai,
    search: async () => results,
  };
  invalidateDuplicateLibrary();
});
afterEach(() => {
  Object.assign(doujinProviders, originalProviders);
});
after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("censorship editions come from title labels and source tags; conflicting labels never count", () => {
  assert.equal(
    censorshipEdition(["Title [English] [Decensored]"]),
    "uncensored"
  );
  assert.equal(censorshipEdition(["Title (Uncensored)"]), "uncensored");
  assert.equal(
    censorshipEdition(["Title"], ["other:uncensored"]),
    "uncensored"
  );
  assert.equal(
    censorshipEdition(["Title"], ["other:mosaic censorship"]),
    "censored"
  );
  assert.equal(
    censorshipEdition(["Title [Censored]"], ["uncensored"]),
    "mixed"
  );
  assert.equal(
    censorshipEdition(["Uncensored Love"]),
    "uncensored",
    "Label detection matches unifiedTitleKey"
  );
  assert.equal(
    withoutCensorshipLabels("(C99) [Circle] Title [English] [Decensored]"),
    "(C99) [Circle] Title [English]"
  );
  assert.equal(withoutCensorshipLabels("Title - Uncensored Version"), "Title");
  assert.ok(
    unifiedTitleKey("Title [Decensored]", ["a"], "english").startsWith(
      "uncensored:"
    ),
    "Unified grouping keeps its edition key"
  );
});

test("an uncensored or decensored edition improves on a censored or unmarked copy of the same work", () => {
  const owned = identity("[Sample Artist] The Lantern Keeper [English]", {
    galleryId: "1",
  });
  assert.ok(
    betterEditionReasons(
      identity("[Sample Artist] The Lantern Keeper [English] [Decensored]"),
      owned
    ).includes("Your copy is not marked uncensored")
  );
  assert.ok(
    betterEditionReasons(
      identity("The Lantern Keeper (Uncensored)"),
      identity("The Lantern Keeper [Censored]")
    ).includes("Your copy is the censored edition")
  );
  assert.ok(
    betterEditionReasons(
      identity("The Lantern Keeper", { tags: ["uncensored"] }),
      owned
    ).length > 0,
    "A tag-stated edition counts"
  );
  assert.ok(
    betterEditionReasons(
      identity("The Lantern Keeper [Decensored]", { pageCount: 22 }),
      owned
    ).length > 0,
    "A decensored release may add a couple of pages"
  );
});

test("worse, equal, or different works are never called better editions", () => {
  const owned = identity("The Lantern Keeper [English]");
  assert.deepEqual(
    betterEditionReasons(identity("The Lantern Keeper [English]"), owned),
    [],
    "Unmarked vs unmarked"
  );
  assert.deepEqual(
    betterEditionReasons(identity("The Lantern Keeper [Censored]"), owned),
    [],
    "A censored edition is not better"
  );
  assert.deepEqual(
    betterEditionReasons(
      identity("The Lantern Keeper [Decensored]"),
      identity("The Lantern Keeper [Uncensored]")
    ),
    [],
    "Already uncensored"
  );
  assert.deepEqual(
    betterEditionReasons(
      identity("The Lantern Keeper [Decensored]", {
        artists: ["Someone Else"],
      }),
      owned
    ),
    []
  );
  assert.deepEqual(
    betterEditionReasons(
      identity("The Lantern Keeper [Decensored]", { language: "Japanese" }),
      owned
    ),
    []
  );
  assert.deepEqual(
    betterEditionReasons(
      identity("The Lantern Keeper [Decensored]", { pageCount: 40 }),
      owned
    ),
    [],
    "A very different page count is another work"
  );
  assert.deepEqual(
    betterEditionReasons(identity("The Lantern Keeper 2 [Decensored]"), owned),
    [],
    "Sequels stay separate"
  );
});

test("library archives report better editions, including ones stated only by ComicInfo tags", async () => {
  archive("Lantern.cbz", "The Lantern Keeper [English]");
  archive("Moth.cbz", "Moth and Flame [English]", "uncensored, vanilla");
  const { reports } = await lookupLibraryMatches([
    {
      source: "nhentai",
      galleryId: "10",
      title: "The Lantern Keeper [English] [Decensored]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
    },
    {
      source: "nhentai",
      galleryId: "11",
      title: "Moth and Flame [English] [Decensored]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
    },
  ]);
  assert.equal(reports[0].matches.length, 1);
  assert.equal(reports[0].matches[0].betterEdition, true);
  assert.equal(
    reports[1].matches.length,
    1,
    "An already-uncensored copy is still a possible duplicate"
  );
  assert.equal(reports[1].matches[0].betterEdition, undefined);
  assert.deepEqual(
    [
      ...findKnownLibraryDuplicateKeys([
        {
          source: "nhentai",
          galleryId: "10",
          title: "The Lantern Keeper [English] [Decensored]",
          artists: ["Sample Artist"],
          language: "English",
          pageCount: 2,
        },
      ]),
    ],
    [],
    "A better edition is not a duplicate for recommendation filtering"
  );
});

test("a decensored upload on the same source improves on an owned download", () => {
  const owned: DoujinGallery = {
    source: "nhentai",
    galleryId: "1",
    title: "The Lantern Keeper [English]",
    artists: ["Sample Artist"],
    language: "English",
    tags: [],
    pages: ["a", "b"],
    pageCount: 2,
    previewPages: [],
  } as unknown as DoujinGallery;
  recordGalleryIdentity(owned);
  getDb()
    .insert(schema.ownedGalleries)
    .values({ source: "nhentai", galleryId: "1" })
    .run();
  const [report] = findDuplicateReports([
    {
      source: "nhentai",
      galleryId: "2",
      title: "The Lantern Keeper [English] [Decensored]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
    },
  ]).reports;
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].betterEdition, true);
  const [plain] = findDuplicateReports([
    {
      source: "nhentai",
      galleryId: "3",
      title: "The Lantern Keeper [English]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
    },
  ]).reports;
  assert.equal(
    plain.matches.length,
    0,
    "Same-source duplicate rules are unchanged for non-upgrades"
  );
});

test("Following records better-edition finds for Home and the feed", async () => {
  archive("Lantern.cbz", "The Lantern Keeper [English]");
  addWatchedSearch("nhentai", 'artist:"sample artist"');
  results = [];
  await checkWatchedSearches(() => {});
  results = [
    {
      source: "nhentai",
      galleryId: "50",
      title: "The Lantern Keeper [English] [Decensored]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
      tags: ["uncensored"],
    },
    {
      source: "nhentai",
      galleryId: "51",
      title: "Something New [English]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
      tags: [],
    },
  ];
  const result = await checkWatchedSearches(() => {});
  assert.equal(result.newGalleries, 2);
  assert.equal(result.betterEditions, 1);
  const feed = listGalleryFeed({ view: "inbox" });
  assert.equal(feed.betterEditionCount, 1);
  assert.deepEqual(
    feed.items.find((item) => item.galleryId === "50")?.betterEditionOf,
    { title: "The Lantern Keeper [English]" }
  );
  assert.equal(
    feed.items.find((item) => item.galleryId === "51")?.betterEditionOf,
    undefined
  );
  const direct = await findBetterEditions([
    {
      source: "nhentai",
      galleryId: "50",
      title: "The Lantern Keeper [English] [Decensored]",
      artists: ["Sample Artist"],
      language: "English",
      pageCount: 2,
    },
  ]);
  assert.equal(direct.get("nhentai:50")?.title, "The Lantern Keeper [English]");
});
