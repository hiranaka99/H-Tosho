import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

/**
 * H-Tosho persists state in SQLite via Drizzle ORM using the
 * `better-sqlite3` driver (prebuilt binaries for Node >= 18, Docker-friendly).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical directory for all persisted state.
 *
 * This is anchored to the source file location rather than `process.cwd()` so
 * that data is stored in a single, stable place no matter how or from where the
 * server is launched (e.g. `npm run dev` runs with cwd=server/ while
 * `npm start` runs from the repo root). Overridable via HTOSHO_DATA_DIR.
 */
// The module lives in <server>/<src|dist>/db/, so two levels up is the server
// package root (identical layout for source and compiled output).
export const DATA_DIR = process.env.HTOSHO_DATA_DIR ?? path.join(__dirname, '..', '..', 'data');

/** Canonical database filename (kept in sync across legacy renames). */
const DB_FILENAME = 'htosho.db';

/**
 * Legacy database filenames that may exist from earlier versions of the app.
 * Their data is migrated into the canonical file on first run so nothing is lost.
 */
const LEGACY_DB_FILENAMES = ['kavisync.db', 'h-tosho.db'];

const TMP_DIR = path.join(DATA_DIR, 'tmp');

export function getTmpDir(): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

export type Db = BetterSQLite3Database<typeof schema>;

let db: Db | null = null;

export function initDb(): Db {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbFile = path.join(DATA_DIR, DB_FILENAME);
  migrateLegacyDatabases(dbFile);
  const sqlite = new Database(dbFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Tolerate brief lock contention from concurrent readers (SSE snapshots, UI polls).
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(SCHEMA_DDL);
  migrateDownloadQueueColumns(sqlite);
  migrateCatalogColumns(sqlite);
  migrateSeriesMatchColumns(sqlite);
  pruneOldData(sqlite);
  db = drizzle(sqlite, { schema });
  return db;
}
/** Retention windows for finished work so the database does not grow unbounded. */
const JOB_RETENTION_DAYS = 30;
const HISTORY_RETENTION_DAYS = 90;

/**
 * Delete finished jobs (and their logs) older than JOB_RETENTION_DAYS and sync
 * history older than HISTORY_RETENTION_DAYS. Runs once per process start; the
 * tables are small and indexed, so this is cheap. Cutoffs use SQLite's own
 * timestamp format ('YYYY-MM-DD HH:MM:SS') for consistent lexicographic
 * comparison against both default-generated and app-written timestamps.
 */
function pruneOldData(sqlite: Database.Database): void {
  const cutoff = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  sqlite.prepare(
    `DELETE FROM job_logs WHERE job_id IN (SELECT id FROM jobs WHERE status IN ('completed','failed','cancelled') AND finished_at < ?)`,
  ).run(cutoff(JOB_RETENTION_DAYS));
  sqlite.prepare(`DELETE FROM jobs WHERE status IN ('completed','failed','cancelled') AND finished_at < ?`).run(cutoff(JOB_RETENTION_DAYS));
  sqlite.prepare(`DELETE FROM sync_history WHERE created_at < ?`).run(cutoff(HISTORY_RETENTION_DAYS));
}

/**
 * Add columns introduced after initial release to databases that already exist.
 * `CREATE TABLE IF NOT EXISTS` only affects brand-new tables, so any DB created
 * by an older build must be upgraded in place. Each ALTER is guarded by a
 * column-existence check and wrapped so a failure never blocks startup.
 */
function migrateDownloadQueueColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(download_queue)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0) return; // table created by the DDL above already has every column
  const additions: [string, string][] = [
    ['bytes_current', 'INTEGER NOT NULL DEFAULT 0'],
    ['bytes_total', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of additions) {
    if (existing.has(col)) continue;
    try {
      sqlite.exec(`ALTER TABLE download_queue ADD COLUMN ${col} ${def}`);
    } catch (err) {
      console.warn(`[h-tosho] failed to add download_queue column ${col}:`, err);
    }
  }
}

/** Add the lazily-resolved catalog cover column to databases created before it existed. */
function migrateCatalogColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(mangadex_catalog)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0 || existing.has('cover_file')) return;
  try {
    sqlite.exec('ALTER TABLE mangadex_catalog ADD COLUMN cover_file TEXT');
  } catch (err) {
    console.warn('[h-tosho] failed to add mangadex_catalog column cover_file:', err);
  }
}
/** Add the alignment flag column to databases created before it existed. */
function migrateSeriesMatchColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(series_matches)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0 || existing.has('aligned')) return;
  try {
    sqlite.exec('ALTER TABLE series_matches ADD COLUMN aligned INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    console.warn('[h-tosho] failed to add series_matches column aligned:', err);
  }
}


/**
 * Consolidate data from any legacy database files into the canonical file.
 *
 * Earlier versions of the app stored state under different filenames
 * (kavisync.db, h-tosho.db). When such a file exists and holds rows that are
 * not already present in the canonical database, those rows are copied across
 * (without overwriting existing values) and the legacy file is archived with a
 * `.migrated` suffix. This ensures settings entered under an old filename are
 * recovered rather than silently lost.
 */
function migrateLegacyDatabases(canonicalFile: string): void {
  const tables = [
    'provider_credentials',
    'provider_priorities',
    'field_config',
    'library_overrides',
    'series_matches',
    'jobs',
    'job_logs',
    'sync_history',
    'download_queue',
    'key_value_store',
  ];

  for (const legacyFile of collectLegacyDatabaseFiles(canonicalFile)) {
    const label = path.basename(legacyFile);
    let source: Database.Database | null = null;
    let migrated = false;
    try {
      // Open read-write so any un-checkpointed WAL is recovered into the main
      // file (a read-only connection cannot recover a WAL that needs writing).
      const src = new Database(legacyFile);
      source = src;
      const target = new Database(canonicalFile);
      // The canonical file may not exist yet (first run after a filename
      // rename), in which case the copy below would see no target tables and
      // silently skip every row. Create the schema up front so the column
      // intersection below always has something to match against.
      target.exec(SCHEMA_DDL);
      // ATTACH lets us copy rows across databases in a single statement.
      target.exec(`ATTACH DATABASE '${legacyFile.replace(/'/g, "''")}' AS legacy`);
      const copyAll = target.transaction(() => {
        for (const table of tables) {
          const exists = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
          if (!exists) continue;

          // Intersect columns present in both the legacy and canonical tables so
          // that minor schema drift never aborts the migration.
          const sourceCols = (src.prepare(`PRAGMA table_info(${table})`).all() ?? [])
            .map((c) => (c as { name: string }).name);
          const targetCols = new Set(
            (target.prepare(`PRAGMA table_info(${table})`).all() ?? []).map(
              (c: unknown) => (c as { name: string }).name,
            ),
          );
          const cols = sourceCols.filter((n) => targetCols.has(n));
          if (cols.length === 0) continue;

          const colList = cols.join(', ');
          target.exec(`INSERT OR IGNORE INTO ${table} (${colList}) SELECT ${colList} FROM legacy.${table}`);
        }
      });
      copyAll();
      target.exec('DETACH DATABASE legacy');
      target.close();
      migrated = true;
    } catch (err) {
      // Never let a migration problem prevent startup.
      console.warn(`[h-tosho] failed to migrate legacy database ${legacyFile}:`, err);
    } finally {
      // Force the WAL into the main file before archiving so nothing is lost.
      try {
        source?.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* ignore */
      }
      source?.close();
    }

    if (!migrated || !source) {
      // Leave the original in place rather than archive data we failed to copy.
      console.warn(`[h-tosho] skipping archival of ${label} because migration did not complete`);
      continue;
    }

    try {
      fs.renameSync(legacyFile, `${legacyFile}.migrated`);
      // Move any leftover WAL/SHM sidecars along with the file.
      for (const suffix of ['-wal', '-shm']) {
        const side = legacyFile + suffix;
        if (fs.existsSync(side)) fs.renameSync(side, `${side}.migrated`);
      }
      console.log(`[h-tosho] migrated legacy database ${label} -> ${DB_FILENAME}`);
    } catch (err) {
      console.warn(`[h-tosho] could not archive legacy database ${label}:`, err);
    }
  }
}

/**
 * Collect the paths of every legacy database file that should be consolidated
 * into the canonical file. This covers both older filenames in the data
 * directory and databases that an earlier version wrote to an alternate
 * location (the dev server used to run with cwd=server/, creating
 * server/server/data/). Archived (.migrated) files are skipped.
 */
function collectLegacyDatabaseFiles(canonicalFile: string): string[] {
  const canonicalDir = path.dirname(canonicalFile);
  const legacyNames = new Set([...LEGACY_DB_FILENAMES, DB_FILENAME]);
  const seen = new Set<string>();
  const out: string[] = [];

  // The dev server historically ran with cwd=server/, which placed the database
  // at <serverRoot>/server/data. Relative to the canonical dir (<serverRoot>/data)
  // that alternate location is ../server/data.
  const altDir = path.join(canonicalDir, '..', 'server', 'data');
  for (const dir of [canonicalDir, altDir]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // directory may not exist
    }
    for (const entry of entries) {
      if (!legacyNames.has(entry)) continue;
      const full = path.join(dir, entry);
      if (!fs.existsSync(full)) continue;
      // Skip the canonical file itself and anything already archived.
      if (full === canonicalFile || full.endsWith('.migrated')) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      out.push(full);
    }
  }

  return out;
}

/** Idempotent bootstrap DDL (mirrors src/db/schema.ts). */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider_id TEXT PRIMARY KEY,
  credentials_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS provider_priorities (
  provider_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS field_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  field TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS library_overrides (
  library_id INTEGER PRIMARY KEY,
  priority_json TEXT NOT NULL DEFAULT '[]',
  auto_match INTEGER NOT NULL DEFAULT 1,
  field_config_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS series_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kavita_series_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unmatched',
  provider_id TEXT,
  provider_series_id TEXT,
  match_score REAL,
  aligned INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  error_message TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (current_timestamp),
  updated_at TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE TABLE IF NOT EXISTS mangadex_catalog (
  manga_id TEXT PRIMARY KEY,
  title_en TEXT,
  original_title TEXT,
  alt_titles_json TEXT NOT NULL DEFAULT '[]',
  description_en TEXT,
  year INTEGER,
  status TEXT,
  content_rating TEXT,
  mal_id TEXT,
  al_id TEXT,
  mu_id TEXT,
  md_updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  cover_file TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (current_timestamp),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kavita_series_id INTEGER NOT NULL,
  series_title TEXT,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (current_timestamp)
);
CREATE TABLE IF NOT EXISTS download_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  gallery_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  speed REAL,
  current_file TEXT,
  bytes_current INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  output_format TEXT NOT NULL DEFAULT 'cbz',
  output_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (current_timestamp),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS key_value_store (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_series ON sync_history(kavita_series_id);
CREATE INDEX IF NOT EXISTS idx_download_queue_gallery ON download_queue(source, gallery_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`;

export function getDb(): Db {
  if (!db) return initDb();
  return db;
}

export { schema };