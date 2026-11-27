/**
 * Discover → Search, scoped to every source.
 *
 * One query fans out to Hitomi.la, nHentai and E-Hentai/ExHentai; repeated
 * editions come back as a single card that keeps every source it was found
 * on. Pagination is a Load-more button over the loaded unique count — there
 * is no summed-total pager. Failed lanes stay visible with scoped retries;
 * successful results remain fully usable while a lane recovers. A new search
 * shows each source's cards as soon as that source answers, with a Searching
 * chip for the ones still running. The form, results header and selection
 * share their shape with single-source search.
 */
import * as React from "react";
import { Link } from "react-router";
import {
  Search,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Minus,
  RotateCcw,
} from "lucide-react";
import {
  type DoujinSearchResult,
  type DoujinSource,
  type ProviderSearchStatus,
  type UnifiedSearchEntry,
} from "../../lib/api";
import { cn } from "../../lib/utils";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
} from "../../components/ui";
import {
  GallerySelectionBar,
  type GallerySelectionActions,
} from "../../components/GallerySelectionBar";
import { GallerySearchInput } from "../../components/GallerySearchInput";

import {
  EHENTAI_ACCOUNT_SETTINGS_URL,
  SOURCE_LABELS,
  type DownloadSetup,
} from "./state";
import { GalleryCard, PRIORITY_COVERS } from "./GalleryCard";
import { toWebResult, type UnifiedSearchValue } from "./useUnifiedSearch";
import { SearchHint } from "./SearchHint";
import { GallerySkeletonCard, GallerySkeletonGrid } from "./GallerySkeletons";
import { SearchResultsHeader, SelectModeButton } from "./SearchResultsHeader";
import type { GalleryOwnership } from "./ownership";

// ---------------- provider status ----------------

const isFailed = (p: ProviderSearchStatus) =>
  p.status === "failed" ||
  p.status === "unavailable" ||
  p.status === "rate-limited";
const isOk = (p: ProviderSearchStatus) =>
  p.status === "success" || p.status === "exhausted";
const isSearching = (p: ProviderSearchStatus) => p.status === "searching";
const listNames = (providers: ProviderSearchStatus[]) =>
  providers.map((p) => SOURCE_LABELS[p.source]).join(", ");

function chipClass(status: ProviderSearchStatus["status"]): string {
  switch (status) {
    case "failed":
    case "unavailable":
    case "rate-limited":
      return "border-danger/40 bg-danger/10 text-danger";
    case "not-configured":
      return "border-warning/40 bg-warning/10 text-warning";
    case "success":
    case "exhausted":
    case "searching":
    case "unsupported-query":
    case "not-applicable":
    default:
      return "border-border bg-surface-2/50 text-muted";
  }
}

/**
 * Sources that answered collapse into one quiet line; only a source that needs
 * attention gets its own chip, with a full-size Retry beside it. Failures are
 * announced once, together, instead of one alert per chip.
 */
function ProviderStatusSummary({
  providers,
  onRetry,
  busy,
  canRetry,
}: {
  providers: ProviderSearchStatus[];
  onRetry: (source: string) => void;
  busy: string | null;
  canRetry: boolean;
}) {
  if (!providers.length) return null;
  const answered = providers.filter(isOk);
  const attention = providers.filter((p) => !isOk(p));
  const failed = providers.filter(isFailed);
  return (
    <div
      role="group"
      aria-label="Provider status for this search"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs"
    >
      {answered.length > 0 && (
        <span className="inline-flex items-center gap-1.5 text-muted">
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-success"
            aria-hidden="true"
          />
          Searched {listNames(answered)}
        </span>
      )}
      {attention.map((p) => {
        const label = SOURCE_LABELS[p.source];
        const icon = isSearching(p) ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : p.status === "unsupported-query" ||
          p.status === "not-applicable" ? (
          <Minus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : p.status === "not-configured" ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        );
        const note =
          p.message ??
          (isSearching(p)
            ? "searching…"
            : p.status === "not-applicable"
              ? "not searched for this query"
              : undefined);
        return (
          <span
            key={p.source}
            className="inline-flex max-w-full flex-wrap items-center gap-x-1 gap-y-1"
          >
            <span
              className={cn(
                "inline-flex max-w-full items-start gap-1.5 rounded-full border px-2.5 py-1",
                chipClass(p.status)
              )}
            >
              {icon}
              <span className="min-w-0 break-words">
                <span className="font-medium">{label}</span>
                {note ? <>: {note}</> : null}
                {p.status === "not-configured" && (
                  <Link
                    to={EHENTAI_ACCOUNT_SETTINGS_URL}
                    className="ml-1 underline underline-offset-2 hover:opacity-80"
                  >
                    save the account
                  </Link>
                )}
              </span>
            </span>
            {isFailed(p) && p.retryable && (
              <Button
                size="sm"
                variant="ghost"
                className="max-lg:min-h-11 pointer-coarse:min-h-11 shrink-0 px-2 text-xs"
                aria-label={`Retry ${label}`}
                disabled={busy !== null || !canRetry}
                onClick={() => onRetry(p.source)}
              >
                {busy === p.source ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}{" "}
                Retry
              </Button>
            )}
          </span>
        );
      })}
      {failed.length > 0 && (
        <p role="alert" className="sr-only">
          {failed
            .map(
              (p) =>
                `${SOURCE_LABELS[p.source]} did not answer${p.message ? `: ${p.message}` : "."}`
            )
            .join(" ")}
        </p>
      )}
    </div>
  );
}

// ---------------- entry card ----------------

function extraSources(entry: UnifiedSearchEntry): DoujinSource[] {
  const primary = entry.primary.source;
  const seen = new Set<string>();
  const out: DoujinSource[] = [];
  for (const v of entry.variants) {
    if (v.source === primary || seen.has(v.source)) continue;
    seen.add(v.source);
    out.push(v.source);
  }
  return out;
}

// ---------------- tab ----------------

interface UnifiedSearchTabProps {
  unified: UnifiedSearchValue;
  /** The "Search in" control, rendered inside the search card with the input it scopes. */
  scopeControl: React.ReactNode;
  /** Watch control for the results header; the parent owns watched-search state. */
  watchControl?: React.ReactNode;
  onOpenEntry: (entry: UnifiedSearchEntry) => void;
  onDownload: (item: DoujinSearchResult, entryId: string) => void;
  downloadStatus: DownloadSetup["status"];
  startingKeys: ReadonlySet<string>;
  ownershipFor: (entry: UnifiedSearchEntry) => GalleryOwnership;
  selectedEntryIds: ReadonlySet<string>;
  onToggleGroup: (entry: UnifiedSearchEntry) => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  selectionActions: GallerySelectionActions;
  showSelection: boolean;
}

interface UnifiedEntryCardProps {
  entry: UnifiedSearchEntry;
  onOpenEntry: (entry: UnifiedSearchEntry) => void;
  onDownload: (item: DoujinSearchResult, entryId: string) => void;
  downloadStatus: DownloadSetup["status"];
  starting: boolean;
  ownership: GalleryOwnership;
  selectMode: boolean;
  selected: boolean;
  onToggleGroup: (entry: UnifiedSearchEntry) => void;
  priority: boolean;
}

/** Ownership is rebuilt per render; the card (like GalleryCard) only reads its type. */
function sameEntryCardProps(
  prev: UnifiedEntryCardProps,
  next: UnifiedEntryCardProps
): boolean {
  return (
    prev.entry === next.entry &&
    prev.onOpenEntry === next.onOpenEntry &&
    prev.onDownload === next.onDownload &&
    prev.downloadStatus === next.downloadStatus &&
    prev.starting === next.starting &&
    prev.ownership.type === next.ownership.type &&
    prev.selectMode === next.selectMode &&
    prev.selected === next.selected &&
    prev.onToggleGroup === next.onToggleGroup &&
    prev.priority === next.priority
  );
}

const UnifiedEntryCard = React.memo(function UnifiedEntryCard({
  entry,
  onOpenEntry,
  onDownload,
  downloadStatus,
  starting,
  ownership,
  selectMode,
  selected,
  onToggleGroup,
  priority,
}: UnifiedEntryCardProps) {
  const primary = React.useMemo(
    () => toWebResult(entry.primary),
    [entry.primary]
  );
  const provenance = React.useMemo(
    () =>
      entry.variants.length > 1
        ? { extraSources: extraSources(entry) }
        : undefined,
    [entry]
  );
  const handleOpen = React.useCallback(
    () => onOpenEntry(entry),
    [onOpenEntry, entry]
  );
  const handleDownload = React.useCallback(
    () => onDownload(primary, entry.entryId),
    [onDownload, primary, entry.entryId]
  );
  const handleToggle = React.useCallback(
    () => onToggleGroup(entry),
    [onToggleGroup, entry]
  );
  const selection = React.useMemo(
    () => ({
      mode: selectMode ? ("select" as const) : ("browse" as const),
      selected,
      onToggle: handleToggle,
    }),
    [selectMode, selected, handleToggle]
  );
  return (
    <GalleryCard
      item={primary}
      onOpen={handleOpen}
      onDownload={handleDownload}
      downloadSetup={downloadStatus}
      starting={starting}
      provenance={provenance}
      ownership={ownership}
      selection={selection}
      quietAction
      priority={priority}
    />
  );
}, sameEntryCardProps);

const UnifiedSearchCard = React.memo(function UnifiedSearchCard({
  draft,
  busy,
  scopeControl,
  onDraftChange,
  onStartSearch,
}: {
  draft: string;
  busy: boolean;
  scopeControl: React.ReactNode;
  onDraftChange: (next: string) => void;
  onStartSearch: (query: string) => void;
}) {
  const [formDraft, setFormDraft] = React.useState(draft);
  const syncedDraftRef = React.useRef(draft);
  React.useEffect(() => {
    if (draft !== syncedDraftRef.current) {
      syncedDraftRef.current = draft;
      setFormDraft(draft);
    }
  }, [draft]);
  React.useEffect(() => {
    if (formDraft === syncedDraftRef.current) return;
    const timer = window.setTimeout(() => {
      syncedDraftRef.current = formDraft;
      onDraftChange(formDraft);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [formDraft, onDraftChange]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = formDraft.trim();
    if (!q) return;
    syncedDraftRef.current = q;
    onDraftChange(q);
    onStartSearch(q);
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {scopeControl}
        <form onSubmit={submit} className="flex min-w-0 gap-2">
          <GallerySearchInput
            value={formDraft}
            source="unified"
            onChange={setFormDraft}
            label="Search galleries"
            describedBy="unified-search-hint"
            placeholder="Keyword, tag, artist or gallery URL…"
            clearLabel="Clear search input"
            className="h-11"
          />
          <Button
            className="h-11 shrink-0"
            type="submit"
            disabled={busy || !formDraft.trim()}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}{" "}
            Search
          </Button>
        </form>
        <SearchHint id="unified-search-hint" />
      </CardContent>
    </Card>
  );
});

export function UnifiedSearchTab({
  unified,
  scopeControl,
  watchControl,
  onOpenEntry,
  onDownload,
  downloadStatus,
  startingKeys,
  ownershipFor,
  selectedEntryIds,
  onToggleGroup,
  selectMode,
  onToggleSelectMode,
  selectionActions,
  showSelection,
}: UnifiedSearchTabProps) {
  const {
    draft,
    committed,
    status,
    entries,
    cursor,
    hasMore,
    loadedUniqueCount,
    totalUnique,
    providers,
    error,
    retrying,
    setDraft,
    startSearch,
  } = unified;
  const busy = status === "searching" || status === "loading-more";
  const failedProviders = providers.filter(isFailed);
  const okProviders = providers.filter(isOk);
  const searchingProviders =
    status === "searching" ? providers.filter(isSearching) : [];

  const galleries = (n: number) => `${n} ${n === 1 ? "gallery" : "galleries"}`;
  const resultStatus =
    status === "loading-more"
      ? "Loading more…"
      : status === "searching"
        ? `Showing ${galleries(loadedUniqueCount)} · still searching ${listNames(searchingProviders) || "sources"}`
        : totalUnique !== null
          ? `${galleries(totalUnique)} across sources`
          : `Showing ${galleries(loadedUniqueCount)}${hasMore ? " · more available" : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <UnifiedSearchCard
        draft={draft}
        busy={busy}
        scopeControl={scopeControl}
        onDraftChange={setDraft}
        onStartSearch={startSearch}
      />

      {/* A shortlist carried over from another search stays reachable while this one has no cards. */}
      {showSelection && (committed === null || entries.length === 0) && (
        <GallerySelectionBar {...selectionActions} />
      )}

      {committed === null && (
        <Card className="flex items-center justify-center">
          <EmptyState
            icon={<Search className="h-8 w-8" />}
            title="Search every source at once"
            description="Each work gets one card that lists every source it was found on. To open one specific gallery, paste its full URL; bare IDs differ between sources."
          />
        </Card>
      )}

      {error && committed !== null && (
        <Card>
          <ErrorState
            title={
              error.kind === "session"
                ? "This search needs to start again"
                : "This search couldn’t run"
            }
            description={error.message}
            onRetry={() => unified.startSearch(committed ?? draft)}
          />
        </Card>
      )}

      {committed !== null &&
        !error &&
        status === "searching" &&
        entries.length === 0 && (
          <div className="flex flex-col gap-3">
            <ProviderStatusSummary
              providers={providers}
              onRetry={(s) => unified.retrySource(s)}
              busy={retrying}
              canRetry={false}
            />
            <GallerySkeletonGrid label="Searching all sources" />
          </div>
        )}

      {committed !== null &&
        !error &&
        status !== "searching" &&
        entries.length === 0 &&
        (okProviders.length === 0 && failedProviders.length > 0 ? (
          <Card>
            <div className="flex flex-col gap-3 px-4 py-8">
              <p className="text-sm font-medium">
                No source answered this search
              </p>
              <ProviderStatusSummary
                providers={providers}
                onRetry={(s) => unified.retrySource(s)}
                busy={retrying}
                canRetry={!!cursor}
              />
              <p className="text-xs text-muted">
                There may still be matches. Retry a source, or search again in a
                minute.
              </p>
            </div>
          </Card>
        ) : (
          <Card className="flex items-center justify-center">
            <EmptyState
              icon={<Search className="h-8 w-8" />}
              title="No results"
              description={
                okProviders.length
                  ? `No galleries for “${committed}” on ${okProviders.map((p) => SOURCE_LABELS[p.source]).join(", ")}.${failedProviders.length ? ` ${failedProviders.length === 1 ? "1 source" : `${failedProviders.length} sources`} did not answer, so more may exist.` : ""}`
                  : `No galleries for “${committed}”.`
              }
            />
          </Card>
        ))}

      {committed !== null && !error && entries.length > 0 && (
        <div className="flex flex-col">
          <SearchResultsHeader
            status={resultStatus}
            actions={
              <>
                {watchControl}
                <SelectModeButton
                  selectMode={selectMode}
                  onToggle={onToggleSelectMode}
                />
              </>
            }
          >
            <ProviderStatusSummary
              providers={providers}
              onRetry={(s) => unified.retrySource(s)}
              busy={retrying}
              canRetry={!!cursor}
            />
          </SearchResultsHeader>
          {showSelection && <GallerySelectionBar {...selectionActions} />}
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {entries.map((entry, index) => (
              <UnifiedEntryCard
                key={entry.entryId}
                entry={entry}
                onOpenEntry={onOpenEntry}
                onDownload={onDownload}
                downloadStatus={downloadStatus}
                starting={startingKeys.has(
                  `${entry.primary.source}:${entry.primary.galleryId}`
                )}
                ownership={ownershipFor(entry)}
                selectMode={selectMode}
                selected={selectedEntryIds.has(entry.entryId)}
                onToggleGroup={onToggleGroup}
                priority={index < PRIORITY_COVERS}
              />
            ))}
            {/* Room for the sources still answering; their cards land here. */}
            {searchingProviders.length > 0 &&
              Array.from({ length: 4 }, (_, i) => (
                <GallerySkeletonCard key={`pending-${i}`} />
              ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => unified.loadMore()}
                disabled={status !== "idle"}
              >
                {status === "loading-more" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                {status === "loading-more" ? "Loading more…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
