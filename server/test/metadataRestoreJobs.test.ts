import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { KavitaSeriesMetadataDto } from "../src/kavita/types.js";

process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-restore-jobs-")
);
// DB configuration is captured at module load; imports must follow the isolated data-directory setup.
const { initDb, getDb, schema } = await import("../src/db/index.js");
const { setKavitaConnection } = await import("../src/services/settings.js");
const { withMetadataHistory, listMetadataHistory, metadataHistoryDetail } =
  await import("../src/services/metadataHistory.js");
const {
  createMetadataRestorePreview,
  enqueueMetadataRestore,
  executeMetadataRestore,
} = await import("../src/services/metadataRestore.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { runJob } = await import("../src/jobs/executor.js");
const { libraryMutations } = await import("../src/lib/mutations.js");
const { api } = await import("../src/routes/api.js");
const { KavitaClient } = await import("../src/kavita/client.js");
initDb();
setKavitaConnection({
  baseUrl: "https://restore-jobs.test",
  apiKey: "test-secret",
});
const client = new KavitaClient("https://restore-jobs.test", "test-secret");
const records = new Map<number, Record<string, unknown>>();
let writes = 0;
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/api/Server/server-info-slim")
    return Response.json({
      kavitaVersion: "0.9.0.22",
      installId: "restore-installation",
    });
  if (url.pathname === "/api/Library/libraries")
    return Response.json([{ id: 7, name: "Library", type: 0 }]);
  const id = Number(
    url.searchParams.get("seriesId") ??
      /\/Series\/(\d+)$/.exec(url.pathname)?.[1]
  );
  if (url.pathname === "/api/Series/metadata" && options?.method === "POST") {
    const body = JSON.parse(String(options.body)) as {
      seriesMetadata: KavitaSeriesMetadataDto;
    };
    writes++;
    records.set(
      body.seriesMetadata.seriesId!,
      structuredClone(body.seriesMetadata) as unknown as Record<string, unknown>
    );
    return Response.json(true);
  }
  if (url.pathname === "/api/Series/metadata")
    return Response.json(records.get(id));
  if (/\/Series\/\d+$/.test(url.pathname))
    return Response.json({
      id,
      libraryId: 7,
      name: `Series ${id}`,
      folderPath: `/library/${id}`,
    });
  throw new Error(`Unexpected restore job request: ${url.pathname}`);
};

async function source(id: number) {
  records.set(id, {
    id,
    seriesId: id,
    summary: "",
    summaryLocked: false,
    tags: [],
    tagsLocked: true,
    writers: [],
    writerLocked: false,
    language: "en",
    languageLocked: false,
  });
  await withMetadataHistory(
    client,
    id,
    "provider-apply",
    { summary: "Provider description", tags: ["new"] },
    async () => {
      records.get(id)!.summary = "Provider description";
      records.get(id)!.tags = [{ id: 1, title: "new" }];
    }
  );
  return listMetadataHistory(id).items[0].id;
}
async function terminal(id: number) {
  // The persistent queue exposes no completion event. Yield the event loop, not wall-clock time.
  for (let turn = 0; turn < 1000; turn++) {
    const row = jobQueue.get(id)!;
    if (!["queued", "running"].includes(row.status)) return row;
    await setImmediate();
  }
  throw new Error(`Restore Task ${id} did not finalize`);
}
test("generic job enqueue cannot bypass review or enqueue a gallery download", async () => {
  const response = await api.request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "restore-metadata",
      seriesId: 1,
      connectionKey: "https://restore-jobs.test",
      planId: "00000000-0000-0000-0000-000000000001",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(jobQueue.list().length, 0);
  assert.deepEqual(getDb().select().from(schema.downloadQueue).all(), []);
});

test("queued restore cancellation prevents writes and invalidates its approved plan", async () => {
  const operationId = await source(1);
  const preview = await createMetadataRestorePreview(client, 1, operationId, {
    snapshot: "before",
    fields: ["summary"],
  });
  const approved = enqueueMetadataRestore(
    1,
    preview.id,
    "cancelled-restore",
    (command) => jobQueue.enqueue("restore-metadata", command)
  );
  const command = jobQueue.get(approved.id)!.payload;
  assert.equal(jobQueue.cancel(approved.id), true);
  assert.equal(jobQueue.get(approved.id)!.status, "cancelled");
  const beforeWrites = writes;
  await assert.rejects(
    executeMetadataRestore(
      client,
      {
        seriesId: 1,
        connectionKey: command.connectionKey!,
        planId: command.planId!,
      },
      approved.id,
      () => {}
    )
  );
  assert.equal(writes, beforeWrites);
});

test("reviewed restore runs through the real Task executor with exact clears and linked history", async () => {
  const operationId = await source(2);
  const preview = await createMetadataRestorePreview(client, 2, operationId, {
    snapshot: "before",
    fields: ["summary", "tags"],
  });
  const approved = enqueueMetadataRestore(
    2,
    preview.id,
    "successful-restore",
    (command) => jobQueue.enqueue("restore-metadata", command)
  );
  jobQueue.registerHandler(runJob);
  const job = await terminal(approved.id);
  assert.equal(job.status, "completed", job.errorMessage ?? "");
  assert.equal(records.get(2)!.summary, "");
  assert.deepEqual(records.get(2)!.tags, []);
  assert.equal(records.get(2)!.tagsLocked, true);
  assert.equal(records.get(2)!.summaryLocked, false);
  assert.equal(records.get(2)!.language, "en");
  const history = listMetadataHistory(2).items[0];
  assert.equal(history.origin, "metadata-restore");
  assert.equal(history.restoredFromOperationId, operationId);
  assert.equal(
    metadataHistoryDetail(2, history.id)!.after!.fields.summary.value,
    ""
  );
  assert.deepEqual(getDb().select().from(schema.downloadQueue).all(), []);
});

test("a newer selected edit while waiting for ownership fails without writes or blind retry", async () => {
  const operationId = await source(3);
  const preview = await createMetadataRestorePreview(client, 3, operationId, {
    snapshot: "before",
    fields: ["summary"],
  });
  const gate = Promise.withResolvers<void>();
  const owned = libraryMutations.run(["series:3"], () => gate.promise);
  const approved = enqueueMetadataRestore(
    3,
    preview.id,
    "stale-restore",
    (command) => jobQueue.enqueue("restore-metadata", command)
  );
  records.get(3)!.summary = "Newer external edit";
  const beforeWrites = writes;
  gate.resolve();
  await owned;
  const job = await terminal(approved.id);
  assert.equal(job.status, "failed");
  assert.equal(writes, beforeWrites);
  assert.equal(records.get(3)!.summary, "Newer external edit");
  assert.equal(jobQueue.retryJob(approved.id), null);
  assert.match(job.recovery!.explanation, /fresh preview/);
  assert.equal(
    (await api.request(`/jobs/${approved.id}/retry`, { method: "POST" }))
      .status,
    409
  );
});
