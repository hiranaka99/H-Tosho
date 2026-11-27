import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

process.env.HTOSHO_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "htosho-review-")
);
const { initDb, getDb, schema } = await import("../src/db/index.js");
initDb();
const { setKavitaConnection } = await import("../src/services/settings.js");
const { api } = await import("../src/routes/api.js");

const realFetch = globalThis.fetch;
beforeEach(() => {
  getDb().delete(schema.seriesMatches).run();
  setKavitaConnection({ baseUrl: "http://kavita.test", apiKey: "test-key" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockLibraries(failSecond = false) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/Library/libraries"))
      return Response.json([
        { id: 1, name: "Manga", type: 0 },
        { id: 2, name: "Novels", type: 4 },
      ]);
    if (url.includes("/Series/all-v2")) {
      const libraryId = Number(
        JSON.parse(String(init?.body)).statements[0].value
      );
      if (libraryId === 2 && failSecond)
        return Response.json({ error: "Library unavailable" }, { status: 403 });
      return Response.json(
        (libraryId === 1 ? [1, 3, 4, 5] : [2]).map((id) => ({
          id,
          libraryId,
          name: `Current title ${id}`,
          pages: 100,
          coverImage: "cover.jpg",
        }))
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  return calls;
}

describe("review queue", () => {
  it("includes uncertain matches from every library, lowest confidence first", async () => {
    const calls = mockLibraries();
    getDb()
      .insert(schema.seriesMatches)
      .values([
        {
          kavitaSeriesId: 1,
          status: "matched",
          matchScore: 0.79,
          providerId: "anilist",
          metadataJson: JSON.stringify({ artists: ["Artist A"] }),
        },
        {
          kavitaSeriesId: 2,
          status: "matched",
          matchScore: 0.62,
          providerId: "anilist",
        },
        { kavitaSeriesId: 3, status: "matched", matchScore: 0.8 },
        { kavitaSeriesId: 4, status: "failed", matchScore: 0.5 },
        { kavitaSeriesId: 5, status: "matched", matchScore: null },
        // A removed Kavita series must not become a broken review card.
        { kavitaSeriesId: 99, status: "matched", matchScore: 0.3 },
      ])
      .run();
    const response = await api.request("/series/needs-review");
    assert.equal(response.status, 200);
    const rows = await response.json();
    assert.deepEqual(
      rows.map((row: { id: number; libraryName: string; name: string }) => [
        row.id,
        row.libraryName,
        row.name,
      ]),
      [
        [2, "Novels", "Current title 2"],
        [1, "Manga", "Current title 1"],
      ]
    );
    assert.equal(rows[0].cover, "/api/kavita/series/2/cover?v=cover.jpg");
    assert.deepEqual(rows[1].artists, ["Artist A"]);
    assert.equal(
      calls.length,
      3,
      "only identities should be fetched, without metadata requests"
    );
  });

  it("returns an empty queue without contacting Kavita when no matches need review", async () => {
    globalThis.fetch = (() => {
      throw new Error("No network call expected");
    }) as typeof fetch;
    const response = await api.request("/series/needs-review");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  it("excludes confirmed low scores from both the review queue and sidebar count", async () => {
    mockLibraries();
    getDb()
      .insert(schema.seriesMatches)
      .values([
        {
          kavitaSeriesId: 1,
          status: "matched",
          matchScore: 0.39,
          confirmed: true,
        },
        { kavitaSeriesId: 2, status: "matched", matchScore: 0.62 },
      ])
      .run();
    const rows = await (await api.request("/series/needs-review")).json();
    assert.deepEqual(
      rows.map((row: { id: number }) => row.id),
      [2]
    );
    assert.equal(
      (await (await api.request("/series/low-confidence")).json()).count,
      1
    );
  });

  it("reports an unavailable library instead of silently showing a partial queue", async () => {
    mockLibraries(true);
    getDb()
      .insert(schema.seriesMatches)
      .values({ kavitaSeriesId: 1, status: "matched", matchScore: 0.5 })
      .run();
    const response = await api.request("/series/needs-review");
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /403/);
  });

  it("requires a configured Kavita connection", async () => {
    setKavitaConnection({ baseUrl: "", apiKey: "" });
    assert.equal((await api.request("/series/needs-review")).status, 503);
  });
});
