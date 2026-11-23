import { recoverLegacyConfirmations } from './legacyColumns.js';
import { pruneMetadataHistory } from './metadataRetention.js';
import { migrateSchema, splitLegacyJobState } from './migrations.js';
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
  // Standard WAL pairing: crash-safe, only a power loss may lose the last
  // transactions.
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  // Tolerate brief lock contention from concurrent readers (SSE snapshots, UI polls).
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('cache_size = -64000');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('mmap_size = 268435456');
  migrateSchema(sqlite);
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
  pruneMetadataHistory(sqlite);
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
    let target: Database.Database | null = null;
    let migrated = false;
    try {
      // Open read-write so any un-checkpointed WAL is recovered into the main
      // file (a read-only connection cannot recover a WAL that needs writing).
      const src = new Database(legacyFile);
      source = src;
      target = new Database(canonicalFile);
      const destination = target;
      // The canonical file may not exist yet (first run after a filename
      // rename), in which case the copy below would see no target tables and
      // silently skip every row. Create the schema up front so the column
      // intersection below always has something to match against.
      migrateSchema(target);
      // ATTACH lets us copy rows across databases in a single statement.
      target.exec(`ATTACH DATABASE '${legacyFile.replace(/'/g, "''")}' AS legacy`);
      const copyAll = destination.transaction(() => {
        for (const table of tables) {
          const exists = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
          if (!exists) continue;

          // Intersect columns present in both the legacy and canonical tables so
          // that minor schema drift never aborts the migration.
          const sourceCols = (src.prepare(`PRAGMA table_info(${table})`).all() ?? [])
            .map((c) => (c as { name: string }).name);
          const targetCols = new Set(
            (destination.prepare(`PRAGMA table_info(${table})`).all() ?? []).map(
              (c: unknown) => (c as { name: string }).name,
            ),
          );
          const cols = sourceCols.filter((n) => targetCols.has(n));
          if (cols.length === 0) continue;

          const colList = cols.join(', ');
          destination.exec(`INSERT OR IGNORE INTO ${table} (${colList}) SELECT ${colList} FROM legacy.${table}`);
        }
        splitLegacyJobState(destination);
        recoverLegacyConfirmations(destination);
        destination.exec(`INSERT OR IGNORE INTO owned_galleries (source, gallery_id)
          SELECT source, gallery_id FROM gallery_tags UNION SELECT source, gallery_id FROM download_queue WHERE status = 'completed'`);
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
      if (target?.open) target.close();
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

export function getDb(): Db {
  if (!db) return initDb();
  return db;
}

export { schema };
