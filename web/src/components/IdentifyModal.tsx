import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, AlertTriangle, Check, X, ArrowRight, Link2, Unlink, History, RefreshCw, ChevronRight } from 'lucide-react';
import {
  api,
  type MatchCandidate,
  type MatchOutcome,
  type SeriesMetadata,
  type KavitaSeriesMetadata,
  type KavitaTag,
  type KavitaPerson,
  type SeriesMatch,
} from '../lib/api';
import { PROVIDER_NAMES, cn, timeAgo } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, ProviderBadge, Spinner, ConfirmDialog } from './ui';

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

const HISTORY_TONE: Record<string, string> = {
  matched: 'bg-success/15 text-success',
  updated: 'bg-info/15 text-info',
  failed: 'bg-danger/15 text-danger',
  unmatched: 'bg-surface-2 text-muted',
  cleared: 'bg-surface-2 text-muted',
  cover: 'bg-warning/15 text-warning',
};

/** Flatten a history row's details object into a short readable line. */
function detailsText(details: Record<string, unknown> | null): string {
  if (!details) return '';
  return Object.entries(details)
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(', ') : typeof v === 'number' && k === 'score' ? Math.round(v * 100) + '%' : String(v);
      return val === '' || val === 'undefined' || val === 'null' ? null : `${k}: ${val}`;
    })
    .filter((s): s is string => s !== null)
    .join(' · ');
}

interface CurrentKavita {
  name: string;
  metadata: KavitaSeriesMetadata | null;
}

interface IdentifyModalProps {
  seriesId: number;
  current: CurrentKavita;
  /** Existing local match row (from GET /series/:id), if any. */
  match: SeriesMatch | null;
  currentCover?: string | null;
  onCoverApplied: (coverUrl: string, jobId: number) => void;
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
  /** Candidate is empty and syncing will clear the current value. */
  clearing?: boolean;
  /** Syncable field key (server EXCLUDABLE_FIELDS); rows without one are informational only. */
  field?: string;
  /** Tags merge into Kavita's existing tags instead of replacing them (see server mergeTagLists). */
  tagMerge?: { existing: string[]; incoming: string[] };
  /** Comma-joined values compared as sets — order differences are not drift. */
  list?: boolean;
  /** Render the value as clickable links (URL row). */
  link?: boolean;
}

/** List fields compare order-insensitively, ignoring punctuation placement ("Girl's Love" vs "Girls' Love"). */
const listKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const listParts = (s: string) => s.split(',').map(listKey).filter(Boolean);

function computeDiffers(row: DiffRow): boolean {
  const a = row.current.trim();
  const b = row.candidate.trim();
  if (row.clearing) return !!a;
  if (!a || !b) return false;
  if (row.list) {
    const pa = listParts(a);
    const pb = listParts(b);
    if (pa.length !== pb.length) return true;
    const sa = new Set(pa);
    return !pb.every((p) => sa.has(p));
  }
  return a.toLowerCase() !== b.toLowerCase();
}

/** URL values render as clickable links (Kavita webLinks may hold several, newline/comma separated). */
function UrlValue({ text, className }: { text: string; className?: string }) {
  const urls = text.split(/[\n,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (urls.length === 0) return <span>{text || '—'}</span>;
  return (
    <>
      {urls.map((u, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ', ' : null}
          <a href={u} target="_blank" rel="noopener noreferrer" className={cn('underline decoration-dotted underline-offset-2 hover:decoration-solid', className)}>
            {u}
          </a>
        </React.Fragment>
      ))}
    </>
  );
}

/** Label column (fixed width) + two equal-width value columns: Kavita on the left, candidate on the right. */
const ROW_GRID = 'grid grid-cols-1 items-start gap-1 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-3';

function FieldRow({ row, checked, onToggle }: { row: DiffRow; checked?: boolean; onToggle?: () => void }) {
  const merge = row.tagMerge;
  const differs = !merge && computeDiffers(row);
  // Multiline fields (Summary) are never truncated: full text, wrapping, with an internal scroll for very long descriptions.
  const valueCls = row.multiline ? 'min-w-0 max-h-56 overflow-y-auto whitespace-pre-wrap break-words' : 'min-w-0 whitespace-pre-wrap break-words';
  const showCheckbox = !!row.field && (row.candidate.trim() !== '' || row.clearing) && !!onToggle;
  return (
    <div className={cn(ROW_GRID, 'border-b border-border py-2 last:border-0', differs ? 'bg-warning/5' : 'transition-colors hover:bg-surface-2/40')}>
      <div className="flex min-w-0 items-start gap-1.5">
        {showCheckbox ? (
          <label className="flex min-h-9 cursor-pointer items-center gap-2 py-1 text-xs font-medium uppercase tracking-wider text-muted">
            <input type="checkbox" checked={!!checked} onChange={onToggle} className="h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
            {row.label}
          </label>
        ) : (
          <span className="min-h-9 py-3 text-xs font-medium uppercase tracking-wider text-muted">{row.label}</span>
        )}
      </div>
      {merge ? (
        <div className={cn(valueCls, 'min-h-8 text-sm')} title={row.current}>
          {row.link ? <UrlValue text={row.current} /> : row.current || '—'}
        </div>
      ) : (
        <div className={cn(valueCls, 'min-h-8 text-sm', differs && 'text-muted line-through')} title={row.current}>
          {row.link ? <UrlValue text={row.current} /> : row.current || '—'}
        </div>
      )}
      {merge ? (
        <div className="min-w-0 text-sm">
          <MergedTags existing={merge.existing} incoming={merge.incoming} dimmed={!checked} />
        </div>
      ) : row.clearing ? (
        <div className={cn(valueCls, 'min-h-8 text-sm')}>
          <span className="text-primary">Will be cleared</span>
          <span className="text-muted"> — the provider's summary contains only the tag list.</span>
        </div>
      ) : (
        <div
          className={cn(valueCls, 'min-h-8 text-sm', differs && 'text-primary', showCheckbox && !checked && 'text-muted line-through opacity-60')}
          title={row.candidate}
        >
          {row.link ? <UrlValue text={row.candidate} className="text-primary" /> : row.candidate || '—'}
        </div>
      )}
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
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="max-h-[55vh] w-full max-w-80 shrink-0 rounded object-cover sm:h-[427px]" />
  );
  if (!onZoom) return img;
  return (
    <button type="button" aria-label={`Enlarge ${alt}`} onClick={() => onZoom(src, alt)} className="shrink-0 cursor-zoom-in transition-opacity hover:opacity-90">
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
export function IdentifyModal({ seriesId, current, match, currentCover, onCoverApplied, onClose }: IdentifyModalProps) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [manualUrl, setManualUrl] = React.useState('');
  const [manualCandidate, setManualCandidate] = React.useState<MatchCandidate | null>(null);
  const [selectedTitle, setSelectedTitle] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState('all');
  const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(new Set());
  const [coverEnabled, setCoverEnabled] = React.useState(true);
  const [zoomCover, setZoomCover] = React.useState<{ src: string; alt: string } | null>(null);

  const [confirmUnmatch, setConfirmUnmatch] = React.useState(false);
  // A fresh selection starts with every syncable field opted in.
  React.useEffect(() => {
    setExcluded(new Set());
    setCoverEnabled(true);
    setSelectedTitle(null);
  }, [selectedId]);

  const identify = useQuery({
    queryKey: ['identify', seriesId],
    queryFn: () => api.identify(seriesId),
    staleTime: 60_000,
  });

  // Identification can update the saved confidence score even before applying.
  React.useEffect(() => {
    if (!identify.dataUpdatedAt) return;
    void qc.invalidateQueries({ queryKey: ['low-confidence'] });
    void qc.invalidateQueries({ queryKey: ['library-series'] });
    void qc.invalidateQueries({ queryKey: ['series', seriesId] });
  }, [identify.dataUpdatedAt, qc, seriesId]);


  const apply = useMutation({
    mutationFn: (p: { providerId: string; providerSeriesId: string; selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number; coverUrl?: string }) =>
      api.apply(seriesId, p.providerId, p.providerSeriesId, { selectedTitle: p.selectedTitle, excludedFields: p.excludedFields, cover: p.cover, score: p.score }),
    onSuccess: (job, variables) => {
      // The sync itself runs in the background. The Libraries page keeps this
      // provider cover pinned until this specific job settles, so its polling
      // cannot overwrite the optimistic image with Kavita's old cover.
      const optimisticCover = variables.cover !== false ? variables.coverUrl : undefined;
      if (optimisticCover) onCoverApplied(optimisticCover, job.id);
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'success', title: 'Sync queued', description: 'Apply & Sync runs in the background — progress shows in the sidebar.' });
      onClose();
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue sync', description: e instanceof Error ? e.message : String(e) }),
  });

  const resolveManual = useMutation({
    mutationFn: () => api.manualMatch(seriesId, manualUrl),
    onSuccess: (candidate) => {
      setManualCandidate(candidate);
      setSelectedId(candidate.providerId + ':' + candidate.providerSeriesId);
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not load provider URL', description: e instanceof Error ? e.message : String(e) }),
  });

  const unmatch = useMutation({
    mutationFn: () => api.unmatch(seriesId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      qc.invalidateQueries({ queryKey: ['library-series'] });
      qc.invalidateQueries({ queryKey: ['libraries'] });
      qc.invalidateQueries({ queryKey: ['low-confidence'] });
      setConfirmUnmatch(false);
      toast({ tone: 'success', title: res.removed ? 'Unmatched' : 'No match to remove', description: current.name });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Unmatch failed', description: e instanceof Error ? e.message : String(e) }),
  });

  const outcome: MatchOutcome | undefined = identify.data;
  const candidates = React.useMemo(() => {
    const found = outcome?.candidates ?? [];
    if (!manualCandidate) return found;
    const key = manualCandidate.providerId + ':' + manualCandidate.providerSeriesId;
    return [manualCandidate, ...found.filter((c) => c.providerId + ':' + c.providerSeriesId !== key)];
  }, [outcome, manualCandidate]);
  const selected = candidates.find((c) => c.providerId + ':' + c.providerSeriesId === selectedId);
  const autoBest = outcome?.best;

  // One tab per provider that was searched or returned candidates (search order).
  const tabProviders = React.useMemo(() => {
    if (!outcome) return [] as string[];
    const ids = [...outcome.searchedProviders];
    for (const c of candidates) if (!ids.includes(c.providerId)) ids.push(c.providerId);
    return ids;
  }, [outcome, candidates]);
  const visibleCandidates = React.useMemo(() => {
    return tab === 'all' ? candidates : candidates.filter((c) => c.providerId === tab);
  }, [candidates, tab]);

  // Full aggregated metadata for the selected candidate — fetched through the
  // same path Apply & Sync uses, so the diff previews exactly what will push.
  const preview = useQuery({
    queryKey: ['identify-preview', selected?.providerId, selected?.providerSeriesId],
    queryFn: () => api.providerMetadata(selected!.providerId, selected!.providerSeriesId),
    enabled: !!selected,
  });
  const resolvedTitle = selectedTitle ?? selected?.title ?? preview.data?.title ?? '';

  const history = useQuery({
    queryKey: ['series-history', seriesId],
    queryFn: () => api.seriesHistory(seriesId),
    staleTime: 60_000,
  });
  // One expanded history row at a time; the raw detail dump stays out of the way.
  const [openHistory, setOpenHistory] = React.useState<number | null>(null);

  const k = current.metadata;

  const diff = React.useMemo(() => {
    if (!selected) return null;
    const m = preview.data;
    const candStatus = m?.status != null ? (CANDIDATE_STATUS[m.status] ?? null) : null;
    const rows: DiffRow[] = [
      { label: 'Title', current: current.name, candidate: resolvedTitle, field: 'title' },
      {
        label: 'Year',
        current: k && k.releaseYear > 0 ? String(k.releaseYear) : '',
        candidate: candidateYear(m, selected.year),
        field: 'releaseDate',
      },
      {
        label: 'Summary',
        current: k?.summary ?? '',
        // Fall back to the raw search summary only while the full preview is
        // still loading; once loaded, an empty candidate means the provider's
        // description was tag blocks only and the summary will be cleared.
        candidate: m ? (m.summary ?? '') : (selected.summary ?? ''),
        multiline: true,
        field: 'summary',
        clearing: !!m && m.summary === '' && Boolean((k?.summary ?? '').trim()),
      },
      { label: 'Genres', current: tagNames(k?.genres), candidate: m ? m.genres.join(', ') : '', field: 'genres', list: true },
      { label: 'Tags', current: tagNames(k?.tags), candidate: m ? m.tags.join(', ') : '', field: 'tags', tagMerge: { existing: (k?.tags ?? []).map((t) => t.title).filter((t): t is string => Boolean(t)), incoming: m?.tags ?? [] } },
      { label: 'Writers', current: peopleNames(k?.writers), candidate: m ? m.writers.join(', ') : '', field: 'writers', list: true },
      // H-Tosho writes provider artists into Kavita's penciller role.
      { label: 'Artists', current: peopleNames(k?.pencillers), candidate: m ? m.artists.join(', ') : '', field: 'artists', list: true },
      { label: 'Language', current: k?.language ?? '', candidate: m?.language ?? '', field: 'language' },
      {
        label: 'Status',
        current: k ? (STATUS_LABELS[k.publicationStatus] ?? '') : '',
        candidate: candStatus != null ? (STATUS_LABELS[candStatus] ?? '') : '',
        field: 'status',
      },
      { label: 'URL', current: k?.webLinks ?? '', candidate: m?.url ?? '', field: 'url', link: true },
    ];
    return { rows, coverCandidate: m?.coverUrl ?? selected.coverUrl };
  }, [selected, preview.data, resolvedTitle, current, k]);

  const doApply = (ids: { providerId: string; providerSeriesId: string }, opts?: { selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number; coverUrl?: string }) => {
    apply.mutate({ ...ids, ...opts });
  };

  return (
    <>
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[min(96vw,1440px)]">
        <div className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start gap-2 pr-10">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <DialogTitle>Identify “{current.name}”</DialogTitle>
              <DialogDescription>Choose a metadata match and review exactly what will be synced to Kavita.</DialogDescription>
            </div>
          </div>

          {!selected && match?.providerId && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-2 bg-surface-2 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <Link2 className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    Matched to {PROVIDER_NAMES[match.providerId] ?? match.providerId}
                    {typeof match.matchScore === 'number' && ` · ${Math.round(match.matchScore * 100)}%`}
                    {match.aligned ? (
                      <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-2xs font-medium text-success">Aligned</span>
                    ) : (
                      <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">Not aligned</span>
                    )}
                  </p>
                  <p className="text-sm text-muted">Unmatching removes the link and removes metadata and covers previously applied by H-Tosho.</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {match.providerSeriesId && (
                  <Button size="sm" variant="secondary" onClick={() => doApply({ providerId: match.providerId!, providerSeriesId: match.providerSeriesId! })} disabled={apply.isPending} title="Re-push this provider's metadata to Kavita">
                    {apply.isPending ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Sync
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => setConfirmUnmatch(true)} disabled={unmatch.isPending}>
                  <Unlink className="h-3.5 w-3.5" /> Unmatch
                </Button>
              </div>
            </div>
          )}

          {history.data && history.data.length > 0 && (
            <div className="rounded-lg border border-border-2 bg-surface-2 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                <History className="h-3.5 w-3.5" /> History
              </p>
              <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                {history.data.map((h) => (
                  <div key={h.id}>
                    <button type="button" onClick={() => setOpenHistory(openHistory === h.id ? null : h.id)} aria-expanded={openHistory === h.id} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs transition-colors duration-150 hover:bg-surface/70">
                      <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium', HISTORY_TONE[h.action] ?? 'bg-surface-2 text-muted')}>{h.action}</span>
                      <span className="min-w-0 flex-1 truncate text-muted">{detailsText(h.details) || '—'}</span>
                      <span className="shrink-0 text-2xs tabular-nums text-muted">{timeAgo(h.createdAt)}</span>
                      <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted transition-transform duration-150', openHistory === h.id && 'rotate-90')} />
                    </button>
                    {openHistory === h.id && detailsText(h.details) && (
                      <p className="mb-1 break-words px-1 pb-1 text-xs leading-relaxed text-muted">{detailsText(h.details)}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!selected && identify.isPending && (
            <div className="flex items-center gap-2 py-8 text-muted">
              <Spinner /> Searching providers…
            </div>
          )}

          {!selected && identify.isError && (
            <div className="flex items-center gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
              <AlertTriangle className="h-4 w-4" />
              {identify.error instanceof Error ? identify.error.message : String(identify.error)}
            </div>
          )}

          {outcome && (
            <>
              {!selected && outcome.matched && autoBest && (
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
                  <Button
                    size="sm"
                    onClick={() => autoBest.providerId === 'mangadex'
                      ? setSelectedId(autoBest.providerId + ':' + autoBest.providerSeriesId)
                      : doApply({ providerId: autoBest.providerId, providerSeriesId: autoBest.providerSeriesId }, { score: autoBest.score, coverUrl: autoBest.coverUrl })}
                    disabled={apply.isPending}
                  >
                    {apply.isPending ? <Spinner /> : <ArrowRight className="h-3.5 w-3.5" />} {autoBest.providerId === 'mangadex' ? 'Choose Title & Sync' : 'Apply & Sync'}
                  </Button>
                </div>
              )}

              {!selected && (
                <form
                  className="rounded-lg border border-border-2 bg-surface-2 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (manualUrl.trim()) resolveManual.mutate();
                  }}
                >
                  <Label htmlFor="manual-provider-url">Match by provider URL</Label>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="manual-provider-url"
                      type="url"
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                      placeholder="Paste a MangaDex, MyAnimeList, or AniList series URL"
                      autoComplete="off"
                    />
                    <Button type="submit" variant="outline" disabled={!manualUrl.trim() || resolveManual.isPending}>
                      {resolveManual.isPending ? <Spinner /> : <Link2 className="h-4 w-4" />} Load
                    </Button>
                  </div>
                </form>
              )}

              {!selected && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setTab('all')}
                  className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors', tab === 'all' ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                >
                  All ({candidates.length})
                </button>
                {tabProviders.map((id) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors', tab === id ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                  >
                    {PROVIDER_NAMES[id] ?? id} ({candidates.filter((c) => c.providerId === id).length})
                  </button>
                ))}
              </div>)}
              {!selected && outcome.errors && Object.keys(outcome.errors).length > 0 && (
                <p className="text-xs text-warning">
                  {Object.entries(outcome.errors)
                    .map(([id, msg]) => `${PROVIDER_NAMES[id] ?? id}: ${msg}`)
                    .join(' · ')}
                </p>
              )}

              {!selected && (
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
                          {isBest && <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-2xs font-medium text-success">Best</span>}
                          {c.year && <span className="text-xs text-muted">{c.year}</span>}
                        </div>
                        <p className="mt-1 truncate text-sm font-medium">{c.title}</p>
                        {c.summary && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{c.summary}</p>}
                      </div>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>)}

              {selected && diff && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <ProviderBadge id={selected.providerId} />
                    <span className="font-medium">{selected.title}</span>
                    <span className="text-xs text-muted">{Math.round(selected.score * 100)}% match</span>
                  </div>
                  {(preview.data?.titleOptions?.length ?? 0) > 1 && (
                    <div className="rounded-md border border-border bg-surface-2 p-3">
                      <Label htmlFor="provider-title-choice">Series name written to every chapter's ComicInfo.xml</Label>
                      <select
                        id="provider-title-choice"
                        value={resolvedTitle}
                        onChange={(e) => setSelectedTitle(e.target.value)}
                        className="mt-2 flex h-9 w-full rounded-md border border-border-2 bg-surface px-3 text-sm"
                      >
                        {preview.data!.titleOptions!.map((title) => <option key={title} value={title}>{title}</option>)}
                      </select>
                      <p className="mt-1 text-xs text-muted">Applying the title rewrites the Series field in every CBZ, then requests a Kavita rescan.</p>
                    </div>
                  )}
                  <div className="rounded-md border border-border">
                  {/* Mirrors the row grid so each header label sits above its column. */}
                  <div className={cn(ROW_GRID, 'border-b border-border px-3 py-2 text-xs')}>
                    <span />
                    <span className="font-semibold text-muted">Current (Kavita)</span>
                    <span className="flex items-center gap-2 font-semibold text-primary">
                      {PROVIDER_NAMES[selected.providerId] ?? selected.providerId} (candidate)
                      {preview.isPending && <Spinner />}
                    </span>
                  </div>
                  {preview.isError && (
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-danger">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Couldn't load candidate metadata: {preview.error instanceof Error ? preview.error.message : String(preview.error)}
                      <Button size="sm" variant="outline" onClick={() => void preview.refetch()}>Retry preview</Button>
                    </div>
                  )}
                  <div className="px-3 pb-1">
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
                    <div className={cn(ROW_GRID, 'items-center py-2')}>
                      <label className="flex min-h-9 cursor-pointer items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
                        <input type="checkbox" checked={coverEnabled} onChange={(e) => setCoverEnabled(e.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
                        Cover
                      </label>
                      <div>
                        <CoverThumb src={currentCover ?? `/api/kavita/series/${seriesId}/cover`} alt="Current cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <CoverThumb src={diff.coverCandidate} alt="Candidate cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                        {!coverEnabled && <span className="text-sm text-muted">not synced</span>}
                      </div>
                    </div>
                  </div>
                </div>
                </div>
              )}

              {selected && (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                <Button variant="ghost" onClick={onClose}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button
                  onClick={() => selected && doApply({ providerId: selected.providerId, providerSeriesId: selected.providerSeriesId }, { selectedTitle: (preview.data?.titleOptions?.length ?? 0) > 1 ? resolvedTitle : undefined, excludedFields: [...excluded], cover: coverEnabled, score: selected.score, coverUrl: diff?.coverCandidate })}
                  disabled={preview.isPending || preview.isError || apply.isPending}
                >
                  {apply.isPending ? <Spinner /> : <ArrowRight className="h-4 w-4" />} Apply & Sync to Kavita
                </Button>
              </div>)}

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
        <DialogContent aria-label={zoomCover.alt} className="flex max-w-none items-center justify-center bg-transparent p-0 shadow-none">
          <img src={zoomCover.src} alt={zoomCover.alt} className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain" />
        </DialogContent>
      )}
    </Dialog>
    <ConfirmDialog
      open={confirmUnmatch}
      title="Unmatch series?"
      description={`This removes the match and removes metadata and covers previously applied by H-Tosho from “${current.name}”.`}
      confirmLabel="Unmatch"
      danger
      pending={unmatch.isPending}
      onOpenChange={setConfirmUnmatch}
      onConfirm={() => unmatch.mutate()}
    />
    </>
  );
}
