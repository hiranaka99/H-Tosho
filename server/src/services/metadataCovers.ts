import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { MetadataSnapshot } from '../contracts/metadataHistory.js';
import { MAX_RETAINED_COVER_BYTES, MAX_RETAINED_COVER_STORE_BYTES,
  type RecordedCover, type CoverHistory, type CoverCheckpoint, type CoverTarget } from '../contracts/metadataCovers.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { observeCover, retainCoverObservation, sameCoverObservation, coverReadbackReservationFits, coverTargetKey, loadCoverAsset,
  type CoverObservation } from './coverObservations.js';
import { PRUNE_UNUSED_COVER_ASSETS_SQL } from '../db/metadataRetention.js';

const connection=()=>kavitaConnectionKey(getKavitaConnection().baseUrl);
export function coverStorageBudget(value:string|undefined=process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB):number {
  if(value===undefined)return MAX_RETAINED_COVER_STORE_BYTES;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<10||Number(value)>16_384) {
    throw new Error('Cover-history storage limit must be an integer from 10 through 16384 MiB; the cover write was not started');
  }
  return Number(value)*1024*1024;
}
export type CoverCheckpointRow = typeof schema.metadataSeriesCovers.$inferSelect | typeof schema.metadataVolumeCovers.$inferSelect;
type CoverPatch = Partial<Omit<typeof schema.metadataSeriesCovers.$inferInsert, 'operationId'>>;
export interface CoverJournalResult { problems: string[]; warnings: string[]; changed: boolean; unverifiedNativeLocks: number }
export interface CoverJournal {
  capture(target?: CoverTarget): Promise<void>;
  beginWrite(target: CoverTarget, lock: boolean, assetId?: string): void;
  acknowledge(target: CoverTarget): void;
  finish(): Promise<CoverJournalResult>;
}

/** Validate raster signatures, never accepting SVG/HTML under an image media type. Bytes remain unmodified. */
export function coverMediaType(data:Buffer):string {
  if(!data.length || data.length>MAX_RETAINED_COVER_BYTES)throw new Error('Cover history requires an image between 1 byte and 5 MiB');
  if(data.length>=33 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii',12,16)==='IHDR'
    && data.toString('ascii',data.length-8,data.length-4)==='IEND')return 'image/png';
  if(data.length>=4 && data[0]===255 && data[1]===216 && data[data.length-2]===255 && data[data.length-1]===217)return 'image/jpeg';
  if(data.length>=20 && data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP' && data.readUInt32LE(4)+8===data.length)return 'image/webp';
  if(data.length>=14 && ['GIF87a','GIF89a'].includes(data.toString('ascii',0,6)) && data[data.length-1]===0x3b)return 'image/gif';
  if(data.length>=16 && data.toString('ascii',4,8)==='ftyp' && data.readUInt32BE(0)<=data.length
    && /avif|avis/.test(data.toString('ascii',8,Math.min(data.readUInt32BE(0),128))))return 'image/avif';
  throw new Error('Cover response is not a supported complete PNG, JPEG, WebP, GIF or AVIF raster image');
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
    async capture(target: CoverTarget = { kind: 'series' }): Promise<void> {
      if (target.kind === 'volume' && (!Number.isSafeInteger(target.volumeId) || target.volumeId <= 0)) throw new Error('Invalid volume-cover target');
      const targetKey = coverTargetKey(target), previous = saved.get(targetKey);
      ensureCheckpoint(operationId, target);
      if (process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB === undefined && !previous) {
        updateCheckpoint(operationId, target, { status: 'not-captured', beforeReason: 'Cover capture was disabled; configure its storage budget to retain images', afterReason: 'No after image was retained because cover capture was disabled' });
        return;
      }
      if (previous) {
        const current = await observeCover(client, seriesId, target, expected, key);
        if (!sameCoverObservation(previous.observation, current)) throw new Error('Cover, native lock or indexed identity changed after preparation; review required');
        updateCheckpoint(operationId, target, { status: 'applying' });
        return;
      }
      try {
        const value = await observeCover(client, seriesId, target, expected, key);
        db.transaction(() => {
          updateCheckpoint(operationId, target, { reservedBytes: MAX_RETAINED_COVER_BYTES });
          retainCoverObservation(value);
          if (!coverReadbackReservationFits()) throw new Error('Insufficient cover-history storage for guaranteed readback; increase its budget before writing');
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
      for (const [targetKey, previous] of saved) {
        try {
          const value = await observeCover(client, seriesId, previous.target, { ...expected, ...(previous.observation.evidence.installationId ? { installationId: previous.observation.evidence.installationId } : {}) }, key);
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
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Could not retain verified cover readback';
          updateCheckpoint(operationId, previous.target, { status: 'unverified', afterReason: message, reservedBytes: 0 });
          result.problems.push(`${previous.observation.name}: ${message}`);
        }
      }
      return result;
    },
  };
}

type AssetMeta = { id: string; mediaType: string; byteSize: number };

export function recordedCover(row: CoverCheckpointRow, side: 'before' | 'after', assetsById?: Map<string, AssetMeta>): RecordedCover {
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

function checkpointHistory(row: CoverCheckpointRow, target: CoverTarget, running: boolean, assetsById?: Map<string, AssetMeta>): CoverCheckpoint {
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
  const seriesRows = db.select().from(schema.metadataSeriesCovers).where(inArray(schema.metadataSeriesCovers.operationId, ids)).all();
  const volumeRows = db.select().from(schema.metadataVolumeCovers).where(inArray(schema.metadataVolumeCovers.operationId, ids)).all();
  const assetIds = new Set<string>();
  const seriesByOp = new Map<string, typeof schema.metadataSeriesCovers.$inferSelect>();
  for (const row of seriesRows) {
    seriesByOp.set(row.operationId, row);
    if (row.beforeAssetId) assetIds.add(row.beforeAssetId);
    if (row.afterAssetId) assetIds.add(row.afterAssetId);
  }
  const volumesByOp = new Map<string, (typeof schema.metadataVolumeCovers.$inferSelect)[]>();
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

/** A content hash is not authority: the active operation must reference the image. */
export function retainedCoverAsset(seriesId: number, operationId: string, assetId: string): { data: Buffer; mediaType: string } | null {
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) return null;
  const db = getDb();
  if (!db.select({ id: schema.metadataOperations.id }).from(schema.metadataOperations).where(and(eq(schema.metadataOperations.connectionKey, connection()), eq(schema.metadataOperations.seriesId, seriesId), eq(schema.metadataOperations.id, operationId))).get()) return null;
  const series = getCoverCheckpoint(operationId, { kind: 'series' });
  const volume = db.select({ id: schema.metadataVolumeCovers.id }).from(schema.metadataVolumeCovers).where(and(eq(schema.metadataVolumeCovers.operationId, operationId), or(eq(schema.metadataVolumeCovers.beforeAssetId, assetId), eq(schema.metadataVolumeCovers.afterAssetId, assetId)))).get();
  if (!(series && (series.beforeAssetId === assetId || series.afterAssetId === assetId)) && !volume) return null;
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
