import type Database from 'better-sqlite3';

/** Independent of activity/job retention. Keep active work and the latest 20 revisions. */
export function pruneMetadataHistory(sqlite: Database.Database, now = Date.now()): void {
  const cutoff = new Date(now - 180 * 86_400_000).toISOString();
  const expired = `SELECT old.id FROM metadata_operations old
    WHERE old.status <> 'running' AND julianday(old.finished_at) < julianday(?)
    AND (SELECT count(*) FROM metadata_operations newer
      WHERE newer.connection_key = old.connection_key AND newer.series_id = old.series_id
      AND newer.status <> 'running' AND newer.sequence > old.sequence) >= 20`;
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM metadata_operation_steps WHERE operation_id IN (${expired})`).run(cutoff);
    sqlite.prepare(`DELETE FROM metadata_operations WHERE id IN (${expired})`).run(cutoff);
  })();
}
