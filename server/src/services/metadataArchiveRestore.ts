import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { MetadataSnapshot, RecordedValue } from '../contracts/metadataHistory.js';
import type { ArchiveRestorePreview, ArchiveRestoreSelection } from '../contracts/metadataRestore.js';
import { PROTECTABLE_FIELDS } from '../contracts/metadata.js';
import { archiveResource } from '../lib/mutations.js';
import { pathContains } from '../lib/paths.js';
import { mapKavitaPathToLocalPath } from '../kavita/libraryPaths.js';
import { captureArchiveSnapshot, verifyArchiveSnapshot, type ArchiveSnapshot } from '../lib/cbz.js';
import { comicInfoFieldValue, comicInfoSeries, restoreComicInfoFields, restoreComicInfoSeries, validateRestoreXml } from '../lib/comicInfoRestore.js';

import { getDownloaderSettings } from './settings.js';

export interface ApprovedArchiveRestore {
  sourceId: number | null;
  target: string;
  expected: ArchiveSnapshot;
  desiredXml: string | null;
  mode: 'fields' | 'document' | 'title';
  fields: string[];
}
export interface PreparedArchiveRestores { approved: ApprovedArchiveRestore[]; previews: ArchiveRestorePreview[] }
const protection: Record<string,string> = {Series:'title',Summary:'summary',Genre:'genres',Tags:'tags',Writer:'writers',Artist:'artists',Year:'releaseDate',Language:'language',LanguageISO:'language',Web:'url'};
export function archiveProtectedFields(archives: ApprovedArchiveRestore[]): string[] {
  return [...new Set(archives.flatMap(archive => archive.mode === 'document' ? PROTECTABLE_FIELDS : archive.fields.map(field => protection[field]).filter(Boolean)))];
}

/** Current Kavita index, current allowed roots, and the complete readable folder must agree. No guessed paths. */
export async function resolveRestoreArchiveTargets(client: KavitaClient, snapshot: MetadataSnapshot): Promise<string[]> {
  const [libraries, chapters] = await Promise.all([client.getLibraries(),client.getChaptersBySeries(snapshot.series.id)]);
  const library = libraries.find(item => item.id === snapshot.series.libraryId);
  const settings = getDownloaderSettings(), mappings = settings.libraryPathMappings;
  const local = (remote: string) => mapKavitaPathToLocalPath(remote,mappings) ?? remote;
  if (!library || !snapshot.series.folderPath || !Array.isArray(chapters) || !chapters.length) throw new Error('Complete indexed archive membership is unavailable');
  const roots = (library.paths ?? (library.path ? [library.path] : [])).map(local).filter(root => path.isAbsolute(root));
  const directory = path.resolve(local(snapshot.series.folderPath));
  const realDirectory = await fs.realpath(directory);
  const realRoots = await Promise.all(roots.map(root => fs.realpath(root)));
  if (!realRoots.some(root => pathContains(root,realDirectory))) throw new Error('Series folder is outside the current allowed library roots');
  const files: string[] = [];
  const walk = async (folder:string,depth:number):Promise<void> => {
    if (depth > 32) throw new Error('Series archive traversal exceeds the supported depth');
    for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
      if (entry.isSymbolicLink()) throw new Error('Symlinked series contents require review; archive identity cannot be verified');
      const target = path.join(folder,entry.name);
      if (entry.isDirectory()) await walk(target,depth+1);
      else if (entry.isFile() && /\.cbz$/i.test(entry.name)) {
        files.push(await fs.realpath(target));
        if (files.length > 2000) throw new Error('More than 2,000 archives cannot be restored in one operation');
      }
    }
  };
  await walk(realDirectory,0);
  const indexed = new Set<string>();
  for (const chapter of chapters) {
    if (!Array.isArray(chapter.files) || !chapter.files.length) throw new Error('Indexed chapter file coverage is incomplete');
    for (const file of chapter.files) {
      if (!file.filePath || !/\.cbz$/i.test(file.filePath) || !path.isAbsolute(local(file.filePath))) throw new Error('Only fully indexed CBZ series support archive restoration');
      const target = await fs.realpath(local(file.filePath));
      if (!pathContains(realDirectory,target)) throw new Error('Indexed archive lies outside the current series folder');
      indexed.add(archiveResource(target));
    }
  }
  // One identity per file: archiveResource resolves the real path on every call.
  const keyed = files.map(file => ({file,key:archiveResource(file)}));
  const actual = new Set(keyed.map(item => item.key));
  if (!actual.size || indexed.size !== actual.size || [...indexed].some(file => !actual.has(file))) throw new Error('Indexed and on-disk archive membership differ; rescan and review');
  return keyed.sort((a,b) => a.key.localeCompare(b.key)).map(item => item.file);
}

const STEP_QUERY_CHUNK = 500;
const cell = (xml:string|null, field:string):RecordedValue => {
  const value=comicInfoFieldValue(xml,field);
  return {present:value!==null,...(value!==null?{value}:{})};
};
export async function prepareArchiveRestores(client: KavitaClient, current: MetadataSnapshot, operationId: string,
  side:'before'|'after', selections:ArchiveRestoreSelection[], title:string|undefined, lockedFields:readonly string[]): Promise<PreparedArchiveRestores> {
  if (!selections.length && title === undefined) return {approved:[],previews:[]};
  const targets = await resolveRestoreArchiveTargets(client,current);
  // Precomputed identities: first indexed file wins, as a linear search would.
  const targetKeys = targets.map(archiveResource);
  const targetByKey = new Map<string,string>();
  targets.forEach((file,index) => { if (!targetByKey.has(targetKeys[index])) targetByKey.set(targetKeys[index],file); });
  const steps = new Map<number,typeof schema.metadataOperationSteps.$inferSelect>();
  const ids = [...new Set(selections.map(selection => selection.id))];
  for (let index = 0; index < ids.length; index += STEP_QUERY_CHUNK) {
    for (const step of getDb().select().from(schema.metadataOperationSteps).where(and(eq(schema.metadataOperationSteps.operationId,operationId),
      inArray(schema.metadataOperationSteps.id,ids.slice(index,index+STEP_QUERY_CHUNK)))).all()) steps.set(step.id,step);
  }
  const byTarget = new Map<string,ApprovedArchiveRestore>();
  const previews: ArchiveRestorePreview[] = [];
  let beforeBytes = 0, desiredBytes = 0;
  const account = (before:string|null,desired:string|null) => {
    const nextBefore=beforeBytes+Buffer.byteLength(before??''),nextDesired=desiredBytes+Buffer.byteLength(desired??'');
    if(nextBefore>16*1024*1024 || nextDesired>16*1024*1024)throw new Error('ComicInfo restore exceeds the 16 MiB budget per snapshot side');
    beforeBytes=nextBefore;desiredBytes=nextDesired;
  };
  for (const selection of selections) {
    const step = steps.get(selection.id);
    const preview:ArchiveRestorePreview = {id:selection.id,target:step?path.basename(step.target):'Unknown archive',mode:selection.mode,
      available:false,reason:null,laterEdit:false,changes:[]};
    previews.push(preview);
    try {
      if (!step) throw new Error('Archive does not belong to this history operation');
      if (side === 'after' && step.status !== 'observed') throw new Error('Archive After snapshot was not verified');
      const json = side === 'before' ? step.beforeJson : step.afterJson;
      if (!json) throw new Error('Archive snapshot was not captured');
      const saved = JSON.parse(json) as ArchiveSnapshot;
      if (!saved.contentHash) throw new Error('This older snapshot has no archive content identity; archive restoration is unavailable');
      const target = targetByKey.get(archiveResource(step.target));
      if (!target) throw new Error('Saved archive is no longer indexed at its original location; file moves cannot be reversed');
      const expected = await captureArchiveSnapshot(target);
      if (expected.contentHash !== saved.contentHash) throw new Error('Archive page/content identity differs from the saved snapshot');
      validateRestoreXml(saved.xml); validateRestoreXml(expected.xml);
      const currentSeries = comicInfoSeries(expected.xml);
      const fields = selection.mode === 'document' ? [] : [...selection.fields!];
      let desiredXml = selection.mode === 'document' ? saved.xml : restoreComicInfoFields(expected.xml,saved.xml,fields);
      if (title !== undefined && selection.mode === 'fields' && !fields.includes('Series')) {
        desiredXml = restoreComicInfoSeries(desiredXml,title); fields.push('Series');
      }
      const approved:ApprovedArchiveRestore = {sourceId:step.id,target,expected,desiredXml,mode:selection.mode,fields};
      if (archiveProtectedFields([approved]).some(field => lockedFields.includes(field))) throw new Error('Affected ComicInfo metadata is protected by H-Tosho; unlock it and refresh the preview');
      const grouping = comicInfoSeries(desiredXml);
      if (grouping !== currentSeries && grouping !== (title ?? current.series.name)) throw new Error('ComicInfo.Series would change grouping; select a paired Title restore or leave Series unchanged');
      if (title !== undefined && grouping !== title) throw new Error('Selected XML conflicts with the paired title; restore Series separately through Title');
      preview.laterEdit = !!step.afterJson && expected.xml !== (JSON.parse(step.afterJson) as ArchiveSnapshot).xml;
      preview.changes = selection.mode === 'document' ? [{field:'Complete ComicInfo.xml',current:{present:expected.xml!==null,value:expected.xml},restoreTo:{present:desiredXml!==null,value:desiredXml}}]
        : fields.map(field => ({field,current:cell(expected.xml,field),restoreTo:cell(desiredXml,field)}));
      account(expected.xml,desiredXml);
      byTarget.set(archiveResource(target),approved);preview.available=true;
    } catch (error) { preview.available=false;preview.reason = error instanceof Error ? error.message : String(error); }
  }
  if (title !== undefined) for (const [index,target] of targets.entries()) {
    const existing = byTarget.get(targetKeys[index]);
    if (existing) continue;
    const expected = await captureArchiveSnapshot(target);
    const desiredXml = restoreComicInfoSeries(expected.xml,title);
    account(expected.xml,desiredXml);
    byTarget.set(targetKeys[index],{sourceId:null,target,expected,desiredXml,mode:'title',fields:['Series']});
    previews.push({id:null,target:path.basename(target),mode:'title',available:true,reason:null,laterEdit:false,
      changes:[{field:'Series',current:cell(expected.xml,'Series'),restoreTo:{present:true,value:title}}]});
  }
  return {approved:[...byTarget.values()],previews};
}

/** Called again while all archive resources are held. A new mount/index/file means a fresh review. */
export async function recheckArchiveRestores(client:KavitaClient,current:MetadataSnapshot,approved:ApprovedArchiveRestore[],titleSelected:boolean):Promise<void> {
  if (!approved.length) return;
  const targets = (await resolveRestoreArchiveTargets(client,current)).map(archiveResource);
  const targetSet = new Set(targets), approvedKeys = approved.map(item => archiveResource(item.target)), approvedSet = new Set(approvedKeys);
  if (titleSelected && (targets.length !== approved.length || targets.some(target => !approvedSet.has(target)))) {
    throw new Error('Series archive membership changed after preview; review required');
  }
  for (const [index,item] of approved.entries()) {
    // Same decision as sameArchiveSnapshot(expected, capture), without the content-identity pass.
    if (!targetSet.has(approvedKeys[index]) || !await verifyArchiveSnapshot(item.target,item.expected)) {
      throw new Error('Archive identity or fingerprint changed after preview; review required');
    }
  }
}
