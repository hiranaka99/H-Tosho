import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockKeyhole, RotateCcw } from 'lucide-react';
import type { MergeProtectionRequest } from '../../../server/src/contracts/mergeProtection';
import { api } from '../lib/api';
import { Button, Spinner } from './ui';

/** Approval belongs to the current inputs AND policy evidence, never only a checkbox. */
export function useMergeProtectionReview(request: MergeProtectionRequest, enabled: boolean, draftKey = '') {
  const qc = useQueryClient();
  const id = React.useId();
  const requestKey = JSON.stringify(request);
  const [reviewed, setReviewed] = React.useState<string | null>(null);
  const [reviewError,setReviewError] = React.useState<string | null>(null);
  const query = useQuery({queryKey:['merge-protection',request],queryFn:()=>api.mergeProtectionPreview(request),enabled,retry:false,staleTime:0});
  const evidence = query.data ? JSON.stringify(query.data) : '';
  const reviewKey = `${requestKey}:${draftKey}:${evidence}`;
  const unlock = useMutation({
    mutationFn: async (seriesId:number) => {
      setReviewed(null);
      const policy = await api.fieldPolicy(seriesId);
      await api.saveFieldPolicy(seriesId,{lockedFields:policy.lockedFields.filter(field=>field!=='title'),expectedRevision:policy.revision});
      await qc.invalidateQueries({queryKey:['field-policy',seriesId]});
      await query.refetch();
    },
  });
  const ready = enabled && query.isSuccess && !query.isFetching && !!query.data.canQueue && reviewed === reviewKey && !unlock.isPending;
  const ensureCurrent = async () => {
    if (!ready) throw new Error('Review current merge protection before queueing.');
    try {
      const current = await api.mergeProtectionPreview(request);
      if (!current.canQueue || JSON.stringify(current) !== evidence) {
        setReviewed(null);
        await query.refetch();
        throw new Error('Merge protection changed. Review the refreshed protection before queueing.');
      }
      setReviewError(null);
    } catch(error) {
      setReviewError(error instanceof Error ? error.message : 'Could not refresh protection. Retry before queueing.');
      throw error;
    }
  };
  const review = !enabled ? null : <section className="space-y-3 border-t border-border pt-4" aria-label="Merge protection review">
    <h3 className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="h-4 w-4 text-primary" aria-hidden="true" /> Merge protection</h3>
    {query.isFetching ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Checking current series and archive protection…</p>
      : query.isError ? <p role="alert" className="break-words text-sm text-danger">{query.error instanceof Error ? query.error.message : 'Could not check protection. Retry before queueing.'}</p>
      : query.data && <>
        {!query.data.series.length && <p className="text-xs text-muted">No indexed series policy covers these archives or this new target yet.</p>}
        <ul className="space-y-2 text-xs">{query.data.series.map(series=><li key={series.seriesId} className="space-y-1">
          <p className="break-words font-medium">{series.name} <span className="font-normal text-muted">· {series.role} · revision {series.revision}</span></p>
          <p className="break-words text-muted">Protected fields: {series.lockedFields.length ? series.lockedFields.join(', ') : 'none'}. {series.titleChange ? 'ComicInfo.Series or Kavita title will change.' : 'Title grouping stays unchanged.'}</p>
          {series.titleChange && series.lockedFields.includes('title') && <Button variant="outline" size="sm" className="min-h-11" disabled={unlock.isPending} onClick={()=>unlock.mutate(series.seriesId)}>Unlock title for {series.name}</Button>}
        </li>)}</ul>
        <p className="break-words text-xs text-muted">The verified merged series inherits: {query.data.inheritedFields.length ? query.data.inheritedFields.join(', ') : 'no protected fields'}. Existing target protection is retained.</p>
        {query.data.warnings.map(warning=><p key={warning} className="break-words text-xs text-warning">{warning}</p>)}
        <p className="text-xs text-muted">Source metadata history is not a whole-merge undo: it cannot reverse moves, downloads, or regrouping.</p>
        <p className="text-xs text-muted">Protection is based on indexed series. New downloads and unassociated archives have no source policy until indexed.</p>
        <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-2 py-2 text-sm">
          <input id={id} type="checkbox" className="mt-1 accent-primary" checked={reviewed===reviewKey} disabled={!query.data.canQueue || unlock.isPending} onChange={event=>setReviewed(event.target.checked ? reviewKey : null)} />
          <span>I reviewed current protection and lock inheritance.</span>
        </label>
      </>}
    {unlock.isError && <p role="alert" className="break-words text-sm text-danger">{unlock.error instanceof Error ? unlock.error.message : 'Could not unlock. Refresh and try again.'}</p>}
    {reviewError && <p role="alert" className="break-words text-sm text-danger">{reviewError}</p>}
    <Button variant="outline" size="sm" className="min-h-11" disabled={query.isFetching || unlock.isPending} onClick={()=>{setReviewed(null);unlock.reset();void query.refetch();}}><RotateCcw className="h-3.5 w-3.5" /> Refresh protection review</Button>
  </section>;
  return {ready,ensureCurrent,review};
}
