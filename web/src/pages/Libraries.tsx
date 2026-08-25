import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Search, LayoutGrid, Table2, Sparkles, RefreshCw, Play, Eraser, BookOpen, Unlink, ArrowUpRight, FileText, Combine, Check } from 'lucide-react';
import { api, type SeriesRow, type DoujinSource } from '../lib/api';
import { Button, Card, Input, Select, Badge, StatusBadge, ProviderBadge, Spinner, EmptyState, Switch } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { ComicInfoModal } from '../components/ComicInfoModal';
import { MergeSeriesModal } from '../components/MergeSeriesModal';
import { buildTagSearchFragment } from './Downloader';
import { cn, timeAgo } from '../lib/utils';
import { toast } from '../lib/toast';
/** Matches below this score are surfaced for review (mirrors the server's threshold). */
const LOW_CONFIDENCE = 0.8;

function Cover({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  // Covers may be absolute provider URLs or same-origin relative paths
  // (e.g. the Kavita proxy at /api/kavita/series/{id}/cover). Fall back to a
  // letter placeholder when there is no URL or the image fails to load
  // (e.g. Kavita returns 404 because the cover file is missing on disk).
  const showImage = !failed && src !== null && src !== undefined && src !== '' && (/^https?:\/\//i.test(src) || src.startsWith('/'));
  if (showImage) {
    return <img src={src} alt={name} className={cn('h-full w-full object-cover', className)} loading="lazy" onError={() => setFailed(true)} />;
  }
  return (
    <div className={cn('flex h-full w-full items-center justify-center bg-surface-2 text-2xl font-semibold text-muted', className)}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
const ARTIST_SOURCE_META: Record<DoujinSource, { label: string; color: string }> = {
  hitomi: { label: 'Hitomi.la', color: '#ff5722' },
  nhentai: { label: 'nHentai', color: '#e91e63' },
};

/**
 * One-click deep link into the Downloader with an artist search pre-filled for
 * this series. Uses the first artist (doujin titles are usually a single
 * circle); the tooltip lists every known artist.
 *
 * variant "pill" — always-visible bordered pill (table view).
 * variant "bar"  — dark button for the grid card's hover action bar.
 */
function ArtistSearchButton({ source, artists, variant = 'pill' }: { source: DoujinSource; artists: string[]; variant?: 'pill' | 'bar' }) {
  const navigate = useNavigate();
  const primary = artists[0];
  const fragment = buildTagSearchFragment(primary, 'artist', source);
  if (!fragment) return null;
  const meta = ARTIST_SOURCE_META[source];
  const target = artists.length > 1 ? `${artists.join(', ')} (first: ${primary})` : `“${primary}”`;
  const title = `Search artist ${target} on ${meta.label}`;
  if (variant === 'bar') {
    return (
      <button
        type="button"
        onClick={() => navigate(`/downloader?source=${source}&q=${encodeURIComponent(fragment)}`)}
        title={title}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-black/70 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm transition-all duration-150 hover:border-primary hover:bg-primary"
      >
        <Search className="h-3 w-3" />
        <span className="max-w-28 truncate">“{primary}”</span>
        <span className="font-normal text-white/60">· {meta.label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => navigate(`/downloader?source=${source}&q=${encodeURIComponent(fragment)}`)}
      title={title}
      className="group/artist inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-all duration-150 hover:-translate-y-px hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      style={{ borderColor: meta.color + '8c', backgroundColor: meta.color + '33' }}
    >
      <Search className="h-3 w-3" />
      <span className="max-w-24 truncate">{primary}</span>
      <span style={{ color: meta.color }}>{meta.label}</span>
      <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity duration-150 group-hover/artist:opacity-100" style={{ color: meta.color }} />
    </button>
  );
}

export function Libraries() {
  const { libraryId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [selected, setSelected] = React.useState<number | null>(libraryId ? Number(libraryId) : null);
  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [view, setView] = React.useState<'grid' | 'table'>('grid');
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [identify, setIdentify] = React.useState<{ id: number; name: string } | null>(null);
  const [comicInfo, setComicInfo] = React.useState<{ id: number; name: string } | null>(null);
  const [mergeOpen, setMergeOpen] = React.useState(false);

  React.useEffect(() => {
    if (libraryId) setSelected(Number(libraryId));
  }, [libraryId]);

  const pickLibrary = (id: number) => {
    setSelected(id);
    setChecked(new Set());
    navigate(`/libraries/${id}`);
  };

  const libs = useQuery({ queryKey: ['libraries'], queryFn: api.libraries, enabled: selected === null || true });
  const series = useQuery({
    queryKey: ['library-series', selected],
    queryFn: () => api.librarySeries(selected!),
    enabled: selected !== null,
    refetchInterval: 5000,
  });
  const currentMeta = useQuery({
    queryKey: ['series', identify?.id],
    queryFn: () => api.series(identify!.id),
    enabled: identify !== null,
  });
  const override = useQuery({
    queryKey: ['library-override', selected],
    queryFn: () => api.libraryOverride(selected!),
    enabled: selected !== null,
  });

  // /libraries no longer has an "all" view — land on the first library once loaded.
  React.useEffect(() => {
    if (selected === null && libs.data && libs.data.length > 0) {
      navigate(`/libraries/${libs.data[0].id}`, { replace: true });
    }
  }, [libs.data, selected, navigate]);

  const rows = series.data ?? [];
  const filtered = rows.filter((r) => {
    const okStatus =
      statusFilter === 'all' ? true :
      statusFilter === 'low-score' ? (r.status === 'matched' && typeof r.matchScore === 'number' && r.matchScore < LOW_CONFIDENCE) :
      r.status === statusFilter;
    const okQuery = query ? r.name.toLowerCase().includes(query.toLowerCase()) : true;
    return okStatus && okQuery;
  });
  const isFiltering = statusFilter !== 'all' || query.trim() !== '';

  const toggleCheck = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allChecked = filtered.length > 0 && filtered.every((r) => checked.has(r.id));

  const enqueue = (type: string, payload: Record<string, unknown> = {}) => {
    return api.enqueue(type, payload).then(() => qc.invalidateQueries({ queryKey: ['jobs'] }));
  };
  const matchSelected = () => enqueue('match-series', { seriesIds: [...checked] });
  const refreshSelected = () => enqueue('sync-series', { seriesIds: [...checked] });
  const clearOverrides = () => enqueue('clear-overrides', selected !== null ? { libraryId: selected } : {});
  const setAutoMatch = (c: boolean) => {
    if (selected === null) return;
    void api.saveLibraryOverride(selected, { autoMatch: c }).then(() => qc.invalidateQueries({ queryKey: ['library-override', selected] }));
  };

  const unmatch = useMutation({
    mutationFn: (row: SeriesRow) => api.unmatch(row.id),
    onSuccess: (_res, row) => {
      qc.invalidateQueries({ queryKey: ['library-series'] });
      qc.invalidateQueries({ queryKey: ['libraries'] });
      toast({ tone: 'success', title: 'Unmatched', description: row.name });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Unmatch failed', description: e instanceof Error ? e.message : String(e) }),
  });

  const matchedInLib = rows.filter((r) => r.status === 'matched').length;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* View tabs — one per Kavita library, same treatment as Settings/Downloader */}
      {libs.data && libs.data.length > 0 ? (
        <div className="flex items-end gap-4 self-start border-b border-border-2">
          {libs.data.map((lib) => (
            <button
              key={lib.id}
              type="button"
              onClick={() => pickLibrary(lib.id)}
              className={cn(
                '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
                selected === lib.id ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground',
              )}
            >
              {lib.name}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pb-1.5">
            <Button size="sm" variant="outline" onClick={() => enqueue('match-unmatched', { libraryId: selected })} disabled={selected === null}>
              <Play className="h-3.5 w-3.5" /> Match all unmatched
            </Button>
            <Button size="sm" onClick={() => enqueue('scan-new', { libraryId: selected })} disabled={selected === null}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh Kavita Library
            </Button>
          </div>
        </div>
      ) : (
        <div className="self-start border-b border-border-2 pb-2 text-sm text-muted">
          {libs.isLoading ? 'Loading libraries…' : 'No libraries — connect Kavita in Settings.'}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {selected === null ? (
          <Card className="flex flex-1 items-center justify-center">
            <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Select a library" description="Pick a Kavita library above to browse and identify its series." />
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold">{series.data ? (isFiltering ? `${filtered.length} of ${rows.length} series` : `${rows.length} series`) : 'Loading…'}</h1>
                <p className="text-xs text-muted">
                  {matchedInLib} matched · {rows.length - matchedInLib} pending
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex cursor-pointer select-none items-center gap-2 rounded-md border border-border-2 px-3 py-2 text-xs font-medium text-muted" title="Automatically match new series in this library during scans">
                  Auto-match
                  <Switch checked={override.data?.autoMatch ?? true} onCheckedChange={setAutoMatch} />
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
                  <Input placeholder="Filter series…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-52 pl-8" />
                </div>
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-40">
                  <option value="all">All</option>
                  <option value="matched">Matched</option>
                  <option value="unmatched">Unmatched</option>
                  <option value="syncing">Syncing</option>
                  <option value="failed">Failed</option>
                  <option value="low-score">Low confidence (&lt;80%)</option>
                </Select>
                <div className="flex overflow-hidden rounded-md border border-border-2">
                  <button onClick={() => setView('grid')} className={cn('p-2', view === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2')}>
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                  <button onClick={() => setView('table')} className={cn('p-2', view === 'table' ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surface-2')}>
                    <Table2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {checked.size > 0 && (
              <div className="flex animate-scale-in flex-wrap items-center gap-2 rounded-lg border border-border-2 bg-surface-2 p-2 shadow-lg shadow-black/20">
                <span className="px-2 text-xs text-muted">{checked.size} selected</span>
                <Button size="sm" onClick={matchSelected}>
                  <Sparkles className="h-3.5 w-3.5" /> Match selected
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)} disabled={checked.size < 2} title={checked.size < 2 ? 'Select at least two series' : undefined}>
                  <Combine className="h-3.5 w-3.5" /> Merge selected
                </Button>
                <Button size="sm" variant="secondary" onClick={refreshSelected}>
                  <RefreshCw className="h-3.5 w-3.5" /> Force refresh
                </Button>
                <Button size="sm" variant="ghost" onClick={clearOverrides}>
                  <Eraser className="h-3.5 w-3.5" /> Clear overrides
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                  Clear selection
                </Button>
              </div>
            )}

            {series.isLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 py-16 text-muted">
                <Spinner /> Loading series…
              </div>
            ) : filtered.length === 0 ? (
              <Card className="flex flex-1 items-center justify-center">
                <EmptyState title="No series" description="No series match the current filters." />
              </Card>
            ) : view === 'grid' ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {filtered.map((r, i) => (
                  <Card
                    key={r.id}
                    style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                    className={cn(
                      'group relative animate-fade-up cursor-pointer overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:shadow-xl hover:shadow-black/30',
                      r.aligned && 'ring-2 ring-success',
                      checked.has(r.id) && 'border-primary/60 ring-1 ring-primary',
                    )}
                  >
                    <button
                      className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIdentify({ id: r.id, name: r.name });
                      }}
                      aria-label="Identify"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCheck(r.id);
                      }}
                      title={checked.has(r.id) ? 'Deselect series' : 'Select series'}
                      aria-pressed={checked.has(r.id)}
                      className={cn(
                        'card-check-btn absolute bottom-2 left-2 z-30 flex h-6 w-6 items-center justify-center rounded-full border transition-all duration-150',
                        checked.has(r.id)
                          ? 'card-check-btn-checked border-primary bg-primary text-white'
                          : 'border-white/50 bg-black/50 text-transparent hover:border-primary hover:text-primary/70',
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setComicInfo({ id: r.id, name: r.name });
                      }}
                      title="Edit ComicInfo.xml"
                      className="card-cbz-btn absolute right-1.5 top-1.5 z-30 rounded-lg border border-white/15 bg-black/70 p-1.5 text-white backdrop-blur-sm transition-all duration-150 hover:border-primary hover:bg-primary"
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </button>
                    <div className="aspect-[3/4] w-full overflow-hidden">
                      <Cover src={r.cover} name={r.name} className="transition-transform duration-300 ease-out group-hover:scale-105" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-black/90 to-transparent p-2 pt-6">
                      <p className="truncate text-xs font-semibold text-white [text-shadow:1px_0_0_rgba(0,0,0,0.85),-1px_0_0_rgba(0,0,0,0.85),0_1px_0_rgba(0,0,0,0.85),0_-1px_0_rgba(0,0,0,0.85),0_2px_3px_rgba(0,0,0,0.6)]">{r.name}</p>
                      <div className="flex flex-wrap items-center gap-1 pl-7">
                        {r.providerId && <ProviderBadge id={r.providerId} solid />}
                        <StatusBadge status={r.status} title={r.errorMessage ?? undefined} className="bg-black/70" />
                      </div>
                      {r.artists?.length ? (
                        // Action bar revealed on hover/focus: explicit buttons instead of badge-like pills.
                        <div className="artist-action-bar flex max-h-0 flex-wrap gap-1 overflow-hidden pl-7 opacity-0 transition-all duration-200 group-hover:max-h-16 group-hover:opacity-100">
                          <ArtistSearchButton source="hitomi" artists={r.artists} variant="bar" />
                          <ArtistSearchButton source="nhentai" artists={r.artists} variant="bar" />
                        </div>
                      ) : null}
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-xs text-muted">
                    <tr>
                      <th className="w-10 p-2">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={() => setChecked(allChecked ? new Set() : new Set(filtered.map((r) => r.id)))}
                          className="h-4 w-4 accent-[var(--color-primary)]"
                        />
                      </th>
                      <th className="p-2 text-left font-medium">Series</th>
                      <th className="p-2 text-left font-medium">Status</th>
                      <th className="p-2 text-left font-medium">Provider</th>
                      <th className="p-2 text-left font-medium">Score</th>
                      <th className="p-2 text-left font-medium">Synced</th>
                      <th className="min-w-56 p-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2/50">
                        <td className="p-2">
                          <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggleCheck(r.id)} className="h-4 w-4 accent-[var(--color-primary)]" />
                        </td>
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <div className="h-9 w-6 overflow-hidden rounded bg-surface-2">
                              <Cover src={r.cover} name={r.name} />
                            </div>
                            <span className="font-medium">{r.name}</span>
                          </div>
                        </td>
                        <td className="p-2">
                          <StatusBadge status={r.status} title={r.errorMessage ?? undefined} />
                        </td>
                        <td className="p-2">
                          {r.providerId ? (
                            <div className="flex items-center gap-1.5">
                              <ProviderBadge id={r.providerId} />
                              {r.aligned && <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">Aligned</span>}
                            </div>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="p-2 text-muted">
                          {r.matchScore ? (
                            <span
                              className={cn('tabular-nums', r.status === 'matched' && r.matchScore < LOW_CONFIDENCE && 'font-medium text-warning')}
                              title={r.status === 'matched' && r.matchScore < LOW_CONFIDENCE ? `Low confidence (${Math.round(r.matchScore * 100)}%) — review via the “Low confidence” filter` : undefined}
                            >
                              {Math.round(r.matchScore * 100)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="p-2 text-xs text-muted">{timeAgo(r.lastSyncedAt)}</td>
                        <td className="p-2 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {r.artists?.length ? (
                              <>
                                <ArtistSearchButton source="hitomi" artists={r.artists} />
                                <ArtistSearchButton source="nhentai" artists={r.artists} />
                              </>
                            ) : null}
                            {r.providerId && (
                              <Button size="sm" variant="ghost" onClick={() => unmatch.mutate(r)} disabled={unmatch.isPending} title="Remove the match and clear metadata and covers previously applied by H-Tosho from Kavita">
                                <Unlink className="h-3.5 w-3.5" /> Unmatch
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setComicInfo({ id: r.id, name: r.name })} title="Edit the ComicInfo.xml of this series' .cbz files">
                              <FileText className="h-3.5 w-3.5" /> ComicInfo
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setIdentify({ id: r.id, name: r.name })}>
                              <Sparkles className="h-3.5 w-3.5" /> Identify
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}
      </div>

      {identify && (
        <IdentifyModal
          seriesId={identify.id}
          current={{
            name: currentMeta.data?.series.name ?? identify.name,
            sortName: currentMeta.data?.series.sortName,
            metadata: currentMeta.data?.kavita ?? null,
          }}
          match={currentMeta.data?.match ?? null}
          onClose={() => setIdentify(null)}
        />
      )}

      {comicInfo && (
        <ComicInfoModal seriesId={comicInfo.id} onClose={() => setComicInfo(null)} />
      )}

      {mergeOpen && (
        <MergeSeriesModal
          selected={(series.data ?? []).filter((r) => checked.has(r.id))}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </div>
  );
}