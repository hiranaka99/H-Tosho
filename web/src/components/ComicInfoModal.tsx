import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, FolderOpen, FileArchive, ArrowUp, Save, Code2, PencilLine, HardDrive } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Dialog, DialogContent, Input, Label, Spinner, EmptyState } from './ui';

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
  const [mode, setMode] = React.useState<'form' | 'raw'>('form');
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [order, setOrder] = React.useState<string[]>([]);
  const [rawText, setRawText] = React.useState(EMPTY_DOC);

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

  // Load the parsed document into form + raw state.
  React.useEffect(() => {
    if (!doc.data) return;
    const base: Record<string, string> = Object.fromEntries(EDITOR_FIELDS.map((f) => [f, '']));
    setValues({ ...base, ...doc.data.fields });
    setOrder(doc.data.order);
    setRawText(doc.data.raw ?? EMPTY_DOC);
    setMode('form');
  }, [doc.data]);

  const openFile = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    setPathInput(trimmed);
    setFile(trimmed);
    setBrowseOpen(false);
  };

  /** Only fields that actually changed are sent — the server merges them over the file's current entry. */
  const changedFields = React.useMemo(() => {
    const orig = doc.data?.fields ?? {};
    return Object.keys(values).filter((k) => (values[k] ?? '') !== (orig[k] ?? ''));
  }, [values, doc.data]);

  const save = useMutation({
    mutationFn: () =>
      mode === 'raw'
        ? api.enqueue('edit-comicinfo', { path: file!, xml: rawText })
        : api.enqueue('edit-comicinfo', { path: file!, fields: Object.fromEntries(changedFields.map((k) => [k, values[k]])) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'success', title: 'ComicInfo save queued', description: `${file} — check the Jobs page` });
      onClose?.();
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue save', description: e instanceof Error ? e.message : String(e) }),
  });

  const canSave = !!file && !doc.isLoading && (mode === 'raw' ? rawText.trim() !== '' : changedFields.length > 0);

  // Extra tags present in the file but not in the standard editor set.
  const extraTags = order.filter((t) => !(EDITOR_FIELDS as readonly string[]).includes(t));

  return (
    <div className="flex flex-col gap-4">

          {/* File picker */}
          <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <Input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') openFile(pathInput); }}
                placeholder="Absolute path to a .cbz file…"
                className="flex-1 font-mono text-xs"
              />
              <Button size="sm" variant="secondary" onClick={() => openFile(pathInput)} disabled={!pathInput.trim()}>
                Load
              </Button>
              <Button size="sm" variant={browseOpen ? 'default' : 'outline'} onClick={() => setBrowseOpen((v) => !v)}>
                <FolderOpen className="h-3.5 w-3.5" /> Browse
              </Button>
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
                    <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto">
                      {seriesFiles.data.files.map((f) => (
                        <button key={f} type="button" onClick={() => openFile(f)} title={f}
                          className={cn(
                            'flex min-w-0 items-center gap-1.5 truncate rounded border px-2 py-1 text-left text-xs transition-colors',
                            f === file ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border-2 hover:border-primary/50',
                          )}>
                          <FileArchive className="h-3.5 w-3.5 shrink-0 text-success" /> {f.split(/[\\/]/).pop()}
                        </button>
                      ))}
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
                          'max-w-56 truncate rounded-full border px-2.5 py-1 text-xs transition-colors',
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
                        className="flex items-center gap-1 rounded border border-border-2 px-2 py-1 text-muted transition-colors hover:text-foreground disabled:opacity-40"
                      >
                        <ArrowUp className="h-3 w-3" /> Up
                      </button>
                      <span className="truncate font-mono text-[11px] text-muted" title={dirData.data.path}>{dirData.data.path}</span>
                    </div>
                    {dirData.data.dirs.length > 0 || dirData.data.files.length > 0 ? (
                      <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto">
                        {dirData.data.dirs.map((d) => (
                          <button key={d} type="button" onClick={() => setDir(joinPath(dirData.data.path, d))} title={d}
                            className="flex min-w-0 items-center gap-1.5 truncate rounded border border-border-2 px-2 py-1 text-left text-xs transition-colors hover:border-primary/50">
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" /> {d}
                          </button>
                        ))}
                        {dirData.data.files.map((f) => (
                          <button key={f} type="button" onClick={() => openFile(joinPath(dirData.data.path, f))} title={joinPath(dirData.data.path, f)}
                            className="flex min-w-0 items-center gap-1.5 truncate rounded border border-border-2 px-2 py-1 text-left text-xs transition-colors hover:border-primary/50">
                            <FileArchive className="h-3.5 w-3.5 shrink-0 text-success" /> {f}
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
                  onClick={() => setMode('form')}
                  className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors', mode === 'form' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-foreground')}
                >
                  <PencilLine className="h-3.5 w-3.5" /> Fields
                </button>
                <button
                  type="button"
                  onClick={() => setMode('raw')}
                  className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors', mode === 'raw' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-foreground')}
                >
                  <Code2 className="h-3.5 w-3.5" /> Raw XML
                </button>
              </div>

              {mode === 'form' ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  {EDITOR_FIELDS.map((f) => (
                    <div key={f} className={cn('flex flex-col gap-1', f === 'Summary' && 'col-span-2')}>
                      <Label>{f}</Label>
                      {f === 'Summary' ? (
                        <textarea
                          value={values[f] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                          rows={4}
                          className="w-full rounded-md border border-border-2 bg-surface px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
                        />
                      ) : (
                        <Input value={values[f] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} />
                      )}
                    </div>
                  ))}
                  {extraTags.map((t) => (
                    <div key={t} className="flex flex-col gap-1">
                      <Label>{t}</Label>
                      <Input value={values[t] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [t]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              ) : (
                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="w-full rounded-md border border-border-2 bg-surface px-3 py-2 font-mono text-xs leading-relaxed outline-none transition-colors focus:border-primary"
                />
              )}
            </>
          )}

          {!file && !doc.isLoading && (
            <EmptyState icon={<FileText className="h-8 w-8" />} title="No file selected" description="Type a path or browse to pick a .cbz archive." />
          )}

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <p className="min-w-0 truncate text-[11px] text-muted">
              {mode === 'raw' ? 'Raw XML is written to the archive verbatim.' : `${changedFields.length} changed field${changedFields.length === 1 ? '' : 's'} will be merged into the file's ComicInfo.xml.`}
            </p>
            <div className="flex shrink-0 items-center gap-2">
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
          <div className="flex items-center gap-2 pr-6">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Edit ComicInfo</h2>
          </div>
          <ComicInfoEditor initialPath={initialPath} seriesId={seriesId} onClose={onClose} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
