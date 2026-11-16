import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import { readComicInfo } from '../lib/cbz.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { archiveMutations, archiveResource } from '../lib/mutations.js';
import { EXCLUDABLE_FIELDS } from '../contracts/metadata.js';
import type { MetadataSnapshot, MetadataHistoryEntry, MetadataHistoryDetail, ArchiveHistory } from '../contracts/metadataHistory.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { getFieldPolicy } from './fieldPolicies.js';

const connection = () => kavitaConnectionKey(getKavitaConnection().baseUrl);
export function describeMetadataPatch(payload:object):Record<string,unknown> {
  return Object.fromEntries(Object.entries(EXCLUDABLE_FIELDS).filter(([,key])=>Object.hasOwn(payload,key)).map(([field,key])=>[field,(payload as Record<string,unknown>)[key]]));
}
const keys: Record<string, [string, string?]> = {
  title:['name','nameLocked'],summary:['summary','summaryLocked'],genres:['genres','genresLocked'],tags:['tags','tagsLocked'],
  writers:['writers','writerLocked'],artists:['pencillers','pencillerLocked'],releaseDate:['releaseYear','releaseYearLocked'],
  language:['language','languageLocked'],status:['publicationStatus','publicationStatusLocked'],url:['webLinks'],
};
async function snapshot(client: KavitaClient, seriesId: number): Promise<MetadataSnapshot> {
  const [series, metadata] = await Promise.all([client.getSeriesDto(seriesId),client.getSeriesMetadata(seriesId)]);
  if (series.id !== seriesId || !Number.isSafeInteger(series.libraryId)) throw new Error('History target identity could not be verified');
  const fields: MetadataSnapshot['fields'] = {};
  for (const [field,[key,lock]] of Object.entries(keys)) {
    const source = (field === 'title' ? series : metadata) as unknown as Record<string,unknown>;
    fields[field] = { present: Object.hasOwn(source,key), ...(Object.hasOwn(source,key)?{value:source[key]}:{}),
      ...(lock && typeof source[lock] === 'boolean' ? {nativeLocked:source[lock] as boolean}: {}) };
  }
  return {series:{id:series.id,libraryId:series.libraryId,name:series.name ?? null},fields};
}
async function archiveSnapshot(target: string) {
  const stat = await fs.stat(target);
  const xml = await readComicInfo(target);
  return {xml,size:stat.size,mtimeMs:stat.mtimeMs,hash:createHash('sha256').update(xml ?? '<absent>').digest('hex')};
}
export interface MetadataJournal { captureArchives: (files: string[]) => Promise<void> }

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
  const before=await snapshot(client,seriesId);
  if(connection()!==key)throw new Error('Kavita connection changed before history capture');
  const id=randomUUID(), db=getDb();
  db.insert(schema.metadataOperations).values({id,connectionKey:key,seriesId,jobId,origin,fieldsJson:JSON.stringify(Object.keys(desired)),desiredJson:JSON.stringify(desired),policyRevision:getFieldPolicy(seriesId).revision,beforeJson:JSON.stringify(before),createdAt:new Date().toISOString()}).run();
  const files=new Set<string>();
  let capturedBytes=0;
  const journal: MetadataJournal = {captureArchives:async targets => {
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
  try {after=await snapshot(client,seriesId);}catch{problems.push('Could not verify current metadata after the operation');}
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
  db.update(schema.metadataOperations).set({afterJson:after?JSON.stringify(after):null,status,message:[failed?(failure instanceof Error?failure.message:String(failure)):'',...problems,...(outcome?.warnings??[])].filter(Boolean).join('; ')||null,finishedAt:new Date().toISOString()}).where(and(eq(schema.metadataOperations.id,id),eq(schema.metadataOperations.status,'running'))).run();
  if(failed)throw failure;
  return result as T;
}

type Row=typeof schema.metadataOperations.$inferSelect;
function summary(row:Row):MetadataHistoryEntry {
  const before:MetadataSnapshot=JSON.parse(row.beforeJson), after:MetadataSnapshot|null=row.afterJson?JSON.parse(row.afterJson):null;
  return {id:row.id,sequence:row.sequence,origin:row.origin,status:row.status,createdAt:row.createdAt,finishedAt:row.finishedAt,
    fields:JSON.parse(row.fieldsJson),changedFields:after?Object.keys(before.fields).filter(field=>JSON.stringify(before.fields[field])!==JSON.stringify(after.fields[field])):[],message:row.message,jobId:row.jobId};
}
export function listMetadataHistory(seriesId:number,cursor?:number) {
  const rows=getDb().select().from(schema.metadataOperations).where(and(eq(schema.metadataOperations.connectionKey,connection()),eq(schema.metadataOperations.seriesId,seriesId),cursor?lt(schema.metadataOperations.sequence,cursor):undefined)).orderBy(desc(schema.metadataOperations.sequence)).limit(21).all();
  const items=rows.slice(0,20).map(summary);
  return {items,nextCursor:rows.length>20?items.at(-1)!.sequence:null};
}
export function metadataHistoryDetail(seriesId:number,id:string):MetadataHistoryDetail|null {
  const row=getDb().select().from(schema.metadataOperations).where(and(eq(schema.metadataOperations.connectionKey,connection()),eq(schema.metadataOperations.seriesId,seriesId),eq(schema.metadataOperations.id,id))).get();
  if(!row)return null;
  return {...summary(row),before:JSON.parse(row.beforeJson) as MetadataSnapshot,after:row.afterJson?JSON.parse(row.afterJson) as MetadataSnapshot:null,
    archives:getDb().select().from(schema.metadataOperationSteps).where(eq(schema.metadataOperationSteps.operationId,id)).all().map(archiveDetail),
    availability:{metadata:row.afterJson?'captured':'unverified',archives:'captured files only; moves are not reversible',covers:'not captured',restore:'not enabled'}};
}

function archiveDetail(row: typeof schema.metadataOperationSteps.$inferSelect): ArchiveHistory {
  const before = JSON.parse(row.beforeJson) as {xml: string|null};
  const after = row.afterJson ? JSON.parse(row.afterJson) as {xml: string|null} : null;
  const beforeFields = before.xml === null ? {} : parseComicInfo(before.xml).fields;
  const afterFields = after?.xml == null ? {} : parseComicInfo(after.xml).fields;
  const fields = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])];
  return {
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
}
