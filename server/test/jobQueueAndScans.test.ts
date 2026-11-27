import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { eq } from "drizzle-orm";
import type { Job } from "../src/jobs/queue.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "htosho-queue-scans-"));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb, getDb, schema } = await import("../src/db/index.js");
const { buildZip } = await import("../src/downloader/zip.js");
const { runJob } = await import("../src/jobs/executor.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { readComicInfo } = await import("../src/lib/cbz.js");
const { archiveResource, archiveResourceAsync } =
  await import("../src/lib/mutations.js");
const { KavitaClient } = await import("../src/kavita/client.js");
const { setKavitaConnection } = await import("../src/services/settings.js");

initDb();
setKavitaConnection({ baseUrl: "https://kavita.example", apiKey: "secret" });
const originalFetch = globalThis.fetch;
// Keep a real event-loop turn available while Date and application timers are mocked.
const realSetTimeout = globalThis.setTimeout;
const yieldToIo = () =>
  new Promise<void>((resolve) => realSetTimeout(resolve, 10));
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function finishWithScanClock<T>(
  t: TestContext,
  run: () => Promise<T>
): Promise<T> {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let done = false;
  const result = run().finally(() => {
    done = true;
  });
  void result.catch(() => {});
  const deadline = performance.now() + 15_000;
  while (!done && performance.now() < deadline) {
    // setImmediate alone can advance simulated timeouts before archive
    // filesystem callbacks finish on slower runners.
    await yieldToIo();
    if (done) return result;
    t.mock.timers.tick(5_000);
  }
  assert.fail("Scan verification did not finish");
}

function makeEditJob(
  file: string,
  seriesId: number,
  fields: Record<string, string>
): Job {
  return {
    id: 1,
    type: "edit-comicinfo",
    payload: { path: file, seriesId, fields },
    status: "running",
    progressCurrent: 0,
    progressTotal: 0,
    result: null,
    errorMessage: null,
    createdAt: "",
    startedAt: "",
    finishedAt: null,
  };
}

test("archiveResourceAsync resolves identically to archiveResource", async () => {
  const dir = path.join(dataDir, "identity");
  fs.mkdirSync(dir, { recursive: true });
  const existing = path.join(dir, "chapter.cbz");
  fs.writeFileSync(existing, "stub");
  for (const file of [existing, dir, path.join(dir, "not yet published.cbz")]) {
    assert.equal(await archiveResourceAsync(file), archiveResource(file));
  }
});

test("job logs return the newest lines oldest-first, and active-type checks need no hydration", () => {
  const id = jobQueue.enqueue("clear-overrides", {});
  getDb()
    .update(schema.jobs)
    .set({ status: "running" })
    .where(eq(schema.jobs.id, id))
    .run();
  assert.equal(jobQueue.hasActiveType("clear-overrides"), true);
  assert.equal(jobQueue.hasActiveType("scan-matchable"), false);
  for (let index = 0; index < 2100; index++)
    jobQueue.log(id, "info", `line ${index}`);
  const logs = jobQueue.logs(id);
  assert.equal(logs.length, 2000);
  assert.equal(logs.at(-1)!.message, "line 2099");
  assert.ok(
    logs.every((log, index) => index === 0 || log.id > logs[index - 1].id)
  );
  assert.equal(
    jobQueue
      .logs(id, 3)
      .map((log) => log.message)
      .join(","),
    "line 2097,line 2098,line 2099"
  );
  getDb()
    .update(schema.jobs)
    .set({ status: "completed" })
    .where(eq(schema.jobs.id, id))
    .run();
  assert.equal(jobQueue.hasActiveType("clear-overrides"), false);
});

test("isTaskRunning settles on the first running answer and remembers a legacy-only server", async () => {
  const requests: string[] = [];
  const stalled = Promise.withResolvers<Response>();
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("methodName=ScanLibrary&queue=default"))
      return Response.json(true);
    return stalled.promise;
  };
  const client = new KavitaClient("https://kavita.example", "secret");
  assert.equal(
    await client.isTaskRunning(),
    true,
    "one running scan answers without waiting for slower calls"
  );
  assert.equal(requests.length, 6);
  stalled.resolve(Response.json(false));

  requests.length = 0;
  let bare = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("methodName="))
      return new Response("The methodName field is required.", { status: 400 });
    bare++;
    return Response.json(bare < 3);
  };
  const legacy = new KavitaClient("https://kavita.example", "secret");
  assert.equal(await legacy.isTaskRunning(), true);
  assert.equal(requests.length, 7);
  assert.equal(await legacy.isTaskRunning(), true);
  assert.equal(
    requests.length,
    8,
    "a pre-0.9.1 server is asked only the bare call afterwards"
  );
  assert.equal(await legacy.isTaskRunning(), false);

  requests.length = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (!url.includes("methodName="))
      return new Response("The methodName field is required.", { status: 400 });
    return Response.json(false);
  };
  assert.equal(
    await legacy.isTaskRunning(),
    false,
    "an upgraded server returns to scoped calls"
  );
  assert.equal(requests.length, 7);
});

test("edit-comicinfo retries a deferred scan until Kavita indexes the new chapter number", async (t) => {
  const dir = path.join(dataDir, "renumber");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "Chapter 5.cbz");
  fs.writeFileSync(
    file,
    buildZip([
      { name: "001.jpg", data: Buffer.from("image-r") },
      {
        name: "ComicInfo.xml",
        data: Buffer.from(
          "<ComicInfo><Series>Renumber</Series><Number>2</Number></ComicInfo>"
        ),
      },
    ])
  );

  const state = { scans: 0, taskPending: false };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/Server/is-task-running")) {
      if (state.taskPending) {
        state.taskPending = false;
        return Response.json(true);
      }
      return Response.json(false);
    }
    if (url.endsWith("/api/Series/50"))
      return Response.json({
        id: 50,
        libraryId: 7,
        name: "Renumber",
        folderPath: dir,
      });
    if (url.endsWith("/api/Series/scan")) {
      state.scans += 1;
      state.taskPending = true;
      return Response.json({ ok: true });
    }
    if (url.includes("/api/Search/chapters-by-series?seriesId=50")) {
      return Response.json([
        {
          id: 1,
          number: state.scans >= 2 ? "3" : "2",
          files: [{ id: 1, filePath: file }],
        },
      ]);
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const logs: string[] = [];
  const result = await finishWithScanClock(t, () =>
    runJob(makeEditJob(file, 50, { Number: "3" }), (level, message) =>
      logs.push(`${level}: ${message}`)
    )
  );
  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  assert.equal(
    state.scans,
    2,
    "stale chapter number triggers a follow-up rescan"
  );
  const xml = await readComicInfo(file);
  assert.ok(
    xml?.includes("<Number>3</Number>") ||
      xml?.includes("<Number><![CDATA[3]]></Number>"),
    `file carries the new number, got: ${xml}`
  );
  assert.ok(
    logs.some((l) => l.startsWith("success") && l.includes("as chapter 3")),
    "verified indexed under the new number"
  );
});

test("edit-comicinfo fails with manual-scan guidance when Kavita never picks up the new number", async (t) => {
  process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS = "1000";
  try {
    const dir = path.join(dataDir, "renumber-stuck");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "Chapter 5.cbz");
    fs.writeFileSync(
      file,
      buildZip([
        { name: "001.jpg", data: Buffer.from("image-s") },
        {
          name: "ComicInfo.xml",
          data: Buffer.from(
            "<ComicInfo><Series>Stuck</Series><Number>2</Number></ComicInfo>"
          ),
        },
      ])
    );

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/Server/is-task-running"))
        return Response.json(false);
      if (url.endsWith("/api/Series/50"))
        return Response.json({
          id: 50,
          libraryId: 7,
          name: "Stuck",
          folderPath: dir,
        });
      if (url.endsWith("/api/Series/scan")) return Response.json({ ok: true });
      if (url.includes("/api/Search/chapters-by-series?seriesId=50")) {
        return Response.json([
          { id: 1, number: "2", files: [{ id: 1, filePath: file }] },
        ]);
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    await assert.rejects(
      finishWithScanClock(t, () =>
        runJob(makeEditJob(file, 50, { Number: "3" }), () => {})
      ),
      /ComicInfo\.xml was saved.*manual scan/
    );
  } finally {
    delete process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS;
  }
});
