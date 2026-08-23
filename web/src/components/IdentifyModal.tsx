import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, AlertTriangle, Check, X, ArrowRight, Link2, Unlink } from 'lucide-react';
import {
  api,
  type MatchOutcome,
  type SeriesMetadata,
  type KavitaSeriesMetadata,
  type KavitaTag,
  type KavitaPerson,
  type SeriesMatch,
} from '../lib/api';
import { PROVIDER_NAMES, cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Dialog, DialogContent, Label, ProviderBadge, Spinner } from './ui';

const STATUS_LABELS: Record<number, string> = {
  0: 'Ongoing',
  1: 'Hiatus',
  2: 'Completed',
  3: 'Cancelled',
  4: 'Ended',
};

/** Maps the unified provider status onto Kavita's publicationStatus value. */
const CANDIDATE_STATUS: Record<string, number | null> = {
  ONGOING: 0,
  HIATUS: 1,
  COMPLETED: 2,
  CANCELLED: 3,
  UNKNOWN: null,
};

interface CurrentKavita {
  name: string;
  sortName?: string;
  metadata: KavitaSeriesMetadata | null;
}

interface IdentifyModalProps {
  seriesId: number;
  current: CurrentKavita;
  /** Existing local match row (from GET /series/:id), if any. */
  match: SeriesMatch | null;
  onClose: () => void;
}

const tagNames = (tags: KavitaTag[] | null | undefined): string =>
  (tags ?? []).map((t) => t.title).filter(Boolean).join(', ');

const peopleNames = (people: KavitaPerson[] | null | undefined): string =>
  (people ?? []).map((p) => p.name).filter(Boolean).join(', ');
/** Mirrors the server's mergeTagLists (server/src/services/sync.ts) so the preview matches what Apply & Sync writes: union of existing + provider tags, deduped case-insensitively, existing spelling wins. */
function mergeTagLists(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...incoming]) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Mirrors the server's releaseYear resolution (year, else releaseDate). */
function candidateYear(meta: SeriesMetadata | undefined, fallbackYear?: number): string {
  if (meta?.year && meta.year >= 1 && meta.year <= 9999) return String(meta.year);
  if (meta?.releaseDate) {
    const y = Number(meta.releaseDate.slice(0, 4));
    if (y >= 1 && y <= 9999) return String(y);
  }
  return fallbackYear ? String(fallbackYear) : '';
}

interface DiffRow {
  label: string;
  current: string;
  candidate: string;
  /** Render the summary with more breathing room. */
  multiline?: boolean;
  /** Syncable field key (server EXCLUDABLE_FIELDS); rows without one are informational only. */
  field?: string;
  /** Tags merge into Kavita's existing tags instead of replacing them (see server mergeTagLists). */
  tagMerge?: { existing: string[]; incoming: string[] };
}

function FieldRow({ row, checked, onToggle }: { row: DiffRow; checked?: boolean; onToggle?: () => void }) {
  const merge = row.tagMerge;
  const differs =
    !merge &&
    row.current.trim() !== '' &&
    row.candidate.trim() !== '' &&
    row.current.trim().toLowerCase() !== row.candidate.trim().toLowerCase();
  // Multiline fields (Summary) are never truncated: full text, wrapping, with an internal scroll for very long descriptions.
  const clamp = row.multiline ? 'max-h-56 overflow-y-auto whitespace-pre-wrap break-words' : 'line-clamp-2';
  const showCheckbox = !!row.field && row.candidate.trim() !== '' && !!onToggle;
  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border py-1.5 text-xs last:border-0">
      <div className="flex min-w-0 items-start gap-1.5">
        {showCheckbox ? (
          <input type="checkbox" checked={!!checked} onChange={onToggle} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-primary)]" />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="w-20 shrink-0 text-muted">{row.label}</span>
        {merge ? (
          <span className="min-w-0 flex-1 break-words" title={row.current}>
            {row.current || '—'}
          </span>
        ) : (
          <span className={cn('min-w-0 flex-1', clamp, differs && 'text-muted line-through')} title={row.current}>
            {row.current || '—'}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-1.5">
        {merge ? (
          <MergedTags existing={merge.existing} incoming={merge.incoming} dimmed={!checked} />
        ) : (
          <span
            className={cn('min-w-0 flex-1 font-medium', clamp, differs && 'text-primary', showCheckbox && !checked && 'text-muted line-through opacity-60')}
            title={row.candidate}
          >
            {row.candidate || '—'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Candidate column for tag rows: existing tags are kept, provider tags are added (highlighted). */
function MergedTags({ existing, incoming, dimmed }: { existing: string[]; incoming: string[]; dimmed?: boolean }) {
  if (incoming.length === 0) return <span className="text-muted">—</span>;
  const merged = mergeTagLists(existing, incoming);
  const kept = new Set(existing.map((t) => t.trim().toLowerCase()).filter(Boolean));
  return (
    <span className={cn('min-w-0 flex-1', dimmed && 'opacity-60')} title="Existing tags are kept; highlighted tags will be added">
      {merged.map((tag, i) => (
        <React.Fragment key={tag}>
          {i > 0 ? ', ' : null}
          <span className={kept.has(tag.toLowerCase()) ? undefined : 'font-medium text-primary'}>{tag}</span>
        </React.Fragment>
      ))}
      {dimmed && <span className="text-muted"> · not synced</span>}
    </span>
  );
}

function CoverThumb({ src, alt, onZoom }: { src?: string | null; alt: string; onZoom?: (src: string, alt: string) => void }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [src]);
  if (!src || failed) return <span className="text-muted">—</span>;
  const img = (
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-[427px] w-80 shrink-0 rounded object-cover" />
  );
  if (!onZoom) return img;
  return (
    <button type="button" title="Click to enlarge" onClick={() => onZoom(src, alt)} className="shrink-0 cursor-zoom-in transition-opacity hover:opacity-90">
      {img}
    </button>
  );
}

/** Thumbnail for candidate rows: falls back to the search icon when the cover is missing or fails to load. */
function CandidateCover({ src }: { src?: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [src]);
  if (!src || failed) return <Search className="h-4 text-muted" />;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />;
}

export function IdentifyModal({ seriesId, current, match, onClose }: IdentifyModalProps) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState('all');
  const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(new Set());
  const [coverEnabled, setCoverEnabled] = React.useState(true);
  const [zoomCover, setZoomCover] = React.useState<{ src: string; alt: string } | null>(null);

  // A fresh selection starts with every syncable field opted in.
  React.useEffect(() => {
    setExcluded(new Set());
    setCoverEnabled(true);
  }, [selectedId]);

  const identify = useQuery({
    queryKey: ['identify', seriesId],
    queryFn: () => api.identify(seriesId),
    staleTime: 60_000,
  });

  const apply = useMutation({
    mutationFn: (p: { providerId: string; providerSeriesId: string; excludedFields?: string[]; cover?: boolean; score?: number }) =>
      api.apply(seriesId, p.providerId, p.providerSeriesId, { excludedFields: p.excludedFields, cover: p.cover, score: p.score }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      qc.invalidateQueries({ queryKey: ['library-series'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['libraries'] });
      onClose();
    },
  });

  const unmatch = useMutation({
    mutationFn: () => api.unmatch(seriesId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      qc.invalidateQueries({ queryKey: ['library-series'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['libraries'] });
      toast({ tone: 'success', title: res.removed ? 'Unmatched' : 'No match to remove', description: current.name });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Unmatch failed', description: e instanceof Error ? e.message : String(e) }),
  });

  const outcome: MatchOutcome | undefined = identify.data;
  const selected = outcome?.candidates.find((c) => c.providerId + ':' + c.providerSeriesId === selectedId);
  const autoBest = outcome?.best;

  // One tab per provider that was searched or returned candidates (search order).
  const tabProviders = React.useMemo(() => {
    if (!outcome) return [] as string[];
    const ids = [...outcome.searchedProviders];
    for (const c of outcome.candidates) if (!ids.includes(c.providerId)) ids.push(c.providerId);
    return ids;
  }, [outcome]);
  const visibleCandidates = React.useMemo(() => {
    if (!outcome) return [];
    return tab === 'all' ? outcome.candidates : outcome.candidates.filter((c) => c.providerId === tab);
  }, [outcome, tab]);

  // Full aggregated metadata for the selected candidate — fetched through the
  // same path Apply & Sync uses, so the diff previews exactly what will push.
  const preview = useQuery({
    queryKey: ['identify-preview', selected?.providerId, selected?.providerSeriesId],
    queryFn: () => api.providerMetadata(selected!.providerId, selected!.providerSeriesId),
    enabled: !!selected,
  });

  const k = current.metadata;

  const diff = React.useMemo(() => {
    if (!selected) return null;
    const m = preview.data;
    const candStatus = m?.status != null ? (CANDIDATE_STATUS[m.status] ?? null) : null;
    const rows: DiffRow[] = [
      { label: 'Title', current: current.name, candidate: m?.title ?? selected.title, field: 'title' },
      { label: 'Sort title', current: current.sortName ?? '', candidate: m?.sortTitle ?? '', field: 'sortTitle' },
      {
        label: 'Year',
        current: k && k.releaseYear > 0 ? String(k.releaseYear) : '',
        candidate: candidateYear(m, selected.year),
        field: 'releaseDate',
      },
      {
        label: 'Summary',
        current: k?.summary ?? '',
        candidate: m?.summary ?? selected.summary ?? '',
        multiline: true,
        field: 'summary',
      },
      { label: 'Genres', current: tagNames(k?.genres), candidate: m ? m.genres.join(', ') : '', field: 'genres' },
      { label: 'Tags', current: tagNames(k?.tags), candidate: m ? m.tags.join(', ') : '', field: 'tags', tagMerge: { existing: (k?.tags ?? []).map((t) => t.title).filter((t): t is string => Boolean(t)), incoming: m?.tags ?? [] } },
      { label: 'Writers', current: peopleNames(k?.writers), candidate: m ? m.writers.join(', ') : '', field: 'writers' },
      // H-Tosho writes provider artists into Kavita's penciller role.
      { label: 'Artists', current: peopleNames(k?.pencillers), candidate: m ? m.artists.join(', ') : '', field: 'artists' },
      { label: 'Publishers', current: peopleNames(k?.publishers), candidate: m ? m.publishers.join(', ') : '', field: 'publishers' },
      { label: 'Language', current: k?.language ?? '', candidate: m?.language ?? '', field: 'language' },
      {
        label: 'Status',
        current: k ? (STATUS_LABELS[k.publicationStatus] ?? '') : '',
        candidate: candStatus != null ? (STATUS_LABELS[candStatus] ?? '') : '',
        field: 'status',
      },
      { label: 'URL', current: k?.webLinks ?? '', candidate: m?.url ?? '', field: 'url' },
    ];
    return { rows, coverCandidate: m?.coverUrl ?? selected.coverUrl };
  }, [selected, preview.data, current, k]);

  const doApply = (ids: { providerId: string; providerSeriesId: string }, opts?: { excludedFields?: string[]; cover?: boolean; score?: number }) => {
    apply.mutate({ ...ids, ...opts });
  };

  return (
    <>
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <div className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Identify "{current.name}"</h2>
          </div>

          {match?.providerId && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-2 bg-surface-2 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <Link2 className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    Matched to {PROVIDER_NAMES[match.providerId] ?? match.providerId}
                    {typeof match.matchScore === 'number' && ` · ${Math.round(match.matchScore * 100)}%`}
                  </p>
                  <p className="text-xs text-muted">Unmatching removes the link only — metadata already pushed to Kavita stays in place.</p>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => unmatch.mutate()} disabled={unmatch.isPending}>
                {unmatch.isPending ? <Spinner /> : <Unlink className="h-3.5 w-3.5" />} Unmatch
              </Button>
            </div>
          )}

          {identify.isPending && (
            <div className="flex items-center gap-2 py-8 text-muted">
              <Spinner /> Searching providers…
            </div>
          )}

          {identify.isError && (
            <div className="flex items-center gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
              <AlertTriangle className="h-4 w-4" />
              {identify.error instanceof Error ? identify.error.message : String(identify.error)}
            </div>
          )}

          {outcome && (
            <>
              {outcome.matched && autoBest && (
                <div className="flex animate-fade-up flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/10 p-3">
                  <div className="flex items-center gap-3">
                    <Check className="h-4 w-4 text-success" />
                    <div>
                      <p className="text-sm font-medium">
                        Auto-matched to {PROVIDER_NAMES[autoBest.providerId] ?? autoBest.providerId} · {Math.round(autoBest.score * 100)}%
                      </p>
                      <p className="text-xs text-muted">{autoBest.title}</p>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => doApply({ providerId: autoBest.providerId, providerSeriesId: autoBest.providerSeriesId }, { score: autoBest.score })} disabled={apply.isPending}>
                    {apply.isPending ? <Spinner /> : <ArrowRight className="h-3.5 w-3.5" />} Apply & Sync
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setTab('all')}
                  className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors', tab === 'all' ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                >
                  All ({outcome.candidates.length})
                </button>
                {tabProviders.map((id) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors', tab === id ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                  >
                    {PROVIDER_NAMES[id] ?? id} ({outcome.candidates.filter((c) => c.providerId === id).length})
                  </button>
                ))}
              </div>

              <div className="max-h-[38vh] overflow-y-auto rounded-md border border-border">
                {visibleCandidates.length === 0 && (
                  <p className="p-4 text-sm text-muted">{tab === 'all' ? 'No candidates found across providers.' : `No candidates from ${PROVIDER_NAMES[tab] ?? tab}.`}</p>
                )}
                {visibleCandidates.map((c) => {
                  const key = c.providerId + ':' + c.providerSeriesId;
                  const isSelected = selectedId === key;
                  const isBest = autoBest?.providerId === c.providerId && autoBest?.providerSeriesId === c.providerSeriesId;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedId(key)}
                      className={cn('flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-0 transition-colors hover:bg-surface-2', isSelected && 'bg-surface-2')}
                    >
                      <div
                        className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2"
                        style={{ border: isSelected ? '1px solid var(--color-primary)' : '1px solid var(--color-border)' }}
                      >
                        <CandidateCover src={c.coverUrl} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <ProviderBadge id={c.providerId} />
                          {isBest && <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">Best</span>}
                          {c.year && <span className="text-xs text-muted">{c.year}</span>}
                        </div>
                        <p className="mt-1 truncate text-sm font-medium">{c.title}</p>
                        {c.summary && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{c.summary}</p>}
                      </div>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>

              {selected && diff && (
                <div className="rounded-md border border-border">
                  {/* Mirrors the row grid so each header label sits above its column. */}
                  <div className="grid grid-cols-2 gap-2 border-b border-border px-3 py-2 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="w-3.5 shrink-0" />
                      <span className="w-20 shrink-0" />
                      <span className="font-semibold text-muted">Current (Kavita)</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 font-semibold text-primary">
                      {PROVIDER_NAMES[selected.providerId] ?? selected.providerId} (candidate)
                      {preview.isPending && <Spinner />}
                    </div>
                  </div>
                  {preview.isError && (
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-danger">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Couldn't load candidate metadata: {preview.error instanceof Error ? preview.error.message : String(preview.error)}
                    </div>
                  )}
                  <div className="max-h-[40vh] overflow-y-auto px-3">
                    {diff.rows.map((row) => (
                      <FieldRow
                        key={row.label}
                        row={row}
                        checked={!excluded.has(row.field ?? '')}
                        onToggle={
                          row.field
                            ? () =>
                                setExcluded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(row.field!)) next.delete(row.field!);
                                  else next.add(row.field!);
                                  return next;
                                })
                            : undefined
                        }
                      />
                    ))}
                    <div className="grid grid-cols-2 gap-2 py-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="w-3.5 shrink-0" />
                        <span className="w-20 shrink-0 text-muted">Cover</span>
                        <CoverThumb src={`/api/kavita/series/${seriesId}/cover`} alt="Current cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input type="checkbox" checked={coverEnabled} onChange={(e) => setCoverEnabled(e.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-[var(--color-primary)]" />
                        <CoverThumb src={diff.coverCandidate} alt="Candidate cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                        {!coverEnabled && <span className="text-muted">not synced</span>}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button
                  onClick={() => selected && doApply({ providerId: selected.providerId, providerSeriesId: selected.providerSeriesId }, { excludedFields: [...excluded], cover: coverEnabled, score: selected.score })}
                  disabled={!selected || apply.isPending}
                >
                  {apply.isPending ? <Spinner /> : <ArrowRight className="h-4 w-4" />} Apply & Sync to Kavita
                </Button>
              </div>

              {apply.isError && (
                <div className="flex items-center gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
                  <AlertTriangle className="h-4 w-4" />
                  {apply.error instanceof Error ? apply.error.message : String(apply.error)}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={!!zoomCover} onOpenChange={(o) => { if (!o) setZoomCover(null); }}>
      {zoomCover && (
        <DialogContent className="flex max-w-none items-center justify-center p-0">
          <img src={zoomCover.src} alt={zoomCover.alt} className="max-h-[85vh] w-auto rounded-lg object-contain" />
        </DialogContent>
      )}
    </Dialog>
    </>
  );
}
