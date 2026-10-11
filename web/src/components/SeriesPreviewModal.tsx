import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { api } from '../lib/api';
import { Dialog, DialogContent, DialogTitle, Select, Spinner, EmptyState, ErrorState } from './ui';

import { PagePreview } from './PagePreview';

const EMPTY_IMAGES: string[] = [];

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

  const imagesList = images.data?.images ?? EMPTY_IMAGES;
  const pages = React.useMemo(() => chapterFile ? imagesList.map(image => api.cbzPageUrl(chapterFile, image)) : EMPTY_IMAGES, [chapterFile, imagesList]);

  const body = files.isError ? (
    <ErrorState title="Could not load preview chapters" onRetry={() => void files.refetch()} />
  ) : files.isPending || !files.data ? (
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
      {images.isError ? (
        <ErrorState title="Could not load archive pages" onRetry={() => void images.refetch()} />
      ) : images.isPending ? (
        <div role="status" aria-label="Loading archive pages" className="flex h-64 items-center justify-center"><Spinner className="h-6 w-6" /></div>
      ) : (
        <PagePreview key={chapterFile} pages={pages} name={name} />
      )}
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[min(98vw,1600px)]" aria-describedby={undefined}>
        <div className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-4 overflow-y-auto p-3 sm:p-5">
          <div className="shrink-0 pr-10">
            <DialogTitle>Preview · {name}</DialogTitle>
          </div>
          {body}
        </div>
      </DialogContent>
    </Dialog>
  );
}
