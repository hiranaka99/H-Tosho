import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';

/**
 * H-Tosho persists state in SQLite via Drizzle ORM using the
 * `better-sqlite3` driver (prebuilt binaries for Node >= 18, Docker-friendly).
 */

export const DATA_DIR =
  process.env.HTOSHO_DATA_DIR ??
  path.join(process.cwd(), 'server', 'data');

const TMP_DIR = path.join(DATA_DIR, 'tmp');

export function getTmpDir(): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;

export function initDb(): Db {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbFile = path.join(DATA_DIR, 'htosho.db');
  const sqlite = new Database(dbFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA_DDL);
  db = drizzle(sqlite, { schema });
  return db;
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
  metadata_json TEXT,
  error_message TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (current_timestamp),
  updated_at TEXT NOT NULL DEFAULT (current_timestamp)
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
`;

export function getDb(): Db {
  if (!db) return initDb();
  return db;
}

export { schema };