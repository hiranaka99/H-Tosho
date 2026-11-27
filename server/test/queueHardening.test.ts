import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-queue-hardening-")
);
const outputDir = path.join(dataDir, "output");
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb, getDb, getTmpDir, schema } = await import("../src/db/index.js");
const { DownloadQueue, downloadQueue: singletonQueue } =
  await import("../src/downloader/engine.js");
const { api } = await import("../src/routes/api.js");
const { DEFAULT_DOWNLOADER, setDownloaderSettings } =
  await import("../src/services/settings.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const originalHitomi = doujinProviders.hitomi;

initDb();
after(() => {
  doujinProviders.hitomi = originalHitomi;
  globalThis.fetch = originalFetch;
});

const PAGES = [
  "https://cdn.test/p0.jpg",
  "https://cdn.test/p1.jpg",
  "https://cdn.test/p2.jpg",
];

const originalFetch = globalThis.fetch;
/** url -> number of times the stubbed fetch saw it this test. */
const fetchCounts = new Map<string, number>();
/** gallery ids in the order their metadata was resolved (claim order). */
const claimed: string[] = [];

function stubFetch(
  behavior: (url: string) => "ok" | "fail" = () => "ok"
): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1);
    if (behavior(url) === "fail") throw new Error("Download failed: HTTP 404");
    return new Response(Buffer.from(`image-${url}`));
  }) as typeof fetch;
}

doujinProviders.hitomi = {
  id: "hitomi",
  name: "Hitomi",
  color: "#000",
  async search() {
    return [];
  },
  async getGallery(idOrUrl) {
    claimed.push(idOrUrl);
    return {
      source: "hitomi",
      galleryId: idOrUrl,
      title: `Gallery ${idOrUrl}`,
      tags: [],
      artists: [],
      pages: PAGES,
    };
  },
};

const settings = () => ({
  downloadDirectory: outputDir,
  format: "cbz" as const,
  maxConcurrentDownloads: 1,
  maxImageConcurrency: 1,
  requestDelayMs: 0,
  autoSyncKavita: false,
  nhentaiApiKey: "",
  nhentaiBannedTags: [],
});

function insertRow(
  values: Partial<{ galleryId: string; status: string; priority: number }>
): number {
  const res = getDb()
    .insert(schema.downloadQueue)
    .values({ source: "hitomi", outputFormat: "cbz", ...values })
    .run();
  return Number(res.lastInsertRowid);
}

function waitForStatus(
  queue: InstanceType<typeof DownloadQueue>,
  id: number,
  status: string
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  const finish = (): void => {
    unsubscribe();
    resolve();
  };
  unsubscribe = queue.subscribe((task) => {
    if (task.id === id && task.status === status) finish();
  });
  if (queue.get(id)?.status === status) finish();
  return promise;
}

function waitForTerminal(
  queue: InstanceType<typeof DownloadQueue>,
  id: number
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  const finish = (): void => {
    unsubscribe();
    resolve();
  };
  unsubscribe = queue.subscribe((task) => {
    if (
      task.id === id &&
      (task.status === "completed" || task.status === "failed")
    )
      finish();
  });
  const cur = queue.get(id)?.status;
  if (cur === "completed" || cur === "failed") finish();
  return promise;
}
const taskTmpDir = (id: number): string =>
  path.join(getTmpDir(), "downloads", String(id));
const count = (url: string): number => fetchCounts.get(url) ?? 0;

test("claimNext claims queued tasks by priority DESC then id ASC", async () => {
  stubFetch();
  claimed.length = 0;
  const queue = new DownloadQueue(settings);
  // Insert out of priority order so FIFO ordering would give a different result.
  const low = insertRow({ galleryId: "low", status: "queued", priority: 0 });
  const high = insertRow({ galleryId: "high", status: "queued", priority: 5 });
  const mid = insertRow({ galleryId: "mid", status: "queued", priority: 1 });

  queue.start();
  await Promise.all([
    waitForStatus(queue, low, "completed"),
    waitForStatus(queue, high, "completed"),
    waitForStatus(queue, mid, "completed"),
  ]);

  assert.deepEqual(claimed, ["high", "mid", "low"]);
});

test("enqueue persists an explicit priority", async () => {
  // No download directory: the pump fails these rows immediately without any
  // network activity, so nothing here can leak into the counting tests below.
  const queue = new DownloadQueue(() => ({
    ...settings(),
    downloadDirectory: "",
  }));
  const id = queue.enqueue(
    "hitomi",
    "prio-arg",
    null,
    "cbz",
    undefined,
    undefined,
    7
  );
  assert.equal(queue.get(id)!.priority, 7);
  await waitForTerminal(queue, id);
  queue.remove(id);
  const fallback = queue.enqueue("hitomi", "prio-default", null, "cbz");
  assert.equal(queue.get(fallback)!.priority, 0);
  await waitForTerminal(queue, fallback);
  queue.remove(fallback);
});

test("POST /downloads blocks duplicates in flight and already owned, with distinct messages", async () => {
  setDownloaderSettings({
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: outputDir,
    requestDelayMs: 0,
    autoSyncKavita: false,
  });
  stubFetch();
  claimed.length = 0;
  // Static rows: never handed to a pump, so statuses stay exactly as inserted.
  const dupQueuedId = insertRow({
    galleryId: "dup-queued",
    status: "queued",
    priority: 0,
  });
  const dupDownloadingId = insertRow({
    galleryId: "dup-downloading",
    status: "downloading",
    priority: 0,
  });
  insertRow({ galleryId: "dup-paused", status: "paused", priority: 0 });
  insertRow({ galleryId: "dup-owned", status: "completed", priority: 0 });

  for (const galleryId of ["dup-queued", "dup-downloading", "dup-paused"]) {
    const res = await api.request("/downloads", {
      method: "POST",
      body: JSON.stringify({ source: "hitomi", galleryId, title: "Dup" }),
    });
    assert.equal(res.status, 409, galleryId);
    const body = (await res.json()) as {
      error: string;
      status?: string;
      message?: string;
    };
    assert.equal(body.error, "already-queued", galleryId);
    assert.ok(body.message, "in-flight 409 carries a human-readable message");
  }

  const owned = await api.request("/downloads", {
    method: "POST",
    body: JSON.stringify({ source: "hitomi", galleryId: "dup-owned" }),
  });
  assert.equal(owned.status, 409);
  const ownedBody = (await owned.json()) as {
    error: string;
    message?: string;
    finishedAt?: string | null;
  };
  assert.equal(ownedBody.error, "already-downloaded");
  assert.ok(ownedBody.message);

  const removeActive = await api.request(`/downloads/${dupDownloadingId}`, {
    method: "DELETE",
  });
  assert.equal(removeActive.status, 409);
  assert.ok(
    singletonQueue.get(dupDownloadingId),
    "active task row remains intact"
  );

  const mergedFolder = await api.request("/downloads", {
    method: "POST",
    body: JSON.stringify({
      source: "hitomi",
      galleryId: "folder-merge",
      format: "folder",
      mergeFolder: "One Series",
    }),
  });
  assert.equal(mergedFolder.status, 400);
  assert.equal(
    (await mergedFolder.json()).error,
    "Merged downloads require CBZ output"
  );

  const invalidFormat = await api.request("/downloads", {
    method: "POST",
    body: JSON.stringify({
      source: "hitomi",
      galleryId: "bad-format",
      format: "rar",
    }),
  });
  assert.equal(invalidFormat.status, 400);

  // A fresh gallery still enqueues, and its optional priority is persisted.
  const res = await api.request("/downloads", {
    method: "POST",
    body: JSON.stringify({
      source: "hitomi",
      galleryId: "fresh-1",
      priority: 3,
    }),
  });
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: number };
  const row = getDb()
    .select()
    .from(schema.downloadQueue)
    .all()
    .find((r) => r.id === id);
  assert.equal(row?.priority, 3);
  // The singleton pump claims whatever is 'queued' once fresh-1 is enqueued —
  // that includes dup-queued. Drain every claimable row to a terminal state and
  // drop all rows this test created so later tests start from a clean queue.
  await Promise.all([
    waitForTerminal(singletonQueue, dupQueuedId),
    waitForTerminal(singletonQueue, id),
  ]);
  singletonQueue.cancel(dupDownloadingId);
  // Terminal status can precede the last cleanup notification. Wait for the
  // writers to unwind before removing rows under the stricter safety boundary.
  while ([dupQueuedId, id].some((rowId) => singletonQueue.isRunning(rowId)))
    await new Promise<void>((resolve) => setImmediate(resolve));
  for (const rowId of [dupQueuedId, dupDownloadingId, id])
    assert.equal(singletonQueue.remove(rowId), true);
});

test("retry resumes from pre-seeded partial page files without re-fetching them", async () => {
  stubFetch();
  claimed.length = 0;
  const queue = new DownloadQueue(settings);
  const id = insertRow({ galleryId: "resume", status: "failed", priority: 0 });
  const tdir = taskTmpDir(id);
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "0"), "page-0-bytes");
  fs.writeFileSync(path.join(tdir, "1"), "page-1-bytes");

  fetchCounts.clear();
  assert.ok(queue.retry(id));
  await waitForStatus(queue, id, "completed");

  // Pages 0 and 1 came from disk; only page 2 hit the network.
  assert.equal(count(PAGES[0]), 0);
  assert.equal(count(PAGES[1]), 0);
  assert.equal(count(PAGES[2]), 1);

  const task = queue.get(id)!;
  assert.equal(task.status, "completed");
  assert.equal(task.progressCurrent, 3);
  assert.ok(task.outputPath && fs.existsSync(task.outputPath));
  // Terminal success cleans the scratch dir.
  assert.ok(!fs.existsSync(tdir));
});

test("resume prefix stops at the first missing page file", async () => {
  stubFetch();
  claimed.length = 0;
  const queue = new DownloadQueue(settings);
  const id = insertRow({
    galleryId: "resume-gap",
    status: "failed",
    priority: 0,
  });
  const tdir = taskTmpDir(id);
  fs.mkdirSync(tdir, { recursive: true });
  // Hole at index 1: only page 0 is trusted; 1 and 2 must be re-downloaded.
  fs.writeFileSync(path.join(tdir, "0"), "page-0-bytes");
  fs.writeFileSync(path.join(tdir, "2"), "stale-page-2-bytes");

  fetchCounts.clear();
  assert.ok(queue.retry(id));
  await waitForStatus(queue, id, "completed");

  assert.equal(count(PAGES[0]), 0);
  assert.equal(count(PAGES[1]), 1);
  assert.equal(count(PAGES[2]), 1);
  assert.equal(queue.get(id)!.status, "completed");
});

test("start resumes interrupted downloading rows from partial pages", async () => {
  stubFetch();
  claimed.length = 0;
  const queue = new DownloadQueue(settings);
  const id = insertRow({
    galleryId: "interrupted",
    status: "downloading",
    priority: 0,
  });
  const tdir = taskTmpDir(id);
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "0"), "page-0-bytes");

  fetchCounts.clear();
  queue.start();
  await waitForStatus(queue, id, "completed");

  // Page 0 survived the restart and was not re-fetched.
  assert.equal(count(PAGES[0]), 0);
  assert.equal(count(PAGES[1]), 1);
  assert.equal(count(PAGES[2]), 1);
  const task = queue.get(id)!;
  assert.equal(task.status, "completed");
  assert.equal(task.errorMessage, null);
});

test("different galleries with the same title get distinct output paths", async () => {
  stubFetch();
  const queue = new DownloadQueue(settings);
  const first = queue.enqueue("hitomi", "same-title-a", "Same Title", "cbz");
  const second = queue.enqueue("hitomi", "same-title-b", "Same Title", "cbz");
  await Promise.all([
    waitForStatus(queue, first, "completed"),
    waitForStatus(queue, second, "completed"),
  ]);
  const firstPath = queue.get(first)?.outputPath;
  const secondPath = queue.get(second)?.outputPath;
  assert.ok(firstPath && secondPath);
  assert.notEqual(firstPath, secondPath);
  assert.ok(fs.existsSync(firstPath));
  assert.ok(fs.existsSync(secondPath));
});

test("removing a task deletes its scratch directory", async () => {
  stubFetch();
  claimed.length = 0;
  const queue = new DownloadQueue(settings);
  const id = insertRow({ galleryId: "removed", status: "failed", priority: 0 });
  const tdir = taskTmpDir(id);
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "0"), "page-0-bytes");

  assert.ok(queue.remove(id));
  assert.equal(queue.get(id), null);
  // remove() deletes the scratch dir with a fire-and-forget fs.promises.rm —
  // no event or promise is exposed to await, so poll the real filesystem
  // briefly (deterministic control is not possible here).
  for (let i = 0; i < 100 && fs.existsSync(tdir); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!fs.existsSync(tdir));
});
