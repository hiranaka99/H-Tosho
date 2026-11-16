import * as React from 'react';
import type { RecordedCover, SeriesCoverHistory } from '../../../server/src/contracts/metadataCovers';
import { Button } from './ui';

function CoverObservation({seriesId,operationId,side,cover}:{seriesId:number;operationId:string;side:'Before'|'After';cover:RecordedCover}) {
  const [attempt,setAttempt]=React.useState(0),[state,setState]=React.useState<'loading'|'loaded'|'error'>('loading');
  const url=cover.assetId?`/api/series/${seriesId}/metadata-history/${encodeURIComponent(operationId)}/assets/${encodeURIComponent(cover.assetId)}?attempt=${attempt}`:null;
  return <figure className="min-w-0 space-y-2">
    <figcaption className="text-xs font-medium text-muted">{side==='After'?'After (observed)':'Before'}</figcaption>
    {cover.state==='captured' && url ? <>
      {state!=='error' && <img key={url} src={url} alt={`${side} recorded series cover`} loading="lazy" onLoad={()=>setState('loaded')} onError={()=>setState('error')} className="h-44 max-w-full rounded object-contain object-left"/>}
      {state==='loading' && <p role="status" className="text-xs text-muted">Loading retained cover…</p>}
      {state==='error' && <div role="alert" className="space-y-2"><p className="text-xs text-danger">Retained cover could not be displayed.</p><Button className="min-h-11" size="sm" variant="outline" onClick={()=>{setState('loading');setAttempt(value=>value+1);}}>Retry {side.toLowerCase()} cover</Button></div>}
      <p className="break-words text-xs text-muted">{cover.mediaType} · {cover.byteSize?.toLocaleString()} bytes</p>
    </> : <p className="break-words text-sm">{cover.state==='absent'?'No cover image was present.':cover.reason??'This cover image was not captured.'}</p>}
    <p className="text-xs text-muted">Kavita cover lock: {cover.nativeLocked===null?'Not recorded':cover.nativeLocked?'locked':'unlocked'}</p>
  </figure>;
}

export function MetadataCoverHistory({seriesId,operationId,history}:{seriesId:number;operationId:string;history?:SeriesCoverHistory}) {
  return <section aria-label="Series cover history" className="mt-4 min-w-0 space-y-3 border-t border-border pt-4">
    <h3 className="text-sm font-semibold">Series cover history</h3>
    {history?<>
      <p className="text-xs text-muted">{history.status==='observed'?'Retained before-and-after images.':`Cover capture: ${history.status}.`} {history.changed===true?'The image or native lock changed.':history.changed===false?'The image and native lock stayed the same.':''}</p>
      <div className="grid min-w-0 grid-cols-2 gap-4 sm:max-w-lg">{(['before','after'] as const).map(side=><CoverObservation key={`${side}:${history[side].assetId}:${history[side].state}`} seriesId={seriesId} operationId={operationId} side={side==='before'?'Before':'After'} cover={history[side]}/>)}</div>
      <p className="max-w-prose text-xs text-muted">{history.restoreReason}</p>
    </>:<p className="max-w-prose text-xs text-muted">No series-cover snapshot was recorded for this operation. Earlier updates have no saved image backup.</p>}
    <p className="text-xs text-muted">Volume covers are not captured. Viewing saved images does not change your library.</p>
  </section>;
}
