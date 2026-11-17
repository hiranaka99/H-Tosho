import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { KavitaVolumeCoverDto } from '../kavita/types.js';
import type { MetadataSnapshot } from '../contracts/metadataHistory.js';
import type { CoverTarget } from '../contracts/metadataCovers.js';
import { MAX_RETAINED_COVER_BYTES } from '../contracts/metadataCovers.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { coverMediaType, coverStorageBudget } from './metadataCovers.js';

export interface CoverEvidence {
  seriesId: number;
  libraryId: number;
  folderPath?: string | null;
  installationId?: string;
  token: string | null;
  volume?: { id: number; seriesId: number; createdUtc: string; membership: string };
}
export interface CoverObservation {
  state: 'captured' | 'absent';
  assetId: string | null;
  data: Buffer | null;
  mediaType: string | null;
  locked: boolean | null;
  nativeLockReason: string | null;
  name: string;
  evidence: CoverEvidence;
}

export function coverTargetKey(target: CoverTarget): string {
  return target.kind === 'series' ? 'series' : `volume:${target.volumeId}`;
}

function volumeMembership(volume: KavitaVolumeCoverDto): string {
  if (!Array.isArray(volume.chapters) || volume.chapters.length > 2000) throw new Error('Volume chapter membership is unavailable or exceeds the cover identity limit');
  const references: string[] = [];
  for (const chapter of volume.chapters) {
    if (!Number.isSafeInteger(chapter.id) || chapter.id <= 0 || !Array.isArray(chapter.files)) throw new Error('Volume chapter identity is unavailable');
    references.push(`chapter:${chapter.id}`);
    for (const file of chapter.files) {
      if (references.length >= 10000) throw new Error('Volume file membership exceeds the cover identity limit');
      if (typeof file.filePath !== 'string' || !file.filePath) throw new Error('Volume file identity is unavailable');
      references.push(`file:${chapter.id}:${file.id ?? ''}:${file.filePath}`);
    }
  }
  references.sort();
  return createHash('sha256').update(JSON.stringify(references)).digest('hex');
}

export async function observeCover(client: KavitaClient, seriesId: number, target: CoverTarget, expected: MetadataSnapshot, connectionKey: string): Promise<CoverObservation> {
  const activeConnection = () => kavitaConnectionKey(getKavitaConnection().baseUrl);
  if (activeConnection() !== connectionKey) throw new Error('Kavita connection changed during cover observation');
  const series = await client.getSeriesDto(seriesId);
  if (series.id !== seriesId || series.libraryId !== expected.series.libraryId ||
    (Object.hasOwn(expected.series, 'folderPath') && series.folderPath !== expected.series.folderPath)) throw new Error('Series identity changed during cover observation');
  const info = typeof client.getServerInfo === 'function' ? await client.getServerInfo() : undefined;
  if (expected.installationId !== undefined && info?.installId !== expected.installationId) throw new Error('Kavita installation changed during cover observation');
  const volume = target.kind === 'volume' ? await client.getVolumeForCoverHistory(target.volumeId) : null;
  if (target.kind === 'volume' && volume && (volume.id !== target.volumeId || volume.seriesId !== seriesId || !Number.isFinite(Date.parse(volume.createdUtc)))) throw new Error('Volume identity no longer belongs to this series');
  const token = volume ? volume.coverImage : series.coverImage;
  if (token !== null && typeof token !== 'string') throw new Error('Kavita did not return the cover image identity');
  const rawLock = volume ? volume.coverImageLocked : series.coverImageLocked;
  if (rawLock !== undefined && typeof rawLock !== 'boolean') throw new Error('Kavita returned an invalid native cover lock');
  if (!volume && typeof rawLock !== 'boolean') throw new Error('Kavita did not return the original series-cover lock');
  const locked = typeof rawLock === 'boolean' ? rawLock : null;
  const nativeLockReason = locked === null ? 'This Kavita release does not expose the current volume-cover lock. Its value was not inferred.' : null;
  const image = volume ? await client.getVolumeCoverForHistory(volume.id) : await client.getSeriesCoverForHistory(seriesId);
  if (!image && token !== null && token !== '') throw new Error('Cover image is unreadable; a failed image read is not an absent cover');
  const evidence: CoverEvidence = { seriesId, libraryId: series.libraryId, token,
    ...(Object.hasOwn(series, 'folderPath') ? { folderPath: series.folderPath } : {}),
    ...(info?.installId ? { installationId: info.installId } : {}),
    ...(volume ? { volume: { id: volume.id, seriesId: volume.seriesId, createdUtc: volume.createdUtc, membership: volumeMembership(volume) } } : {}) };
  const afterSeries = await client.getSeriesDto(seriesId);
  const afterVolume = volume ? await client.getVolumeForCoverHistory(volume.id) : null;
  if (activeConnection() !== connectionKey || afterSeries.id !== series.id || afterSeries.libraryId !== series.libraryId || afterSeries.folderPath !== series.folderPath ||
    (afterVolume ? afterVolume.coverImage !== token || afterVolume.coverImageLocked !== rawLock || afterVolume.createdUtc !== volume!.createdUtc || afterVolume.seriesId !== seriesId || volumeMembership(afterVolume) !== evidence.volume!.membership
      : afterSeries.coverImage !== token || afterSeries.coverImageLocked !== rawLock)) throw new Error('Cover or indexed identity changed while it was being observed');
  return { state: image ? 'captured' : 'absent', assetId: image ? createHash('sha256').update(image.data).digest('hex') : null,
    data: image?.data ?? null, mediaType: image ? coverMediaType(image.data) : null, locked, nativeLockReason,
    name: volume ? volume.name?.trim() || `Volume #${volume.id}` : 'Series cover', evidence };
}

export function sameCoverObservation(expected: Omit<CoverObservation, 'data'>, current: CoverObservation): boolean {
  return expected.state === current.state && expected.assetId === current.assetId && expected.locked === current.locked &&
    JSON.stringify(expected.evidence) === JSON.stringify(current.evidence);
}

export function retainCoverObservation(value: CoverObservation): void {
  if (!value.assetId || !value.data || !value.mediaType) return;
  const db = getDb();
  const existing = db.select().from(schema.metadataAssets).where(eq(schema.metadataAssets.id, value.assetId)).get();
  if (existing) {
    if (existing.byteSize !== value.data.length || existing.data.length !== existing.byteSize || createHash('sha256').update(existing.data).digest('hex') !== value.assetId) throw new Error('An existing retained image asset failed integrity checks; the cover write was not started');
    return;
  }
  const used = db.select({ bytes: sql<number>`coalesce(sum(${schema.metadataAssets.byteSize}), 0)` }).from(schema.metadataAssets).get()!.bytes;
  const seriesReserved = db.select({ bytes: sql<number>`coalesce(sum(${schema.metadataSeriesCovers.reservedBytes}), 0)` }).from(schema.metadataSeriesCovers).get()!.bytes;
  const volumeReserved = db.select({ bytes: sql<number>`coalesce(sum(${schema.metadataVolumeCovers.reservedBytes}), 0)` }).from(schema.metadataVolumeCovers).get()!.bytes;
  if (used + seriesReserved + volumeReserved + value.data.length > coverStorageBudget()) throw new Error('Retained cover storage reached its configured budget; no retained history was evicted. Increase the cover-history budget before retrying');
  db.insert(schema.metadataAssets).values({ id: value.assetId, mediaType: value.mediaType, byteSize: value.data.length, data: value.data }).run();
}

export function coverReadbackReservationFits(): boolean {
  const db = getDb();
  const used = db.select({ bytes: sql<number>`coalesce(sum(${schema.metadataAssets.byteSize}), 0)` }).from(schema.metadataAssets).get()!.bytes;
  const series = db.select({ bytes: sql<number>`coalesce(sum(${schema.metadataSeriesCovers.reservedBytes}), 0)` }).from(schema.metadataSeriesCovers).get()!.bytes;
  const volumes = db.select({ bytes: sql<number>`coalesce(sum(${schema.metadataVolumeCovers.reservedBytes}), 0)` }).from(schema.metadataVolumeCovers).get()!.bytes;
  return used + series + volumes <= coverStorageBudget();
}

export function loadCoverAsset(assetId: string): { data: Buffer; mediaType: string } | null {
  if (!/^[a-f0-9]{64}$/.test(assetId)) return null;
  const asset = getDb().select().from(schema.metadataAssets).where(eq(schema.metadataAssets.id, assetId)).get();
  if (!asset || !asset.data.length || asset.data.length > MAX_RETAINED_COVER_BYTES || asset.data.length !== asset.byteSize || createHash('sha256').update(asset.data).digest('hex') !== assetId) return null;
  try { if (coverMediaType(asset.data) !== asset.mediaType) return null; } catch { return null; }
  return { data: asset.data, mediaType: asset.mediaType };
}
