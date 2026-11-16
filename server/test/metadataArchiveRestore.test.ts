import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import type { KavitaClient } from '../src/kavita/client.js';
import type { RestoreMetadataCommand, ExactMetadataRestoreValues, ExactMetadataRestoreOptions, RestorePreviewRequest } from '../src/contracts/metadataRestore.js';
import { buildZip } from '../src/downloader/zip.js';
import { captureArchiveSnapshot, readComicInfo, readZipEntries, readZipEntry, rewriteZipEntry, restoreComicInfoArchive } from '../src/lib/cbz.js';
import { spawnSync } from 'node:child_process';
import { comicInfoSeries, restoreComicInfoFields, restoreComicInfoSeries } from '../src/lib/comicInfoRestore.js';
import { archiveMutations, archiveResource } from '../src/lib/mutations.js';
import { migrateSchema } from '../src/db/migrations.js';
import { pruneMetadataHistory } from '../src/db/metadataRetention.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(),'htosho-archive-restore-'));
process.env.HTOSHO_DATA_DIR=directory;
const {initDb,getDb,schema}=await import('../src/db/index.js');
const {setKavitaConnection,setDownloaderSettings,getDownloaderSettings}=await import('../src/services/settings.js');
const {saveFieldPolicy}=await import('../src/services/fieldPolicies.js');
const {withMetadataHistory,listMetadataHistory,metadataHistoryDetail}=await import('../src/services/metadataHistory.js');
const {createMetadataRestorePreview,enqueueMetadataRestore,executeMetadataRestore,interruptMetadataRestore}=await import('../src/services/metadataRestore.js');
initDb();
setKavitaConnection({baseUrl:'https://archive-restore.test',apiKey:'private-key'});
let nextId=1000;
const oldXml = '<ComicInfo vendor="keep"><Series>Old</Series><!-- keep comment --><Summary><![CDATA[Saved summary]]></Summary><Pages><Page Image="0" Bookmark="Keep"/></Pages><Unknown flag="1">keep</Unknown></ComicInfo>';

async function fixture(options:{absent?:boolean;files?:number}={}) {
  const id=nextId++, root=path.join(directory,'library'), folder=path.join(root,String(id));
  fs.mkdirSync(folder,{recursive:true});
  setDownloaderSettings({...getDownloaderSettings(),libraryPathMappings:[{kavitaPath:'/remote/library',localPath:root}]});
  const files=Array.from({length:options.files??2},(_,index)=>path.join(folder,`chapter-${index+1}.cbz`));
  const initial=options.absent?null:oldXml;
  for (const file of files) fs.writeFileSync(file,buildZip([{name:'001.jpg',data:Buffer.from('immutable page')},...(initial===null?[]:[{name:'ComicInfo.xml',data:Buffer.from(initial)}]),{name:'extra.bin',data:Buffer.from([0,1,2,3])}]));
  const series={id,libraryId:7,name:options.absent?'Same':'Old',folderPath:`/remote/library/${id}`,nameLocked:false,
    sortName:'Keep sort',sortNameLocked:false,localizedName:null,localizedNameLocked:false,coverImageLocked:true};
  const metadata={id:5,seriesId:id,summary:'Saved description',summaryLocked:false,tags:[],tagsLocked:false};
  const state={writes:0,fail:false,noOp:false,readFailure:false,cancel:false,indexed:[...files]};
  const client={
    getSeriesDto:async()=>structuredClone(series),
    getSeriesMetadata:async()=>{if(state.readFailure)throw new Error('No readback');return structuredClone(metadata);},
    getServerInfo:async()=>({version:'0.9.1',installId:'same-installation'}),
    getLibraries:async()=>[{id:7,path:'/remote/library',paths:['/remote/library']}],
    getChaptersBySeries:async()=>state.indexed.map((file,index)=>({id:index+1,files:[{id:index+1,filePath:`/remote/library/${id}/${path.basename(file)}`}]})),
    restoreSeriesMetadataExact:async(_id:number,values:ExactMetadataRestoreValues,opts:ExactMetadataRestoreOptions)=>{
      state.writes++;
      if(values.title) {
        for(const file of files)assert.equal(comicInfoSeries(await readComicInfo(file)),values.title.value,'Every CBZ must be paired before remote title write');
        if(!state.noOp)series.name=values.title.value as string;
        if(opts.nativeLockFields.includes('title'))series.nameLocked=values.title.nativeLocked!;
      }
      if(values.summary)metadata.summary=values.summary.value as string;
      if(state.fail)throw new Error('Remote mutation failed after publication');
    },
  } as unknown as KavitaClient;
  await withMetadataHistory(client,id,options.absent?'comicinfo-edit':'provider-apply',options.absent?{archives:true}:{title:'Renamed'},async journal=>{
    await journal.captureArchives(files);
    for(const file of files)await rewriteZipEntry(file,'ComicInfo.xml',Buffer.from(options.absent?'<ComicInfo><Summary>New</Summary></ComicInfo>':restoreComicInfoSeries(oldXml,'Renamed').replace('Saved summary','New summary')));
    if(!options.absent)series.name='Renamed';
    series.nameLocked=true; metadata.summary='Current description';
  });
  const operationId=listMetadataHistory(id).items[0].id;
  const detail=metadataHistoryDetail(id,operationId)!;
  return {id,root,folder,files,series,metadata,state,client,operationId,detail};
}
function approve(id:number,previewId:string) {
  let command!:RestoreMetadataCommand;
  const result=enqueueMetadataRestore(id,previewId,`approve-${id}`,value=>{
    command=value;return Number(getDb().insert(schema.jobs).values({type:'restore-metadata',payloadJson:JSON.stringify(value)}).run().lastInsertRowid);
  });
  return {command,jobId:result.id};
}

test('lossless selected XML restoration keeps root attributes, comments, nested XML, empty elements and absence',()=>{
  const live='<ComicInfo custom="retained">\n<!-- note --><Summary flag="live">New</Summary><Year>2026</Year><Pages><Page Image="0" Type="FrontCover"/></Pages><Unknown foo="1"/></ComicInfo>';
  const saved='<ComicInfo><Summary flag="saved"><![CDATA[ Old & exact ]]></Summary><Title/></ComicInfo>';
  assert.equal(restoreComicInfoFields(live,saved,['Summary','Year','Title']),'<ComicInfo custom="retained">\n<!-- note --><Summary flag="saved"><![CDATA[ Old & exact ]]></Summary><Pages><Page Image="0" Type="FrontCover"/></Pages><Unknown foo="1"/><Title/>\n</ComicInfo>');
  assert.equal(restoreComicInfoFields(null,null,['Summary']),null);
  assert.equal(comicInfoSeries(restoreComicInfoSeries(live,'Custom & <historical>')),'Custom & <historical>');
  assert.equal(comicInfoSeries(restoreComicInfoSeries('<ComicInfo custom="kept"/>','Added')),'Added');
  assert.equal(restoreComicInfoFields('<ComicInfo/>','<ComicInfo><Title/></ComicInfo>',['Title']),'<ComicInfo><Title/>\n</ComicInfo>');
  assert.equal(comicInfoSeries('<ComicInfo><Series><![CDATA[A ]]]]><![CDATA[> B]]></Series></ComicInfo>'),'A ]]> B');
  for(const xml of ['<ComicInfo><Summary>a</Summary><Summary>b</Summary></ComicInfo>','<ComicInfo><Pages></ComicInfo>','<!DOCTYPE ComicInfo [<!ENTITY x SYSTEM "file:///secret">]><ComicInfo/>','<ComicInfo><Summary>&external;</Summary></ComicInfo>','<ComicInfo wrong=unquoted></ComicInfo>']) {
    assert.throws(()=>restoreComicInfoFields(xml,saved,['Summary']),/malformed|ambiguous|unsupported entity/);
  }
});

test('entry removal preserves original page headers, extras, attributes, comments and data descriptors',async()=>{
  const file=path.join(directory,'zip-preservation.cbz');
  const original=buildZip([{name:'001.jpg',data:Buffer.from('immutable page')},{name:'ComicInfo.xml',data:Buffer.from('<ComicInfo/>')}]);
  const extra=Buffer.from([0xfe,0xca,2,0,0x12,0x34]),note=Buffer.from('page note');
  const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
  for(const entry of readZipEntries(original)) {
    const local=Buffer.from(original.subarray(entry.localOffset,entry.localOffset+30));
    const nameLength=local.readUInt16LE(26),oldExtraLength=local.readUInt16LE(28);
    const name=original.subarray(entry.localOffset+30,entry.localOffset+30+nameLength);
    const start=entry.localOffset+30+nameLength+oldExtraLength;
    const page=entry.name==='001.jpg',addedExtra=page?extra:Buffer.alloc(0),comment=page?note:Buffer.alloc(0);
    local.writeUInt16LE(addedExtra.length,28);
    const central=Buffer.from(entry.centralRecord.subarray(0,46));
    central.writeUInt16LE(addedExtra.length,30);central.writeUInt16LE(comment.length,32);central.writeUInt32LE(offset,42);
    let descriptor=Buffer.alloc(0);
    if(page) {
      local.writeUInt16LE(entry.flags|8,6);local.writeUInt32LE(0,14);local.writeUInt32LE(0,18);local.writeUInt32LE(0,22);
      central.writeUInt16LE(entry.flags|8,8);central.writeUInt32LE((0o100644<<16)>>>0,38);
      descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(entry.crc,4);descriptor.writeUInt32LE(entry.compressedSize,8);descriptor.writeUInt32LE(entry.uncompressedSize,12);
    }
    const record=Buffer.concat([local,name,addedExtra,original.subarray(start,start+entry.compressedSize),descriptor]);
    locals.push(record);centrals.push(Buffer.concat([central,name,addedExtra,comment]));offset+=record.length;
  }
  const archiveComment=Buffer.from('collection comment'),end=Buffer.alloc(22),centralSize=centrals.reduce((size,item)=>size+item.length,0);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(centrals.length,8);end.writeUInt16LE(centrals.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(archiveComment.length,20);
  const archive=Buffer.concat([...locals,...centrals,end,archiveComment]);fs.writeFileSync(file,archive);
  const expected=await captureArchiveSnapshot(file);
  await archiveMutations.run([archiveResource(file)],()=>restoreComicInfoArchive(file,null,expected));
  const restored=fs.readFileSync(file),entries=readZipEntries(restored);
  assert.equal(entries.length,1);assert.equal(await readComicInfo(file),null);
  assert.deepEqual(restored.subarray(0,locals[0].length),locals[0]);
  assert.deepEqual(entries[0].centralRecord,centrals[0]);
  assert.deepEqual(restored.subarray(-archiveComment.length),archiveComment);
  assert.deepEqual(readZipEntry(restored,'001.jpg'),Buffer.from('immutable page'));
});

test('title restoration pairs every indexed CBZ, preserves current unrelated XML, native locks and linked history',async()=>{
  const f=await fixture();
  await rewriteZipEntry(f.files[0],'ComicInfo.xml',Buffer.from((await readComicInfo(f.files[0]))!.replace('Bookmark="Keep"','Bookmark="Newer"')));
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
  assert.equal(preview.canRestore,true);assert.equal(preview.archives!.length,2);
  assert.equal(JSON.stringify(preview).includes(f.root),false);
  const queued=approve(f.id,preview.id);
  const result=await executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{});
  assert.equal(f.series.name,'Old');assert.equal(f.series.nameLocked,true);assert.equal(f.state.writes,1);
  assert.match((await readComicInfo(f.files[0]))!,/Bookmark="Newer"/);
  assert.match((await readComicInfo(f.files[0]))!,/New summary/);
  const restored=metadataHistoryDetail(f.id,result.operationId)!;
  assert.equal(restored.status,'completed');assert.equal(restored.archives.length,2);
  assert.ok(restored.archives.every(file=>file.status==='observed'));assert.equal(restored.restoredFromOperationId,f.operationId);
  for(const file of f.files)assert.deepEqual(readZipEntry(fs.readFileSync(file),'001.jpg'),Buffer.from('immutable page'));
});

test('selected archive fields restore exactly while unrelated newer XML and remote metadata are retained',async()=>{
  const f=await fixture();
  const xml=(await readComicInfo(f.files[0]))!.replace('<Unknown flag="1">keep</Unknown>','<Unknown flag="2">newer</Unknown><Year>2026</Year>');
  await rewriteZipEntry(f.files[0],'ComicInfo.xml',Buffer.from(xml));
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id:f.detail.archives[0].id,mode:'fields',fields:['Summary','Year']}]});
  assert.equal(preview.canRestore,true);assert.equal(preview.archives![0].laterEdit,true);
  const queued=approve(f.id,preview.id);await executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{});
  const restored=(await readComicInfo(f.files[0]))!;
  assert.match(restored,/Saved summary/);assert.match(restored,/<Unknown flag="2">newer<\/Unknown>/);assert.doesNotMatch(restored,/<Year>/);
  assert.equal(comicInfoSeries(restored),'Renamed');assert.equal(f.metadata.summary,'Current description');assert.equal(f.state.writes,0);
});

test('complete XML replacement needs explicit selection and must agree with a paired title',async()=>{
  const f=await fixture();
  const selection={id:f.detail.archives[0].id,mode:'document' as const};
  const conflict=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[selection]});
  assert.equal(conflict.canRestore,false);assert.match(conflict.conflicts.join(' '),/grouping/);
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title'],nativeLockFields:['title'],archives:[selection]});
  assert.equal(preview.canRestore,true);
  const queued=approve(f.id,preview.id);await executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{});
  assert.equal(await readComicInfo(f.files[0]),oldXml);assert.equal(f.series.nameLocked,false);
});

test('an explicitly selected absent ComicInfo entry is removed with every other ZIP entry preserved',async()=>{
  const f=await fixture({absent:true,files:1});
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id:f.detail.archives[0].id,mode:'document'}]});
  assert.equal(preview.canRestore,true);
  const queued=approve(f.id,preview.id);await executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{});
  assert.equal(await readComicInfo(f.files[0]),null);
  assert.deepEqual(readZipEntry(fs.readFileSync(f.files[0]),'extra.bin'),Buffer.from([0,1,2,3]));
  assert.deepEqual(readZipEntry(fs.readFileSync(f.files[0]),'001.jpg'),Buffer.from('immutable page'));
});

for(const change of ['xml','same-size-pages','membership','mount','native-lock','protection','missing'] as const) test(`${change} after title approval blocks every file and remote write`,async()=>{
  const f=await fixture();
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
  const queued=approve(f.id,preview.id);
  if(change==='xml')await rewriteZipEntry(f.files[0],'ComicInfo.xml',Buffer.from('<ComicInfo><Series>Later</Series></ComicInfo>'));
  if(change==='same-size-pages') {
    const stat=fs.statSync(f.files[0]),data=fs.readFileSync(f.files[0]);
    const index=data.indexOf(Buffer.from('immutable page')); assert.ok(index>=0);data[index]=data[index]^1;
    fs.writeFileSync(f.files[0],data);fs.utimesSync(f.files[0],stat.atime,stat.mtime);
  }
  if(change==='membership')f.state.indexed.pop();
  if(change==='mount')setDownloaderSettings({...getDownloaderSettings(),libraryPathMappings:[]});
  if(change==='native-lock')f.series.nameLocked=false;
  if(change==='protection')await saveFieldPolicy(f.id,['title'],0);
  if(change==='missing')fs.unlinkSync(f.files[0]);
  const remaining=fs.existsSync(f.files[1])?fs.readFileSync(f.files[1]):null;
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{}));
  assert.equal(f.state.writes,0);assert.equal(f.series.name,'Renamed');
  assert.deepEqual(fs.readFileSync(f.files[1]),remaining);
});

test('unindexed files, unavailable mounts and replaced source content make previews non-restorable',async()=>{
  for(const kind of ['extra','mount','content']) {
    const f=await fixture();
    if(kind==='extra')fs.copyFileSync(f.files[0],path.join(f.folder,'unindexed.cbz'));
    if(kind==='mount')setDownloaderSettings({...getDownloaderSettings(),libraryPathMappings:[]});
    if(kind==='content')await rewriteZipEntry(f.files[0],'001.jpg',Buffer.from('different page'));
    const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id:f.detail.archives[0].id,mode:'fields',fields:['Summary']}]});
    assert.equal(preview.canRestore,false);assert.ok(preview.conflicts.length);
  }
});

test('saved paths and unrelated operation step IDs cannot authorize filesystem targets',async()=>{
  const f=await fixture(),other=await fixture();
  for(const id of [other.detail.archives[0].id,f.detail.archives[0].id]) {
    if(id===f.detail.archives[0].id)getDb().update(schema.metadataOperationSteps).set({target:path.join(directory,'outside.cbz')}).where(eq(schema.metadataOperationSteps.id,id)).run();
    const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id,mode:'document'}]});
    assert.equal(preview.canRestore,false);
  }
});

test('legacy snapshots without non-XML identity remain browseable but visibly unavailable for XML restoration',async()=>{
  const f=await fixture();
  const row=getDb().select().from(schema.metadataOperationSteps).where(eq(schema.metadataOperationSteps.id,f.detail.archives[0].id)).get()!;
  const snapshot=JSON.parse(row.beforeJson);delete snapshot.contentHash;
  getDb().update(schema.metadataOperationSteps).set({beforeJson:JSON.stringify(snapshot)}).where(eq(schema.metadataOperationSteps.id,row.id)).run();
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id:row.id,mode:'document'}]});
  assert.equal(preview.canRestore,false);assert.match(preview.conflicts.join(' '),/older snapshot/);
  assert.equal(metadataHistoryDetail(f.id,f.operationId)!.archives.length,2);
});

test('verified archive After steps remain selectable independently of unverified remote metadata',async()=>{
  const f=await fixture();
  getDb().update(schema.metadataOperations).set({status:'unverified',afterJson:null}).where(eq(schema.metadataOperations.id,f.operationId)).run();
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'after',fields:[],archives:[{id:f.detail.archives[0].id,mode:'fields',fields:['Summary']}]});
  assert.equal(preview.canRestore,true);
  await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'after',fields:['summary']}),/snapshot was not captured/);
});

test('missing title preservation capabilities block a preview before any archive or remote mutation',async()=>{
  const f=await fixture();
  delete (f.series as Partial<typeof f.series>).sortNameLocked;
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
  assert.equal(preview.canRestore,false);assert.match(preview.fields[0].reason!,/sort-name/);assert.equal(f.state.writes,0);
});

test('complete XML replacement respects every protected family while a selected unrelated XML field remains available',async()=>{
  const f=await fixture({absent:true,files:1});
  await saveFieldPolicy(f.id,['status','cover'],0);
  const full=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id:f.detail.archives[0].id,mode:'document'}]});
  assert.equal(full.canRestore,false);assert.match(full.conflicts.join(' '),/protected/);
  const selected=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives:[{id:f.detail.archives[0].id,mode:'fields',fields:['Summary']}]});
  assert.equal(selected.canRestore,true);
});

test('title preview enforces cumulative XML snapshot budgets before approving an oversized file set',async()=>{
  const f=await fixture();
  const xml='<ComicInfo><Series>Renamed</Series><Summary>'+'x'.repeat(9*1024*1024)+'</Summary></ComicInfo>';
  for(const file of f.files)await rewriteZipEntry(file,'ComicInfo.xml',Buffer.from(xml));
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
  assert.equal(preview.canRestore,false);assert.match(preview.conflicts.join(' '),/16 MiB budget/);assert.equal(f.state.writes,0);
});

test('partial remote failure and cancellation retain observed file checkpoints and require a new preview',async()=>{
  for(const mode of ['failure','cancel'] as const) {
    const f=await fixture();f.state.fail=mode==='failure';
    const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
    const queued=approve(f.id,preview.id);
    await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{
      if(mode==='cancel'&&f.state.writes){const error=new Error('Cancelled');error.name='JobCancelled';throw error;}
    }));
    const entry=listMetadataHistory(f.id).items[0],detail=metadataHistoryDetail(f.id,entry.id)!;
    assert.equal(entry.status,mode==='failure'?'partial':'cancelled');assert.ok(detail.archives.every(item=>item.status==='observed'));
    await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{}),/finalized/);
    assert.equal(f.state.writes,1);
  }
});

test('interrupted archive checkpoints survive restart and never replay an attempted approved plan',async()=>{
  const f=await fixture();
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
  const queued=approve(f.id,preview.id);
  getDb().update(schema.metadataRestorePlans).set({status:'running',operationId:f.operationId}).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).run();
  getDb().update(schema.metadataOperations).set({status:'running'}).where(eq(schema.metadataOperations.id,f.operationId)).run();
  interruptMetadataRestore();
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{}),/finalized/);
  assert.equal(metadataHistoryDetail(f.id,f.operationId)!.status,'interrupted');assert.equal(f.state.writes,0);
  const stored=getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).get()!;
  assert.equal(JSON.parse(stored.archivesJson).length,2);
});

test('a separate process restart keeps approved archives and interrupts attempted file checkpoints without replay',async()=>{
  const f=await fixture();
  const preview=await createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:['title']});
  const queued=approve(f.id,preview.id);
  getDb().update(schema.metadataRestorePlans).set({status:'running',operationId:f.operationId}).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).run();
  getDb().update(schema.metadataOperations).set({status:'running'}).where(eq(schema.metadataOperations.id,f.operationId)).run();
  const before=fs.readFileSync(f.files[0]);
  const moduleUrl=new URL('../src/services/metadataRestore.ts',import.meta.url).href;
  const dbUrl=new URL('../src/db/index.ts',import.meta.url).href;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type','module','--eval',`const {initDb}=await import(${JSON.stringify(dbUrl)});initDb();const {interruptMetadataRestore}=await import(${JSON.stringify(moduleUrl)});interruptMetadataRestore();`],
    {env:{...process.env,HTOSHO_DATA_DIR:directory},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const stored=getDb().select().from(schema.metadataRestorePlans).where(eq(schema.metadataRestorePlans.id,queued.command.planId)).get()!;
  assert.equal(stored.status,'interrupted');assert.equal(JSON.parse(stored.archivesJson).length,2);
  assert.equal(metadataHistoryDetail(f.id,f.operationId)!.archives.length,2);
  assert.deepEqual(fs.readFileSync(f.files[0]),before);
  await assert.rejects(executeMetadataRestore(f.client,queued.command,queued.jobId,()=>{}),/finalized/);
});

test('archive command payloads reject paths, arbitrary XML, unknown fields and duplicate targets',async()=>{
  const f=await fixture(),id=f.detail.archives[0].id;
  for(const archives of [[{id,mode:'document',xml:'attack'}],[{id,mode:'fields',fields:['Pages']}],[{id,mode:'fields',fields:[]}],[{id,mode:'document'},{id,mode:'document'}],[{id,mode:'document',target:f.files[0]}]]) {
    await assert.rejects(createMetadataRestorePreview(f.client,f.id,f.operationId,{snapshot:'before',fields:[],archives} as RestorePreviewRequest),/Invalid restore/);
  }
});

test('stale atomic publication and ZIP removal failures leave current files and unrelated entries intact',async()=>{
  const f=await fixture({absent:true,files:1}),file=f.files[0];
  const expected=await captureArchiveSnapshot(file);
  await rewriteZipEntry(file,'extra.bin',Buffer.from('later edit'));
  const current=fs.readFileSync(file);
  await assert.rejects(archiveMutations.run([archiveResource(file)],()=>restoreComicInfoArchive(file,null,expected)),/changed after preview/);
  assert.deepEqual(fs.readFileSync(file),current);
  assert.ok(fs.readdirSync(f.folder).every(name=>!name.startsWith('.cbztmp-')));
});

test('migration 7 upgrades existing approvals without inventing archive authority and applies once',()=>{
  const sqlite=new Database(':memory:');migrateSchema(sqlite);
  sqlite.exec("ALTER TABLE metadata_restore_previews DROP COLUMN archives_json; ALTER TABLE metadata_restore_plans DROP COLUMN archives_json; DELETE FROM schema_migrations WHERE version=7");
  sqlite.prepare(`INSERT INTO metadata_restore_plans(id,preview_id,connection_key,series_id,source_operation_id,idempotency_key,expected_json,desired_json,native_lock_fields_json,policy_revision,created_at) VALUES ('old','preview','connection',1,'source','key','{}','{}','[]',0,'2026-01-01')`).run();
  migrateSchema(sqlite);migrateSchema(sqlite);
  assert.deepEqual(sqlite.prepare("SELECT archives_json,expected_json,status FROM metadata_restore_plans WHERE id='old'").get(),{archives_json:'[]',expected_json:'{}',status:'approved'});
  assert.equal((sqlite.prepare('SELECT count(*) AS count FROM schema_migrations WHERE version=7').get() as {count:number}).count,1);
  sqlite.close();
});

test('retention expires consumed previews and releases finalized XML copies while preserving active plans and idempotency receipts',()=>{
  const sqlite=new Database(':memory:');migrateSchema(sqlite);
  const insert=sqlite.prepare(`INSERT INTO metadata_operations(id,connection_key,series_id,origin,status,fields_json,desired_json,policy_revision,before_json,created_at,finished_at)
    VALUES (?,'connection',?,'metadata-restore','completed','[]','{}',0,'{}','2020-01-01','2020-01-01')`);
  insert.run('old-source',1);insert.run('old-restore',1);insert.run('active-source',2);
  for(let index=0;index<20;index++){insert.run(`new-${index}`,1);insert.run(`new-active-${index}`,2);}
  const plan=sqlite.prepare(`INSERT INTO metadata_restore_plans(id,preview_id,connection_key,series_id,source_operation_id,operation_id,idempotency_key,status,expected_json,desired_json,archives_json,native_lock_fields_json,policy_revision,created_at,finished_at)
    VALUES (?,?,'connection',?,?,?, ?,?, '{"expected":"retained XML"}','{"desired":"retained XML"}','[{"xml":"retained XML"}]','[]',0,'2020-01-01','2020-01-01')`);
  plan.run('finished','old-preview',1,'old-source','old-restore','stable-key','completed');
  plan.run('active','active-preview',2,'active-source',null,'active-key','approved');
  sqlite.exec(`INSERT INTO metadata_restore_previews(id,connection_key,series_id,source_operation_id,preview_json,expected_json,desired_json,archives_json,created_at,expires_at,consumed_at)
    VALUES ('old-preview','connection',1,'old-source','{}','{}','{}','[{"xml":"old preview"}]','2020-01-01','2020-01-02','2020-01-01')`);
  pruneMetadataHistory(sqlite,Date.parse('2026-11-16T12:00:00Z'));
  assert.deepEqual(sqlite.prepare("SELECT expected_json,desired_json,archives_json,idempotency_key FROM metadata_restore_plans WHERE id='finished'").get(),
    {expected_json:'{}',desired_json:'{}',archives_json:'[]',idempotency_key:'stable-key'});
  assert.equal(sqlite.prepare("SELECT id FROM metadata_restore_previews WHERE id='old-preview'").get(),undefined);
  assert.ok(sqlite.prepare("SELECT id FROM metadata_operations WHERE id='active-source'").get());
  assert.deepEqual(sqlite.prepare("SELECT archives_json FROM metadata_restore_plans WHERE id='active'").get(),{archives_json:'[{"xml":"retained XML"}]'});
  sqlite.close();
});
