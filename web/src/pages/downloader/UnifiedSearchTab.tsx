/**
 * Discover → "Unified search" tab (plan P2.5–P2.7).
 *
 * One query fans out to Hitomi.la, nHentai and E-Hentai/ExHentai; repeated
 * editions come back as a single card that keeps every source it was found
 * on. Pagination is a Load-more button over the loaded unique count — there
 * is no summed-total pager. Failed lanes stay visible with scoped retries;
 * successful results remain fully usable while a lane recovers.
 */
import * as React from 'react';
import { Link } from 'react-router';
import { Search, Loader2, CheckCircle2, AlertTriangle, XCircle, Minus, CheckSquare, RotateCcw } from 'lucide-react';
import { type DoujinSearchResult, type DoujinSource, type ProviderSearchStatus, type UnifiedSearchEntry } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button, Card, CardContent, EmptyState } from '../../components/ui';
import { GallerySelectionBar } from '../../components/GallerySelectionBar';
import { GallerySearchInput } from '../../components/GallerySearchInput';

import { EHENTAI_ACCOUNT_SETTINGS_URL, SOURCE_LABELS, type DownloadSetup } from './state';
import { GalleryCard } from './GalleryCard';
import { toWebResult, type UnifiedSearchValue } from './useUnifiedSearch';
import { SearchHint } from './SearchHint';
import { GallerySkeletonGrid } from './GallerySkeletons';
import type { GalleryOwnership } from './ownership';

// ---------------- provider status chips ----------------

function chipClass(status: ProviderSearchStatus['status']): string {
  switch (status) {
    case 'success':
    case 'exhausted':
      return 'border-border bg-surface-2/50 text-foreground';
    case 'failed':
    case 'unavailable':
    case 'rate-limited':
      return 'border-danger/40 bg-danger/10 text-danger';
    case 'not-configured':
      return 'border-warning/40 bg-warning/10 text-warning';
    default:
      return 'border-border bg-surface-2/50 text-muted';
  }
}

function ProviderStatusChips({ providers, onRetry, busy, canRetry }: { providers: ProviderSearchStatus[]; onRetry: (source: string) => void; busy: string | null; canRetry: boolean }) {
  if (!providers.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" aria-label="Provider status for this search">
      {providers.map((p) => {
        const label = SOURCE_LABELS[p.source];
        const icon =
          p.status === 'success' || p.status === 'exhausted' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            : p.status === 'unsupported-query' || p.status === 'not-applicable' ? <Minus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              : p.status === 'not-configured' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                : <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
        const note = p.status === 'exhausted' ? 'complete'
          : p.status === 'success' ? 'searched'
            : p.status === 'not-applicable' ? 'not applicable'
              : p.message;
        return (
          <span key={p.source} role={p.status === 'failed' || p.status === 'unavailable' || p.status === 'rate-limited' || p.status === 'not-configured' ? 'alert' : undefined} className={cn('inline-flex max-w-full items-start gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs', chipClass(p.status))}>
            {icon}
            <span className="min-w-0 break-words">
              <span className="font-medium">{label}</span>
              {note ? <>: <span className="break-words">{note}</span></> : null}
              {p.status === 'not-configured' && (
                <Link to={EHENTAI_ACCOUNT_SETTINGS_URL} className="ml-1 underline underline-offset-2 hover:opacity-80">save the account</Link>
              )}
            </span>
            {(p.status === 'failed' || p.status === 'unavailable' || p.status === 'rate-limited') && p.retryable && (
              <Button size="sm" variant="ghost" className="h-6 min-h-6 shrink-0 px-2 text-xs" disabled={busy !== null || !canRetry} onClick={() => onRetry(p.source)}>
                {busy === p.source ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Retry
              </Button>
            )}
          </span>
        );
      })}
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

export interface UnifiedSelectionActions {
  items: DoujinSearchResult[];
  onMerge: () => void;
  onMergeInto: () => void;
  onDownloadEach?: () => void;
  onSelectAll?: () => void;
  allSelected?: boolean;
  onRemove: (item: DoujinSearchResult) => void;
  onClear: () => void;
  onCancel: () => void;
}

interface UnifiedSearchTabProps {
  unified: UnifiedSearchValue;
  onOpenEntry: (entry: UnifiedSearchEntry) => void;
  onDownload: (item: DoujinSearchResult, entryId: string) => void;
  downloadStatus: DownloadSetup['status'];
  startingKeys: ReadonlySet<string>;
  ownershipFor: (entry: UnifiedSearchEntry) => GalleryOwnership;
  selectedEntryIds: Set<string>;
  onToggleGroup: (entry: UnifiedSearchEntry) => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  selectionActions: UnifiedSelectionActions;
  showSelection: boolean;
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
}: {
  entry: UnifiedSearchEntry;
  onOpenEntry: (entry: UnifiedSearchEntry) => void;
  onDownload: (item: DoujinSearchResult, entryId: string) => void;
  downloadStatus: DownloadSetup['status'];
  starting: boolean;
  ownership: GalleryOwnership;
  selectMode: boolean;
  selected: boolean;
  onToggleGroup: (entry: UnifiedSearchEntry) => void;
}) {
  const primary = React.useMemo(() => toWebResult(entry.primary), [entry.primary]);
  const provenance = React.useMemo(
    () => (entry.variants.length > 1 ? { extraSources: extraSources(entry) } : undefined),
    [entry],
  );
  const handleOpen = React.useCallback(() => onOpenEntry(entry), [onOpenEntry, entry]);
  const handleDownload = React.useCallback(() => onDownload(primary, entry.entryId), [onDownload, primary, entry.entryId]);
  const handleToggle = React.useCallback(() => onToggleGroup(entry), [onToggleGroup, entry]);
  const selection = React.useMemo(
    () => ({ mode: (selectMode ? 'select' : 'browse') as 'select' | 'browse', selected, onToggle: handleToggle }),
    [selectMode, selected, handleToggle],
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
    />
  );
});

export function UnifiedSearchTab({ unified, onOpenEntry, onDownload, downloadStatus, startingKeys, ownershipFor, selectedEntryIds, onToggleGroup, selectMode, onToggleSelectMode, selectionActions, showSelection }: UnifiedSearchTabProps) {
  const { draft, committed, status, entries, cursor, hasMore, loadedUniqueCount, totalUnique, providers, error, retrying } = unified;
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
      unified.setDraft(formDraft);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [formDraft, unified]);
  const busy = status === 'searching' || status === 'loading-more';
  const failedProviders = providers.filter((p) => p.status === 'failed' || p.status === 'unavailable' || p.status === 'rate-limited');
  const okProviders = providers.filter((p) => p.status === 'success' || p.status === 'exhausted');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = formDraft.trim();
    if (!q) return;
    syncedDraftRef.current = q;
    unified.setDraft(q);
    unified.startSearch(q);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-2">
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
            <GallerySearchInput
              value={formDraft} source="unified"
              onChange={setFormDraft}
              label="Search galleries" describedBy="unified-search-hint"
              placeholder="Search all sources, e.g. sister or artist:foo -bar"
              clearLabel="Clear search input" className="h-11"
            />
            <Button className="shrink-0 sm:h-11" type="submit" disabled={busy || !formDraft.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
            </Button>
          </form>
          <SearchHint id="unified-search-hint" scope="all" />
        </CardContent>
      </Card>

      {committed === null && (
        <Card className="flex items-center justify-center">
          <EmptyState
            icon={<Search className="h-8 w-8" />}
            title="Search every source at once"
            description="Every source a work was found on stays visible on its card. A bare numeric ID is ambiguous across sources, so paste the full gallery URL instead."
          />
        </Card>
      )}

      {error && committed !== null && (
        <Card>
          <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center">
            <XCircle className="h-8 w-8 text-danger" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{error.kind === 'session' ? 'This search session can’t continue' : 'Search rejected'}</p>
              <p className="max-w-lg break-words text-sm text-muted">{error.message}</p>
            </div>
            <Button onClick={() => unified.startSearch(committed ?? draft)}>
              <Search className="h-4 w-4" /> Search again
            </Button>
          </div>
        </Card>
      )}

      {committed !== null && !error && status === 'searching' && (
        <GallerySkeletonGrid label="Searching all sources" />
      )}

      {committed !== null && !error && status !== 'searching' && entries.length === 0 && (
        okProviders.length === 0 && failedProviders.length > 0 ? (
          <Card>
            <div role="alert" className="flex flex-col gap-3 py-8">
              <p className="text-sm font-medium">Every source failed this search</p>
              <ProviderStatusChips providers={providers} onRetry={(s) => unified.retrySource(s)} busy={retrying} canRetry={!!cursor} />
              <p className="text-xs text-muted">Nothing was found — and no source answered successfully, so this isn’t a true zero-result.</p>
            </div>
          </Card>
        ) : (
          <Card className="flex items-center justify-center">
            <EmptyState
              icon={<Search className="h-8 w-8" />}
              title="No results"
              description={
                okProviders.length
                  ? `No galleries for “${committed}” on ${okProviders.map((p) => SOURCE_LABELS[p.source]).join(', ')}.${failedProviders.length ? ` ${failedProviders.length === 1 ? '1 source' : `${failedProviders.length} sources`} did not answer, so more may exist.` : ''}`
                  : `No galleries for “${committed}”.`
              }
            />
          </Card>
        )
      )}

      {committed !== null && !error && entries.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-col gap-2">
              <p role="status" className="text-sm text-muted">
                {busy ? 'Loading…' : `${loadedUniqueCount} unique ${loadedUniqueCount === 1 ? 'gallery' : 'galleries'} loaded`}
                {totalUnique !== null && ` · ${totalUnique} total`}
              </p>
              <ProviderStatusChips providers={providers} onRetry={(s) => unified.retrySource(s)} busy={retrying} canRetry={!!cursor} />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant={selectMode ? 'default' : 'outline'} aria-pressed={selectMode} onClick={onToggleSelectMode}>
                <CheckSquare className="h-3.5 w-3.5" /> {selectMode ? 'Done selecting' : 'Select galleries'}
              </Button>
            </div>
          </div>
          {showSelection && <GallerySelectionBar {...selectionActions} />}
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {entries.map((entry) => (
              <UnifiedEntryCard
                key={entry.entryId}
                entry={entry}
                onOpenEntry={onOpenEntry}
                onDownload={onDownload}
                downloadStatus={downloadStatus}
                starting={startingKeys.has(`${entry.primary.source}:${entry.primary.galleryId}`)}
                ownership={ownershipFor(entry)}
                selectMode={selectMode}
                selected={selectedEntryIds.has(entry.entryId)}
                onToggleGroup={onToggleGroup}
              />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button variant="outline" className="min-h-11" onClick={() => unified.loadMore()} disabled={status !== 'idle'}>
                {status === 'loading-more' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {status === 'loading-more' ? 'Loading more…' : `Load more — ${loadedUniqueCount} unique loaded`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
