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

function createIndexes(sqlite: Database.Database): void {
  for (const table of tables) for (const index of table.indexes) {
    const columns = index.config.columns.map(column => {
      if (column instanceof SQL) throw new Error('Expression indexes require an explicit migration');
      return quote(column.name);
    });
    sqlite.exec(`CREATE ${index.config.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(index.config.name)} ON ${quote(table.name)} (${columns.join(', ')})`);
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
