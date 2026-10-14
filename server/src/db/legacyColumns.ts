import type Database from 'better-sqlite3';

/**
 * Add columns introduced after initial release to databases that already exist.
 * `CREATE TABLE IF NOT EXISTS` only affects brand-new tables, so any DB created
 * by an older build must be upgraded in place. Each ALTER is guarded by a
 * column-existence check and runs inside the versioned migration transaction.
 */
export function migrateDownloadQueueColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(download_queue)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0) return; // table created by the DDL above already has every column
  const additions: [string, string][] = [
    ['bytes_current', 'INTEGER NOT NULL DEFAULT 0'],
    ['bytes_total', 'INTEGER NOT NULL DEFAULT 0'],
    ['merge_folder', 'TEXT'],
    ['chapter_number', 'INTEGER'],
    ['merge_job_id', 'INTEGER'],
    ['priority', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of additions) {
    if (existing.has(col)) continue;
    try {
      sqlite.exec(`ALTER TABLE download_queue ADD COLUMN ${col} ${def}`);
    } catch (err) {
      throw err;
    }
  }
}

/** Add the watched-search last-results column to databases created before it existed. */
export function migrateWatchedSearchColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(watched_searches)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0) return; // table created by the DDL above already has every column
  for (const [column, type] of [['last_results_json', 'TEXT'], ['last_new_count', 'INTEGER'], ['last_finds_at', 'TEXT'], ['last_attempted_at', 'TEXT'], ['last_error', 'TEXT']]) {
    if (!existing.has(column)) sqlite.exec(`ALTER TABLE watched_searches ADD COLUMN ${column} ${type}`);
  }
}

/** Preserve page counts in feeds created before this column existed. */
export function migrateWatchedSearchNewColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(watched_search_new)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0) return;
  for (const [column, type] of [['page_count', 'INTEGER'], ['artists_json', "TEXT NOT NULL DEFAULT '[]'"], ['language', 'TEXT'], ['reviewed_at', 'TEXT']]) {
    if (!existing.has(column)) sqlite.exec(`ALTER TABLE watched_search_new ADD COLUMN ${column} ${type}`);
  }
}

/** Preserve explicit approvals and remove the retired alignment flag. */
export function migrateSeriesMatchColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(series_matches)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0) return;
  if (existing.has('aligned')) sqlite.exec('ALTER TABLE series_matches DROP COLUMN aligned');
  if (!existing.has('confirmed')) sqlite.exec('ALTER TABLE series_matches ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0');
  if (!existing.has('confirmed')) {
    recoverLegacyConfirmations(sqlite);
  }
}

/** Add precise serve times so same-day fallback can choose least-recent picks. */
export function migrateRecommendationHistoryColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare('PRAGMA table_info(recommendation_history)').all() ?? []).map((c) => (c as { name: string }).name),
  );
  if (existing.size === 0 || existing.has('served_at')) return;
  try {
    sqlite.exec("ALTER TABLE recommendation_history ADD COLUMN served_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    sqlite.exec("UPDATE recommendation_history SET served_at = served_date || 'T00:00:00.000Z'");
  } catch (err) {
    throw err;
  }
}


export function recoverLegacyConfirmations(sqlite: Database.Database): void {
  // Recover explicit approvals from retained apply jobs. History alone is
  // ambiguous: automatic re-syncs also use the "updated" action. Require the
  // exact candidate and the current row's sync timestamp within that job.
  const hasJobs = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
  if (!hasJobs) return;
  const jobs = sqlite.prepare("SELECT payload_json, result_json, started_at, finished_at FROM jobs WHERE type = 'apply-series' AND status = 'completed'").all() as {
    payload_json: string; result_json: string | null; started_at: string | null; finished_at: string | null;
  }[];
  const findMatch = sqlite.prepare('SELECT provider_id, provider_series_id, last_synced_at FROM series_matches WHERE kavita_series_id = ? AND status = ?');
  const confirm = sqlite.prepare('UPDATE series_matches SET confirmed = 1 WHERE kavita_series_id = ?');
  sqlite.transaction(() => {
    for (const job of jobs) {
      try {
        const payload = JSON.parse(job.payload_json);
        const result = JSON.parse(job.result_json ?? '{}');
        if (!payload?.providerId || !payload.providerSeriesId || result?.matched !== 1 || result.failed !== 0) continue;
        const row = findMatch.get(payload.seriesId, 'matched') as { provider_id: string; provider_series_id: string; last_synced_at: string } | undefined;
        if (!row || row.provider_id !== payload.providerId || row.provider_series_id !== payload.providerSeriesId) continue;
        const syncedAt = Date.parse(row.last_synced_at);
        if (syncedAt >= Date.parse(job.started_at ?? '') && syncedAt <= Date.parse(job.finished_at ?? '')) confirm.run(payload.seriesId);
      } catch {
        // Malformed legacy job records cannot establish an approval.
      }
    }
  })();
}
