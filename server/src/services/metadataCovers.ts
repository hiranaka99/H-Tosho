import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { MetadataSnapshot } from '../contracts/metadataHistory.js';
import { COVER_RESTORE_UNAVAILABLE, MAX_RETAINED_COVER_BYTES, MAX_RETAINED_COVER_STORE_BYTES,
  type RecordedCover, type RecordedCoverState, type SeriesCoverHistory } from '../contracts/metadataCovers.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';

const connection=()=>kavitaConnectionKey(getKavitaConnection().baseUrl);
export function coverStorageBudget(value:string|undefined=process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB):number {
  if(value===undefined)return MAX_RETAINED_COVER_STORE_BYTES;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<10||Number(value)>16_384) {
    throw new Error('Cover-history storage limit must be an integer from 10 through 16384 MiB; the cover write was not started');
  }
  return Number(value)*1024*1024;
}
type CoverRow=typeof schema.metadataSeriesCovers.$inferSelect;
interface CoverObservation {
  state:'captured'|'absent'; assetId:string|null; data:Buffer|null; mediaType:string|null;
  locked:boolean; token:string|null; libraryId:number; folderPath?:string|null; installationId?:string;
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

async function observe(client:KavitaClient,seriesId:number,expected:MetadataSnapshot,key:string):Promise<CoverObservation> {
  if(connection()!==key)throw new Error('Kavita connection changed during cover capture');
  const series=await client.getSeriesDto(seriesId);
  if(series.id!==seriesId || series.libraryId!==expected.series.libraryId
    || (Object.hasOwn(expected.series,'folderPath') && series.folderPath!==expected.series.folderPath))throw new Error('Series identity changed during cover capture');
  if(typeof series.coverImageLocked!=='boolean')throw new Error('Kavita did not return the original series-cover lock; cover write was not started');
  if(typeof client.getSeriesCoverForHistory!=='function')throw new Error('Kavita series-cover image reads are unavailable; cover write was not started');
  const info=typeof client.getServerInfo==='function'?await client.getServerInfo():undefined;
  if(expected.installationId!==undefined && info?.installId!==expected.installationId)throw new Error('Kavita installation changed during cover capture');
  const image=await client.getSeriesCoverForHistory(seriesId);
  const token=typeof series.coverImage==='string'?series.coverImage:series.coverImage===null?null:undefined;
  if(!image && token!==null && token!=='')throw new Error('Current series cover is unreadable; a failed image read cannot be recorded as an absent cover');
  const mediaType=image?coverMediaType(image.data):null;
  const after=await client.getSeriesDto(seriesId);
  if(connection()!==key || after.id!==seriesId || after.libraryId!==series.libraryId || after.folderPath!==series.folderPath
    || after.coverImage!==series.coverImage || after.coverImageLocked!==series.coverImageLocked)throw new Error('Series cover or identity changed while it was being captured');
  return {state:image?'captured':'absent',assetId:image?createHash('sha256').update(image.data).digest('hex'):null,
    data:image?.data??null,mediaType,locked:series.coverImageLocked,token:token??null,libraryId:series.libraryId,
    ...(Object.hasOwn(series,'folderPath')?{folderPath:series.folderPath}:{}),...(info?.installId?{installationId:info.installId}:{})};
}

function persistAsset(value:CoverObservation):void {
  if(!value.assetId || !value.data || !value.mediaType)return;
  const db=getDb();
  if(db.select({id:schema.metadataAssets.id}).from(schema.metadataAssets).where(eq(schema.metadataAssets.id,value.assetId)).get())return;
  const used=db.select({bytes:sql<number>`coalesce(sum(${schema.metadataAssets.byteSize}),0)`}).from(schema.metadataAssets).get()!.bytes;
  const reserved=db.select({bytes:sql<number>`coalesce(sum(${schema.metadataSeriesCovers.reservedBytes}),0)`}).from(schema.metadataSeriesCovers).get()!.bytes;
  if(used+reserved+value.data.length>coverStorageBudget())throw new Error('Retained cover storage reached its configured budget; no retained history was evicted. Increase the cover-history storage budget before retrying the affected cover write');
  db.insert(schema.metadataAssets).values({id:value.assetId,mediaType:value.mediaType,byteSize:value.data.length,data:value.data}).run();
}

/** All writes use the caller's existing parent series ownership and journal. */
export function seriesCoverJournal(client:KavitaClient,operationId:string,seriesId:number,expected:MetadataSnapshot,key:string) {
  let saved:CoverObservation|undefined;
  const db=getDb();
  return {
    async capture():Promise<void> {
      // The plan gates capture on an explicitly chosen storage budget. A fresh
      // install keeps its existing cover workflow until the operator opts in.
      if(process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB===undefined && !saved) {
        db.insert(schema.metadataSeriesCovers).values({operationId,status:'not-captured',
          beforeReason:'Series-cover capture was disabled for this operation; configure its storage budget to retain images',
          afterReason:'Series-cover capture was disabled for this operation; no after image was retained'}).onConflictDoNothing().run();
        return;
      }
      if(saved) {
        const current=await observe(client,seriesId,expected,key);
        if(current.assetId!==saved.assetId || current.state!==saved.state || current.locked!==saved.locked || current.token!==saved.token
          || current.installationId!==saved.installationId)throw new Error('Series cover or native lock changed after history preparation; review required before applying the cover');
        db.update(schema.metadataSeriesCovers).set({status:'applying'}).where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
        return;
      }
      db.insert(schema.metadataSeriesCovers).values({operationId,beforeReason:'Series cover capture did not finish',afterReason:'No observed cover readback yet'}).onConflictDoNothing().run();
      try {
        const value=await observe(client,seriesId,expected,key);
        db.transaction(()=>{
          // Reserve the maximum readback size first, so concurrent operations cannot consume its capacity.
          db.update(schema.metadataSeriesCovers).set({reservedBytes:MAX_RETAINED_COVER_BYTES}).where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
          persistAsset(value);
          const used=db.select({bytes:sql<number>`coalesce(sum(${schema.metadataAssets.byteSize}),0)`}).from(schema.metadataAssets).get()!.bytes;
          const reserved=db.select({bytes:sql<number>`coalesce(sum(${schema.metadataSeriesCovers.reservedBytes}),0)`}).from(schema.metadataSeriesCovers).get()!.bytes;
          if(used+reserved>coverStorageBudget())throw new Error('Insufficient retained cover storage for guaranteed readback; increase the cover-history storage budget before retrying the affected cover write');
          db.update(schema.metadataSeriesCovers).set({status:'prepared',beforeState:value.state,beforeAssetId:value.assetId,
            beforeLocked:value.locked,beforeEvidenceJson:JSON.stringify({token:value.token,libraryId:value.libraryId,folderPath:value.folderPath,installationId:value.installationId}),beforeReason:null})
            .where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
        });
        saved=value;
      }catch(error){
        db.update(schema.metadataSeriesCovers).set({status:'not-captured',beforeReason:error instanceof Error?error.message:'Could not capture current cover',
          afterReason:'Series cover write was skipped because required before capture failed',reservedBytes:0}).where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
        throw error;
      }
    },
    async finish():Promise<string|null> {
      if(!saved)return null;
      try {
        const value=await observe(client,seriesId,{...expected,...(saved.installationId?{installationId:saved.installationId}:{})},key);
        db.transaction(()=>{
          db.update(schema.metadataSeriesCovers).set({reservedBytes:0}).where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
          persistAsset(value);
          db.update(schema.metadataSeriesCovers).set({status:'observed',afterState:value.state,afterAssetId:value.assetId,afterLocked:value.locked,afterReason:null})
            .where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
        });
        return null;
      }catch{
        const message='Could not retain verified series-cover readback; inspect the current cover before any further action';
        db.update(schema.metadataSeriesCovers).set({status:'unverified',afterReason:message,reservedBytes:0}).where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
        return message;
      }
    },
  };
}

function recorded(row:CoverRow,side:'before'|'after'):RecordedCover {
  const state=row[`${side}State`] as RecordedCoverState,id=row[`${side}AssetId`];
  const asset=id?getDb().select({id:schema.metadataAssets.id,mediaType:schema.metadataAssets.mediaType,byteSize:schema.metadataAssets.byteSize})
    .from(schema.metadataAssets).where(eq(schema.metadataAssets.id,id)).get():undefined;
  const missing=state==='captured'&&!asset;
  return {state:missing?'unavailable':state,assetId:asset?.id??null,mediaType:asset?.mediaType??null,byteSize:asset?.byteSize??null,
    nativeLocked:row[`${side}Locked`],reason:missing?'Retained cover asset is no longer available':row[`${side}Reason`]};
}
export function seriesCoverHistory(operationId:string):SeriesCoverHistory|undefined {
  const row=getDb().select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId,operationId)).get();
  if(!row)return undefined;
  const before=recorded(row,'before'),after=recorded(row,'after');
  return {status:row.status,before,after,changed:before.state==='unavailable'||after.state==='unavailable'?null
    :before.state!==after.state||before.assetId!==after.assetId||before.nativeLocked!==after.nativeLocked,
    restoreAvailable:false,restoreReason:COVER_RESTORE_UNAVAILABLE,volumeCovers:'not captured'};
}

/** Possessing a content hash never authorizes another connection/series/operation's image. */
export function retainedCoverAsset(seriesId:number,operationId:string,assetId:string):{data:Buffer;mediaType:string}|null {
  if(!Number.isSafeInteger(seriesId)||seriesId<=0||!(/^[A-Za-z0-9._:-]{1,128}$/).test(operationId)||!(/^[a-f0-9]{64}$/).test(assetId))return null;
  const db=getDb();
  const reference=db.select({operationId:schema.metadataSeriesCovers.operationId}).from(schema.metadataSeriesCovers)
    .innerJoin(schema.metadataOperations,eq(schema.metadataOperations.id,schema.metadataSeriesCovers.operationId))
    .where(and(eq(schema.metadataOperations.connectionKey,connection()),eq(schema.metadataOperations.seriesId,seriesId),eq(schema.metadataOperations.id,operationId),
      or(eq(schema.metadataSeriesCovers.beforeAssetId,assetId),eq(schema.metadataSeriesCovers.afterAssetId,assetId)))).get();
  if(!reference)return null;
  const asset=db.select().from(schema.metadataAssets).where(eq(schema.metadataAssets.id,assetId)).get();
  if(!asset || asset.data.length!==asset.byteSize || createHash('sha256').update(asset.data).digest('hex')!==assetId)return null;
  try {if(coverMediaType(asset.data)!==asset.mediaType)return null;}catch{return null;}
  return {data:asset.data,mediaType:asset.mediaType};
}

export function interruptSeriesCoverHistory():void {
  getDb().update(schema.metadataSeriesCovers).set({status:'interrupted',reservedBytes:0,afterReason:'Server stopped before series-cover readback; only retained observations are available'})
    .where(or(eq(schema.metadataSeriesCovers.status,'preparing'),eq(schema.metadataSeriesCovers.status,'prepared'),eq(schema.metadataSeriesCovers.status,'applying'))).run();
}
