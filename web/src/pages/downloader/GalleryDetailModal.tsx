import { formatDate, Cover, SourceBadge } from './GalleryCard';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Loader2, Download as DownloadIcon, RotateCcw, CheckCircle2, Languages, X, ExternalLink, BookOpen, Users, Layers, Star, Tags } from 'lucide-react';
import { api, type DoujinSource, type DoujinSearchResult } from '../../lib/api';
import { useGalleryDownloadTask } from '../../lib/DownloadsContext';
import { buildTagSearchFragment, cn } from '../../lib/utils';
import { Button, Badge, Spinner, Dialog, DialogContent, DialogTitle } from '../../components/ui';
import { PagePreview } from '../../components/PagePreview';

import { SOURCE_LABELS, type DownloadSetup } from './state';
/** Galleries per page, matching both official search APIs. */
import { DownloadDestination, DownloadFailure } from './DownloadSetup';
/** One neutral chip style: the group heading names the kind, so hue carries no meaning. */
const TAG_CHIP_STYLE = 'bg-surface-2 text-foreground';

function TagList({ label, items, namespaces, icon, onSearch, titleFor }: {
  label: string;
  items?: string[];
  /** Per-item search namespace (parallel to `items`). */
  namespaces?: (string | null)[];
  icon?: React.ReactNode;
  onSearch?: (value: string, ns?: string | null) => void;
  /** Tooltip for a searchable item — show the exact query it will run. */
  titleFor?: (value: string, ns?: string | null) => string | undefined;
}) {
  if (!items?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        {icon} {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t, i) => {
          const ns = namespaces?.[i];
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSearch?.(t, ns)}
              title={titleFor ? titleFor(t, ns) : onSearch ? `Search for “${t}”` : undefined}
              className={cn(
                'max-lg:min-h-11 pointer-coarse:min-h-11 rounded-full px-2.5 py-1 text-xs transition-all',
                TAG_CHIP_STYLE,
                onSearch && 'cursor-pointer hover:bg-border',
              )}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-surface-2/50 px-3 py-2">
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export function GalleryDetailModal({ item, onClose, onDownload, checking, downloaded, inLibrary, setup, onSearchTag, variants, selectedVariantKey, onSelectVariant }: { item: DoujinSearchResult; onClose: () => void; onDownload: () => void; checking: boolean; downloaded: boolean; inLibrary: boolean; setup: DownloadSetup; onSearchTag: (fragment: string, source?: DoujinSource) => void; variants?: { item: DoujinSearchResult; position?: number }[]; selectedVariantKey?: string; onSelectVariant?: (item: DoujinSearchResult) => void }) {
  const downloading = !!useGalleryDownloadTask(item.source, item.galleryId);
  const { data: gallery, isPending, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['doujin-gallery', item.source, item.galleryId],
    queryFn: () => api.doujinGallery(item.source, item.galleryId),
    staleTime: 5 * 60_000 });
  const g = gallery;
  const previewPages = g?.previewPages ?? [];

  /** Search a single tag/artist value (from the details card) on this source. */
  const searchFor = (value: string, ns?: string | null) => {
    const fragment = buildTagSearchFragment(value, ns, item.source);
    if (fragment) onSearchTag(fragment, item.source);
  };
  /** Tooltip showing the exact query a pill will run. */
  const searchTitle = (value: string, ns?: string | null) => {
    const fragment = buildTagSearchFragment(value, ns, item.source);
    return fragment ? `Search for “${fragment}”` : undefined;
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[min(98vw,1760px)]" aria-describedby={undefined}>
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="grid min-h-0 gap-4 overflow-y-auto p-3 sm:p-5 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-5">
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:self-start">
            <div className="min-w-0 pr-10">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <SourceBadge source={item.source} />
                {g?.language && <Badge tone="info"><Languages className="h-3 w-3" /> {g.language}</Badge>}
              </div>
              <DialogTitle className="break-words text-lg leading-snug">{g?.title ?? item.title}</DialogTitle>
            </div>

            {isPending && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted">
                <Spinner /> Loading gallery details…
              </div>
            )}

            {isError && (
              <div className="space-y-2" role="alert">
                <p className="text-sm font-medium">Could not load gallery details</p>
                <DownloadFailure message={error instanceof Error ? error.message : String(error)} />
                <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}><RotateCcw className="h-3.5 w-3.5" />{isFetching ? 'Retrying…' : 'Retry details'}</Button>
              </div>
            )}

          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:col-start-1 lg:row-start-1 lg:row-span-2">
            {previewPages.length > 0 ? (
              <PagePreview key={`${item.source}:${item.galleryId}`} pages={previewPages} fallbacks={g?.previewFallbacks} name={g?.title ?? item.title} />
            ) : (
              <Cover url={g?.coverUrl ?? item.coverUrl} title={item.title} className="mx-auto aspect-[3/4] w-40 rounded-md border border-border lg:w-48" />
            )}
            {g?.url && (
              <a href={g.url} target="_blank" rel="noreferrer" className="inline-flex max-lg:min-h-11 pointer-coarse:min-h-11 items-center gap-1.5 self-start text-xs text-muted transition-colors hover:text-primary">
                <ExternalLink className="h-3 w-3" /> View on {SOURCE_LABELS[item.source]}
              </a>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-2 lg:self-start">
            {g && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetaItem label="Pages" value={g.pageCount ? `${g.pageCount} pages` : null} />
                  <MetaItem label="Language" value={g.language} />
                  <MetaItem label="Uploaded" value={formatDate(g.uploadedAt ?? item.uploadedAt)} />
                  <MetaItem label="Gallery ID" value={g.galleryId} />
                </div>

                {/* Unified search: the same work found on several sources.
                    Choosing a variant re-targets metadata, preview, link and
                    download at that concrete gallery. */}
                {variants && variants.length > 1 && (
                  <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Available from">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <ExternalLink className="h-3 w-3" /> Available from
                    </p>
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
                                  {position ? `Position #${position} on ${SOURCE_LABELS[v.source]}` : `Found on ${SOURCE_LABELS[v.source]}`}
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
                {g.series && (
                  <div className="flex flex-col gap-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                      <BookOpen className="h-3 w-3" /> Series
                    </p>
                    <button
                      type="button"
                      onClick={() => searchFor(g.series ?? '', 'series')}
                      title={searchTitle(g.series ?? '', 'series')}
                      className="max-lg:min-h-11 pointer-coarse:min-h-11 w-fit cursor-pointer rounded-full bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-700 transition-all hover:brightness-125 dark:bg-cyan-400/20 dark:text-cyan-300"
                    >
                      {g.series}
                    </button>
                  </div>
                )}
                {g.tags?.length ? (
                  <TagList label={`Tags (${g.tags.length})`} items={g.tags} namespaces={g.tagNamespaces} icon={<Tags className="h-3 w-3" />} onSearch={(v, ns) => searchFor(v, ns)} titleFor={(v, ns) => searchTitle(v, ns)} />
                ) : null}

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
              {downloaded ? <CheckCircle2 className="h-4 w-4" /> : (downloading || checking) ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />}{inLibrary ? 'In library' : downloaded ? 'Downloaded' : checking ? 'Checking…' : downloading ? 'Queued / downloading' : 'Download'}
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
