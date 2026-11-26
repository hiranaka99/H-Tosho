import type Database from 'better-sqlite3';

/** Both history checkpoints and durable preview/approval evidence own image assets. */
export const PRUNE_UNUSED_COVER_ASSETS_SQL = `WITH plan_covers AS (
  SELECT cover.value AS val FROM metadata_restore_plans plan, json_each(plan.covers_json) cover WHERE plan.covers_json <> '[]'
)
DELETE FROM metadata_assets
  WHERE id NOT IN (
    SELECT before_asset_id FROM metadata_series_covers WHERE before_asset_id IS NOT NULL
    UNION SELECT after_asset_id FROM metadata_series_covers WHERE after_asset_id IS NOT NULL
    UNION SELECT before_asset_id FROM metadata_volume_covers WHERE before_asset_id IS NOT NULL
    UNION SELECT after_asset_id FROM metadata_volume_covers WHERE after_asset_id IS NOT NULL
    UNION SELECT json_extract(cover.value, '$.current.assetId') FROM metadata_restore_previews preview, json_each(preview.preview_json, '$.covers') cover WHERE preview.preview_json LIKE '%"assetId"%' AND json_extract(cover.value, '$.current.assetId') IS NOT NULL
    UNION SELECT json_extract(val, '$.expected.assetId') FROM plan_covers WHERE json_extract(val, '$.expected.assetId') IS NOT NULL
    UNION SELECT json_extract(val, '$.sourceAssetId') FROM plan_covers WHERE json_extract(val, '$.sourceAssetId') IS NOT NULL
  )`;
/** Independent of activity/job retention. Keep active work and the latest 20 revisions. */
export function pruneMetadataHistory(sqlite: Database.Database, now = Date.now()): void {
  const nowIso = new Date(now).toISOString();
  const cutoff = new Date(now - 180 * 86_400_000).toISOString();
  const expiredQuery = `WITH ranked AS (
      SELECT id, finished_at,
        ROW_NUMBER() OVER (PARTITION BY connection_key, series_id ORDER BY sequence DESC) AS rn
      FROM metadata_operations
      WHERE status <> 'running'
    )
    SELECT old.id FROM ranked old
    WHERE old.rn > 20 AND old.finished_at < ?
      AND NOT EXISTS (SELECT 1 FROM metadata_restore_plans plan
        WHERE plan.status IN ('approved', 'running') AND (plan.source_operation_id = old.id OR plan.operation_id = old.id))
      AND NOT EXISTS (SELECT 1 FROM metadata_restore_previews preview
        WHERE preview.source_operation_id = old.id AND preview.consumed_at IS NULL AND preview.expires_at > ?)`;
  sqlite.transaction(() => {
    // expires_at is always written as ISO-8601 UTC (toISOString), which orders
    // lexically; a bare comparison lets idx_metadata_restore_preview_expiry serve it.
    sqlite.prepare('DELETE FROM metadata_restore_previews WHERE expires_at <= ?').run(nowIso);
    const expiredIds = (sqlite.prepare(expiredQuery).all(cutoff, nowIso) as { id: string }[]).map((row) => row.id);
    for (let i = 0; i < expiredIds.length; i += 400) {
      const batch = expiredIds.slice(i, i + 400);
      const placeholders = batch.map(() => '?').join(',');
      sqlite.prepare(`DELETE FROM metadata_operation_steps WHERE operation_id IN (${placeholders})`).run(...batch);
      sqlite.prepare(`DELETE FROM metadata_series_covers WHERE operation_id IN (${placeholders})`).run(...batch);
      sqlite.prepare(`DELETE FROM metadata_volume_covers WHERE operation_id IN (${placeholders})`).run(...batch);
      sqlite.prepare(`DELETE FROM metadata_operations WHERE id IN (${placeholders})`).run(...batch);
    }
    // Retain the idempotency receipt, not duplicate XML after both journal sides
    // have aged out. Active plans remain fully pinned through queue/restart delays.
    sqlite.prepare(`UPDATE metadata_restore_plans AS plan
      SET expected_json = '{}', desired_json = '{}', archives_json = '[]', covers_json = '[]'
      WHERE plan.status NOT IN ('approved', 'running') AND plan.finished_at < ?
      AND (plan.expected_json <> '{}' OR plan.desired_json <> '{}' OR plan.archives_json <> '[]' OR plan.covers_json <> '[]')
      AND NOT EXISTS (SELECT 1 FROM metadata_operations operation
        WHERE operation.id = plan.source_operation_id OR operation.id = plan.operation_id)`).run(cutoff);
    sqlite.exec(PRUNE_UNUSED_COVER_ASSETS_SQL);
  })();
}
