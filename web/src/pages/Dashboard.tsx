import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Library as LibraryIcon,
  Server,
  ListChecks,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  LayoutDashboard,
  ArrowRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle, Skeleton, EmptyState, Badge, StatusBadge, PageHeader } from '../components/ui';
import { pct, timeAgo } from '../lib/utils';
export function Dashboard() {
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
    { label: 'Matched', value: matched, icon: <CheckCircle2 className="h-4 w-4" />, tone: 'bg-success/10 text-success', sub: total ? pct(matched, total) + '% of tracked series' : '' },
    { label: 'Unmatched', value: unmatched, icon: <HelpCircle className="h-4 w-4" />, tone: 'bg-surface-2 text-muted', sub: 'awaiting identification' },
    { label: 'Failed', value: failed, icon: <AlertTriangle className="h-4 w-4" />, tone: 'bg-danger/10 text-danger', sub: 'need attention' },
    { label: 'Active Jobs', value: stats?.activeJobs ?? 0, icon: <ListChecks className="h-4 w-4" />, tone: 'bg-info/10 text-info', sub: 'queued / running' },
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
      <PageHeader icon={<LayoutDashboard className="h-5 w-5" />} title="Dashboard" subtitle="Overview of your Kavita metadata sync.">
        {kavita?.configured === false && (
          <Badge tone="warning">
            <Server className="h-3 w-3" /> Kavita not configured — set it up in Settings
          </Badge>
        )}
        {kavita?.configured && !kavita.error && (
          <Badge tone="success">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-success" /> Kavita {kavita.version ?? ''} connected
          </Badge>
        )}
        {kavita?.configured && kavita.error && (
          <Badge tone="danger">
            <AlertTriangle className="h-3 w-3" /> {kavita.error}
          </Badge>
        )}
      </PageHeader>

      {isLoading && !stats ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[7.5rem]" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {cards.map((c, i) => (
            <Card
              key={c.label}
              style={{ animationDelay: `${i * 60}ms` }}
              className="group animate-fade-up transition-all duration-200 hover:-translate-y-0.5 hover:border-border-2 hover:shadow-lg hover:shadow-black/20"
            >
              <CardContent className="flex flex-col gap-3 p-4">
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-110 ${c.tone}`}>
                  {c.icon}
                </div>
                <div>
                  <span className="block text-3xl font-semibold tabular-nums tracking-tight">{c.value}</span>
                  <span className="mt-0.5 block text-sm text-muted">{c.label}</span>
                  <span className="block text-xs text-muted/70">{c.sub}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="animate-fade-up" style={{ animationDelay: '240ms' }}>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <LibraryIcon className="h-4 w-4" /> Recent jobs
          </CardTitle>
          <Link to="/jobs" className="group flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-hover">
            View all <ArrowRight className="h-3 w-3 transition-transform duration-150 group-hover:translate-x-0.5" />
          </Link>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {!stats?.recentJobs || stats.recentJobs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No jobs yet. Trigger a scan or match from the Libraries tab.</p>
          ) : (
            stats.recentJobs.map((j, i) => (
              <div
                key={j.id}
                style={{ animationDelay: `${280 + i * 40}ms` }}
                className="flex animate-fade-up items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2/50"
              >
                <StatusBadge status={j.status} />
                <span className="w-40 truncate text-sm">{j.type}</span>
                {j.progressTotal > 0 && (
                  <span className="text-xs tabular-nums text-muted">
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
