import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HTOSHO_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "htosho-following-jobs-")
);
const { initDb, schema } = await import("../src/db/index.js");
const {
  addWatchedSearch,
  checkWatchedSearches,
  listWatchedSearches,
  updateWatchedSearch,
} = await import("../src/services/watchedSearches.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { runJob } = await import("../src/jobs/executor.js");

// Exercise storage parsing and the executor, not just the service's optional arguments.
test("queued Check once targets a paused watch without checking other active watches or acquiring content", async () => {
  const db = initDb();
  const original = doujinProviders.hitomi;
  const calls: string[] = [];
  let galleryId = "seed";
  doujinProviders.hitomi = {
    id: "hitomi",
    name: "Hitomi.la",
    color: "#ff5722",
    async getGallery() {
      throw new Error("Unexpected gallery hydration");
    },
    async search(query) {
      calls.push(query);
      return [
        {
          source: "hitomi",
          galleryId,
          title: galleryId,
          tags: [],
          artists: [],
        },
      ];
    },
  };
  try {
    const target = addWatchedSearch("hitomi", "artist:target");
    await checkWatchedSearches(() => {}, undefined, undefined, {
      mode: "manual",
      watchIds: [target.id],
    });
    updateWatchedSearch(target.id, {
      expectedRevision: target.revision,
      paused: true,
    });
    const other = addWatchedSearch("hitomi", "artist:other");
    calls.length = 0;
    galleryId = "new-find";
    const id = jobQueue.enqueue("check-watched-searches", {
      mode: "manual",
      watchIds: [target.id],
    });
    const result = await runJob(jobQueue.get(id)!, () => {});
    const watches = listWatchedSearches();
    assert.deepEqual(calls, ["artist:target"]);
    assert.deepEqual(
      watches
        .find((watch) => watch.id === target.id)!
        .lastResults.map((item) => item.galleryId),
      ["new-find"]
    );
    assert.ok(watches.find((watch) => watch.id === target.id)!.pausedAt);
    assert.equal(
      watches.find((watch) => watch.id === other.id)!.lastCheckedAt,
      null
    );
    assert.equal(result.notified, 0);
    assert.equal(db.select().from(schema.downloadQueue).all().length, 0);
  } finally {
    doujinProviders.hitomi = original;
  }
});
