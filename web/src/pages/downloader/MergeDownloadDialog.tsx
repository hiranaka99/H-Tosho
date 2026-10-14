import * as React from 'react';
import { Link } from 'react-router';
import { Loader2, RotateCcw, Combine } from 'lucide-react';
import { type DoujinSearchResult } from '../../lib/api';
import { Button, Input, Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui';
import { chapterErrors } from '../../lib/chapterNumbers';

import { DOWNLOADER_SETTINGS_URL, type DownloadSetup } from './state';
import { DownloadDestination } from './DownloadSetup';
export function folderNameFrom(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

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
  const settled = new Set([...(result?.queuedKeys ?? []), ...(result?.skippedKeys ?? [])]);
  const setNumber = (i: number, v: string) => {
    setNumbers((prev) => prev.map((n, j) => (j === i ? v : n)));
  };
  const numberErrors = chapterErrors(numbers.map((value, index) => ({ key: String(index), value, changed: true })));
  const folderError = /[\\/]/.test(folder) ? 'Use a folder name without slashes.' : null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg" onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
        <div className="flex max-h-[calc(100vh-9rem)] flex-col gap-3 overflow-y-auto p-5 pr-12">
          <div>
            <DialogTitle>Merged download</DialogTitle>
            <DialogDescription className="sr-only">Download the selected galleries as one series.</DialogDescription>
          </div>
          <DownloadDestination setup={setup} />
          {result && result.failures.length > 0 && <div role="alert" className="space-y-1 text-sm">
            <p className="font-medium">{result.queuedKeys.length} queued{result.skippedKeys.length > 0 ? ` · ${result.skippedKeys.length} already owned or queued` : ''} · {result.failures.length} {result.failures.length === 1 ? 'needs' : 'need'} retry</p>
          </div>}
          {setup.status === 'ready' && setup.format !== 'cbz' && <p className="text-sm text-danger">Merged downloads need CBZ format. <Link className="underline underline-offset-4" to={DOWNLOADER_SETTINGS_URL}>Change the output format</Link> first.</p>}
          <div className="flex flex-col gap-1">
            <span id="merge-folder-label" className="text-xs font-medium text-muted">Series folder name</span>
            <Input id="merge-folder" aria-labelledby="merge-folder-label" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Series folder" disabled={pending || settled.size > 0} aria-invalid={!!folderError} aria-describedby={folderError ? "merge-folder-error" : undefined} autoFocus />
            {folderError && <p id="merge-folder-error" className="text-xs text-danger">{folderError}</p>}
          </div>
          <hr className="border-border" />
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
            {items.map((item, i) => (
              <div key={`${item.source}:${item.galleryId}`} className="flex shrink-0 items-center gap-2 rounded-md border border-border-2 bg-surface-2 px-2 py-1.5">
                <div className="min-w-0 flex-1 text-xs">
                  <p className="break-words">{item.title}</p>
                  {result?.queuedKeys.includes(`${item.source}:${item.galleryId}`) && <p className="text-success">Queued</p>}
                  {result?.skippedKeys.includes(`${item.source}:${item.galleryId}`) && <p className="text-muted">Already owned or queued</p>}
                  {result?.failures.filter(failure => failure.key === `${item.source}:${item.galleryId}`).map(failure => <p key={failure.key} className="mt-1 text-danger">{failure.message}</p>)}
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
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending || !folder.trim() || !!folderError || Object.keys(numberErrors).length > 0 || setup.status !== 'ready' || setup.format !== 'cbz'} onClick={() => onConfirm(folder.trim(), numbers.map((n) => (n.trim() === '' ? null : Number(n))))}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : result?.failures.length ? <RotateCcw className="h-4 w-4" /> : <Combine className="h-4 w-4" />} {pending ? 'Queuing…' : result?.failures.length ? `Retry remaining (${result.failures.length})` : `Download ${items.length} ${items.length === 1 ? 'gallery' : 'galleries'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Watched searches tab ----------------

/**
 * Saved searches that ping Discord when they find new galleries. Owns its own
 * query observer (30s poll — auto-scan results land while the tab is open) so
 * refetches never re-render the rest of the page; the search tab's Watch
 * button shares the same cache key.
 */
