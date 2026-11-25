import type Database from 'better-sqlite3';
import { SQL } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';
import { migrateDownloadQueueColumns, migrateWatchedSearchColumns, migrateWatchedSearchNewColumns, migrateSeriesMatchColumns, migrateRecommendationHistoryColumns } from './legacyColumns.js';

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const dialect = new SQLiteSyncDialect();
const tables = Object.values(schema).map(table => getTableConfig(table));

/** Bootstrap uses the ORM's actual column definitions, including defaults and indexes. */
export function createSchemaTables(sqlite: Database.Database): void {
  for (const table of tables) {
    if (table.foreignKeys.length || table.checks.length || table.primaryKeys.length || table.uniqueConstraints.length) throw new Error(`Table ${table.name} requires explicit bootstrap constraint support`);
    const columns = table.columns.map(column => {
      const parts = [quote(column.name), column.getSQLType()];
      if (column.primary) parts.push('PRIMARY KEY');
      if ('autoIncrement' in column && column.autoIncrement) parts.push('AUTOINCREMENT');
      if (column.notNull) parts.push('NOT NULL');
      if (column.isUnique) parts.push('UNIQUE');
      if (column.default !== undefined) {
        const value = column.default;
        const literal = value instanceof SQL ? dialect.sqlToQuery(value.inlineParams()).sql
          : typeof value === 'string' ? `'${value.replace(/'/g, "''")}'`
          : typeof value === 'boolean' ? String(Number(value)) : String(value);
        parts.push('DEFAULT', literal);
      }
      return parts.join(' ');
    });
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${columns.join(', ')})`);
  }
}

function createIndexes(sqlite: Database.Database, following = false): void {
  for (const table of tables) for (const index of table.indexes) {
    // Legacy watch rows must be reconciled and extended before F1 indexes exist.
    if (!following && (index.config.name === 'idx_watched_searches_source_query' || index.config.name === 'idx_watched_searches_due')) continue;
    // SQL terms are plain column terms with a sort order (`"priority" DESC`);
    // a WHERE clause makes a partial index. Both are written as raw SQL in the schema.
    const columns = index.config.columns.map(column => column instanceof SQL ? dialect.sqlToQuery(column.inlineParams()).sql : quote(column.name));
    const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where.inlineParams()).sql}` : '';
    sqlite.exec(`CREATE ${index.config.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(index.config.name)} ON ${quote(table.name)} (${columns.join(', ')})${where}`);
  }
}

/** Each version commits atomically; a failed upgrade never receives a version stamp. */
export function migrateSchema(sqlite: Database.Database): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (current_timestamp))');
  const migrations = [
    () => {
      createSchemaTables(sqlite);
      migrateDownloadQueueColumns(sqlite);
      migrateWatchedSearchColumns(sqlite);
      migrateWatchedSearchNewColumns(sqlite);
      migrateSeriesMatchColumns(sqlite);
      migrateRecommendationHistoryColumns(sqlite);
      createIndexes(sqlite);
      sqlite.exec(`INSERT OR IGNORE INTO owned_galleries (source, gallery_id)
        SELECT source, gallery_id FROM gallery_tags UNION SELECT source, gallery_id FROM download_queue WHERE status = 'completed'`);
      sqlite.exec('DROP TABLE IF EXISTS mangadex_catalog');
    },
    () => {
      const add = (table: string, column: string, definition: string) => {
        const existing = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
        if (!existing.some(entry => entry.name === column)) sqlite.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${definition}`);
      };
      add('jobs', 'state_json', "TEXT NOT NULL DEFAULT '{}'");
      add('jobs', 'error_code', 'TEXT');
      for (const [column, definition] of [['phase', 'TEXT'], ['error_code', 'TEXT'], ['retry_at', 'TEXT'], ['retry_count', 'INTEGER NOT NULL DEFAULT 0'], ['attempt', 'INTEGER NOT NULL DEFAULT 0'], ['revision', 'INTEGER NOT NULL DEFAULT 0']]) add('download_queue', column, definition);
      sqlite.exec("UPDATE download_queue SET error_code = 'cancelled' WHERE status = 'failed' AND error_message = 'Cancelled by user'");
      splitLegacyJobState(sqlite);
    },
    () => {
      createSchemaTables(sqlite);
      createIndexes(sqlite);
    },
    () => {
      createSchemaTables(sqlite);
      createIndexes(sqlite);
    },
    () => {
      createSchemaTables(sqlite);
      createIndexes(sqlite);
    },
    () => {
      const columns = sqlite.prepare('PRAGMA table_info(metadata_operations)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'restored_from_operation_id')) sqlite.exec('ALTER TABLE metadata_operations ADD COLUMN restored_from_operation_id TEXT');
      createSchemaTables(sqlite);
      createIndexes(sqlite);
    },
    () => {
      for (const table of ['metadata_restore_previews', 'metadata_restore_plans']) {
        const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
        if (!columns.some(column => column.name === 'archives_json')) sqlite.exec(`ALTER TABLE ${quote(table)} ADD COLUMN archives_json TEXT NOT NULL DEFAULT '[]'`);
      }
    },
    () => {
      createSchemaTables(sqlite);
      createIndexes(sqlite);
    },
    () => {
      createSchemaTables(sqlite);
      createIndexes(sqlite);
    },
    () => {
      createSchemaTables(sqlite);
      migrateFollowing(sqlite);
      createIndexes(sqlite, true);
    },
    () => {
      sqlite.exec(`
        DELETE FROM job_logs WHERE job_id IN (SELECT id FROM jobs WHERE type = 'scan-library-gaps');
        DELETE FROM jobs WHERE type = 'scan-library-gaps';
        DROP TABLE IF EXISTS series_gap_reports;
        DROP TABLE IF EXISTS series_gap_preferences;
        DROP TABLE IF EXISTS series_gap_ignores;
        DROP TABLE IF EXISTS gap_inventory_state;
      `);
    },
    () => {
      const columns = sqlite.prepare('PRAGMA table_info(watched_searches)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'notification_mode')) sqlite.exec("ALTER TABLE watched_searches ADD COLUMN notification_mode TEXT NOT NULL DEFAULT 'immediate'");
      createSchemaTables(sqlite);
      createIndexes(sqlite, true);
      // Intentionally no historic discovery -> outbox replay.
    },
    () => {
      const add = (table: string, column: string, definition: string) => {
        const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
        if (!columns.some(entry => entry.name === column)) sqlite.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${definition}`);
      };
      for (const table of ['metadata_restore_previews', 'metadata_restore_plans']) add(table, 'covers_json', "TEXT NOT NULL DEFAULT '[]'");
      add('metadata_series_covers', 'after_evidence_json', 'TEXT');
      add('metadata_series_covers', 'requested_lock', 'INTEGER');
      add('metadata_series_covers', 'write_acknowledged', 'INTEGER NOT NULL DEFAULT 0');
      createSchemaTables(sqlite);
      createIndexes(sqlite, true);
    },
    () => retireFollowingDelivery(sqlite),
    () => {
      // Freeze a queued gallery's canonical origin so a Settings/site change
      // never rewrites where an in-flight or resumed task resolves from.
      const columns = sqlite.prepare('PRAGMA table_info(download_queue)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'source_url')) {
        sqlite.exec('ALTER TABLE download_queue ADD COLUMN source_url TEXT');
      }
      createSchemaTables(sqlite);
    },
    () => {
      // Persist parodies/characters/groups on gallery_tags and dismissed
      // gallery metadata so recommendations can learn from parodies and dismissals.
      const add = (table: string, column: string, definition: string) => {
        const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
        if (!columns.some(entry => entry.name === column)) sqlite.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${definition}`);
      };
      add('gallery_tags', 'parodies_json', "TEXT NOT NULL DEFAULT '[]'");
      add('gallery_tags', 'characters_json', "TEXT NOT NULL DEFAULT '[]'");
      add('gallery_tags', 'groups_json', "TEXT NOT NULL DEFAULT '[]'");
      add('dismissed_galleries', 'title', 'TEXT');
      add('dismissed_galleries', 'artists_json', "TEXT NOT NULL DEFAULT '[]'");
      add('dismissed_galleries', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
      createSchemaTables(sqlite);
      createIndexes(sqlite, true);
    },
    () => {
      // Performance indexes for hot queries and retention sweeps.
      createIndexes(sqlite, true);
    },
    () => {
      // The claim index gains `priority DESC, id` so claimNext needs no temp
      // sort; IF NOT EXISTS cannot redefine an index, so rebuild it.
      sqlite.exec('DROP INDEX IF EXISTS idx_download_queue_claim');
      createIndexes(sqlite, true);
    },
    () => {
      // Scheduled refreshes of matched series, and better-edition context on Following finds.
      const columns = sqlite.prepare('PRAGMA table_info(watched_search_new)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'better_edition_json')) sqlite.exec('ALTER TABLE watched_search_new ADD COLUMN better_edition_json TEXT');
      createSchemaTables(sqlite);
      createIndexes(sqlite, true);
    },
  ];
  for (const [index, migration] of migrations.entries()) {
    const version = index + 1;
    if (sqlite.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)) continue;
    sqlite.transaction(() => {
      migration();
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    })();
  }
}

/** Remove the retired delivery queue without deleting discoveries, Tasks, logs or Discord credentials. */
function retireFollowingDelivery(sqlite: Database.Database): void {
  const columns = sqlite.prepare('PRAGMA table_info(watched_search_new)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'notification_attempted_at')) {
    sqlite.exec('ALTER TABLE watched_search_new ADD COLUMN notification_attempted_at TEXT');
  }
  // Historical finds, including unsent digest backlog, must never be replayed.
  sqlite.exec('UPDATE watched_search_new SET notification_attempted_at = found_at WHERE notification_attempted_at IS NULL');
  sqlite.exec("UPDATE watched_searches SET notification_mode = 'immediate', revision = revision + 1 WHERE notification_mode = 'digest'");
  const object = (json: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(json);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* Keep malformed historical JSON verbatim. */ }
  };
  const stored = sqlite.prepare("SELECT value_json FROM key_value_store WHERE key = 'notifications'").get() as { value_json: string } | undefined;
  const settings = stored && object(stored.value_json);
  if (settings) {
    delete settings.digest;
    sqlite.prepare("UPDATE key_value_store SET value_json = ? WHERE key = 'notifications'").run(JSON.stringify(settings));
  }
  const exists = (table: string) => Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const summaries = new Map<number, Record<string, number>>();
  const add = (jobId: number, status: string) => {
    const summary = summaries.get(jobId) ?? { pending: 0, dispatching: 0, delivered: 0, disabled: 0, suppressed: 0, failed: 0, unknown: 0 };
    if (!Object.hasOwn(summary, status)) return;
    summary[status]++;
    summaries.set(jobId, summary);
  };
  if (exists('following_deliveries')) {
    const deliveries = sqlite.prepare('SELECT status, payload_json FROM following_deliveries').all() as { status: string; payload_json: string }[];
    for (const delivery of deliveries) {
      try {
        const members = JSON.parse(delivery.payload_json) as { originJobIds?: number[] }[];
        if (!Array.isArray(members)) continue;
        const ids = new Set(members.flatMap(member => Array.isArray(member?.originJobIds) ? member.originJobIds : []));
        for (const id of ids) if (Number.isSafeInteger(id) && id > 0) add(id, delivery.status);
      } catch { /* Invalid delivery payloads must not damage readable Task history. */ }
    }
  }
  if (exists('following_events') && exists('following_contributions')) {
    const waiting = sqlite.prepare(`SELECT DISTINCT e.id, c.origin_job_id FROM following_events e JOIN following_contributions c ON c.event_id = e.id
      WHERE e.delivery_id IS NULL AND e.status = 'pending' AND c.origin_job_id IS NOT NULL`).all() as { origin_job_id: number }[];
    for (const row of waiting) add(row.origin_job_id, 'pending');
  }
  for (const [id, summary] of summaries) {
    const job = sqlite.prepare("SELECT result_json FROM jobs WHERE id = ? AND type = 'check-watched-searches'").get(id) as { result_json: string | null } | undefined;
    if (!job) continue;
    const result = object(job.result_json ?? '{}');
    if (result) {
      result.notificationDeliveryHistory = summary;
      sqlite.prepare('UPDATE jobs SET result_json = ? WHERE id = ?').run(JSON.stringify(result), id);
    }
  }
  for (const table of ['following_delivery_approvals', 'following_deliveries', 'following_contributions', 'following_events']) {
    sqlite.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
  }
}

/** Migration 10: retain history while consolidating old non-unique watch identities. */
function migrateFollowing(sqlite: Database.Database): void {
  const add = (table: string, column: string, definition: string) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
    if (!columns.some(entry => entry.name === column)) sqlite.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${definition}`);
  };
  for (const [column, definition] of [
    ['display_name', 'TEXT'], ['folder_id', 'INTEGER'], ['paused_at', 'TEXT'],
    ['interval_minutes', 'INTEGER'], ['revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_check_at', 'TEXT'], ['last_failed_at', 'TEXT'],
  ]) add('watched_searches', column, definition);
  add('watched_search_new', 'watch_label', "TEXT NOT NULL DEFAULT ''");
  sqlite.exec(`UPDATE watched_searches SET last_failed_at = last_attempted_at WHERE last_error IS NOT NULL AND last_failed_at IS NULL;
    UPDATE watched_search_new SET watch_label = COALESCE(
      (SELECT COALESCE(NULLIF(display_name, ''), query) FROM watched_searches WHERE id = search_id), query)
      WHERE watch_label = ''`);

  type Watch = {
    id: number; source: string; query: string; display_name: string | null;
    last_checked_at: string | null; last_result_count: number | null; last_results_json: string | null;
    last_new_count: number | null; last_finds_at: string | null; last_attempted_at: string | null;
    last_failed_at: string | null; last_error: string | null;
  };
  const watches = sqlite.prepare('SELECT * FROM watched_searches ORDER BY id').all() as Watch[];
  const groups = new Map<string, Watch[]>();
  for (const watch of watches) {
    const key = JSON.stringify([watch.source, watch.query]);
    const group = groups.get(key);
    if (group) group.push(watch); else groups.set(key, [watch]);
  }
  const replay = sqlite.prepare(`INSERT INTO watched_search_new
    (search_id, source, query, watch_label, gallery_id, title, url, cover_url, page_count, found_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(search_id, source, gallery_id) DO UPDATE SET
      url = COALESCE(watched_search_new.url, excluded.url),
      cover_url = COALESCE(watched_search_new.cover_url, excluded.cover_url),
      page_count = COALESCE(watched_search_new.page_count, excluded.page_count)`);
  const unionSeen = sqlite.prepare(`INSERT INTO watched_search_seen (search_id, source, gallery_id, first_seen_at)
    SELECT ?, source, gallery_id, first_seen_at FROM watched_search_seen WHERE search_id = ?
    ON CONFLICT(search_id, source, gallery_id) DO UPDATE SET first_seen_at = MIN(watched_search_seen.first_seen_at, excluded.first_seen_at)`);
  type Find = {
    id: number; search_id: number; source: string; gallery_id: string; title: string;
    url: string | null; cover_url: string | null; page_count: number | null; artists_json: string;
    language: string | null; reviewed_at: string | null; found_at: string;
  };
  const mergeFind = sqlite.prepare(`UPDATE watched_search_new SET search_id = ?, watch_label = ?, title = ?,
    url = ?, cover_url = ?, page_count = ?, artists_json = ?, language = ?, reviewed_at = ?, found_at = ? WHERE id = ?`);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = group[0];
    const label = canonical.display_name || group.find(watch => watch.display_name)?.display_name || canonical.query;
    // Older builds may only have the retained last-results JSON. Replay every
    // duplicate before deleting it, not merely the canonical row's latest finds.
    for (const watch of group) {
      try {
        const items: unknown = JSON.parse(watch.last_results_json ?? '[]');
        if (Array.isArray(items)) for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const r = item as Record<string, unknown>;
          if (typeof r.galleryId !== 'string' || typeof r.title !== 'string') continue;
          replay.run(watch.id, watch.source, watch.query, label, r.galleryId, r.title,
            typeof r.url === 'string' ? r.url : null, typeof r.coverUrl === 'string' ? r.coverUrl : null,
            typeof r.pageCount === 'number' && Number.isSafeInteger(r.pageCount) && r.pageCount > 0 ? r.pageCount : null,
            watch.last_finds_at ?? watch.last_checked_at ?? '1970-01-01T00:00:00.000Z');
        }
      } catch { /* Malformed legacy JSON remains on the surviving watch when available. */ }
      if (watch.id !== canonical.id) unionSeen.run(canonical.id, watch.id);
    }
    const ids = group.map(watch => watch.id);
    const finds = sqlite.prepare(`SELECT * FROM watched_search_new WHERE search_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Find[];
    const galleries = new Map<string, Find[]>();
    for (const find of finds) {
      const key = JSON.stringify([find.source, find.gallery_id]);
      const rows = galleries.get(key);
      if (rows) rows.push(find); else galleries.set(key, [find]);
    }
    for (const rows of galleries.values()) {
      const survivor = rows[0];
      const newest = [...rows].sort((a, b) => b.found_at.localeCompare(a.found_at) || b.id - a.id);
      const known = <K extends keyof Find>(key: K, usable: (value: Find[K]) => boolean): Find[K] | null => newest.find(row => usable(row[key]))?.[key] ?? null;
      const artists = new Set<string>();
      for (const row of rows) {
        try {
          const values: unknown = JSON.parse(row.artists_json);
          if (Array.isArray(values)) for (const artist of values) if (typeof artist === 'string') artists.add(artist);
        } catch { /* Other collision rows can still supply valid metadata. */ }
      }
      for (const row of rows.slice(1)) sqlite.prepare('DELETE FROM watched_search_new WHERE id = ?').run(row.id);
      mergeFind.run(canonical.id, label,
        known('title', value => !!value && value !== survivor.gallery_id) ?? survivor.title,
        known('url', value => !!value), known('cover_url', value => !!value),
        known('page_count', value => value !== null && value > 0),
        JSON.stringify([...artists]),
        known('language', value => !!value), known('reviewed_at', value => !!value),
        newest[0].found_at, survivor.id);
    }
    const latest = (key: 'last_checked_at' | 'last_finds_at' | 'last_attempted_at' | 'last_failed_at') =>
      [...group].sort((a, b) => (b[key] ?? '').localeCompare(a[key] ?? '') || a.id - b.id)[0];
    const checked = latest('last_checked_at'), findsWatch = latest('last_finds_at'), attempted = latest('last_attempted_at'), failed = latest('last_failed_at');
    sqlite.prepare(`UPDATE watched_searches SET display_name = ?, last_checked_at = ?, last_result_count = ?,
      last_results_json = ?, last_new_count = ?, last_finds_at = ?, last_attempted_at = ?, last_failed_at = ?, last_error = ? WHERE id = ?`)
      .run(label === canonical.query ? null : label, checked.last_checked_at, checked.last_result_count,
        findsWatch.last_results_json ?? checked.last_results_json, checked.last_new_count, findsWatch.last_finds_at,
        attempted.last_attempted_at, failed.last_failed_at, attempted.last_error, canonical.id);
    for (const watch of group.slice(1)) {
      sqlite.prepare('DELETE FROM watched_search_seen WHERE search_id = ?').run(watch.id);
      sqlite.prepare('DELETE FROM watched_searches WHERE id = ?').run(watch.id);
    }
  }
  // Review is gallery-wide, including retained rows from already removed watches.
  sqlite.exec(`UPDATE watched_search_new AS discovery SET reviewed_at =
    (SELECT MAX(reviewed_at) FROM watched_search_new AS other
      WHERE other.source = discovery.source AND other.gallery_id = discovery.gallery_id)
    WHERE EXISTS (SELECT 1 FROM watched_search_new AS other
      WHERE other.source = discovery.source AND other.gallery_id = discovery.gallery_id AND other.reviewed_at IS NOT NULL)`);
}

export function splitLegacyJobState(sqlite: Database.Database): void {
  const rows = sqlite.prepare('SELECT id, payload_json, state_json FROM jobs').all() as { id: number; payload_json: string; state_json: string }[];
  const update = sqlite.prepare('UPDATE jobs SET payload_json = ?, state_json = ? WHERE id = ?');
  for (const row of rows) {
    try {
      const command = JSON.parse(row.payload_json);
      if (!command || typeof command !== 'object' || Array.isArray(command)) continue;
      const stored = JSON.parse(row.state_json ?? '{}');
      const state: Record<string, unknown> = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      for (const key of ['context', 'contextPendingSeriesIds', 'mergeDownloadIds']) {
        if (command[key] !== undefined) { if (state[key] === undefined) state[key] = command[key]; delete command[key]; }
      }
      update.run(JSON.stringify(command), JSON.stringify(state), row.id);
    } catch { /* Invalid legacy commands remain inspectable and fail validation when executed. */ }
  }
}
