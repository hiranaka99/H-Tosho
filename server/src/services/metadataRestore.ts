import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { MetadataSnapshot } from '../contracts/metadataHistory.js';
import {
  RESTORABLE_METADATA_FIELDS, getMetadataRestoreFieldAvailability, isRestorableMetadataField, metadataValueKey, titleRestoreCapability,
  type ExactMetadataRestoreValues, type MetadataRestorePreview, type MetadataRestoreResult, type RestoreMetadataCommand,
  type RestorePreviewRequest, type RestorableMetadataField,
} from '../contracts/metadataRestore.js';
import { captureMetadataSnapshot } from './metadataHistory.js';
import { getFieldPolicy } from './fieldPolicies.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { RESTORABLE_COMICINFO_FIELDS } from '../lib/comicInfoRestore.js';
import { libraryMutations, archiveMutations, archiveResource } from '../lib/mutations.js';
import { captureArchiveSnapshot, restoreComicInfoArchive, verifyArchiveSnapshot, type ArchiveSnapshot } from '../lib/cbz.js';
import { prepareArchiveRestores, recheckArchiveRestores, archiveProtectedFields, type ApprovedArchiveRestore, type PreparedArchiveRestores } from './metadataArchiveRestore.js';
import { prepareCoverRestores, recheckCoverRestores, parseApprovedCoverRestores, type PreparedCoverRestores } from './metadataCoverRestore.js';
import { coverJournal, retainedCoverAsset, pruneUnusedCoverAssets, type CoverJournal, type CoverJournalResult } from './metadataCovers.js';
import { recoverMergeProtectionForSeriesOwned } from './mergeProtection.js';
import { retainCoverObservation, coverTargetKey } from './coverObservations.js';

const PREVIEW_LIFETIME_MS = 15 * 60_000;
const connection = () => kavitaConnectionKey(getKavitaConnection().baseUrl);
const now = () => new Date().toISOString();
const activeStatuses = ['approved', 'running'];

export class MetadataRestoreError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) { super(message); this.name = 'MetadataRestoreError'; }
}
function conflict(message: string): never { throw new MetadataRestoreError(`${message}; review required`, 409); }
function validSeriesId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new MetadataRestoreError('Invalid series id', 400);
}
function validKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new MetadataRestoreError(`Invalid ${label}`, 400);
}
function validateRequest(request: RestorePreviewRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['snapshot', 'fields', 'nativeLockFields', 'archives', 'covers'].includes(key))
    || !['before', 'after'].includes(request.snapshot)
    || !Array.isArray(request.fields) || (request.fields.length < 1 && !request.archives?.length && !request.covers?.length) || request.fields.length > RESTORABLE_METADATA_FIELDS.length
    || request.fields.some(field => !isRestorableMetadataField(field)) || new Set(request.fields).size !== request.fields.length
    || (request.nativeLockFields !== undefined && (!Array.isArray(request.nativeLockFields)
      || request.nativeLockFields.length > request.fields.length
      || request.nativeLockFields.some(field => !isRestorableMetadataField(field) || !request.fields.includes(field))
      || new Set(request.nativeLockFields).size !== request.nativeLockFields.length))
    || (request.archives !== undefined && (!Array.isArray(request.archives) || request.archives.length > 2000
      || new Set(request.archives.map(item => item?.id)).size !== request.archives.length
      || request.archives.some(item => !item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => !['id','mode','fields'].includes(key))
        || !Number.isSafeInteger(item.id) || item.id <= 0 || !['fields','document'].includes(item.mode)
        || (item.mode === 'document' ? item.fields !== undefined : !Array.isArray(item.fields) || !item.fields.length
          || item.fields.length > RESTORABLE_COMICINFO_FIELDS.length || new Set(item.fields).size !== item.fields.length
          || item.fields.some(field => !RESTORABLE_COMICINFO_FIELDS.includes(field as typeof RESTORABLE_COMICINFO_FIELDS[number]))))))) {
    throw new MetadataRestoreError('Invalid restore preview request', 400);
  }
  if (request.covers !== undefined && (!Array.isArray(request.covers) || request.covers.length > 2000
    || new Set(request.covers.map(item => `${item?.kind}:${item?.volumeId ?? ''}`)).size !== request.covers.length
    || request.covers.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['kind', 'volumeId', 'nativeLock'].includes(key))
      || (item.kind !== 'series' && item.kind !== 'volume')
      || (item.kind === 'series' ? item.volumeId !== undefined : !Number.isSafeInteger(item.volumeId) || Number(item.volumeId) <= 0)
      || (item.nativeLock !== undefined && !['preserve', 'saved', 'locked', 'unlocked'].includes(item.nativeLock))))) throw new MetadataRestoreError('Invalid cover restore selection', 400);
}
async function capture(client: KavitaClient, seriesId: number): Promise<MetadataSnapshot> {
  const snapshot = await captureMetadataSnapshot(client, seriesId, true);
  // H1 test clients and older integrations may lack server-info; captured evidence is mandatory on recheck.
  if (typeof client.getServerInfo === 'function') {
    const info = await client.getServerInfo();
    if (typeof info.installId === 'string' && info.installId.length) snapshot.installationId = info.installId;
  }
  return snapshot;
}
function sameIdentity(expected: MetadataSnapshot, current: MetadataSnapshot, compareName = true): boolean {
  return expected.series.id === current.series.id && expected.series.libraryId === current.series.libraryId
    && (!compareName || expected.series.name === current.series.name)
    && (!Object.hasOwn(expected.series, 'folderPath') || expected.series.folderPath === current.series.folderPath)
    && (expected.installationId === undefined || expected.installationId === current.installationId);
}
function expirePreviews(): void {
  // Approval copies all authority into its pinned plan; consumed previews may expire too.
  const deleted = getDb().delete(schema.metadataRestorePreviews).where(lte(schema.metadataRestorePreviews.expiresAt, now())).run();
  if (deleted.changes > 0) pruneUnusedCoverAssets();
}

export async function createMetadataRestorePreview(client: KavitaClient, seriesId: number, operationId: string,
  request: RestorePreviewRequest): Promise<MetadataRestorePreview> {
  validSeriesId(seriesId); validKey(operationId, 'operation id'); validateRequest(request);
  const key = connection();
  if (!key) throw new MetadataRestoreError('Kavita not configured', 409);
  expirePreviews();
  const source = getDb().select().from(schema.metadataOperations).where(and(
    eq(schema.metadataOperations.id, operationId), eq(schema.metadataOperations.seriesId, seriesId),
    eq(schema.metadataOperations.connectionKey, key),
  )).get();
  if (!source) throw new MetadataRestoreError('Metadata operation not found', 404);
  const nonMetadataOnly = request.fields.length === 0 && (!!request.archives?.length || !!request.covers?.length);
  const selectedJson = request.snapshot === 'before' ? source.beforeJson : source.afterJson ?? (nonMetadataOnly?source.beforeJson:null);
  if (!selectedJson) throw new MetadataRestoreError('Requested snapshot was not captured', 409);
  if (source.status === 'running') conflict('Source operation is still running');
  if (request.snapshot === 'after' && source.status === 'unverified' && !nonMetadataOnly) {
    throw new MetadataRestoreError('After metadata verification is unavailable; select verified archive steps separately or use Before',409);
  }
  const selected = JSON.parse(selectedJson) as MetadataSnapshot;
  const historicalAfter = source.afterJson && source.status !== 'unverified' ? JSON.parse(source.afterJson) as MetadataSnapshot : null;
  let current: MetadataSnapshot;
  await libraryMutations.run([`series:${seriesId}`], () => recoverMergeProtectionForSeriesOwned(client, seriesId));
  try { current = await capture(client, seriesId); }
  catch { throw new MetadataRestoreError('Could not read current Kavita metadata and identity', 502); }
  if (connection() !== key) conflict('Kavita connection changed during preview');
  const policy = getFieldPolicy(seriesId);
  const conflicts: string[] = [];
  if (!sameIdentity(selected, current, false)) conflicts.push('Series or installation identity changed; review required');
  const desired: ExactMetadataRestoreValues = {};
  const fields = request.fields.map(field => {
    const target = selected.fields[field];
    const available = getMetadataRestoreFieldAvailability(field, target);
    const currentAvailability = getMetadataRestoreFieldAvailability(field, current.fields[field]);
    const currentPresent = current.fields[field]?.present === true;
    const titleCapability = field==='title'?titleRestoreCapability(current.titleContext):null;
    const currentSupported = currentPresent && (field !== 'title' || (currentAvailability.nativeLockAvailable && titleCapability===null));
    const protectedField = policy.lockedFields.includes(field);
    const reason = protectedField ? 'Protected by H-Tosho field policy' : available.reason
      ?? titleCapability ?? (!currentSupported ? 'Current field or required native name lock was not returned by Kavita; capability cannot be verified' : null)
      ?? (source.status === 'unverified' ? 'Later-edit baseline is unverified; review the current values explicitly' : null);
    const usable = !protectedField && available.available && currentSupported;
    if (usable) desired[field] = target;
    if (usable && request.nativeLockFields?.includes(field)
      && (!available.nativeLockAvailable || !currentAvailability.nativeLockAvailable)) {
      conflicts.push(`Native lock for ${field} was not captured or is unsupported; review required`);
    }
    return {field, current:current.fields[field] ?? {present:false}, restoreTo:target ?? {present:false},
      protected:protectedField, available:usable, reason,
      laterEdit:historicalAfter !== null && metadataValueKey(current.fields[field]) !== metadataValueKey(historicalAfter.fields[field])};
  });
  const effectiveFields = request.fields.filter(field => Object.hasOwn(desired, field));
  const nativeLockFields = (request.nativeLockFields ?? []).filter(field => effectiveFields.includes(field));
  let archives: PreparedArchiveRestores = {approved:[],previews:[]};
  try {
    archives = await prepareArchiveRestores(client,current,operationId,request.snapshot,request.archives ?? [],
      effectiveFields.includes('title') ? desired.title!.value as string : undefined,policy.lockedFields);
    for (const archive of archives.previews) if (!archive.available) conflicts.push(`${archive.target}: ${archive.reason}`);
  } catch (error) { conflicts.push(error instanceof Error ? error.message : 'Could not verify current archive identity'); }
  const createdAt = now();
  const preview: MetadataRestorePreview = {
    id: randomUUID(), operationId, seriesId, snapshot: request.snapshot,
    expiresAt: new Date(Date.now() + PREVIEW_LIFETIME_MS).toISOString(), policyRevision: policy.revision,
    requestedFields: [...request.fields], effectiveFields, nativeLockFields, fields, conflicts,
    archives: archives.previews, covers: [], canRestore: false,
  };
  // A preparing preview cannot be approved; it atomically pins each inspected current image.
  const db = getDb();
  db.insert(schema.metadataRestorePreviews).values({ id: preview.id, connectionKey: key, seriesId, sourceOperationId: operationId,
    previewJson: JSON.stringify(preview), expectedJson: JSON.stringify(current), desiredJson: JSON.stringify(desired),
    archivesJson: JSON.stringify(archives.approved), coversJson: '[]', createdAt, expiresAt: preview.expiresAt }).run();
  let covers: PreparedCoverRestores = { approved: [], previews: [] };
  try {
    covers = await prepareCoverRestores(client, current, selected, operationId, request.snapshot, request.covers ?? [], policy.lockedFields, (cover, observed) => {
      preview.covers!.push(cover);
      db.transaction(() => {
        db.update(schema.metadataRestorePreviews).set({ previewJson: JSON.stringify(preview) }).where(eq(schema.metadataRestorePreviews.id, preview.id)).run();
        retainCoverObservation(observed);
      });
    });
    for (const cover of covers.previews) if (!cover.available) conflicts.push(`${cover.name}: ${cover.reason}`);
  } catch (error) { conflicts.push(error instanceof Error ? error.message : 'Could not verify current cover identity'); }
  if (connection() !== key) conflict('Kavita connection changed during preview');
  preview.covers = covers.previews;
  preview.canRestore = (effectiveFields.length > 0 || archives.approved.length > 0 || covers.approved.length > 0) && conflicts.length === 0;
  db.update(schema.metadataRestorePreviews).set({ previewJson: JSON.stringify(preview), coversJson: JSON.stringify(covers.approved) }).where(eq(schema.metadataRestorePreviews.id, preview.id)).run();
  return preview;
}

/** The callback inserts the queue job on the same connection, and must not start execution synchronously. */
export function enqueueMetadataRestore(seriesId: number, previewId: string, idempotencyKey: string,
  enqueue: (command: RestoreMetadataCommand) => number, acceptCoverConversion = false): {id: number} {
  validSeriesId(seriesId); validKey(previewId, 'preview id'); validKey(idempotencyKey, 'idempotency key');
  const key = connection();
  if (!key) throw new MetadataRestoreError('Kavita not configured', 409);
  return getDb().transaction(tx => {
    const existing = tx.select().from(schema.metadataRestorePlans).where(and(
      eq(schema.metadataRestorePlans.connectionKey,key),eq(schema.metadataRestorePlans.idempotencyKey,idempotencyKey),
    )).get();
    if (existing) {
      if (existing.seriesId !== seriesId || existing.previewId !== previewId) conflict('Idempotency key already approves a different preview');
      if (existing.jobId === null) conflict('Approved restore has no linked job');
      return {id:existing.jobId};
    }
    const row = tx.select().from(schema.metadataRestorePreviews).where(and(eq(schema.metadataRestorePreviews.id,previewId),
      eq(schema.metadataRestorePreviews.seriesId,seriesId),eq(schema.metadataRestorePreviews.connectionKey,key))).get();
    if (!row) throw new MetadataRestoreError('Restore preview not found or expired',404);
    if (row.consumedAt) conflict('Restore preview has already been approved');
    if (Date.parse(row.expiresAt) <= Date.now()) conflict('Restore preview expired; create a new preview');
    const preview = JSON.parse(row.previewJson) as MetadataRestorePreview;
    const archives = JSON.parse(row.archivesJson) as ApprovedArchiveRestore[];
    const covers = parseApprovedCoverRestores(row.coversJson);
    if (covers.length && !acceptCoverConversion) throw new MetadataRestoreError('Explicit review of cover resize/re-encoding is required before approval', 400);
    if (!preview.canRestore || (!preview.effectiveFields.length && !archives.length && !covers.length)) conflict('Restore preview has unavailable fields or conflicts');
    const policy = getFieldPolicy(seriesId);
    if (policy.revision !== preview.policyRevision || [...preview.effectiveFields,...archiveProtectedFields(archives),...(covers.length?['cover']:[])].some(field => policy.lockedFields.some(locked => locked === field))) {
      conflict('Protection settings changed after preview');
    }
    const planId = randomUUID(), createdAt = now();
    tx.insert(schema.metadataRestorePlans).values({id:planId,previewId,connectionKey:key,seriesId,
      sourceOperationId:row.sourceOperationId,idempotencyKey,expectedJson:row.expectedJson,desiredJson:row.desiredJson,
      archivesJson:row.archivesJson,coversJson:row.coversJson,
      nativeLockFieldsJson:JSON.stringify(preview.nativeLockFields),policyRevision:preview.policyRevision,createdAt}).run();
    const id = enqueue({seriesId,connectionKey:key,planId});
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Restore queue returned an invalid job id');
    tx.update(schema.metadataRestorePlans).set({jobId:id}).where(eq(schema.metadataRestorePlans.id,planId)).run();
    tx.update(schema.metadataRestorePreviews).set({consumedAt:createdAt}).where(eq(schema.metadataRestorePreviews.id,previewId)).run();
    return {id};
  });
}

/** The caller owns the parent series boundary; hold affected archives through recheck, writes and readback. */
export async function executeMetadataRestore(client: KavitaClient, command: RestoreMetadataCommand, jobId: number,
  checkCancelled: () => void): Promise<MetadataRestoreResult> {
  const plan = getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,command.planId)).get();
  const archives = plan ? JSON.parse(plan.archivesJson) as ApprovedArchiveRestore[] : [];
  const execute = () => executeApprovedMetadataRestore(client,command,jobId,checkCancelled, plan ? { plan, archives } : undefined);
  return archives.length ? archiveMutations.run(archives.map(item => archiveResource(item.target)),execute) : execute();
}

async function executeApprovedMetadataRestore(client: KavitaClient, command: RestoreMetadataCommand, jobId: number,
  checkCancelled: () => void, preloaded?: { plan: typeof schema.metadataRestorePlans.$inferSelect; archives: ApprovedArchiveRestore[] }): Promise<MetadataRestoreResult> {
  validSeriesId(command.seriesId); validKey(command.planId, 'plan id');
  const db = getDb();
  const plan = preloaded?.plan ?? db.select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,command.planId)).get();
  if (!plan || plan.seriesId !== command.seriesId || plan.connectionKey !== command.connectionKey || plan.jobId !== jobId) {
    conflict('Restore command does not match its approved job');
  }
  if (plan.status !== 'approved') conflict('Restore plan has already started or was finalized');
  const claimed = db.update(schema.metadataRestorePlans).set({status:'running'}).where(and(
    eq(schema.metadataRestorePlans.id,plan.id),eq(schema.metadataRestorePlans.status,'approved'))).run();
  if (claimed.changes !== 1) conflict('Restore plan was consumed by another execution');
  const expected = JSON.parse(plan.expectedJson) as MetadataSnapshot;
  const desired = JSON.parse(plan.desiredJson) as ExactMetadataRestoreValues;
  const fields = Object.keys(desired) as RestorableMetadataField[];
  const nativeLockFields = JSON.parse(plan.nativeLockFieldsJson) as RestorableMetadataField[];
  const archives = preloaded?.archives ?? JSON.parse(plan.archivesJson) as ApprovedArchiveRestore[];
  const covers = parseApprovedCoverRestores(plan.coversJson);
  const operationId = randomUUID();
  let before: MetadataSnapshot | null = null, after: MetadataSnapshot | null = null;
  let failure: unknown, failed = false, startedWrite = false, journaled = false;
  const problems: string[] = [];
  const warnings: string[] = [];
  let coverCapture: CoverJournal | undefined;
  /** Snapshots restoreComicInfoArchive verified; final readback reuses one while the file is still byte-identical. */
  const restoredSnapshots = new Map<string, ArchiveSnapshot>();
  let coverResult: CoverJournalResult = { problems: [], warnings: [], changed: false, unverifiedNativeLocks: 0 };
  try {
    checkCancelled();
    if (connection() !== plan.connectionKey) conflict('Kavita connection changed after preview');
    await recoverMergeProtectionForSeriesOwned(client, command.seriesId);
    before = await capture(client,command.seriesId);
    if (connection() !== plan.connectionKey) conflict('Kavita connection changed after preview');
    db.transaction(tx => {
      tx.insert(schema.metadataOperations).values({id:operationId,connectionKey:plan.connectionKey,seriesId:plan.seriesId,
        jobId,origin:'metadata-restore',restoredFromOperationId:plan.sourceOperationId,
        fieldsJson:JSON.stringify([...fields,...(archives.length?['archives']:[]),...(covers.length?['cover']:[])]),desiredJson:plan.desiredJson,policyRevision:plan.policyRevision,
        beforeJson:JSON.stringify(before),createdAt:now(),version:4}).run();
      tx.update(schema.metadataRestorePlans).set({operationId}).where(eq(schema.metadataRestorePlans.id,plan.id)).run();
    });
    journaled = true;
    if (!sameIdentity(expected,before)) conflict('Series or installation identity changed after preview');
    const policy = getFieldPolicy(plan.seriesId);
    if (policy.revision !== plan.policyRevision || [...fields,...archiveProtectedFields(archives),...(covers.length?['cover']:[])].some(field => policy.lockedFields.some(locked => locked===field))) conflict('Protection settings changed after preview');
    if ((!fields.length && !archives.length && !covers.length) || fields.some(field => !isRestorableMetadataField(field)
      || !getMetadataRestoreFieldAvailability(field,desired[field]).available)
      || nativeLockFields.some(field => !fields.includes(field) || !getMetadataRestoreFieldAvailability(field,desired[field]).nativeLockAvailable)) {
      conflict('Approved restore values are unavailable');
    }
    const changed = fields.filter(field => metadataValueKey(expected.fields[field]) !== metadataValueKey(before!.fields[field]));
    if (changed.length) conflict(`Selected metadata or native locks changed after preview: ${changed.join(', ')}`);
    if(fields.includes('title') && titleRestoreCapability(before.titleContext)) conflict(titleRestoreCapability(before.titleContext)!);
    await recheckArchiveRestores(client,before,archives,fields.includes('title'));
    const preObservedCovers = await recheckCoverRestores(client, before, covers, plan.sourceOperationId);
    if (covers.length) {
      coverCapture = coverJournal(client, operationId, plan.seriesId, before, plan.connectionKey);
      for (const cover of covers) {
        checkCancelled();
        await coverCapture.capture(cover.target, { preObserved: preObservedCovers.get(coverTargetKey(cover.target)) });
      }
    }
    db.transaction(tx => {
      for (const archive of archives) tx.insert(schema.metadataOperationSteps).values({operationId,target:archive.target,beforeJson:JSON.stringify(archive.expected)}).run();
    });
    checkCancelled();
    startedWrite = true;
    for (const archive of archives) {
      // Once a paired title starts, finish its remote checkpoint before honoring cancellation.
      if (!fields.includes('title')) checkCancelled();
      db.update(schema.metadataOperationSteps).set({status:'applying'}).where(and(eq(schema.metadataOperationSteps.operationId,operationId),eq(schema.metadataOperationSteps.target,archive.target))).run();
      const observed = await restoreComicInfoArchive(archive.target,archive.desiredXml,archive.expected);
      restoredSnapshots.set(archive.target,observed);
      db.update(schema.metadataOperationSteps).set({afterJson:JSON.stringify(observed),status:'observed'}).where(and(eq(schema.metadataOperationSteps.operationId,operationId),eq(schema.metadataOperationSteps.target,archive.target))).run();
    }
    if (fields.length) await client.restoreSeriesMetadataExact(plan.seriesId,desired,{expected,nativeLockFields,
      checkCancelled:fields.includes('title')?undefined:checkCancelled});
    for (const [index, cover] of covers.entries()) {
      checkCancelled();
      await coverCapture!.capture(cover.target, { skipVerify: archives.length === 0 && fields.length === 0 && index === 0 });
      const asset = retainedCoverAsset(plan.seriesId, cover.sourceOperationId, cover.sourceAssetId);
      if (!asset) conflict('Retained image became unavailable before upload');
      coverCapture!.beginWrite(cover.target, cover.requestedLock, cover.sourceAssetId);
      if (cover.target.kind === 'series') await client.updateSeriesCover(plan.seriesId, asset.data, cover.requestedLock);
      else await client.updateVolumeCover(cover.target.volumeId, asset.data, cover.requestedLock);
      coverCapture!.acknowledge(cover.target);
    }
    checkCancelled();
  } catch (error) { failure = error; failed = true; }
  if (coverCapture) {
    coverResult = await coverCapture.finish();
    problems.push(...coverResult.problems);
    warnings.push(...coverResult.warnings);
  }
  if (journaled) {
    try {
      if (connection() !== plan.connectionKey) throw new Error('Connection changed');
      after = await captureMetadataSnapshot(client,plan.seriesId,true);
      if (typeof client.getServerInfo === 'function') {
        try {
          const info = await client.getServerInfo();
          if (typeof info.installId === 'string' && info.installId.length) after.installationId = info.installId;
        } catch { problems.push('Could not verify Kavita installation identity after restore'); }
      }
      const finalIdentity = fields.includes('title') ? {...expected,series:{...expected.series,name:desired.title!.value as string}} : expected;
      if (connection() !== plan.connectionKey || !sameIdentity(finalIdentity,after)) problems.push('Identity changed during restore; observed values require review');
    } catch { problems.push('Could not verify current metadata after restore'); }
    if (after && before) {
      const unverified = fields.filter(field => metadataValueKey(after!.fields[field],false) !== metadataValueKey(desired[field],false)
        || after!.fields[field]?.nativeLocked !== (nativeLockFields.includes(field) ? desired[field]?.nativeLocked : before!.fields[field]?.nativeLocked));
      if (unverified.length && startedWrite) problems.push(`Exact values or final native locks were not confirmed: ${unverified.join(', ')}`);
      const changedUnselected = Object.keys(before.fields).filter(field => !fields.includes(field as RestorableMetadataField)
        && metadataValueKey(before!.fields[field]) !== metadataValueKey(after!.fields[field]));
      if (changedUnselected.length && startedWrite) problems.push(`Unselected metadata changed during restore: ${changedUnselected.join(', ')}`);
    }
  }
  let archiveChanged = false;
  const stepsByTarget = new Map(archives.length ? db.select().from(schema.metadataOperationSteps)
    .where(eq(schema.metadataOperationSteps.operationId,operationId)).all().map(step => [step.target,step]) : []);
  for (const archive of archives) {
    const step = stepsByTarget.get(archive.target);
    if (!step) continue;
    try {
      const restored = restoredSnapshots.get(archive.target);
      let observed: ArchiveSnapshot;
      if (restored && fields.length === 0 && covers.length === 0) {
        const currentStat = await fs.stat(archive.target);
        observed = currentStat.isFile() && currentStat.dev === restored.device && currentStat.ino === restored.inode && currentStat.size === restored.size && currentStat.mtimeMs === restored.mtimeMs
          ? restored
          : await captureArchiveSnapshot(archive.target);
      } else {
        observed = restored && await verifyArchiveSnapshot(archive.target, restored) ? restored : await captureArchiveSnapshot(archive.target);
      }
      archiveChanged ||= observed.xml !== archive.expected.xml;
      const verified = observed.xml === archive.desiredXml && observed.contentHash === archive.expected.contentHash;
      if (!verified && startedWrite) problems.push(`Archive restore was not confirmed: ${archive.target.split(/[\\/]/).at(-1)}`);
      db.update(schema.metadataOperationSteps).set({afterJson:JSON.stringify(observed),status:verified?'observed':'unverified'}).where(eq(schema.metadataOperationSteps.id,step.id)).run();
    } catch {
      problems.push(`Could not verify restored archive: ${archive.target.split(/[\\/]/).at(-1)}`);
      db.update(schema.metadataOperationSteps).set({status:'unverified'}).where(eq(schema.metadataOperationSteps.id,step.id)).run();
    }
  }
  const cancelled = failed && failure instanceof Error && failure.name === 'JobCancelled';
  const changed = coverResult.changed || archiveChanged || (before && after && Object.keys(before.fields).some(field => metadataValueKey(before!.fields[field]) !== metadataValueKey(after!.fields[field])));
  const status = cancelled ? 'cancelled' : failed ? (!after && startedWrite ? 'unverified' : changed ? 'partial' : 'failed')
    : problems.length ? 'unverified' : 'completed';
  const message = [failed ? failure instanceof Error ? failure.message : String(failure) : '',...problems,...warnings].filter(Boolean).join('; ') || null;
  const finishedAt = now();
  db.transaction(tx => {
    if (journaled) tx.update(schema.metadataOperations).set({afterJson:after?JSON.stringify(after):null,status,message,finishedAt})
      .where(and(eq(schema.metadataOperations.id,operationId),eq(schema.metadataOperations.status,'running'))).run();
    tx.update(schema.metadataRestorePlans).set({status,message,finishedAt})
      .where(and(eq(schema.metadataRestorePlans.id,plan.id),eq(schema.metadataRestorePlans.status,'running'))).run();
  });
  if (failed) throw failure;
  if (problems.length) throw new MetadataRestoreError(`Restore verification failed: ${problems.join('; ')}`,502);
  return {restored:fields,restoredArchives:archives.length,restoredCovers:covers.length,unverifiedCoverLocks:coverResult.unverifiedNativeLocks,operationId};
}

/** Terminal hooks release pins, including queued cancellations and pre-execution validation failures. */
export function settleMetadataRestoreJob(jobId: number, status: string, message?: string): void {
  const plans = getDb().select({
    id: schema.metadataRestorePlans.id,
    status: schema.metadataRestorePlans.status,
    operationId: schema.metadataRestorePlans.operationId,
  }).from(schema.metadataRestorePlans).where(and(eq(schema.metadataRestorePlans.jobId,jobId),
    inArray(schema.metadataRestorePlans.status,activeStatuses))).all();
  if (!plans.length) return;
  const finishedAt = now();
  getDb().transaction(tx => {
    for (const plan of plans) {
      const outcome = status === 'cancelled' ? 'cancelled' : status === 'interrupted' || plan.status === 'running' ? 'interrupted' : 'failed';
      const detail = message ?? 'Restore ended before authoritative verification; inspect history before retrying';
      tx.update(schema.metadataRestorePlans).set({status:outcome,message:detail,finishedAt}).where(eq(schema.metadataRestorePlans.id,plan.id)).run();
      if (plan.operationId) tx.update(schema.metadataOperations).set({status:outcome,message:detail,finishedAt})
        .where(and(eq(schema.metadataOperations.id,plan.operationId),eq(schema.metadataOperations.status,'running'))).run();
    }
  });
}

/** Queued, never-started approvals survive restart; ambiguous attempts never repeat automatically. */
export function interruptMetadataRestore(): void {
  const plans = getDb().select({
    id: schema.metadataRestorePlans.id,
    jobId: schema.metadataRestorePlans.jobId,
    status: schema.metadataRestorePlans.status,
    operationId: schema.metadataRestorePlans.operationId,
  }).from(schema.metadataRestorePlans).where(inArray(schema.metadataRestorePlans.status,activeStatuses)).all();
  const finishedAt = now(), message = 'Server stopped before restore verification; inspect current values and create a new preview';
  getDb().transaction(tx => {
    for (const plan of plans) {
      const job = plan.jobId === null ? undefined : tx.select({status:schema.jobs.status}).from(schema.jobs).where(eq(schema.jobs.id,plan.jobId)).get();
      if (plan.status === 'approved' && job?.status === 'queued') continue;
      tx.update(schema.metadataRestorePlans).set({status:'interrupted',message,finishedAt}).where(eq(schema.metadataRestorePlans.id,plan.id)).run();
      if (plan.operationId) tx.update(schema.metadataOperations).set({status:'interrupted',message,finishedAt})
        .where(and(eq(schema.metadataOperations.id,plan.operationId),eq(schema.metadataOperations.status,'running'))).run();
    }
  });
  expirePreviews();
}
