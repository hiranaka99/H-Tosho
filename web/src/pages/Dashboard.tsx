import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Library as LibraryIcon,
  Server,
  ListChecks,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle, Spinner, EmptyState, Badge, StatusBadge } from '../components/ui';
import { pct, timeAgo } from '../lib/utils';

export function Dashboard() {
  const qc = useQueryClient();
  const { data: stats, isLoading, isError, error } = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
    refetchInterval: 4000,
  });
  const { data: kavita } = useQuery({ queryKey: ['kavita-status'], queryFn: api.kavitaStatus, refetchInterval: 30_000 });

  const by = stats?.byStatus ?? {};
  const matched = by.matched ?? 0;
  const unmatched = by.unmatched ?? 0;
  const failed = by.failed ?? 0;
  const total = stats?.totalSeries ?? 0;

  const cards = [
    { label: 'Matched', value: matched, icon: <CheckCircle2 className="h-5 w-5 text-success" />, sub: total ? pct(matched, total) + '% of tracked series' : '' },
    { label: 'Unmatched', value: unmatched, icon: <HelpCircle className="h-5 w-5 text-muted" />, sub: 'awaiting identification' },
    { label: 'Failed', value: failed, icon: <AlertTriangle className="h-5 w-5 text-danger" />, sub: 'need attention' },
    { label: 'Active Jobs', value: stats?.activeJobs ?? 0, icon: <ListChecks className="h-5 w-5 text-info" />, sub: 'queued / running' },
  ];

  if (isError) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-8 w-8" />}
        title="Backend unreachable"
        description={error instanceof Error ? error.message : String(error)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted">Overview of your Kavita metadata sync.</p>
        </div>
        <div className="flex items-center gap-2">
          {kavita?.configured === false && (
            <Badge tone="warning">
              <Server className="h-3 w-3" /> Kavita not configured — set it up in Settings
            </Badge>
          )}
          {kavita?.configured && !kavita.error && (
            <Badge tone="success">
              <Server className="h-3 w-3" /> Kavita {kavita.version ?? ''} connected
            </Badge>
          )}
          {kavita?.configured && kavita.error && (
            <Badge tone="danger">
              <AlertTriangle className="h-3 w-3" /> {kavita.error}
            </Badge>
          )}
        </div>
      </div>

      {isLoading && !stats ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted">
          <Spinner /> Loading stats…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {cards.map((c) => (
            <Card key={c.label}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted">{c.label}</span>
                  {c.icon}
                </div>
                <span className="text-3xl font-semibold">{c.value}</span>
                <span className="text-xs text-muted">{c.sub}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <LibraryIcon className="h-4 w-4" /> Recent jobs
          </CardTitle>
          <Link to="/jobs" className="text-xs text-primary hover:underline">
            View all →
          </Link>
        </CardHeader>
        <CardContent className="flex flex-col">
          {!stats?.recentJobs || stats.recentJobs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No jobs yet. Trigger a scan or match from the Libraries tab.</p>
          ) : (
            stats.recentJobs.map((j) => (
              <div key={j.id} className="flex items-center gap-3 border-b border-border py-2 last:border-0">
                <StatusBadge status={j.status} />
                <span className="w-40 text-sm">{j.type}</span>
                {j.progressTotal > 0 && (
                  <span className="text-xs text-muted">
                    {j.progressCurrent}/{j.progressTotal}
                  </span>
                )}
                <span className="flex-1" />
                {j.errorMessage && (
                  <span className="max-w-[30%] truncate text-xs text-danger" title={j.errorMessage}>
                    {j.errorMessage}
                  </span>
                )}
                <span className="text-xs text-muted">{timeAgo(j.finishedAt ?? j.createdAt)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}