import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { KavitaClient } from "../src/kavita/client.js";
import type { SeriesMetadata } from "../src/providers/types.js";

process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-field-policy-")
);
const { initDb } = await import("../src/db/index.js");
const { setKavitaConnection } = await import("../src/services/settings.js");
const {
  getFieldPolicy,
  saveFieldPolicy,
  FieldPolicyConflict,
  inheritFieldPoliciesOwned,
} = await import("../src/services/fieldPolicies.js");
const { applyResolvedSeriesMatch } = await import("../src/services/sync.js");
const { libraryMutations } = await import("../src/lib/mutations.js");
const { migrateSchema } = await import("../src/db/migrations.js");
initDb();
setKavitaConnection({ baseUrl: "https://policy.test", apiKey: "fixture" });

test("policy validation, optimistic revisions, empty policies and connection isolation", async () => {
  assert.deepEqual(getFieldPolicy(1), { lockedFields: [], revision: 0 });
  const first = await saveFieldPolicy(1, ["title", "tags", "title"], 0);
  assert.deepEqual(first, { lockedFields: ["title", "tags"], revision: 1 });
  await assert.rejects(saveFieldPolicy(1, [], 0), FieldPolicyConflict);
  assert.throws(() => saveFieldPolicy(1, ["not-a-field"], 1), /Invalid/);
  assert.throws(() => saveFieldPolicy(1, [], -1), /Invalid/);
  await saveFieldPolicy(1, [], 1);
  assert.equal(getFieldPolicy(1).revision, 2);
  setKavitaConnection({
    baseUrl: "https://other-policy.test",
    apiKey: "fixture",
  });
  assert.equal(getFieldPolicy(1).revision, 0);
  setKavitaConnection({ baseUrl: "https://policy.test/", apiKey: "fixture" });
  assert.equal(getFieldPolicy(1).revision, 2);
});

test("protected title avoids filesystem resolution and covers/tags never write", async () => {
  await saveFieldPolicy(2, ["title", "tags", "cover"], 0);
  const patches: object[] = [];
  const client = {
    getSeriesDto: async () => ({ id: 2, libraryId: 1, name: "Keep my title" }),
    getSeriesMetadata: async () => ({ summary: "Old description" }),
    getSeriesById: async () => ({ id: 2, libraryId: 1, name: "Keep my title" }),
    getLibraries: async () => {
      throw new Error("Locked title must not resolve archive paths");
    },
    updateSeriesMetadata: async (_id: number, patch: object) => {
      patches.push(patch);
    },
    updateSeriesCoverFromUrl: async () => {
      throw new Error("Locked cover must not be uploaded");
    },
    getVolumes: async () => {
      throw new Error("Locked volume covers must not be resolved");
    },
  } as unknown as KavitaClient;
  const meta: SeriesMetadata = {
    providerId: "anilist",
    providerSeriesId: "2",
    title: "Provider title",
    summary: "New description",
    tags: ["new"],
    genres: [],
    writers: [],
    artists: [],
    coverUrl: "https://fixture.invalid/cover",
    volumeCovers: [{ number: 1, url: "https://fixture.invalid/volume" }],
  };
  const result = await libraryMutations.run(["series:2"], () =>
    applyResolvedSeriesMatch(
      client,
      { seriesId: 2, providerId: "anilist", providerSeriesId: "2" },
      meta
    )
  );
  assert.deepEqual(patches, [{ summary: "New description" }]);
  assert.equal(result.titleFilesUpdated, 0);
  assert.equal(result.coverUpdated, false);
  assert.equal(result.volumeCoversUpdated, 0);
  assert.match(result.warnings.join(" "), /Protected/);
});

test("a queued operation observes protection committed before it executes", async () => {
  const release = Promise.withResolvers<void>();
  const owner = libraryMutations.run(["series:3"], () => release.promise);
  const policy = saveFieldPolicy(3, ["title"], 0);
  const queued = libraryMutations.run(["series:3"], async () =>
    getFieldPolicy(3)
  );
  release.resolve();
  await owner;
  await policy;
  assert.deepEqual((await queued).lockedFields, ["title"]);
});

test("unmatch retains protected metadata and covers while removing identification", async () => {
  const { getDb, schema } = await import("../src/db/index.js");
  const { removeSeriesMatch } = await import("../src/services/unmatch.js");
  await saveFieldPolicy(9, ["summary", "cover"], 0);
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: 9,
      status: "matched",
      metadataJson: JSON.stringify({
        title: "Example",
        summary: "Keep this",
        tags: [],
        genres: [],
        artists: [],
        writers: [],
      }),
    })
    .run();
  getDb()
    .insert(schema.syncHistory)
    .values({
      kavitaSeriesId: 9,
      action: "updated",
      detailsJson: JSON.stringify({
        pushed: ["summary", "tags"],
        coverUpdated: true,
        volumeCoversUpdated: 1,
        volumeCoverIds: [90],
      }),
    })
    .run();
  let removed: string[] = [];
  const client = {
    getSeriesDto: async () => ({ id: 9, libraryId: 1, name: "Example" }),
    getSeriesMetadata: async () => ({ summary: "Keep this" }),
    getSeriesById: async () => ({ id: 9, libraryId: 1, name: "Example" }),
    removeSeriesMetadata: async (
      _id: number,
      _meta: unknown,
      fields: string[]
    ) => {
      removed = fields;
    },
    scanSeries: async () => {},
    resetSeriesCover: async () => {
      throw Error("Protected cover reset");
    },
    getVolumes: async () => {
      throw Error("Protected volume cover lookup");
    },
  } as unknown as KavitaClient;
  assert.deepEqual(await removeSeriesMatch(client, 9), { removed: true });
  assert.deepEqual(removed, ["tags"]);
  assert.deepEqual(getFieldPolicy(9).lockedFields, ["summary", "cover"]);
});

test("new policy table upgrades an existing migration stamp and survives repeat migration", () => {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  sqlite.exec(
    "DROP TABLE series_field_policies; DELETE FROM schema_migrations WHERE version=4"
  );
  migrateSchema(sqlite);
  sqlite
    .prepare("INSERT INTO series_field_policies VALUES (?,?,?,?,?)")
    .run("https://fixture", 1, '["title"]', 1, new Date().toISOString());
  migrateSchema(sqlite);
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) AS n FROM series_field_policies")
        .get() as { n: number }
    ).n,
    1
  );
  sqlite.close();
});

test("policy transfer rereads newer source locks and does not resurrect a source unlock", async () => {
  const sourceId = 9101,
    targetId = 9102,
    laterTargetId = 9103;
  const source = await saveFieldPolicy(sourceId, ["summary"], 0);
  await saveFieldPolicy(targetId, ["tags"], 0);
  // Evidence captured when the merge was reviewed; the source changes afterwards.
  const evidence = [{ seriesId: sourceId, lockedFields: source.lockedFields }];
  await saveFieldPolicy(sourceId, ["title", "summary"], source.revision);
  await libraryMutations.run([`series:${targetId}`], async () =>
    inheritFieldPoliciesOwned(
      targetId,
      source.lockedFields,
      "https://policy.test",
      evidence
    )
  );
  assert.deepEqual(getFieldPolicy(targetId).lockedFields, [
    "title",
    "summary",
    "tags",
  ]);

  await saveFieldPolicy(sourceId, [], getFieldPolicy(sourceId).revision);
  await libraryMutations.run([`series:${laterTargetId}`], async () =>
    inheritFieldPoliciesOwned(
      laterTargetId,
      source.lockedFields,
      "https://policy.test",
      evidence
    )
  );
  assert.deepEqual(getFieldPolicy(laterTargetId).lockedFields, []);
});
