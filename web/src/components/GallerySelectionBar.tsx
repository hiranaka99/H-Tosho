import * as React from 'react';
import { CheckSquare, Combine, ImageOff, Merge, X } from 'lucide-react';
import type { DoujinSearchResult } from '../lib/api';
import { cn, sourceDisplayName } from '../lib/utils';
import { Button } from './ui';

interface GallerySelectionBarProps {
  items: DoujinSearchResult[];
  onMerge: () => void;
  onMergeInto: () => void;
  onRemove: (item: DoujinSearchResult) => void;
  onClear: () => void;
  onCancel: () => void;
  mobile?: boolean;
  onHeightChange?: (height: number) => void;
}

/** Both results grids share a shortlist; mobile keeps its actions within reach. */
export const GallerySelectionBar = React.memo(function GallerySelectionBar({ items, onMerge, onMergeInto, onRemove, onClear, onCancel, mobile = false, onHeightChange }: GallerySelectionBarProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const tray = ref.current;
    if (!mobile || !tray || !onHeightChange) return;
    const main = tray.closest('main');
    const previousPadding = main?.style.scrollPaddingBottom ?? '';
    const measure = () => {
      const height = tray.getBoundingClientRect().height;
      onHeightChange(height);
      // Keyboard focus and scrollIntoView must stop above the fixed tray.
      if (main) main.style.scrollPaddingBottom = height ? `${height + 16}px` : previousPadding;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(tray);
    measure();
    return () => {
      observer.disconnect();
      onHeightChange(0);
      if (main) main.style.scrollPaddingBottom = previousPadding;
    };
  }, [mobile, onHeightChange]);

  return (
    <div ref={ref} role="region" aria-label="Merge selected galleries" className={cn(
      'min-w-0 border-border bg-surface',
      mobile ? 'fixed inset-x-0 bottom-0 z-20 border-t px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden' : 'mb-4 hidden rounded-lg border p-3 lg:block',
    )}>
      <p className="sr-only" role="status">{items.length} {items.length === 1 ? 'gallery' : 'galleries'} selected for merging.</p>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2">
        <p className="flex min-h-11 items-center gap-2 text-sm font-semibold"><CheckSquare className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{items.length ? `${items.length} selected ${items.length === 1 ? 'gallery' : 'galleries'}` : 'Select galleries to merge'}</p>
        <div className="flex gap-1">
          {items.length > 0 && <Button size="sm" variant="ghost" onClick={onClear}>Clear all</Button>}
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
      {items.length > 0 ? <>
        <ol aria-label="Selected galleries" className="grid max-h-[min(9rem,22dvh)] grid-cols-1 gap-x-6 overflow-y-auto overscroll-contain border-y border-border lg:max-h-48 lg:grid-cols-2 xl:grid-cols-3">
          {items.map(item => <li key={`${item.source}:${item.galleryId}`} data-gallery-shortlist-id={`${item.source}:${item.galleryId}`} className="flex min-w-0 items-center gap-2 border-b border-border py-2">
            <span className="relative flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2 text-muted" aria-hidden="true">
              <ImageOff className="h-4 w-4" />
              {item.coverUrl && <img src={item.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} className="absolute inset-0 h-full w-full object-cover" />}
            </span>
            <span className="min-w-0 flex-1 break-words text-xs font-medium leading-4">{item.title}<span className="mt-1 block font-normal text-muted">{sourceDisplayName(item.source)} · #{item.galleryId}</span></span>
            <Button size="icon" variant="ghost" className="shrink-0" onClick={() => onRemove(item)} aria-label={`Remove ${item.title} from selection`}><X className="h-4 w-4" /></Button>
          </li>)}
        </ol>
      </> : <p className="text-xs text-muted">Choose galleries below. Their titles will appear here.</p>}
      <div className="mt-3 grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:justify-end">
        <Button size="sm" className="h-auto min-h-11 py-2" disabled={!items.length} onClick={onMerge}>
          <Combine className="h-3.5 w-3.5 shrink-0" /><span>Download as new series</span>
        </Button>
        <Button size="sm" variant="outline" className="h-auto min-h-11 py-2" disabled={!items.length} onClick={onMergeInto}>
          <Merge className="h-3.5 w-3.5 shrink-0" /><span>Add to existing series</span>
        </Button>
      </div>
    </div>
  );
});
