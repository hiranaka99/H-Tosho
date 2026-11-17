import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { KavitaClient } from '../src/kavita/client.js';
import { RESTORE_FIELD_MAPPINGS, type ExactMetadataRestoreValues, type ExactMetadataRestoreOptions, type RestoreMetadataCommand, type RestorePreviewRequest } from '../src/contracts/metadataRestore.js';
import { migrateSchema } from '../src/db/migrations.js';
import { pruneMetadataHistory } from '../src/db/metadataRetention.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(),'htosho-metadata-restore-'));
process.env.HTOSHO_DATA_DIR = directory;
// Imports must follow the environment override: db/index captures DATA_DIR at module evaluation.
const { initDb,getDb,schema } = await import('../src/db/index.js');
const { setKavitaConnection } = await import('../src/services/settings.js');
const { saveFieldPolicy } = await import('../src/services/fieldPolicies.js');
const { withMetadataHistory,listMetadataHistory,metadataHistoryDetail } = await import('../src/services/metadataHistory.js');
const { createMetadataRestorePreview,enqueueMetadataRestore,executeMetadataRestore,settleMetadataRestoreJob,interruptMetadataRestore,MetadataRestoreError } = await import('../src/services/metadataRestore.js');
const { api } = await import('../src/routes/api/series.js');
initDb();
setKavitaConnection({baseUrl:'https://restore.test',apiKey:'private-test-key'});
let nextSeriesId = 1;

async function fixture() {
  const id = nextSeriesId++;
  const series: Record<string,unknown> = {id,libraryId:7,name:'Series',folderPath:'/private/library/series',nameLocked:false};
  const metadata: Record<string,unknown> = {seriesId:id,summary:'',genres:[],tags:[],writers:[],pencillers:[],releaseYear:0,
    language:'',publicationStatus:0,webLinks:'',summaryLocked:false,genresLocked:false,tagsLocked:false,
    writerLocked:false,pencillerLocked:false,releaseYearLocked:false,languageLocked:false,publicationStatusLocked:false,
    ageRating:3,ageRatingLocked:true,publishers:[{id:77,name:'Untouched publisher'}]};
  const state = {writes:0,installId:'installation-a',readFailure:false};
  const client = {
    getSeriesDto:async () => structuredClone(series),
    getSeriesMetadata:async () => { if (state.readFailure) throw new Error('Readback unavailable'); return structuredClone(metadata); },
    getServerInfo:async () => ({version:'0.8.9',installId:state.installId}),
    restoreSeriesMetadataExact:async (_id:number,values:ExactMetadataRestoreValues,options:ExactMetadataRestoreOptions) => {
      state.writes++;
      const running = listMetadataHistory(id).items[0];
      assert.equal(running.origin,'metadata-restore');
      assert.equal(running.status,'running');
      assert.equal(running.restoredFromOperationId,operationId);
      const stored = metadataHistoryDetail(id,running.id)!;
      assert.deepEqual(stored.before.fields.summary.value,metadata.summary);
      options.checkCancelled?.();
      for (const [field,cell] of Object.entries(values)) {
        const mapping = RESTORE_FIELD_MAPPINGS[field as keyof typeof RESTORE_FIELD_MAPPINGS];
        metadata[mapping.key] = structuredClone(cell!.value);
        if (options.nativeLockFields.includes(field as keyof typeof RESTORE_FIELD_MAPPINGS) && 'lock' in mapping) {
          metadata[mapping.lock] = cell!.nativeLocked;
        }
      }
    },
  } as unknown as KavitaClient;
  await withMetadataHistory(client,id,'provider-apply',{summary:'New summary',tags:['Added tag']},async () => {
    metadata.summary = 'New summary';
    metadata.tags = [{id:9,title:'Added tag'}];
    metadata.writers = [{id:8,name:'New writer'}];
    metadata.summaryLocked = true;
    metadata.tagsLocked = true;
    metadata.webLinks = 'https://example.test';
  });
  const operationId = listMetadataHistory(id).items[0].id;
  return {id,series,metadata,state,client,operationId};
}
function approve(id: number,previewId: string,key = `approval-${id}`) {
  let command: RestoreMetadataCommand | undefined;
  const result = enqueueMetadataRestore(id,previewId,key,approved => {
    command = approved;
    return Number(getDb().insert(schema.jobs).values({type:'restore-metadata',payloadJson:JSON.stringify(approved)}).run().lastInsertRowid);
  });
  assert.ok(command);
  return {command:command!,jobId:result.id};
}

test('exact selective clearing preserves unselected metadata, native flags, and provider approval', async () => {
  const f = await fixture();
  getDb().insert(schema.seriesMatches).values({kavitaSeriesId:f.id,providerId:'fixture',providerSeriesId:'approved',matchScore:1,confirmed:true,metadataJson:'{"accepted":true}'}).run();
  const approvedMatch = getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId,f.id)).get();
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary','tags','writers','url']});
  assert.equal(preview.canRestore,true);
  assert.equal(JSON.stringify(preview).includes('/private/library'),false);
  assert.equal(JSON.stringify(preview).includes('private-test-key'),false);
  assert.equal(preview.fields.find(field => field.field === 'summary')!.restoreTo.value,'');
  const {command,jobId} = approve(f.id,preview.id);
  const result = await executeMetadataRestore(f.client,command,jobId,() => {});
  assert.deepEqual(result.restored,['summary','tags','writers','url']);
  assert.equal(f.metadata.summary,'');
  assert.deepEqual(f.metadata.tags,[]);
  assert.deepEqual(f.metadata.writers,[]);
  assert.equal(f.metadata.webLinks,'');
  assert.equal(f.metadata.summaryLocked,true);
  assert.equal(f.metadata.tagsLocked,true);
  assert.equal(f.metadata.ageRating,3);
  assert.equal(f.metadata.ageRatingLocked,true);
  assert.deepEqual(f.metadata.publishers,[{id:77,name:'Untouched publisher'}]);
  assert.equal(f.series.name,'Series');
  assert.deepEqual(getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId,f.id)).get(),approvedMatch);
  const detail = metadataHistoryDetail(f.id,result.operationId)!;
  assert.equal(detail.status,'completed');
  assert.equal(detail.restoredFromOperationId,f.operationId);
  assert.equal(detail.after!.fields.summary.value,'');
  assert.equal(JSON.stringify(detail).includes('/private/library'),false);
  assert.equal(getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,command.planId)).get()!.status,'completed');
  await assert.rejects(executeMetadataRestore(f.client,command,jobId,() => {}),/finalized/);
  assert.equal(f.state.writes,1);
});

test('explicit selected native-lock restoration changes only captured supported locks', async () => {
  const f = await fixture();
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary','tags'],nativeLockFields:['summary']});
  const queued = approve(f.id,preview.id);
  await executeMetadataRestore(f.client,queued.command,queued.jobId,() => {});
  assert.equal(f.metadata.summaryLocked,false);
  assert.equal(f.metadata.tagsLocked,true);
  const unavailable = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['url'],nativeLockFields:['url']});
  assert.equal(unavailable.canRestore,false);
  assert.match(unavailable.conflicts[0],/unsupported/);
});

test('protection visibly excludes requested fields and blocks changed policy at approval and execution', async () => {
  const f = await fixture();
  await saveFieldPolicy(f.id,['summary'],0);
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary','tags'],nativeLockFields:['summary']});
  assert.deepEqual(preview.requestedFields,['summary','tags']);
  assert.deepEqual(preview.effectiveFields,['tags']);
  assert.deepEqual(preview.nativeLockFields,[]);
  assert.equal(preview.fields[0].protected,true);
  assert.match(preview.fields[0].reason!,/Protected/);
  await saveFieldPolicy(f.id,[],1);
  assert.throws(() => approve(f.id,preview.id),/changed after preview/);
  const fresh = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['tags']});
  const queued = approve(f.id,fresh.id);
  await saveFieldPolicy(f.id,['tags'],2);
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/changed after preview/);
  assert.equal(f.state.writes,0);
  assert.equal(listMetadataHistory(f.id).items[0].status,'failed');
});

test('changed selected values and newly set native locks require a new review without writes', async () => {
  for (const change of ['value','lock']) {
    const f = await fixture();
    const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['writers']});
    const queued = approve(f.id,preview.id);
    if (change === 'value') f.metadata.writers = [{id:31,name:'External writer'}];
    else f.metadata.writerLocked = true;
    await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/changed after preview/);
    assert.equal(f.state.writes,0);
    assert.equal(listMetadataHistory(f.id).items[0].status,'failed');
  }
});

test('list IDs and ordering are not conflicts while unrelated external changes are preserved', async () => {
  const f = await fixture();
  f.metadata.tags = [{id:1,title:'Alpha'},{id:2,title:'Beta'}];
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['tags']});
  assert.equal(preview.fields[0].laterEdit,true);
  const queued = approve(f.id,preview.id);
  f.metadata.tags = [{id:200,title:'Beta'},{id:100,title:'Alpha'}];
  f.metadata.summary = 'Unselected external edit';
  await executeMetadataRestore(f.client,queued.command,queued.jobId,() => {});
  assert.deepEqual(f.metadata.tags,[]);
  assert.equal(f.metadata.summary,'Unselected external edit');
});

test('source and approved identity are scoped to active connection, library, path, and installation', async () => {
  const f = await fixture();
  setKavitaConnection({baseUrl:'https://different.test',apiKey:'other'});
  await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']}),error => error instanceof MetadataRestoreError && error.status === 404);
  setKavitaConnection({baseUrl:'https://restore.test/',apiKey:'fixture'});
  f.series.libraryId = 99;
  const wrongIdentity = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  assert.equal(wrongIdentity.canRestore,false);
  assert.match(wrongIdentity.conflicts[0],/identity/);
  f.series.libraryId = 7;
  for (const change of ['library','path','install','connection']) {
    const item = await fixture();
    const preview = await createMetadataRestorePreview(item.client,item.id,item.operationId,{snapshot:'before',fields:['summary']});
    const queued = approve(item.id,preview.id);
    if (change === 'library') item.series.libraryId = 99;
    if (change === 'path') item.series.folderPath = '/other/series';
    if (change === 'install') item.state.installId = 'installation-b';
    if (change === 'connection') setKavitaConnection({baseUrl:'https://different.test',apiKey:'other'});
    await assert.rejects(executeMetadataRestore(item.client,queued.command,queued.jobId,() => {}),/changed after preview/);
    assert.equal(item.state.writes,0);
    setKavitaConnection({baseUrl:'https://restore.test',apiKey:'fixture'});
  }
});

test('H1 snapshots without path remain restorable and title changes are not source identity authority', async () => {
  const f = await fixture();
  const source = getDb().select().from(schema.metadataOperations).where(eq(schema.metadataOperations.id,f.operationId)).get()!;
  const before = JSON.parse(source.beforeJson);
  delete before.series.folderPath;
  getDb().update(schema.metadataOperations).set({beforeJson:JSON.stringify(before)}).where(eq(schema.metadataOperations.id,f.operationId)).run();
  f.series.name = 'Renamed after operation';
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  assert.equal(preview.canRestore,true);
  const queued = approve(f.id,preview.id);
  await executeMetadataRestore(f.client,queued.command,queued.jobId,() => {});
  assert.equal(f.series.name,'Renamed after operation');
});

test('absence, malformed values, null scalars/lists, and unverified After are visibly unavailable', async () => {
  const f = await fixture();
  const row = getDb().select().from(schema.metadataOperations).where(eq(schema.metadataOperations.id,f.operationId)).get()!;
  const before = JSON.parse(row.beforeJson);
  before.fields.language = {present:false};
  before.fields.genres = {present:true,value:null,nativeLocked:false};
  before.fields.writers = {present:true,value:[{id:1,name:null}],nativeLocked:false};
  before.fields.url = {present:true,value:null};
  getDb().update(schema.metadataOperations).set({beforeJson:JSON.stringify(before),status:'unverified'}).where(eq(schema.metadataOperations.id,f.operationId)).run();
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary','language','genres','writers','url']});
  assert.deepEqual(preview.effectiveFields,['summary']);
  assert.match(preview.fields.find(field => field.field === 'language')!.reason!,/absent/);
  assert.match(preview.fields.find(field => field.field === 'genres')!.reason!,/null/);
  assert.equal(preview.fields.find(field => field.field === 'url')!.restoreTo.value,null);
  assert.equal(preview.fields.find(field => field.field === 'url')!.available,false);
  assert.match(preview.fields.find(field => field.field === 'url')!.reason!,/null/);
  assert.match(preview.fields[0].reason!,/baseline is unverified/);
  const detail = metadataHistoryDetail(f.id,f.operationId)!;
  assert.equal(detail.restoreAvailability.after.every(field => !field.available),true);
  assert.equal(detail.restoreAvailability.before.find(field => field.field === 'summary')!.available,true);
  await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'after',fields:['summary']}),/verification is unavailable/);
});

test('approval is atomic, one-use and idempotent while approved plans survive preview expiry and deletion', async () => {
  const f = await fixture();
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  assert.throws(() => enqueueMetadataRestore(f.id,preview.id,'rollback',() => { throw new Error('Queue unavailable'); }),/Queue unavailable/);
  assert.equal(getDb().select().from(schema.metadataRestorePreviews).where(eq(schema.metadataRestorePreviews.id,preview.id)).get()!.consumedAt,null);
  const queued = approve(f.id,preview.id,'stable-key');
  const duplicate = enqueueMetadataRestore(f.id,preview.id,'stable-key',() => { throw new Error('must not enqueue twice'); });
  assert.equal(duplicate.id,queued.jobId);
  assert.throws(() => approve(f.id,preview.id,'another-key'),/already been approved/);
  const other = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  assert.throws(() => approve(f.id,other.id,'stable-key'),/different preview/);
  getDb().update(schema.metadataRestorePreviews).set({expiresAt:'2000-01-01T00:00:00Z'}).where(eq(schema.metadataRestorePreviews.id,other.id)).run();
  assert.throws(() => approve(f.id,other.id,'expired-key'),/expired/);
  getDb().delete(schema.metadataRestorePreviews).where(eq(schema.metadataRestorePreviews.id,preview.id)).run();
  await executeMetadataRestore(f.client,queued.command,queued.jobId,() => {});
  assert.equal(f.metadata.summary,'');
  await assert.rejects(executeMetadataRestore(f.client,{...queued.command,seriesId:f.id + 1000},queued.jobId,() => {}),/approved job/);
});

test('strict allowlists reject client values, paths, duplicate fields, and unbounded approval keys', async () => {
  const f = await fixture();
  for (const body of [null,{snapshot:'before',fields:['summary'],values:{summary:'attack'}},
    {snapshot:'before',fields:['cover']},{snapshot:'before',fields:['summary','summary']},
    {snapshot:'before',fields:['summary'],nativeLockFields:['tags']}]) {
    await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,body as RestorePreviewRequest),error => error instanceof MetadataRestoreError && error.status === 400);
  }
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  assert.throws(() => approve(f.id,preview.id,'x'.repeat(129)),/Invalid idempotency/);
  assert.throws(() => approve(f.id,preview.id,'/server/path'),/Invalid idempotency/);
  const badBody = await api.request(`/series/${f.id}/metadata-restore`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({previewId:preview.id,idempotencyKey:'valid',desired:{summary:'attack'}})});
  assert.equal(badBody.status,400);
});

test('partial failures and cancellations capture observed after values and never repeat writes', async () => {
  for (const cancelled of [false,true]) {
    const f = await fixture();
    const error = new Error(cancelled ? 'Cancelled' : 'Transport lost after first field');
    if (cancelled) error.name = 'JobCancelled';
    f.client.restoreSeriesMetadataExact = async () => { f.state.writes++; f.metadata.summary = null; throw error; };
    const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary','tags']});
    const queued = approve(f.id,preview.id);
    await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),caught => caught === error);
    const detail = metadataHistoryDetail(f.id,listMetadataHistory(f.id).items[0].id)!;
    assert.equal(detail.status,cancelled ? 'cancelled' : 'partial');
    assert.equal(detail.after!.fields.summary.value,null);
    assert.deepEqual(detail.after!.fields.tags.value,[{id:9,title:'Added tag'}]);
    await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/finalized/);
    assert.equal(f.state.writes,1);
  }
});

test('no-op, altered final locks, failed readback and changed unselected values are unverified', async () => {
  for (const mode of ['noop','lock','readback','unselected']) {
    const f = await fixture();
    f.client.restoreSeriesMetadataExact = async () => {
      f.state.writes++;
      if (mode !== 'noop') f.metadata.summary = '';
      if (mode === 'lock') f.metadata.summaryLocked = false;
      if (mode === 'readback') f.state.readFailure = true;
      if (mode === 'unselected') f.metadata.tags = [];
    };
    const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
    const queued = approve(f.id,preview.id);
    await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/verification failed/);
    const entry = listMetadataHistory(f.id).items[0];
    assert.equal(entry.status,'unverified');
    if (mode === 'readback') assert.equal(metadataHistoryDetail(f.id,entry.id)!.after,null);
    assert.equal(f.state.writes,1);
  }
});

test('restart preserves queued approvals but interrupts attempted and terminal plans; cancellation releases pins', async () => {
  const queuedFixture = await fixture();
  const queuedPreview = await createMetadataRestorePreview(queuedFixture.client,queuedFixture.id,queuedFixture.operationId,{snapshot:'before',fields:['summary']});
  const queued = approve(queuedFixture.id,queuedPreview.id);
  const attemptedFixture = await fixture();
  const attemptedPreview = await createMetadataRestorePreview(attemptedFixture.client,attemptedFixture.id,attemptedFixture.operationId,{snapshot:'before',fields:['summary']});
  const attempted = approve(attemptedFixture.id,attemptedPreview.id);
  getDb().update(schema.metadataRestorePlans).set({status:'running',operationId:attemptedFixture.operationId}).where(eq(schema.metadataRestorePlans.id,attempted.command.planId)).run();
  getDb().update(schema.metadataOperations).set({status:'running'}).where(eq(schema.metadataOperations.id,attemptedFixture.operationId)).run();
  interruptMetadataRestore();
  assert.equal(getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).get()!.status,'approved');
  assert.equal(getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,attempted.command.planId)).get()!.status,'interrupted');
  assert.equal(metadataHistoryDetail(attemptedFixture.id,attemptedFixture.operationId)!.status,'interrupted');
  await assert.rejects(executeMetadataRestore(attemptedFixture.client,attempted.command,attempted.jobId,() => {}),/finalized/);
  settleMetadataRestoreJob(queued.jobId,'cancelled','User cancelled before start');
  assert.equal(getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).get()!.status,'cancelled');
  assert.equal(queuedFixture.state.writes,0);
});

test('migration 6 upgrades existing history without rewriting it and fresh tables support durable plans', () => {
  const sqlite = new Database(':memory:');
  migrateSchema(sqlite);
  sqlite.exec(`DROP TABLE metadata_restore_plans; DROP TABLE metadata_restore_previews;
    ALTER TABLE metadata_operations DROP COLUMN restored_from_operation_id; DELETE FROM schema_migrations WHERE version=6;
    INSERT INTO metadata_operations (id,connection_key,series_id,origin,fields_json,desired_json,policy_revision,before_json,created_at)
    VALUES ('legacy','https://restore.test',1,'provider-apply','[]','{}',0,'{"legacy":true}','2020-01-01')`);
  migrateSchema(sqlite); migrateSchema(sqlite);
  const legacy = sqlite.prepare("SELECT before_json,restored_from_operation_id FROM metadata_operations WHERE id='legacy'").get() as {before_json:string;restored_from_operation_id:null};
  assert.equal(legacy.before_json,'{"legacy":true}');
  assert.equal(legacy.restored_from_operation_id,null);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='metadata_restore_plans'").get());
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='metadata_restore_previews'").get());
  sqlite.close();
});

test('retention pins source and linked active operations independently of expired previews, then releases terminal pins', () => {
  const sqlite = new Database(':memory:'); migrateSchema(sqlite);
  const insert = sqlite.prepare(`INSERT INTO metadata_operations
    (id,connection_key,series_id,origin,status,fields_json,desired_json,policy_revision,before_json,created_at,finished_at)
    VALUES (?,'https://restore.test',1,'fixture','completed','[]','{}',0,'{}','2020-01-01','2020-01-01')`);
  for (let i = 0; i < 30; i++) insert.run(`old-${i}`);
  sqlite.prepare(`INSERT INTO metadata_restore_plans
    (id,preview_id,connection_key,series_id,source_operation_id,operation_id,idempotency_key,expected_json,desired_json,native_lock_fields_json,policy_revision,created_at)
    VALUES ('pin','approved-preview','https://restore.test',1,'old-0','old-1','pin-key','{}','{}','[]',0,'2020-01-01')`).run();
  const preview = sqlite.prepare(`INSERT INTO metadata_restore_previews
    (id,connection_key,series_id,source_operation_id,preview_json,expected_json,desired_json,created_at,expires_at,consumed_at)
    VALUES (?,'https://restore.test',1,?,'{}','{}','{}','2020-01-01',?,?)`);
  preview.run('expired','old-2','2020-01-01',null);
  preview.run('valid','old-3','2030-01-01',null);
  preview.run('consumed','old-4','2020-01-01','2020-01-01');
  const date = Date.parse('2026-11-16T12:00:00Z');
  pruneMetadataHistory(sqlite,date);
  assert.ok(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='old-0'").get());
  assert.ok(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='old-1'").get());
  assert.ok(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='old-3'").get());
  assert.equal(sqlite.prepare("SELECT id FROM metadata_restore_previews WHERE id='expired'").get(),undefined);
  assert.equal(sqlite.prepare("SELECT id FROM metadata_restore_previews WHERE id='consumed'").get(),undefined);
  sqlite.prepare("UPDATE metadata_restore_plans SET status='cancelled' WHERE id='pin'").run();
  pruneMetadataHistory(sqlite,date);
  assert.equal(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='old-0'").get(),undefined);
  assert.equal(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='old-1'").get(),undefined);
  sqlite.close();
});

test('After restoration uses server-derived observed values rather than provider payload or current values', async () => {
  const f = await fixture();
  f.metadata.summary = 'Later edit';
  f.metadata.tags = [{id:300,title:'Later tag'}];
  f.metadata.summaryLocked = false;
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'after',fields:['summary','tags'],nativeLockFields:['summary']});
  assert.equal(preview.fields[0].laterEdit,true);
  assert.equal(preview.fields[0].restoreTo.value,'New summary');
  const queued = approve(f.id,preview.id);
  await executeMetadataRestore(f.client,queued.command,queued.jobId,() => {});
  assert.equal(f.metadata.summary,'New summary');
  assert.deepEqual(f.metadata.tags,[{id:9,title:'Added tag'}]);
  assert.equal(f.metadata.summaryLocked,true);
});

test('failed authoritative reads never write; missing captured installation evidence blocks approval execution', async () => {
  const f = await fixture();
  f.state.readFailure = true;
  await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']}),error => error instanceof MetadataRestoreError && error.status === 502);
  f.state.readFailure = false;
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  const queued = approve(f.id,preview.id);
  f.state.readFailure = true;
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/Readback unavailable/);
  assert.equal(f.state.writes,0);
  assert.equal(getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).get()!.status,'failed');
  const missing = await fixture();
  const missingPreview = await createMetadataRestorePreview(missing.client,missing.id,missing.operationId,{snapshot:'before',fields:['summary']});
  const missingQueued = approve(missing.id,missingPreview.id);
  missing.state.installId = '';
  await assert.rejects(executeMetadataRestore(missing.client,missingQueued.command,missingQueued.jobId,() => {}),/identity changed after preview/);
  assert.equal(missing.state.writes,0);
});

test('metadata remains observed when post-write installation verification fails', async () => {
  const f = await fixture();
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  const queued = approve(f.id,preview.id);
  f.client.restoreSeriesMetadataExact = async () => {
    f.state.writes++;
    f.metadata.summary = '';
    f.client.getServerInfo = async () => { throw new Error('Installation read unavailable'); };
  };
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/verification failed/);
  const detail = metadataHistoryDetail(f.id,listMetadataHistory(f.id).items[0].id)!;
  assert.equal(detail.status,'unverified');
  assert.equal(detail.after!.fields.summary.value,'');
  assert.match(detail.message!,/installation identity/);
});

test('terminal queued approvals are interrupted on restart and cannot be revived through a persisted command', async () => {
  const f = await fixture();
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  const queued = approve(f.id,preview.id);
  getDb().update(schema.jobs).set({status:'failed'}).where(eq(schema.jobs.id,queued.jobId)).run();
  interruptMetadataRestore();
  assert.equal(getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).get()!.status,'interrupted');
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,() => {}),/finalized/);
  assert.equal(f.state.writes,0);
});

test('current null does not prevent an exactly representable historical empty value from being restored', async () => {
  const f = await fixture();
  f.metadata.summary = null;
  const preview = await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']});
  assert.equal(preview.canRestore,true);
  assert.equal(preview.fields[0].current.value,null);
  assert.equal(preview.fields[0].restoreTo.value,'');
  const queued = approve(f.id,preview.id);
  await executeMetadataRestore(f.client,queued.command,queued.jobId,() => {});
  assert.equal(f.metadata.summary,'');
});

test('a mismatched live metadata series never becomes preview or approved write authority', async () => {
  const f = await fixture();
  f.metadata.seriesId = f.id + 999;
  await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['summary']}),error => error instanceof MetadataRestoreError && error.status === 502);
  assert.equal(f.state.writes,0);
});
