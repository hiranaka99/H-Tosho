import * as React from 'react';
import { ChevronLeft, ChevronRight, ImageOff, RotateCcw } from 'lucide-react';
import { Button, Select, Spinner } from './ui';

/** Shared page controls for remote galleries and local archives. Key by resource to reset paging. */
export const PagePreview = React.memo(function PagePreview({ pages, fallbacks, name }: {
  pages: readonly string[];
  fallbacks?: readonly (string | null)[];
  name: string;
}) {
  const [page, setPage] = React.useState(0);
  const [attempt, setAttempt] = React.useState(0);
  const [loaded, setLoaded] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const lastPage = Math.max(0, pages.length - 1);
  const currentPage = Math.min(page, lastPage);
  const src = pages[currentPage];
  const token = `${src}:${attempt}`;
  const options = React.useMemo(() => pages.map((_, index) => <option key={index} value={index}>{index + 1}</option>), [pages.length]);

  const showPage = (index: number) => setPage(Math.max(0, Math.min(index, lastPage)));

  React.useEffect(() => {
    if (loaded !== token || failed === token) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return;
    const next = pages[currentPage + 1];
    if (!next) return;
    const image = new Image();
    const fallback = fallbacks?.[currentPage + 1];
    image.onerror = () => {
      image.onerror = null;
      if (fallback) image.src = fallback;
    };
    image.src = next;
    return () => { image.onerror = null; image.removeAttribute('src'); };
  }, [loaded, failed, token, pages, fallbacks, currentPage]);

  return (
    <div className="flex min-h-0 shrink-0 flex-col gap-2" tabIndex={0}
      aria-label={`Page preview for ${name}. Use left and right arrow keys or click either half to turn pages.`}
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('select, input, textarea, button, [contenteditable]')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          showPage(currentPage + (event.key === 'ArrowLeft' ? -1 : 1));
        }
      }}>
      <div className="relative flex h-[min(60dvh,36rem)] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background sm:h-[min(72dvh,54rem)] lg:h-[min(calc(100dvh-15rem),72rem)]" aria-busy={!!src && loaded !== token && failed !== token}>
        {!src ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted"><ImageOff className="h-8 w-8" />No image pages found.</div>
        ) : failed === token ? (
          <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted"><ImageOff className="h-8 w-8" />This page could not be loaded.<Button size="sm" variant="outline" onClick={() => setAttempt(n => n + 1)}><RotateCcw className="h-3.5 w-3.5" />Retry page</Button></div>
        ) : (
          <>
            {loaded !== token && <div role="status" aria-label={`Loading page ${currentPage + 1}`} className="pointer-events-none absolute inset-0 flex items-center justify-center"><Spinner className="h-6 w-6" /></div>}
            <img key={token} src={src} alt={`Page ${currentPage + 1} of ${pages.length} from ${name}`} className="h-full w-full object-contain" decoding="async"
              onLoad={() => setLoaded(token)}
              onError={(event) => {
                const fallback = fallbacks?.[currentPage];
                if (fallback && event.currentTarget.src !== new URL(fallback, window.location.href).href) event.currentTarget.src = fallback;
                else setFailed(token);
              }} />
            <button type="button" tabIndex={-1} aria-label="Previous page — left half of preview" title="Previous page" disabled={currentPage === 0} onClick={() => showPage(currentPage - 1)} className="absolute inset-y-0 left-0 w-1/2 cursor-pointer disabled:cursor-default" />
            <button type="button" tabIndex={-1} aria-label="Next page — right half of preview" title="Next page" disabled={currentPage === lastPage} onClick={() => showPage(currentPage + 1)} className="absolute inset-y-0 right-0 w-1/2 cursor-pointer disabled:cursor-default" />
          </>
        )}
      </div>
      {pages.length > 0 && <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => showPage(currentPage - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Previous</span></Button>
        <label className="flex min-w-0 items-center justify-center gap-1.5 text-xs text-muted"><span>Page</span>
          <Select aria-label="Preview page" value={currentPage} onChange={(event) => showPage(Number(event.target.value))} className="max-lg:min-h-11 pointer-coarse:min-h-11 w-auto min-w-16 py-0 pl-2 pr-7 text-xs">{options}</Select>
          <span className="tabular-nums">of {pages.length}</span>
        </label>
        <Button size="sm" variant="outline" disabled={currentPage === lastPage} onClick={() => showPage(currentPage + 1)} aria-label="Next page"><span className="hidden sm:inline">Next</span><ChevronRight className="h-4 w-4" /></Button>
      </div>}
    </div>
  );
});
