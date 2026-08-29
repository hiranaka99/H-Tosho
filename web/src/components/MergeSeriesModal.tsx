import * as React from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Combine, FolderInput } from 'lucide-react';
import { api, type SeriesRow } from '../lib/api';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, Spinner, EmptyState } from './ui';
import { toast } from '../lib/toast';

interface MergeSeriesModalProps {
  /** The selected Kavita series (two or more) whose files will be merged. */
  selected: SeriesRow[];
  onClose: () => void;
}

/** One .cbz collected from the selected series, with an editable chapter number. */
interface MergeFile {
  path: string;
  name: string;
  /** Name of the series this file currently belongs to (display only). */
  fromSeries: string;
  /** Chapter number written to ComicInfo.Number on merge ('' = leave as-is). */
  chapter: string;
}

/** Per-series resolution result shown in the dialog. */
interface SeriesFiles {
  series: SeriesRow;
  files: string[];
  chapterNumbers: Record<string, string>;
  reason: string | null;
}

export function MergeSeriesModal({ selected, onClose }: MergeSeriesModalProps) {
  const qc = useQueryClient();
  const [seriesName, setSeriesName] = React.useState(selected[0]?.name ?? '');
  const [targetOverride, setTargetOverride] = React.useState('');
  const [files, setFiles] = React.useState<MergeFile[] | null>(null);

  const roots = useQuery({ queryKey: ['cbz-roots'], queryFn: api.cbzRoots });
  // One canonical cache entry per source series (same ['cbz-series-files', id]
  // shape ComicInfoModal uses) so chapter edits elsewhere invalidate these too.
  const perSeries = useQueries({
    queries: selected.map((s) => ({
      queryKey: ['cbz-series-files', s.id],
      queryFn: () => api.cbzSeriesFiles(s.id),
      retry: false,
    })),
    combine: (results) => ({
      isLoading: results.some((r) => r.isPending),
      data: results.map((r, i): SeriesFiles => {
        const s = selected[i];
        if (r.data) return { series: s, files: r.data.files, chapterNumbers: r.data.chapterNumbers ?? {}, reason: r.data.reason };
        return { series: s, files: [], chapterNumbers: {}, reason: r.error instanceof Error ? r.error.message : String(r.error) };
      }),
    }),
  });

  // Build the draft list once when the files first arrive, then merge later
  // refetches: chapter numbers the user typed (keyed by file path) survive
  // window-focus refetches, while files added or removed server-side still sync.
  React.useEffect(() => {
    if (!perSeries.data) return;
    setFiles((prev) => {
      const prevChapter: Record<string, string> = {};
      for (const f of prev ?? []) prevChapter[f.path] = f.chapter;
      const seen = new Set<string>();
      const list: MergeFile[] = [];
      for (const entry of perSeries.data) {
        for (const f of entry.files) {
          if (seen.has(f)) continue;
          seen.add(f);
          list.push({
            path: f,
            name: f.split(/[\\/]/).pop() ?? f,
            fromSeries: entry.series.name,
            chapter: prevChapter[f] ?? entry.chapterNumbers[f] ?? '',
          });
        }
      }
      return list;
    });
  }, [perSeries.data]);

  // Default target = the download directory (first root) + the merged series name.
  const defaultTarget = React.useMemo(() => {
    const root = roots.data?.roots[0];
    if (!root || !seriesName.trim()) return '';
    const sep = root.includes('\\') ? '\\' : '/';
    return `${root}${sep}${seriesName.trim()}`;
  }, [roots.data, seriesName]);

  const targetDir = targetOverride.trim() || defaultTarget;

  const setChapter = (path: string, chapter: string) => {
    setFiles((prev) => prev?.map((f) => (f.path === path ? { ...f, chapter } : f)) ?? null);
  };

  const canSave = !!seriesName.trim() && !!targetDir && (files?.length ?? 0) > 0;

  const save = useMutation({
    mutationFn: () => {
      const chapters: Record<string, string> = {};
      for (const f of files ?? []) if (f.chapter.trim()) chapters[f.path] = f.chapter.trim();
      return api.enqueue('merge-series', {
        sourceFiles: (files ?? []).map((f) => f.path),
        targetDir,
        chapters,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'success', title: 'Merge queued', description: `${files?.length ?? 0} file(s) → ${targetDir}` });
      onClose();
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue merge', description: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start gap-2 pr-10">
            <Combine className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <DialogTitle>Merge series</DialogTitle>
              <DialogDescription>Move the selected archives into one Kavita series folder.</DialogDescription>
            </div>
          </div>

          {/* Series name + target folder */}
          <div className="flex flex-col gap-3 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="merge-name">Merged series name</Label>
              <Input id="merge-name" value={seriesName} onChange={(e) => setSeriesName(e.target.value)} placeholder="e.g. A Fifth of Romance" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="merge-target">Target folder</Label>
              <Input id="merge-target" value={targetOverride} onChange={(e) => setTargetOverride(e.target.value)} placeholder={defaultTarget || 'Select a series name first'} />
              <p className="text-xs text-muted">
                All files move into this folder — Kavita shows one series per folder, so the folder name becomes the series name.
              </p>
            </div>
          </div>

          {/* File list with chapter numbers */}
          <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Files to merge</span>
              {files && <span className="text-xs text-muted">{files.length} file{files.length === 1 ? '' : 's'}</span>}
            </div>

            {perSeries.isLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted"><Spinner /> Collecting files…</div>
            ) : !files || files.length === 0 ? (
              <EmptyState icon={<FolderInput className="h-8 w-8" />} title="No .cbz files found" description={perSeries.data?.find((e) => e.reason)?.reason ?? 'The selected series have no archives on this machine.'} />
            ) : (
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                {files.map((f) => (
                  <div key={f.path} className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 rounded-md border border-border-2 bg-surface px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_8rem_5rem]">
                    <span className="min-w-0 truncate text-xs" title={`${f.path}\n(from ${f.fromSeries})`}>{f.name}</span>
                    <span className="hidden truncate text-xs text-muted sm:block" title={f.fromSeries}>{f.fromSeries}</span>
                    <Input value={f.chapter} onChange={(e) => setChapter(f.path, e.target.value)} placeholder="Ch #" inputMode="decimal" className="h-8 w-full px-2 text-xs" aria-label={`Chapter number for ${f.name}`} />
                  </div>
                ))}
              </div>
            )}

            {perSeries.data?.filter((e) => e.reason).map((e) => (
              <p key={e.series.id} className="text-xs text-warning">{e.series.name}: {e.reason}</p>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 text-sm text-muted">
              After the merge, Kavita shows these files as one series. Empty leftover series may remain — delete them in Kavita.
            </p>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={() => save.mutate()} disabled={!canSave || save.isPending || perSeries.isLoading}>
                {save.isPending ? <Spinner /> : <Combine className="h-3.5 w-3.5" />} Queue merge
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
