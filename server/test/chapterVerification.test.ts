import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test, type TestContext } from "node:test";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "htosho-chapter-verification-")
);
process.env.HTOSHO_DATA_DIR = dataDir;
const { initDb, getDb } = await import("../src/db/index.js");
const { buildZip } = await import("../src/downloader/zip.js");
const { readComicInfo } = await import("../src/lib/cbz.js");
const { parseComicInfo } = await import("../src/downloader/comicinfo.js");
const { runJob } = await import("../src/jobs/executor.js");
const { jobQueue } = await import("../src/jobs/queue.js");
const { setKavitaConnection } = await import("../src/services/settings.js");
initDb();
setKavitaConnection({ baseUrl: "https://kavita.example", apiKey: "test" });
jobQueue.registerHandler(runJob);

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS;
// Keep a real event-loop turn available while Date and application timers are mocked.
const realSetTimeout = globalThis.setTimeout;
const yieldToIo = () =>
  new Promise<void>((resolve) => realSetTimeout(resolve, 10));
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTimeout === undefined)
    delete process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS;
  else process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS = originalTimeout;
});
after(() => {
  getDb().$client.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface Request {
  url: string;
  at: number;
}
interface FakeState {
  id: number;
  file: string;
  requests: Request[];
  scans: number;
  statusPolls: number;
}
interface Options {
  number?: string;
  timeoutMs?: number;
  respond?: (url: string, state: FakeState) => Response | undefined;
}

/** Exercise the real queue, archive edit, and HTTP client with a virtual scan clock. */
async function edit(t: TestContext, options: Options = {}) {
  const file = path.join(dataDir, `chapter-${jobQueue.list().length}.cbz`);
  fs.writeFileSync(
    file,
    buildZip([
      { name: "001.jpg", data: Buffer.from("image") },
      {
        name: "ComicInfo.xml",
        data: Buffer.from(
          "<ComicInfo><Series>Archive series name</Series><Number>4</Number></ComicInfo>"
        ),
      },
    ])
  );
  process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS = String(
    options.timeoutMs ?? 20 * 60_000
  );
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const state: FakeState = {
    id: 0,
    file,
    requests: [],
    scans: 0,
    statusPolls: 0,
  };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    state.requests.push({ url, at: Date.now() });
    if (url.endsWith("/api/Series/scan")) state.scans++;
    if (
      url.includes(
        "/api/Server/is-task-running?methodName=ScanLibrary&queue=default"
      )
    )
      state.statusPolls++;
    const response = options.respond?.(url, state);
    if (response) return response;
    if (url.endsWith("/api/Series/42"))
      return Response.json({ id: 42, libraryId: 7, name: "Test series" });
    if (url.endsWith("/api/Library/libraries"))
      return Response.json([{ id: 7, name: "Comics", type: 0 }]);
    if (url.includes("/api/Server/is-task-running"))
      return Response.json(state.statusPolls % 2 === 1);
    if (url.includes("/api/Search/chapters-by-series")) {
      return Response.json([
        { id: 1, number: "5", files: [{ filePath: file }] },
      ]);
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  state.id = jobQueue.enqueue("edit-comicinfo", {
    seriesId: 42,
    path: file,
    fields:
      options.number === ""
        ? { Title: "Edited title", Number: "" }
        : { Number: options.number ?? "5" },
  });
  // Let real archive I/O and HTTP callbacks settle before advancing polling timers.
  for (let step = 0; step < 1000; step++) {
    await yieldToIo();
    const job = jobQueue.get(state.id)!;
    if (job.status !== "running" && job.status !== "queued") {
      return {
        job,
        state,
        fields: parseComicInfo((await readComicInfo(file))!).fields,
        logs: jobQueue.logs(state.id),
      };
    }
    t.mock.timers.tick(5_000);
  }
  assert.fail("Edit did not reach a terminal job status");
}

test("cancelling a stale chapter verification stops further scans and records cancelled", async (t) => {
  const { job, state, fields, logs } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Search/chapters-by-series")) {
        assert.equal(jobQueue.cancel(state.id), true);
        return Response.json([
          { id: 1, number: "4", files: [{ filePath: state.file }] },
        ]);
      }
    },
  });
  assert.equal(job.status, "cancelled");
  assert.equal(state.scans, 1);
  assert.equal(
    fields.Number,
    "5",
    "the already committed archive edit is preserved"
  );
  assert.ok(logs.some((log) => log.message === "Cancelled edit-comicinfo"));
  assert.ok(!logs.some((log) => log.level === "success"));
});

test("cancellation before the archive write preserves the original chapter number", async (t) => {
  const { job, state, fields } = await edit(t, {
    respond(url, state) {
      if (url.endsWith("/api/Series/42")) jobQueue.cancel(state.id);
    },
  });
  assert.equal(job.status, "cancelled");
  assert.equal(fields.Number, "4");
  assert.equal(state.scans, 0);
});

test("an indexed chapter response cannot complete a cancelled job", async (t) => {
  const { job } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Search/chapters-by-series"))
        jobQueue.cancel(state.id);
    },
  });
  assert.equal(job.status, "cancelled");
});

test("cancellation is checked while Kavita tasks stay running", async (t) => {
  const { job, state } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Server/is-task-running")) {
        if (state.statusPolls === 2) jobQueue.cancel(state.id);
        return Response.json(true);
      }
    },
  });
  assert.equal(job.status, "cancelled");
  assert.equal(state.statusPolls, 2);
  assert.equal(state.scans, 1);
  assert.ok(
    !state.requests.some(({ url }) => url.includes("/chapters-by-series"))
  );
});

test("cancellation is checked during the idle task grace window", async (t) => {
  const { job, state } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Server/is-task-running")) {
        if (state.statusPolls === 2) jobQueue.cancel(state.id);
        return Response.json(false);
      }
    },
  });
  assert.equal(job.status, "cancelled");
  assert.equal(state.statusPolls, 2);
});

test("unavailable task status cannot swallow a cancellation request", async (t) => {
  const { job } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Server/is-task-running")) {
        jobQueue.cancel(state.id);
        return new Response("Unavailable", { status: 401 });
      }
    },
  });
  assert.equal(job.status, "cancelled");
});

test("cancellation during the scan request stops before polling, including edits without a number", async (t) => {
  const { job, state } = await edit(t, {
    number: "",
    respond(url, state) {
      if (url.endsWith("/api/Series/scan")) jobQueue.cancel(state.id);
    },
  });
  assert.equal(job.status, "cancelled");
  assert.equal(state.scans, 1);
  assert.equal(state.statusPolls, 0);
});

test("cancelling during the verification sleep stops at the next poll without another request", async (t) => {
  const { job, state } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Search/chapters-by-series")) {
        setTimeout(() => jobQueue.cancel(state.id), 1_000);
        return Response.json([
          { id: 1, number: "4", files: [{ filePath: state.file }] },
        ]);
      }
    },
  });
  assert.equal(job.status, "cancelled");
  assert.equal(state.scans, 1);
  assert.equal(
    state.requests.filter(({ url }) => url.includes("/chapters-by-series"))
      .length,
    1
  );
});

test("stale chapter numbers time out as failed without flooding Kavita with scans", async (t) => {
  const { job, state, fields, logs } = await edit(t, {
    timeoutMs: 30_000,
    respond(url, state) {
      if (url.includes("/api/Search/chapters-by-series")) {
        return Response.json([
          { id: 1, number: "4", files: [{ filePath: state.file }] },
        ]);
      }
    },
  });
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage!, /as chapter 5/);
  assert.match(job.errorMessage!, /ComicInfo.xml was saved/);
  assert.equal(fields.Number, "5");
  assert.equal(state.scans, 1);
  assert.ok(!logs.some((log) => log.message === "Completed edit-comicinfo"));
});

test("scan retries allow the deferred scan to run before requesting another", async (t) => {
  const { job, state } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Search/chapters-by-series")) {
        const elapsed =
          Date.now() -
          state.requests.find(({ url }) => url.endsWith("/api/Series/scan"))!
            .at;
        return Response.json([
          {
            id: 1,
            number: elapsed >= 11 * 60_000 ? "5" : "4",
            files: [{ filePath: state.file }],
          },
        ]);
      }
    },
  });
  assert.equal(job.status, "completed");
  assert.equal(
    state.scans,
    2,
    "only retry after allowing the deferred scan to run"
  );
  const scans = state.requests.filter(({ url }) =>
    url.endsWith("/api/Series/scan")
  );
  assert.ok(scans[1].at - scans[0].at >= 10 * 60_000);
});

test("a chapter can become indexed while waiting for the deferred scan", async (t) => {
  const { job, state } = await edit(t, {
    respond(url, state) {
      if (url.includes("/api/Search/chapters-by-series")) {
        const reads = state.requests.filter(({ url }) =>
          url.includes("/chapters-by-series")
        ).length;
        return Response.json([
          {
            id: 1,
            number: reads >= 3 ? "5.0" : "4",
            files: [{ filePath: state.file }],
          },
        ]);
      }
    },
  });
  assert.equal(job.status, "completed");
  assert.equal(state.scans, 1);
});

test("a failed chapter lookup reports the error without continuing to scan a stale series ID", async (t) => {
  const { job, state } = await edit(t, {
    timeoutMs: 30_000,
    respond(url) {
      if (url.includes("/api/Search/chapters-by-series"))
        return new Response("Unavailable", { status: 401 });
    },
  });
  assert.equal(job.status, "failed");
  assert.equal(state.scans, 1);
  assert.match(
    job.errorMessage!,
    /Could not verify chapter indexing.*HTTP 401/
  );
  assert.match(job.errorMessage!, /ComicInfo.xml was saved/);
  assert.equal(
    state.requests.filter(({ url }) => url.includes("/chapters-by-series"))
      .length,
    1
  );
});

test("a scan that never drains fails at the deadline, including edits without a number", async (t) => {
  const { job, state } = await edit(t, {
    number: "",
    timeoutMs: 10_000,
    respond(url) {
      if (url.includes("/api/Server/is-task-running"))
        return Response.json(true);
    },
  });
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage!, /did not confirm/);
  assert.equal(state.scans, 1);
});

test("a successfully indexed chapter completes normally", async (t) => {
  const { job, state, fields } = await edit(t);
  assert.equal(job.status, "completed");
  assert.equal(state.scans, 1);
  assert.equal(fields.Number, "5");
});

test("a chapter-only edit preserves the Kavita series name when it differs from ComicInfo.Series", async (t) => {
  const { job, state, fields } = await edit(t);
  assert.equal(job.status, "completed");
  assert.equal(fields.Series, "Archive series name");
  assert.ok(
    !state.requests.some(({ url }) => url.endsWith("/api/Series/update"))
  );
});

for (const correctFirst of [false, true]) {
  test(`conflicting chapter entries fail without repeated scans when the correct entry is ${correctFirst ? "first" : "last"}`, async (t) => {
    const { job, state, fields, logs } = await edit(t, {
      respond(url, state) {
        if (url.includes("/api/Search/chapters-by-series")) {
          const chapters = [
            { id: 1, number: "4", files: [{ filePath: state.file }] },
            { id: 2, number: "5", files: [{ filePath: state.file }] },
          ];
          return Response.json(correctFirst ? chapters.reverse() : chapters);
        }
      },
    });
    assert.equal(job.status, "failed");
    assert.equal(fields.Number, "5");
    assert.match(job.errorMessage!, /conflicting chapters/);
    assert.match(job.errorMessage!, /chapter 4 \(ID 1\)/);
    assert.match(job.errorMessage!, /chapter 5 \(ID 2\)/);
    assert.match(job.errorMessage!, /ComicInfo.xml was saved/);
    assert.equal(state.scans, 1);
    assert.equal(
      state.requests.filter(({ url }) => url.includes("/chapters-by-series"))
        .length,
      1
    );
    assert.ok(!logs.some((log) => log.level === "success"));
  });
}
