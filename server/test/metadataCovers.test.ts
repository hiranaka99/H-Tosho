import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import type { KavitaClient as ClientType } from '../src/kavita/client.js';
import { coverImage } from './fixtures/coverImage.js';
import { MAX_RETAINED_COVER_BYTES, MAX_RETAINED_COVER_STORE_BYTES, COVER_RESTORE_UNAVAILABLE } from '../src/contracts/metadataCovers.js';
import { migrateSchema } from '../src/db/migrations.js';
import { pruneMetadataHistory } from '../src/db/metadataRetention.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'htosho-cover-history-'));
process.env.HTOSHO_DATA_DIR=directory;
process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB='256';
const {initDb,getDb,schema}=await import('../src/db/index.js');
const {setKavitaConnection}=await import('../src/services/settings.js');
const {withMetadataHistory,listMetadataHistory,metadataHistoryDetail,interruptMetadataHistory}=await import('../src/services/metadataHistory.js');
const {retainedCoverAsset,coverMediaType,coverStorageBudget}=await import('../src/services/metadataCovers.js');
const {createMetadataRestorePreview}=await import('../src/services/metadataRestore.js');
const {saveFieldPolicy}=await import('../src/services/fieldPolicies.js');
const {applyResolvedSeriesMatch}=await import('../src/services/sync.js');
const {api}=await import('../src/routes/api/series.js');
const {createApp}=await import('../src/app.js');
const {KavitaClient}=await import('../src/kavita/client.js');
initDb();setKavitaConnection({baseUrl:'https://covers.test',apiKey:'secret-not-in-history'});
const beforeImage=coverImage(),afterImage=coverImage(11,125,102);
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
let nextId=20000;
function fixture() {
  const id=nextId++,series={id,libraryId:7,name:'Same title',folderPath:'/private/library',coverImage:'private-cover-file.png' as string|null,coverImageLocked:true as boolean|undefined};
  const metadata={id:1,seriesId:id,summary:'Summary',summaryLocked:false,tags:[]};
  const state={image:beforeImage as Buffer|null,failRead:false,writes:0,reads:0,installId:'installation-a'};
  const client={getSeriesDto:async()=>structuredClone(series),getSeriesMetadata:async()=>structuredClone(metadata),
    getSeriesById:async()=>({...series,name:series.name}),getServerInfo:async()=>({version:'0.9.1',installId:state.installId}),
    getSeriesCoverForHistory:async()=>{state.reads++;if(state.failRead)throw new Error('Unavailable');return state.image?{data:state.image,contentType:'image/png'}:null;},
    updateSeriesMetadata:async()=>{},updateSeriesCoverFromUrl:async()=>{state.writes++;state.image=afterImage;},updateSeriesCover:async()=>{state.writes++;state.image=afterImage;},
  } as unknown as ClientType;
  return {id,series,metadata,state,client};
}
const entry=(id:number)=>listMetadataHistory(id).items[0];
const detail=(id:number)=>metadataHistoryDetail(id,entry(id).id)!;

test('required original bytes and lock are committed before a cover write, and actual after bytes are retained and deduplicated',async()=>{
  const f=fixture();
  await withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{
    await journal.captureSeriesCover();
    const row=getDb().select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId,entry(f.id).id)).get()!;
    assert.equal(row.beforeAssetId,hash(beforeImage));assert.equal(row.beforeLocked,true);assert.equal(row.reservedBytes,MAX_RETAINED_COVER_BYTES);
    assert.deepEqual(retainedCoverAsset(f.id,row.operationId,row.beforeAssetId!)!.data,beforeImage);
    await journal.captureSeriesCover();f.state.writes++;f.state.image=afterImage;f.series.coverImageLocked=false;
  });
  const history=detail(f.id);
  assert.equal(history.status,'completed');assert.deepEqual(history.changedFields,['cover']);
  assert.equal(history.covers!.before.assetId,hash(beforeImage));assert.equal(history.covers!.after.assetId,hash(afterImage));
  assert.equal(history.covers!.after.nativeLocked,false);assert.equal(history.covers!.changed,true);
  assert.equal(history.covers!.restoreAvailable,false);assert.equal(history.covers!.restoreReason,COVER_RESTORE_UNAVAILABLE);
  assert.equal(JSON.stringify(history).includes('/private'),false);assert.equal(JSON.stringify(history).includes('private-cover-file'),false);assert.equal(JSON.stringify(history).includes('secret-not-in-history'),false);
  assert.equal(getDb().select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId,history.id)).get()!.reservedBytes,0);
  const duplicate=fixture();
  await withMetadataHistory(duplicate.client,duplicate.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();});
  assert.equal(getDb().select().from(schema.metadataAssets).where(eq(schema.metadataAssets.id,hash(beforeImage))).all().length,1);
  assert.equal(detail(duplicate.id).covers!.changed,false);
});

test('genuine cover absence is distinct from missing assets and failed or unsupported image reads',async()=>{
  const f=fixture();f.state.image=null;f.series.coverImage=null;f.series.coverImageLocked=false;
  await withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();f.state.image=afterImage;f.series.coverImage='new.png';});
  const history=detail(f.id);
  assert.equal(history.covers!.before.state,'absent');assert.equal(history.covers!.before.assetId,null);assert.equal(history.covers!.before.nativeLocked,false);
  assert.equal(history.covers!.after.state,'captured');
  const missing=fixture();missing.state.image=null;
  await assert.rejects(withMetadataHistory(missing.client,missing.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();missing.state.writes++;}),/unreadable/);
  assert.equal(missing.state.writes,0);assert.equal(detail(missing.id).covers!.before.state,'unavailable');
});

for(const cause of ['read','lock','oversized','non-raster','identity'] as const)test(`a ${cause} before-capture failure prevents the cover mutation`,async()=>{
  const f=fixture();
  if(cause==='read')f.state.failRead=true;
  if(cause==='lock')f.series.coverImageLocked=undefined;
  if(cause==='oversized')f.state.image=Buffer.alloc(MAX_RETAINED_COVER_BYTES+1);
  if(cause==='non-raster')f.state.image=Buffer.from('<svg><script>bad</script></svg>');
  if(cause==='identity')f.client.getSeriesCoverForHistory=async()=>{f.series.libraryId=9;return {data:beforeImage,contentType:'image/png'};};
  await assert.rejects(withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();f.state.writes++;}));
  assert.equal(f.state.writes,0);assert.equal(detail(f.id).covers!.before.state,'unavailable');
});

for(const changed of ['bytes','native-lock','installation'] as const)test(`fresh ${changed} changes after preparation stop the pending cover write`,async()=>{
  const f=fixture();
  await assert.rejects(withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{
    await journal.captureSeriesCover();
    if(changed==='bytes')f.state.image=afterImage;
    if(changed==='native-lock')f.series.coverImageLocked=false;
    if(changed==='installation')f.state.installId='installation-b';
    await journal.captureSeriesCover();f.state.writes++;
  }),/changed/);
  assert.equal(f.state.writes,0);assert.equal(detail(f.id).covers!.before.assetId,hash(beforeImage));
});

test('partial mutations, cancellation and unavailable readback keep honest inspectable cover observations',async()=>{
  for(const mode of ['partial','cancelled','unverified'] as const){
    const f=fixture();
    const promise=withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{
      await journal.captureSeriesCover();f.state.image=afterImage;f.state.writes++;
      if(mode==='unverified'){f.state.failRead=true;return;}
      const error=new Error('After upload');if(mode==='cancelled')error.name='JobCancelled';throw error;
    });
    if(mode==='unverified')await promise;else await assert.rejects(promise);
    const history=detail(f.id);assert.equal(history.status,mode);
    assert.equal(history.covers!.before.state,'captured');assert.equal(history.covers!.after.state,mode==='unverified'?'unavailable':'captured');
    assert.equal(getDb().select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId,history.id)).get()!.reservedBytes,0);
  }
});

test('provider updates capture before metadata writes and retain cover-only failures without blocking eligible scalar changes',async()=>{
  const good=fixture();
  good.client.updateSeriesMetadata=async()=>{assert.equal(detail(good.id).covers!.before.state,'captured');good.metadata.summary='New summary';};
  const meta={providerId:'fixture',providerSeriesId:'one',title:'Same title',summary:'New summary',coverUrl:'https://provider.test/cover.png',tags:[],genres:[],writers:[],artists:[]};
  const result=await applyResolvedSeriesMatch(good.client,{seriesId:good.id,providerId:'fixture',providerSeriesId:'one'},meta);
  assert.equal(result.coverUpdated,true);assert.equal(good.state.writes,1);assert.equal(detail(good.id).covers!.after.assetId,hash(afterImage));
  const bad=fixture();bad.state.failRead=true;
  bad.client.updateSeriesMetadata=async()=>{bad.metadata.summary='New summary';};
  const skipped=await applyResolvedSeriesMatch(bad.client,{seriesId:bad.id,providerId:'fixture',providerSeriesId:'one'},meta);
  assert.equal(skipped.coverUpdated,false);assert.equal(bad.state.writes,0);assert.equal(bad.metadata.summary,'New summary');assert.ok(skipped.errors.some(message=>message.includes('series cover was skipped')));
});

test('protected covers trigger neither image reads nor cover writes and create no misleading image history',async()=>{
  const f=fixture();await saveFieldPolicy(f.id,['cover'],0);
  await applyResolvedSeriesMatch(f.client,{seriesId:f.id,providerId:'fixture',providerSeriesId:'one'},
    {providerId:'fixture',providerSeriesId:'one',title:'Same title',coverUrl:'https://provider.test/cover.png',tags:[],genres:[],writers:[],artists:[]});
  assert.equal(f.state.reads,0);assert.equal(f.state.writes,0);assert.equal(detail(f.id).covers,undefined);
});

test('retained image handlers require an authenticated, active-connection operation reference and never arbitrary hash authority',async()=>{
  const f=fixture();await withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();});
  const operationId=entry(f.id).id,assetId=hash(beforeImage),url=`/series/${f.id}/metadata-history/${operationId}/assets/${assetId}`;
  const response=await api.request(url);
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),beforeImage);
  assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('cache-control')!,/no-store/);
  for(const suffix of [url.replace(`/${f.id}/`,`/${f.id+1}/`),url.replace(operationId,'not-this-operation'),url.replace(assetId,'b'.repeat(64))])assert.equal((await api.request(suffix)).status,404);
  setKavitaConnection({baseUrl:'https://another-cover.test',apiKey:'other'});
  assert.equal((await api.request(url)).status,404);setKavitaConnection({baseUrl:'https://covers.test',apiKey:'secret-not-in-history'});
  const app=createApp({webDist:null});
  await app.request('/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'cover-test',password:'cover-test-password'})});
  assert.equal((await app.request(`/api${url}`)).status,401);
  getDb().delete(schema.metadataAssets).where(eq(schema.metadataAssets.id,assetId)).run();
  assert.equal((await api.request(url)).status,404);assert.equal(detail(f.id).covers!.before.state,'unavailable');
});

test('cover restore payloads remain rejected even when image bytes and native flags were retained',async()=>{
  const f=fixture();await withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();});
  await assert.rejects(createMetadataRestorePreview(f.client,f.id,entry(f.id).id,{snapshot:'before',fields:['cover']} as never),/Invalid restore/);
  assert.equal(detail(f.id).restoreAvailability.before.find(field=>field.field==='cover')!.available,false);
  assert.match(detail(f.id).restoreAvailability.before.find(field=>field.field==='cover')!.reason!,/re-encodes/);
});

test('admission reserves bounded readback capacity and never evicts retained assets to admit a new cover write',async()=>{
  const f=fixture(),occupied='c'.repeat(64);
  getDb().insert(schema.metadataAssets).values({id:occupied,data:beforeImage,mediaType:'image/png',byteSize:MAX_RETAINED_COVER_STORE_BYTES-MAX_RETAINED_COVER_BYTES}).run();
  try{
    await assert.rejects(withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();f.state.writes++;}),/budget|storage/);
    assert.equal(f.state.writes,0);assert.ok(getDb().select().from(schema.metadataAssets).where(eq(schema.metadataAssets.id,occupied)).get());
    assert.equal(getDb().select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId,entry(f.id).id)).get()!.reservedBytes,0);
  }finally{getDb().delete(schema.metadataAssets).where(eq(schema.metadataAssets.id,occupied)).run();}
});

test('restart preserves retained cover bytes, marks unfinished observations interrupted and releases readback reservations',async()=>{
  const f=fixture();
  await withMetadataHistory(f.client,f.id,'provider-apply',{},async journal=>{await journal.captureSeriesCover();});
  const operationId=entry(f.id).id;
  getDb().update(schema.metadataOperations).set({status:'running',afterJson:null,finishedAt:null}).where(eq(schema.metadataOperations.id,operationId)).run();
  getDb().update(schema.metadataSeriesCovers).set({status:'applying',afterState:'unavailable',afterAssetId:null,reservedBytes:MAX_RETAINED_COVER_BYTES}).where(eq(schema.metadataSeriesCovers.operationId,operationId)).run();
  const dbUrl=new URL('../src/db/index.ts',import.meta.url).href,historyUrl=new URL('../src/services/metadataHistory.ts',import.meta.url).href;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type','module','--eval',`const {initDb}=await import(${JSON.stringify(dbUrl)});initDb();const {interruptMetadataHistory}=await import(${JSON.stringify(historyUrl)});interruptMetadataHistory();`],{env:{...process.env,HTOSHO_DATA_DIR:directory},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(detail(f.id).status,'interrupted');assert.equal(detail(f.id).covers!.status,'interrupted');
  assert.deepEqual(retainedCoverAsset(f.id,operationId,hash(beforeImage))!.data,beforeImage);
  assert.equal(getDb().select().from(schema.metadataSeriesCovers).where(eq(schema.metadataSeriesCovers.operationId,operationId)).get()!.reservedBytes,0);
});

test('migration 8 and retention preserve active or preview-pinned images and collect only unreferenced assets',()=>{
  const sqlite=new Database(':memory:');migrateSchema(sqlite);
  sqlite.exec('DROP TABLE metadata_series_covers; DROP TABLE metadata_assets; DELETE FROM schema_migrations WHERE version=8');
  migrateSchema(sqlite);migrateSchema(sqlite);
  const insert=sqlite.prepare(`INSERT INTO metadata_operations(id,connection_key,series_id,origin,status,fields_json,desired_json,policy_revision,before_json,created_at,finished_at) VALUES (?,'one',1,'provider-apply','completed','[]','{}',0,'{}','2020-01-01','2020-01-01')`);
  for(let index=0;index<25;index++)insert.run(`old-${index}`);
  const asset=sqlite.prepare('INSERT INTO metadata_assets(id,media_type,byte_size,data) VALUES (?,\'image/png\',?,?)');
  for(const id of ['shared','expired','active','preview','orphan'])asset.run(id,beforeImage.length,beforeImage);
  const ref=sqlite.prepare('INSERT INTO metadata_series_covers(operation_id,before_state,before_asset_id) VALUES (?,\'captured\',?)');
  ref.run('old-0','expired');ref.run('old-1','shared');ref.run('old-2','active');ref.run('old-3','preview');ref.run('old-24','shared');
  sqlite.exec(`INSERT INTO metadata_restore_plans(id,preview_id,connection_key,series_id,source_operation_id,idempotency_key,expected_json,desired_json,native_lock_fields_json,policy_revision,created_at)
    VALUES ('pin','approved','one',1,'old-2','key','{}','{}','[]',0,'2020-01-01');
    INSERT INTO metadata_restore_previews(id,connection_key,series_id,source_operation_id,preview_json,expected_json,desired_json,created_at,expires_at)
    VALUES ('preview','one',1,'old-3','{}','{}','{}','2026-11-16','2026-11-17')`);
  pruneMetadataHistory(sqlite,Date.parse('2026-11-16T12:00:00Z'));
  assert.deepEqual(sqlite.prepare('SELECT id FROM metadata_assets ORDER BY id').all(),[{id:'active'},{id:'preview'},{id:'shared'}]);
  assert.equal(sqlite.prepare("SELECT operation_id FROM metadata_series_covers WHERE operation_id='old-0'").get(),undefined);
  sqlite.close();
});

test('raster inspection and bounded Kavita reads reject active payloads, empty images and oversized streams without logging credentials',async()=>{
  assert.equal(coverMediaType(beforeImage),'image/png');
  for(const data of [Buffer.alloc(0),Buffer.from('<svg/>'),Buffer.from('<html>not an image</html>'),Buffer.from([137,80,78,71])])assert.throws(()=>coverMediaType(data));
  const client=new KavitaClient('https://bounded-cover.test','hidden-secret'),original=globalThis.fetch;
  try{
    let cancelled=false;
    globalThis.fetch=(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_RETAINED_COVER_BYTES+1));},cancel(){cancelled=true;}}))) as typeof fetch;
    await assert.rejects(client.getSeriesCoverForHistory(1),/5 MiB/);assert.equal(cancelled,true);
    globalThis.fetch=(async()=>new Response(null,{status:404})) as typeof fetch;assert.equal(await client.getSeriesCoverForHistory(1),null);
    globalThis.fetch=(async()=>new Response(null,{status:401})) as typeof fetch;
    await assert.rejects(client.getSeriesCoverForHistory(1),error=>error instanceof Error&&!error.message.includes('hidden-secret'));
    globalThis.fetch=(async()=>new Response(beforeImage,{headers:{'content-type':'image/png'}})) as typeof fetch;
    assert.deepEqual((await client.getSeriesCoverForHistory(1))!.data,beforeImage);
  }finally{globalThis.fetch=original;}
});

test('cover storage defaults remain bounded and larger deployments can configure an explicit validated budget',()=>{
  assert.equal(coverStorageBudget(),MAX_RETAINED_COVER_STORE_BYTES);
  assert.equal(coverStorageBudget('1024'),1024*1024*1024);
  for(const value of ['','9','16385','1.5','-1','Infinity','not-a-size'])assert.throws(()=>coverStorageBudget(value),/storage limit/);
});

test('cover capture waits for an explicitly configured storage budget while keeping existing cover updates available',async()=>{
  const f=fixture(),configured=process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB;
  delete process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB;
  try {
    const result=await applyResolvedSeriesMatch(f.client,{seriesId:f.id,providerId:'fixture',providerSeriesId:'one'},
      {providerId:'fixture',providerSeriesId:'one',title:'Same title',coverUrl:'https://provider.test/cover.png',tags:[],genres:[],writers:[],artists:[]});
    assert.equal(result.coverUpdated,true);assert.equal(f.state.writes,1);assert.equal(f.state.reads,0);
    assert.equal(detail(f.id).covers!.status,'not-captured');assert.match(detail(f.id).covers!.before.reason!,/disabled/);
  }finally{process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB=configured;}
});
