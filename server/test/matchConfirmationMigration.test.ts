import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

const dir = mkdtempSync(path.join(tmpdir(), "htosho-confirm-migration-"));
process.env.HTOSHO_DATA_DIR = dir;
const legacy = new Database(path.join(dir, "htosho.db"));
legacy.exec(`
  CREATE TABLE series_matches (
    id INTEGER PRIMARY KEY, kavita_series_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL, provider_id TEXT, provider_series_id TEXT, match_score REAL,
    aligned INTEGER NOT NULL DEFAULT 0, metadata_json TEXT, error_message TEXT,
    last_synced_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY, type TEXT, payload_json TEXT, status TEXT, result_json TEXT,
    started_at TEXT, finished_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
const start = new Date(Date.now() - 5000).toISOString();
const synced = new Date(Date.now() - 3000).toISOString();
const finish = new Date(Date.now() - 1000).toISOString();
const insertMatch = legacy.prepare(
  "INSERT INTO series_matches (id, kavita_series_id, status, provider_id, provider_series_id, match_score, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const insertJob = legacy.prepare(
  "INSERT INTO jobs (id, type, status, payload_json, result_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
for (let id = 1; id <= 7; id++) {
  insertMatch.run(
    id,
    id,
    "matched",
    "mangadex",
    "current",
    0.39,
    id === 5 ? new Date().toISOString() : synced
  );
  insertJob.run(
    id,
    id === 2 ? "sync-series" : "apply-series",
    id === 3 ? "failed" : "completed",
    id === 6
      ? "{broken"
      : JSON.stringify({
          seriesId: id,
          providerId: "mangadex",
          providerSeriesId: id === 4 ? "previous" : "current",
        }),
    JSON.stringify({ matched: id === 7 ? 0 : 1, failed: id === 7 ? 1 : 0 }),
    start,
    finish
  );
}
legacy.close();
const { initDb, schema } = await import("../src/db/index.js");
const db = initDb();

test("upgrade recovers only successful manual approvals of the current candidate and sync", () => {
  const rows = db
    .select()
    .from(schema.seriesMatches)
    .all()
    .sort((a, b) => a.kavitaSeriesId - b.kavitaSeriesId);
  assert.deepEqual(
    rows.map((r) => r.confirmed),
    [true, false, false, false, false, false, false]
  );
  assert.ok(
    rows.every((r) => r.matchScore === 0.39),
    "migration keeps the original confidence"
  );
  const sqlite = new Database(path.join(dir, "htosho.db"));
  assert.equal(
    sqlite
      .prepare("PRAGMA table_info(series_matches)")
      .all()
      .some(
        (column) =>
          column !== null &&
          typeof column === "object" &&
          "name" in column &&
          column.name === "aligned"
      ),
    false
  );
  sqlite.close();
  assert.equal(initDb(), db, "initialization is idempotent");
});
