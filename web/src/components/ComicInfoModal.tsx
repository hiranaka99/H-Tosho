import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, FolderOpen, FileArchive, ArrowUp, Save, Code2, PencilLine, HardDrive } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, Spinner, EmptyState } from './ui';

/** Fields offered in the form editor, mirroring the server's COMICINFO_EDITOR_FIELDS. */
const EDITOR_FIELDS = [
  'Title',
  'Series',
  'Number',
  'Volume',
  'Artist',
  'Writer',
  'Publisher',
  'Summary',
  'Tags',
  'Language',
  'Year',
  'Web',
] as const;

const EMPTY_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
</ComicInfo>
`;
/** Per-file editor state so switching files never loses pending changes. */
interface Draft {
  values: Record<string, string>;
  order: string[];
  rawText: string;
  mode: 'form' | 'raw';
  /** Field values as loaded from the file (baseline for change detection). */
  orig: Record<string, string>;
  origRaw: string;
}

const emptyValues = (): Record<string, string> => Object.fromEntries(EDITOR_FIELDS.map((f) => [f, '']));

/** Field keys whose value differs from the file's loaded baseline. */
function changedFieldKeys(d: Draft): string[] {
  return Object.keys(d.values).filter((k) => (d.values[k] ?? '') !== (d.orig[k] ?? ''));
}

function draftHasChanges(d: Draft): boolean {
  if (d.mode === 'raw') return d.rawText.trim() !== '' && d.rawText !== d.origRaw;
  return changedFieldKeys(d).length > 0;
}

/** Join a directory + child using the separator the server's paths actually use. */
const joinPath = (dir: string, name: string): string => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;

interface ComicInfoModalProps {
  /** Absolute path to open immediately (e.g. from a completed download row). */
  initialPath?: string;
  /** Kavita series to list archives for (entry point from the Libraries page). */
  seriesId?: number;
  /** Present in dialog mode — hides the Cancel button on the standalone page. */
  onClose?: () => void;
}

export function ComicInfoEditor({ initialPath, seriesId, onClose }: ComicInfoModalProps) {
  const qc = useQueryClient();
  const [pathInput, setPathInput] = React.useState(initialPath ?? '');
  const [browseOpen, setBrowseOpen] = React.useState(!initialPath && seriesId === undefined);
  const [file, setFile] = React.useState<string | null>(initialPath ?? null);
  const [dir, setDir] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const draft = file ? drafts[file] : undefined;
  const mode = draft?.mode ?? 'form';
  const values = draft?.values ?? {};
  const order = draft?.order ?? [];
  const rawText = draft?.rawText ?? EMPTY_DOC;

  /** Patch the current file's draft (no-op until its document has loaded). */
  const patchDraft = (patch: Partial<Draft>) => {
    if (!file) return;
    setDrafts((prev) => (prev[file] ? { ...prev, [file]: { ...prev[file], ...patch } } : prev));
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
    setDrafts((prev) => {
      if (prev[file]) return prev;
      return {
        ...prev,
        [file]: {
          values: { ...emptyValues(), ...doc.data.fields },
          order: doc.data.order,
          rawText: doc.data.raw ?? EMPTY_DOC,
          mode: 'form',
          orig: { ...doc.data.fields },
          origRaw: doc.data.raw ?? EMPTY_DOC,
        },
      };
    });
  }, [doc.data, file]);

  const openFile = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    setPathInput(trimmed);
    setFile(trimmed);
    setBrowseOpen(false);
  };

  /** Only fields that actually changed are sent — the server merges them over the file's current entry. */
  const changedFields = React.useMemo(() => (draft && draft.mode === 'form' ? changedFieldKeys(draft) : []), [draft]);

  const save = useMutation({
    mutationFn: () =>
      mode === 'raw'
        ? api.enqueue('edit-comicinfo', { path: file!, xml: rawText, ...(seriesId !== undefined ? { seriesId } : {}) })
        : api.enqueue('edit-comicinfo', { path: file!, fields: Object.fromEntries(changedFields.map((k) => [k, values[k]])), ...(seriesId !== undefined ? { seriesId } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      const savedPath = file!;
      // Advance the draft's baseline so its pending indicator clears while the
      // just-saved values stay displayed. The modal stays open so other files
      // in the series can be edited next.
      setDrafts((prev) => (prev[savedPath] ? { ...prev, [savedPath]: { ...prev[savedPath], orig: { ...prev[savedPath].values }, origRaw: prev[savedPath].rawText } } : prev));
      toast({ tone: 'success', title: 'ComicInfo save queued', description: `${savedPath.split(/[\\/]/).pop()} — check the Jobs page` });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue save', description: e instanceof Error ? e.message : String(e) }),
  });

  const canSave = !!file && !!draft && !doc.isLoading && draftHasChanges(draft);

  // Extra tags present in the file but not in the standard editor set.
  const extraTags = order.filter((t) => !(EDITOR_FIELDS as readonly string[]).includes(t));

  const fieldId = (field: string): string => `comicinfo-${field.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <div className="flex flex-col gap-4">

          {/* File picker */}
          <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                aria-label="CBZ file path"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') openFile(pathInput); }}
                placeholder="Absolute path to a .cbz file…"
                className="flex-1 font-mono text-xs"
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
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted" title={seriesFiles.data.dir ?? undefined}>
                      <FileArchive className="h-3 w-3" /> {seriesFiles.data.name}
                    </span>
                    <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
                      {sortedFiles.map((f) => {
                        const num = seriesFiles.data?.chapterNumbers[f];
                        const pending = drafts[f] ? draftHasChanges(drafts[f]) : false;
                        return (
                          <button key={f} type="button" onClick={() => openFile(f)} aria-label={`Open ${f}`}
                            className={cn(
                              'flex min-h-11 min-w-0 shrink-0 items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors',
                              f === file ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border-2 hover:border-primary/50',
                            )}>
                            <FileArchive className="h-3.5 w-3.5 shrink-0 text-success" />
                            {num && num.trim() !== '' && (
                              <span className="shrink-0 rounded bg-surface px-1.5 py-px font-mono text-[10px] tabular-nums text-muted">{num}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{f.split(/[\\/]/).pop()}</span>
                            {pending && <span className="shrink-0 rounded-full bg-warning/20 px-1.5 py-px text-[10px] font-medium text-warning">unsaved</span>}
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
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted"><HardDrive className="h-3 w-3" /> Roots</span>
                    {roots.data.roots.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setDir(r)}
                        title={r}
                        className={cn(
                          'min-h-11 max-w-56 break-all rounded-full border px-2.5 py-1 text-xs transition-colors',
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
                        className="flex min-h-11 items-center gap-1 rounded border border-border-2 px-3 py-1 text-muted transition-colors hover:text-foreground disabled:opacity-40"
                      >
                        <ArrowUp className="h-3 w-3" /> Up
                      </button>
                      <span className="break-all font-mono text-[11px] text-muted">{dirData.data.path}</span>
                    </div>
                    {dirData.data.dirs.length > 0 || dirData.data.files.length > 0 ? (
                      <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {dirData.data.dirs.map((d) => (
                          <button key={d} type="button" onClick={() => setDir(joinPath(dirData.data.path, d))} aria-label={`Open folder ${d}`}
                            className="flex min-h-11 min-w-0 items-center gap-1.5 rounded border border-border-2 px-2 py-1 text-left text-xs transition-colors hover:border-primary/50">
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" /> <span className="break-all">{d}</span>
                          </button>
                        ))}
                        {dirData.data.files.map((f) => (
                          <button key={f} type="button" onClick={() => openFile(joinPath(dirData.data.path, f))} aria-label={`Open file ${f}`}
                            className="flex min-h-11 min-w-0 items-center gap-1.5 rounded border border-border-2 px-2 py-1 text-left text-xs transition-colors hover:border-primary/50">
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
          </div>

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
              {!doc.data.hasEntry && mode === 'form' && (
                <p className="text-xs text-muted">This archive has no ComicInfo.xml yet — saving will create one.</p>
              )}
              <div className="flex items-center gap-1 self-start rounded-lg border border-border-2 p-0.5">
                <button
                  type="button"
                  onClick={() => patchDraft({ mode: 'form' })}
                  className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors', mode === 'form' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-foreground')}
                >
                  <PencilLine className="h-3.5 w-3.5" /> Fields
                </button>
                <button
                  type="button"
                  onClick={() => patchDraft({ mode: 'raw' })}
                  className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors', mode === 'raw' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-foreground')}
                >
                  <Code2 className="h-3.5 w-3.5" /> Raw XML
                </button>
              </div>

              {mode === 'form' ? (
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  {EDITOR_FIELDS.map((f) => {
                    const id = fieldId(f);
                    const isChanged = draft ? (values[f] ?? '') !== (draft.orig[f] ?? '') : false;
                    return (
                      <div key={f} className={cn('flex flex-col gap-1', f === 'Summary' && 'sm:col-span-2')}>
                        <Label htmlFor={id} className={isChanged ? 'text-warning' : undefined}>{f}</Label>
                        {f === 'Summary' ? (
                          <textarea
                            id={id}
                            value={values[f] ?? ''}
                            onChange={(e) => patchDraft({ values: { ...values, [f]: e.target.value } })}
                            rows={4}
                            className={cn('w-full rounded-md border bg-surface px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/50', isChanged ? 'border-warning/60' : 'border-border-2')}
                          />
                        ) : (
                          <Input id={id} value={values[f] ?? ''} onChange={(e) => patchDraft({ values: { ...values, [f]: e.target.value } })} className={isChanged ? 'border-warning/60 bg-warning/10' : undefined} />
                        )}
                      </div>
                    );
                  })}
                  {extraTags.map((t) => {
                    const isChanged = draft ? (values[t] ?? '') !== (draft.orig[t] ?? '') : false;
                    return (
                      <div key={t} className="flex flex-col gap-1">
                        <Label htmlFor={fieldId(t)} className={isChanged ? 'text-warning' : undefined}>{t}</Label>
                        <Input id={fieldId(t)} value={values[t] ?? ''} onChange={(e) => patchDraft({ values: { ...values, [t]: e.target.value } })} className={isChanged ? 'border-warning/60 bg-warning/10' : undefined} />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  value={rawText}
                  onChange={(e) => patchDraft({ rawText: e.target.value })}
                  rows={14}
                  spellCheck={false}
                  className={cn('w-full rounded-md border bg-surface px-3 py-2 font-mono text-xs leading-relaxed outline-none transition-colors focus:border-primary', draft && rawText !== draft.origRaw ? 'border-warning/60' : 'border-border-2')}
                />
              )}
            </>
          )}

          {!file && !doc.isLoading && (
            <EmptyState icon={<FileText className="h-8 w-8" />} title="No file selected" description="Type a path or browse to pick a .cbz archive." />
          )}

          {/* Footer */}
          <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-sm text-muted">
              {mode === 'raw' ? 'Raw XML is written to the archive verbatim.' : `${changedFields.length} changed field${changedFields.length === 1 ? '' : 's'} will be merged into the file's ComicInfo.xml.`}
            </p>
            <div className="flex shrink-0 justify-end gap-2">
              {onClose && <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>}
              <Button size="sm" onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
                {save.isPending ? <Spinner /> : <Save className="h-3.5 w-3.5" />} Save
              </Button>
            </div>
          </div>
    </div>
  );
}

/** Dialog wrapper around the editor (used from the Downloader and Libraries pages). */
export function ComicInfoModal({ initialPath, seriesId, onClose }: ComicInfoModalProps) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start gap-2 pr-10">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <DialogTitle>Edit ComicInfo</DialogTitle>
              <DialogDescription>Edit metadata stored inside the selected CBZ archive.</DialogDescription>
            </div>
          </div>
          <ComicInfoEditor initialPath={initialPath} seriesId={seriesId} onClose={onClose} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
