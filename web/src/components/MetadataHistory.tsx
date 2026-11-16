import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Spinner } from './ui';
import type { RecordedValue } from '../../../server/src/contracts/metadataHistory';

const names:Record<string,string>={title:'Title',summary:'Description',genres:'Genres',tags:'Tags',writers:'Writers',artists:'Artists',releaseDate:'Release year',language:'Language',status:'Publication status',url:'Source URL'};
const origins:Record<string,string>={'provider-apply':'Provider update','automatic-sync':'Automatic sync',unmatch:'Unmatch','comicinfo-edit':'ComicInfo edit','merge-metadata':'Merge metadata'};
function value(cell:RecordedValue|undefined):string {
  if(!cell)return 'Not captured';
  if(!cell.present)return 'Field absent';
  if(cell.value===null)return 'Null';
  if(cell.value==='')return 'Empty text';
  if(Array.isArray(cell.value))return cell.value.length?cell.value.map(item=>typeof item==='object'&&item!==null?String(item.name??item.title??JSON.stringify(item)):String(item)).join(', '):'Empty list';
  return String(cell.value);
}
export function MetadataHistory({seriesId}:{seriesId:number}) {
  const [open,setOpen]=React.useState(false),[cursors,setCursors]=React.useState<(number|undefined)[]>([undefined]),[selected,setSelected]=React.useState<string|null>(null);
  const cursor=cursors[cursors.length-1];
  const list=useQuery({queryKey:['metadata-history',seriesId,cursor],queryFn:()=>api.metadataHistory(seriesId,cursor),enabled:open,staleTime:0});
  const detail=useQuery({queryKey:['metadata-history-detail',seriesId,selected],queryFn:()=>api.metadataHistoryDetail(seriesId,selected!),enabled:open&&!!selected});
  return <details className="group/history min-w-0 rounded-md border border-border p-3" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open/history:rotate-90"/>Metadata history</summary>
    {open&&<div className="mt-3 min-w-0 space-y-3">
      <p className="max-w-prose text-xs text-muted">Saved before-and-after metadata from new updates. Earlier activity and archive edits without a connected series have no snapshots. Restore is not available yet; cover images are not captured.</p>
      {list.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner/>Loading metadata history…</p>:list.isError?<div role="alert"><p className="text-sm text-danger">Could not load metadata history.</p><Button size="sm" variant="outline" onClick={()=>void list.refetch()}>Retry history</Button></div>:!list.data.items.length?<p className="py-3 text-sm text-muted">No recorded metadata changes yet.</p>:<ul className="divide-y divide-border">{list.data.items.map(entry=><li key={entry.id} className="min-w-0 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{origins[entry.origin]??entry.origin} · {entry.status}</p>
            <time dateTime={entry.createdAt} className="text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</time>
            {entry.jobId!=null&&<p className="text-xs text-muted">Task #{entry.jobId}</p>}
            <p className="mt-1 break-words text-xs text-muted">{entry.changedFields.length?entry.changedFields.map(field=>names[field]??field).join(', '):'No verified Kavita field changes'}</p>
          </div>
          <Button size="sm" variant="outline" aria-expanded={selected===entry.id} onClick={()=>setSelected(selected===entry.id?null:entry.id)}>View changes</Button>
        </div>
        {entry.message&&<p className="mt-2 break-words text-xs text-warning">{entry.message}</p>}
        {selected===entry.id&&(detail.isPending?<p role="status" className="mt-3 text-sm">Loading snapshot…</p>:detail.isError?<div role="alert" className="mt-3"><p className="text-sm text-danger">Could not load this snapshot.</p><Button size="sm" variant="outline" onClick={()=>void detail.refetch()}>Retry snapshot</Button></div>:detail.data?<div className="mt-3 min-w-0">
          <dl className="divide-y divide-border">{Object.entries(detail.data.before.fields).map(([field,before])=><div key={field} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]"><dt className="text-xs font-medium">{names[field]??field}</dt>{([before,detail.data.after?.fields[field]] as const).map((cell,index)=><dd key={index} className="min-w-0"><span className="mb-1 block text-xs font-medium text-muted">{index?'After (observed)':'Before'}</span><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{value(cell)}</p>{cell?.nativeLocked!==undefined&&<p className="mt-1 text-xs text-muted">Kavita lock: {cell.nativeLocked?'locked':'unlocked'}</p>}</dd>)}</div>)}</dl>
          <p className="mt-3 text-xs text-muted">{detail.data.archives.length} archive snapshot(s). Archive moves and deletions cannot be undone here.</p>
          {detail.data.archives.map((file,index)=><details key={index} className="group/archive mt-2 border-t border-border pt-1">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 break-words py-3 text-xs font-medium [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open/archive:rotate-90"/><span className="min-w-0 [overflow-wrap:anywhere]">{file.target} · {file.status}</span></summary>
            <p className="text-xs text-muted">ComicInfo.xml: {file.beforePresent?'present':'absent'} before; {file.afterPresent===null?'not verified':file.afterPresent?'present':'absent'} after.</p>
            {file.changes.length?<dl className="divide-y divide-border">{file.changes.map(change=><div key={change.field} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
              <dt className="text-xs font-medium">{change.field}</dt>{([change.before,change.after] as const).map((cell,index)=><dd key={index} className="min-w-0"><span className="mb-1 block text-xs font-medium text-muted">{index?'After (observed)':'Before'}</span><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{value(cell)}</p></dd>)}
            </div>)}</dl>:<p className="py-3 text-xs text-muted">No changed text fields. Original XML is retained with this operation.</p>}
          </details>)}
        </div>:null)}
      </li>)}</ul>}
      <div className="flex flex-wrap gap-2">{cursors.length>1&&<Button size="sm" variant="outline" onClick={()=>{setCursors(cursors.slice(0,-1));setSelected(null);}}>Newer changes</Button>}{list.data?.nextCursor&&<Button size="sm" variant="outline" onClick={()=>{setCursors([...cursors,list.data!.nextCursor!]);setSelected(null);}}>Older changes</Button>}</div>
    </div>}
  </details>;
}
