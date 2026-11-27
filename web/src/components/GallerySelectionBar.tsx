import * as React from "react";
import {
  CheckSquare,
  ChevronDown,
  Combine,
  Download,
  EyeOff,
  ImageOff,
  Merge,
  X,
} from "lucide-react";
import type { DoujinSearchResult } from "../lib/api";
import { cn, sourceDisplayName } from "../lib/utils";
import { Button } from "./ui";
import { useMediaQuery } from "../lib/useMediaQuery";

/** Same breakpoint as the bar's `lg:` classes (and the app shell). */
const DESKTOP_QUERY = "(min-width: 1024px)";

/** The selection actions a results view hands to the bar (desktop and phone tray share them). */
export interface GallerySelectionActions {
  items: DoujinSearchResult[];
  onMerge: () => void;
  onMergeInto: () => void;
  /** Queue every selected gallery as its own download. */
  onDownloadEach?: () => void;
  /** Select everything on the visible page. */
  onSelectAll?: () => void;
  allSelected?: boolean;
  onRemove: (item: DoujinSearchResult) => void;
  onClear: () => void;
  onCancel: () => void;
  /** Names what Select all adds: a page, the loaded results, or what is shown. */
  selectAllLabel?: string;
  /** Where downloads land, shown beside the actions that start them. */
  destination?: React.ReactNode;
  /** Inbox triage: dismiss the selected finds that are still in Inbox. */
  dismiss?: {
    label: string;
    count: number;
    pending: boolean;
    onDismiss: () => void;
  };
}

interface GallerySelectionBarProps extends GallerySelectionActions {
  mobile?: boolean;
  onHeightChange?: (height: number) => void;
}

/** Both results grids share a shortlist; mobile keeps its actions within reach. */
export const GallerySelectionBar = React.memo(function GallerySelectionBar({
  items,
  onMerge,
  onMergeInto,
  onDownloadEach,
  onSelectAll,
  allSelected = false,
  onRemove,
  onClear,
  onCancel,
  selectAllLabel = "Select all on page",
  destination,
  dismiss,
  mobile = false,
  onHeightChange,
}: GallerySelectionBarProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  // The phone tray keeps the count and actions in reach; the title list is one tap away.
  const [listOpen, setListOpen] = React.useState(false);
  // Desktop and phone copies are both rendered by callers; only the one that
  // fits the viewport mounts, so the other never builds its list or observers.
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const shown = mobile ? !desktop : desktop;
  React.useLayoutEffect(() => {
    const tray = ref.current;
    if (!shown || !mobile || !tray || !onHeightChange) return;
    const main = tray.closest("main");
    const previousPadding = main?.style.scrollPaddingBottom ?? "";
    const measure = () => {
      const height = tray.getBoundingClientRect().height;
      onHeightChange(height);
      // Keyboard focus and scrollIntoView must stop above the fixed tray.
      if (main)
        main.style.scrollPaddingBottom = height
          ? `${height + 16}px`
          : previousPadding;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(tray);
    measure();
    return () => {
      observer.disconnect();
      onHeightChange(0);
      if (main) main.style.scrollPaddingBottom = previousPadding;
    };
  }, [shown, mobile, onHeightChange]);

  if (!shown) return null;
  return (
    <div
      ref={ref}
      role="region"
      aria-label="Gallery selection"
      className={cn(
        "min-w-0 border-border bg-surface",
        mobile
          ? "fixed inset-x-0 bottom-0 z-20 border-t px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
          : "mb-4 hidden rounded-lg border p-3 lg:block"
      )}
    >
      <p className="sr-only" role="status">
        {items.length} {items.length === 1 ? "gallery" : "galleries"} selected.
      </p>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2">
        <p className="flex min-h-11 items-center gap-2 text-sm font-semibold">
          <CheckSquare
            className="h-4 w-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          {items.length
            ? `${items.length} selected ${items.length === 1 ? "gallery" : "galleries"}`
            : "Select galleries"}
        </p>
        <div className="flex flex-wrap gap-1">
          {onSelectAll && !allSelected && (
            <Button size="sm" variant="ghost" onClick={onSelectAll}>
              {selectAllLabel}
            </Button>
          )}
          {items.length > 0 && mobile && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={listOpen}
              aria-controls={listId}
              onClick={() => setListOpen((open) => !open)}
            >
              {listOpen ? "Hide list" : "Show list"}
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-150",
                  listOpen && "rotate-180"
                )}
              />
            </Button>
          )}
          {items.length > 0 && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear all
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      {items.length > 0 ? (
        <>
          <ol
            id={listId}
            hidden={mobile && !listOpen}
            aria-label="Selected galleries"
            className="grid max-h-[min(9rem,22dvh)] grid-cols-1 gap-x-6 overflow-y-auto overscroll-contain border-y border-border lg:max-h-48 lg:grid-cols-2 xl:grid-cols-3"
          >
            {items.map((item) => (
              <li
                key={`${item.source}:${item.galleryId}`}
                data-gallery-shortlist-id={`${item.source}:${item.galleryId}`}
                className="flex min-w-0 items-center gap-2 border-b border-border py-2"
              >
                <span
                  className="relative flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2 text-muted"
                  aria-hidden="true"
                >
                  <ImageOff className="h-4 w-4" />
                  {item.coverUrl && (
                    <img
                      src={item.coverUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 break-words text-xs font-medium leading-4">
                  {item.title}
                  <span className="mt-1 block font-normal text-muted">
                    {sourceDisplayName(item.source)} · #{item.galleryId}
                  </span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => onRemove(item)}
                  aria-label={`Remove ${item.title} from selection`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-xs text-muted">
          Choose galleries below, or use {selectAllLabel}.
        </p>
      )}
      {destination && (
        <div hidden={mobile && !listOpen} className="mt-3 lg:hidden">
          {destination}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        {destination && (
          <div className="hidden min-w-0 lg:block">{destination}</div>
        )}
        <div className="grid grid-cols-2 gap-2 lg:ml-auto lg:flex lg:flex-wrap lg:justify-end">
          {onDownloadEach && (
            <Button
              size="sm"
              className="col-span-2 h-auto min-h-11 py-2"
              disabled={!items.length}
              onClick={onDownloadEach}
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              <span>
                {items.length > 1
                  ? `Download each (${items.length})`
                  : "Download"}
              </span>
            </Button>
          )}
          {dismiss && (
            <Button
              size="sm"
              variant="outline"
              className="col-span-2 h-auto min-h-11 py-2"
              disabled={!dismiss.count || dismiss.pending}
              onClick={dismiss.onDismiss}
            >
              <EyeOff className="h-3.5 w-3.5 shrink-0" />
              <span>{dismiss.label}</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-auto min-h-11 py-2"
            disabled={!items.length}
            onClick={onMerge}
          >
            <Combine className="h-3.5 w-3.5 shrink-0" />
            <span>Merge into new series</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-auto min-h-11 py-2"
            disabled={!items.length}
            onClick={onMergeInto}
          >
            <Merge className="h-3.5 w-3.5 shrink-0" />
            <span>Add to existing series</span>
          </Button>
        </div>
      </div>
    </div>
  );
});
