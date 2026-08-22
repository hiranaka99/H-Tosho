import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, LayoutGrid, Table2, Sparkles, RefreshCw, Eraser, BookOpen, ArrowLeft, ChevronRight } from 'lucide-react';
import { api, type SeriesRow } from '../lib/api';
import { Button, Card, Input, Select, Badge, StatusBadge, ProviderBadge, Spinner, EmptyState } from '../components/ui';
import { IdentifyModal } from '../components/IdentifyModal';
import { cn, timeAgo } from '../lib/utils';

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

  React.useEffect(() => {
    if (libraryId) setSelected(Number(libraryId));
  }, [libraryId]);

  const pickLibrary = (id: number | null) => {
    setSelected(id);
    setChecked(new Set());
    navigate(id === null ? '/libraries' : `/libraries/${id}`);
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

  const rows = series.data ?? [];
  const filtered = rows.filter((r) => {
    const okStatus = statusFilter === 'all' ? true : r.status === statusFilter;
    const okQuery = query ? r.name.toLowerCase().includes(query.toLowerCase()) : true;
    return okStatus && okQuery;
  });

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

  const matchedInLib = rows.filter((r) => r.status === 'matched').length;

  return (
    <div className="flex h-full gap-4">
      <div className="w-60 shrink-0">
        <Card className="h-full">
          <div className="flex items-center justify-between border-b border-border p-3">
            <span className="text-xs font-semibold text-muted">LIBRARIES</span>
            {selected !== null && (
              <button onClick={() => pickLibrary(null)} className="flex items-center gap-1 text-xs text-muted hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> All
              </button>
            )}
          </div>
          <div className="max-h-[calc(100vh-8rem)] overflow-y-auto p-2">
            {libs.isLoading && (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            )}
            {libs.data?.map((lib) => {
              const active = selected === lib.id;
              return (
                <button
                  key={lib.id}
                  onClick={() => pickLibrary(lib.id)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
                    active ? 'bg-primary/15 text-primary' : 'hover:bg-surface-2',
                  )}
                >
                  <span className="truncate">{lib.name}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
                </button>
              );
            })}
            {!libs.isLoading && (libs.data?.length ?? 0) === 0 && (
              <p className="p-4 text-center text-xs text-muted">No libraries — connect Kavita in Settings.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {selected === null ? (
          <Card className="flex flex-1 items-center justify-center">
            <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Select a library" description="Pick a Kavita library from the left to browse and identify its series." />
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold">{series.data ? `${rows.length} series` : 'Loading…'}</h1>
                <p className="text-xs text-muted">
                  {matchedInLib} matched · {rows.length - matchedInLib} pending
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
                  <Input placeholder="Filter series…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-52 pl-8" />
                </div>
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-32">
                  <option value="all">All</option>
                  <option value="matched">Matched</option>
                  <option value="unmatched">Unmatched</option>
                  <option value="syncing">Syncing</option>
                  <option value="failed">Failed</option>
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
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-2 bg-surface-2 p-2">
                <span className="px-2 text-xs text-muted">{checked.size} selected</span>
                <Button size="sm" onClick={matchSelected}>
                  <Sparkles className="h-3.5 w-3.5" /> Match selected
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
                {filtered.map((r) => (
                  <Card
                    key={r.id}
                    className={cn('group relative cursor-pointer overflow-hidden transition-colors hover:border-primary/50', checked.has(r.id) && 'ring-1 ring-primary')}
                    onClick={() => toggleCheck(r.id)}
                  >
                    <button
                      className="absolute inset-0 z-10"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIdentify({ id: r.id, name: r.name });
                      }}
                      aria-label="Identify"
                    />
                    <div className="aspect-[3/4] w-full">
                      <Cover src={r.cover} name={r.name} />
                    </div>
                    <div className="absolute left-2 top-2 z-20">
                      <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggleCheck(r.id)} className="h-4 w-4 accent-[var(--color-primary)]" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-black/90 to-transparent p-2 pt-6">
                      <p className="truncate text-xs font-medium text-white">{r.name}</p>
                      <div className="flex items-center gap-1">
                        <StatusBadge status={r.status} />
                        {r.providerId && <ProviderBadge id={r.providerId} />}
                      </div>
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
                      <th className="p-2 text-right font-medium">Actions</th>
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
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="p-2">{r.providerId ? <ProviderBadge id={r.providerId} /> : <span className="text-muted">—</span>}</td>
                        <td className="p-2 text-muted">{r.matchScore ? Math.round(r.matchScore) + '%' : '—'}</td>
                        <td className="p-2 text-xs text-muted">{timeAgo(r.lastSyncedAt)}</td>
                        <td className="p-2 text-right">
                          <Button size="sm" variant="outline" onClick={() => setIdentify({ id: r.id, name: r.name })}>
                            <Sparkles className="h-3.5 w-3.5" /> Identify
                          </Button>
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
        <IdentifyModal seriesId={identify.id} seriesName={identify.name} currentMetadata={currentMeta.data?.metadata ?? null} onClose={() => setIdentify(null)} />
      )}
    </div>
  );
}