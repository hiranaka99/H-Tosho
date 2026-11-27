import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { MetadataRestoreReview } from './MetadataRestoreReview';
import { MetadataCoverHistory } from './MetadataCoverHistory';
import { LazyDetails } from './LazyDetails';
import { api } from '../lib/api';
import { Button, Spinner } from './ui';
import type { RecordedValue } from '../../../server/src/contracts/metadataHistory';

const names:Record<string,string>={title:'Title',sortName:'Sort name',localizedName:'Localized name',summary:'Description',genres:'Genres',tags:'Tags',writers:'Writers',artists:'Artists',releaseDate:'Release year',language:'Language',status:'Publication status',url:'Source URL',cover:'Series cover'};
const origins:Record<string,string>={'provider-apply':'Provider update','automatic-sync':'Automatic sync',unmatch:'Unmatch','comicinfo-edit':'ComicInfo edit','merge-metadata':'Merge metadata','metadata-restore':'Metadata restore'};
function value(cell:RecordedValue|undefined):string {
  if(!cell)return 'Not captured';
  if(!cell.present)return 'Field absent';
  if(cell.value===null)return 'Null';
  if(cell.value==='')return 'Empty text';
  if(Array.isArray(cell.value))return cell.value.length?(cell.value as unknown[]).map(item=>{
    const val=typeof item==='object'&&item!==null?((item as Record<string,unknown>).name??(item as Record<string,unknown>).title??item):item;
    return val===null||val===undefined?'':typeof val==='string'||typeof val==='number'||typeof val==='boolean'?String(val):JSON.stringify(val)??'';
  }).join(', '):'Empty list';
  return typeof cell.value === 'string' || typeof cell.value === 'number' || typeof cell.value === 'boolean' ? String(cell.value) : JSON.stringify(cell.value) ?? '';
}
export function MetadataHistory({seriesId,id,open}:{seriesId:number;id:string;open:boolean}) {
  const [cursors,setCursors]=React.useState<(number|undefined)[]>([undefined]),[selected,setSelected]=React.useState<string|null>(null);
  const cursor=cursors[cursors.length-1];
  const list=useQuery({queryKey:['metadata-history',seriesId,cursor],queryFn:()=>api.metadataHistory(seriesId,cursor),enabled:open,staleTime:0});
  const detail=useQuery({queryKey:['metadata-history-detail',seriesId,selected],queryFn:()=>api.metadataHistoryDetail(seriesId,selected!),enabled:open&&!!selected});
  return <section id={id} aria-label="Metadata history" hidden={!open} className="min-w-0 border-b border-border pb-4">
    {open&&<div className="min-w-0 space-y-3">
      <p className="max-w-prose text-xs text-muted">Saved before-and-after metadata from new updates. Earlier activity and archive edits without a connected series have no snapshots. Review selected metadata, archive values and retained series/volume covers before restoring. Cover uploads may be resized/re-encoded by Kavita; original backups remain retained.</p>
      {list.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner/>Loading metadata history…</p>:list.isError?<div role="alert"><p className="text-sm text-danger">Could not load metadata history.</p><Button size="sm" variant="outline" onClick={()=>void list.refetch()}>Retry history</Button></div>:!list.data.items.length?<p className="py-3 text-sm text-muted">No recorded metadata changes yet.</p>:<ul className="divide-y divide-border">{list.data.items.map(entry=><li key={entry.id} className="min-w-0 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{origins[entry.origin]??entry.origin} · {entry.status}</p>
            <time dateTime={entry.createdAt} className="text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</time>
            {entry.jobId!=null&&<Button asChild size="sm" variant="ghost" className="min-h-11"><Link to={`/jobs?job=${entry.jobId}`}>Task #{entry.jobId}</Link></Button>}
            {entry.restoredFromOperationId&&<p className="text-xs text-muted">Restored from <button type="button" className="min-h-11 break-all text-primary underline underline-offset-2" onClick={()=>setSelected(entry.restoredFromOperationId)}>{entry.restoredFromOperationId}</button></p>}
            <p className="mt-1 break-words text-xs text-muted">{entry.changedFields.length?entry.changedFields.map(field=>names[field]??field).join(', '):'No verified Kavita field changes'}</p>
          </div>
          <Button size="sm" variant="outline" aria-expanded={selected===entry.id} onClick={()=>setSelected(selected===entry.id?null:entry.id)}>View changes</Button>
        </div>
        {entry.message&&<p className="mt-2 break-words text-xs text-warning">{entry.message}</p>}
        {selected===entry.id&&(detail.isPending?<p role="status" className="mt-3 text-sm">Loading snapshot…</p>:detail.isError?<div role="alert" className="mt-3"><p className="text-sm text-danger">Could not load this snapshot.</p><Button size="sm" variant="outline" onClick={()=>void detail.refetch()}>Retry snapshot</Button></div>:detail.data?<div className="mt-3 min-w-0">
          <dl className="divide-y divide-border">{Object.entries(detail.data.before.fields).map(([field,before])=><div key={field} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]"><dt className="text-xs font-medium">{names[field]??field}</dt>{([before,detail.data.after?.fields[field]] as const).map((cell,index)=><dd key={index} className="min-w-0"><span className="mb-1 block text-xs font-medium text-muted">{index?'After (observed)':'Before'}</span><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{value(cell)}</p>{cell?.nativeLocked!==undefined&&<p className="mt-1 text-xs text-muted">Kavita lock: {cell.nativeLocked?'locked':'unlocked'}</p>}</dd>)}</div>)}</dl>
          <p className="mt-3 text-xs text-muted">{detail.data.archives.length} archive snapshot(s). Archive moves and deletions cannot be undone here.</p>
          {detail.data.archives.map((file,index)=><LazyDetails key={index} className="group/archive mt-2 border-t border-border pt-1" summary={
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 break-words py-3 text-xs font-medium [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open/archive:rotate-90"/><span className="min-w-0 [overflow-wrap:anywhere]">{file.target} · {file.status}</span></summary>}>
            <p className="text-xs text-muted">ComicInfo.xml: {file.beforePresent?'present':'absent'} before; {file.afterPresent===null?'not verified':file.afterPresent?'present':'absent'} after.</p>
            {file.changes.length?<dl className="divide-y divide-border">{file.changes.map(change=><div key={change.field} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
              <dt className="text-xs font-medium">{change.field}</dt>{([change.before,change.after] as const).map((cell,index)=><dd key={index} className="min-w-0"><span className="mb-1 block text-xs font-medium text-muted">{index?'After (observed)':'Before'}</span><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{value(cell)}</p></dd>)}
            </div>)}</dl>:<p className="py-3 text-xs text-muted">No changed text fields. Original XML is retained with this operation.</p>}
          </LazyDetails>)}
          <MetadataCoverHistory seriesId={seriesId} operationId={detail.data.id} history={detail.data.covers}/>
          <MetadataRestoreReview key={`${seriesId}:${detail.data.id}`} seriesId={seriesId} detail={detail.data}/>
        </div>:null)}
      </li>)}</ul>}
      {selected&&!list.data?.items.some(entry=>entry.id===selected)&&<div className="min-w-0 border-t border-border pt-3">{detail.isPending?<p role="status" className="text-sm">Loading source operation…</p>:detail.isError?<div role="alert"><p className="text-sm text-danger">Could not load the source operation.</p><Button className="min-h-11" variant="outline" onClick={()=>void detail.refetch()}>Retry source operation</Button></div>:detail.data?<><h3 className="break-all text-sm font-semibold">Source operation {detail.data.id}</h3><MetadataCoverHistory seriesId={seriesId} operationId={detail.data.id} history={detail.data.covers}/><MetadataRestoreReview key={`${seriesId}:${detail.data.id}`} seriesId={seriesId} detail={detail.data}/></>:null}</div>}
      <div className="flex flex-wrap gap-2">{cursors.length>1&&<Button size="sm" variant="outline" onClick={()=>{setCursors(cursors.slice(0,-1));setSelected(null);}}>Newer changes</Button>}{list.data?.nextCursor&&<Button size="sm" variant="outline" onClick={()=>{if(list.data?.nextCursor!=null){setCursors([...cursors,list.data.nextCursor]);setSelected(null);}}}>Older changes</Button>}</div>
    </div>}
  </section>;
}
