import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { coverImage } from "./fixtures/coverImage.js";
import type { KavitaClient } from "../src/kavita/client.js";
import type { CoverRestoreSelection } from "../src/contracts/metadataCovers.js";
import { parseJobCommand } from "../src/contracts/jobs.js";
import { migrateSchema } from "../src/db/migrations.js";

process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-cover-restore-")
);
process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB = "40";
const { initDb, getDb, schema } = await import("../src/db/index.js");
const { setKavitaConnection } = await import("../src/services/settings.js");
const { withMetadataHistory, listMetadataHistory, metadataHistoryDetail } =
  await import("../src/services/metadataHistory.js");
const {
  createMetadataRestorePreview,
  enqueueMetadataRestore,
  executeMetadataRestore,
} = await import("../src/services/metadataRestore.js");
const { retainedCoverAsset, coverHistory, pruneUnusedCoverAssets } =
  await import("../src/services/metadataCovers.js");
const { retainedPreviewCoverAsset } =
  await import("../src/services/metadataCoverRestore.js");
const { saveFieldPolicy } = await import("../src/services/fieldPolicies.js");
const { libraryMutations } = await import("../src/lib/mutations.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { KavitaClient: HttpKavitaClient } =
  await import("../src/kavita/client.js");
initDb();
setKavitaConnection({
  baseUrl: "https://cover-restore.test",
  apiKey: "test-key",
});
const original = coverImage(170, 56, 106),
  replaced = coverImage(11, 125, 102),
  converted = coverImage(80, 120, 160),
  external = coverImage(110, 130, 150);
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
let nextId = 40000;
interface CoverFixtureState {
  seriesImage: Buffer;
  volumeImage: Buffer;
  seriesLock: boolean;
  volumeLock: boolean;
  seriesToken: string;
  volumeToken: string;
  createdUtc: string;
  noOp: boolean;
  uploads: { kind: "series" | "volume"; image: Buffer; lock: boolean }[];
}
interface CoverFixture {
  id: number;
  volumeId: number;
  state: CoverFixtureState;
  client: KavitaClient;
}

function fixture(exposeVolumeLock = true): CoverFixture {
  const id = nextId++,
    volumeId = id + 100000;
  const state: CoverFixtureState = {
    seriesImage: original,
    volumeImage: original,
    seriesLock: false,
    volumeLock: false,
    seriesToken: "original-series.png",
    volumeToken: "original-volume.png",
    createdUtc: "2020-01-01T00:00:00Z",
    noOp: false,
    uploads: [],
  };
  const series = () => ({
    id,
    libraryId: 7,
    name: "Retained series",
    folderPath: "/fixture/library",
    coverImage: state.seriesToken,
    coverImageLocked: state.seriesLock,
    nameLocked: true,
    sortName: "Retained series",
    sortNameLocked: true,
    localizedName: null,
    localizedNameLocked: false,
  });
  const client = {
    getSeriesDto: async () => series(),
    getSeriesById: async () => series(),
    getSeriesMetadata: async () => ({
      seriesId: id,
      summary: "Keep unselected metadata",
      summaryLocked: false,
    }),
    getServerInfo: async () => ({
      version: "0.9.1.4",
      installId: "cover-fixture",
    }),
    getSeriesCoverForHistory: async () => ({
      data: state.seriesImage,
      contentType: "image/png",
    }),
    getVolumeCoverForHistory: async () => ({
      data: state.volumeImage,
      contentType: "image/png",
    }),
    getVolumeForCoverHistory: async () => ({
      id: volumeId,
      seriesId: id,
      name: "1",
      createdUtc: state.createdUtc,
      coverImage: state.volumeToken,
      ...(exposeVolumeLock ? { coverImageLocked: state.volumeLock } : {}),
      chapters: [
        {
          id: 100,
          files: [{ id: 200, filePath: "/fixture/library/volume1.cbz" }],
        },
      ],
    }),
    updateSeriesCover: async (_id: number, image: Buffer, lock: boolean) => {
      state.uploads.push({ kind: "series", image, lock });
      if (!state.noOp) {
        state.seriesImage = converted;
        state.seriesToken = "restored-series.png";
        state.seriesLock = lock;
      }
    },
    updateVolumeCover: async (_id: number, image: Buffer, lock: boolean) => {
      state.uploads.push({ kind: "volume", image, lock });
      if (!state.noOp) {
        state.volumeImage = converted;
        state.volumeToken = "restored-volume.png";
        state.volumeLock = lock;
      }
    },
    restoreSeriesMetadataExact: async () => {
      throw new Error("Cover-only restore must not write metadata");
    },
    scanSeries: async () => {
      throw new Error("Cover restore must not scan");
    },
    scanLibrary: async () => {
      throw new Error("Cover restore must not scan");
    },
  };
  // The isolated fake implements every Kavita operation exercised by cover restoration, not the client's private transport fields.
  const apiClient = client as unknown as KavitaClient;
  return { id, volumeId, state, client: apiClient };
}

async function sourceSnapshot(f: CoverFixture, kind: "series" | "volume") {
  await libraryMutations.run([`series:${f.id}`], () =>
    withMetadataHistory(
      f.client,
      f.id,
      "provider-apply",
      {},
      async (journal) => {
        if (kind === "series") {
          await journal.captureSeriesCover();
          f.state.seriesImage = replaced;
          f.state.seriesToken = "new-series.png";
          f.state.seriesLock = true;
        } else {
          await journal.captureVolumeCover(f.volumeId);
          f.state.volumeImage = replaced;
          f.state.volumeToken = "new-volume.png";
          f.state.volumeLock = true;
        }
      }
    )
  );
  return listMetadataHistory(f.id).items[0].id;
}
async function runApproved(f: CoverFixture, previewId: string) {
  const queued = enqueueMetadataRestore(
    f.id,
    previewId,
    `cover-${f.id}-${previewId}`,
    (command) => jobQueue.enqueue("restore-metadata", command),
    true
  );
  const job = jobQueue.get(queued.id)!;
  const command = parseJobCommand(job.type, job.payload);
  if (command.type !== "restore-metadata")
    throw new Error("Wrong queued restore command");
  const result = await libraryMutations.run([`series:${f.id}`], () =>
    executeMetadataRestore(f.client, command.payload, queued.id, () => {})
  );
  return { queued, result };
}

for (const kind of ["series", "volume"] as const)
  test(`${kind} restores retained input through the supported API and journals actual re-encoded output and native lock`, async () => {
    const f = fixture(),
      operationId = await sourceSnapshot(f, kind);
    const selection: CoverRestoreSelection = {
      kind,
      ...(kind === "volume" ? { volumeId: f.volumeId } : {}),
      nativeLock: "saved",
    };
    const preview = await createMetadataRestorePreview(
      f.client,
      f.id,
      operationId,
      { snapshot: "before", fields: [], covers: [selection] }
    );
    assert.equal(preview.canRestore, true);
    assert.equal(preview.covers![0].requestedLock, false);
    assert.throws(
      () =>
        enqueueMetadataRestore(
          f.id,
          preview.id,
          "missing-conversion-review",
          (command) => jobQueue.enqueue("restore-metadata", command)
        ),
      /Explicit review/
    );
    const { result } = await runApproved(f, preview.id);
    assert.equal(result.restoredCovers, 1);
    assert.equal(result.unverifiedCoverLocks, 0);
    assert.deepEqual(f.state.uploads, [{ kind, image: original, lock: false }]);
    const checkpoint =
      kind === "series"
        ? coverHistory(result.operationId)!.series!
        : coverHistory(result.operationId)!.volumes[0];
    assert.equal(checkpoint.before.assetId, hash(replaced));
    assert.equal(checkpoint.after.assetId, hash(converted));
    assert.equal(checkpoint.after.nativeLocked, false);
    assert.equal(checkpoint.writeAcknowledged, true);
    assert.deepEqual(
      retainedCoverAsset(f.id, operationId, hash(original))!.data,
      original
    );
    assert.equal(
      metadataHistoryDetail(f.id, result.operationId)!.after!.fields.summary
        .value,
      "Keep unselected metadata"
    );
  });

test("unexposed native volume locks require explicit choice and are never invented as observed values", async () => {
  const f = fixture(false),
    operationId = await sourceSnapshot(f, "volume");
  const blocked = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    {
      snapshot: "before",
      fields: [],
      covers: [{ kind: "volume", volumeId: f.volumeId }],
    }
  );
  assert.equal(blocked.canRestore, false);
  assert.match(blocked.covers![0].reason!, /choose Locked or Unlocked/);
  const preview = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    {
      snapshot: "before",
      fields: [],
      covers: [{ kind: "volume", volumeId: f.volumeId, nativeLock: "locked" }],
    }
  );
  const { result } = await runApproved(f, preview.id);
  assert.equal(result.unverifiedCoverLocks, 1);
  const checkpoint = coverHistory(result.operationId)!.volumes[0];
  assert.equal(checkpoint.requestedLock, true);
  assert.equal(checkpoint.writeAcknowledged, true);
  assert.equal(checkpoint.before.nativeLocked, null);
  assert.equal(checkpoint.after.nativeLocked, null);
  assert.match(
    metadataHistoryDetail(f.id, result.operationId)!.message!,
    /does not expose lock readback/
  );
});

test("new protection or changed current image blocks an approved cover write before publication", async () => {
  for (const change of ["policy", "image"] as const) {
    const f = fixture(),
      operationId = await sourceSnapshot(f, "series");
    const preview = await createMetadataRestorePreview(
      f.client,
      f.id,
      operationId,
      { snapshot: "before", fields: [], covers: [{ kind: "series" }] }
    );
    const queued = enqueueMetadataRestore(
      f.id,
      preview.id,
      `conflict-${f.id}`,
      (command) => jobQueue.enqueue("restore-metadata", command),
      true
    );
    const job = jobQueue.get(queued.id)!;
    const command = parseJobCommand(job.type, job.payload);
    if (command.type !== "restore-metadata")
      throw new Error("Wrong queued cover command");
    if (change === "policy") await saveFieldPolicy(f.id, ["cover"], 0);
    else {
      f.state.seriesImage = external;
      f.state.seriesToken = "external.png";
    }
    await assert.rejects(
      libraryMutations.run([`series:${f.id}`], () =>
        executeMetadataRestore(f.client, command.payload, queued.id, () => {})
      ),
      /changed after preview|Protection settings/
    );
    assert.deepEqual(f.state.uploads, []);
    assert.deepEqual(
      retainedCoverAsset(f.id, operationId, hash(original))!.data,
      original
    );
  }
});

test("reused volume identity and missing historical assets cannot authorize a cover restore", async () => {
  const f = fixture(),
    operationId = await sourceSnapshot(f, "volume");
  f.state.createdUtc = "2025-01-01T00:00:00Z";
  const changed = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    {
      snapshot: "before",
      fields: [],
      covers: [{ kind: "volume", volumeId: f.volumeId, nativeLock: "locked" }],
    }
  );
  assert.equal(changed.canRestore, false);
  assert.match(changed.covers![0].reason!, /volume identity/);
  getDb()
    .delete(schema.metadataAssets)
    .where(eq(schema.metadataAssets.id, hash(original)))
    .run();
  const missing = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    {
      snapshot: "before",
      fields: [],
      covers: [{ kind: "volume", volumeId: f.volumeId, nativeLock: "locked" }],
    }
  );
  assert.equal(missing.canRestore, false);
  assert.deepEqual(f.state.uploads, []);
});

test("current preview assets stay authorized and pinned for unavailable previews and durable queue delays", async () => {
  const f = fixture(false),
    operationId = await sourceSnapshot(f, "volume");
  f.state.volumeImage = external;
  f.state.volumeToken = "external-volume.png";
  const blocked = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    {
      snapshot: "before",
      fields: [],
      covers: [{ kind: "volume", volumeId: f.volumeId }],
    }
  );
  pruneUnusedCoverAssets();
  assert.deepEqual(
    retainedPreviewCoverAsset(f.id, blocked.id, hash(external))!.data,
    external
  );
  assert.equal(
    retainedPreviewCoverAsset(f.id + 1, blocked.id, hash(external)),
    null
  );
  const preview = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    {
      snapshot: "before",
      fields: [],
      covers: [{ kind: "volume", volumeId: f.volumeId, nativeLock: "locked" }],
    }
  );
  enqueueMetadataRestore(
    f.id,
    preview.id,
    `pinned-${f.id}`,
    (command) => jobQueue.enqueue("restore-metadata", command),
    true
  );
  getDb()
    .delete(schema.metadataRestorePreviews)
    .where(eq(schema.metadataRestorePreviews.id, preview.id))
    .run();
  pruneUnusedCoverAssets();
  assert.deepEqual(
    retainedPreviewCoverAsset(f.id, preview.id, hash(external))!.data,
    external
  );
});

test("a silent cover upload no-op is retained as unverified rather than a restored image", async () => {
  const f = fixture(),
    operationId = await sourceSnapshot(f, "series");
  const preview = await createMetadataRestorePreview(
    f.client,
    f.id,
    operationId,
    { snapshot: "before", fields: [], covers: [{ kind: "series" }] }
  );
  f.state.noOp = true;
  await assert.rejects(runApproved(f, preview.id), /no observed cover change/);
  const operation = listMetadataHistory(f.id).items[0];
  assert.equal(operation.status, "unverified");
  assert.equal(
    coverHistory(operation.id)!.series!.after.assetId,
    hash(replaced)
  );
});

test("cover upgrade preserves existing series images and does not manufacture volume backups", () => {
  const db = new Database(":memory:");
  try {
    migrateSchema(db);
    db.exec(`DROP TABLE metadata_volume_covers;
      ALTER TABLE metadata_series_covers DROP COLUMN after_evidence_json;
      ALTER TABLE metadata_series_covers DROP COLUMN requested_lock;
      ALTER TABLE metadata_series_covers DROP COLUMN write_acknowledged;
      ALTER TABLE metadata_restore_previews DROP COLUMN covers_json;
      ALTER TABLE metadata_restore_plans DROP COLUMN covers_json;
      DELETE FROM schema_migrations WHERE version=13;
      INSERT INTO metadata_series_covers(operation_id,before_state,before_asset_id,before_locked,after_state,after_asset_id,after_locked)
      VALUES('legacy','captured','before-asset',1,'captured','after-asset',0);`);
    migrateSchema(db);
    assert.deepEqual(
      db
        .prepare(
          "SELECT before_asset_id, before_locked, after_asset_id, after_locked FROM metadata_series_covers"
        )
        .get(),
      {
        before_asset_id: "before-asset",
        before_locked: 1,
        after_asset_id: "after-asset",
        after_locked: 0,
      }
    );
    assert.deepEqual(
      db.prepare("SELECT volume_id FROM metadata_volume_covers").all(),
      []
    );
  } finally {
    db.close();
  }
});

test("supported volume HTTP reads do not invent native locks and uploads preserve retained input", async () => {
  const client = new HttpKavitaClient(
    "https://volume-contract.test",
    "fixture-key"
  );
  const originalFetch = globalThis.fetch;
  const uploads: { kind: string; id: number; image: Buffer; lock: boolean }[] =
    [];
  let invalidLock = false,
    wrongVolume = false;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/Series/volume")
        return Response.json({
          id: wrongVolume ? 999 : 101,
          seriesId: 42,
          name: "1",
          createdUtc: "2020-01-01T00:00:00Z",
          coverImage: "volume.png",
          chapters: [
            { id: 201, files: [{ id: 301, filePath: "/fixture/volume.cbz" }] },
          ],
          ...(invalidLock ? { coverImageLocked: "true" } : {}),
        });
      if (url.pathname === "/api/Image/volume-cover") {
        assert.equal(url.searchParams.get("volumeId"), "101");
        return new Response(original, {
          headers: { "content-type": "image/png" },
        });
      }
      if (
        url.pathname === "/api/Upload/volume" ||
        url.pathname === "/api/Upload/series"
      ) {
        const body = JSON.parse(String(init?.body));
        uploads.push({
          kind: url.pathname.endsWith("/volume") ? "volume" : "series",
          id: body.id,
          image: Buffer.from(body.url, "base64"),
          lock: body.lockCover,
        });
        return Response.json(true);
      }
      throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
    };
    const volume = await client.getVolumeForCoverHistory(101);
    assert.equal(Object.hasOwn(volume, "coverImageLocked"), false);
    assert.deepEqual(
      (await client.getVolumeCoverForHistory(101))!.data,
      original
    );
    await client.updateVolumeCover(101, original, false);
    await client.updateSeriesCover(42, original, true);
    assert.deepEqual(uploads, [
      { kind: "volume", id: 101, image: original, lock: false },
      { kind: "series", id: 42, image: original, lock: true },
    ]);
    invalidLock = true;
    await assert.rejects(
      client.getVolumeForCoverHistory(101),
      /identity.*malformed/
    );
    invalidLock = false;
    wrongVolume = true;
    await assert.rejects(
      client.getVolumeForCoverHistory(101),
      /another volume/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("separate-process restart retains volume originals and marks unfinished cover readback interrupted", async () => {
  const f = fixture(false),
    operationId = await sourceSnapshot(f, "volume");
  getDb()
    .update(schema.metadataOperations)
    .set({ status: "running", afterJson: null, finishedAt: null })
    .where(eq(schema.metadataOperations.id, operationId))
    .run();
  getDb()
    .update(schema.metadataVolumeCovers)
    .set({
      status: "applying",
      afterState: "unavailable",
      afterAssetId: null,
      reservedBytes: 5 * 1024 * 1024,
    })
    .where(eq(schema.metadataVolumeCovers.operationId, operationId))
    .run();
  const dbUrl = new URL("../src/db/index.ts", import.meta.url).href,
    historyUrl = new URL("../src/services/metadataHistory.ts", import.meta.url)
      .href;
  const restarted = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type",
      "module",
      "--eval",
      `const {initDb}=await import(${JSON.stringify(dbUrl)});initDb();const {interruptMetadataHistory}=await import(${JSON.stringify(historyUrl)});interruptMetadataHistory();`,
    ],
    { env: { ...process.env }, encoding: "utf8", windowsHide: true }
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(metadataHistoryDetail(f.id, operationId)!.status, "interrupted");
  const checkpoint = coverHistory(operationId)!.volumes[0];
  assert.equal(checkpoint.status, "interrupted");
  assert.equal(checkpoint.before.nativeLocked, null);
  assert.deepEqual(
    retainedCoverAsset(f.id, operationId, hash(original))!.data,
    original
  );
  assert.equal(
    getDb()
      .select()
      .from(schema.metadataVolumeCovers)
      .where(eq(schema.metadataVolumeCovers.operationId, operationId))
      .get()!.reservedBytes,
    0
  );
});
