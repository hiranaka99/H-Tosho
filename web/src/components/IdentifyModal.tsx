import {
  PROTECTABLE_FIELDS,
  PUBLICATION_STATUS as CANDIDATE_STATUS,
  mergeTagLists,
  releaseYear,
  type FieldPolicy,
  type ProtectedField,
} from '../../../server/src/contracts/metadata';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, AlertTriangle, ArrowLeft, ArrowRight, Link2, Unlink, ChevronRight, Users, History, Lock, LockOpen } from 'lucide-react';
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
  type SeriesRow,
} from '../lib/api';
import { PROVIDER_NAMES, cn } from '../lib/utils';
import { toast } from '../lib/toast';
import { Button, Input, Label, ProviderBadge, Spinner } from './ui';
import { Dialog, DialogContent, DialogTitle, DialogDescription, ConfirmDialog } from './dialog';
import { shouldEnableIdentify } from '../lib/identifyGating';

const ArtistWorksBrowser = React.lazy(() => import('./ArtistWorksBrowser').then((m) => ({ default: m.ArtistWorksBrowser })));
const MetadataHistory = React.lazy(() => import('./MetadataHistory').then((m) => ({ default: m.MetadataHistory })));

const STATUS_LABELS: Record<number, string> = {
  0: 'Ongoing',
  1: 'Hiatus',
  2: 'Completed',
  3: 'Cancelled',
  4: 'Ended',
};

/** One vocabulary for a field everywhere in the dialog: the rows, the unchanged list and the protection panel. */
const PROTECT_LABELS = {
  title: 'Title',
  summary: 'Description',
  genres: 'Genres',
  tags: 'Tags',
  writers: 'Writers',
  artists: 'Artists',
  releaseDate: 'Release year',
  language: 'Language',
  status: 'Publication status',
  url: 'Source URL',
  cover: 'Series and volume covers',
} as const;

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
  /** True when the series already has a match (before async series details finish loading). */
  hasMatch?: boolean;
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
  /** Render the description with more breathing room. */
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

type RowChange = 'change' | 'same' | 'empty';
interface RowEntry { row: DiffRow; kind: RowChange }

/**
 * What applying this row would do. `change` rewrites or adds a value, `same`
 * already matches Kavita, `empty` means the provider has nothing to offer.
 * The Apply count and the guided list are both built from this one answer.
 */
function rowChange(row: DiffRow): RowChange {
  if (row.clearing) return 'change';
  if (!row.candidate.trim()) return 'empty';
  if (row.tagMerge) {
    const have = new Set(row.tagMerge.existing.map((t) => t.trim().toLowerCase()).filter(Boolean));
    return row.tagMerge.incoming.some((t) => t.trim() && !have.has(t.trim().toLowerCase())) ? 'change' : 'same';
  }
  if (!row.current.trim()) return 'change';
  return computeDiffers(row) ? 'change' : 'same';
}

/** Reading order for the guided list: what identifies the series first, housekeeping last. */
const FIELD_ORDER = ['title', 'releaseDate', 'summary', 'genres', 'tags', 'writers', 'artists', 'language', 'status', 'url'] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** URL values render as clickable links (Kavita webLinks may hold several, newline/comma separated). */
function UrlValue({ text }: { text: string }) {
  const urls = text.split(/[\n,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (urls.length === 0) return <span>{text || '—'}</span>;
  return (
    <>
      {urls.map((u, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ', ' : null}
          <a href={u} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center break-all underline decoration-dotted underline-offset-2 hover:decoration-solid pointer-coarse:min-h-11">
            {u}
          </a>
        </React.Fragment>
      ))}
    </>
  );
}

/** Label column (fixed width) + two equal-width value columns: Kavita on the left, candidate on the right. */
const ROW_GRID = 'grid grid-cols-1 items-start gap-1 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-3';

function ComparisonValue({ label, field, className, title, children }: { label: 'Current' | 'Proposed'; field: string; className?: string; title?: string; children: React.ReactNode }) {
  return (
    <dl className="min-w-0 text-sm">
      <dt className="mb-1 text-xs font-medium text-muted sm:sr-only">{label}<span className="sr-only"> {field}</span></dt>
      <dd className={className} title={title}>{children}</dd>
    </dl>
  );
}

interface FieldRowProps {
  row: DiffRow;
  checked?: boolean;
  onToggle?: () => void;
  /** Protected fields are never overwritten: no checkbox, a visible lock and an inline way out. */
  locked?: boolean;
  onUnlock?: () => void;
  unlockDisabled?: boolean;
  /** Replaces the proposed value (the title chooser). */
  proposedControl?: React.ReactNode;
  note?: React.ReactNode;
}

function FieldRow({ row, checked, onToggle, locked, onUnlock, unlockDisabled, proposedControl, note }: FieldRowProps) {
  const labelId = React.useId();
  const merge = row.tagMerge;
  const showCheckbox = !locked && !!row.field && (row.candidate.trim() !== '' || row.clearing) && !!onToggle;
  const skipped = !!locked || (showCheckbox && !checked);
  // Multiline fields (Description) are never truncated: full text, wrapping, with an internal scroll for very long descriptions.
  const valueCls = row.multiline ? 'min-w-0 max-h-56 overflow-y-auto whitespace-pre-wrap break-words' : 'min-w-0 whitespace-pre-wrap break-words';
  return (
    <div role="group" aria-labelledby={labelId} className={cn(ROW_GRID, 'border-b border-border py-3 transition-colors last:border-0 hover:bg-surface-2/40')}>
      <div className="flex min-w-0 flex-col items-start gap-0.5">
        {showCheckbox ? (
          <label id={labelId} className="flex min-h-11 cursor-pointer items-center gap-2 py-1 text-xs font-medium uppercase tracking-wider text-muted sm:min-h-9 pointer-coarse:min-h-11">
            <input type="checkbox" checked={!!checked} onChange={onToggle} className="h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
            {row.label}
          </label>
        ) : (
          <span id={labelId} className="flex min-h-9 items-center gap-1.5 py-1 text-xs font-medium uppercase tracking-wider text-muted">
            {locked && <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
            {row.label}
          </span>
        )}
        {locked && (
          <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted">
            <span>Protected</span>
            {onUnlock && (
              <Button type="button" size="sm" variant="ghost" aria-label={`Unlock ${row.label}`} disabled={unlockDisabled} onClick={onUnlock} className="min-h-9 gap-1 px-1.5 pointer-coarse:min-h-11">
                <LockOpen aria-hidden="true" className="h-3.5 w-3.5" />Unlock
              </Button>
            )}
          </div>
        )}
      </div>
      <ComparisonValue label="Current" field={row.label} className={cn(valueCls, 'min-h-8 text-muted')} title={row.current}>
        {row.link ? <UrlValue text={row.current} /> : row.current || '—'}
      </ComparisonValue>
      <ComparisonValue label="Proposed" field={row.label} className={cn(valueCls, 'min-h-8', skipped ? 'text-muted' : 'text-foreground')} title={row.candidate}>
        {proposedControl ?? (merge ? (
          <MergedTags existing={merge.existing} incoming={merge.incoming} dimmed={skipped} />
        ) : row.clearing ? (
          <>
            <span className={skipped ? 'text-muted' : 'font-medium text-warning'}>{skipped ? 'Would be cleared' : 'Will be cleared'}</span>
            <span className="text-muted"> — the provider's description contains only the tag list.</span>
          </>
        ) : (
          row.link ? <UrlValue text={row.candidate} /> : row.candidate || '—'
        ))}
        {skipped && !merge && <span className="mt-1 block text-xs text-muted">Not synced{locked ? ' · protected' : ''}</span>}
        {note}
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
    <span className="min-w-0 flex-1" title="Existing tags are kept; highlighted tags will be added">
      {merged.map((tag, i) => (
        <React.Fragment key={tag}>
          {i > 0 ? ', ' : null}
          <span className={kept.has(tag.toLowerCase()) || dimmed ? undefined : 'font-medium text-primary'}>{tag}</span>
        </React.Fragment>
      ))}
      {dimmed && <span className="mt-1 block text-xs text-muted">Not synced</span>}
    </span>
  );
}

/** Fields that need no decision: they already match, or the provider has nothing to offer. Collapsed by default. */
function UnchangedFields({ entries }: { entries: RowEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="group/unchanged min-w-0">
      <summary className="flex min-h-11 w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground sm:min-h-9 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open/unchanged:rotate-90" />
        {plural(entries.length, 'field')} won’t change
      </summary>
      <dl className="mt-1 divide-y divide-border rounded-md border border-border text-sm">
        {entries.map(({ row, kind }) => (
          <div key={row.label} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-xs font-medium uppercase tracking-wider text-muted">{row.label}</dt>
            <dd className="min-w-0 break-words text-muted">
              {kind === 'same' ? <>Already matches · <span className="text-foreground">{row.current}</span></> : 'The provider has no value for this field'}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Compact cover for the review summary; tap to enlarge. */
function CoverThumb({ src, alt, onZoom }: { src?: string | null; alt: string; onZoom?: (src: string, alt: string) => void }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [src]);
  const size = 'aspect-[2/3] h-48 sm:h-72';
  if (!src || failed) return <span className={cn(size, 'flex items-center justify-center rounded bg-surface-2 text-xs text-muted')}>No cover</span>;
  const img = (
    <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={cn(size, 'rounded object-cover')} />
  );
  if (!onZoom) return img;
  return (
    <button type="button" aria-label={`Enlarge ${alt}`} onClick={() => onZoom(src, alt)} className="shrink-0 cursor-zoom-in rounded transition-opacity hover:opacity-90">
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
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />;
}
export function IdentifyModal({ seriesId, current, currentLoading, currentError, onRetryCurrent, match, currentCover, onClose, reviewPosition, onNext, autoReview = false, hasMatch = false, initialCandidate }: IdentifyModalProps) {
  const qc = useQueryClient();
  const [browseArtists, setBrowseArtists] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyMounted, setHistoryMounted] = React.useState(false);
  const [autoReviewDone, setAutoReviewDone] = React.useState(false);
  const historyId = React.useId();
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
  // Remember what opened the dialog so closing it puts keyboard focus back there
  // instead of on <body>. A remount between queue items finds focus inside the
  // previous dialog and records nothing, which falls back to the default.
  const opener = React.useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !document.activeElement.closest('[role="dialog"]')
      ? document.activeElement
      : null,
  );
  const [manualUrl, setManualUrl] = React.useState('');
  const [manualOpen, setManualOpen] = React.useState(false);
  const [manualCandidate, setManualCandidate] = React.useState<MatchCandidate | null>(null);
  const [selectedTitle, setSelectedTitle] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState('all');
  const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(new Set());
  // null follows the default: replace the cover unless it is already applied.
  const [coverChoice, setCoverChoice] = React.useState<boolean | null>(null);
  const protection = useQuery({ queryKey: ['field-policy', seriesId], queryFn: () => api.fieldPolicy(seriesId) });
  // Shares the sidebar badge's query, so the review threshold costs no extra request.
  const threshold = useQuery({ queryKey: ['low-confidence'], queryFn: api.lowConfidenceCount, staleTime: 60_000 }).data?.threshold;
  const lockedFields = protection.data?.lockedFields;
  const protectedKeys = React.useMemo(() => new Set<string>(lockedFields ?? []), [lockedFields]);
  const effectiveExcluded = React.useMemo(() => new Set([...excluded, ...protectedKeys]), [excluded, protectedKeys]);
  const protect = useMutation({
    mutationFn: (field: ProtectedField) => api.saveFieldPolicy(seriesId, {
      lockedFields: protectedKeys.has(field) ? (protection.data?.lockedFields ?? []).filter(key => key !== field) : [...(protection.data?.lockedFields ?? []), field],
      expectedRevision: protection.data!.revision,
    }),
    onSuccess: (policy: FieldPolicy) => qc.setQueryData(['field-policy', seriesId], policy),
    onError: (error: Error) => { toast({ tone: 'danger', title: 'Could not save field protection', description: error.message }); void protection.refetch(); },
  });
  const [zoomCover, setZoomCover] = React.useState<{ src: string; alt: string } | null>(null);

  const [confirmUnmatch, setConfirmUnmatch] = React.useState(false);
  // A fresh selection starts with every syncable field opted in.
  React.useEffect(() => {
    setExcluded(new Set());
    setCoverChoice(null);
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

  const reviewCandidate = React.useCallback((candidate: MatchCandidate, fromList = false, existing = false) => {
    savedListScroll.current = candidateList.current?.scrollTop ?? 0;
    savedDialogScroll.current = dialogScroll.current?.scrollTop ?? 0;
    savedCandidateKey.current = fromList ? `${candidate.providerId}:${candidate.providerSeriesId}` : null;
    savedReviewOrigin.current = existing ? 'existing' : fromList ? 'list' : 'manual';
    setReviewingExistingMatch(existing);
    setSelected(candidate);
  }, []);

  const effectiveHasMatch = Boolean(match?.providerId && match.providerSeriesId) || (hasMatch && currentLoading);
  const identify = useQuery({
    queryKey: ['identify', seriesId],
    queryFn: () => api.identify(seriesId),
    // Skip fetching candidates when reviewing an existing match or provided candidate until user asks for matches.
    enabled: shouldEnableIdentify({
      browseArtists,
      selected: Boolean(selected),
      hasInitialCandidate: Boolean(initialCandidate),
      autoReview,
      hasMatch: effectiveHasMatch,
      currentError: Boolean(currentError),
      autoReviewDone,
    }),
    staleTime: 60_000,
  });

  // Identification can update the saved confidence score even before applying:
  // the server rewrites the stored match's score when that match reappears in
  // the results with a different score. Mirror exactly that change into the
  // cached rows instead of refetching every library shelf and this series.
  const identifyOutcome = identify.data;
  React.useEffect(() => {
    if (!identifyOutcome) return;
    let cancelled = false;
    void (async () => {
      // Reuses the cached (or in-flight) series detail the caller already loads.
      const detail = await qc.ensureQueryData({ queryKey: ['series', seriesId], queryFn: () => api.series(seriesId) }).catch(() => null);
      const match = detail?.match;
      if (cancelled || !match?.providerId || !match.providerSeriesId) return;
      const current = identifyOutcome.candidates.find((candidate) => candidate.providerId === match.providerId && candidate.providerSeriesId === match.providerSeriesId);
      if (!current || current.score === match.matchScore) return;
      const score = current.score;
      qc.setQueryData<Awaited<ReturnType<typeof api.series>>>(['series', seriesId], (prev) => prev?.match ? { ...prev, match: { ...prev.match, matchScore: score } } : prev);
      qc.setQueriesData<SeriesRow[]>({ queryKey: ['library-series'] }, (rows) => rows?.some((row) => row.id === seriesId && row.matchScore !== score)
        ? rows.map((row) => row.id === seriesId ? { ...row, matchScore: score } : row)
        : rows);
      // Membership of the review queue and its count depend on the score.
      void qc.invalidateQueries({ queryKey: ['low-confidence'] });
      void qc.invalidateQueries({ queryKey: ['library-series', 'review'] });
    })();
    return () => { cancelled = true; };
  }, [identifyOutcome, qc, seriesId]);


  const apply = useMutation({
    mutationFn: (p: { providerId: string; providerSeriesId: string; selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number }) => {
      if (historyOpen) throw new Error('Close Metadata history before applying provider changes.');
      if (!currentReady || !preview.isSuccess || preview.isError) throw new Error('Load current and proposed metadata before applying changes.');
      return api.apply(seriesId, p.providerId, p.providerSeriesId, { selectedTitle: p.selectedTitle, excludedFields: p.excludedFields, cover: p.cover, score: p.score });
    },
    onSuccess: () => {
      // A queued job has not changed Kavita yet. Keep showing Kavita's cover;
      // SidebarStatus refreshes the series list when the job settles.
      void qc.invalidateQueries({ queryKey: ['series', seriesId] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({ tone: 'info', title: 'Sync queued', description: 'Cover stays unchanged until sync finishes. Check Tasks for errors.' });
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
      void qc.invalidateQueries({ queryKey: ['series', seriesId] });
      void qc.invalidateQueries({ queryKey: ['applied-cover', seriesId] });
      void qc.invalidateQueries({ queryKey: ['library-series'] });
      void qc.invalidateQueries({ queryKey: ['libraries'] });
      void qc.invalidateQueries({ queryKey: ['low-confidence'] });
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
  const manualKey = manualCandidate ? manualCandidate.providerId + ':' + manualCandidate.providerSeriesId : null;
  const visibleCandidates = React.useMemo(() => {
    const filtered = tab === 'all' ? alternatives : alternatives.filter((c) => c.providerId === tab);
    // Best match first, so the list reads as a ranking; a URL or artist work the user picked stays on top.
    const pinned = (c: MatchCandidate) => (manualKey !== null && c.providerId + ':' + c.providerSeriesId === manualKey ? 1 : 0);
    return [...filtered].sort((a, b) => pinned(b) - pinned(a) || b.score - a.score);
  }, [alternatives, tab, manualKey]);
  const openedExisting = React.useRef(false);
  const hasExistingMatch = Boolean(match);
  const matchProviderId = match?.providerId;
  const matchProviderSeriesId = match?.providerSeriesId;
  const matchScore = match?.matchScore;
  React.useEffect(() => {
    if (!autoReview || openedExisting.current) return;
    if (matchProviderId && matchProviderSeriesId) {
      openedExisting.current = true;
      setAutoReviewDone(true);
      reviewCandidate({ providerId: matchProviderId, providerSeriesId: matchProviderSeriesId, title: current.name, type: 'unknown', score: matchScore ?? 0 }, false, true);
    } else if (!currentLoading && !hasExistingMatch) {
      setAutoReviewDone(true);
    }
  }, [autoReview, currentLoading, hasExistingMatch, matchProviderId, matchProviderSeriesId, current.name, matchScore, reviewCandidate]);

  // Full aggregated metadata for the selected candidate — fetched through the
  // same path Apply & Sync uses, so the diff previews exactly what will push.
  const preview = useQuery({
    queryKey: ['identify-preview', selected?.providerId, selected?.providerSeriesId],
    queryFn: () => api.providerMetadata(selected!.providerId, selected!.providerSeriesId),
    enabled: !!selected,
  });
  // Covers from an earlier apply, read fresh for each review: a restore can replace them.
  const appliedCover = useQuery({ queryKey: ['applied-cover', seriesId], queryFn: () => api.appliedCover(seriesId), enabled: !!selected, staleTime: 0 });
  const resolvedTitle = selectedTitle ?? preview.data?.title ?? selected?.title ?? '';

  const k = current.metadata;

  const diff = React.useMemo(() => {
    if (!selected) return null;
    const m = preview.data;
    const candStatus = m?.status != null ? (CANDIDATE_STATUS[m.status] ?? null) : null;
    const rows: DiffRow[] = [
      { label: PROTECT_LABELS.title, current: current.name, candidate: resolvedTitle, field: 'title' },
      {
        label: PROTECT_LABELS.releaseDate,
        current: k && k.releaseYear > 0 ? String(k.releaseYear) : '',
        candidate: candidateYear(m, selected.year),
        field: 'releaseDate',
      },
      {
        label: PROTECT_LABELS.summary,
        current: k?.summary ?? '',
        // Fall back to the raw search summary only while the full preview is
        // still loading; once loaded, an empty candidate means the provider's
        // description was tag blocks only and the description will be cleared.
        candidate: m ? (m.summary ?? '') : (selected.summary ?? ''),
        multiline: true,
        field: 'summary',
        clearing: !!m && m.summary === '' && Boolean((k?.summary ?? '').trim()),
      },
      { label: PROTECT_LABELS.genres, current: tagNames(k?.genres), candidate: m ? m.genres.join(', ') : '', field: 'genres', list: true },
      { label: PROTECT_LABELS.tags, current: tagNames(k?.tags), candidate: m ? m.tags.join(', ') : '', field: 'tags', tagMerge: { existing: (k?.tags ?? []).map((t) => t.title).filter((t): t is string => Boolean(t)), incoming: m?.tags ?? [] } },
      { label: PROTECT_LABELS.writers, current: peopleNames(k?.writers), candidate: m ? m.writers.join(', ') : '', field: 'writers', list: true },
      // H-Tosho writes provider artists into Kavita's penciller role.
      { label: PROTECT_LABELS.artists, current: peopleNames(k?.pencillers), candidate: m ? m.artists.join(', ') : '', field: 'artists', list: true },
      { label: PROTECT_LABELS.language, current: k?.language ?? '', candidate: m?.language ?? '', field: 'language' },
      {
        label: PROTECT_LABELS.status,
        current: k ? (STATUS_LABELS[k.publicationStatus] ?? '') : '',
        candidate: candStatus != null ? (STATUS_LABELS[candStatus] ?? '') : '',
        field: 'status',
      },
      { label: PROTECT_LABELS.url, current: k?.webLinks ?? '', candidate: m?.url ?? '', field: 'url', link: true },
    ];
    return { rows, coverCandidate: m?.coverUrl ?? selected.coverUrl };
  }, [selected, preview.data, resolvedTitle, current.name, k]);

  // Covers H-Tosho already pushed from this same source are not a change. The
  // checkbox also governs volume covers, so every proposed one must be applied too.
  const appliedCovers = appliedCover.data;
  const coverAlreadyApplied = !!preview.data?.coverUrl && preview.data.coverUrl === appliedCovers?.coverUrl
    && (preview.data.volumeCovers ?? []).every((cover) => appliedCovers.volumeCoverUrls?.includes(cover.url) ?? false);
  const coverEnabled = coverChoice ?? !coverAlreadyApplied;

  const doApply = (ids: { providerId: string; providerSeriesId: string }, opts?: { selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number }) => {
    apply.mutate({ ...ids, ...opts, excludedFields: [...effectiveExcluded], cover: coverEnabled && !protectedKeys.has('cover') });
  };

  // ---- Guided review model --------------------------------------------------
  // Sort every field into what it will do. The dialog leads with the changes,
  // keeps protected fields visibly apart, and folds away what needs no decision.
  const titleChoices = preview.data?.titleOptions ?? [];
  const hasTitleChoice = titleChoices.length > 1;
  const { changedRows, lockedRows, unchangedRows } = React.useMemo(() => {
    const changed: RowEntry[] = [];
    const locked: RowEntry[] = [];
    const unchanged: RowEntry[] = [];
    if (diff) {
      for (const field of FIELD_ORDER) {
        const row = diff.rows.find((r) => r.field === field);
        if (!row) continue;
        const kind = rowChange(row);
        if (protectedKeys.has(field)) {
          if (kind === 'change') locked.push({ row, kind });
          else if (kind === 'same') unchanged.push({ row, kind });
          continue;
        }
        // The title chooser stays reachable even when the first option already matches.
        if (kind === 'change' || (field === 'title' && hasTitleChoice && kind !== 'empty')) changed.push({ row, kind });
        else unchanged.push({ row, kind });
      }
    }
    return { changedRows: changed, lockedRows: locked, unchangedRows: unchanged };
  }, [diff, protectedKeys, hasTitleChoice]);
  const currentMetadata = current.metadata;
  const savedArtists = React.useMemo(() => [...new Set([...(currentMetadata?.pencillers ?? []), ...(currentMetadata?.writers ?? []), ...(currentMetadata?.coverArtists ?? [])].map(person => person.name?.trim()).filter((name): name is string => !!name))], [currentMetadata]);
  const includedChanges = changedRows.filter(({ row, kind }) => kind === 'change' && !excluded.has(row.field!)).length;
  const skippedByUser = changedRows.filter(({ row, kind }) => kind === 'change' && excluded.has(row.field!)).length;
  const coverLocked = protectedKeys.has('cover');
  const coverIncluded = !!diff?.coverCandidate && coverEnabled && !coverLocked;
  const totalChanges = includedChanges + (coverIncluded ? 1 : 0);
  const sameCount = unchangedRows.filter(({ kind }) => kind === 'same').length + (coverAlreadyApplied && !coverIncluded && !coverLocked ? 1 : 0);
  const protectedCount = lockedRows.length + (coverLocked && diff?.coverCandidate ? 1 : 0);
  const reviewScore = selected ? (reviewingExistingMatch ? match?.matchScore : selected.score) : undefined;
  const scorePct = typeof reviewScore === 'number' ? Math.round(reviewScore * 100) : null;
  const lowScore = typeof reviewScore === 'number' && typeof threshold === 'number' && reviewScore < threshold;
  const metadataReady = currentReady && preview.isSuccess && !appliedCover.isPending;
  const changeSummary = [
    totalChanges === 0 ? 'No changes' : plural(totalChanges, 'change'),
    sameCount ? `${sameCount} already ${sameCount === 1 ? 'matches' : 'match'}` : null,
    protectedCount ? `${protectedCount} protected` : null,
    lowScore && scorePct !== null ? `${scorePct}% match, below threshold` : null,
  ].filter(Boolean).join(' · ');
  const applyLabel = !metadataReady ? 'Apply changes' : totalChanges > 0 ? `Apply ${plural(totalChanges, 'change')}` : 'Apply match';

  const toggleField = (field: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });

  return (
    <>
    <Dialog open onOpenChange={(o) => { if (!o && !apply.isPending) onClose(); }}>
      <DialogContent
        className="flex max-h-[90dvh] max-w-[min(96vw,1440px)] flex-col overflow-hidden"
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        {/* The title sits outside the scroll area so the close button never overlaps rows scrolling beneath it. */}
        <div className="flex shrink-0 items-start gap-2 px-3 pb-3 pr-14 pt-3 sm:px-5 sm:pt-5">
          <Sparkles aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <DialogTitle className="break-words text-balance">Identify “{current.name}”</DialogTitle>
            <DialogDescription>{selected ? 'Review the changes and choose which fields to sync.' : browseArtists ? 'Find the artist, browse their works by provider, and choose a work to review.' : 'Choose a match to review its metadata before syncing.'}</DialogDescription>
          </div>
        </div>
        <div ref={dialogScroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-border px-3 pb-3 pt-3 sm:px-5 sm:pb-5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            {selected && (
              <Button ref={backButton} size="sm" variant="outline" className="min-h-11" disabled={apply.isPending} onClick={() => { returningToMatches.current = true; setSelected(null); }}><ArrowLeft aria-hidden="true" className="h-4 w-4" />{browseArtists ? 'Back to artist works' : 'Back to matches'}</Button>
            )}
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              {/* While reviewing, the artist browser is one Back away; it only competes for attention here. */}
              {!selected && <Button ref={artistTrigger} size="sm" variant="outline" className="min-h-11" disabled={apply.isPending} aria-expanded={browseArtists} aria-controls={artistBrowserId} onClick={() => setBrowseArtists(value => !value)}>
                {browseArtists ? <ArrowLeft aria-hidden="true" className="h-4 w-4" /> : <Users aria-hidden="true" className="h-4 w-4" />}{browseArtists ? 'Back to matches' : 'Browse artist works'}
              </Button>}
              <Button size="sm" variant={selected ? 'ghost' : 'outline'} disabled={apply.isPending} aria-expanded={historyOpen} aria-controls={historyId} className={cn('min-h-11', historyOpen && 'border border-primary/50 bg-primary/10 text-primary')} onClick={() => { setHistoryMounted(true); setHistoryOpen(value => !value); }}>
                <History aria-hidden="true" className="h-4 w-4" />Metadata history
              </Button>
            </div>
          </div>
          {historyMounted && (
            <React.Suspense fallback={historyOpen ? <div role="status" className="flex items-center gap-2 py-2 text-sm text-muted"><Spinner /> Loading metadata history…</div> : null}>
              <MetadataHistory key={seriesId} id={historyId} seriesId={seriesId} open={historyOpen} />
            </React.Suspense>
          )}
          {browseArtists && <div ref={artistBrowser} id={artistBrowserId} hidden={!!selected}>
            <React.Suspense fallback={<div role="status" className="flex items-center gap-2 py-4 text-sm text-muted"><Spinner /> Loading artist browser…</div>}>
              <ArtistWorksBrowser active={!selected} seriesTitle={current.name} artists={savedArtists} onSelect={candidate => { setManualCandidate(candidate); reviewCandidate(candidate, true); }} />
            </React.Suspense>
          </div>}

          {selected && (currentLoading ? (
            <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading current metadata…</div>
          ) : currentErrorMessage ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">Could not load current metadata</p><p className="mt-1 break-words text-sm text-muted">{currentErrorMessage}</p></div>
              <Button variant="outline" size="sm" onClick={onRetryCurrent}>Retry current metadata</Button>
            </div>
          ) : null)}

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
                <Button size="sm" variant="ghost" onClick={() => setConfirmUnmatch(true)} disabled={unmatch.isPending || historyOpen}>
                  <Unlink className="h-3.5 w-3.5" /> Unmatch
                </Button>
              </div>
            </div>
          )}

          {!selected && !browseArtists && identify.isLoading && (
            <div role="status" className="flex items-center gap-2 py-8 text-muted">
              <Spinner /> Searching providers…
            </div>
          )}

          {!selected && !browseArtists && identify.isError && (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <AlertTriangle aria-hidden="true" className="h-4 w-4 text-danger" />
              <div className="min-w-0 flex-1"><p className="font-medium">Could not search for matches</p><p className="mt-1 break-words text-muted">{identify.error instanceof Error ? identify.error.message : String(identify.error)}</p></div>
              <Button size="sm" variant="outline" onClick={() => void identify.refetch()} disabled={identify.isFetching}>Retry search</Button>
            </div>
          )}

          {(outcome || selected || identify.isError) && (
            <>
              {!selected && !browseArtists && outcome && alternatives.length > 0 && <h3 className="text-sm font-semibold">{match?.providerId ? 'Other matches' : 'Choose a match'}</h3>}
              {!selected && !browseArtists && tabProviders.length > 1 && (
              <div role="group" aria-label="Filter matches by provider" className="flex flex-wrap items-center gap-1.5">
                {['all', ...tabProviders].map((id) => {
                  const active = tab === id;
                  const label = id === 'all' ? 'All' : (PROVIDER_NAMES[id] ?? id);
                  const count = id === 'all' ? alternatives.length : alternatives.filter((c) => c.providerId === id).length;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTab(id)}
                      className={cn('min-h-9 rounded-full border px-3 text-xs transition-colors pointer-coarse:min-h-11', active ? 'border-primary bg-primary/15 font-medium text-primary' : 'border-border text-muted hover:bg-surface-2')}
                    >
                      {label} ({count})
                    </button>
                  );
                })}
              </div>)}
              {!selected && !browseArtists && outcome && (
              <div ref={candidateList}>
                {visibleCandidates.length === 0 && (
                  <p className="py-2 text-sm text-muted">{tab === 'all' ? (match?.providerId ? 'No other matches found.' : 'No matches found. Try a provider URL below.') : `No matches from ${PROVIDER_NAMES[tab] ?? tab}.`}</p>
                )}
                {visibleCandidates.map((c) => {
                  const key = c.providerId + ':' + c.providerSeriesId;
                  const isBest = autoBest?.providerId === c.providerId && autoBest?.providerSeriesId === c.providerSeriesId;
                  const picked = key === manualKey;
                  const low = typeof threshold === 'number' && c.score < threshold;
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
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <ProviderBadge id={c.providerId} />
                          {picked
                            ? <span className="text-xs text-muted">Picked by you</span>
                            : <span className={cn('text-xs font-medium tabular-nums', low ? 'text-muted' : 'text-foreground')}>{Math.round(c.score * 100)}% match{low ? ' · low' : ''}</span>}
                          {isBest && <span className="text-xs font-medium text-primary">Recommended</span>}
                          {c.year && <span className="text-xs text-muted">{c.year}</span>}
                        </div>
                        <p title={c.title} className="mt-1 line-clamp-2 break-words text-sm font-medium">{c.title}</p>
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
                        <Link to="/settings?tab=sources" className="inline-flex min-h-9 items-center text-primary underline underline-offset-2">Check provider settings</Link>
                      </div>
                    </details>
                  )}
                </div>
              )}

              {selected && diff && (
                <div className="flex min-w-0 flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <ProviderBadge id={selected.providerId} />
                    <span className="min-w-0 break-words font-medium">{preview.data?.title ?? selected.title}</span>
                    {scorePct !== null && <span className={cn('text-xs tabular-nums', lowScore ? 'font-medium text-warning' : 'text-muted')}>{scorePct}% match</span>}
                  </div>
                  {preview.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading proposed metadata…</p>}
                  {preview.isError && (
                    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3">
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium">Could not load proposed metadata</p><p className="mt-1 break-words text-sm text-muted">{preview.error instanceof Error ? preview.error.message : String(preview.error)}</p></div>
                      <Button size="sm" variant="outline" onClick={() => void preview.refetch()}>Retry preview</Button>
                    </div>
                  )}
                  {metadataReady && !preview.isError && (<>
                  {/* Summary: the covers a curator recognises a series by, and an honest count of what Apply will do. */}
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <div className="flex shrink-0 items-start gap-2.5">
                      <figure className="m-0 flex flex-col gap-1.5">
                        <CoverThumb src={currentCover ?? `/api/kavita/series/${seriesId}/cover`} alt="Current cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                        <figcaption className="text-xs text-muted">Current</figcaption>
                      </figure>
                      <ArrowRight aria-hidden="true" className="mt-[5.5rem] h-4 w-4 shrink-0 text-muted sm:mt-[8.5rem]" />
                      <figure className="m-0 flex flex-col gap-1.5">
                        <CoverThumb src={diff.coverCandidate} alt="Proposed cover" onZoom={(s, a) => setZoomCover({ src: s, alt: a })} />
                        <figcaption className="text-xs text-muted">{coverIncluded ? 'Proposed' : coverAlreadyApplied && !coverLocked ? 'Proposed · already applied' : 'Proposed · not synced'}</figcaption>
                      </figure>
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <h3 className="text-base font-semibold">{totalChanges === 0 ? 'No metadata changes' : `${plural(totalChanges, 'change')} ready to apply`}</h3>
                      {(sameCount > 0 || protectedCount > 0 || skippedByUser > 0) && (
                        <p className="text-sm text-muted">
                          {[
                            sameCount ? `${sameCount} already ${sameCount === 1 ? 'matches' : 'match'}` : null,
                            protectedCount ? `${protectedCount} protected` : null,
                            skippedByUser ? `${skippedByUser} skipped by you` : null,
                          ].filter(Boolean).join(' · ')}
                        </p>
                      )}
                      {lowScore && scorePct !== null && typeof threshold === 'number' && (
                        <p className="flex items-start gap-2 text-sm text-warning"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />A {scorePct}% match is below your {Math.round(threshold * 100)}% review threshold. Check the title and cover before applying.</p>
                      )}
                      {!diff.coverCandidate ? (
                        <p className="text-sm text-muted">The provider has no cover, so the current one stays.</p>
                      ) : coverLocked ? (
                        <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
                          <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />Series and volume covers are protected.
                          <Button type="button" size="sm" variant="ghost" aria-label="Unlock Series and volume covers" disabled={protect.isPending || apply.isPending || !protection.isSuccess} onClick={() => protect.mutate('cover')} className="min-h-9 px-2 pointer-coarse:min-h-11"><LockOpen aria-hidden="true" className="h-3.5 w-3.5" />Unlock</Button>
                        </div>
                      ) : (
                        <div>
                          {coverAlreadyApplied && <p className="text-sm text-muted">H-Tosho already applied this cover.</p>}
                          <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm sm:min-h-9 pointer-coarse:min-h-11">
                            <input type="checkbox" checked={coverEnabled} onChange={(e) => setCoverChoice(e.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
                            {coverAlreadyApplied ? 'Apply it again' : 'Replace cover'}
                          </label>
                        </div>
                      )}
                    </div>
                  </div>

                  <section aria-label="Field changes" className="rounded-md border border-border">
                    {/* Mirrors the row grid so each header label sits above its column. */}
                    <div aria-hidden="true" className="hidden grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-border px-3 py-2 text-xs font-semibold text-muted sm:grid">
                      <span />
                      <span>Current (Kavita)</span>
                      <span className="text-foreground">Proposed ({PROVIDER_NAMES[selected.providerId] ?? selected.providerId})</span>
                    </div>
                    <div className="px-3">
                      {changedRows.length === 0 && lockedRows.length === 0 && (
                        <p className="py-4 text-sm text-muted">Nothing to change. Every field the provider knows already matches Kavita.</p>
                      )}
                      {changedRows.map(({ row, kind }) => {
                        const isTitle = row.field === 'title';
                        const included = !effectiveExcluded.has(row.field ?? '');
                        return (
                          <FieldRow
                            key={row.label}
                            row={row}
                            checked={included}
                            onToggle={row.field ? () => toggleField(row.field!) : undefined}
                            proposedControl={isTitle && hasTitleChoice ? (
                              <>
                                <Label htmlFor="provider-title-choice" className="sr-only">Proposed series title</Label>
                                <select
                                  id="provider-title-choice"
                                  value={resolvedTitle}
                                  onChange={(e) => setSelectedTitle(e.target.value)}
                                  className="h-9 w-full min-w-0 rounded-md border border-border-2 bg-surface px-3 text-sm pointer-coarse:min-h-11"
                                >
                                  {titleChoices.map((title) => <option key={title} value={title}>{title}</option>)}
                                </select>
                                {!included && <span className="mt-1 block text-xs text-muted">Not synced</span>}
                              </>
                            ) : undefined}
                            note={isTitle && included && kind === 'change' ? (
                              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted"><AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />Also rewrites ComicInfo.xml in every chapter file. This needs access to the CBZ files; if H-Tosho can’t reach them, the title is skipped and everything else still syncs.</p>
                            ) : undefined}
                          />
                        );
                      })}
                      {lockedRows.map(({ row }) => (
                        <FieldRow
                          key={row.label}
                          row={row}
                          locked
                          unlockDisabled={protect.isPending || apply.isPending || !protection.isSuccess}
                          onUnlock={() => protect.mutate(row.field as ProtectedField)}
                        />
                      ))}
                    </div>
                  </section>

                  <UnchangedFields entries={unchangedRows} />

                  <details className="group/protection min-w-0">
                    <summary className="flex min-h-11 w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground sm:min-h-9 [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 group-open/protection:rotate-90" />Protected from H-Tosho sync{protectedKeys.size ? ` (${protectedKeys.size})` : ''}</summary>
                    <p className="mt-2 text-xs text-muted">Checked fields are never overwritten, by this review or by future syncs. Cover protection includes volume covers. Manual ComicInfo edits are still allowed.</p>
                    {protection.isPending ? <p role="status" className="mt-3 text-sm text-muted">Loading field protection…</p> : protection.isError ? <Button size="sm" variant="outline" onClick={() => void protection.refetch()}>Retry field protection</Button> : <fieldset className="mt-3 grid gap-x-4 sm:grid-cols-2">
                      <legend className="sr-only">Never overwrite these fields</legend>
                      {PROTECTABLE_FIELDS.map(field => <label key={field} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={protectedKeys.has(field)} disabled={protect.isPending || apply.isPending} onChange={() => protect.mutate(field)} className="h-4 w-4 accent-primary" />{PROTECT_LABELS[field]}</label>)}
                    </fieldset>}
                  </details>
                </>)}
                </div>
              )}


              {apply.isError && (
                <div role="alert" className="flex items-center gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
                  <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                  {apply.error instanceof Error ? apply.error.message : String(apply.error)}
                </div>
              )}
            </>
          )}
        </div>
        {(selected || reviewPosition) && <div className="shrink-0 border-t border-border bg-surface px-3 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-xs text-muted">{historyOpen ? 'Close Metadata history to apply provider changes.' : <>{reviewPosition && `Review ${reviewPosition}${selected ? ' · ' : ''}`}{selected && (metadataReady ? changeSummary : 'Load metadata before applying')}</>}</p>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Button variant="outline" className="min-h-11" onClick={onClose} disabled={apply.isPending}>Close</Button>
              {onNext && <Button variant="outline" className="min-h-11" onClick={onNext} disabled={apply.isPending}>Skip to next</Button>}
              {selected && <Button title="Queues an Apply & Sync task. Progress and errors appear in Tasks." className="min-h-11 flex-1 sm:flex-none" onClick={() => doApply({ providerId: selected.providerId, providerSeriesId: selected.providerSeriesId }, { selectedTitle: hasTitleChoice ? resolvedTitle : undefined, excludedFields: [...excluded], cover: coverEnabled, score: reviewingExistingMatch ? undefined : selected.score })} disabled={historyOpen || !metadataReady || preview.isError || apply.isPending || !protection.isSuccess || protect.isPending}>
                {apply.isPending ? <Spinner /> : <ArrowRight className="h-4 w-4" />} {applyLabel}{onNext ? ' & next' : ''}
              </Button>}
            </div>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!zoomCover} onOpenChange={(o) => { if (!o) setZoomCover(null); }}>
      {zoomCover && (
        <DialogContent aria-label={zoomCover.alt} className="flex max-w-none items-center justify-center bg-transparent p-0 shadow-none">
          <img src={zoomCover.src} alt={zoomCover.alt} decoding="async" className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain" />
        </DialogContent>
      )}
    </Dialog>
    <ConfirmDialog
      open={confirmUnmatch}
      title="Unmatch series?"
      description={`This removes the match and removes metadata and covers previously applied by H-Tosho from “${current.name}”. Protected fields and covers are retained.`}
      confirmLabel="Unmatch"
      danger
      pending={unmatch.isPending}
      onOpenChange={setConfirmUnmatch}
      onConfirm={() => unmatch.mutate()}
    />
    </>
  );
}
