import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { MetadataSnapshot } from '../contracts/metadataHistory.js';
import { MAX_RETAINED_COVER_BYTES,
  type RecordedCover, type CoverHistory, type CoverCheckpoint, type CoverTarget } from '../contracts/metadataCovers.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { observeCover, retainCoverObservation, retainCoverWithBudgetCheck, hasCoverAssetMetadata, sameCoverObservation, coverTargetKey, loadCoverAsset,
  coverMediaType, coverStorageBudget, type CoverObservation } from './coverObservations.js';
import { mapLimit } from '../lib/http.js';
import { PRUNE_UNUSED_COVER_ASSETS_SQL } from '../db/metadataRetention.js';

export { coverMediaType, coverStorageBudget };

const connection=()=>kavitaConnectionKey(getKavitaConnection().baseUrl);
export type CoverCheckpointRow = typeof schema.metadataSeriesCovers.$inferSelect | typeof schema.metadataVolumeCovers.$inferSelect;
type CoverCheckpointHistoryRow = Omit<typeof schema.metadataSeriesCovers.$inferSelect, 'beforeEvidenceJson' | 'afterEvidenceJson'>
  | Omit<typeof schema.metadataVolumeCovers.$inferSelect, 'beforeEvidenceJson' | 'afterEvidenceJson'>;
type CoverPatch = Partial<Omit<typeof schema.metadataSeriesCovers.$inferInsert, 'operationId'>>;
export interface CoverJournalResult { problems: string[]; warnings: string[]; changed: boolean; unverifiedNativeLocks: number }
export interface CoverJournal {
  capture(target?: CoverTarget, options?: { preObserved?: CoverObservation; skipVerify?: boolean }): Promise<void>;
  beginWrite(target: CoverTarget, lock: boolean, assetId?: string): void;
  acknowledge(target: CoverTarget): void;
  finish(): Promise<CoverJournalResult>;
}

export function getCoverCheckpoint(operationId: string, target: CoverTarget): CoverCheckpointRow | undefined {
  const db = getDb();
  return target.kind === 'series'
    ? db.select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId, operationId)).get()
    : db.select().from(schema.metadataVolumeCovers).where(and(eq(schema.metadataVolumeCovers.operationId, operationId), eq(schema.metadataVolumeCovers.volumeId, target.volumeId))).get();
}

function updateCheckpoint(operationId: string, target: CoverTarget, values: CoverPatch): void {
  const db = getDb();
  if (target.kind === 'series') db.update(schema.metadataSeriesCovers).set(values).where(eq(schema.metadataSeriesCovers.operationId, operationId)).run();
  else db.update(schema.metadataVolumeCovers).set(values).where(and(eq(schema.metadataVolumeCovers.operationId, operationId), eq(schema.metadataVolumeCovers.volumeId, target.volumeId))).run();
}

function ensureCheckpoint(operationId: string, target: CoverTarget): void {
  const db = getDb();
  if (target.kind === 'series') db.insert(schema.metadataSeriesCovers).values({ operationId }).onConflictDoNothing().run();
  else db.insert(schema.metadataVolumeCovers).values({ operationId, volumeId: target.volumeId, name: `Volume #${target.volumeId}` }).onConflictDoNothing().run();
}

/** The caller owns the parent series mutation boundary; original bytes remain unmodified. */
export function coverJournal(client: KavitaClient, operationId: string, seriesId: number, expected: MetadataSnapshot, key: string): CoverJournal {
  const saved = new Map<string, { target: CoverTarget; observation: Omit<CoverObservation, 'data'> }>();
  const requested = new Map<string, { lock: boolean; assetId?: string }>();
  const db = getDb();
  return {
    async capture(target: CoverTarget = { kind: 'series' }, options?: { preObserved?: CoverObservation; skipVerify?: boolean }): Promise<void> {
      if (target.kind === 'volume' && (!Number.isSafeInteger(target.volumeId) || target.volumeId <= 0)) throw new Error('Invalid volume-cover target');
      const targetKey = coverTargetKey(target), previous = saved.get(targetKey);
      ensureCheckpoint(operationId, target);
      if (process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB === undefined && !previous) {
        updateCheckpoint(operationId, target, { status: 'not-captured', beforeReason: 'Cover capture was disabled; configure its storage budget to retain images', afterReason: 'No after image was retained because cover capture was disabled' });
        return;
      }
      if (previous) {
        if (!options?.skipVerify) {
          const current = await observeCover(client, seriesId, target, expected, key);
          if (!sameCoverObservation(previous.observation, current)) throw new Error('Cover, native lock or indexed identity changed after preparation; review required');
        }
        updateCheckpoint(operationId, target, { status: 'applying' });
        return;
      }
      try {
        const value = options?.preObserved ?? await observeCover(client, seriesId, target, expected, key);
        db.transaction(() => {
          updateCheckpoint(operationId, target, { reservedBytes: MAX_RETAINED_COVER_BYTES });
          retainCoverWithBudgetCheck(value, true);
          updateCheckpoint(operationId, target, { status: 'prepared', beforeState: value.state, beforeAssetId: value.assetId, beforeLocked: value.locked, beforeEvidenceJson: JSON.stringify(value.evidence), beforeReason: null });
          if (target.kind === 'volume') db.update(schema.metadataVolumeCovers).set({ name: value.name }).where(and(eq(schema.metadataVolumeCovers.operationId, operationId), eq(schema.metadataVolumeCovers.volumeId, target.volumeId))).run();
        });
        const { data: _data, ...observation } = value;
        saved.set(targetKey, { target, observation });
      } catch (error) {
        updateCheckpoint(operationId, target, { status: 'not-captured', beforeReason: error instanceof Error ? error.message : 'Could not capture the current cover', afterReason: 'Cover write was skipped because required before capture failed', reservedBytes: 0 });
        throw error;
      }
    },
    beginWrite(target: CoverTarget, lock: boolean, assetId?: string): void {
      ensureCheckpoint(operationId, target);
      requested.set(coverTargetKey(target), { lock, assetId });
      updateCheckpoint(operationId, target, { requestedLock: lock, writeAcknowledged: false });
    },
    acknowledge(target: CoverTarget): void {
      updateCheckpoint(operationId, target, { writeAcknowledged: true });
    },
    async finish(): Promise<CoverJournalResult> {
      const result: CoverJournalResult = { problems: [], warnings: [], changed: false, unverifiedNativeLocks: 0 };
      const entries = [...saved.entries()];
      const observed = await mapLimit(entries, 4, async ([targetKey, previous]) => {
        try {
          const value = await observeCover(client, seriesId, previous.target, { ...expected, ...(previous.observation.evidence.installationId ? { installationId: previous.observation.evidence.installationId } : {}) }, key);
          return { targetKey, previous, value, error: undefined as unknown };
        } catch (error) {
          return { targetKey, previous, value: undefined, error };
        }
      });
      for (const { targetKey, previous, value, error } of observed) {
        if (!value) {
          const message = error instanceof Error ? error.message : 'Could not retain verified cover readback';
          updateCheckpoint(operationId, previous.target, { status: 'unverified', afterReason: message, reservedBytes: 0 });
          result.problems.push(`${previous.observation.name}: ${message}`);
          continue;
        }
        try {
          const intent = requested.get(targetKey), checkpoint = getCoverCheckpoint(operationId, previous.target)!;
          const problems: string[] = [];
          if (JSON.stringify(value.evidence.volume) !== JSON.stringify(previous.observation.evidence.volume)) problems.push('Indexed volume identity changed during the cover operation');
          if (intent && value.locked !== null && value.locked !== intent.lock) problems.push('Requested native cover lock was not confirmed');
          if (intent?.assetId && intent.assetId !== previous.observation.assetId && value.assetId === previous.observation.assetId && value.evidence.token === previous.observation.evidence.token) problems.push('The requested image upload produced no observed cover change');
          if (intent && value.locked === null) {
            result.unverifiedNativeLocks++;
            result.warnings.push(`${value.name}: image observed; requested native lock ${intent.lock ? 'locked' : 'unlocked'} ${checkpoint.writeAcknowledged ? 'was acknowledged by the API' : 'was not acknowledged'}, but this server does not expose lock readback`);
          }
          db.transaction(() => {
            updateCheckpoint(operationId, previous.target, { reservedBytes: 0 });
            retainCoverObservation(value);
            updateCheckpoint(operationId, previous.target, { status: problems.length ? 'unverified' : 'observed', afterState: value.state, afterAssetId: value.assetId, afterLocked: value.locked, afterEvidenceJson: JSON.stringify(value.evidence), afterReason: problems.join('; ') || null });
          });
          result.changed ||= value.state !== previous.observation.state || value.assetId !== previous.observation.assetId || (value.locked !== null && previous.observation.locked !== null && value.locked !== previous.observation.locked);
          result.problems.push(...problems.map(problem => `${value.name}: ${problem}`));
        } catch (persistError) {
          const message = persistError instanceof Error ? persistError.message : 'Could not retain verified cover readback';
          updateCheckpoint(operationId, previous.target, { status: 'unverified', afterReason: message, reservedBytes: 0 });
          result.problems.push(`${previous.observation.name}: ${message}`);
        }
      }
      return result;
    },
  };
}

type AssetMeta = { id: string; mediaType: string; byteSize: number };

export function recordedCover(row: CoverCheckpointHistoryRow, side: 'before' | 'after', assetsById?: Map<string, AssetMeta>): RecordedCover {
  const rawState = side === 'before' ? row.beforeState : row.afterState;
  const state = rawState === 'captured' || rawState === 'absent' ? rawState : 'unavailable';
  const id = side === 'before' ? row.beforeAssetId : row.afterAssetId;
  const asset = !id
    ? undefined
    : assetsById
      ? assetsById.get(id)
      : getDb().select({ id: schema.metadataAssets.id, mediaType: schema.metadataAssets.mediaType, byteSize: schema.metadataAssets.byteSize }).from(schema.metadataAssets).where(eq(schema.metadataAssets.id, id)).get();
  const nativeLocked = side === 'before' ? row.beforeLocked : row.afterLocked;
  return { state: state === 'captured' && !asset ? 'unavailable' : state, assetId: asset?.id ?? null, mediaType: asset?.mediaType ?? null, byteSize: asset?.byteSize ?? null, nativeLocked,
    nativeLockReason: nativeLocked === null && state !== 'unavailable' ? 'This server did not expose the native cover lock; its value was not inferred.' : null,
    reason: state === 'captured' && !asset ? 'Retained cover asset is no longer available' : side === 'before' ? row.beforeReason : row.afterReason };
}

function checkpointHistory(row: CoverCheckpointHistoryRow, target: CoverTarget, running: boolean, assetsById?: Map<string, AssetMeta>): CoverCheckpoint {
  const before = recordedCover(row, 'before', assetsById), after = recordedCover(row, 'after', assetsById);
  let budgetReason: string | null = process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB === undefined ? 'Configure a cover-history budget before restoring images' : null;
  try { coverStorageBudget(); } catch (error) { budgetReason = error instanceof Error ? error.message : 'Cover-history budget is invalid'; }
  const availability = (cover: RecordedCover, side: 'before' | 'after') => {
    const reason = running ? 'Source operation is still running' : budgetReason ?? (cover.state !== 'captured' ? cover.state === 'absent' ? 'Kavita resets/regenerates covers rather than preserving an absent image' : cover.reason ?? 'This image was not captured' : side === 'after' && row.status !== 'observed' ? 'After cover readback was not verified' : null);
    return { available: reason === null, reason };
  };
  const imageChanged = before.state !== after.state || before.assetId !== after.assetId;
  const changed = before.state === 'unavailable' || after.state === 'unavailable' ? null : imageChanged ? true : before.nativeLocked === null || after.nativeLocked === null ? null : before.nativeLocked !== after.nativeLocked;
  return { ...target, name: 'name' in row ? row.name : 'Series cover', status: row.status, before, after, changed, requestedLock: row.requestedLock, writeAcknowledged: row.writeAcknowledged,
    restoreAvailability: { before: availability(before, 'before'), after: availability(after, 'after') } };
}

/** Batch-load cover history for multiple operations in 3 queries instead of N+1. */
export function coverHistoryBatch(operations: { id: string; status: string }[]): Map<string, CoverHistory> {
  const result = new Map<string, CoverHistory>();
  if (!operations.length) return result;
  const db = getDb();
  const ids = operations.map((op) => op.id);
  const seriesRows = db.select({
    operationId: schema.metadataSeriesCovers.operationId,
    status: schema.metadataSeriesCovers.status,
    beforeState: schema.metadataSeriesCovers.beforeState,
    beforeAssetId: schema.metadataSeriesCovers.beforeAssetId,
    beforeLocked: schema.metadataSeriesCovers.beforeLocked,
    beforeReason: schema.metadataSeriesCovers.beforeReason,
    afterState: schema.metadataSeriesCovers.afterState,
    afterAssetId: schema.metadataSeriesCovers.afterAssetId,
    afterLocked: schema.metadataSeriesCovers.afterLocked,
    afterReason: schema.metadataSeriesCovers.afterReason,
    requestedLock: schema.metadataSeriesCovers.requestedLock,
    writeAcknowledged: schema.metadataSeriesCovers.writeAcknowledged,
    reservedBytes: schema.metadataSeriesCovers.reservedBytes,
  }).from(schema.metadataSeriesCovers).where(inArray(schema.metadataSeriesCovers.operationId, ids)).all();
  const volumeRows = db.select({
    id: schema.metadataVolumeCovers.id,
    operationId: schema.metadataVolumeCovers.operationId,
    volumeId: schema.metadataVolumeCovers.volumeId,
    name: schema.metadataVolumeCovers.name,
    status: schema.metadataVolumeCovers.status,
    beforeState: schema.metadataVolumeCovers.beforeState,
    beforeAssetId: schema.metadataVolumeCovers.beforeAssetId,
    beforeLocked: schema.metadataVolumeCovers.beforeLocked,
    beforeReason: schema.metadataVolumeCovers.beforeReason,
    afterState: schema.metadataVolumeCovers.afterState,
    afterAssetId: schema.metadataVolumeCovers.afterAssetId,
    afterLocked: schema.metadataVolumeCovers.afterLocked,
    afterReason: schema.metadataVolumeCovers.afterReason,
    requestedLock: schema.metadataVolumeCovers.requestedLock,
    writeAcknowledged: schema.metadataVolumeCovers.writeAcknowledged,
    reservedBytes: schema.metadataVolumeCovers.reservedBytes,
  }).from(schema.metadataVolumeCovers).where(inArray(schema.metadataVolumeCovers.operationId, ids)).all();
  const assetIds = new Set<string>();
  const seriesByOp = new Map<string, typeof seriesRows[number]>();
  for (const row of seriesRows) {
    seriesByOp.set(row.operationId, row);
    if (row.beforeAssetId) assetIds.add(row.beforeAssetId);
    if (row.afterAssetId) assetIds.add(row.afterAssetId);
  }
  const volumesByOp = new Map<string, (typeof volumeRows[number])[]>();
  for (const row of volumeRows) {
    const list = volumesByOp.get(row.operationId);
    if (list) list.push(row);
    else volumesByOp.set(row.operationId, [row]);
    if (row.beforeAssetId) assetIds.add(row.beforeAssetId);
    if (row.afterAssetId) assetIds.add(row.afterAssetId);
  }
  const assetsById = new Map<string, AssetMeta>();
  const assetIdList = [...assetIds];
  for (let i = 0; i < assetIdList.length; i += 400) {
    const batch = assetIdList.slice(i, i + 400);
    for (const asset of db.select({ id: schema.metadataAssets.id, mediaType: schema.metadataAssets.mediaType, byteSize: schema.metadataAssets.byteSize }).from(schema.metadataAssets).where(inArray(schema.metadataAssets.id, batch)).all()) {
      assetsById.set(asset.id, asset);
    }
  }
  for (const op of operations) {
    const series = seriesByOp.get(op.id);
    const volumes = volumesByOp.get(op.id) ?? [];
    if (!series && !volumes.length) continue;
    const running = op.status === 'running';
    result.set(op.id, {
      ...(series ? { series: checkpointHistory(series, { kind: 'series' }, running, assetsById) } : {}),
      volumes: volumes.map((row) => checkpointHistory(row, { kind: 'volume', volumeId: row.volumeId }, running, assetsById)),
    });
  }
  return result;
}

export function coverHistory(operationId: string): CoverHistory | undefined {
  const db = getDb();
  const operation = db.select({ id: schema.metadataOperations.id, status: schema.metadataOperations.status }).from(schema.metadataOperations).where(eq(schema.metadataOperations.id, operationId)).get();
  if (!operation) return undefined;
  return coverHistoryBatch([operation]).get(operationId);
}

function authorizeRetainedCoverAsset(seriesId: number, operationId: string, assetId: string): boolean {
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) return false;
  const db = getDb();
  if (!db.select({ id: schema.metadataOperations.id }).from(schema.metadataOperations).where(and(eq(schema.metadataOperations.connectionKey, connection()), eq(schema.metadataOperations.seriesId, seriesId), eq(schema.metadataOperations.id, operationId))).get()) return false;
  const series = db.select({ beforeAssetId: schema.metadataSeriesCovers.beforeAssetId, afterAssetId: schema.metadataSeriesCovers.afterAssetId })
    .from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId, operationId)).get();
  if (series && (series.beforeAssetId === assetId || series.afterAssetId === assetId)) return true;
  const volume = db.select({ id: schema.metadataVolumeCovers.id }).from(schema.metadataVolumeCovers).where(and(eq(schema.metadataVolumeCovers.operationId, operationId), or(eq(schema.metadataVolumeCovers.beforeAssetId, assetId), eq(schema.metadataVolumeCovers.afterAssetId, assetId)))).get();
  return !!volume;
}

/** Light authorization + existence check without loading/hashing a multi-MiB BLOB before upload. */
export function hasRetainedCoverAsset(seriesId: number, operationId: string, assetId: string): boolean {
  return authorizeRetainedCoverAsset(seriesId, operationId, assetId) && hasCoverAssetMetadata(assetId);
}

/** A content hash is not authority: the active operation must reference the image. */
export function retainedCoverAsset(seriesId: number, operationId: string, assetId: string): { data: Buffer; mediaType: string } | null {
  if (!authorizeRetainedCoverAsset(seriesId, operationId, assetId)) return null;
  return loadCoverAsset(assetId);
}

export function interruptCoverHistory(): void {
  const db = getDb(), message = 'Server stopped before cover readback; only retained observations are available';
  db.update(schema.metadataSeriesCovers).set({ status: 'interrupted', reservedBytes: 0, afterReason: message }).where(or(eq(schema.metadataSeriesCovers.status, 'preparing'), eq(schema.metadataSeriesCovers.status, 'prepared'), eq(schema.metadataSeriesCovers.status, 'applying'))).run();
  db.update(schema.metadataVolumeCovers).set({ status: 'interrupted', reservedBytes: 0, afterReason: message }).where(or(eq(schema.metadataVolumeCovers.status, 'preparing'), eq(schema.metadataVolumeCovers.status, 'prepared'), eq(schema.metadataVolumeCovers.status, 'applying'))).run();
}

export function pruneUnusedCoverAssets(): void {
  getDb().run(sql.raw(PRUNE_UNUSED_COVER_ASSETS_SQL));
}
