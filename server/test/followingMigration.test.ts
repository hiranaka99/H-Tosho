import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createSchemaTables, migrateSchema } from "../src/db/migrations.js";

function legacyTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE watched_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, query TEXT NOT NULL,
      last_checked_at TEXT, last_result_count INTEGER, last_results_json TEXT,
      last_new_count INTEGER, last_finds_at TEXT, last_attempted_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (current_timestamp)
    );
    CREATE TABLE watched_search_seen (
      id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER NOT NULL, source TEXT NOT NULL,
      gallery_id TEXT NOT NULL, first_seen_at TEXT NOT NULL DEFAULT (current_timestamp)
    );
    CREATE UNIQUE INDEX idx_watched_search_seen_unique ON watched_search_seen(search_id, source, gallery_id);
    CREATE TABLE watched_search_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER NOT NULL, source TEXT NOT NULL,
      query TEXT NOT NULL, gallery_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, cover_url TEXT,
      page_count INTEGER, artists_json TEXT NOT NULL DEFAULT '[]', language TEXT, reviewed_at TEXT, found_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_watched_search_new_unique ON watched_search_new(search_id, source, gallery_id);
    INSERT INTO watched_searches (id, source, query, last_checked_at, last_result_count, last_results_json, last_attempted_at, last_error)
      VALUES (10, 'hitomi', 'artist:duplicate', '2026-01-01T00:00:00.000Z', 1, '[]', '2026-01-01T00:00:00.000Z', NULL),
        (20, 'hitomi', 'artist:duplicate', '2026-02-01T00:00:00.000Z', 3, '[{"galleryId":"json-only","title":"JSON only","url":"https://gallery.test/json","pageCount":32}]', '2026-03-01T00:00:00.000Z', 'Legacy provider failure'),
        (30, 'nhentai', 'artist:unaffected', '2026-01-01T00:00:00.000Z', 1, NULL, NULL, NULL);
    INSERT INTO watched_search_seen (id, search_id, source, gallery_id, first_seen_at) VALUES
      (1, 10, 'hitomi', 'shared', '2026-02-01T00:00:00.000Z'),
      (2, 20, 'hitomi', 'shared', '2026-01-01T00:00:00.000Z'),
      (3, 20, 'hitomi', 'duplicate-only', '2026-01-01T00:00:00.000Z'),
      (4, 30, 'nhentai', 'unaffected', '2026-01-01T00:00:00.000Z');
    INSERT INTO watched_search_new (id, search_id, source, query, gallery_id, title, url, page_count, artists_json, found_at) VALUES
      (101, 10, 'hitomi', 'artist:duplicate', 'shared', 'Old shared title', 'https://gallery.test/shared', 24, '["Artist A"]', '2026-01-01T00:00:00.000Z'),
      (103, 20, 'hitomi', 'artist:duplicate', 'duplicate-only', 'Duplicate only', NULL, 18, '[]', '2026-02-01T00:00:00.000Z'),
      (104, 999, 'hitomi', 'artist:removed', 'shared', 'Removed watch history', NULL, NULL, '[]', '2026-02-01T00:00:00.000Z'),
      (105, 30, 'nhentai', 'artist:unaffected', 'unaffected', 'Unaffected find', NULL, 42, '[]', '2026-02-01T00:00:00.000Z');
    INSERT INTO watched_search_new (id, search_id, source, query, gallery_id, title, cover_url, artists_json, language, reviewed_at, found_at)
      VALUES (102, 20, 'hitomi', 'artist:duplicate', 'shared', 'Newest shared title', 'https://image.test/shared.jpg', '["Artist B"]', 'Japanese', '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  `);
}

for (const stamped of [false, true]) {
  test(`${stamped ? "stamped-v9" : "versionless"} duplicate upgrade preserves canonical IDs, unioned seen IDs, finds, metadata and shared review`, () => {
    const sqlite = new Database(":memory:");
    try {
      legacyTables(sqlite);
      if (stamped) {
        createSchemaTables(sqlite);
        sqlite.exec(
          "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (current_timestamp))"
        );
        for (let version = 1; version <= 9; version++)
          sqlite
            .prepare("INSERT INTO schema_migrations(version) VALUES (?)")
            .run(version);
      }
      migrateSchema(sqlite);
      const watches = sqlite
        .prepare(
          "SELECT id, query, revision, last_checked_at, last_failed_at, last_error FROM watched_searches ORDER BY id"
        )
        .all();
      assert.deepEqual(watches, [
        {
          id: 10,
          query: "artist:duplicate",
          revision: 0,
          last_checked_at: "2026-02-01T00:00:00.000Z",
          last_failed_at: "2026-03-01T00:00:00.000Z",
          last_error: "Legacy provider failure",
        },
        {
          id: 30,
          query: "artist:unaffected",
          revision: 0,
          last_checked_at: "2026-01-01T00:00:00.000Z",
          last_failed_at: null,
          last_error: null,
        },
      ]);
      assert.deepEqual(
        sqlite
          .prepare(
            "SELECT gallery_id, first_seen_at FROM watched_search_seen WHERE search_id = 10 ORDER BY gallery_id"
          )
          .all(),
        [
          {
            gallery_id: "duplicate-only",
            first_seen_at: "2026-01-01T00:00:00.000Z",
          },
          { gallery_id: "shared", first_seen_at: "2026-01-01T00:00:00.000Z" },
        ]
      );
      assert.deepEqual(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM watched_search_seen WHERE search_id = 20"
          )
          .get(),
        { n: 0 }
      );
      const shared = sqlite
        .prepare(
          "SELECT * FROM watched_search_new WHERE search_id = 10 AND gallery_id = 'shared'"
        )
        .get() as {
        id: number;
        title: string;
        url: string;
        cover_url: string;
        page_count: number;
        artists_json: string;
        language: string;
        reviewed_at: string;
        watch_label: string;
      };
      assert.equal(shared.id, 101);
      assert.equal(shared.title, "Newest shared title");
      assert.equal(shared.url, "https://gallery.test/shared");
      assert.equal(shared.cover_url, "https://image.test/shared.jpg");
      assert.equal(shared.page_count, 24);
      assert.deepEqual(JSON.parse(String(shared.artists_json)).sort(), [
        "Artist A",
        "Artist B",
      ]);
      assert.equal(shared.language, "Japanese");
      assert.equal(shared.reviewed_at, "2026-03-01T00:00:00.000Z");
      assert.equal(shared.watch_label, "artist:duplicate");
      assert.equal(
        sqlite
          .prepare("SELECT id FROM watched_search_new WHERE id = 102")
          .get(),
        undefined
      );
      assert.deepEqual(
        sqlite
          .prepare("SELECT search_id FROM watched_search_new WHERE id = 103")
          .get(),
        { search_id: 10 }
      );
      assert.deepEqual(
        sqlite
          .prepare(
            "SELECT search_id, gallery_id, page_count, watch_label FROM watched_search_new WHERE id = 105"
          )
          .get(),
        {
          search_id: 30,
          gallery_id: "unaffected",
          page_count: 42,
          watch_label: "artist:unaffected",
        }
      );
      const removed = sqlite
        .prepare(
          "SELECT watch_label, reviewed_at FROM watched_search_new WHERE id = 104"
        )
        .get()!;
      assert.deepEqual(removed, {
        watch_label: "artist:removed",
        reviewed_at: "2026-03-01T00:00:00.000Z",
      });
      assert.deepEqual(
        sqlite
          .prepare(
            "SELECT search_id, title, page_count FROM watched_search_new WHERE gallery_id = 'json-only'"
          )
          .get(),
        { search_id: 10, title: "JSON only", page_count: 32 }
      );
      assert.throws(
        () =>
          sqlite
            .prepare(
              "INSERT INTO watched_searches(source, query) VALUES ('hitomi', 'artist:duplicate')"
            )
            .run(),
        /UNIQUE/
      );
      const before = sqlite
        .prepare("SELECT * FROM watched_search_new ORDER BY id")
        .all();
      migrateSchema(sqlite);
      assert.deepEqual(
        sqlite.prepare("SELECT * FROM watched_search_new ORDER BY id").all(),
        before
      );
    } finally {
      sqlite.close();
    }
  });
}

test("fresh bootstrap creates additive Following storage and unique identities without retired delivery storage", () => {
  const sqlite = new Database(":memory:");
  try {
    migrateSchema(sqlite);
    const id = sqlite
      .prepare(
        "INSERT INTO watched_searches(source, query) VALUES ('hitomi', 'artist:fresh')"
      )
      .run().lastInsertRowid;
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT display_name, folder_id, paused_at, interval_minutes, revision, next_check_at, last_failed_at FROM watched_searches WHERE id = ?"
        )
        .get(id),
      {
        display_name: null,
        folder_id: null,
        paused_at: null,
        interval_minutes: null,
        revision: 0,
        next_check_at: null,
        last_failed_at: null,
      }
    );
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    assert.ok(tables.some((table) => table.name === "watched_search_folders"));
    for (const name of [
      "following_events",
      "following_contributions",
      "following_deliveries",
      "following_delivery_approvals",
    ])
      assert.equal(
        tables.some((table) => table.name === name),
        false
      );
    assert.deepEqual(
      sqlite
        .prepare("SELECT notification_mode FROM watched_searches WHERE id = ?")
        .get(id),
      { notification_mode: "immediate" }
    );
    const indexes = sqlite
      .prepare("PRAGMA index_list('watched_searches')")
      .all() as { name: string; unique: number }[];
    assert.ok(
      indexes.some(
        (index) =>
          index.name === "idx_watched_searches_source_query" &&
          index.unique === 1
      )
    );
    assert.ok(
      indexes.some((index) => index.name === "idx_watched_searches_due")
    );
  } finally {
    sqlite.close();
  }
});

test("failed migration10 reconciliation is atomic and does not receive a version stamp", () => {
  const sqlite = new Database(":memory:");
  try {
    legacyTables(sqlite);
    createSchemaTables(sqlite);
    sqlite.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (current_timestamp));
      CREATE TRIGGER refuse_reconciliation BEFORE DELETE ON watched_searches BEGIN SELECT RAISE(ABORT, 'Fixture reconciliation failure'); END;`);
    for (let version = 1; version <= 9; version++)
      sqlite
        .prepare("INSERT INTO schema_migrations(version) VALUES (?)")
        .run(version);
    assert.throws(
      () => migrateSchema(sqlite),
      /Fixture reconciliation failure/
    );
    assert.equal(
      sqlite
        .prepare("SELECT version FROM schema_migrations WHERE version = 10")
        .get(),
      undefined
    );
    assert.deepEqual(
      sqlite.prepare("SELECT COUNT(*) AS n FROM watched_searches").get(),
      { n: 3 }
    );
    assert.deepEqual(
      sqlite.prepare("SELECT COUNT(*) AS n FROM watched_search_new").get(),
      { n: 5 }
    );
    const columns = sqlite
      .prepare("PRAGMA table_info(watched_searches)")
      .all() as { name: string }[];
    assert.equal(
      columns.some((column) => column.name === "revision"),
      false
    );
    sqlite.exec("DROP TRIGGER refuse_reconciliation");
    migrateSchema(sqlite);
    assert.deepEqual(
      sqlite.prepare("SELECT COUNT(*) AS n FROM watched_searches").get(),
      { n: 2 }
    );
  } finally {
    sqlite.close();
  }
});

test("legacy upgrade and persisted schedule/history remain intact after database close and reopen", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "htosho-following-migration-"));
  const filename = path.join(dir, "htosho.db");
  let sqlite = new Database(filename);
  try {
    legacyTables(sqlite);
    migrateSchema(sqlite);
    sqlite
      .prepare(
        "INSERT INTO watched_search_folders(name, position) VALUES (?, ?)"
      )
      .run("Retained folder", 0);
    sqlite
      .prepare(
        "UPDATE watched_searches SET display_name = ?, folder_id = ?, interval_minutes = ?, next_check_at = ?, revision = ? WHERE id = 10"
      )
      .run("Retained label", 1, 60, "2026-11-16T13:00:00.000Z", 7);
    const history = sqlite
      .prepare("SELECT * FROM watched_search_new ORDER BY id")
      .all();
    sqlite.close();
    sqlite = new Database(filename);
    migrateSchema(sqlite);
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT display_name, folder_id, interval_minutes, next_check_at, revision FROM watched_searches WHERE id = 10"
        )
        .get(),
      {
        display_name: "Retained label",
        folder_id: 1,
        interval_minutes: 60,
        next_check_at: "2026-11-16T13:00:00.000Z",
        revision: 7,
      }
    );
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM watched_search_new ORDER BY id").all(),
      history
    );
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM watched_search_seen WHERE search_id = 10"
        )
        .get(),
      { n: 2 }
    );
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
