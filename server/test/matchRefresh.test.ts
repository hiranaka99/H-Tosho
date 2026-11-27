import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { SeriesMetadata } from "../src/providers/types.js";

process.env.HTOSHO_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "htosho-match-refresh-")
);
const { initDb, getDb, schema } = await import("../src/db/index.js");
const {
  setKavitaConnection,
  setProviderSetting,
  setNotificationSettings,
  getNotificationSettings,
} = await import("../src/services/settings.js");
const { getProvider } = await import("../src/providers/registry.js");
const { refreshMatchedSeries, listMatchUpdates, dismissMatchUpdate } =
  await import("../src/services/matchRefresh.js");
const { saveFieldPolicy, getFieldPolicy } =
  await import("../src/services/fieldPolicies.js");
const { diffMatchedMetadata } =
  await import("../src/contracts/matchUpdates.js");
const { api } = await import("../src/routes/api.js");
initDb();

const provider = getProvider("anilist")!;
const originals = {
  search: provider.search,
  meta: provider.getSeriesMetadata,
  fetch: globalThis.fetch,
};
const base = (overrides: Partial<SeriesMetadata> = {}): SeriesMetadata => ({
  providerId: "anilist",
  providerSeriesId: "100",
  title: "Sample Series",
  titleOptions: ["Sample Series", "Sanpuru"],
  summary: "A summary.",
  genres: ["Drama"],
  tags: ["School"],
  writers: ["Writer A"],
  artists: ["Artist A"],
  year: 2020,
  status: "ONGOING",
  language: "ja",
  url: "https://anilist.co/manga/100",
  coverUrl: "https://img.test/100.jpg",
  ...overrides,
});
let latest: Record<string, SeriesMetadata>;
let metadataReads: string[];
let discordPosts: string[];
const refresh = () =>
  refreshMatchedSeries({ checkCancelled() {}, progress() {}, log() {} });
const match = (
  seriesId: number,
  meta: SeriesMetadata,
  providerSeriesId = meta.providerSeriesId
) =>
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: seriesId,
      status: "matched",
      providerId: "anilist",
      providerSeriesId,
      confirmed: true,
      matchScore: 0.93,
      metadataJson: JSON.stringify(meta),
    })
    .onConflictDoUpdate({
      target: schema.seriesMatches.kavitaSeriesId,
      set: {
        providerSeriesId,
        metadataJson: JSON.stringify(meta),
        status: "matched",
      },
    })
    .run();

beforeEach(() => {
  const db = getDb();
  setKavitaConnection({ baseUrl: "https://kavita.test", apiKey: "test" });
  for (const table of [
    schema.matchUpdates,
    schema.seriesMatches,
    schema.seriesFieldPolicies,
    schema.jobs,
  ])
    db.delete(table).run();
  for (const id of ["anilist", "mangadex", "myanimelist"])
    setProviderSetting(id, { enabled: id === "anilist" });
  latest = {};
  metadataReads = [];
  discordPosts = [];
  provider.search = async () => {
    throw new Error("A refresh must never search for candidates");
  };
  provider.getSeriesMetadata = async (id) => {
    metadataReads.push(id);
    if (!latest[id]) throw new Error("not found");
    return structuredClone(latest[id]);
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://discord.test/")) {
      discordPosts.push(String(init?.body));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/Library/libraries"))
      return Response.json([{ id: 1, name: "Manga", type: 0 }]);
    if (url.includes("/Series/all-v2"))
      return Response.json([
        { id: 1, libraryId: 1, name: "Sample Series", coverImage: "c1.jpg" },
        { id: 2, libraryId: 1, name: "Quiet Series", coverImage: "c2.jpg" },
      ]);
    throw new Error(
      `A refresh must not write to Kavita or read anything else: ${url}`
    );
  }) as typeof fetch;
});
afterEach(() => {
  provider.search = originals.search;
  provider.getSeriesMetadata = originals.meta;
  globalThis.fetch = originals.fetch;
  const current = getNotificationSettings();
  if (current.discord.enabled)
    setNotificationSettings({ discord: { enabled: false, webhookUrl: "" } });
});

test("only a change to the exact matched candidate is reported, and nothing is searched or written", async () => {
  match(1, base());
  match(
    2,
    base({
      providerSeriesId: "200",
      title: "Quiet Series",
      titleOptions: ["Quiet Series"],
    }),
    "200"
  );
  latest = {
    100: base({ status: "COMPLETED", tags: ["School", "Time Skip"] }),
    200: base({
      providerSeriesId: "200",
      title: "Quiet Series",
      titleOptions: ["Quiet Series"],
    }),
  };
  const result = await refresh();
  assert.deepEqual(result, {
    processed: 2,
    updates: 1,
    unchanged: 1,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(metadataReads.sort(), ["100", "200"]);
  const [update] = listMatchUpdates();
  assert.equal(update.seriesId, 1);
  assert.equal(update.providerSeriesId, "100");
  assert.equal(update.score, 0.93);
  assert.deepEqual(
    update.changes.map((change) => change.summary),
    ["1 new tag (Time Skip)", "Status: Ongoing → Completed"]
  );
  const body = (await (await api.request("/home/updates")).json()) as {
    items: { cover: string }[];
  };
  assert.equal(body.items[0].cover, "/api/kavita/series/1/cover?v=c1.jpg");
});

test("an alternative title chosen at apply time is not mistaken for a provider change", async () => {
  match(1, base({ title: "Sanpuru" }));
  latest = { 100: base() };
  await refresh();
  assert.equal(listMatchUpdates().length, 0);
});

test("protected fields never alert, and protecting a field resolves a waiting update", async () => {
  match(1, base());
  latest = { 100: base({ summary: "A rewritten summary." }) };
  await refresh();
  assert.equal(listMatchUpdates().length, 1);
  await saveFieldPolicy(1, ["summary"], getFieldPolicy(1).revision);
  assert.equal(
    listMatchUpdates().length,
    0,
    "The waiting update resolves once its only field is protected"
  );
  await refresh();
  assert.equal(getDb().select().from(schema.matchUpdates).all().length, 0);
});

test("applying the update, or matching a different candidate, resolves it", async () => {
  match(1, base());
  latest = { 100: base({ coverUrl: "https://img.test/100-new.jpg" }) };
  await refresh();
  assert.equal(listMatchUpdates()[0].changes[0].summary, "New cover");
  match(1, latest[100]);
  assert.equal(
    listMatchUpdates().length,
    0,
    "Apply & Sync stores the new metadata, which clears the update"
  );

  match(1, base());
  await refresh();
  assert.equal(listMatchUpdates().length, 1);
  match(1, base({ providerSeriesId: "300" }), "300");
  assert.equal(
    listMatchUpdates().length,
    0,
    "A rematch to another candidate is not an update of the old one"
  );
});

test("a dismissed update stays hidden until the provider changes again", async () => {
  match(1, base());
  latest = { 100: base({ status: "HIATUS" }) };
  await refresh();
  assert.equal(dismissMatchUpdate(1, true), true);
  assert.equal(listMatchUpdates().length, 0);
  await refresh();
  assert.equal(
    listMatchUpdates().length,
    0,
    "The same provider state stays dismissed"
  );
  latest[100] = base({ status: "COMPLETED" });
  await refresh();
  assert.deepEqual(
    listMatchUpdates()[0].changes.map((change) => change.summary),
    ["Status: Ongoing → Completed"]
  );
  assert.equal(dismissMatchUpdate(1, true), true);
  assert.equal(dismissMatchUpdate(1, false), true);
  assert.equal(listMatchUpdates().length, 1, "Undo brings it back");
});

test("Discord announces each provider state once", async () => {
  setNotificationSettings({
    discord: { enabled: true, webhookUrl: "https://discord.test/webhook" },
  });
  match(1, base());
  latest = { 100: base({ genres: ["Drama", "Romance"] }) };
  await refresh();
  await refresh();
  assert.equal(discordPosts.length, 1);
  assert.match(discordPosts[0], /Sample Series/);
  latest[100] = base({ genres: ["Drama", "Romance", "Mystery"] });
  await refresh();
  assert.equal(discordPosts.length, 2);
});

test("provider read failures are reported without inventing updates", async () => {
  match(1, base());
  await assert.rejects(refresh(), /Providers could not be read/);
  assert.equal(getDb().select().from(schema.matchUpdates).all().length, 0);
});

test("diff ignores values the provider stopped returning and counts only added tags", () => {
  const applied = base({
    tags: ["School", "Drama"],
    volumeCovers: [{ number: 1, url: "v1" }],
  });
  assert.deepEqual(
    diffMatchedMetadata(
      applied,
      base({
        tags: ["School"],
        genres: [],
        summary: "",
        volumeCovers: [{ number: 1, url: "v1" }],
      })
    ),
    []
  );
  assert.deepEqual(
    diffMatchedMetadata(
      applied,
      base({
        tags: ["School", "Drama"],
        volumeCovers: [
          { number: 1, url: "v1" },
          { number: 2, url: "v2" },
        ],
      })
    ).map((change) => change.summary),
    ["1 new volume cover"]
  );
  assert.deepEqual(
    diffMatchedMetadata(
      applied,
      base({
        tags: ["School", "Drama"],
        volumeCovers: [
          { number: 1, url: "v1" },
          { number: 2, url: "v2" },
        ],
        coverUrl: "x",
      }),
      ["cover"]
    ),
    [],
    "Cover protection covers volume covers"
  );
  assert.deepEqual(
    diffMatchedMetadata(base(), base({ title: "Brand New Title" })).map(
      (change) => change.field
    ),
    ["title"]
  );
});

test("the upgrade migration adds match updates and better-edition context without touching existing finds", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrateSchema } = await import("../src/db/migrations.js");
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  sqlite.exec(
    "DROP TABLE match_updates; ALTER TABLE watched_search_new DROP COLUMN better_edition_json; DELETE FROM schema_migrations WHERE version >= 19"
  );
  sqlite
    .prepare(
      "INSERT INTO watched_search_new (search_id, source, query, gallery_id, title, found_at) VALUES (1, 'hitomi', 'q', '7', 'Kept', '2026-01-01')"
    )
    .run();
  migrateSchema(sqlite);
  migrateSchema(sqlite);
  const columns = (
    sqlite.prepare("PRAGMA table_info(watched_search_new)").all() as {
      name: string;
    }[]
  ).map((column) => column.name);
  assert.ok(columns.includes("better_edition_json"));
  assert.ok(
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_match_updates_series'"
      )
      .get()
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT title, better_edition_json FROM watched_search_new")
      .all(),
    [{ title: "Kept", better_edition_json: null }]
  );
  sqlite.close();
});
