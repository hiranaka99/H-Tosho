import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrateSchema } from '../src/db/migrations.js';
import { parseJobCommand } from '../src/contracts/jobs.js';

const retiredTables = ['series_gap_reports', 'series_gap_preferences', 'series_gap_ignores', 'gap_inventory_state'];
const retiredTask = 'scan-library-gaps';

function upgradeFixture(): Database.Database {
  const db = new Database(':memory:');
  migrateSchema(db);
  db.exec('DELETE FROM schema_migrations WHERE version = 11');
  for (const table of retiredTables) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, saved_value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(1, 'previously saved inventory state');
  }
  const insertJob = db.prepare('INSERT INTO jobs (id, type, status, payload_json, state_json) VALUES (?, ?, ?, ?, ?)');
  for (const [index, status] of ['queued', 'running', 'completed', 'failed', 'cancelled'].entries()) {
    insertJob.run(index + 1, retiredTask, status, '{"seriesId":42}', '{}');
    db.prepare('INSERT INTO job_logs (job_id, level, message) VALUES (?, ?, ?)').run(index + 1, 'info', 'old inventory task');
  }
  insertJob.run(100, 'check-watched-searches', 'queued', '{"mode":"manual","watchIds":[7]}', '{"context":{"series":[]}}');
  db.exec(`
    INSERT INTO job_logs (job_id, level, message) VALUES (100, 'info', 'keep this task log');
    INSERT INTO watched_searches (id, source, query, display_name, interval_minutes, next_check_at, revision)
      VALUES (7, 'hitomi', 'artist:kept', 'Kept watch', 60, '2030-01-01T10:00:00Z', 3);
    INSERT INTO watched_search_seen (search_id, source, gallery_id) VALUES (7, 'hitomi', 'kept-gallery');
    INSERT INTO watched_search_new (search_id, source, query, watch_label, gallery_id, title, found_at, reviewed_at)
      VALUES (7, 'hitomi', 'artist:kept', 'Kept watch', 'kept-gallery', 'Kept discovery', '2026-01-01T10:00:00Z', '2026-01-02T10:00:00Z');
    INSERT INTO series_field_policies (connection_key, series_id, locked_fields_json, revision, updated_at)
      VALUES ('https://kept.test', 42, '["title"]', 2, '2026-01-01T10:00:00Z');
  `);
  return db;
}

function remainingRetiredTables(db: Database.Database): string[] {
  return retiredTables.filter(table => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

test('upgrade removes retired reports and every old task state without losing Following, protection or other Tasks', () => {
  const db = upgradeFixture();
  try {
    migrateSchema(db);
    migrateSchema(db);
    assert.deepEqual(remainingRetiredTables(db), []);
    assert.deepEqual(db.prepare('SELECT id, type, status, payload_json, state_json FROM jobs').all(), [
      { id: 100, type: 'check-watched-searches', status: 'queued', payload_json: '{"mode":"manual","watchIds":[7]}', state_json: '{"context":{"series":[]}}' },
    ]);
    assert.deepEqual(db.prepare('SELECT job_id, message FROM job_logs').all(), [{ job_id: 100, message: 'keep this task log' }]);
    assert.deepEqual(db.prepare('SELECT id, display_name, interval_minutes, next_check_at, revision FROM watched_searches').get(),
      { id: 7, display_name: 'Kept watch', interval_minutes: 60, next_check_at: '2030-01-01T10:00:00Z', revision: 3 });
    assert.deepEqual(db.prepare('SELECT source, gallery_id FROM watched_search_seen').all(), [{ source: 'hitomi', gallery_id: 'kept-gallery' }]);
    assert.deepEqual(db.prepare('SELECT watch_label, title, reviewed_at FROM watched_search_new').get(),
      { watch_label: 'Kept watch', title: 'Kept discovery', reviewed_at: '2026-01-02T10:00:00Z' });
    assert.deepEqual(db.prepare('SELECT locked_fields_json, revision FROM series_field_policies').get(), { locked_fields_json: '["title"]', revision: 2 });
    assert.throws(() => parseJobCommand(retiredTask, {}), /Unsupported job type/);
  } finally { db.close(); }
});

test('fresh startup does not recreate retired storage through historical bootstrap migrations', () => {
  const db = new Database(':memory:');
  try {
    migrateSchema(db);
    assert.deepEqual(remainingRetiredTables(db), []);
  } finally { db.close(); }
});

test('failed cleanup rolls back logs and table state and remains eligible for the next successful startup', () => {
  const db = upgradeFixture();
  try {
    db.exec(`CREATE TRIGGER reject_retired_cleanup BEFORE DELETE ON jobs WHEN OLD.type = '${retiredTask}' BEGIN SELECT RAISE(ABORT, 'cleanup fixture failure'); END`);
    assert.throws(() => migrateSchema(db), /cleanup fixture failure/);
    assert.deepEqual(remainingRetiredTables(db), retiredTables);
    assert.deepEqual(db.prepare('SELECT count(*) AS count FROM jobs').get(), { count: 6 });
    assert.deepEqual(db.prepare('SELECT count(*) AS count FROM job_logs').get(), { count: 6 });
    assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version = 11').get(), undefined);
    db.exec('DROP TRIGGER reject_retired_cleanup');
    migrateSchema(db);
    assert.deepEqual(remainingRetiredTables(db), []);
    assert.deepEqual(db.prepare('SELECT count(*) AS count FROM jobs').get(), { count: 1 });
  } finally { db.close(); }
});

test('upgrading from v4.1/v4.2 databases without match_updates succeeds across index and table migrations', () => {
  for (const baseVersion of [16, 17]) {
    const db = new Database(':memory:');
    try {
      migrateSchema(db);
      // Rewind to a pre-v4.3 database where match_updates does not exist yet
      // and idx_download_queue_claim has the older definition.
      db.exec('DROP TABLE match_updates');
      db.exec('DROP INDEX IF EXISTS idx_download_queue_claim');
      db.exec('CREATE INDEX idx_download_queue_claim ON download_queue (status, id)');
      db.exec(`DELETE FROM schema_migrations WHERE version > ${baseVersion}`);

      migrateSchema(db);

      const matchUpdatesTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'match_updates'").get();
      assert.ok(matchUpdatesTable, `match_updates table must exist after upgrading from migration ${baseVersion}`);
      const matchUpdatesIdx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_match_updates_series'").get();
      assert.ok(matchUpdatesIdx, `idx_match_updates_series must exist after upgrading from migration ${baseVersion}`);
      const claimIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_download_queue_claim'").get() as { sql: string } | undefined;
      assert.match(claimIdx?.sql ?? '', /"priority" DESC/i, `idx_download_queue_claim must be rebuilt with priority DESC from migration ${baseVersion}`);
    } finally { db.close(); }
  }
});
