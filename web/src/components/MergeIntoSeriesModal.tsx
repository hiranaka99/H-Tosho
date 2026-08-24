import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Combine, Search } from 'lucide-react';
import { api, type DownloadTask } from '../lib/api';
import { Button, Dialog, DialogContent, Input, Label, Spinner, EmptyState } from './ui';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';

interface MergeIntoSeriesModalProps {
  /** Completed download tasks (cbz) whose files will move into the target series. */
  tasks: DownloadTask[];
  onClose: () => void;
}

/** A Kavita series with its library name, for the target picker. */
interface SeriesOption {
  id: number;
  name: string;
  libraryName: string;
}

/**
 * Merge completed downloads into an existing Kavita series ("library item").
 * The files move into the series' folder and get stamped with its series name +
 * chapter numbers, so a rescan folds them in as new chapters of that series.
 */
export function MergeIntoSeriesModal({ tasks, onClose }: MergeIntoSeriesModalProps) {
  const qc = useQueryClient();
  const [filter, setFilter] = React.useState('');
  const [targetId, setTargetId] = React.useState<number | null>(null);
  const [chapters, setChapters] = React.useState<Record<string, string>>({});

  // Only cbz outputs can be merged (the merge job moves .cbz archives).
  const files = tasks.filter((t) => t.outputPath && (t.outputFormat ?? 'cbz') === 'cbz');

  // Every series across all libraries, for the target picker.
  const options = useQuery({
    queryKey: ['merge-into-series-options'],
    queryFn: async (): Promise<SeriesOption[]> => {
      const libs = await api.libraries();
      const results = await Promise.all(
        libs.map(async (lib) => {
          try {
            const rows = await api.librarySeries(lib.id);
            return rows.map((s): SeriesOption => ({ id: s.id, name: s.name, libraryName: lib.name }));
          } catch {
            return []; // one unreachable library must not block the picker
          }
        }),
      );
      return results.flat().sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  // Prefill chapter numbers from the archives' existing ComicInfo.Number.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        files.map(async (t) => {
          try {
            const data = await api.cbzComicInfo(t.outputPath!);
            const n = data.fields?.Number;
            if (n && n.trim()) next[t.outputPath!] = n.trim();
          } catch {
            /* unreadable archive — leave the prefill empty */
          }
        }),
      );
      if (!cancelled) setChapters((prev) => ({ ...next, ...prev }));
    })();
    return () => {
      cancelled = true;
    };
    // The modal remounts for every selection — run the prefill once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = filter.trim().toLowerCase();
  const visible = (options.data ?? []).filter((o) => !q || o.name.toLowerCase().includes(q));
  const target = (options.data ?? []).find((o) => o.id === targetId) ?? null;

  const setChapter = (path: string, value: string) => setChapters((prev) => ({ ...prev, [path]: value }));

  const canSave = !!targetId && files.length > 0 && !options.isLoading;

  const save = useMutation({
    mutationFn: () => {
      if (!targetId) throw new Error('Pick a target series');
      const chapterMap: Record<string, string> = {};
      for (const t of files) {
        const n = chapters[t.outputPath!];
        if (n && n.trim()) chapterMap[t.outputPath!] = n.trim();
      }
      return api.enqueue('merge-series', {
        sourceFiles: files.map((t) => t.outputPath!),
        seriesId: targetId,
        chapters: chapterMap,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'success', title: 'Merge queued', description: `${files.length} file(s) → ${target?.name ?? `series ${targetId}`}` });
      onClose();
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue merge', description: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2 pr-6">
            <Combine className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Merge into series</h2>
          </div>

          {/* Target picker */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-border-2 bg-surface-2 p-3">
            <Label htmlFor="merge-into-target">Target library item</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
              <Input
                id="merge-into-target"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search series…"
                className="pl-8"
              />
            </div>
            {options.isLoading ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted">
                <Spinner /> Loading series…
              </div>
            ) : visible.length === 0 ? (
              <p className="py-2 text-xs text-muted">No series match “{filter}”.</p>
            ) : (
              <div className="max-h-44 overflow-y-auto rounded-md border border-border-2 bg-surface">
                {visible.slice(0, 200).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setTargetId(o.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2',
                      o.id === targetId && 'bg-primary/10 text-primary',
                    )}
                  >
                    <span className="min-w-0 truncate">{o.name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{o.libraryName}</span>
                  </button>
                ))}
              </div>
            )}
            {target && (
              <p className="text-[11px] text-muted">
                Files move into <span className="font-medium text-foreground">{target.name}</span> ({target.libraryName}) and are stamped with its series name.
              </p>
            )}
          </div>

          {/* Files + chapter numbers */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Files to merge</span>
              <span className="text-xs text-muted">{files.length} file{files.length === 1 ? '' : 's'}</span>
            </div>
            {files.length === 0 ? (
              <EmptyState icon={<Combine className="h-6 w-6" />} title="No mergeable files" description="Only completed .cbz downloads can be merged." />
            ) : (
              <div className="flex flex-col gap-1.5">
                {files.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 rounded-md border border-border-2 bg-surface px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs" title={t.outputPath ?? ''}>
                      {(t.outputPath ?? '').split(/[\\/]/).pop()}
                    </span>
                    <Label htmlFor={`ch-${t.id}`} className="shrink-0 text-[10px] uppercase tracking-wide text-muted">Ch.</Label>
                    <Input
                      id={`ch-${t.id}`}
                      value={chapters[t.outputPath ?? ''] ?? ''}
                      onChange={(e) => setChapter(t.outputPath!, e.target.value)}
                      placeholder="—"
                      className="h-7 w-16 shrink-0 text-center text-xs"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border-2 pt-3">
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
              Empty source folders are removed and Kavita is rescanned, so the files appear as new chapters of the target series.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
                {save.isPending ? <Spinner /> : <Combine className="h-3.5 w-3.5" />} Queue merge
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
