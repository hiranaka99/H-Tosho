import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download as DownloadIcon, Merge, Search } from 'lucide-react';
import { api, type DoujinSearchResult } from '../lib/api';
import { useDownloads } from '../lib/DownloadsContext';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, Spinner, EmptyState } from './ui';
import { toast } from '../lib/toast';

interface TargetOption {
  id: number;
  name: string;
  library: string;
}

/** A selected gallery plus the .cbz files ready to merge (empty when not downloadable). */
interface Entry {
  item: DoujinSearchResult;
  files: string[];
  note: string | null;
  /** File lookup still in flight (history-cleared galleries are resolved server-side). */
  resolving: boolean;
}

interface MergeIntoSeriesDialogProps {
  /** Selected galleries in click order. */
  items: DoujinSearchResult[];
  onClose: () => void;
  /** Called after the merge job is queued (the page clears its selection). */
  onQueued: () => void;
  /** Queue a plain single-gallery download for an entry that has no file yet. */
  onDownload: (item: DoujinSearchResult) => void;
}

/**
 * Move already-downloaded galleries into an existing Kavita series: the archives
 * are moved into the target series' folder, stamped with its ComicInfo.Series
 * value and chapter numbers, and the emptied source series is removed from Kavita
 * (server `merge-series` job with a seriesId target). Chapter numbers can be set
 * per gallery before its download completes, and archives already in the target
 * series are renumbered in place via `edit-comicinfo` jobs.
 */
export function MergeIntoSeriesDialog({ items, onClose, onQueued, onDownload }: MergeIntoSeriesDialogProps) {
  const qc = useQueryClient();
  const { tasks } = useDownloads();
  const [filter, setFilter] = React.useState('');
  const [targetId, setTargetId] = React.useState<number | null>(null);
  // Chapter numbers keyed by source path; prefilled from the target's existing
  // numeric chapters (max + 1…) and always editable. Never overwritten once set,
  // so typed values survive downloads resolving and series refetches.
  const [chapters, setChapters] = React.useState<Record<string, string>>({});
  // Chapter numbers preset per gallery for entries whose file is not downloaded yet.
  const [galleryChapters, setGalleryChapters] = React.useState<Record<string, string>>({});
  // Editable chapter state for archives already in the target series: `value` is
  // what the user sees, `orig` the last saved baseline (dirty when they differ).
  const [existing, setExisting] = React.useState<Record<string, { value: string; orig: string }>>({});
  // Server-resolved files for galleries whose download history row is gone.
  const [remoteFiles, setRemoteFiles] = React.useState<Record<string, string[]> | null>(null);

  /** Completed-task .cbz path when available; null means "ask the server". */
  const taskPath = (item: DoujinSearchResult): string | null => {
    const t = tasks.find((x) => x.source === item.source && x.galleryId === item.galleryId && x.status === 'completed');
    return t?.outputPath?.toLowerCase().endsWith('.cbz') ? t.outputPath : null;
  };

  React.useEffect(() => {
    const missing = items.filter((item) => taskPath(item) === null);
    if (missing.length === 0) {
      setRemoteFiles({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      missing.map(async (item) => [`${item.source}:${item.galleryId}`, await api.galleryFiles(item.source, item.galleryId, item.title).catch(() => ({ files: [] }))]),
    ).then((pairs) => {
      if (!cancelled) setRemoteFiles(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tasks]);

  const entries: Entry[] = items.map((item) => {
    const key = `${item.source}:${item.galleryId}`;
    const direct = taskPath(item);
    if (direct) return { item, files: [direct], note: null, resolving: false };
    if (remoteFiles === null) return { item, files: [], note: 'Resolving files…', resolving: true };
    const files = remoteFiles[key] ?? [];
    if (files.length > 0) return { item, files, note: null, resolving: false };
    const hasTask = tasks.some((t) => t.source === item.source && t.galleryId === item.galleryId && t.status === 'completed');
    return { item, files: [], note: hasTask ? 'Downloaded as an image folder — merge works on .cbz archives.' : 'Not downloaded yet.', resolving: false };
  });

  const options = useQuery({
    queryKey: ['merge-into-series-options'],
    queryFn: async (): Promise<TargetOption[]> => {
      const libs = await api.libraries();
      const perLib = await Promise.all(
        libs.map(async (lib) => {
          try {
            const rows = await api.librarySeries(lib.id);
            return rows.map((r): TargetOption => ({ id: r.id, name: r.name, library: lib.name }));
          } catch {
            return [] as TargetOption[];
          }
        }),
      );
      return perLib.flat().sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  const target = (options.data ?? []).find((o) => o.id === targetId) ?? null;

  const targetFiles = useQuery({
    queryKey: ['cbz-series-files', 'merge-into', targetId],
    queryFn: () => api.cbzSeriesFiles(targetId!),
    enabled: targetId != null,
  });

  // Seed the editable chapter state for the target's archives; local edits are
  // kept across refetches and stale paths dropped.
  React.useEffect(() => {
    if (targetId == null) return;
    const data = targetFiles.data;
    if (!data) return;
    setExisting((prev) => {
      const next: Record<string, { value: string; orig: string }> = {};
      let changed = false;
      for (const f of data.files) {
        if (prev[f]) next[f] = prev[f];
        else {
          next[f] = { value: data.chapterNumbers[f] ?? '', orig: data.chapterNumbers[f] ?? '' };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [targetId, targetFiles.data]);

  // Auto-assign chapter numbers into the gaps only: files that already carry a
  // value (typed or previously assigned) are never renumbered, and numbering
  // starts above every number in play — the target's existing chapters (including
  // unsaved edits below) plus what is already assigned here.
  const assignedTargetRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (targetId == null) return;
    const data = targetFiles.data;
    const switched = assignedTargetRef.current !== targetId;
    assignedTargetRef.current = targetId;
    setChapters((prev) => {
      const next: Record<string, string> = switched ? {} : { ...prev };
      // Apply chapter numbers preset before download to files that just resolved.
      for (const e of entries) {
        if (e.files.length === 0) continue;
        const preset = galleryChapters[`${e.item.source}:${e.item.galleryId}`]?.trim();
        for (const f of e.files) if (!next[f]?.trim() && preset) next[f] = preset;
      }
      const taken: number[] = [];
      for (const f of data?.files ?? []) {
        const v = Number(existing[f]?.value ?? data?.chapterNumbers[f]);
        if (Number.isFinite(v) && v > 0) taken.push(v);
      }
      for (const v of Object.values(next)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) taken.push(n);
      }
      let n = taken.length > 0 ? Math.max(...taken) : 0;
      for (const e of entries) {
        if (e.files.length === 0) continue;
        for (const f of e.files) {
          if (!next[f]?.trim()) {
            n += 1;
            next[f] = String(n);
          }
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, targetFiles.data, existing, galleryChapters, entries.map((e) => e.files.join(',')).join('|')]);

  const sourceFiles = entries.flatMap((e) => e.files);
  const resolving = entries.some((e) => e.resolving);
  const canQueue = targetId != null && sourceFiles.length > 0 && !resolving;

  const save = useMutation({
    mutationFn: () => {
      const numbered: Record<string, string> = {};
      for (const f of sourceFiles) {
        const v = chapters[f]?.trim();
        if (v) numbered[f] = v;
      }
      return api.enqueue('merge-series', { seriesId: targetId, sourceFiles, chapters: numbered });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'success', title: 'Merge queued', description: `${sourceFiles.length} file(s) → ${target?.name ?? `series ${targetId}`}` });
      onQueued();
      onClose();
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue merge', description: e instanceof Error ? e.message : String(e) }),
  });

  const saveExisting = useMutation({
    mutationFn: (f: string) => {
      const v = existing[f]?.value?.trim() ?? '';
      return api.enqueue('edit-comicinfo', { path: f, seriesId: targetId!, fields: { Number: v } });
    },
    onSuccess: (_res, f) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['cbz-series-files', 'merge-into', targetId] });
      setExisting((prev) => (prev[f] ? { ...prev, [f]: { ...prev[f], orig: prev[f].value } } : prev));
      toast({ tone: 'success', title: 'Chapter save queued', description: `${f.split(/[\\/]/).pop()} — check the Jobs page` });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue chapter save', description: e instanceof Error ? e.message : String(e) }),
  });

  const visible = (options.data ?? []).filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()));

  // Existing archives in reading order: numeric chapter first, then filename.
  const existingFiles = React.useMemo(() => {
    const files = targetFiles.data?.files ?? [];
    const num = (f: string): number | null => {
      const v = (existing[f]?.value ?? targetFiles.data?.chapterNumbers[f] ?? '').trim();
      const n = Number(v);
      return v !== '' && !Number.isNaN(n) ? n : null;
    };
    return [...files].sort((a, b) => {
      const na = num(a);
      const nb = num(b);
      if (na !== null && nb !== null) return na - nb || a.localeCompare(b);
      if (na !== null) return -1;
      if (nb !== null) return 1;
      return a.localeCompare(b);
    });
  }, [targetFiles.data, existing]);
  const unsavedExisting = existingFiles.filter((f) => {
    const st = existing[f];
    return !!st && st.value !== st.orig;
  }).length;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start gap-2 pr-10">
            <Merge className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <DialogTitle>Merge into series</DialogTitle>
              <DialogDescription>Move downloaded galleries into an existing Kavita series and set chapter numbers for new and existing files.</DialogDescription>
            </div>
          </div>

          {/* Target series picker */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-border-2 bg-surface-2 p-3">
            <Label htmlFor="merge-into-target">Target series</Label>
            {options.isLoading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted"><Spinner /> Loading Kavita series…</div>
            ) : options.isError ? (
              <p className="py-2 text-xs text-danger">Could not load Kavita series: {options.error instanceof Error ? options.error.message : String(options.error)}</p>
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <Input id="merge-into-target" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by series name…" className="pl-7" />
                </div>
                <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto pr-1">
                  {visible.length === 0 && <p className="py-2 text-xs text-muted">No matching series.</p>}
                  {visible.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setTargetId(o.id)}
                      aria-pressed={targetId === o.id}
                      className={`flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                        targetId === o.id ? 'border-primary/60 bg-primary/10' : 'border-transparent hover:border-border-2 hover:bg-surface'
                      }`}
                    >
                      <span className="min-w-0 truncate" title={o.name}>{o.name}</span>
                      <span className="shrink-0 text-2xs text-muted">{o.library}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Per-gallery file rows */}
          <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Galleries</span>
              <span className="text-xs text-muted">{sourceFiles.length} file{sourceFiles.length === 1 ? '' : 's'} ready</span>
            </div>
            {entries.length === 0 ? (
              <EmptyState icon={<Merge className="h-8 w-8" />} title="Nothing selected" description="Select galleries in the search results first." />
            ) : (
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                {entries.map((e) => {
                  const key = `${e.item.source}:${e.item.galleryId}`;
                  const ready = e.files.length > 0;
                  const chapterValue = ready ? (chapters[e.files[0]] ?? '') : (galleryChapters[key] ?? '');
                  const setChapter = (v: string) => {
                    if (ready) setChapters((prev) => ({ ...prev, [e.files[0]]: v }));
                    else setGalleryChapters((prev) => ({ ...prev, [key]: v }));
                  };
                  return (
                    <div key={key} className="grid grid-cols-[minmax(0,1fr)_4rem_auto] items-center gap-2 rounded-md border border-border-2 bg-surface px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_8rem_4rem_auto]">
                      <span className="min-w-0 truncate text-xs" title={e.item.title}>{e.item.title}</span>
                      {ready ? (
                        <span className="hidden truncate text-xs text-muted sm:block" title={e.files.join('\n')}>{e.files.map((f) => f.split(/[\\/]/).pop()).join(', ')}</span>
                      ) : e.resolving ? (
                        <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex"><Spinner className="h-3 w-3" /> Resolving files…</span>
                      ) : (
                        <span className="hidden truncate text-xs text-warning sm:block" title={e.note ?? ''}>{e.note}</span>
                      )}
                      <Input
                        value={chapterValue}
                        onChange={(ev) => setChapter(ev.target.value)}
                        placeholder="Ch #"
                        inputMode="decimal"
                        className="h-8 w-full px-2 text-xs"
                        aria-label={`Chapter number for ${e.item.title}`}
                      />
                      {!ready && !e.resolving ? (
                        <Button size="sm" variant="ghost" onClick={() => onDownload(e.item)}>
                          <DownloadIcon className="h-3.5 w-3.5" /> Download
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Archives already in the target series: chapter numbers editable in place */}
          {target && (
            <div className="flex flex-col gap-2 rounded-lg border border-border-2 bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted" title={`Existing in ${target.name}`}>Existing in {target.name}</span>
                <span className="shrink-0 text-xs text-muted">
                  {unsavedExisting > 0 ? <span className="text-warning">{unsavedExisting} unsaved</span> : `${existingFiles.length} file${existingFiles.length === 1 ? '' : 's'}`}
                </span>
              </div>
              {targetFiles.isLoading ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted"><Spinner /> Loading series files…</div>
              ) : targetFiles.data?.reason ? (
                <p className="py-1 text-xs text-warning">{targetFiles.data.reason}</p>
              ) : existingFiles.length === 0 ? (
                <p className="py-1 text-xs text-muted">No archives in this series yet.</p>
              ) : (
                <div className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
                  {existingFiles.map((f) => {
                    const st = existing[f];
                    const name = f.split(/[\\/]/).pop() ?? f;
                    const value = st?.value ?? targetFiles.data?.chapterNumbers[f] ?? '';
                    const orig = st?.orig ?? targetFiles.data?.chapterNumbers[f] ?? '';
                    const dirty = value !== orig;
                    return (
                      <div key={f} className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 rounded-md border border-border-2 bg-surface px-2 py-1.5">
                        <span className={`min-w-0 truncate text-xs ${dirty ? 'text-warning' : ''}`} title={f}>{name}</span>
                        <Input
                          value={value}
                          onChange={(ev) => setExisting((prev) => (prev[f] ? { ...prev, [f]: { ...prev[f], value: ev.target.value } } : prev))}
                          onBlur={() => { if (dirty) saveExisting.mutate(f); }}
                          onKeyDown={(ev) => { if (ev.key === 'Enter' && dirty) { ev.preventDefault(); saveExisting.mutate(f); } }}
                          placeholder="—"
                          inputMode="decimal"
                          className="h-8 w-full px-2 text-xs"
                          aria-label={`Chapter number for ${name}`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 text-sm text-muted">
              Files move into the target series folder and take its ComicInfo.Series name; emptied source series are removed from Kavita.
            </p>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={() => save.mutate()} disabled={!canQueue || save.isPending || options.isLoading}>
                {save.isPending ? <Spinner /> : <Merge className="h-3.5 w-3.5" />} Queue merge
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
