import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal, Activity, Circle, XCircle, CheckCircle2, ListChecks, Ban, X, Inbox } from 'lucide-react';
import { api, type Job, type JobLog } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, EmptyState, ProgressBar, PageHeader, ErrorState, SegmentedTabs } from '../components/ui';
import { cn, timeAgo, shortDate, toIsoUtc, jobLabel } from '../lib/utils';
import { toast } from '../lib/toast';

function JobStatus({ status }: { status: string }) {
  if (status === 'running')
    return (
      <Badge tone="info">
        <Activity className="h-3 w-3 animate-pulse-soft" /> Running
      </Badge>
    );
  if (status === 'queued')
    return (
      <Badge tone="muted">
        <Circle className="h-3 w-3" /> Queued
      </Badge>
    );
  if (status === 'completed')
    return (
      <Badge tone="success">
        <CheckCircle2 className="h-3 w-3" /> Done
      </Badge>
    );
  if (status === 'cancelled')
    return (
      <Badge tone="muted">
        <Ban className="h-3 w-3" /> Cancelled
      </Badge>
    );
  return (
    <Badge tone="danger">
      <XCircle className="h-3 w-3" /> Failed
    </Badge>
  );
}


const LOG_COLOR: Record<string, string> = {
  info: 'text-muted',
  warn: 'text-warning',
  error: 'text-danger',
  success: 'text-success',
};

/** Render a job's result as compact human-facing metrics; raw details remain in logs. */
function jobResultText(j: Job): string {
  if (j.result == null) return j.errorMessage ?? '';
  if (typeof j.result === 'string') return j.result;
  if (typeof j.result !== 'object' || Array.isArray(j.result)) return String(j.result);
  return Object.entries(j.result as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}: ${String(value)}`)
    .join(' · ');
}

function LogConsole({ logs }: { logs: JobLog[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  return (
    <div ref={ref} className="h-64 overflow-y-auto rounded-md border border-border bg-black/40 p-3 font-mono text-xs">
      {logs.length === 0 ? (
        <p className="text-muted">No logs yet.</p>
      ) : (
        logs.map((l) => (
          <div key={l.id} className="flex animate-fade-in gap-2 py-0.5">
            <span className="shrink-0 text-muted/60">{new Date(toIsoUtc(l.createdAt)).toLocaleTimeString()}</span>
            <span className={cn('shrink-0 uppercase', LOG_COLOR[l.level] ?? 'text-muted')}>{l.level}</span>
            <span className="break-all">{l.message}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function Jobs() {
  const jobsQuery = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 2500 });
  const logsQuery = useQuery({ queryKey: ['logs'], queryFn: api.logs, refetchInterval: 2500 });
  const jobs = jobsQuery.data ?? [];
  const recentLogs = logsQuery.data ?? [];
  const [selected, setSelected] = React.useState<Job | null>(null);
  const { data: jobDetail } = useQuery({
    queryKey: ['job', selected?.id],
    queryFn: () => api.job(selected!.id),
    enabled: selected !== null,
    refetchInterval: 1500,
  });
  const qc = useQueryClient();
  const cancelJob = (id: number) => {
    void api.cancelJob(id).then(() => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['job', id] });
    }).catch((error) => toast({ tone: 'danger', title: 'Could not cancel job', description: error instanceof Error ? error.message : String(error) }));
  };

  type JobFilter = 'all' | 'active' | 'failed' | 'done';
  const [filter, setFilter] = React.useState<JobFilter>('all');
  const filters: readonly { id: JobFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'failed', label: 'Failed' },
    { id: 'done', label: 'Done' },
  ];
  const visibleJobs = jobs.filter((j) => {
    if (filter === 'all') return true;
    if (filter === 'active') return j.status === 'running' || j.status === 'queued';
    if (filter === 'failed') return j.status === 'failed';
    return j.status === 'completed' || j.status === 'cancelled';
  });

  if (jobsQuery.isError) {
    return <ErrorState title="Could not load jobs" description={jobsQuery.error instanceof Error ? jobsQuery.error.message : String(jobsQuery.error)} onRetry={() => void jobsQuery.refetch()} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={<ListChecks className="h-5 w-5" />}
        title="Activity & Jobs"
        subtitle="Background task queue and real-time logging console."
      />

      <Card>
        <CardHeader className="sticky top-0 z-10 flex-row flex-wrap items-center justify-between gap-3 rounded-t-xl bg-surface">
          <CardTitle>Task queue</CardTitle>
          <SegmentedTabs items={filters} value={filter} onChange={setFilter} label="Filter jobs" panelId="jobs-list" className="border-0" />
        </CardHeader>
        <CardContent id="jobs-list" role="tabpanel" aria-labelledby={`jobs-list-tab-${filter}`}>
          {jobs.length === 0 ? (
            <EmptyState icon={<ListChecks className="h-8 w-8" />} title="No jobs" description="Jobs appear here when you run a scan or match." />
          ) : visibleJobs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No {filter} jobs.</p>
          ) : (
            <>
              <div className="flex flex-col gap-2 md:hidden">
                {visibleJobs.map((job) => (
                  <button key={job.id} type="button" onClick={() => setSelected(job)} className="rounded-lg border border-border p-3 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
                    <div className="flex items-start justify-between gap-2"><div><span className="text-xs text-muted">#{job.id}</span><p className="font-medium">{jobLabel(job.type, job.payload)}</p></div><JobStatus status={job.status} /></div>
                    <div className="mt-2"><ProgressBar label={`${jobLabel(job.type, job.payload)} progress`} value={job.progressCurrent} max={job.progressTotal} className="h-1.5" /></div>
                    {jobResultText(job) && <p className="mt-2 line-clamp-2 text-xs text-muted">{jobResultText(job)}</p>}
                    <p className="mt-2 text-xs text-muted">{timeAgo(job.createdAt)}</p>
                  </button>
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="min-w-[760px] w-full text-sm">
                  <thead className="border-b border-border text-xs text-muted"><tr><th className="p-2 text-left font-medium">ID</th><th className="p-2 text-left font-medium">Type</th><th className="p-2 text-left font-medium">Status</th><th className="p-2 text-left font-medium">Progress</th><th className="p-2 text-left font-medium">Result</th><th className="p-2 text-left font-medium">Created</th><th className="p-2"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {visibleJobs.map((j) => (
                      <tr key={j.id} tabIndex={0} aria-label={`Open details for ${jobLabel(j.type, j.payload)}`} className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2/50" onClick={() => setSelected(j)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(j); } }}>
                        <td className="p-2 text-muted">#{j.id}</td><td className="p-2 font-medium">{jobLabel(j.type, j.payload)}</td><td className="p-2"><JobStatus status={j.status} /></td><td className="p-2"><ProgressBar label={`${jobLabel(j.type, j.payload)} progress`} value={j.progressCurrent} max={j.progressTotal} className="h-1.5" /></td><td className="max-w-xs truncate p-2 text-xs text-muted">{jobResultText(j)}</td><td className="p-2 text-xs text-muted">{timeAgo(j.createdAt)}</td><td className="p-2">{(j.status === 'running' || j.status === 'queued') && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); cancelJob(j.id); }}>Cancel</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-4 w-4" /> Logs
            </CardTitle>
            <span className="text-xs text-muted">{jobDetail ? `Job #${selected?.id}` : 'All jobs'}</span>
          </CardHeader>
          <CardContent>
            {jobDetail ? (
              <LogConsole logs={jobDetail.logs} />
            ) : (
              <LogConsole logs={recentLogs} />
            )}
            {jobDetail && (
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Back to all logs</Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {(() => {
              const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
              return active.length === 0 ? (
                <EmptyState icon={<Inbox className="h-7 w-7" />} title="No active jobs" description="Queued and running work appears here." />
              ) : (
                active.map((j) => (
                  <div key={j.id} className={cn('animate-fade-up rounded-lg border p-3 transition-colors', j.status === 'running' ? 'border-primary/40 bg-primary/5' : 'border-border')}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{jobLabel(j.type, j.payload)}</span>
                      <div className="flex items-center gap-2">
                        <JobStatus status={j.status} />
                        <Button size="sm" variant="ghost" onClick={() => cancelJob(j.id)}>
                          <X className="h-3.5 w-3.5" /> Cancel
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={j.progressCurrent} max={j.progressTotal} active />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {j.progressTotal ? `${j.progressCurrent} of ${j.progressTotal} series` : 'starting…'}
                    </p>
                  </div>
                ))
              );
            })()}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}