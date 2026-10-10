import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ImageOff, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Select, Spinner, EmptyState } from './ui';

/**
 * Page preview for a Kavita series: lists the series' .cbz archives as
 * chapters and serves individual pages from disk (positional CBZ reads),
 * with the same viewer controls as the Downloader's gallery preview.
 */
export function SeriesPreviewModal({ seriesId, name, onClose }: { seriesId: number; name: string; onClose: () => void }) {
  const files = useQuery({ queryKey: ['cbz-series-files', seriesId], queryFn: () => api.cbzSeriesFiles(seriesId) });
  const [chapter, setChapter] = React.useState(0);
  const chapterFile = files.data?.files[chapter] ?? null;
  const images = useQuery({ queryKey: ['cbz-images', chapterFile], queryFn: () => api.cbzImages(chapterFile!), enabled: chapterFile !== null });

  const pages = images.data?.images ?? [];
  const lastPage = Math.max(0, pages.length - 1);
  const [page, setPage] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  const showPage = (index: number) => {
    setPage(Math.max(0, Math.min(index, lastPage)));
    setFailed(false);
  };

  // Switching chapters starts at the first page of the new archive.
  React.useEffect(() => {
    setPage(0);
    setFailed(false);
  }, [chapterFile]);

  // Preload the next page so arrow-key paging feels instant.
  React.useEffect(() => {
    const next = pages[page + 1];
    if (!next || !chapterFile) return;
    const image = new Image();
    image.src = api.cbzPageUrl(chapterFile, next);
  }, [page, pages, chapterFile]);

  const body = files.isPending || !files.data ? (
    <div className="flex h-64 items-center justify-center"><Spinner className="h-6 w-6" /></div>
  ) : files.data.dir === null ? (
    <EmptyState icon={<ImageOff className="h-8 w-8" />} title="Cannot locate this series on this machine" description={files.data.reason ?? undefined} />
  ) : files.data.files.length === 0 ? (
    <EmptyState icon={<ImageOff className="h-8 w-8" />} title="No .cbz files" description="This series folder holds no archives to preview." />
  ) : (
    <div className="flex min-w-0 flex-col gap-3">
      {files.data.files.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Chapter</span>
          <Select aria-label="Preview chapter" value={chapter} onChange={(event) => setChapter(Number(event.target.value))} className="min-w-0 flex-1 py-1 text-xs">
            {files.data.files.map((f, i) => (
              <option key={f} value={i}>{f.split(/[\\/]/).pop()}</option>
            ))}
          </Select>
        </label>
      )}
      <div
        className="flex min-h-0 flex-col gap-2"
        tabIndex={0}
        aria-label={`Page preview for ${name}. Click the left half for the previous page or the right half for the next page. You can also use left and right arrow keys.`}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') showPage(page - 1);
          if (event.key === 'ArrowRight') showPage(page + 1);
        }}
      >
        <div className="relative flex h-[min(60dvh,36rem)] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background sm:h-[min(72dvh,54rem)] lg:h-[min(84dvh,72rem)]">
          {images.isPending ? (
            <Spinner className="h-6 w-6" />
          ) : pages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted"><ImageOff className="h-8 w-8" />No image pages found in this archive.</div>
          ) : failed ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted"><ImageOff className="h-8 w-8" />This page could not be loaded.<Button size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}><RotateCcw className="h-3.5 w-3.5" /> Retry page</Button></div>
          ) : (
            <>
            <img
              key={`${chapterFile}:${page}:${attempt}`}
              src={api.cbzPageUrl(chapterFile!, pages[page])}
              alt={`Page ${page + 1} of ${pages.length} from ${name}`}
              className="h-full w-full object-contain"
              onError={() => setFailed(true)}
            />
              <button type="button" tabIndex={-1} aria-label="Previous page — left half of preview" title="Previous page" disabled={page === 0} onClick={() => showPage(page - 1)} className="absolute inset-y-0 left-0 w-1/2 cursor-pointer disabled:cursor-default" />
              <button type="button" tabIndex={-1} aria-label="Next page — right half of preview" title="Next page" disabled={page === lastPage} onClick={() => showPage(page + 1)} className="absolute inset-y-0 right-0 w-1/2 cursor-pointer disabled:cursor-default" />
            </>
          )}
        </div>
        {pages.length > 0 && (
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => showPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Previous</span></Button>
            <label className="flex min-w-0 items-center justify-center gap-1.5 text-xs text-muted">
              <span>Page</span>
              <Select aria-label="Preview page" value={page} onChange={(event) => showPage(Number(event.target.value))} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-20 py-0 pl-2 pr-7 text-xs">
                {pages.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}
              </Select>
              <span>of {pages.length}</span>
            </label>
            <Button size="sm" variant="outline" disabled={page === lastPage} onClick={() => showPage(page + 1)} aria-label="Next page"><span className="hidden sm:inline">Next</span><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[min(98vw,1600px)]">
        <div className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-4 overflow-y-auto p-3 sm:p-5">
          <div className="shrink-0 pr-10">
            <DialogTitle>Preview · {name}</DialogTitle>
            <DialogDescription className="mt-1">Pages are read directly from the series' .cbz files on disk.</DialogDescription>
          </div>
          {body}
        </div>
      </DialogContent>
    </Dialog>
  );
}
