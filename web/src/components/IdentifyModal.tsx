import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, AlertTriangle, Check, X, ArrowRight } from 'lucide-react';
import { api, type MatchOutcome, type SeriesMetadata } from '../lib/api';
import { PROVIDER_NAMES, cn } from '../lib/utils';
import { Button, Dialog, DialogContent, Label, ProviderBadge, Spinner } from './ui';

interface IdentifyModalProps {
  seriesId: number;
  seriesName: string;
  currentMetadata: SeriesMetadata | null;
  onClose: () => void;
}

function FieldRow({ label, current, candidate }: { label: string; current: string; candidate: string }) {
  const differs = current.trim().toLowerCase() !== candidate.trim().toLowerCase();
  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border py-1.5 text-xs last:border-0">
      <div className="flex items-center gap-1.5">
        <span className="w-20 shrink-0 text-muted">{label}</span>
        <span className={cn('truncate', differs && 'text-muted line-through')} title={current}>
          {current || '—'}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className={cn('truncate font-medium', differs && 'text-primary')} title={candidate}>
          {candidate || '—'}
        </span>
      </div>
    </div>
  );
}

export function IdentifyModal({ seriesId, seriesName, currentMetadata, onClose }: IdentifyModalProps) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const identify = useQuery({
    queryKey: ['identify', seriesId],
    queryFn: () => api.identify(seriesId),
    staleTime: 60_000,
  });

  const apply = useMutation({
    mutationFn: (ids: { providerId: string; providerSeriesId: string }) => api.apply(seriesId, ids.providerId, ids.providerSeriesId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      qc.invalidateQueries({ queryKey: ['library-series'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['libraries'] });
      onClose();
    },
  });

  const outcome: MatchOutcome | undefined = identify.data;
  const selected = outcome?.candidates.find((c) => c.providerId + ':' + c.providerSeriesId === selectedId);
  const autoBest = outcome?.best;

  const diff = React.useMemo(() => {
    if (!selected) return null;
    const cur = currentMetadata;
    return {
      title: { current: cur?.title ?? seriesName, candidate: selected.title },
      type: { current: cur?.type ?? '', candidate: selected.type },
      year: { current: cur?.year ? String(cur.year) : '', candidate: selected.year ? String(selected.year) : '' },
      summary: { current: cur?.summary ?? '', candidate: selected.summary ?? '' },
    };
  }, [selected, currentMetadata, seriesName]);

  const doApply = (ids: { providerId: string; providerSeriesId: string }) => {
    apply.mutate(ids);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Identify "{seriesName}"</h2>
          </div>

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
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/30 bg-success/10 p-3">
                  <div className="flex items-center gap-3">
                    <Check className="h-4 w-4 text-success" />
                    <div>
                      <p className="text-sm font-medium">
                        Auto-matched to {PROVIDER_NAMES[autoBest.providerId] ?? autoBest.providerId} · {Math.round(autoBest.score)}%
                      </p>
                      <p className="text-xs text-muted">{autoBest.title}</p>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => doApply({ providerId: autoBest.providerId, providerSeriesId: autoBest.providerSeriesId })} disabled={apply.isPending}>
                    {apply.isPending ? <Spinner /> : <ArrowRight className="h-3.5 w-3.5" />} Apply & Sync
                  </Button>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Label className="text-sm">All candidates</Label>
                <div className="text-xs text-muted">{outcome.candidates.length} found</div>
              </div>

              <div className="max-h-[46vh] overflow-y-auto rounded-md border border-border">
                {outcome.candidates.length === 0 && <p className="p-4 text-sm text-muted">No candidates found across providers.</p>}
                {outcome.candidates.map((c) => {
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
                        {c.coverUrl ? <img src={c.coverUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Search className="h-4 w-4 text-muted" />}
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
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <div className="w-24" />
                    <div className="text-xs font-semibold text-muted">Current (Kavita)</div>
                    <div className="flex-1 text-xs font-semibold text-primary">
                      {PROVIDER_NAMES[selected.providerId] ?? selected.providerId} (candidate)
                    </div>
                  </div>
                  <div className="px-3">
                    <FieldRow label="Title" current={diff.title.current} candidate={diff.title.candidate} />
                    <FieldRow label="Type" current={diff.type.current} candidate={diff.type.candidate} />
                    <FieldRow label="Year" current={diff.year.current} candidate={diff.year.candidate} />
                    <FieldRow label="Summary" current={diff.summary.current} candidate={diff.summary.candidate} />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button
                  onClick={() => selected && doApply({ providerId: selected.providerId, providerSeriesId: selected.providerSeriesId })}
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
  );
}