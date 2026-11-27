import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  MoveHorizontal,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button, Select, Spinner } from "./ui";
import { cn } from "../lib/utils";

type Fit = "page" | "width";
const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;
/** Keys the reader never steals from fields, radios, or modified shortcuts. */
const KEY_EXEMPT =
  'input, select, textarea, [contenteditable], [role="radio"], [role="slider"], [role="listbox"]';

/** Last page viewed per gallery for this session, so closing and reopening resumes. */
const pageMemory = new Map<string, number>();
/** Last fit mode, so a reader who prefers fit-width keeps it from gallery to gallery. */
let preferredFit: Fit = "page";

function rememberPage(key: string, page: number) {
  pageMemory.delete(key);
  pageMemory.set(key, page);
  if (pageMemory.size > 200) pageMemory.delete(pageMemory.keys().next().value!);
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-border-2 bg-surface-2 px-1 font-sans text-xs leading-4 text-foreground">
      {children}
    </kbd>
  );
}

export interface PagePreviewHandle {
  /** Drop back to the unzoomed view. Returns false when there was nothing to reset. */
  resetZoom: () => boolean;
  focus: () => void;
}

/**
 * Shared page reader for remote galleries and local archives. Key by resource to
 * reset paging. Inside a dialog it listens for page keys on the whole dialog, so
 * paging works wherever focus sits (except fields and radios).
 */
export const PagePreview = React.memo(function PagePreview({
  pages,
  fallbacks,
  name,
  memoryKey,
  sourceLabel,
  failureNote,
  ref,
}: {
  pages: readonly string[];
  fallbacks?: readonly (string | null)[];
  name: string;
  /** Remember the current page under this key for the session. */
  memoryKey?: string;
  /** Where pages come from, named in the failed-page message. */
  sourceLabel?: string;
  /** Extra reassurance under a failed page. */
  failureNote?: string;
  ref?: React.Ref<PagePreviewHandle>;
}) {
  const lastPage = Math.max(0, pages.length - 1);
  const [page, setPage] = React.useState(() =>
    memoryKey ? (pageMemory.get(memoryKey) ?? 0) : 0
  );
  const [attempt, setAttempt] = React.useState(0);
  const [loaded, setLoaded] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [fit, setFitState] = React.useState<Fit>(preferredFit);
  const [zoomIndex, setZoomIndex] = React.useState(0);
  const [natural, setNatural] = React.useState<{
    token: string;
    w: number;
    h: number;
  } | null>(null);
  const [viewport, setViewport] = React.useState<{
    w: number;
    h: number;
  } | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const currentPage = Math.min(page, lastPage);
  const src = pages[currentPage];
  const token = `${src}:${attempt}`;
  const zoom = ZOOM_STEPS[zoomIndex];
  const scrollable = fit === "width" || zoom > 1;
  const options = React.useMemo(
    () =>
      Array.from({ length: pages.length }, (_, index) => (
        <option key={index} value={index}>
          {index + 1}
        </option>
      )),
    [pages.length]
  );

  const showPage = React.useCallback(
    (index: number) => setPage(Math.max(0, Math.min(index, lastPage))),
    [lastPage]
  );
  const setFit = (next: Fit) => {
    preferredFit = next;
    setFitState(next);
  };
  const stepZoom = React.useCallback(
    (delta: number) =>
      setZoomIndex((i) =>
        Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + delta))
      ),
    []
  );

  React.useImperativeHandle(
    ref,
    () => ({
      resetZoom: () => {
        if (zoomIndex === 0) return false;
        setZoomIndex(0);
        return true;
      },
      focus: () => rootRef.current?.focus({ preventScroll: true }),
    }),
    [zoomIndex]
  );

  React.useEffect(() => {
    if (memoryKey) rememberPage(memoryKey, currentPage);
  }, [memoryKey, currentPage]);

  // Measure the visible stage so fit-width and zoom can size the image in pixels.
  const hasFailed = failed === token;
  React.useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () =>
      setViewport((v) =>
        v && v.w === el.clientWidth && v.h === el.clientHeight
          ? v
          : { w: el.clientWidth, h: el.clientHeight }
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [src, hasFailed]);

  const size =
    natural?.token === token && viewport && viewport.w > 0 && viewport.h > 0
      ? (() => {
          const base =
            fit === "width"
              ? viewport.w / natural.w
              : Math.min(viewport.w / natural.w, viewport.h / natural.h);
          return {
            width: Math.round(natural.w * base * zoom),
            height: Math.round(natural.h * base * zoom),
          };
        })()
      : null;

  // A new page starts at its top-left corner.
  React.useLayoutEffect(() => {
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [token]);

  // Zooming keeps the point at the centre of the stage where it was; changing the fit starts at the top.
  const lastSize = React.useRef<{
    token: string;
    fit: Fit;
    width: number;
  } | null>(null);
  const sizeWidth = size?.width;
  React.useLayoutEffect(() => {
    const el = viewportRef.current;
    const prev = lastSize.current;
    lastSize.current =
      sizeWidth !== undefined ? { token, fit, width: sizeWidth } : null;
    if (!el || sizeWidth === undefined || !prev || prev.token !== token) return;
    if (prev.fit !== fit) {
      el.scrollTo({ top: 0, left: 0 });
      return;
    }
    if (prev.width === sizeWidth) return;
    const ratio = sizeWidth / prev.width;
    el.scrollLeft =
      (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
    el.scrollTop =
      (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
  }, [token, fit, sizeWidth]);

  React.useEffect(() => {
    if (loaded !== token || failed === token) return;
    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    if (
      connection?.saveData ||
      connection?.effectiveType === "slow-2g" ||
      connection?.effectiveType === "2g"
    )
      return;
    const next = pages[currentPage + 1];
    if (!next) return;
    const image = new Image();
    const fallback = fallbacks?.[currentPage + 1];
    image.onerror = () => {
      image.onerror = null;
      if (fallback) image.src = fallback;
    };
    image.src = next;
    return () => {
      image.onerror = null;
      image.removeAttribute("src");
    };
  }, [loaded, failed, token, pages, fallbacks, currentPage]);

  // Page keys work anywhere in the surrounding dialog, not only on the stage.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root || pages.length === 0) return;
    const scope: HTMLElement = root.closest('[role="dialog"]') ?? root;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.target instanceof Element && event.target.closest(KEY_EXEMPT))
        return;
      const actions: Record<string, () => void> = {
        ArrowLeft: () => showPage(currentPage - 1),
        ArrowRight: () => showPage(currentPage + 1),
        Home: () => showPage(0),
        End: () => showPage(lastPage),
        "+": () => stepZoom(1),
        "=": () => stepZoom(1),
        "-": () => stepZoom(-1),
        "0": () => setZoomIndex(0),
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    scope.addEventListener("keydown", onKey);
    return () => scope.removeEventListener("keydown", onKey);
  }, [pages.length, currentPage, lastPage, showPage, stepZoom]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (
      !scrollable ||
      !el ||
      event.pointerType !== "mouse" ||
      event.button !== 0
    )
      return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    el.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    const d = drag.current;
    if (!el || !d || d.id !== event.pointerId) return;
    el.scrollLeft = d.left - (event.clientX - d.x);
    el.scrollTop = d.top - (event.clientY - d.y);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const pageLabel = `Page ${currentPage + 1}`;
  return (
    <div
      ref={rootRef}
      className="flex min-h-0 shrink-0 flex-col gap-2 rounded-lg"
      tabIndex={-1}
      data-page-preview=""
      role="group"
      aria-label={`Page preview for ${name}`}
    >
      <div
        className="relative h-[min(46dvh,30rem)] shrink-0 overflow-hidden rounded-lg border border-border bg-reader-stage text-reader-ink sm:h-[min(72dvh,54rem)] lg:h-[min(calc(100dvh-17rem),72rem)]"
        aria-busy={!!src && loaded !== token && failed !== token}
      >
        {!src ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-reader-ink-muted">
            <ImageOff className="h-8 w-8" />
            No image pages found.
          </div>
        ) : failed === token ? (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
          >
            <ImageOff className="h-8 w-8 text-reader-ink-muted" />
            <div className="max-w-xs space-y-1">
              <p className="text-sm font-medium">
                {pageLabel} didn’t load
                {sourceLabel ? ` from ${sourceLabel}` : ""}.
              </p>
              {failureNote && (
                <p className="text-xs text-reader-ink-muted">{failureNote}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry page
            </Button>
          </div>
        ) : (
          <>
            <div
              ref={viewportRef}
              className={cn(
                "absolute inset-0 flex",
                scrollable
                  ? "overflow-auto overscroll-contain [scrollbar-gutter:stable]"
                  : "overflow-hidden",
                scrollable &&
                  (dragging ? "cursor-grabbing select-none" : "cursor-grab")
              )}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img
                key={token}
                src={src}
                alt={`Page ${currentPage + 1} of ${pages.length} from ${name}`}
                draggable={false}
                decoding="async"
                className={cn(
                  scrollable && size
                    ? "m-auto block max-w-none shrink-0"
                    : "h-full w-full object-contain"
                )}
                style={
                  scrollable && size
                    ? { width: size.width, height: size.height }
                    : undefined
                }
                onLoad={(event) => {
                  setNatural({
                    token,
                    w: event.currentTarget.naturalWidth || 1,
                    h: event.currentTarget.naturalHeight || 1,
                  });
                  setLoaded(token);
                }}
                onError={(event) => {
                  const fallback = fallbacks?.[currentPage];
                  if (
                    fallback &&
                    event.currentTarget.src !==
                      new URL(fallback, window.location.href).href
                  )
                    event.currentTarget.src = fallback;
                  else setFailed(token);
                }}
              />
            </div>
            {loaded !== token && (
              <div
                role="status"
                aria-label={`Loading page ${currentPage + 1}`}
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <Spinner className="h-6 w-6 text-reader-ink-muted" />
              </div>
            )}
            {!scrollable && (
              <>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Previous page — left half of preview"
                  title="Previous page"
                  disabled={currentPage === 0}
                  onClick={() => showPage(currentPage - 1)}
                  className="group/turn absolute inset-y-0 left-0 flex w-1/2 cursor-pointer items-center justify-start pl-3 disabled:cursor-default"
                >
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-reader-stage/70 text-reader-ink opacity-0 transition-opacity duration-150 pointer-fine:group-hover/turn:opacity-100 group-disabled/turn:hidden"
                    aria-hidden="true"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </span>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Next page — right half of preview"
                  title="Next page"
                  disabled={currentPage === lastPage}
                  onClick={() => showPage(currentPage + 1)}
                  className="group/turn absolute inset-y-0 right-0 flex w-1/2 cursor-pointer items-center justify-end pr-3 disabled:cursor-default"
                >
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-reader-stage/70 text-reader-ink opacity-0 transition-opacity duration-150 pointer-fine:group-hover/turn:opacity-100 group-disabled/turn:hidden"
                    aria-hidden="true"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </span>
                </button>
              </>
            )}
          </>
        )}
      </div>
      {pages.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-x-1.5 gap-y-2 sm:gap-x-3 rounded-lg bg-surface px-1 py-1 lg:static lg:bg-transparent">
          <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="min-w-11"
              disabled={currentPage === 0}
              onClick={() => showPage(currentPage - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Previous</span>
            </Button>
            <label className="flex min-w-0 items-center gap-1 text-sm text-muted sm:gap-1.5">
              <span className="sr-only sm:not-sr-only">Page</span>
              <Select
                aria-label="Preview page"
                value={currentPage}
                onChange={(event) => showPage(Number(event.target.value))}
                className="max-lg:min-h-11 pointer-coarse:min-h-11 w-auto min-w-14 py-0 pl-2 pr-7 text-sm"
              >
                {options}
              </Select>
              <span className="whitespace-nowrap tabular-nums">
                of {pages.length}
              </span>
            </label>
            <Button
              size="sm"
              variant="outline"
              className="min-w-11"
              disabled={currentPage === lastPage}
              onClick={() => showPage(currentPage + 1)}
              aria-label="Next page"
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div
            className="flex items-center sm:gap-1.5"
            role="group"
            aria-label="Page view"
          >
            <Button
              size="sm"
              variant={fit === "width" ? "secondary" : "ghost"}
              className="min-w-11"
              aria-pressed={fit === "width"}
              onClick={() => setFit(fit === "width" ? "page" : "width")}
              title={
                fit === "width"
                  ? "Fit the whole page"
                  : "Fit the page to the width"
              }
            >
              <MoveHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Fit width</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="min-w-11"
              aria-label="Zoom out"
              title="Zoom out (−)"
              disabled={zoomIndex === 0}
              onClick={() => stepZoom(-1)}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <button
              type="button"
              className="ui-button hidden h-9 min-w-12 rounded-lg px-1 text-sm tabular-nums text-muted hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none sm:inline-flex sm:items-center sm:justify-center"
              aria-label={`Zoom ${Math.round(zoom * 100)}%, reset`}
              title="Reset zoom (0)"
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex(0)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              size="sm"
              variant="ghost"
              className="min-w-11"
              aria-label="Zoom in"
              title="Zoom in (+)"
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              onClick={() => stepZoom(1)}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
          <p className="hidden w-full text-xs text-muted lg:pointer-fine:block">
            <Key>←</Key> <Key>→</Key> turn pages · <Key>+</Key> <Key>−</Key>{" "}
            zoom ·{" "}
            {scrollable
              ? "drag the page to move around"
              : "or click either half of the page"}
          </p>
        </div>
      )}
    </div>
  );
});
