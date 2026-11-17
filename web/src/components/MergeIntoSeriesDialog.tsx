import { useDuplicateReview } from './DuplicateReview';
import * as React from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageOff, Merge, RotateCcw, Search } from 'lucide-react';
import { Link } from 'react-router';
import { api, ApiError, type DuplicateCheck, type DoujinSearchResult, type DoujinSource } from '../lib/api';
import { chapterErrors, chapterNumber } from '../lib/chapterNumbers';
import { useDownloads } from '../lib/DownloadsContext';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, Spinner, Switch } from './ui';
import { toast } from '../lib/toast';
import { useMergeProtectionReview } from './MergeProtectionReview';

interface TargetOption {
  id: number;
  name: string;
  library: string;
  artists: string[];
  cover: string | null;
}

interface MergeIntoSeriesDialogProps {
  /** Selected galleries in click order. */
  items: DoujinSearchResult[];
  onClose: () => void;
  /** Remove only galleries included in the queued merge from the shortlist. */
  onQueued: (keys: string[]) => void;
  setup: { status: 'loading' | 'error' | 'missing' | 'ready'; directory?: string; onRetry: () => void };
}

interface MergeSubmission {
  seriesId: number;
  sourceFiles: string[];
  chapters: Record<string, string>;
  existingChapters: Record<string, string>;
  downloads: { source: DoujinSource; galleryId: string; title: string; chapter: string; allowDuplicate?: boolean }[];
  keys: string[];
  targetName: string;
  seriesName?: string;
}

const galleryKey = (item: DoujinSearchResult) => `${item.source}:${item.galleryId}`;
const filename = (file: string) => file.split(/[\\/]/).pop() ?? file;
const normalizeArtist = (name: string) => name.normalize('NFKC').replace(/_/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();

function TargetCover({ option, className = '' }: { option: TargetOption; className?: string }) {
  return <div className={`relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-md bg-surface-2 ${className}`}>
    <span className="flex flex-col items-center gap-1 text-xs text-muted" aria-hidden="true"><ImageOff className="h-5 w-5" /> No cover</span>
    {option.cover && <img key={option.cover} src={option.cover} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} className="absolute inset-0 h-full w-full object-cover" />}
  </div>;
}

/** All chapter edits are drafts. One merge job commits incoming and existing changes. */
export function MergeIntoSeriesDialog({ items, onClose, onQueued, setup }: MergeIntoSeriesDialogProps) {
  const qc = useQueryClient();
  const { tasks } = useDownloads();
  const id = React.useId();
  const [filter, setFilter] = React.useState('');
  const [targetId, setTargetId] = React.useState<number | null>(null);
  const [rename, setRename] = React.useState(false);
  const [seriesName, setSeriesName] = React.useState('');
  // Only user edits are stored. Generated values are derived after target inspection.
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const submitting = React.useRef(false);

  const galleryTasks = items.map(item => tasks.find(task => task.source === item.source && task.galleryId === item.galleryId && ['queued', 'downloading', 'paused'].includes(task.status))
    ?? tasks.find(task => task.source === item.source && task.galleryId === item.galleryId && task.status === 'completed')
    ?? tasks.find(task => task.source === item.source && task.galleryId === item.galleryId));
  // Query observers survive StrictMode effect replay and support per-gallery retries.
  const fileQueries = useQueries({
    queries: items.map((item, index) => ({
      queryKey: ['gallery-files', item.source, item.galleryId, item.title, galleryTasks[index]?.status === 'completed' ? galleryTasks[index]?.outputPath : null],
      queryFn: () => api.galleryFiles(item.source, item.galleryId, item.title),
      enabled: !['queued', 'downloading', 'paused'].includes(galleryTasks[index]?.status ?? ''),
      retry: false,
      staleTime: Infinity,
    })),
  });

  const entries = items.map((item, index) => {
    const key = galleryKey(item);
    const task = galleryTasks[index];
    const query = fileQueries[index];
    const downloading = task?.status === 'queued' || task?.status === 'downloading' || task?.status === 'paused';
    const files = !downloading && query.isSuccess && !query.isFetching ? query.data.files : [];
    const resolving = !downloading && query.isFetching;
    const folder = task?.status === 'completed' && task.outputPath && !task.outputPath.toLowerCase().endsWith('.cbz');
    const lookupError = !downloading && query.isError;
    let note = files.length ? `Downloaded${files.length > 1 ? ` · ${files.length} archives` : ''}` : 'To download';
    if (downloading) note = task?.status === 'paused' ? 'Paused · resume in Downloads' : 'Downloading · merge will wait';
    else if (resolving) note = 'Checking files…';
    else if (lookupError) note = 'File lookup failed.';
    else if (!files.length && folder) note = 'Folder found · CBZ download needed';
    else if (!files.length && task?.status === 'completed') note = 'Missing CBZ · will download';
    return { item, key, chapterKey: `gallery:${key}`, files, note, downloading, resolving, lookupError, task, query };
  });

  const options = useQuery({
    queryKey: ['merge-into-series-options', 'artist-covers'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const libraries = await api.libraries();
      const results = await Promise.all(libraries.map(async library => {
        try {
          const rows = await api.librarySeries(library.id);
          return { options: rows.map(row => ({ id: row.id, name: row.name, library: library.name, artists: row.artists ?? [], cover: row.cover ?? null } satisfies TargetOption)), failed: null };
        } catch {
          return { options: [] as TargetOption[], failed: library.name };
        }
      }));
      return {
        options: results.flatMap(result => result.options).sort((a, b) => a.name.localeCompare(b.name)),
        failedLibraries: results.flatMap(result => result.failed ? [result.failed] : []),
      };
    },
  });
  const target = options.data?.options.find(option => option.id === targetId);
  const nameError = rename && !seriesName.trim() ? 'Enter a series name, or turn off Rename series.'
    : rename && /[\u0000-\u001f\u007f]/.test(seriesName) ? 'Use a series name without control characters.' : null;
  const renamed = rename && !!seriesName.trim() && seriesName.trim() !== target?.name;
  const targetFiles = useQuery({
    queryKey: ['cbz-series-files', targetId],
    queryFn: () => api.cbzSeriesFiles(targetId!),
    enabled: targetId !== null,
    retry: false,
  });
  const targetReady = !!target && targetFiles.isSuccess && !targetFiles.isFetching && !!targetFiles.data?.dir && !targetFiles.data.reason;
  const existingFiles = targetFiles.data?.files ?? [];
  const sourceFiles = [...new Set(entries.flatMap(entry => entry.files))];
  const downloadEntries = entries.filter(entry => !entry.files.length);
  const incomingKeys = [...new Set(entries.flatMap(entry => entry.files.length ? entry.files : [entry.chapterKey]))];
  const galleryDrafts = new Map(entries.filter(entry => entry.files.length === 1).map(entry => [entry.files[0], entry.chapterKey]));
  const draftValue = (key: string) => drafts[key] ?? drafts[galleryDrafts.get(key) ?? ''];
  const existingValue = (file: string) => drafts[file] ?? targetFiles.data?.chapterNumbers[file] ?? '';
  const editedExisting = existingFiles.filter(file => drafts[file] !== undefined && drafts[file].trim() !== (targetFiles.data?.chapterNumbers[file] ?? '').trim());

  // Generated defaults may adapt to staged edits; typed values (including blanks) never change.
  const defaults: Record<string, string> = {};
  if (targetReady) {
    const taken = [...existingFiles.map(existingValue), ...incomingKeys.map(draftValue)].filter((value): value is string => value !== undefined).map(chapterNumber).filter((number): number is number => number !== null);
    let next = Math.floor(Math.max(0, ...taken));
    for (const file of incomingKeys) {
      if (existingFiles.includes(file)) defaults[file] = existingValue(file);
      else if (draftValue(file) === undefined) defaults[file] = String(++next);
    }
  }
  const incomingValue = (file: string) => draftValue(file) ?? defaults[file] ?? '';
  const errors = chapterErrors([
    ...existingFiles.filter(file => !sourceFiles.includes(file)).map(file => ({ key: file, value: existingValue(file), changed: editedExisting.includes(file) })),
    ...incomingKeys.map(file => ({ key: file, value: incomingValue(file), changed: true })),
  ]);
  const hasErrors = Object.keys(errors).length > 0;
  const resolving = entries.some(entry => entry.resolving);
  const downloadReady = !downloadEntries.length || (setup.status === 'ready' && !!setup.directory);
  const canQueue = targetReady && items.length > 0 && !resolving && !entries.some(entry => entry.lookupError) && downloadReady && !hasErrors && !nameError;
  const protection = useMergeProtectionReview({seriesId:targetId ?? undefined,sourceFiles,...(rename && seriesName.trim() ? {seriesName:seriesName.trim()} : {})},canQueue,JSON.stringify(drafts));

  const { checkDuplicates, reviewCheck, dialog: duplicateDialog } = useDuplicateReview();
  const save = useMutation({
    mutationFn: async (submission: MergeSubmission) => {
      const approved = await checkDuplicates(submission.downloads);
      if (approved === null) return null;
      const enqueue = async (keys: Set<string>) => {
        await protection.ensureCurrent();
        return api.enqueue('merge-series', {
        seriesId: submission.seriesId,
        sourceFiles: submission.sourceFiles,
        chapters: submission.chapters,
        existingChapters: submission.existingChapters,
        ...(submission.seriesName ? { seriesName: submission.seriesName } : {}),
        downloads: submission.downloads.map(plan => ({ ...plan, allowDuplicate: keys.has(`${plan.source}:${plan.galleryId}`) })),
      });
      };
      try { return await enqueue(approved); }
      catch (error) {
        if (!(error instanceof ApiError) || error.message !== 'possible-duplicate') throw error;
        const approval = await reviewCheck(error.details as unknown as DuplicateCheck);
        if (approval === null) return null;
        return enqueue(new Set([...approved, ...approval]));
      }
    },
    onSuccess: (_result, submission) => {
      if (_result === null) return;
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({
        tone: 'success',
        title: 'Merge queued',
        description: `${submission.keys.length} ${submission.keys.length === 1 ? 'gallery' : 'galleries'} → ${submission.targetName}${submission.downloads.length ? ` · ${submission.downloads.length} downloads included` : ''}`,
      });
      onQueued(submission.keys);
      onClose();
    },
    onSettled: () => { submitting.current = false; },
  });

  const submit = () => {
    if (!canQueue || submitting.current || targetId === null || !target) return;
    submitting.current = true;
    save.mutate({
      seriesId: targetId,
      sourceFiles,
      chapters: Object.fromEntries(sourceFiles.filter(file => incomingValue(file).trim()).map(file => [file, incomingValue(file).trim()])),
      existingChapters: Object.fromEntries(editedExisting.filter(file => !sourceFiles.includes(file)).map(file => [file, existingValue(file).trim()])),
      downloads: downloadEntries.map(entry => ({ source: entry.item.source, galleryId: entry.item.galleryId, title: entry.item.title, chapter: incomingValue(entry.chapterKey).trim() })),
      keys: entries.map(entry => entry.key),
      targetName: renamed ? seriesName.trim() : target.name,
      seriesName: renamed ? seriesName.trim() : undefined,
    });
  };

  const setChapter = (file: string, value: string) => setDrafts(current => ({ ...current, [file]: value }));
  const selectedArtists = [...new Map(items.flatMap(item => item.artists ?? []).filter(artist => normalizeArtist(artist)).map(artist => [normalizeArtist(artist), artist.trim()])).values()];
  const artistNames = new Set(selectedArtists.map(normalizeArtist));
  const search = normalizeArtist(filter);
  const visible = (options.data?.options ?? []).filter(option => search
    ? normalizeArtist(`${option.name} ${option.library} ${option.artists.join(' ')}`).includes(search)
    : !artistNames.size || option.artists.some(artist => artistNames.has(normalizeArtist(artist))));
  const busy = save.isPending;
  const dismiss = () => { if (!submitting.current) onClose(); };

  return (
    <>
    <Dialog open onOpenChange={open => { if (!open) dismiss(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start gap-2 pr-10">
            <Merge className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <DialogTitle>Merge into series</DialogTitle>
              <DialogDescription>Choose a series, optionally rename it, and review chapter numbers before queueing.</DialogDescription>
            </div>
          </div>

          <section className="flex min-w-0 flex-col gap-2">
            <Label htmlFor={`${id}-target`}>Target series</Label>
            {options.isPending ? <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading Kavita series…</p>
              : options.isError ? <div role="alert" className="space-y-2 text-sm"><p className="text-danger">Could not load Kavita series. Check the connection and retry.</p><Button size="sm" variant="outline" disabled={options.isFetching || busy} onClick={() => void options.refetch()}><RotateCcw className="h-3.5 w-3.5" /> Retry series list</Button></div>
              : <>
                {!!options.data?.failedLibraries.length && <div role="alert" className="space-y-2 text-xs"><p className="break-words text-danger">Could not load series from {options.data.failedLibraries.join(', ')}. Other libraries are available.</p><Button size="sm" variant="outline" disabled={options.isFetching || busy} onClick={() => void options.refetch()}>Retry missing libraries</Button></div>}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <Input id={`${id}-target`} value={filter} disabled={busy} onChange={event => setFilter(event.target.value)} placeholder="Search by series, artist or library…" aria-describedby={`${id}-target-help`} className="pl-7" />
                </div>
                <p id={`${id}-target-help`} className="break-words text-xs text-muted">{search ? 'All series' : selectedArtists.length ? `By ${selectedArtists.join(', ')}` : 'All series · no artist listed'}</p>
                {!visible.length && <p role="status" className="py-2 text-sm text-muted">{search ? 'No matches. Try another search.' : selectedArtists.length ? 'No series by this artist. Search for another target.' : 'No series available. Check your Kavita libraries.'}</p>}
                <div className="grid max-h-[min(26rem,45dvh)] min-w-0 grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-4" aria-label="Choose a merge target">
                  {visible.map(option => <button
                    key={option.id}
                    type="button"
                    disabled={busy}
                    onClick={() => { if (targetId !== option.id) { setTargetId(option.id); setRename(false); setSeriesName(option.name); setDrafts({}); save.reset(); } }}
                    aria-pressed={targetId === option.id}
                    aria-label={`Select ${option.name} as merge target`}
                    className={`flex min-w-0 flex-col gap-2 rounded-lg border p-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${targetId === option.id ? 'border-primary bg-primary/10' : 'border-border hover:border-border-2 hover:bg-surface-2'}`}
                  >
                    <div className="relative w-full">
                      <TargetCover option={option} />
                      {targetId === option.id && <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 rounded-b-md bg-primary-button px-1 py-1.5 font-medium text-white"><Check className="h-3.5 w-3.5" aria-hidden="true" /> Selected</span>}
                    </div>
                    <span className="w-full break-words font-medium">{option.name}</span>
                    {!!option.artists.length && <span className="w-full break-words text-muted">{option.artists.join(', ')}</span>}
                    <span className="w-full break-words text-muted">{option.library}</span>
                  </button>)}
                </div>
              </>}
          </section>

          {target && <section className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center gap-3">
              <TargetCover option={target} className="w-12 shrink-0" />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-sm font-semibold">{target.name}</h3>
                <p className="break-words text-xs text-muted">{target.library}</p>
              </div>
            </div>
            <div className="space-y-3 py-2">
              <div className="flex min-h-11 items-center justify-between gap-3">
                <Label htmlFor={`${id}-rename`} className="cursor-pointer text-sm text-foreground">Rename series</Label>
                <Switch id={`${id}-rename`} checked={rename} onCheckedChange={setRename} disabled={busy} aria-label="Rename series" aria-controls={`${id}-name-fields`} />
              </div>
              {rename && <div id={`${id}-name-fields`} className="space-y-2">
                <Label htmlFor={`${id}-name`}>New series name</Label>
                <Input id={`${id}-name`} value={seriesName} onChange={event => setSeriesName(event.target.value)} disabled={busy} aria-invalid={!!nameError} aria-describedby={`${id}-name-help${nameError ? ` ${id}-name-error` : ''}`} />
                <p id={`${id}-name-help`} className="text-xs text-muted">Applies to existing and incoming chapters in Kavita when the merge runs. The folder name stays the same.</p>
                {nameError && <p id={`${id}-name-error`} role="alert" className="text-xs text-danger">{nameError}</p>}
              </div>}
            </div>
            <h3 className="text-sm font-semibold">Existing chapters</h3>
            {targetFiles.isFetching ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Inspecting target archives…</p>
              : targetFiles.isError || !targetFiles.data?.dir || targetFiles.data.reason ? <div role="alert" className="space-y-2 text-sm">
                <p className="text-danger">{targetFiles.isError ? 'Could not inspect the target series. Retry before merging.' : 'Could not locate the target series folder. Check library folder mappings in Downloader settings, then retry.'}</p>
                <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void targetFiles.refetch()}><RotateCcw className="h-3.5 w-3.5" /> Retry target inspection</Button><Button asChild size="sm" variant="ghost"><Link to="/settings?tab=downloader">Downloader settings</Link></Button></div>
              </div>
              : <>
                <p id={`${id}-existing-help`} className="text-xs text-muted">Blank clears the number.</p>
                {editedExisting.length > 0 && <p className="text-xs text-warning">{editedExisting.length} staged chapter {editedExisting.length === 1 ? 'edit' : 'edits'}</p>}
                {!existingFiles.length ? <p className="text-xs text-muted">No archives in this series yet.</p> : <div className="max-h-48 overflow-y-auto pr-1">
                  {existingFiles.map((file, index) => <div key={file} className="border-b border-border py-2 last:border-b-0">
                    <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2">
                      <span className="min-w-0 break-words text-xs">{filename(file)}</span>
                      <Input value={existingValue(file)} onChange={event => setChapter(file, event.target.value)} placeholder="—" inputMode="decimal" disabled={busy || !targetReady} className="w-full px-2 text-base sm:text-base lg:text-xs pointer-coarse:text-base" aria-label={`Chapter number for ${filename(file)}`} aria-invalid={!!errors[file]} aria-describedby={errors[file] ? `${id}-existing-error-${index}` : `${id}-existing-help`} />
                    </div>
                    {errors[file] && <p id={`${id}-existing-error-${index}`} className="mt-1 text-xs text-danger">{errors[file]}</p>}
                  </div>)}
                </div>}
              </>}
          </section>}

          <section className="min-w-0 space-y-2 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Selected galleries</h3>
              <span className="text-xs text-muted">{items.length} {items.length === 1 ? 'gallery' : 'galleries'} · {downloadEntries.length} to download</span>
            </div>
            <p id={`${id}-chapter-help`} className="sr-only">Positive numbers or decimals. Blank keeps the archive’s number.</p>
            <div className="max-h-[min(24rem,45dvh)] overflow-y-auto pr-1">
              {entries.map((entry, index) => <div key={entry.key} className="min-w-0 space-y-2 border-b border-border py-3 last:border-b-0">
                <p className="break-words text-xs font-medium">{entry.item.title}</p>
                <p role={entry.downloading || entry.resolving ? 'status' : undefined} className={`flex items-start gap-2 text-xs ${entry.lookupError ? 'text-danger' : entry.files.length ? 'text-success' : 'text-muted'}`}>
                  {(entry.resolving || entry.downloading) && <Spinner className="h-3.5 w-3.5 shrink-0" />}{entry.note}
                </p>
                {(entry.files.length ? entry.files : [entry.chapterKey]).map((file, fileIndex) => <div key={file}>
                  <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2">
                    <span className="min-w-0 break-words text-xs text-muted">{entry.files.length ? filename(file) : 'Chapter number'}</span>
                    <Input value={incomingValue(file)} onChange={event => setChapter(file, event.target.value)} placeholder={targetReady ? '—' : 'Ch #'} inputMode="decimal" disabled={busy || !targetReady || entry.resolving} className="w-full px-2 text-base sm:text-base lg:text-xs pointer-coarse:text-base" aria-label={`Chapter number for ${entry.files.length <= 1 ? entry.item.title : `${filename(file)} in ${entry.item.title}`}`} aria-invalid={!!errors[file]} aria-describedby={errors[file] ? `${id}-gallery-error-${index}-${fileIndex}` : `${id}-chapter-help`} />
                  </div>
                  {errors[file] && <p id={`${id}-gallery-error-${index}-${fileIndex}`} className="mt-1 text-xs text-danger">{errors[file]}</p>}
                </div>)}
                {entry.lookupError && <Button size="sm" variant="outline" disabled={busy || entry.query.isFetching} onClick={() => void entry.query.refetch()}><RotateCcw className="h-3.5 w-3.5" /> Retry lookup</Button>}
                {entry.downloading && <Link to="/downloader?tab=downloads" className="inline-block text-xs text-primary underline underline-offset-4">View download progress</Link>}
              </div>)}
            </div>
          </section>
          {protection.review}
        </div>

        <div className="shrink-0 space-y-3 border-t border-border p-4">
          {renamed && !nameError && <p className="break-words text-xs text-muted">Rename on merge: <span className="text-foreground">{target?.name}</span> → <span className="font-medium text-foreground">{seriesName.trim()}</span></p>}
          {save.isError && <p role="alert" className="text-sm text-danger">Could not queue the merge. Drafts kept; try again.</p>}
          {hasErrors && <p role="alert" className="text-xs text-danger">Fix the chapter numbers above.</p>}
          {!downloadReady && <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {setup.status === 'loading' ? <><Spinner /> Checking download settings…</> : setup.status === 'error' ? <><span>Could not check download settings.</span><Button size="sm" variant="outline" onClick={setup.onRetry}>Retry settings</Button></> : <><span>Set an output folder before queueing downloads.</span><Link to="/settings?tab=downloader" className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">Downloader settings</Link></>}
          </div>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={dismiss}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!canQueue || !protection.ready || busy}>
              {busy ? <Spinner /> : <Merge className="h-3.5 w-3.5" />} {busy ? 'Queuing…' : `Queue merge (${items.length} ${items.length === 1 ? 'gallery' : 'galleries'})`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {duplicateDialog}
    </>
  );
}
