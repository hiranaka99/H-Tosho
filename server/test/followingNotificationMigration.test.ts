import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { migrateSchema } from "../src/db/migrations.js";

const retired = [
  "following_delivery_approvals",
  "following_deliveries",
  "following_contributions",
  "following_events",
];
function legacyFixture() {
  const db = new Database(":memory:");
  migrateSchema(db);
  db.exec(`DELETE FROM schema_migrations WHERE version = 14;
    ALTER TABLE watched_search_new DROP COLUMN notification_attempted_at;
    CREATE TABLE following_deliveries (id TEXT PRIMARY KEY, status TEXT, payload_json TEXT);
    CREATE TABLE following_events (id INTEGER PRIMARY KEY, delivery_id TEXT, status TEXT);
    CREATE TABLE following_contributions (event_id INTEGER, origin_job_id INTEGER);
    CREATE TABLE following_delivery_approvals (id TEXT PRIMARY KEY);
    INSERT INTO watched_searches(id,source,query,notification_mode,revision) VALUES
      (1,'hitomi','digest','digest',4),(2,'hitomi','immediate','immediate',5),(3,'hitomi','in-app','in-app',6);
    INSERT INTO watched_search_new(search_id,source,query,gallery_id,title,found_at,reviewed_at)
      VALUES(1,'hitomi','digest','old','Kept discovery','2026-01-01','2026-01-02');
    INSERT INTO watched_search_seen(search_id,source,gallery_id) VALUES(1,'hitomi','old');
    INSERT INTO jobs(id,type,status,payload_json,result_json) VALUES
      (41,'check-watched-searches','completed','{"watchIds":[1]}','{"processed":2,"notified":0,"notificationIntents":3}'),
      (42,'scan-new','queued','{}',NULL);
    INSERT INTO job_logs(job_id,level,message) VALUES(41,'success','Kept check log'),(42,'info','Kept queued log');
    INSERT INTO following_events VALUES(1,NULL,'pending'),(2,NULL,'pending');
    INSERT INTO following_contributions VALUES(1,41),(1,41),(2,41);`);
  const payload = JSON.stringify([{ originJobIds: [41, 41] }]);
  db.prepare("INSERT INTO following_deliveries VALUES(?,?,?)").run(
    "sent",
    "delivered",
    payload
  );
  db.prepare("INSERT INTO following_deliveries VALUES(?,?,?)").run(
    "uncertain",
    "unknown",
    payload
  );
  db.prepare("INSERT INTO key_value_store VALUES(?,?)").run(
    "notifications",
    JSON.stringify({
      discord: { enabled: true, webhookUrl: "https://discord.test/kept" },
      revision: 8,
      destinationIdentity: "kept-identity",
      digest: {
        time: "09:00",
        timezone: "Europe/Berlin",
        nextDueAt: "2026-01-01",
      },
    })
  );
  return db;
}

test("retirement removes delivery storage and digest settings while retaining Discord, Tasks and discoveries", () => {
  const db = legacyFixture();
  try {
    const jobs = db
      .prepare("SELECT id,type,status,payload_json FROM jobs ORDER BY id")
      .all();
    const logs = db.prepare("SELECT * FROM job_logs ORDER BY id").all();
    const seen = db.prepare("SELECT * FROM watched_search_seen").all();
    migrateSchema(db);
    for (const table of retired)
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
          )
          .get(table),
        undefined
      );
    assert.deepEqual(
      db
        .prepare("SELECT id,type,status,payload_json FROM jobs ORDER BY id")
        .all(),
      jobs
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM job_logs ORDER BY id").all(),
      logs
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM watched_search_seen").all(),
      seen
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT notification_mode,revision FROM watched_searches ORDER BY id"
        )
        .all(),
      [
        { notification_mode: "immediate", revision: 5 },
        { notification_mode: "immediate", revision: 5 },
        { notification_mode: "in-app", revision: 6 },
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT title,reviewed_at,notification_attempted_at FROM watched_search_new"
        )
        .get(),
      {
        title: "Kept discovery",
        reviewed_at: "2026-01-02",
        notification_attempted_at: "2026-01-01",
      }
    );
    const settings = JSON.parse(
      (
        db
          .prepare(
            "SELECT value_json FROM key_value_store WHERE key='notifications'"
          )
          .get() as { value_json: string }
      ).value_json
    );
    assert.deepEqual(settings, {
      discord: { enabled: true, webhookUrl: "https://discord.test/kept" },
      revision: 8,
      destinationIdentity: "kept-identity",
    });
    const recorded = JSON.parse(
      (
        db.prepare("SELECT result_json FROM jobs WHERE id=41").get() as {
          result_json: string;
        }
      ).result_json
    );
    assert.deepEqual(recorded, {
      processed: 2,
      notified: 0,
      notificationIntents: 3,
      notificationDeliveryHistory: {
        pending: 2,
        dispatching: 0,
        delivered: 1,
        disabled: 0,
        suppressed: 0,
        failed: 0,
        unknown: 1,
      },
    });
    const snapshot = db
      .prepare("SELECT result_json FROM jobs ORDER BY id")
      .all();
    migrateSchema(db);
    assert.deepEqual(
      db.prepare("SELECT result_json FROM jobs ORDER BY id").all(),
      snapshot
    );
  } finally {
    db.close();
  }
});

for (const table of ["watched_searches", "key_value_store", "jobs"])
  test(`retirement rolls back a failed ${table} write and leaves old state and Tasks intact`, () => {
    const db = legacyFixture();
    try {
      db.exec(
        `CREATE TRIGGER fail_retirement BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'fixture failure'); END`
      );
      assert.throws(() => migrateSchema(db), /fixture failure/);
      assert.equal(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version=14")
          .get(),
        undefined
      );
      assert.equal(
        (
          db.prepare("PRAGMA table_info(watched_search_new)").all() as {
            name: string;
          }[]
        ).some((column) => column.name === "notification_attempted_at"),
        false
      );
      for (const table of retired)
        assert.ok(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            )
            .get(table)
        );
      assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM jobs").get(), {
        n: 2,
      });
    } finally {
      db.close();
    }
  });
