import { PUBLICATION_STATUS as CANDIDATE_STATUS, mergeTagLists, releaseYear } from '../../../server/src/contracts/metadata';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, AlertTriangle, ArrowLeft, ArrowRight, Link2, Unlink, ChevronRight, Users } from 'lucide-react';
import { Link } from 'react-router';
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
import { PROVIDER_NAMES, cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription, Input, Label, ProviderBadge, Spinner, ConfirmDialog } from './ui';
import { ArtistWorksBrowser } from './ArtistWorksBrowser';

const STATUS_LABELS: Record<number, string> = {
  0: 'Ongoing',
  1: 'Hiatus',
  2: 'Completed',
  3: 'Cancelled',
  4: 'Ended',
};

interface CurrentKavita {
  name: string;
  metadata: KavitaSeriesMetadata | null;
}

interface IdentifyModalProps {
  seriesId: number;
  current: CurrentKavita;
  currentLoading: boolean;
  currentError: string | null;
  onRetryCurrent: () => void;
  /** Existing local match row (from GET /series/:id), if any. */
  match: SeriesMatch | null;
  currentCover?: string | null;
  onClose: () => void;
  reviewPosition?: string;
  onNext?: () => void;
  autoReview?: boolean;
  /** Open a background-discovered candidate directly in the normal comparison. */
  initialCandidate?: MatchCandidate;
}

const tagNames = (tags: KavitaTag[] | null | undefined): string =>
  (tags ?? []).map((t) => t.title).filter(Boolean).join(', ');

const peopleNames = (people: KavitaPerson[] | null | undefined): string =>
  (people ?? []).map((p) => p.name).filter(Boolean).join(', ');
function candidateYear(meta: SeriesMetadata | undefined, fallbackYear?: number): string {
  const year = meta ? releaseYear(meta) : undefined;
  return year !== undefined ? String(year) : fallbackYear ? String(fallbackYear) : '';
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

function ComparisonValue({ label, field, className, title, children }: { label: 'Current' | 'Proposed'; field: string; className?: string; title?: string; children: React.ReactNode }) {
  return (
    <dl className="min-w-0 text-sm">
      <dt className="mb-1 text-xs font-medium text-muted sm:sr-only">{label}<span className="sr-only"> {field}</span></dt>
      <dd className={className} title={title}>{children}</dd>
    </dl>
  );
}

function FieldRow({ row, checked, onToggle }: { row: DiffRow; checked?: boolean; onToggle?: () => void }) {
  const labelId = React.useId();
  const merge = row.tagMerge;
  const differs = !merge && computeDiffers(row);
  // Multiline fields (Summary) are never truncated: full text, wrapping, with an internal scroll for very long descriptions.
  const valueCls = row.multiline ? 'min-w-0 max-h-56 overflow-y-auto whitespace-pre-wrap break-words' : 'min-w-0 whitespace-pre-wrap break-words';
  const showCheckbox = !!row.field && (row.candidate.trim() !== '' || row.clearing) && !!onToggle;
  return (
    <div role="group" aria-labelledby={labelId} className={cn(ROW_GRID, 'border-b border-border py-3 last:border-0', differs ? 'bg-warning/5' : 'transition-colors hover:bg-surface-2/40')}>
      <div id={labelId} className="flex min-w-0 items-start gap-1.5">
        {showCheckbox ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 py-1 text-xs font-medium uppercase tracking-wider text-muted sm:min-h-9 pointer-coarse:min-h-11">
            <input type="checkbox" checked={!!checked} onChange={onToggle} className="h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
            {row.label}
          </label>
        ) : (
          <span className="min-h-9 py-3 text-xs font-medium uppercase tracking-wider text-muted">{row.label}</span>
        )}
      </div>
      <ComparisonValue label="Current" field={row.label} className={cn(valueCls, 'min-h-8', differs && 'text-muted line-through')} title={row.current}>
        {row.link ? <UrlValue text={row.current} /> : row.current || '—'}
      </ComparisonValue>
      <ComparisonValue label="Proposed" field={row.label} className={cn(valueCls, 'min-h-8', differs && 'text-primary', !merge && showCheckbox && !checked && 'text-muted line-through opacity-60')} title={row.candidate}>
        {merge ? (
          <MergedTags existing={merge.existing} incoming={merge.incoming} dimmed={!checked} />
        ) : row.clearing ? (
          <>
            <span className="text-primary">Will be cleared</span>
            <span className="text-muted"> — the provider's summary contains only the tag list.</span>
          </>
        ) : (
          row.link ? <UrlValue text={row.candidate} className="text-primary" /> : row.candidate || '—'
        )}
      </ComparisonValue>
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
export function IdentifyModal({ seriesId, current, currentLoading, currentError, onRetryCurrent, match, currentCover, onClose, reviewPosition, onNext, autoReview = false, initialCandidate }: IdentifyModalProps) {
  const qc = useQueryClient();
  const [browseArtists, setBrowseArtists] = React.useState(false);
  const artistBrowser = React.useRef<HTMLDivElement>(null);
  const artistTrigger = React.useRef<HTMLButtonElement>(null);
  const artistBrowserId = React.useId();
  const [selected, setSelected] = React.useState<MatchCandidate | null>(initialCandidate ?? null);
  const [reviewingExistingMatch, setReviewingExistingMatch] = React.useState(false);
  const selectedId = selected ? `${selected.providerId}:${selected.providerSeriesId}` : null;
  const currentErrorMessage = currentError ?? (!currentLoading && !current.metadata ? 'Kavita did not return current metadata. Check the connection and retry.' : null);
  const currentReady = !currentLoading && !currentErrorMessage && current.metadata !== null;
  const dialogScroll = React.useRef<HTMLDivElement>(null);
  const candidateList = React.useRef<HTMLDivElement>(null);
  const savedListScroll = React.useRef(0);
  const savedDialogScroll = React.useRef(0);
  const savedCandidateKey = React.useRef<string | null>(null);
  const savedReviewOrigin = React.useRef<'existing' | 'list' | 'manual'>('list');
  const returningToMatches = React.useRef(false);
  const backButton = React.useRef<HTMLButtonElement>(null);
  const existingReviewButton = React.useRef<HTMLButtonElement>(null);
  const manualLoadButton = React.useRef<HTMLButtonElement>(null);
  const comparisonId = React.useId();
  const [manualUrl, setManualUrl] = React.useState('');
  const [manualOpen, setManualOpen] = React.useState(false);
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

  React.useLayoutEffect(() => {
    if (selectedId) {
      if (dialogScroll.current) dialogScroll.current.scrollTop = 0;
      backButton.current?.focus({ preventScroll: true });
    } else if (returningToMatches.current) {
      returningToMatches.current = false;
      if (candidateList.current) candidateList.current.scrollTop = savedListScroll.current;
      if (dialogScroll.current) dialogScroll.current.scrollTop = savedDialogScroll.current;
      const previous = Array.from((browseArtists ? artistBrowser.current : candidateList.current)?.querySelectorAll<HTMLButtonElement>('[data-candidate-key]') ?? []).find((button) => button.dataset.candidateKey === savedCandidateKey.current);
      const origin = savedReviewOrigin.current === 'manual' ? manualLoadButton.current : existingReviewButton.current;
      (previous ?? origin)?.focus({ preventScroll: true });
    }
  }, [selectedId, browseArtists]);

  const reviewCandidate = (candidate: MatchCandidate, fromList = false, existing = false) => {
    savedListScroll.current = candidateList.current?.scrollTop ?? 0;
    savedDialogScroll.current = dialogScroll.current?.scrollTop ?? 0;
    savedCandidateKey.current = fromList ? `${candidate.providerId}:${candidate.providerSeriesId}` : null;
    savedReviewOrigin.current = existing ? 'existing' : fromList ? 'list' : 'manual';
    setReviewingExistingMatch(existing);
    setSelected(candidate);
  };

  const identify = useQuery({
    queryKey: ['identify', seriesId],
    queryFn: () => api.identify(seriesId),
    // Home opens its saved candidate directly; search when returning to the list.
    enabled: !browseArtists && (!initialCandidate || !selected),
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
    mutationFn: (p: { providerId: string; providerSeriesId: string; selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number }) => {
      if (!currentReady || !preview.isSuccess || preview.isError) throw new Error('Load current and proposed metadata before applying changes.');
      return api.apply(seriesId, p.providerId, p.providerSeriesId, { selectedTitle: p.selectedTitle, excludedFields: p.excludedFields, cover: p.cover, score: p.score });
    },
    onSuccess: () => {
      // A queued job has not changed Kavita yet. Keep showing Kavita's cover;
      // SidebarStatus refreshes the series list when the job settles.
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'info', title: 'Sync queued', description: 'Cover stays unchanged until sync finishes. Check Jobs for errors.' });
      if (onNext) onNext();
      else onClose();
    },
    onError: (e) => toast({ tone: 'danger', title: 'Could not queue sync', description: e instanceof Error ? e.message : String(e) }),
  });

  const resolveManual = useMutation({
    mutationFn: () => api.manualMatch(seriesId, manualUrl),
    onSuccess: (candidate) => {
      setManualCandidate(candidate);
      reviewCandidate(candidate);
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
    const found = outcome?.candidates ?? (initialCandidate ? [initialCandidate] : []);
    if (!manualCandidate) return found;
    const key = manualCandidate.providerId + ':' + manualCandidate.providerSeriesId;
    return [manualCandidate, ...found.filter((c) => c.providerId + ':' + c.providerSeriesId !== key)];
  }, [outcome, manualCandidate, initialCandidate]);
  const autoBest = outcome?.best;
  const currentCandidate = candidates.find((candidate) => candidate.providerId === match?.providerId && candidate.providerSeriesId === match.providerSeriesId);
  const alternatives = React.useMemo(() => candidates.filter((candidate) => candidate.providerId !== match?.providerId || candidate.providerSeriesId !== match.providerSeriesId), [candidates, match?.providerId, match?.providerSeriesId]);

  // Only offer filters that have matches to show.
  const tabProviders = React.useMemo(() => {
    return [...new Set(alternatives.map((candidate) => candidate.providerId))];
  }, [alternatives]);
  const visibleCandidates = React.useMemo(() => {
    return tab === 'all' ? alternatives : alternatives.filter((c) => c.providerId === tab);
  }, [alternatives, tab]);
  const openedExisting = React.useRef(false);
  React.useEffect(() => {
    if (!autoReview || openedExisting.current || !match?.providerId || !match.providerSeriesId) return;
    openedExisting.current = true;
    reviewCandidate({ providerId: match.providerId, providerSeriesId: match.providerSeriesId, title: current.name, type: 'unknown', score: match.matchScore ?? 0 }, false, true);
  }, [autoReview, match?.providerId, match?.providerSeriesId, current.name, match?.matchScore]);

  // Full aggregated metadata for the selected candidate — fetched through the
  // same path Apply & Sync uses, so the diff previews exactly what will push.
  const preview = useQuery({
    queryKey: ['identify-preview', selected?.providerId, selected?.providerSeriesId],
    queryFn: () => api.providerMetadata(selected!.providerId, selected!.providerSeriesId),
    enabled: !!selected,
  });
  const resolvedTitle = selectedTitle ?? preview.data?.title ?? selected?.title ?? '';

  const k = current.metadata;

  const diff = React.useMemo(() => {
    if (!selected) return null;
    const m = preview.data;
    const candStatus = m?.status != null ? (CANDIDATE_STATUS[m.status as keyof typeof CANDIDATE_STATUS] ?? null) : null;
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
  const selectedFieldCount = diff?.rows.filter((row) => row.field && (row.candidate.trim() !== '' || row.clearing) && !excluded.has(row.field)).length ?? 0;

  const doApply = (ids: { providerId: string; providerSeriesId: string }, opts?: { selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number }) => {
    apply.mutate({ ...ids, ...opts });
  };

  return (
    <>
    <Dialog open onOpenChange={(o) => { if (!o && !apply.isPending) onClose(); }}>
      <DialogContent className="flex max-h-[90dvh] max-w-[min(96vw,1440px)] flex-col overflow-hidden">
        <div ref={dialogScroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-5">
          <div className="flex items-start gap-2 pr-10">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <DialogTitle className="break-words">Identify “{current.name}”</DialogTitle>
              <DialogDescription>{selected ? 'Review the changes and choose which fields to sync.' : browseArtists ? 'Find the artist, browse their works by provider, and choose a work to review.' : 'Choose a match to review its metadata before syncing.'}</DialogDescription>
            </div>
          </div>

          {(!selected || !browseArtists) && <Button ref={artistTrigger} size="sm" variant="outline" className="shrink-0 self-start" aria-expanded={browseArtists && !selected} aria-controls={artistBrowserId} onClick={() => { if (selected) { setSelected(null); setBrowseArtists(true); } else setBrowseArtists(value => !value); }}>
            {browseArtists && !selected ? <ArrowLeft className="h-4 w-4" /> : <Users className="h-4 w-4" />}{browseArtists && !selected ? 'Back to matches' : 'Browse artist works'}
          </Button>}
          {browseArtists && <div ref={artistBrowser} id={artistBrowserId} hidden={!!selected}>
            <ArtistWorksBrowser active={!selected} seriesTitle={current.name} artists={[...new Set([...(current.metadata?.pencillers ?? []), ...(current.metadata?.writers ?? []), ...(current.metadata?.coverArtists ?? [])].map(person => person.name?.trim()).filter((name): name is string => !!name))]} onSelect={candidate => { setManualCandidate(candidate); reviewCandidate(candidate, true); }} />
          </div>}

          {selected && (currentLoading ? (
            <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading current metadata…</div>
          ) : currentErrorMessage ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">Could not load current metadata</p><p className="mt-1 break-words text-sm text-muted">{currentErrorMessage}</p></div>
              <Button variant="outline" size="sm" onClick={onRetryCurrent}>Retry current metadata</Button>
            </div>
          ) : null)}

          {selected && (
            <Button ref={backButton} size="sm" variant="ghost" className="self-start" disabled={apply.isPending} onClick={() => { returningToMatches.current = true; setSelected(null); }}><ArrowLeft className="h-4 w-4" />{browseArtists ? 'Back to artist works' : 'Back to matches'}</Button>
          )}

          {!selected && !browseArtists && match?.providerId && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div className="min-w-0">
                  {currentCandidate && <p className="mb-1 break-words text-sm font-semibold">{currentCandidate.title}</p>}
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="font-normal text-muted">Current match</span>
                    <ProviderBadge id={match.providerId} />
                    {typeof match.matchScore === 'number' && ` · ${Math.round(match.matchScore * 100)}%`}
                  </p>
                  <p className="mt-1 text-xs text-muted">Review current and proposed metadata before syncing.</p>
                </div>
              <div className="flex flex-wrap items-center gap-2">
                {match.providerSeriesId && (
                  <Button ref={existingReviewButton} size="sm" onClick={() => reviewCandidate({ providerId: match.providerId!, providerSeriesId: match.providerSeriesId!, title: current.name, type: 'unknown', score: match.matchScore ?? 0 }, false, true)} disabled={apply.isPending}>
                    <ArrowRight className="h-3.5 w-3.5" /> Review changes
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setConfirmUnmatch(true)} disabled={unmatch.isPending}>
                  <Unlink className="h-3.5 w-3.5" /> Unmatch
                </Button>
              </div>
            </div>
          )}

          {!selected && !browseArtists && identify.isLoading && (
            <div className="flex items-center gap-2 py-8 text-muted">
              <Spinner /> Searching providers…
            </div>
          )}

          {!selected && !browseArtists && identify.isError && (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <AlertTriangle className="h-4 w-4" />
              <div className="min-w-0 flex-1"><p className="font-medium">Could not search for matches</p><p className="mt-1 break-words text-muted">{identify.error instanceof Error ? identify.error.message : String(identify.error)}</p></div>
              <Button size="sm" variant="outline" onClick={() => void identify.refetch()} disabled={identify.isFetching}>Retry search</Button>
            </div>
          )}

          {(outcome || selected || identify.isError) && (
            <>
              {!selected && !browseArtists && outcome && alternatives.length > 0 && <h3 className="text-sm font-semibold">{match?.providerId ? 'Other matches' : 'Choose a match'}</h3>}
              {!selected && !browseArtists && tabProviders.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setTab('all')}
                  className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors', tab === 'all' ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                >
                  All ({alternatives.length})
                </button>
                {tabProviders.map((id) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors', tab === id ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                  >
                    {PROVIDER_NAMES[id] ?? id} ({alternatives.filter((c) => c.providerId === id).length})
                  </button>
                ))}
              </div>)}
              {!selected && !browseArtists && outcome && (
              <div ref={candidateList} className="max-h-[42vh] overflow-y-auto">
                {visibleCandidates.length === 0 && (
                  <p className="py-2 text-sm text-muted">{tab === 'all' ? (match?.providerId ? 'No other matches found.' : 'No matches found. Try a provider URL below.') : `No matches from ${PROVIDER_NAMES[tab] ?? tab}.`}</p>
                )}
                {visibleCandidates.map((c) => {
                  const key = c.providerId + ':' + c.providerSeriesId;
                  const isBest = autoBest?.providerId === c.providerId && autoBest?.providerSeriesId === c.providerSeriesId;
                  return (
                    <button
                      key={key}
                      data-candidate-key={key}
                      onClick={() => reviewCandidate(c, true)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-surface-2"
                    >
                      <div
                        className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2"
                      >
                        <CandidateCover src={c.coverUrl} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <ProviderBadge id={c.providerId} />
                          {isBest && <span className="text-xs font-medium text-primary">Recommended</span>}
                          {c.year && <span className="text-xs text-muted">{c.year}</span>}
                        </div>
                        <p className="mt-1 truncate text-sm font-medium">{c.title}</p>
                        {c.summary && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{c.summary}</p>}
                      </div>
                      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                    </button>
                  );
                })}
              </div>)}

              {!selected && !browseArtists && (
                <div className="flex flex-col gap-3 border-t border-border pt-4">
                  <details className="group" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}>
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3 text-sm text-muted sm:min-h-9 sm:py-2 [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open:rotate-90" />Use a provider URL</summary>
                    <form className="pt-2" onSubmit={(event) => { event.preventDefault(); if (manualUrl.trim() && !resolveManual.isPending) resolveManual.mutate(); }}>
                      <Label htmlFor="manual-provider-url">MangaDex, MyAnimeList, or AniList series URL</Label>
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <Input id="manual-provider-url" type="url" value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} placeholder="Paste a series URL" autoComplete="off" />
                        <Button ref={manualLoadButton} type="submit" variant="outline" disabled={!manualUrl.trim() || resolveManual.isPending}>
                          {resolveManual.isPending ? <Spinner /> : <Link2 className="h-4 w-4" />} Load
                        </Button>
                      </div>
                    </form>
                  </details>
                  {outcome?.errors && Object.keys(outcome.errors).length > 0 && (
                    <details className="group">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3 text-sm text-muted sm:min-h-9 sm:py-2 [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open:rotate-90" />{Object.keys(outcome.errors).map((id) => PROVIDER_NAMES[id] ?? id).join(', ')} search unavailable</summary>
                      <div className="space-y-2 pb-2 pt-1 text-xs text-muted">
                        {Object.entries(outcome.errors).map(([id, message]) => <p key={id} className="break-words"><span className="font-medium">{PROVIDER_NAMES[id] ?? id}:</span> {message}</p>)}
                        <Link to="/settings?tab=providers" className="inline-flex min-h-9 items-center text-primary underline underline-offset-2">Check provider settings</Link>
                      </div>
                    </details>
                  )}
                </div>
              )}

              {selected && diff && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <ProviderBadge id={selected.providerId} />
                    <span className="font-medium">{preview.data?.title ?? selected.title}</span>
                    {(!reviewingExistingMatch || match?.matchScore != null) && <span className="text-xs text-muted">{Math.round(selected.score * 100)}% match</span>}
                  </div>
                  {preview.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading proposed metadata…</p>}
                  {preview.isError && (
                    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3">
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium">Could not load proposed metadata</p><p className="mt-1 break-words text-sm text-muted">{preview.error instanceof Error ? preview.error.message : String(preview.error)}</p></div>
                      <Button size="sm" variant="outline" onClick={() => void preview.refetch()}>Retry preview</Button>
                    </div>
                  )}
                  {currentReady && preview.isSuccess && !preview.isError && (<>
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
                      <p className="mt-1 text-xs text-muted">Applying the title updates Kavita and the Series field in every CBZ. H-Tosho needs access to the series’ CBZ files to change its title.</p>
                    </div>
                  )}
                  <div className="rounded-md border border-border">
                  {/* Mirrors the row grid so each header label sits above its column. */}
                  <div aria-hidden="true" className="hidden grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-border px-3 py-2 text-xs sm:grid">
                    <span />
                    <span className="font-semibold text-muted">Current (Kavita)</span>
                    <span className="flex items-center gap-2 font-semibold text-primary">
                      Proposed ({PROVIDER_NAMES[selected.providerId] ?? selected.providerId})
                    </span>
                  </div>
                  <div className="px-3 pb-1">
                    {[
                      { title: 'Identity', fields: ['title', 'releaseDate', 'language', 'status', 'url'] },
                      { title: 'Description & tags', fields: ['summary', 'genres', 'tags'] },
                      { title: 'Contributors', fields: ['writers', 'artists'] },
                    ].map((section) => (
                      <section key={section.title} aria-labelledby={`${comparisonId}-${section.fields[0]}`} className="border-b border-border pb-2 last:border-0">
                        <h3 id={`${comparisonId}-${section.fields[0]}`} className="pb-1 pt-4 text-sm font-semibold">{section.title}</h3>
                        {diff.rows.filter((row) => section.fields.includes(row.field ?? '')).map((row) => (
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
                      </section>
                    ))}
                    <section aria-labelledby={`${comparisonId}-cover`}>
                      <h3 id={`${comparisonId}-cover`} className="pb-1 pt-4 text-sm font-semibold">Cover</h3>
                    <div className={cn(ROW_GRID, 'py-3')}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted sm:min-h-9 pointer-coarse:min-h-11">
                        <input type="checkbox" checked={coverEnabled} onChange={(e) => setCoverEnabled(e.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
                        Apply cover
                      </label>
                      <ComparisonValue label="Current" field="cover">
                        <CoverThumb src={currentCover ?? `/api/kavita/series/${seriesId}/cover`} alt="Current cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                      </ComparisonValue>
                      <ComparisonValue label="Proposed" field="cover" className="flex flex-col gap-1.5">
                        <CoverThumb src={diff.coverCandidate} alt="Proposed cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                        {!coverEnabled && <span className="text-sm text-muted">not synced</span>}
                      </ComparisonValue>
                    </div>
                    </section>
                  </div>
                </div>
                </>)}
                </div>
              )}


              {apply.isError && (
                <div className="flex items-center gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
                  <AlertTriangle className="h-4 w-4" />
                  {apply.error instanceof Error ? apply.error.message : String(apply.error)}
                </div>
              )}
            </>
          )}
        </div>
        {(selected || reviewPosition) && <div className="shrink-0 border-t border-border bg-surface px-3 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-xs text-muted">{reviewPosition && `Review ${reviewPosition}${selected ? ' · ' : ''}`}{selected && (currentReady && preview.isSuccess ? `${selectedFieldCount} fields selected${coverEnabled && diff?.coverCandidate ? ' · cover selected' : ''}` : 'Load metadata before applying')}</p>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <Button variant="ghost" onClick={onClose} disabled={apply.isPending}>Close</Button>
              {onNext && <Button variant="outline" onClick={onNext} disabled={apply.isPending}>Skip to next</Button>}
              {selected && <Button className="min-h-11 flex-1 sm:flex-none" onClick={() => doApply({ providerId: selected.providerId, providerSeriesId: selected.providerSeriesId }, { selectedTitle: (preview.data?.titleOptions?.length ?? 0) > 1 ? resolvedTitle : undefined, excludedFields: [...excluded], cover: coverEnabled, score: reviewingExistingMatch ? undefined : selected.score })} disabled={!currentReady || !preview.isSuccess || preview.isError || apply.isPending}>
                {apply.isPending ? <Spinner /> : <ArrowRight className="h-4 w-4" />} {onNext ? 'Apply & next' : 'Apply & Sync'}
              </Button>}
            </div>
          </div>
        </div>}
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
