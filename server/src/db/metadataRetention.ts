import type Database from 'better-sqlite3';

/** Independent of activity/job retention. Keep active work and the latest 20 revisions. */
export function pruneMetadataHistory(sqlite: Database.Database, now = Date.now()): void {
  const cutoff = new Date(now - 180 * 86_400_000).toISOString();
  const expired = `SELECT old.id FROM metadata_operations old
    WHERE old.status <> 'running' AND julianday(old.finished_at) < julianday(?)
    AND (SELECT count(*) FROM metadata_operations newer
      WHERE newer.connection_key = old.connection_key AND newer.series_id = old.series_id
      AND newer.status <> 'running' AND newer.sequence > old.sequence) >= 20
    AND NOT EXISTS (SELECT 1 FROM metadata_restore_plans plan
      WHERE plan.status IN ('approved', 'running') AND (plan.source_operation_id = old.id OR plan.operation_id = old.id))
    AND NOT EXISTS (SELECT 1 FROM metadata_restore_previews preview
      WHERE preview.source_operation_id = old.id AND preview.consumed_at IS NULL AND julianday(preview.expires_at) > julianday(?))`;
  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM metadata_restore_previews WHERE julianday(expires_at) <= julianday(?)').run(new Date(now).toISOString());
    sqlite.prepare(`DELETE FROM metadata_operation_steps WHERE operation_id IN (${expired})`).run(cutoff, new Date(now).toISOString());
    sqlite.prepare(`DELETE FROM metadata_series_covers WHERE operation_id IN (${expired})`).run(cutoff, new Date(now).toISOString());
    sqlite.prepare(`DELETE FROM metadata_operations WHERE id IN (${expired})`).run(cutoff, new Date(now).toISOString());
    // Retain the idempotency receipt, not duplicate XML after both journal sides
    // have aged out. Active plans remain fully pinned through queue/restart delays.
    sqlite.prepare(`UPDATE metadata_restore_plans AS plan
      SET expected_json = '{}', desired_json = '{}', archives_json = '[]'
      WHERE plan.status NOT IN ('approved', 'running') AND julianday(plan.finished_at) < julianday(?)
      AND NOT EXISTS (SELECT 1 FROM metadata_operations operation
        WHERE operation.id = plan.source_operation_id OR operation.id = plan.operation_id)`).run(cutoff);
    sqlite.prepare(`DELETE FROM metadata_assets AS asset WHERE NOT EXISTS (SELECT 1 FROM metadata_series_covers cover
      WHERE cover.before_asset_id = asset.id OR cover.after_asset_id = asset.id)`).run();
  })();
}
