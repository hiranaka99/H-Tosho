import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api';
import { Button, Spinner } from './ui';
import type { MetadataHistoryDetail, RecordedValue } from '../../../server/src/contracts/metadataHistory';
import { isRestorableMetadataField, type ArchiveRestoreSelection, type MetadataRestorePreview, type RestorableMetadataField, type RestoreSnapshotSide } from '../../../server/src/contracts/metadataRestore';
import { RESTORABLE_COMICINFO_FIELDS } from '../../../server/src/lib/comicInfoRestore';
import type { ProtectedField } from '../../../server/src/contracts/metadata';
import { COVER_RESTORE_CONVERSION_WARNING, type CoverCheckpoint, type CoverRestoreSelection } from '../../../server/src/contracts/metadataCovers';
import { CoverRestoreSelectionControls, CoverRestorePreviewImages } from './CoverRestoreControls';

const labels: Record<string, string> = { summary: 'Description', genres: 'Genres', tags: 'Tags', writers: 'Writers', artists: 'Artists', releaseDate: 'Release year', language: 'Language', status: 'Publication status', url: 'Source URL', title: 'Title', cover: 'Cover', archives: 'ComicInfo.xml' };
function display(cell: RecordedValue): string {
  if (!cell.present) return 'Field absent';
  if (cell.value === null) return 'Null';
  if (cell.value === '') return 'Empty text';
  if (Array.isArray(cell.value)) return cell.value.length ? cell.value.map(item => item && typeof item === 'object' ? String(item.name ?? item.title ?? JSON.stringify(item)) : String(item)).join(', ') : 'Empty list';
  return String(cell.value);
}

export function MetadataRestoreReview({ seriesId, detail }: { seriesId: number; detail: MetadataHistoryDetail }) {
  const qc = useQueryClient();
  const policy = useQuery({ queryKey: ['field-policy', seriesId], queryFn: () => api.fieldPolicy(seriesId) });
  const [side, setSide] = React.useState<RestoreSnapshotSide>('before');
  const [fields, setFields] = React.useState<RestorableMetadataField[]>([]);
  const [nativeFields, setNativeFields] = React.useState<RestorableMetadataField[]>([]);
  const [archives, setArchives] = React.useState<ArchiveRestoreSelection[]>([]);
  const [covers, setCovers] = React.useState<CoverRestoreSelection[]>([]);
  const [coverReviewed, setCoverReviewed] = React.useState(false);
  const [preview, setPreview] = React.useState<MetadataRestorePreview | null>(null);
  const [reviewed, setReviewed] = React.useState(false);
  const [pending, setPending] = React.useState<'preview' | 'queue' | 'unlock' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [taskId, setTaskId] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const generation = React.useRef(0);
  const approvalKey = React.useRef('');
  const previewHeading = React.useRef<HTMLHeadingElement>(null);
  const availability = detail.restoreAvailability?.[side] ?? [];
  const expired = !!preview && now >= Date.parse(preview.expiresAt);
  const coverCheckpoints = React.useMemo<CoverCheckpoint[]>(() => [...(detail.covers?.series ? [detail.covers.series] : []), ...(detail.covers?.volumes ?? [])], [detail.covers]);
  const needsCoverReview = !!preview?.covers?.some(cover => cover.available);
  function invalidate() {
    generation.current++;
    setPreview(null); setReviewed(false); setCoverReviewed(false); setError(null); setTaskId(null);
  }
  React.useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  React.useEffect(() => {
    if (preview && policy.data && preview.policyRevision !== policy.data.revision) invalidate();
  }, [policy.data?.revision, preview]);
  async function loadPreview() {
    const version = ++generation.current;
    setPending('preview'); setError(null); setPreview(null); setReviewed(false); setCoverReviewed(false);
    try {
      const result = await api.metadataRestorePreview(seriesId, detail.id, { snapshot: side, fields, nativeLockFields: nativeFields, ...(archives.length ? {archives} : {}), ...(covers.length ? {covers} : {}) });
      if (generation.current !== version) return;
      approvalKey.current = crypto.randomUUID();
      setNow(Date.now()); setPreview(result);
      requestAnimationFrame(() => previewHeading.current?.focus());
    } catch (cause) {
      if (generation.current === version) setError(cause instanceof Error ? cause.message : 'Could not preview restore. Retry the preview.');
    } finally { setPending(null); }
  }
  async function unlock(field: ProtectedField) {
    if (!policy.data) return;
    invalidate(); setPending('unlock');
    try {
      const saved = await api.saveFieldPolicy(seriesId, { lockedFields: policy.data.lockedFields.filter(key => key !== field), expectedRevision: policy.data.revision });
      qc.setQueryData(['field-policy', seriesId], saved);
      await qc.invalidateQueries({ queryKey: ['metadata-history-detail', seriesId, detail.id] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save field protection.');
      void policy.refetch();
    } finally { setPending(null); }
  }
  async function queue() {
    if (!preview || !reviewed || (needsCoverReview && !coverReviewed) || expired || !preview.canRestore || pending) return;
    setPending('queue'); setError(null);
    try {
      const result = await api.restoreMetadata(seriesId, { previewId: preview.id, idempotencyKey: approvalKey.current, ...(needsCoverReview ? { acceptCoverConversion: coverReviewed } : {}) });
      setTaskId(result.id);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue restore. Retry or refresh the preview.');
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404 || cause.status === 400)) setPreview(null);
      // Retain the approval key so a lost response never creates a second task.
      setReviewed(false);
    } finally { setPending(null); }
  }
  return <section aria-label="Restore metadata" className="mt-6 min-w-0 space-y-3 border-t border-border pt-4">
    <h3 className="text-sm font-semibold">Restore selected metadata</h3>
    <p className="max-w-prose text-xs text-muted">Restore saved metadata after reviewing current values. A Title restore also updates ComicInfo.Series in every indexed CBZ. Selected archive fields preserve other XML; complete XML replacement requires its own selection. Kavita locks are preserved unless selected below. External Kavita edits cannot be guarded atomically.</p>
    <fieldset disabled={!!pending || taskId !== null} className="flex flex-wrap gap-3">
      <legend className="text-xs font-medium">Saved values to use</legend>
      {(['before', 'after'] as const).map(snapshot => <label key={snapshot} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="radio" name={`restore-side-${detail.id}`} checked={side === snapshot} disabled={snapshot === 'after' && !(detail.restoreAvailability?.after.some(item => item.available) || detail.archives.some(file => file.afterPresent !== null && file.status === 'observed') || coverCheckpoints.some(checkpoint => checkpoint.restoreAvailability.after.available))} onChange={() => { invalidate(); setSide(snapshot); setFields([]); setNativeFields([]); setArchives([]); setCovers([]); }} />{snapshot === 'before' ? 'Before' : 'After (observed)'}</label>)}
    </fieldset>
    <fieldset disabled={!!pending || taskId !== null} className="min-w-0 divide-y divide-border">
      <legend className="text-xs font-medium">Fields to restore</legend>
      {availability.map(item => {
        const field = item.field;
        const supported = isRestorableMetadataField(field);
        const chosen = supported && fields.includes(field);
        const protectedField = policy.data?.lockedFields.some(key => key === field) ?? false;
        return <div key={field} className="min-w-0 py-2">
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={!supported || !item.available || protectedField} checked={chosen} onChange={() => { if (!supported) return; invalidate(); setFields(chosen ? fields.filter(key => key !== field) : [...fields, field]); setNativeFields(nativeFields.filter(key => key !== field)); }} />{labels[field] ?? field}{protectedField && <span className="text-xs text-foreground dark:text-warning">H-Tosho protected</span>}</label>
          {!item.available && <p className="break-words text-xs text-muted">{item.reason ?? 'This saved field cannot be restored through Kavita.'}</p>}
          {supported && protectedField && <Button className="min-h-11" size="sm" variant="outline" onClick={() => void unlock(field)}>Unlock {labels[field] ?? field}</Button>}
          {supported && chosen && item.nativeLockAvailable && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={nativeFields.includes(field)} onChange={() => { invalidate(); setNativeFields(nativeFields.includes(field) ? nativeFields.filter(key => key !== field) : [...nativeFields, field]); }} />Restore captured Kavita lock for {labels[field] ?? field}</label>}
        </div>;
      })}
    </fieldset>
    <CoverRestoreSelectionControls checkpoints={coverCheckpoints} side={side} selections={covers} disabled={!!pending || taskId !== null} protectedCover={policy.data?.lockedFields.includes('cover') ?? false} onChange={selections => { invalidate(); setCovers(selections); }} onUnlock={() => void unlock('cover')}/>
    {!!detail.archives.length && <fieldset disabled={!!pending || taskId !== null} className="min-w-0 space-y-2 border-t border-border pt-3">
      <legend className="text-xs font-medium">ComicInfo.xml to restore</legend>
      <p className="max-w-prose text-xs text-muted">Preview checks each archive against the current library index, allowed folders and saved content identity. Moved, replaced or older files without identity evidence remain unavailable. XML changes are read by Kavita on its next library scan.</p>
      {detail.archives.map(file => {
        const selected = archives.find(item => item.id === file.id);
        const replace = selected?.mode === 'document';
        const available = Number.isSafeInteger(file.id) && (side === 'before' || (file.afterPresent !== null && file.status === 'observed'));
        const setSelection = (selection:ArchiveRestoreSelection|null) => { invalidate(); setArchives([...archives.filter(item => item.id !== file.id),...(selection?[selection]:[])]); };
        return <details key={file.id ?? file.target} className="min-w-0 border-t border-border">
          <summary className="min-h-11 cursor-pointer py-3 text-sm [overflow-wrap:anywhere]">{file.target}{selected ? ' · selected' : ''}</summary>
          {!available && <p className="text-xs text-muted">This archive snapshot is unavailable for the selected side.</p>}
          <label className="flex min-h-11 items-center gap-2 text-sm"><input className="accent-primary" aria-label={`Replace complete ComicInfo.xml in ${file.target}`} type="checkbox" disabled={!available} checked={replace} onChange={() => setSelection(replace?null:{id:file.id,mode:'document'})}/>Replace complete ComicInfo.xml</label>
          {replace && <p className="max-w-prose text-xs text-foreground dark:text-warning">This replaces all current XML with the saved document, including nested and unknown metadata. If the saved entry was absent, it removes ComicInfo.xml. A grouping conflict blocks restoration.</p>}
          {file.changes.filter(change => RESTORABLE_COMICINFO_FIELDS.some(field => field === change.field)).map(change => <label key={change.field} className="flex min-h-11 items-center gap-2 text-sm"><input className="accent-primary" aria-label={`Restore ${change.field} in ${file.target}`} type="checkbox" disabled={!available || replace} checked={!replace && (selected?.fields?.includes(change.field) ?? false)} onChange={() => {
            const chosen = selected?.fields ?? [], next = chosen.includes(change.field)?chosen.filter(field => field!==change.field):[...chosen,change.field];
            setSelection(next.length?{id:file.id,mode:'fields',fields:next}:null);
          }}/>Restore {change.field}</label>)}
        </details>;
      })}
    </fieldset>}
    <p className="text-xs text-muted">Restores do not download galleries or reverse file moves and merges. Retained cover uploads use Kavita's API with explicit conversion review.</p>
    {!availability.length && !detail.archives.length && !coverCheckpoints.length && <p className="text-xs text-foreground dark:text-warning">No supported restore values were recorded for this snapshot.</p>}
    {policy.isError && <p role="alert" className="text-sm text-danger">Could not load field protection. <Button className="min-h-11" size="sm" variant="outline" onClick={() => void policy.refetch()}>Retry protection</Button></p>}
    <Button className="min-h-11" variant="outline" disabled={(!fields.length && !archives.length && !covers.length) || !!pending || taskId !== null} onClick={() => void loadPreview()}>{pending === 'preview' && <Spinner />}{pending === 'preview' ? 'Preparing preview…' : preview ? 'Refresh restore preview' : 'Preview restore'}</Button>
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{error}</p>}
    {preview && <div className="min-w-0 space-y-3">
      <h4 ref={previewHeading} tabIndex={-1} className="text-sm font-semibold">Review restore preview</h4>
      <p className="text-xs text-muted">{preview.effectiveFields.length} metadata field(s), {preview.archives?.filter(archive => archive.available).length ?? 0} archive(s), and {preview.covers?.filter(cover => cover.available).length ?? 0} cover image(s) eligible. Excluded metadata: {preview.requestedFields.filter(field => !preview.effectiveFields.includes(field)).map(field => labels[field] ?? field).join(', ') || 'None'}. Only reviewed values will be restored.</p>
      <dl className="divide-y divide-border">{preview.fields.map(row => <div key={row.field} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
        <dt className="text-xs font-medium">{labels[row.field] ?? row.field}{row.protected && <span className="mt-1 block text-foreground dark:text-warning">H-Tosho protected · excluded</span>}{!row.available && <span className="mt-1 block text-muted">{row.reason ?? 'Unavailable'}</span>}{row.laterEdit && <span className="mt-1 block text-foreground dark:text-warning">Later edit: restoring will replace newer values.</span>}{row.protected && <Button className="mt-2 min-h-11" size="sm" variant="outline" disabled={!!pending || !policy.data || taskId !== null} onClick={() => void unlock(row.field)}>Unlock {labels[row.field] ?? row.field}</Button>}</dt>
        {[row.current, row.restoreTo].map((cell, index) => <dd key={index} className="min-w-0"><span className="mb-1 block text-xs font-medium text-muted">{index ? 'Restore to' : 'Current'}</span><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{display(cell)}</p>{preview.nativeLockFields.includes(row.field) && <p className="mt-1 text-xs text-muted">Kavita lock: {cell.nativeLocked === undefined ? 'Not captured' : cell.nativeLocked ? 'locked' : 'unlocked'}</p>}</dd>)}
      </div>)}</dl>
      {!!preview.archives?.length && <div className="min-w-0 space-y-3">
        <h5 className="text-sm font-semibold">Archive changes</h5>
        {preview.archives.map((archive,index) => <div key={`${archive.id}:${index}`} className="min-w-0 border-t border-border pt-3">
          <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{archive.target} · {archive.mode === 'title'?'Paired title':archive.mode === 'document'?'Complete XML replacement':'Selected XML fields'}</p>
          {archive.laterEdit && <p className="text-xs text-foreground dark:text-warning">Later archive edit: selected values will be replaced.</p>}
          {!archive.available && <p className="text-sm text-danger">{archive.reason ?? 'Archive restoration is unavailable. Refresh after resolving the conflict.'}</p>}
          <dl className="divide-y divide-border">{archive.changes.map(row => <div key={row.field} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
            <dt className="text-xs font-medium">{row.field}</dt>
            {[row.current,row.restoreTo].map((cell,index) => <dd key={index} className="min-w-0"><span className="mb-1 block text-xs font-medium text-muted">{index?'Restore to':'Current'}</span>{archive.mode==='document'?<pre tabIndex={0} aria-label={`${index?'Saved':'Current'} complete XML for ${archive.target}`} className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs [overflow-wrap:anywhere]">{display(cell)}</pre>:<p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{display(cell)}</p>}</dd>)}
          </div>)}</dl>
        </div>)}
      </div>}
      <CoverRestorePreviewImages seriesId={seriesId} operationId={detail.id} previewId={preview.id} covers={preview.covers ?? []}/>
      {needsCoverReview && <div className="space-y-2"><p className="max-w-prose text-xs text-foreground dark:text-warning">{COVER_RESTORE_CONVERSION_WARNING}</p><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={coverReviewed} disabled={!!pending || expired || !preview.canRestore} onChange={event => setCoverReviewed(event.target.checked)}/>I accept Kavita's image conversion and the explicitly reviewed native-lock choices/readback limits.</label></div>}
      {!!preview.conflicts.length && <div role="alert" className="space-y-1 text-sm text-foreground dark:text-warning"><p className="font-medium">Review required</p><ul className="list-inside list-disc">{preview.conflicts.map((conflict, index) => <li key={index} className="break-words">{conflict}</li>)}</ul><p>Resolve conflicts and refresh the preview before queueing.</p></div>}
      {expired && taskId === null && <p role="alert" className="text-sm text-foreground dark:text-warning">This preview expired. Refresh it and review current values again.</p>}
      {taskId === null && <><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={!!pending || expired || !preview.canRestore} onChange={event => setReviewed(event.target.checked)} />I reviewed these current and restore values.</label><Button className="min-h-11" disabled={!!pending || !reviewed || (needsCoverReview && !coverReviewed) || expired || !preview.canRestore} onClick={() => void queue()}>{pending === 'queue' && <Spinner />}{pending === 'queue' ? 'Queueing restore…' : 'Queue restore'}</Button></>}
    </div>}
    {taskId !== null && <p role="status" className="text-sm text-success">Restore queued. <Button asChild className="min-h-11" size="sm" variant="outline"><Link to={`/jobs?job=${taskId}`}>View Task #{taskId}</Link></Button> Check the Task and linked history for verified results.</p>}
    {pending === 'unlock' && <p role="status" className="text-sm text-muted">Saving field protection… Refresh the preview after unlocking.</p>}
  </section>;
}
