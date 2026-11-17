import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, FolderOpen, FileArchive, ArrowUp, Save, HardDrive } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, Spinner, EmptyState, Disclosure } from './ui';
import { changedComicInfoFields, comicInfoHasChanges, createComicInfoDraft, editComicInfoField, type ComicInfoDraft } from '../lib/comicInfoDraft';

const FIELD_GROUPS = [
  { title: 'Chapter identity', fields: ['Title', 'Series', 'Number', 'Volume'] },
  { title: 'Credits', fields: ['Artist', 'Writer', 'Publisher'] },
  { title: 'Description and tags', fields: ['Summary', 'Tags'] },
  { title: 'Additional metadata', fields: ['Language', 'LanguageISO', 'Year', 'Web'] },
];
const FIELD_LABELS: Record<string, string> = { Number: 'Chapter number', Web: 'Source URL', Language: 'Language name', LanguageISO: 'Language code' };
const EDITOR_FIELDS = FIELD_GROUPS.flatMap(group => group.fields);

/** Join a directory + child using the separator the server's paths actually use. */
const joinPath = (dir: string, name: string): string => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;

interface ComicInfoModalProps {
  /** Absolute path to open immediately (e.g. from a completed download row). */
  initialPath?: string;
  /** Kavita series to list archives for (entry point from the Libraries page). */
  seriesId?: number;
  onClose?: () => void;
  onStateChange?: (state: { dirty: boolean; pending: boolean; file: string | null }) => void;
}

export function ComicInfoEditor({ initialPath, seriesId, onClose, onStateChange }: ComicInfoModalProps) {
  const qc = useQueryClient();
  const [pathInput, setPathInput] = React.useState(initialPath ?? '');
  const [browseOpen, setBrowseOpen] = React.useState(!initialPath && seriesId === undefined);
  const [file, setFile] = React.useState<string | null>(initialPath ?? null);
  const [dir, setDir] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, ComicInfoDraft>>({});
  const [pickerOpen, setPickerOpen] = React.useState(!initialPath);
  const [queuedFiles, setQueuedFiles] = React.useState<Record<string, number>>({});
  const draft = file ? drafts[file] : undefined;
  const values = draft?.values ?? {};
  const patchDraft = (update: (current: ComicInfoDraft) => ComicInfoDraft) => {
    if (!file) return;
    setDrafts(previous => previous[file] ? { ...previous, [file]: update(previous[file]) } : previous);
  };

  const roots = useQuery({ queryKey: ['cbz-roots'], queryFn: () => api.cbzRoots(), enabled: browseOpen });
  const dirData = useQuery({
    queryKey: ['cbz-browse', dir],
    queryFn: () => api.cbzBrowse(dir!),
    enabled: browseOpen && !!dir,
  });
  const doc = useQuery({
    queryKey: ['cbz-comicinfo', file],
    queryFn: () => api.cbzComicInfo(file!),
    enabled: !!file,
  });
  const seriesFiles = useQuery({
    queryKey: ['cbz-series-files', seriesId],
    queryFn: () => api.cbzSeriesFiles(seriesId!),
    enabled: !!seriesId,
  });
  const associatedSeriesId = seriesId !== undefined && !!file && seriesFiles.data?.files.includes(file) ? seriesId : undefined;
  const protection = useQuery({queryKey:['field-policy',associatedSeriesId],queryFn:()=>api.fieldPolicy(associatedSeriesId!),enabled:associatedSeriesId!==undefined,retry:false});
  // Natural reading order: numeric ComicInfo Number first, then plain filename order.
  const sortedFiles = React.useMemo(() => {
    const files = seriesFiles.data?.files ?? [];
    const nums = seriesFiles.data?.chapterNumbers ?? {};
    const numOf = (f: string): number | null => {
      const n = Number(nums[f]);
      return nums[f] !== undefined && nums[f].trim() !== '' && !Number.isNaN(n) ? n : null;
    };
    return [...files].sort((a, b) => {
      const na = numOf(a);
      const nb = numOf(b);
      if (na !== null && nb !== null) return na - nb || a.localeCompare(b);
      if (na !== null) return -1;
      if (nb !== null) return 1;
      return a.localeCompare(b);
    });
  }, [seriesFiles.data]);

  // Initialize the file's draft when its parsed document arrives. An existing
  // draft is kept so pending edits survive refetches and file switches.
  React.useEffect(() => {
    if (!doc.data || !file) return;
    setDrafts(previous => previous[file] ? previous : { ...previous, [file]: createComicInfoDraft(doc.data.raw) });
  }, [doc.data, file]);

  const openFile = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    setPathInput(trimmed);
    setFile(trimmed);
    setBrowseOpen(false);
    setPickerOpen(false);
  };

  const changedFields = React.useMemo(() => draft ? changedComicInfoFields(draft) : [], [draft]);
  const save = useMutation({
    mutationFn: ({ path, snapshot }: { path: string; snapshot: ComicInfoDraft }) => api.enqueue('edit-comicinfo', {
      path,
      ...(snapshot.rawEdited ? { xml: snapshot.xml } : { fields: Object.fromEntries(changedComicInfoFields(snapshot).map(key => [key, snapshot.values[key] ?? ''])) }),
      ...(associatedSeriesId !== undefined ? { seriesId: associatedSeriesId } : {}),
    }),
    onSuccess: (result, { path, snapshot }) => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      setQueuedFiles(previous => ({ ...previous, [path]: result.id }));
      setDrafts(previous => previous[path] ? { ...previous, [path]: { ...previous[path], originalXml: snapshot.xml, originalValues: { ...snapshot.values } } } : previous);
      toast({ tone: 'success', title: 'ComicInfo save queued', description: `${path.split(/[\\/]/).pop()} — check the Tasks page` });
    },
    onError: error => toast({ tone: 'danger', title: 'Could not queue save', description: error instanceof Error ? error.message : String(error) }),
  });
  const dirty = Object.values(drafts).some(comicInfoHasChanges);
  React.useEffect(() => { onStateChange?.({ dirty, pending: save.isPending, file }); }, [dirty, save.isPending, file, onStateChange]);
  React.useEffect(() => {
    if (!dirty && !save.isPending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, save.isPending]);
  const canSave = !!file && !!draft && !doc.isLoading && (seriesId === undefined || !seriesFiles.isPending && !seriesFiles.isFetching) && !draft.error && comicInfoHasChanges(draft);
  const extraTags = draft?.scalarFields.filter(tag => !EDITOR_FIELDS.includes(tag)) ?? [];

  const fieldId = (field: string): string => `comicinfo-${field.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const renderField = (field: string) => {
    const id = fieldId(field);
    const changed = changedFields.includes(field);
    return <div key={field} className={cn('flex min-w-0 flex-col gap-1.5', field === 'Summary' && 'sm:col-span-2')}>
      <Label htmlFor={id} className="flex flex-wrap items-center justify-between gap-2">{FIELD_LABELS[field] ?? field}{changed && <span className="text-xs font-normal text-warning">Changed</span>}</Label>
      {field === 'Summary' ? <textarea id={id} value={values[field] ?? ''} onChange={event => patchDraft(current => editComicInfoField(current, field, event.target.value))} rows={4} className={cn('w-full rounded-lg border bg-surface-2 px-3 py-2 text-base lg:text-sm', changed ? 'border-warning/60' : 'border-border-2')} />
        : <Input id={id} value={values[field] ?? ''} onChange={event => patchDraft(current => editComicInfoField(current, field, event.target.value))} className={changed ? 'border-warning/60 bg-warning/10' : undefined} />}
    </div>;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0"><p className="break-words text-sm font-semibold">{file ? file.split(/[\\/]/).pop() : 'Choose an archive'}</p></div>
        <Button size="sm" variant="outline" aria-expanded={pickerOpen} onClick={() => setPickerOpen(open => !open)}>Change archive</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5" data-comicinfo-scroll>
          <section className="space-y-2 text-xs" aria-label="ComicInfo protection scope">
            <h3 className="text-sm font-semibold">Protection scope</h3>
            {associatedSeriesId === undefined ? <p className="text-muted">Series protection is unavailable for this path. No series association or series metadata history is claimed.</p>
              : protection.isPending ? <p role="status" className="text-muted">Loading series protection…</p>
              : protection.isError ? <div role="alert" className="space-y-2"><p className="text-danger">Could not load protection. Manual editing remains available.</p><Button variant="outline" size="sm" className="min-h-11" onClick={()=>void protection.refetch()}>Retry protection</Button></div>
              : <p className="break-words text-muted">Protected from H-Tosho sync and automated merge changes: {protection.data.lockedFields.length ? protection.data.lockedFields.join(', ') : 'none'}.</p>}
            <p className="text-muted">Deliberate manual ComicInfo editing is allowed and does not clear protection. Series-associated metadata edits are journaled; path-only edits are not.</p>
          </section>
          {pickerOpen && <div className="flex flex-col gap-3 border-b border-border pb-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                aria-label="CBZ file path"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') openFile(pathInput); }}
                placeholder="Absolute path to a .cbz file…"
                className="flex-1 font-mono text-base lg:text-xs"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => openFile(pathInput)} disabled={!pathInput.trim()} className="flex-1 sm:flex-none">Load</Button>
                <Button size="sm" variant={browseOpen ? 'default' : 'outline'} onClick={() => setBrowseOpen((v) => !v)} className="flex-1 sm:flex-none">
                  <FolderOpen className="h-3.5 w-3.5" /> Browse
                </Button>
              </div>
            </div>

            {seriesId !== undefined && (
              <div className="flex flex-col gap-1.5">
                {seriesFiles.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> Loading series files…</div>
                ) : seriesFiles.data?.reason ? (
                  <p className="text-xs text-warning">{seriesFiles.data.reason}</p>
                ) : seriesFiles.data && seriesFiles.data.files.length > 0 ? (
                  <>
                    <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted" title={seriesFiles.data.dir ?? undefined}>
                      <FileArchive className="h-3 w-3" /> {seriesFiles.data.name}
                    </span>
                    <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
                      {sortedFiles.map((f) => {
                        const num = seriesFiles.data?.chapterNumbers[f];
                        const pending = drafts[f] ? comicInfoHasChanges(drafts[f]) : false;
                        return (
                          <button key={f} type="button" onClick={() => openFile(f)} aria-label={`Open ${f}`}
                            className={cn(
                              'flex min-h-9 min-w-0 shrink-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                              f === file ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border-2 hover:border-primary/50',
                            )}>
                            <FileArchive className="h-3.5 w-3.5 shrink-0 text-success" />
                            {num && num.trim() !== '' && (
                              <span className="shrink-0 rounded-md bg-surface px-1.5 py-px font-mono text-2xs tabular-nums text-muted">{num}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{f.split(/[\\/]/).pop()}</span>
                            {pending && <span className="shrink-0 rounded-full bg-warning/20 px-1.5 py-px text-2xs font-medium text-warning">unsaved</span>}
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : seriesFiles.data ? (
                  <p className="text-xs text-muted">No .cbz files found in this series folder.</p>
                ) : null}
              </div>
            )}

            {browseOpen && (
              <div className="flex flex-col gap-2">
                {roots.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> Loading roots…</div>
                ) : roots.data && roots.data.roots.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted"><HardDrive className="h-3 w-3" /> Roots</span>
                    {roots.data.roots.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setDir(r)}
                        title={r}
                        className={cn(
                          'min-h-9 max-w-56 break-all rounded-full border px-2.5 py-1 text-xs transition-colors',
                          dir === r ? 'border-primary bg-primary/10 text-primary' : 'border-border-2 hover:border-primary/50 hover:text-foreground',
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted">No browse roots available — set a download directory in Settings and connect Kavita.</p>
                )}

                {dir && dirData.isLoading && <div className="flex items-center gap-2 text-xs text-muted"><Spinner /> Listing…</div>}
                {dir && dirData.error && <p className="text-xs text-danger">{dirData.error instanceof Error ? dirData.error.message : String(dirData.error)}</p>}
                {dir && dirData.data && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setDir(dirData.data.parent)}
                        disabled={!dirData.data.parent}
                        title={dirData.data.parent ?? undefined}
                        className="flex min-h-9 items-center gap-1 rounded-md border border-border-2 px-3 py-1 text-muted transition-colors hover:text-foreground disabled:opacity-40"
                      >
                        <ArrowUp className="h-3 w-3" /> Up
                      </button>
                      <span className="break-all font-mono text-xs text-muted">{dirData.data.path}</span>
                    </div>
                    {dirData.data.dirs.length > 0 || dirData.data.files.length > 0 ? (
                      <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {dirData.data.dirs.map((d) => (
                          <button key={d} type="button" onClick={() => setDir(joinPath(dirData.data.path, d))} aria-label={`Open folder ${d}`}
                            className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md border border-border-2 px-2 py-1 text-left text-xs transition-colors hover:border-primary/50">
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" /> <span className="break-all">{d}</span>
                          </button>
                        ))}
                        {dirData.data.files.map((f) => (
                          <button key={f} type="button" onClick={() => openFile(joinPath(dirData.data.path, f))} aria-label={`Open file ${f}`}
                            className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md border border-border-2 px-2 py-1 text-left text-xs transition-colors hover:border-primary/50">
                            <FileArchive className="h-3.5 w-3.5 shrink-0 text-success" /> <span className="break-all">{f}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted">No subdirectories or .cbz files here.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>}

          {/* Document editor */}
          {doc.isLoading && file && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted"><Spinner /> Reading ComicInfo.xml…</div>
          )}
          {doc.error && file && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
              {doc.error instanceof Error ? doc.error.message : String(doc.error)}
            </div>
          )}
          {doc.data && (
            <>
              {!doc.data.hasEntry && (
                <p className="text-xs text-muted">This archive has no ComicInfo.xml yet — saving will create one.</p>
              )}
              {draft?.error && <p role="alert" id="comicinfo-xml-error" className="text-sm text-danger">{draft.error}</p>}
                <div className="space-y-6">
                  {FIELD_GROUPS.map(group => <fieldset key={group.title} className="min-w-0 space-y-3">
                    <legend className="mb-3 text-sm font-semibold">{group.title}</legend>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">{group.fields.map(renderField)}</div>
                  </fieldset>)}
                  {extraTags.length > 0 && <Disclosure label="Other metadata fields"><div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">{extraTags.map(renderField)}</div></Disclosure>}
                </div>

            </>
          )}

          {!file && !doc.isLoading && (
            <EmptyState icon={<FileText className="h-8 w-8" />} title="No file selected" description="Type a path or browse to pick a .cbz archive." />
          )}

      </div>
      <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 text-xs text-muted" role="status">
          <p>{draft?.error ? 'Cannot save unreadable metadata.' : draft && comicInfoHasChanges(draft) ? `${changedFields.length} changed field${changedFields.length === 1 ? '' : 's'}` : 'No unsaved changes in this archive.'}</p>
          {file && queuedFiles[file] && <p className="mt-1">Save queued as job #{queuedFiles[file]}. <a href="/jobs" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-4">Check write progress</a></p>}
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          {onClose && <Button variant="outline" size="sm" onClick={onClose}>Close</Button>}
          <Button size="sm" onClick={() => { if (file && draft) save.mutate({ path: file, snapshot: draft }); }} disabled={!canSave || save.isPending}>
            {save.isPending ? <Spinner /> : <Save className="h-3.5 w-3.5" />} {save.isPending ? 'Queueing…' : 'Queue save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Dialog wrapper around the editor (used from the Downloader and Libraries pages). */
export function ComicInfoModal({ initialPath, seriesId, onClose }: ComicInfoModalProps) {
  const [state, setState] = React.useState({ dirty: false, pending: false, file: initialPath ?? null as string | null });
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const requestClose = () => {
    if (state.pending) return;
    if (state.dirty) setConfirmDiscard(true);
    else onClose?.();
  };
  return <>
    <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
      <DialogContent className="flex h-[min(58rem,calc(100dvh-1.5rem))] max-w-2xl flex-col" onEscapeKeyDown={event => { if (state.pending) event.preventDefault(); }} onPointerDownOutside={event => { if (state.pending) event.preventDefault(); }}>
        <div className="flex shrink-0 items-start gap-2 border-b border-border p-4 pr-14 sm:p-5 sm:pr-14">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div><DialogTitle>Edit ComicInfo</DialogTitle><DialogDescription className="sr-only">Edit ComicInfo metadata.</DialogDescription></div>
        </div>
        <ComicInfoEditor initialPath={initialPath} seriesId={seriesId} onClose={requestClose} onStateChange={setState} />
      </DialogContent>
    </Dialog>
    <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
      <DialogContent className="max-w-md">
        <div className="space-y-4 p-5 pr-14">
          <div><DialogTitle>Discard unsaved changes?</DialogTitle><DialogDescription className="mt-2">Unsaved drafts in all opened archives will be discarded. Saves already queued in Tasks are not cancelled.</DialogDescription></div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button variant="danger" onClick={() => { setConfirmDiscard(false); onClose?.(); }}>Discard changes</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
