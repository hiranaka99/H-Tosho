import * as React from 'react';
import { Link } from 'react-router';
import { Loader2, RotateCcw, Combine } from 'lucide-react';
import { type DoujinSearchResult } from '../../lib/api';
import { Button, Input } from '../../components/ui';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/dialog';
import { chapterErrors } from '../../lib/chapterNumbers';
import { mergeSeriesNameError } from '../../lib/mergeNames';
export { folderNameFrom } from '../../lib/mergeNames';

import { DOWNLOADER_SETTINGS_URL, type DownloadSetup } from './state';
import { DownloadDestination } from './DownloadSetup';
import { useMergeProtectionReview } from '../../components/MergeProtectionReview';

/**
 * Confirm dialog for queued merged downloads: all selected galleries land in one
 * shared folder (one Kavita series). Chapter numbers are prefilled with the
 * selection order but editable by hand; an empty field skips numbering that file.
 */
export interface MergeDownloadResult {
  queuedKeys: string[];
  skippedKeys: string[];
  failures: { key: string; message: string }[];
}

export function MergeDownloadDialog({ items, defaultFolder, onClose, onConfirm, setup, pending, result }: {
  items: DoujinSearchResult[];
  defaultFolder: string;
  onClose: () => void;
  onConfirm: (folder: string, numbers: (number | null)[]) => void;
  setup: DownloadSetup;
  pending: boolean;
  result: MergeDownloadResult | null;
}) {
  const [folder, setFolder] = React.useState(defaultFolder);
  // Per-gallery chapter numbers as editable strings, prefilled with selection order.
  const [numbers, setNumbers] = React.useState<string[]>(() => items.map((_, i) => String(i + 1)));
  // Per-item status lookups as sets/maps, so each row is O(1) instead of scanning the result lists.
  const { settled, queued, skipped, failuresByKey } = React.useMemo(() => {
    const failures = new Map<string, MergeDownloadResult['failures']>();
    for (const failure of result?.failures ?? []) failures.set(failure.key, [...(failures.get(failure.key) ?? []), failure]);
    return {
      settled: new Set([...(result?.queuedKeys ?? []), ...(result?.skippedKeys ?? [])]),
      queued: new Set(result?.queuedKeys ?? []),
      skipped: new Set(result?.skippedKeys ?? []),
      failuresByKey: failures,
    };
  }, [result]);
  const setNumber = (i: number, v: string) => {
    setNumbers((prev) => prev.map((n, j) => (j === i ? v : n)));
  };
  const numberErrors = React.useMemo(() => chapterErrors(numbers.map((value, index) => ({ key: String(index), value, changed: true }))), [numbers]);
  const folderError = /[\\/]/.test(folder) ? 'Use a series name without slashes.' : mergeSeriesNameError(folder);
  const directory = setup.directory;
  const targetDir = setup.status === 'ready' && directory ? `${directory}${directory.includes('\\') ? '\\' : '/'}${folder.trim()}` : undefined;
  const protection = useMergeProtectionReview({targetDir,seriesName:folder.trim()},setup.status === 'ready' && !!targetDir && !folderError,JSON.stringify(numbers));
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg" onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
        <div className="flex max-h-[calc(100vh-9rem)] flex-col gap-3 overflow-y-auto p-5 pr-12">
          <div>
            <DialogTitle>Merged download</DialogTitle>
            <DialogDescription>Name the new series and review chapter numbers before downloading.</DialogDescription>
          </div>
          <DownloadDestination setup={setup} />
          {result && result.failures.length > 0 && <div role="alert" className="space-y-1 text-sm">
            <p className="font-medium">{result.queuedKeys.length} queued{result.skippedKeys.length > 0 ? ` · ${result.skippedKeys.length} already owned or queued` : ''} · {result.failures.length} {result.failures.length === 1 ? 'needs' : 'need'} retry</p>
          </div>}
          {setup.status === 'ready' && setup.format !== 'cbz' && <p className="text-sm text-danger">Merged downloads need CBZ format. <Link className="underline underline-offset-4" to={DOWNLOADER_SETTINGS_URL}>Change the output format</Link> first.</p>}
          <div className="flex flex-col gap-1">
            <span id="merge-folder-label" className="text-xs font-medium text-muted">Merged series name</span>
            <Input id="merge-folder" aria-labelledby="merge-folder-label" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Series name" disabled={pending || settled.size > 0} aria-invalid={!!folderError} aria-describedby={`merge-name-help${folderError ? ' merge-folder-error' : ''}`} autoFocus />
            <p id="merge-name-help" className="text-xs text-muted">Used for every chapter in Kavita and for the shared download folder.</p>
            {folderError && <p id="merge-folder-error" className="text-xs text-danger">{folderError}</p>}
          </div>
          <hr className="border-border" />
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
            {items.map((item, i) => (
              <div key={`${item.source}:${item.galleryId}`} className="flex shrink-0 items-center gap-2 rounded-md border border-border-2 bg-surface-2 px-2 py-1.5">
                <div className="min-w-0 flex-1 text-xs">
                  <p className="break-words">{item.title}</p>
                  {queued.has(`${item.source}:${item.galleryId}`) && <p className="text-success">Queued</p>}
                  {skipped.has(`${item.source}:${item.galleryId}`) && <p className="text-muted">Already owned or queued</p>}
                  {failuresByKey.get(`${item.source}:${item.galleryId}`)?.map(failure => <p key={failure.key} className="mt-1 text-danger">{failure.message}</p>)}
                  {numberErrors[String(i)] && <p id={`merge-number-error-${i}`} className="mt-1 text-danger">{numberErrors[String(i)]}</p>}
                </div>
                <Input
                  inputMode="decimal"
                  aria-label={`Chapter number for ${item.title}`}
                  value={numbers[i]}
                  aria-invalid={!!numberErrors[String(i)]}
                  aria-describedby={numberErrors[String(i)] ? `merge-number-error-${i}` : undefined}
                  disabled={pending || settled.has(`${item.source}:${item.galleryId}`)}
                  onChange={(e) => setNumber(i, e.target.value)}
                  className="h-7 w-20 px-2 text-right text-base sm:text-base lg:text-xs pointer-coarse:text-base"
                />
              </div>
            ))}
          </div>
          {protection.review}
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending || !protection.ready || !folder.trim() || !!folderError || Object.keys(numberErrors).length > 0 || setup.status !== 'ready' || setup.format !== 'cbz'} onClick={() => { void protection.ensureCurrent().then(()=>onConfirm(folder.trim(), numbers.map((n) => (n.trim() === '' ? null : Number(n))))).catch(()=>{}); }}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : result?.failures.length ? <RotateCcw className="h-4 w-4" /> : <Combine className="h-4 w-4" />} {pending ? 'Queuing…' : result?.failures.length ? `Retry remaining (${result.failures.length})` : `Download ${items.length} ${items.length === 1 ? 'gallery' : 'galleries'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

