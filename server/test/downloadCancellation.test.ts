import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "htosho-cancel-"));
process.env.HTOSHO_DATA_DIR = dataDir;
const { initDb } = await import("../src/db/index.js");
const { DownloadQueue } = await import("../src/downloader/engine.js");
const { DEFAULT_DOWNLOADER } = await import("../src/services/settings.js");
const { doujinProviders } = await import("../src/downloader/providers.js");
const { fetchPageToFileWithRetry } =
  await import("../src/downloader/requests.js");
initDb();

test(
  "Cancel aborts a live HTTP stream and frees the queue for the next download",
  { timeout: 6000 },
  async () => {
    const requested = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      if (req.url === "/next.jpg") {
        res.end("fixture");
        return;
      }
      res.on("close", () => closed.resolve());
      res.write("partial fixture");
      requested.resolve();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address() as { port: number };
    const original = doujinProviders.hitomi;
    doujinProviders.hitomi = {
      ...original,
      getGallery: async (id) => ({
        source: "hitomi",
        galleryId: id,
        title: id,
        artists: [],
        tags: [],
        pages: [`http://127.0.0.1:${address.port}/${id}.jpg`],
      }),
    };
    const queue = new DownloadQueue(() => ({
      ...DEFAULT_DOWNLOADER,
      downloadDirectory: path.join(dataDir, "output"),
      maxConcurrentDownloads: 1,
      maxImageConcurrency: 1,
      requestDelayMs: 0,
      autoSyncKavita: false,
    }));
    try {
      const first = queue.enqueue("hitomi", "slow", "slow", "cbz");
      await requested.promise;
      const next = queue.enqueue("hitomi", "next", "next", "cbz");
      assert.equal(queue.cancel(first), true);
      await closed.promise;
      const deadline = Date.now() + 2500;
      while (
        (queue.isRunning(first) || queue.get(next)?.status !== "completed") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(queue.isRunning(first), false);
      assert.equal(queue.get(first)?.state.type, "cancelled");
      assert.equal(queue.get(next)?.status, "completed");
      assert.deepEqual(
        fs
          .readdirSync(path.join(dataDir, "tmp", "downloads", String(first)))
          .filter((name) => name.endsWith(".part")),
        []
      );
    } finally {
      doujinProviders.hitomi = original;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);

test(
  "Cancel interrupts a transient retry backoff without issuing another request",
  { timeout: 3000 },
  async () => {
    const original = globalThis.fetch;
    const requested = Promise.withResolvers<void>();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      requested.resolve();
      return new Response("retry", { status: 503 });
    };
    const controller = new AbortController();
    try {
      const pending = fetchPageToFileWithRetry(
        "https://fixture.test/page.jpg",
        {},
        path.join(dataDir, "retry-page"),
        {},
        controller.signal
      );
      const rejected = assert.rejects(pending, /Cancelled by user/);
      await requested.promise;
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort(new Error("Cancelled by user"));
      await rejected;
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(path.join(dataDir, "retry-page.part")), false);
    } finally {
      globalThis.fetch = original;
    }
  }
);
