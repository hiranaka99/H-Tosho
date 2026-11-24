import { formatDate, Cover, SourceBadge } from './GalleryCard';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Loader2, Download as DownloadIcon, RotateCcw, CheckCircle2, X, ExternalLink, BookOpen, Users, Layers, Star, Tags } from 'lucide-react';
import { api, type DoujinSource, type DoujinSearchResult } from '../../lib/api';
import { useGalleryDownloadTask } from '../../lib/DownloadsContext';
import { buildTagSearchFragment, cn } from '../../lib/utils';
import { Button, Spinner, Disclosure, ProgressBar } from '../../components/ui';
import { Dialog, DialogContent, DialogTitle } from '../../components/dialog';
import { PagePreview, type PagePreviewHandle } from '../../components/PagePreview';

import { SOURCE_LABELS, type DownloadSetup } from './state';
import { DownloadDestination, DownloadFailure } from './DownloadSetup';

const DOWNLOADS_URL = '/downloader?tab=downloads';
/** Tags shown before "Show all": enough to judge a gallery, few enough to scan. */
const TAG_PREVIEW_LIMIT = 12;
const NAMESPACE_LABELS: Record<string, string> = {
  female: 'Female', male: 'Male', mixed: 'Mixed', other: 'Other', language: 'Language', parody: 'Parody',
  character: 'Character', artist: 'Artist', group: 'Group', cosplayer: 'Cosplayer', reclass: 'Category',
};
const GENERAL_NAMESPACES = new Set(['', 'tag', 'tags', 'misc']);
const GENERAL_LABEL = 'General';

function namespaceLabel(ns?: string | null): string {
  if (!ns || GENERAL_NAMESPACES.has(ns)) return GENERAL_LABEL;
  return NAMESPACE_LABELS[ns] ?? ns.charAt(0).toUpperCase() + ns.slice(1);
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{icon} {children}</p>;
}

/** One neutral chip style: the section label names the kind, so hue carries no meaning. */
function TagChip({ value, onClick, title }: { value: string; onClick?: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn('max-lg:min-h-11 pointer-coarse:min-h-11 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-foreground transition-colors', onClick && 'cursor-pointer hover:bg-border')}
    >
      {value}
    </button>
  );
}

function TagList({ label, items, icon, onSearch, titleFor }: {
  label: string;
  items?: string[];
  icon?: React.ReactNode;
  onSearch?: (value: string) => void;
  /** Tooltip for a searchable item — show the exact query it will run. */
  titleFor?: (value: string) => string | undefined;
}) {
  if (!items?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel icon={icon}>{label}</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t, i) => (
          <TagChip key={i} value={t} onClick={onSearch ? () => onSearch(t) : undefined} title={titleFor ? titleFor(t) : onSearch ? `Search for “${t}”` : undefined} />
        ))}
      </div>
    </div>
  );
}

/**
 * Tags grouped by namespace, so "glasses" under Female and Male read as two
 * different tags. The first dozen show; the rest wait behind "Show all".
 */
function TagGroups({ tags, onSearch, titleFor }: {
  tags: { value: string; ns: string | null }[];
  onSearch: (value: string, ns: string | null) => void;
  titleFor: (value: string, ns: string | null) => string | undefined;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const ordered = React.useMemo(() => {
    const groups = new Map<string, { value: string; ns: string | null }[]>();
    for (const tag of tags) {
      const label = namespaceLabel(tag.ns);
      groups.set(label, [...(groups.get(label) ?? []), tag]);
    }
    // Named namespaces first (in the source's order); untyped tags last.
    const general = groups.get(GENERAL_LABEL);
    groups.delete(GENERAL_LABEL);
    if (general) groups.set(GENERAL_LABEL, general);
    return [...groups].flatMap(([label, items]) => items.map((tag) => ({ ...tag, label })));
  }, [tags]);
  if (!ordered.length) return null;
  const collapsible = ordered.length > TAG_PREVIEW_LIMIT + 2;
  const visible = collapsible && !expanded ? ordered.slice(0, TAG_PREVIEW_LIMIT) : ordered;
  const groupLabels = new Set(ordered.map((tag) => tag.label));
  const showLabels = groupLabels.size > 1;
  const visibleGroups = [...new Set(visible.map((tag) => tag.label))].map((label) => ({ label, items: visible.filter((tag) => tag.label === label) }));
  const chips = (items: typeof visible) => items.map((tag, i) => (
    <TagChip key={`${tag.ns}:${tag.value}:${i}`} value={tag.value} onClick={() => onSearch(tag.value, tag.ns)} title={titleFor(tag.value, tag.ns)} />
  ));
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel icon={<Tags className="h-3 w-3" />}>Tags ({ordered.length})</SectionLabel>
      <div id={listId} className="flex flex-col gap-2">
        {visibleGroups.map(({ label, items }) => showLabels ? (
          <div key={label} role="group" aria-label={`${label} tags`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-xs text-muted">{label}</span>
            <div className="flex flex-wrap gap-1.5">{chips(items)}</div>
          </div>
        ) : (
          <div key={label} className="flex flex-wrap gap-1.5">{chips(items)}</div>
        ))}
      </div>
      {collapsible && (
        <Button variant="ghost" size="sm" className="-ml-2.5 self-start max-lg:min-h-11 pointer-coarse:min-h-11" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Show fewer tags' : `Show all ${ordered.length} tags`}
        </Button>
      )}
    </div>
  );
}

/** Where an in-progress download stands, with the way to the queue. */
function DownloadProgressNotice({ task, onClose }: { task: NonNullable<ReturnType<typeof useGalleryDownloadTask>>; onClose: () => void }) {
  const packing = task.state?.type === 'packing';
  const retrying = task.state?.type === 'retry-wait';
  const resolving = task.status === 'downloading' && task.phase === 'resolving';
  const counted = task.progressTotal > 0;
  const pct = counted ? Math.round((task.progressCurrent / task.progressTotal) * 100) : null;
  const pages = counted ? `${task.progressCurrent} of ${task.progressTotal} pages` : null;
  const label = packing ? 'Packing the file…'
    : retrying ? 'Waiting to retry'
    : task.status === 'queued' ? 'Queued'
    : task.status === 'paused' ? `Paused${pages ? ` at ${pages}` : ''}`
    : resolving || pct === null ? 'Starting download…'
    : `Downloading · ${pct}% · ${pages}`;
  const showBar = task.status === 'downloading' || task.status === 'paused';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/50 px-3 py-2" role="status">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm tabular-nums">{label}</span>
        <Link to={DOWNLOADS_URL} onClick={onClose} className="inline-flex min-h-8 max-lg:min-h-11 pointer-coarse:min-h-11 items-center text-xs text-primary underline underline-offset-4">View in Downloads</Link>
      </div>
      {showBar && <ProgressBar value={packing ? 1 : task.progressCurrent} max={packing ? 1 : task.progressTotal} active={task.status === 'downloading'} label={`Download progress for ${task.title ?? 'this gallery'}`} className="h-1.5" />}
    </div>
  );
}

export function GalleryDetailModal({ item, onClose, onDownload, checking, downloaded, inLibrary, libraryMatch, setup, onSearchTag, searchAcrossSources = false, variants, selectedVariantKey, onSelectVariant }: { item: DoujinSearchResult; onClose: () => void; onDownload: () => void; checking: boolean; downloaded: boolean; inLibrary: boolean; /** The confirmed library copy, when one was found. */ libraryMatch?: { title: string; path?: string }; setup: DownloadSetup; onSearchTag: (fragment: string, source?: DoujinSource | 'all') => void; /** Opened from All sources: shared filters search every source again. */ searchAcrossSources?: boolean; variants?: { item: DoujinSearchResult; position?: number }[]; selectedVariantKey?: string; onSelectVariant?: (item: DoujinSearchResult) => void }) {
  const task = useGalleryDownloadTask(item.source, item.galleryId);
  const downloading = !!task;
  const { data: gallery, isPending, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['doujin-gallery', item.source, item.galleryId],
    queryFn: () => api.doujinGallery(item.source, item.galleryId),
    staleTime: 5 * 60_000 });
  const g = gallery;
  const previewPages = g?.previewPages ?? [];
  const hasPreview = previewPages.length > 0;
  /** No reader to show: size the dialog to the cover and metadata. */
  const compact = !isPending && !hasPreview;
  const sourceLabel = SOURCE_LABELS[item.source];
  const title = g?.title ?? item.title;
  const reasons = 'reasons' in item && Array.isArray((item as { reasons?: unknown }).reasons)
    ? ((item as { reasons: string[] }).reasons).filter((r) => typeof r === 'string' && r.trim()).slice(0, 5)
    : [];
  const pageCount = g?.pageCount ?? item.pageCount;
  const language = g?.language ?? item.language;
  const uploaded = formatDate(g?.uploadedAt ?? item.uploadedAt);
  const facts = [pageCount ? `${pageCount} pages` : null, language, uploaded ? `Uploaded ${uploaded}` : null].filter(Boolean).join(' · ');
  // The language already sits in the header; a tag that only repeats it is noise.
  const tags = (g?.tags ?? []).map((value, i) => ({ value, ns: g?.tagNamespaces?.[i] ?? null }))
    .filter((tag) => !(language && tag.value.toLowerCase() === language.toLowerCase() && (!tag.ns || tag.ns === 'language' || GENERAL_NAMESPACES.has(tag.ns))));

  const bodyRef = React.useRef<HTMLDivElement>(null);
  const readerRef = React.useRef<PagePreviewHandle>(null);
  // Opened programmatically, so Radix has no trigger to hand focus back to: remember the card.
  const [returnFocusTo] = React.useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  // Details often arrive after the dialog opens; move to the reader then, unless the user has moved on.
  React.useEffect(() => {
    if (!hasPreview) return;
    const active = document.activeElement;
    if (!active || active === document.body || active === bodyRef.current) readerRef.current?.focus();
  }, [hasPreview]);

  /**
   * Search a single tag/artist value (from the details card). From All sources,
   * a shared filter (artist, group, character, series) stays in All sources;
   * provider-only tags search the gallery's own source, where they mean something.
   */
  const tagSearch = (value: string, ns?: string | null): { fragment: string; source: DoujinSource | 'all' } | null => {
    const shared = ns === 'series' ? 'parody' : ns;
    const clean = value.replace(/"/g, '').trim();
    if (searchAcrossSources && clean && shared && ['artist', 'group', 'character', 'parody'].includes(shared)) {
      return { fragment: `${shared}:"${clean}"`, source: 'all' };
    }
    const fragment = buildTagSearchFragment(value, ns, item.source);
    return fragment ? { fragment, source: item.source } : null;
  };
  const searchFor = (value: string, ns?: string | null) => {
    const target = tagSearch(value, ns);
    if (target) onSearchTag(target.fragment, target.source);
  };
  /** Tooltip showing the exact query a pill will run, and where. */
  const searchTitle = (value: string, ns?: string | null) => {
    const target = tagSearch(value, ns);
    return target ? `Search ${target.source === 'all' ? 'all sources' : SOURCE_LABELS[target.source]} for “${target.fragment}”` : undefined;
  };
  const libraryFile = libraryMatch?.path?.split(/[\\/]/).pop();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className={compact ? 'max-w-[min(98vw,60rem)]' : 'max-w-[min(98vw,1760px)]'}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (readerRef.current) readerRef.current.focus();
          else bodyRef.current?.focus({ preventScroll: true });
        }}
        // Esc first steps out of a zoomed page; only an unzoomed reader closes the dialog.
        onEscapeKeyDown={(event) => { if (readerRef.current?.resetZoom()) event.preventDefault(); }}
        onCloseAutoFocus={(event) => { if (returnFocusTo?.isConnected) { event.preventDefault(); returnFocusTo.focus(); } }}
      >
        <div ref={bodyRef} tabIndex={-1} className="flex max-h-[calc(100dvh-2rem)] flex-col focus-visible:outline-none">
        <div className={cn('grid min-h-0 gap-4 overflow-y-auto p-3 sm:p-5 lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-5', compact ? 'lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]')}>
          <div className="flex min-w-0 flex-col gap-3 lg:col-start-2 lg:row-start-1 lg:self-start">
            <div className="min-w-0 pr-10">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <SourceBadge source={item.source} />
              </div>
              <DialogTitle className="break-words text-lg leading-snug text-balance">{title}</DialogTitle>
              {facts && <p className="mt-1 text-sm text-muted tabular-nums">{facts}</p>}
              {reasons.length > 0 && (reasons.length <= 2 ? (
                <p className="mt-2 text-xs text-muted"><span className="font-medium text-foreground">Picked for</span> {reasons.join(' · ')}</p>
              ) : (
                <Disclosure className="mt-1" label={<><span className="font-medium text-foreground">Picked for</span> {reasons[0]} and {reasons.length - 1} more</>}
                  summaryClassName="min-h-8 max-lg:min-h-11 pointer-coarse:min-h-11 justify-start px-0 py-1 text-xs font-normal [&>span]:flex-none">
                  <p className="pb-1 text-xs text-muted">{reasons.join(' · ')}</p>
                </Disclosure>
              ))}
            </div>

            {inLibrary && (
              <div className="flex flex-col gap-1 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm">
                <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>Already in your Kavita library{libraryFile ? <> as <span className="break-all font-mono text-xs">{libraryFile}</span></> : null}.</span>
                </p>
                <Link to={`/libraries?q=${encodeURIComponent(libraryMatch?.title ?? title)}`} onClick={onClose} className="ml-6 inline-flex min-h-8 max-lg:min-h-11 pointer-coarse:min-h-11 items-center self-start text-xs text-primary underline underline-offset-4">Search Libraries for this title</Link>
              </div>
            )}
            {task && !inLibrary && <DownloadProgressNotice task={task} onClose={onClose} />}

            {isPending && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted">
                <Spinner /> Loading gallery details…
              </div>
            )}

            {isError && (
              <div className="space-y-2" role="alert">
                <p className="text-sm font-medium">Could not load gallery details</p>
                <DownloadFailure message={error instanceof Error ? error.message : String(error)} />
                {!downloaded && !downloading && <p className="text-xs text-muted">You can still download it: the download looks the gallery up on {sourceLabel} again.</p>}
                <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}><RotateCcw className="h-3.5 w-3.5" />{isFetching ? 'Retrying…' : 'Retry details'}</Button>
              </div>
            )}

          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:col-start-1 lg:row-start-1 lg:row-span-2">
            {hasPreview ? (
              <PagePreview ref={readerRef} key={`${item.source}:${item.galleryId}`} memoryKey={`${item.source}:${item.galleryId}`} pages={previewPages} fallbacks={g?.previewFallbacks} name={title}
                sourceLabel={sourceLabel} failureNote="Only the preview is affected: a download fetches every page again." />
            ) : (
              <Cover url={g?.coverUrl ?? item.coverUrl} title={item.title} className="mx-auto aspect-[3/4] w-40 rounded-md border border-border lg:w-full lg:max-w-56" />
            )}
            <div className="flex flex-wrap items-center gap-x-4 text-xs text-muted">
              {g?.url && (
                <a href={g.url} target="_blank" rel="noreferrer" className="inline-flex min-h-8 max-lg:min-h-11 pointer-coarse:min-h-11 items-center gap-1.5 transition-colors hover:text-primary">
                  <ExternalLink className="h-3 w-3" /> View on {sourceLabel}
                </a>
              )}
              <span className="inline-flex min-h-8 items-center">Gallery ID&nbsp;<span className="font-mono tabular-nums">{g?.galleryId ?? item.galleryId}</span></span>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-2 lg:self-start">
            {g && (
              <>
                {/* Unified search: the same work found on several sources.
                    Choosing a variant re-targets metadata, preview, link and
                    download at that concrete gallery. */}
                {variants && variants.length > 1 && (
                  <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Available from">
                    <SectionLabel icon={<ExternalLink className="h-3 w-3" />}>Available from</SectionLabel>
                    <ul className="flex flex-col gap-1">
                      {variants.map(({ item: v, position }) => {
                        const key = `${v.source}:${v.galleryId}`;
                        const active = key === selectedVariantKey;
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onClick={() => (key === selectedVariantKey ? undefined : onSelectVariant?.(v))}
                              className={cn(
                                'flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                                active ? 'border-primary/40 bg-primary/10' : 'border-border bg-surface-2/50 hover:border-border-2',
                              )}
                            >
                              <SourceBadge source={v.source} />
                              <span className="min-w-0 flex-1 text-xs">
                                <span className="block truncate text-foreground" title={v.title}>{v.title}</span>
                                <span className="block truncate text-muted">
                                  {position ? `Result ${position} on ${SOURCE_LABELS[v.source]}` : `Found on ${SOURCE_LABELS[v.source]}`}
                                  {v.language ? ` · ${v.language}` : ''}{typeof v.pageCount === 'number' ? ` · ${v.pageCount} pages` : ''}
                                </span>
                              </span>
                              {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <TagList label="Artists" items={g.artists ?? item.artists} icon={<Users className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'artist')} titleFor={(v) => searchTitle(v, 'artist')} />
                <TagList label="Groups / circles" items={g.groups} icon={<Layers className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'group')} titleFor={(v) => searchTitle(v, 'group')} />
                <TagList label="Characters" items={g.characters ?? g.genres} icon={<Star className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'character')} titleFor={(v) => searchTitle(v, 'character')} />
                {g.series && <TagList label="Series" items={[g.series]} icon={<BookOpen className="h-3 w-3" />} onSearch={(v) => searchFor(v, 'series')} titleFor={(v) => searchTitle(v, 'series')} />}
                <TagGroups key={`${item.source}:${item.galleryId}`} tags={tags} onSearch={(v, ns) => searchFor(v, ns)} titleFor={(v, ns) => searchTitle(v, ns)} />
              </>
            )}

          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-surface p-3 sm:px-5">
          <div className="flex min-w-0 flex-col gap-1">
            <DownloadDestination setup={setup} />
            {downloaded && !inLibrary && <Link to="/downloader?tab=downloads" onClick={onClose} className="inline-flex min-h-11 items-center self-start text-xs text-primary underline underline-offset-4">Manage this gallery in Downloads</Link>}
          </div>
          <div className="ml-auto flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Close</Button>
            {(downloaded || setup.status !== 'missing') && <Button onClick={onDownload} disabled={downloaded || downloading || checking || setup.status !== 'ready'}>
              {downloaded ? <CheckCircle2 className="h-4 w-4" /> : (downloading || checking) ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />}{inLibrary ? 'In library' : downloaded ? 'Downloaded' : checking ? 'Checking…' : downloading ? 'In Downloads' : 'Download'}
            </Button>}
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Queue row ----------------

/**
 * Cover for a finished download — the first image of the saved file, served
 * locally by /downloads/:id/cover. Stretches to the full height of its row so
 * completed downloads are identifiable at a glance; lazy-loaded and hidden
 * when the file is gone or holds no image, so rows never show a broken
 * placeholder.
 */
