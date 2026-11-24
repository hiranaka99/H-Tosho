import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import { captureArchiveSnapshot } from '../lib/cbz.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { archiveMutations, archiveResource } from '../lib/mutations.js';
import { EXCLUDABLE_FIELDS } from '../contracts/metadata.js';
import type { MetadataSnapshot, MetadataHistoryEntry, MetadataHistoryDetail, ArchiveHistory } from '../contracts/metadataHistory.js';
import { RESTORABLE_METADATA_FIELDS, getMetadataRestoreFieldAvailability, metadataValueKey } from '../contracts/metadataRestore.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { getFieldPolicy } from './fieldPolicies.js';
import { coverJournal, coverHistoryBatch, interruptCoverHistory } from './metadataCovers.js';
import type { CoverHistory, CoverTarget } from '../contracts/metadataCovers.js';

const connection = () => kavitaConnectionKey(getKavitaConnection().baseUrl);
export function describeMetadataPatch(payload:object):Record<string,unknown> {
  return Object.fromEntries(Object.entries(EXCLUDABLE_FIELDS).filter(([,key])=>Object.hasOwn(payload,key)).map(([field,key])=>[field,(payload as Record<string,unknown>)[key]]));
}
const keys: Record<string, [string, string?]> = {
  title:['name','nameLocked'],summary:['summary','summaryLocked'],genres:['genres','genresLocked'],tags:['tags','tagsLocked'],
  sortName:['sortName','sortNameLocked'],localizedName:['localizedName','localizedNameLocked'],
  writers:['writers','writerLocked'],artists:['pencillers','pencillerLocked'],releaseDate:['releaseYear','releaseYearLocked'],
  language:['language','languageLocked'],status:['publicationStatus','publicationStatusLocked'],url:['webLinks'],
};
export async function captureMetadataSnapshot(client: KavitaClient, seriesId: number, verifyMetadataIdentity = false): Promise<MetadataSnapshot> {
  const [series, metadata] = await Promise.all([client.getSeriesDto(seriesId),client.getSeriesMetadata(seriesId)]);
  if (series.id !== seriesId || !Number.isSafeInteger(series.libraryId)) throw new Error('History target identity could not be verified');
  if (verifyMetadataIdentity && metadata.seriesId !== seriesId) throw new Error('Metadata target identity could not be verified');
  const fields: MetadataSnapshot['fields'] = {};
  for (const [field,[key,lock]] of Object.entries(keys)) {
    const source = (['title','sortName','localizedName'].includes(field) ? series : metadata) as unknown as Record<string,unknown>;
    fields[field] = { present: Object.hasOwn(source,key), ...(Object.hasOwn(source,key)?{value:source[key]}:{}),
      ...(lock && typeof source[lock] === 'boolean' ? {nativeLocked:source[lock] as boolean}: {}) };
  }
  return {titleContext:{sortName:series.sortName,sortNameLocked:series.sortNameLocked,localizedName:series.localizedName,
    localizedNameLocked:series.localizedNameLocked,coverImageLocked:series.coverImageLocked},series:{id:series.id,libraryId:series.libraryId,name:series.name ?? null,
    ...(Object.hasOwn(series, 'folderPath') ? {folderPath:series.folderPath} : {})},fields};
}
const archiveSnapshot = captureArchiveSnapshot;
export interface MetadataJournal {
  captureArchives: (files: string[]) => Promise<void>;
  captureSeriesCover: () => Promise<void>;
  captureVolumeCover: (volumeId: number) => Promise<void>;
  beginCoverWrite: (target: CoverTarget, lock: boolean, assetId?: string) => void;
  acknowledgeCoverWrite: (target: CoverTarget) => void;
}

function comparable(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => typeof item === 'object' && item !== null ? item.name ?? item.title : item)
    .map(item => typeof item === 'string' ? item.trim().toLowerCase() : item).sort();
}

function unverifiedFields(after: MetadataSnapshot, desired: Record<string, unknown>): string[] {
  return Object.entries(desired).filter(([field, expected]) => {
    const cell = after.fields[field];
    if (!cell) return false; // Archive changes are shown separately from Kavita field expectations.
    if (!cell.present) return true;
    const actual = comparable(cell.value), requested = comparable(expected);
    // Provider tag writes deliberately preserve tags already in Kavita.
    if (field === 'tags' && Array.isArray(actual) && Array.isArray(requested)) return requested.some(tag => !actual.includes(tag));
    return JSON.stringify(actual) !== JSON.stringify(requested);
  }).map(([field]) => field);
}

/** The caller owns the series mutation boundary. Journal preparation fails closed. */
export async function withMetadataHistory<T>(client: KavitaClient, seriesId: number, origin: string,
  desired: Record<string,unknown>, operation: (journal: MetadataJournal) => Promise<T>, jobId?: number): Promise<T> {
  const key=connection();
  const before=await captureMetadataSnapshot(client,seriesId);
  if(connection()!==key)throw new Error('Kavita connection changed before history capture');
  const id=randomUUID(), db=getDb();
  db.insert(schema.metadataOperations).values({id,connectionKey:key,seriesId,jobId,origin,fieldsJson:JSON.stringify(Object.keys(desired)),desiredJson:JSON.stringify(desired),policyRevision:getFieldPolicy(seriesId).revision,beforeJson:JSON.stringify(before),createdAt:new Date().toISOString()}).run();
  const files=new Set<string>();
  const covers=coverJournal(client,id,seriesId,before,key);
  let capturedBytes=0;
  // Only this journal edits its operation's fieldsJson, so once 'cover' is recorded it stays recorded.
  let coverFieldRecorded=false;
  const recordCoverField = () => {
    if (coverFieldRecorded) return;
    const row = db.select({ fieldsJson: schema.metadataOperations.fieldsJson }).from(schema.metadataOperations).where(eq(schema.metadataOperations.id, id)).get()!;
    const fields: string[] = JSON.parse(row.fieldsJson);
    if (!fields.includes('cover')) db.update(schema.metadataOperations).set({ fieldsJson: JSON.stringify([...fields, 'cover']) }).where(eq(schema.metadataOperations.id, id)).run();
    coverFieldRecorded=true;
  };
  const journal: MetadataJournal = {
    captureSeriesCover: async () => { recordCoverField(); await covers.capture({ kind: 'series' }); },
    captureVolumeCover: async volumeId => { recordCoverField(); await covers.capture({ kind: 'volume', volumeId }); },
    beginCoverWrite: (target, lock, assetId) => covers.beginWrite(target, lock, assetId),
    acknowledgeCoverWrite: target => covers.acknowledge(target),
    captureArchives: async targets => {
    for(const file of targets) {
      const target=path.resolve(file);
      if(files.has(target))continue;
      if(files.size>=2000)throw new Error('Too many archive snapshots in one operation');
      await archiveMutations.run([archiveResource(target)],async()=>{
        const value=await archiveSnapshot(target);
        capturedBytes+=Buffer.byteLength(value.xml ?? '','utf8');
        if(capturedBytes>16*1024*1024)throw new Error('ComicInfo history snapshot exceeds 16 MiB; no further archive changes were started');
        db.insert(schema.metadataOperationSteps).values({operationId:id,target,beforeJson:JSON.stringify(value)}).run();
        files.add(target);
      });
    }
  }};
  let result:T|undefined, failure:unknown, failed=false;
  try {result=await operation(journal);} catch(error){failure=error;failed=true;}
  let after:MetadataSnapshot|null=null;
  const problems:string[]=[];
  const coverResult = await covers.finish();
  problems.push(...coverResult.problems);
  try {after=await captureMetadataSnapshot(client,seriesId);}catch{problems.push('Could not verify current metadata after the operation');}
  if (after && after.series.libraryId !== before.series.libraryId) problems.push('Series library changed during the operation; review target identity');
  let afterBytes = 0;
  for(const target of files) {
    try {
      const value=await archiveMutations.run([archiveResource(target)],()=>archiveSnapshot(target));
      afterBytes += Buffer.byteLength(value.xml ?? '', 'utf8');
      if (afterBytes > 16 * 1024 * 1024) throw new Error('Archive readback exceeded the history size limit');
      db.update(schema.metadataOperationSteps).set({afterJson:JSON.stringify(value),status:'observed'}).where(and(eq(schema.metadataOperationSteps.operationId,id),eq(schema.metadataOperationSteps.target,target))).run();
    }catch{
      db.update(schema.metadataOperationSteps).set({status:'unverified'}).where(and(eq(schema.metadataOperationSteps.operationId,id),eq(schema.metadataOperationSteps.target,target))).run();
      problems.push(`Could not capture archive after operation: ${path.basename(target)}`);
    }
  }
  const outcome=result as {errors?:string[];warnings?:string[];failed?:number}|undefined;
  if(outcome?.errors?.length)problems.push(...outcome.errors);
  if(outcome?.failed)problems.push(`${outcome.failed} operation step(s) failed`);
  if (after && (origin === 'provider-apply' || origin === 'automatic-sync')) {
    const fields = unverifiedFields(after, desired);
    if (fields.length) problems.push(`Requested values were not confirmed: ${fields.join(', ')}`);
  }
  const status=failed ? (failure instanceof Error && failure.name==='JobCancelled'?'cancelled':'partial') : problems.length?'unverified':'completed';
  db.update(schema.metadataOperations).set({afterJson:after?JSON.stringify(after):null,status,message:[failed?(failure instanceof Error?failure.message:String(failure)):'',...problems,...coverResult.warnings,...(outcome?.warnings??[])].filter(Boolean).join('; ')||null,finishedAt:new Date().toISOString()}).where(and(eq(schema.metadataOperations.id,id),eq(schema.metadataOperations.status,'running'))).run();
  if(failed)throw failure;
  return result as T;
}

type Row=typeof schema.metadataOperations.$inferSelect;
function summary(row:Row, cover?: CoverHistory, parsedBefore?: MetadataSnapshot, parsedAfter?: MetadataSnapshot | null):MetadataHistoryEntry {
  const before:MetadataSnapshot=parsedBefore ?? JSON.parse(row.beforeJson);
  const after:MetadataSnapshot|null=parsedAfter !== undefined ? parsedAfter : (row.afterJson?JSON.parse(row.afterJson):null);
  return {id:row.id,sequence:row.sequence,origin:row.origin,status:row.status,createdAt:row.createdAt,finishedAt:row.finishedAt,
    fields:JSON.parse(row.fieldsJson),changedFields:[...(after?Object.keys(before.fields).filter(field=>metadataValueKey(before.fields[field])!==metadataValueKey(after.fields[field])):[]),...((cover?.series?.changed || cover?.volumes.some(volume => volume.changed))?['cover']:[])],message:row.message,jobId:row.jobId,restoredFromOperationId:row.restoredFromOperationId};
}
export function listMetadataHistory(seriesId:number,cursor?:number) {
  const rows=getDb().select().from(schema.metadataOperations).where(and(eq(schema.metadataOperations.connectionKey,connection()),eq(schema.metadataOperations.seriesId,seriesId),cursor?lt(schema.metadataOperations.sequence,cursor):undefined)).orderBy(desc(schema.metadataOperations.sequence)).limit(21).all();
  const page = rows.slice(0,20);
  const coversByOp = coverHistoryBatch(page);
  const items=page.map(row => summary(row, coversByOp.get(row.id)));
  return {items,nextCursor:rows.length>20?items.at(-1)!.sequence:null};
}
export function metadataHistoryDetail(seriesId:number,id:string):MetadataHistoryDetail|null {
  const row=getDb().select().from(schema.metadataOperations).where(and(eq(schema.metadataOperations.connectionKey,connection()),eq(schema.metadataOperations.seriesId,seriesId),eq(schema.metadataOperations.id,id))).get();
  if(!row)return null;
  const before = JSON.parse(row.beforeJson) as MetadataSnapshot;
  const after = row.afterJson ? JSON.parse(row.afterJson) as MetadataSnapshot : null;
  const policy = getFieldPolicy(seriesId);
  const covers=coverHistoryBatch([row]).get(id);
  const availability = (value: MetadataSnapshot | null, side: 'before' | 'after') => RESTORABLE_METADATA_FIELDS.map(field => {
    const result = getMetadataRestoreFieldAvailability(field, value?.fields[field]);
    if (row.status === 'running' || (side === 'after' && row.status === 'unverified')) {
      return {...result,available:false,nativeLockAvailable:false,reason:row.status === 'running'
        ? 'Source operation is still running' : 'After snapshot is unverified; per-field verification was not recorded'};
    }
    return policy.lockedFields.includes(field as typeof policy.lockedFields[number])
      ? {...result, available:false, reason:'Protected by H-Tosho field policy', nativeLockAvailable:false} : result;
  });
  return {...summary(row, covers, before, after),before:publicSnapshot(before),after:after?publicSnapshot(after):null,...(covers?{covers}:{}),
    archives:getDb().select().from(schema.metadataOperationSteps).where(eq(schema.metadataOperationSteps.operationId,id)).all().map(archiveDetail),
    restoreAvailability:{before:availability(before,'before'),after:availability(after,'after')},
    availability:{metadata:row.afterJson?'captured':'unverified',archives:'Captured files only; current identity and fingerprints must pass preview. Moves are not reversible.',covers:covers?'Retained series/volume images; API restoration requires current identity/protection checks and explicit conversion review':'No cover mutation was captured; earlier history has no image backup',restore:'Selected metadata, paired titles, ComicInfo XML and retained covers; preview and approval required'}};
}

/** Identity paths are private evidence, never historical write authority in API responses. */
function publicSnapshot(value: MetadataSnapshot): MetadataSnapshot {
  const {folderPath: _folderPath, ...series} = value.series;
  return {...value,series};
}

function archiveDetail(row: typeof schema.metadataOperationSteps.$inferSelect): ArchiveHistory {
  const before = JSON.parse(row.beforeJson) as {xml: string|null};
  const after = row.afterJson ? JSON.parse(row.afterJson) as {xml: string|null} : null;
  const beforeFields = before.xml === null ? {} : parseComicInfo(before.xml).fields;
  const afterFields = after?.xml == null ? {} : parseComicInfo(after.xml).fields;
  const fields = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])];
  return {
    id: row.id,
    target: path.basename(row.target), status: row.status,
    beforePresent: before.xml !== null, afterPresent: after ? after.xml !== null : null,
    changes: fields.filter(field => !after || beforeFields[field] !== afterFields[field]).map(field => ({
      field,
      before: {present: Object.hasOwn(beforeFields,field), ...(Object.hasOwn(beforeFields,field)?{value:beforeFields[field]}:{})},
      ...(after?{after:{present:Object.hasOwn(afterFields,field),...(Object.hasOwn(afterFields,field)?{value:afterFields[field]}:{})}}:{}),
    })),
  };
}
export function interruptMetadataHistory():void {
  getDb().update(schema.metadataOperations).set({status:'interrupted',message:'Server stopped before verification; inspect current values before retrying',finishedAt:new Date().toISOString()}).where(eq(schema.metadataOperations.status,'running')).run();
  interruptCoverHistory();
}
