import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Combine } from 'lucide-react';
import { type DoujinSearchResult } from '../lib/api';
import { useDownloads } from '../lib/DownloadsContext';
import { Button, Dialog, DialogContent, Input, Label, Spinner } from './ui';
import { toast } from '../lib/toast';

interface MergeDownloadModalProps {
  /** The selected search results (two or more) that form one series. */
  items: DoujinSearchResult[];
  onClose: () => void;
}

/** Pull a chapter number out of titles like "… ch 12 …", "chapter 3", "#5". */
function prefillChapter(title: string): string {
  const m = title.match(/\b(?:ch|chap|chapter|ep)\.?\s*(\d+(?:\.\d+)?)/i) ?? title.match(/#(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

/**
 * Batch-download several galleries into one shared folder so Kavita groups them
 * as a single series. Each gallery becomes its own .cbz with a manual chapter
 * number (ComicInfo.Number) for ordering.
 */
export function MergeDownloadModal({ items, onClose }: MergeDownloadModalProps) {
  const qc = useQueryClient();
  const { startDownload } = useDownloads();
  const [seriesName, setSeriesName] = React.useState('');
  const [chapters, setChapters] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((it) => [`${it.source}:${it.galleryId}`, prefillChapter(it.title)])),
  );
  const [pending, setPending] = React.useState(false);

  const confirm = async () => {
    const name = seriesName.trim();
    if (!name || pending) return;
    setPending(true);
    let queued = 0;
    const skipped: string[] = [];
    try {
      for (const it of items) {
        const key = `${it.source}:${it.galleryId}`;
        const raw = chapters[key]?.trim();
        const chapter = raw && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
        try {
          await startDownload({ source: it.source, galleryId: it.galleryId, title: it.title ?? undefined, format: 'cbz', mergeFolder: name, chapter });
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
        toast({ tone: 'success', title: `${queued} download${queued === 1 ? '' : 's'} queued`, description: `All chapters land in one folder — “${name}” becomes the series.` });
        onClose();
      } else {
        toast({ tone: 'info', title: 'Nothing to download', description: 'Every selected gallery is already downloaded.' });
      }
    } catch (e) {
      setPending(false);
      toast({ tone: 'danger', title: `Queued ${queued} of ${items.length}`, description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2 pr-6">
            <Combine className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Merge &amp; download</h2>
          </div>

          {/* Series name */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-border-2 bg-surface-2 p-3">
            <Label htmlFor="merge-dl-name">Merged series name</Label>
            <Input id="merge-dl-name" value={seriesName} onChange={(e) => setSeriesName(e.target.value)} placeholder="e.g. A Fifth of Romance" />
            <p className="text-[11px] text-muted">
              Each gallery downloads as its own .cbz into one shared folder — Kavita shows them as a single series with this name.
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
              <Button size="sm" onClick={() => void confirm()} disabled={!seriesName.trim() || pending}>
                {pending ? <Spinner /> : <Combine className="h-3.5 w-3.5" />} Queue {items.length} download{items.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
