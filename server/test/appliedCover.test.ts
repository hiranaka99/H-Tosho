import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

// Isolated DB before the db module loads: DATA_DIR is a module-level const in db/index.js.
process.env.HTOSHO_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "htosho-applied-cover-")
);

const { initDb, getDb, schema } = await import("../src/db/index.js");
initDb();
const { setKavitaConnection } = await import("../src/services/settings.js");
const { appliedSeriesCovers } = await import("../src/services/appliedCover.js");
const { api } = await import("../src/routes/api.js");

const SERIES = 42;
const COVER = "https://covers.example/series.jpg";
setKavitaConnection({ baseUrl: "http://kavita.test", apiKey: "test-key" });

function match(meta: Record<string, unknown> = { coverUrl: COVER }): void {
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: SERIES,
      status: "matched",
      providerId: "anilist",
      providerSeriesId: "1",
      metadataJson: JSON.stringify(meta),
    })
    .run();
}
function history(action: string, details: Record<string, unknown>): void {
  getDb()
    .insert(schema.syncHistory)
    .values({
      kavitaSeriesId: SERIES,
      action,
      detailsJson: JSON.stringify(details),
    })
    .run();
}
let operation = 0;
function coverWrite(origin: string): void {
  const id = `op-${++operation}`;
  getDb()
    .insert(schema.metadataOperations)
    .values({
      id,
      connectionKey: "http://kavita.test",
      seriesId: SERIES,
      origin,
      status: "completed",
      fieldsJson: '["cover"]',
      desiredJson: "{}",
      policyRevision: 0,
      beforeJson: "{}",
      createdAt: new Date().toISOString(),
    })
    .run();
  getDb()
    .insert(schema.metadataSeriesCovers)
    .values({ operationId: id, status: "completed", writeAcknowledged: true })
    .run();
}

describe("appliedSeriesCovers", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(schema.seriesMatches).run();
    db.delete(schema.syncHistory).run();
    db.delete(schema.metadataSeriesCovers).run();
    db.delete(schema.metadataOperations).run();
  });

  it("returns the cover URL recorded by the apply that pushed it", async () => {
    match();
    coverWrite("provider-apply");
    history("matched", {
      coverUpdated: true,
      coverUrl: COVER,
      volumeCoverUrls: ["https://covers.example/v1.jpg"],
    });
    assert.deepEqual(appliedSeriesCovers(SERIES), {
      coverUrl: COVER,
      volumeCoverUrls: ["https://covers.example/v1.jpg"],
    });
    const res = await api.request(`/series/${SERIES}/applied-cover`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      coverUrl: COVER,
      volumeCoverUrls: ["https://covers.example/v1.jpg"],
    });
  });

  it("looks past later applies that left the cover alone", () => {
    match({ coverUrl: "https://covers.example/newer.jpg" });
    history("matched", {
      coverUpdated: true,
      coverUrl: COVER,
      volumeCoverUrls: [],
    });
    history("updated", { coverUpdated: false });
    assert.equal(appliedSeriesCovers(SERIES)?.coverUrl, COVER);
  });

  it("falls back to the stored match metadata for history written before URLs were recorded", () => {
    match({
      coverUrl: COVER,
      volumeCovers: [{ number: 1, url: "https://covers.example/v1.jpg" }],
    });
    history("matched", { coverUpdated: true });
    assert.deepEqual(appliedSeriesCovers(SERIES), {
      coverUrl: COVER,
      volumeCoverUrls: ["https://covers.example/v1.jpg"],
    });
  });

  it("does not trust legacy match metadata written by a later apply", () => {
    match({ coverUrl: "https://covers.example/newer.jpg" });
    history("matched", { coverUpdated: true });
    history("updated", { coverUpdated: false });
    assert.equal(appliedSeriesCovers(SERIES), null);
  });

  it("is unknown when no apply pushed a cover", () => {
    match();
    history("matched", { coverUpdated: false });
    assert.equal(appliedSeriesCovers(SERIES), null);
  });

  it("is unknown once a restore has written the cover since", () => {
    match();
    coverWrite("provider-apply");
    history("matched", {
      coverUpdated: true,
      coverUrl: COVER,
      volumeCoverUrls: [],
    });
    coverWrite("metadata-restore");
    assert.equal(appliedSeriesCovers(SERIES), null);
  });

  it("ignores covers applied before an unmatch", () => {
    match();
    history("matched", {
      coverUpdated: true,
      coverUrl: COVER,
      volumeCoverUrls: [],
    });
    history("unmatched", {});
    history("matched", { coverUpdated: false });
    assert.equal(appliedSeriesCovers(SERIES), null);
  });

  it("is unknown without a match", async () => {
    history("matched", { coverUpdated: true, coverUrl: COVER });
    assert.equal(appliedSeriesCovers(SERIES), null);
    assert.deepEqual(
      await (await api.request(`/series/${SERIES}/applied-cover`)).json(),
      { coverUrl: null, volumeCoverUrls: null }
    );
  });
});
