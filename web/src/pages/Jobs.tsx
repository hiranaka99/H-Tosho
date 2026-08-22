import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal, Activity, Circle, XCircle, CheckCircle2, ListChecks } from 'lucide-react';
import { api, type Job, type JobLog } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, EmptyState, Spinner } from '../components/ui';
import { cn, timeAgo, shortDate } from '../lib/utils';

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
  return (
    <Badge tone="danger">
      <XCircle className="h-3 w-3" /> Failed
    </Badge>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  if (!total) return <div className="h-1.5 w-full rounded-full bg-surface-2" />;
  const p = Math.min(100, Math.round((current / total) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: p + '%' }} />
    </div>
  );
}

const LOG_COLOR: Record<string, string> = {
  info: 'text-muted',
  warn: 'text-warning',
  error: 'text-danger',
  success: 'text-success',
};

/** Render a job's stored result (arbitrary JSON from the server) as displayable text. */
function jobResultText(j: Job): string {
  if (j.result != null) {
    return typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
  }
  return j.errorMessage ?? '';
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
          <div key={l.id} className="flex gap-2 py-0.5">
            <span className="shrink-0 text-muted/60">{new Date(l.createdAt).toLocaleTimeString()}</span>
            <span className={cn('shrink-0 uppercase', LOG_COLOR[l.level] ?? 'text-muted')}>{l.level}</span>
            <span className="break-all">{l.message}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function Jobs() {
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 2500 });
  const { data: recentLogs = [] } = useQuery({ queryKey: ['logs'], queryFn: api.logs, refetchInterval: 2500 });
  const [selected, setSelected] = React.useState<Job | null>(null);
  const { data: jobDetail } = useQuery({
    queryKey: ['job', selected?.id],
    queryFn: () => api.job(selected!.id),
    enabled: selected !== null,
    refetchInterval: 1500,
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ListChecks className="h-5 w-5" /> Activity & Jobs
        </h1>
        <p className="text-sm text-muted">Background task queue and real-time logging console.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Task queue</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <EmptyState icon={<ListChecks className="h-8 w-8" />} title="No jobs" description="Jobs appear here when you run a scan or match." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-xs text-muted">
                  <tr>
                    <th className="p-2 text-left font-medium">ID</th>
                    <th className="p-2 text-left font-medium">Type</th>
                    <th className="p-2 text-left font-medium">Status</th>
                    <th className="p-2 text-left font-medium">Progress</th>
                    <th className="p-2 text-left font-medium">Result</th>
                    <th className="p-2 text-left font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2/50" onClick={() => setSelected(j)}>
                      <td className="p-2 text-muted">#{j.id}</td>
                      <td className="p-2 font-medium">{j.type}</td>
                      <td className="p-2">
                        <JobStatus status={j.status} />
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <div className="w-32">
                            <ProgressBar current={j.progressCurrent} total={j.progressTotal} />
                          </div>
                          <span className="text-xs text-muted">
                            {j.progressTotal ? `${j.progressCurrent}/${j.progressTotal}` : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="max-w-[28%] truncate p-2 text-xs text-muted" title={jobResultText(j)}>
                        {jobResultText(j)}
                      </td>
                      <td className="p-2 text-xs text-muted" title={shortDate(j.createdAt)}>
                        {timeAgo(j.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                  Back to all logs
                </Button>
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
                <div className="flex flex-col items-center gap-2 py-8 text-muted">
                  <Spinner />
                  No active jobs
                </div>
              ) : (
                active.map((j) => (
                  <div key={j.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{j.type}</span>
                      <JobStatus status={j.status} />
                    </div>
                    <div className="mt-2">
                      <ProgressBar current={j.progressCurrent} total={j.progressTotal} />
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