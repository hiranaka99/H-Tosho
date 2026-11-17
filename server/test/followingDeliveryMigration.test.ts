import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrateSchema } from '../src/db/migrations.js';

const deliveryTables = ['following_delivery_approvals', 'following_deliveries', 'following_contributions', 'following_events'];
for (const fixture of ['fresh', 'versionless', 'stamped11'] as const) test(`${fixture} upgrade preserves Following IDs/review/seen and never seeds historical outbox work`, () => {
  const sqlite = new Database(':memory:');
  try {
    if (fixture === 'versionless') {
      sqlite.exec(`CREATE TABLE watched_searches(id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, query TEXT NOT NULL,
        last_checked_at TEXT, last_result_count INTEGER, last_results_json TEXT, last_new_count INTEGER, last_finds_at TEXT,
        last_attempted_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (current_timestamp));
        INSERT INTO watched_searches(id,source,query,last_checked_at,last_results_json) VALUES(42,'hitomi','artist:historical','2026-01-01T00:00:00Z','[{"galleryId":"legacy-find","title":"Historical find"}]');`);
    } else if (fixture === 'stamped11') {
      migrateSchema(sqlite);
      sqlite.exec(`INSERT INTO watched_searches(id,source,query,display_name,revision,paused_at,next_check_at,last_checked_at,last_results_json)
        VALUES(42,'hitomi','artist:historical','Retained name',6,'2026-11-01T00:00:00Z',NULL,'2026-01-01T00:00:00Z','[{"galleryId":"legacy-find","title":"Historical find"}]');
        INSERT INTO watched_search_seen(search_id,source,gallery_id) VALUES(42,'hitomi','seen-gallery');
        INSERT INTO watched_search_new(search_id,source,query,watch_label,gallery_id,title,reviewed_at,found_at)
        VALUES(42,'hitomi','artist:historical','Retained name','retained-find','Retained find','2026-10-01T00:00:00Z','2026-09-01T00:00:00Z');
        ALTER TABLE watched_searches DROP COLUMN notification_mode;
        DELETE FROM schema_migrations WHERE version >= 12;`);
      for (const table of deliveryTables) sqlite.exec(`DROP TABLE ${table}`);
    }
    migrateSchema(sqlite);
    const watch = sqlite.prepare('SELECT id,query,notification_mode,revision,paused_at FROM watched_searches WHERE id=42').get();
    if (fixture !== 'fresh') assert.deepEqual(watch, { id: 42, query: 'artist:historical', notification_mode: 'immediate', revision: fixture === 'stamped11' ? 6 : 0, paused_at: fixture === 'stamped11' ? '2026-11-01T00:00:00Z' : null });
    if (fixture === 'stamped11') {
      assert.deepEqual(sqlite.prepare('SELECT gallery_id FROM watched_search_seen WHERE search_id=42').all(), [{ gallery_id: 'seen-gallery' }]);
      assert.deepEqual(sqlite.prepare('SELECT reviewed_at,title FROM watched_search_new WHERE search_id=42').get(), { reviewed_at: '2026-10-01T00:00:00Z', title: 'Retained find' });
    }
    for (const table of deliveryTables) assert.deepEqual(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), { n: 0 });
    const historical = sqlite.prepare('SELECT * FROM watched_search_new ORDER BY id').all(); migrateSchema(sqlite);
    assert.deepEqual(sqlite.prepare('SELECT * FROM watched_search_new ORDER BY id').all(), historical);
    assert.deepEqual(sqlite.prepare('SELECT version FROM schema_migrations WHERE version=12').get(), { version: 12 });
    sqlite.prepare("INSERT INTO following_events(source,gallery_id,title,settings_revision,destination_identity,created_at,ready_at) VALUES('hitomi','unique','Unique',0,'','2026-01-01','2026-01-01')").run();
    assert.throws(() => sqlite.prepare("INSERT INTO following_events(source,gallery_id,title,settings_revision,destination_identity,created_at,ready_at) VALUES('hitomi','unique','Duplicate',0,'','2026-01-01','2026-01-01')").run(), /UNIQUE/);
  } finally { sqlite.close(); }
});

test('migration12 is atomic and never stamps a failed incompatible outbox upgrade', () => {
  const sqlite = new Database(':memory:');
  try {
    migrateSchema(sqlite);
    sqlite.exec('DELETE FROM schema_migrations WHERE version >= 12; ALTER TABLE watched_searches DROP COLUMN notification_mode;');
    for (const table of deliveryTables) sqlite.exec(`DROP TABLE ${table}`);
    sqlite.exec('CREATE TABLE following_events(id INTEGER PRIMARY KEY)');
    assert.throws(() => migrateSchema(sqlite), /source|column/);
    assert.equal(sqlite.prepare('SELECT version FROM schema_migrations WHERE version=12').get(), undefined);
    assert.equal((sqlite.prepare('PRAGMA table_info(watched_searches)').all() as { name: string }[]).some(column => column.name === 'notification_mode'), false);
  } finally { sqlite.close(); }
});
