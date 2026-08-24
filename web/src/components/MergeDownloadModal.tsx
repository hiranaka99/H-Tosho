import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Combine, FolderInput, Search, X } from 'lucide-react';
import { api, type DoujinSearchResult } from '../lib/api';
import { useDownloads } from '../lib/DownloadsContext';
import { Button, Dialog, DialogContent, Input, Label, Spinner } from './ui';
import { toast } from '../lib/toast';

interface MergeDownloadModalProps {
  /** The selected search results that form one series. */
  items: DoujinSearchResult[];
  /** 'existing' opens focused on merging into an existing Kavita series. */
  initialMode?: 'new' | 'existing';
  onClose: () => void;
}

/** Pull a chapter number out of titles like "… ch 12 …", "chapter 3", "#5". */
function prefillChapter(title: string): string {
  const m = title.match(/\b(?:ch|chap|chapter|ep)\.?\s*(\d+(?:\.\d+)?)/i) ?? title.match(/#(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

interface SeriesOption {
  id: number;
  name: string;
  libraryName: string;
}

/**
 * Batch-download several galleries into one shared folder so Kavita groups them
 * as a single series. Each gallery becomes its own .cbz with a manual chapter
 * number (ComicInfo.Number) for ordering. The target is either a new merged
 * series name or an existing Kavita series, whose folder the chapters land in.
 */
export function MergeDownloadModal({ items, initialMode = 'new', onClose }: MergeDownloadModalProps) {
  const qc = useQueryClient();
  const { startDownload } = useDownloads();
  const [seriesName, setSeriesName] = React.useState('');
  const [chapters, setChapters] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((it) => [`${it.source}:${it.galleryId}`, prefillChapter(it.title)])),
  );
  const [pickerOpen, setPickerOpen] = React.useState(initialMode === 'existing');
  const [targetId, setTargetId] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const roots = useQuery({ queryKey: ['cbz-roots'], queryFn: api.cbzRoots });
  const options = useQuery({
    queryKey: ['merge-into-series-options'],
    queryFn: async (): Promise<SeriesOption[]> => {
      const libs = await api.libraries();
      const all = await Promise.all(
        libs.map(async (lib) => {
          try {
            const series = await api.librarySeries(lib.id);
            return series.map((s) => ({ id: s.id, name: s.name, libraryName: lib.name }));
          } catch {
            return [];
          }
        }),
      );
      return all.flat().sort((a, b) => a.name.localeCompare(b.name));
    },
  });
  const targetInfo = useQuery({
    queryKey: ['cbz-series-files', targetId],
    queryFn: () => api.cbzSeriesFiles(targetId!),
    enabled: targetId != null,
  });

  /** Resolve the selected series to a folder name inside the download directory. */
  const root = roots.data?.roots[0] ?? '';
  const norm = (p: string) => p.replace(/\\/g, '/');
  let targetFolderName: string | null = null;
  let targetWarning: string | null = null;
  if (targetId != null && targetInfo.data) {
    const dir = targetInfo.data.dir;
    if (!dir) {
      targetWarning = 'Could not locate this series on this machine — pick another one.';
    } else if (!root || !norm(dir).startsWith(norm(root))) {
      targetWarning = `This series' folder is outside the download directory, so chapters can't land there directly. Download normally and merge from the Manager instead.`;
    } else {
      const name = dir.split(/[\\/]/).pop();
      if (name) targetFolderName = name;
    }
  }

  const selectedTarget = options.data?.find((o) => o.id === targetId);
  const effectiveFolder = targetFolderName ?? seriesName.trim();
  const canSubmit = !!effectiveFolder && !pending;

  const confirm = async () => {
    if (!canSubmit) return;
    setPending(true);
    let queued = 0;
    const skipped: string[] = [];
    try {
      for (const it of items) {
        const key = `${it.source}:${it.galleryId}`;
        const raw = chapters[key]?.trim();
        const chapter = raw && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
        try {
          await startDownload({ source: it.source, galleryId: it.galleryId, title: it.title ?? undefined, format: 'cbz', mergeFolder: effectiveFolder, chapter });
          queued++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === 'already-downloaded') skipped.push(it.title);
          else throw e;
        }
      }
      setPending(false);
      qc.invalidateQueries({ queryKey: ['downloads'] });
      if (skipped.length > 0) {
        toast({ tone: 'info', title: `${skipped.length} already downloaded`, description: skipped.join(', ').slice(0, 240) });
      }
      if (queued > 0) {
        const desc = targetFolderName && selectedTarget
          ? `Chapters land in “${selectedTarget.name}”'s folder and appear as new chapters of that series.`
          : `All chapters land in one folder — “${effectiveFolder}” becomes the series.`;
        toast({ tone: 'success', title: `${queued} download${queued === 1 ? '' : 's'} queued`, description: desc });
        onClose();
      } else {
        toast({ tone: 'info', title: 'Nothing to download', description: 'Every selected gallery is already downloaded.' });
      }
    } catch (e) {
      setPending(false);
      toast({ tone: 'danger', title: `Queued ${queued} of ${items.length}`, description: e instanceof Error ? e.message : String(e) });
    }
  };

  const filtered = (options.data ?? []).filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2 pr-6">
            <Combine className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Merge &amp; download</h2>
          </div>

          {/* Target: new series name or existing series */}
          <div className="flex flex-col gap-3 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className={targetId != null ? 'opacity-40' : undefined}>
              <Label htmlFor="merge-dl-name">New merged series name</Label>
              <Input
                id="merge-dl-name"
                value={seriesName}
                onChange={(e) => setSeriesName(e.target.value)}
                placeholder="e.g. A Fifth of Romance"
                disabled={targetId != null}
                className="mt-1.5"
              />
            </div>

            <div className="flex flex-col gap-1.5 border-t border-border-2 pt-3">
              {targetId == null && !pickerOpen ? (
                <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)} className="-ml-2 h-7 justify-start text-xs text-muted">
                  <FolderInput className="h-3.5 w-3.5" /> Or merge into an existing series…
                </Button>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="merge-dl-existing">Merge into an existing series</Label>
                    {targetId != null && (
                      <button type="button" onClick={() => setTargetId(null)} className="flex items-center gap-1 text-[11px] text-muted hover:text-danger" title="Clear selection">
                        <X className="h-3 w-3" /> Clear
                      </button>
                    )}
                  </div>
                  {targetId != null ? (
                    selectedTarget && (
                      <p className="rounded-md border border-primary/40 bg-surface px-2 py-1.5 text-xs">
                        <span className="font-medium">{selectedTarget.name}</span>{' '}
                        <span className="text-muted">· {selectedTarget.libraryName} · chapters land in its folder</span>
                      </p>
                    )
                  ) : (
                    <>
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                        <Input id="merge-dl-existing" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search series…" className="h-8 pl-7 text-xs" />
                      </div>
                      <div className="max-h-40 overflow-y-auto rounded-md border border-border-2 bg-surface">
                        {options.isLoading ? (
                          <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted"><Spinner /> Loading series…</div>
                        ) : filtered.length === 0 ? (
                          <p className="px-3 py-2.5 text-xs text-muted">No matching series.</p>
                        ) : (
                          filtered.slice(0, 200).map((o) => (
                            <button key={o.id} type="button" onClick={() => setTargetId(o.id)} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2">
                              <span className="truncate">{o.name}</span>
                              <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[9px] uppercase tracking-wide text-muted">{o.libraryName}</span>
                            </button>
                          ))
                        )}
                      </div>
                    </>
                  )}
                  {targetWarning && <p className="text-[11px] text-danger">{targetWarning}</p>}
                </>
              )}
            </div>
            <p className="text-[11px] text-muted">
              Each gallery downloads as its own .cbz into one shared folder — Kavita shows them as a single series.
            </p>
          </div>

          {/* Per-gallery chapter numbers */}
          <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Chapters</span>
              <span className="text-xs text-muted">{items.length} item{items.length === 1 ? '' : 's'}</span>
            </div>
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
              {items.map((it) => {
                const key = `${it.source}:${it.galleryId}`;
                return (
                  <div key={key} className="flex items-center gap-2 rounded-md border border-border-2 bg-surface px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs" title={it.title}>{it.title}</span>
                    {it.pageCount ? <span className="shrink-0 text-[10px] text-muted">{it.pageCount}p</span> : null}
                    <Input
                      value={chapters[key] ?? ''}
                      onChange={(e) => setChapters((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="Ch #"
                      inputMode="decimal"
                      className="h-7 w-20 shrink-0 px-2 text-xs"
                      aria-label={`Chapter number for ${it.title}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
              Chapter numbers are written to each archive's ComicInfo.Number for ordering.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={() => void confirm()} disabled={!canSubmit}>
                {pending ? <Spinner /> : <Combine className="h-3.5 w-3.5" />} Queue {items.length} download{items.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
