import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { Job } from "../src/jobs/queue.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "htosho-delete-series-"));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required because the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb } = await import("../src/db/index.js");
const { buildZip } = await import("../src/downloader/zip.js");
const { runJob } = await import("../src/jobs/executor.js");
const { setKavitaConnection } = await import("../src/services/settings.js");

initDb();
setKavitaConnection({ baseUrl: "https://kavita.example", apiKey: "secret" });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const LIBRARY_ROOT = path.join(dataDir, "Library");

function makeSeriesFolder(name: string, archiveCount: number): string {
  const dir = path.join(LIBRARY_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= archiveCount; n++) {
    fs.writeFileSync(
      path.join(dir, `Chapter ${n}.cbz`),
      buildZip([{ name: "001.jpg", data: Buffer.from(`image-${n}`) }])
    );
  }
  return dir;
}

function makeJob(seriesId: number): Job {
  return {
    id: 1,
    type: "delete-series",
    payload: { seriesId },
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

function fakeKavita(series: {
  id: number;
  libraryId: number;
  name: string;
  folderPath: string;
}) {
  const requests: string[] = [];
  const fetchMock = (async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/api/Library/libraries")) {
      return Response.json([
        {
          id: series.libraryId,
          name: "Library",
          folders: [LIBRARY_ROOT],
          type: 0,
        },
      ]);
    }
    if (url.includes(`/api/Series/${series.id}`)) {
      return Response.json(series);
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { requests, fetchMock };
}

test("delete-series removes the series folder and requests a library rescan", async () => {
  const dir = makeSeriesFolder("Promeia", 3);
  const { requests, fetchMock } = fakeKavita({
    id: 5,
    libraryId: 7,
    name: "Promeia",
    folderPath: dir,
  });
  globalThis.fetch = fetchMock;

  const result = await runJob(makeJob(5), () => {});
  assert.deepEqual(result, { deleted: 3 });
  assert.equal(fs.existsSync(dir), false, "the series folder is gone");
  assert.ok(
    requests.some((u) => u.includes("/api/Library/scan?libraryId=7")),
    "a library rescan is requested so Kavita drops the series"
  );
});

test("delete-series refuses to delete a library root", async () => {
  fs.mkdirSync(LIBRARY_ROOT, { recursive: true });
  const keeper = path.join(LIBRARY_ROOT, "keep.cbz");
  fs.writeFileSync(
    keeper,
    buildZip([{ name: "001.jpg", data: Buffer.from("x") }])
  );
  const { requests, fetchMock } = fakeKavita({
    id: 6,
    libraryId: 7,
    name: "RootSeries",
    folderPath: LIBRARY_ROOT,
  });
  globalThis.fetch = fetchMock;

  await assert.rejects(
    runJob(makeJob(6), () => {}),
    /not strictly inside a known library root/
  );
  assert.ok(fs.existsSync(keeper), "library contents survive the refusal");
  assert.equal(
    requests.some((u) => u.includes("/api/Library/scan")),
    false,
    "no rescan after a refusal"
  );
});

test("delete-series fails clearly when the folder cannot be located", async () => {
  fs.mkdirSync(LIBRARY_ROOT, { recursive: true });
  const { fetchMock } = fakeKavita({
    id: 7,
    libraryId: 7,
    name: "Ghost",
    folderPath: path.join(LIBRARY_ROOT, "Does-Not-Exist"),
  });
  globalThis.fetch = fetchMock;

  await assert.rejects(
    runJob(makeJob(7), () => {}),
    /Could not locate the series folder/
  );
});
