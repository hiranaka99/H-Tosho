import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { api, type AppUpdateStatus, type InstallMode } from "../lib/api";
import { formatBytes } from "../lib/format";
import { toast } from "../lib/toast";
import { timeAgo } from "../lib/utils";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Disclosure,
  ProgressBar,
} from "./ui";
import { ConfirmDialog } from "./dialog";

const ACTIVE_PHASES = new Set([
  "checking",
  "downloading",
  "verifying",
  "extracting",
  "fetching-git",
  "installing-deps",
  "building",
]);

const INSTALL_MODE_LABELS: Record<InstallMode, string> = {
  docker: "Docker",
  git: "Git checkout",
  standalone: "Standalone",
  development: "Development",
};

function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        tone: "danger",
        title: "Could not copy command",
        description: "Select and copy the command manually.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border border-border-2 bg-surface px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
          {command}
        </code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void onCopy()}
          aria-label={`Copy ${label.toLowerCase()} command`}
          className="shrink-0 max-lg:min-h-11 pointer-coarse:min-h-11"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function AppUpdatesCard() {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [restartingTimedOut, setRestartingTimedOut] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["app-update-status"],
    queryFn: api.appUpdateStatus,
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: (query) => {
      const phase = query.state.data?.progress.phase;
      return phase && ACTIVE_PHASES.has(phase) ? 1000 : false;
    },
  });

  const data = statusQuery.data;
  const phase = data?.progress.phase ?? "idle";
  const isUpdating = ACTIVE_PHASES.has(phase);
  const isRestarting = phase === "restarting";

  // Poll the public auth-status endpoint while the server restarts. Once the
  // newly booted server responds (with its fresh session table, authenticated=false,
  // or after a connection drop recovers), reload so the browser picks up the new UI.
  React.useEffect(() => {
    if (!isRestarting) {
      setRestartingTimedOut(false);
      return;
    }
    let cancelled = false;
    let sawDrop = false;
    const deadline = Date.now() + 90_000;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setRestartingTimedOut(true);
        return;
      }
      try {
        const res = await fetch("/api/auth/status", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (res.ok) {
          const auth = (await res.json()) as { authenticated?: boolean };
          if (sawDrop || auth.authenticated === false) {
            window.location.reload();
            return;
          }
        } else if (res.status >= 500) {
          sawDrop = true;
        }
      } catch {
        sawDrop = true;
      }
      if (!cancelled) window.setTimeout(() => void poll(), 1200);
    };

    const initial = window.setTimeout(() => void poll(), 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
    };
  }, [isRestarting]);

  const checkMutation = useMutation({
    mutationFn: api.checkAppUpdate,
    onSuccess: (next) => {
      setApplyError(null);
      qc.setQueryData<AppUpdateStatus>(["app-update-status"], next);
    },
    onError: (error) => {
      toast({
        tone: "danger",
        title: "Could not check for updates",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const applyMutation = useMutation({
    mutationFn: (version: string) => api.applyAppUpdate(version),
    onSuccess: (next) => {
      setConfirmOpen(false);
      setApplyError(null);
      qc.setQueryData<AppUpdateStatus>(["app-update-status"], next);
    },
    onError: (error) => {
      setConfirmOpen(false);
      setApplyError(error instanceof Error ? error.message : String(error));
    },
  });

  const dismissRollbackMutation = useMutation({
    mutationFn: api.dismissUpdateRollback,
    onSuccess: () => {
      qc.setQueryData<AppUpdateStatus>(["app-update-status"], (current) =>
        current ? { ...current, rolledBackVersion: null } : current
      );
    },
  });

  const requiresDockerReplace = Boolean(
    data?.installMode === "docker" &&
    data.docker?.requiresImageReplacement &&
    data.updateAvailable
  );
  const activeJobs = data?.activeWork.jobs ?? 0;
  const activeDownloads = data?.activeWork.downloads ?? 0;
  const hasActiveWork = activeJobs > 0 || activeDownloads > 0;
  const latest = data?.latestRelease ?? null;

  const badge = !data ? null : isUpdating || isRestarting ? (
    <Badge tone="info">Updating…</Badge>
  ) : requiresDockerReplace ? (
    <Badge tone="warning">Replace image</Badge>
  ) : data.updateAvailable ? (
    <Badge tone="info">Update available</Badge>
  ) : data.checkedAt && !data.checkError ? (
    <Badge tone="success">Up to date</Badge>
  ) : null;

  return (
    <Card id="app-updates" className="animate-fade-up scroll-mt-16">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle as="h2" className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-muted">
            <ArrowUpCircle className="h-4 w-4" />
          </span>
          <span className="break-words">App updates</span>
        </CardTitle>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {badge}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              checkMutation.isPending ||
              statusQuery.isPending ||
              isUpdating ||
              isRestarting
            }
            onClick={() => checkMutation.mutate()}
            className="max-lg:min-h-11 pointer-coarse:min-h-11"
          >
            {checkMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Check for updates
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {statusQuery.isPending ? (
          <div
            role="status"
            className="flex items-center gap-2 text-sm text-muted"
          >
            <Loader2 className="h-4 w-4 animate-spin" /> Checking current
            version…
          </div>
        ) : statusQuery.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"
          >
            <span className="flex min-w-0 items-start gap-2">
              <XCircle
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-danger"
              />
              <span className="break-words">
                Could not load update status.{" "}
                {statusQuery.error instanceof Error
                  ? statusQuery.error.message
                  : String(statusQuery.error)}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void statusQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : data ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span className="font-medium">v{data.currentVersion}</span>
              <Badge tone="muted">
                {INSTALL_MODE_LABELS[data.installMode]}
              </Badge>
              <span className="text-xs text-muted">
                Node {data.nodeVersion}
              </span>
              {data.checkedAt && (
                <span className="text-xs text-muted">
                  Checked {timeAgo(data.checkedAt)}
                </span>
              )}
            </div>

            {data.docker?.runningBundledOverlay &&
              data.docker.baseImageVersion && (
                <p className="text-xs text-muted">
                  Running an in-app update layered over Docker base image v
                  {data.docker.baseImageVersion}. Replacing the container image
                  later will automatically supersede this bundle.
                </p>
              )}

            {data.rolledBackVersion && (
              <div
                role="alert"
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
              >
                <p className="flex min-w-0 flex-1 items-start gap-2">
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  />
                  <span className="min-w-0 break-words">
                    <span className="font-medium">Automatic rollback:</span> v
                    {data.rolledBackVersion} exited unexpectedly during startup,
                    so H-Tosho restored v{data.currentVersion}.
                  </span>
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={dismissRollbackMutation.isPending}
                  onClick={() => dismissRollbackMutation.mutate()}
                >
                  Dismiss
                </Button>
              </div>
            )}

            {data.checkError && (
              <div
                role="alert"
                className="flex min-w-0 items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"
              >
                <XCircle
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-danger"
                />
                <span className="min-w-0 break-words">
                  <span className="font-medium">
                    Could not check for updates.
                  </span>{" "}
                  {data.checkError}
                </span>
              </div>
            )}

            {!data.checkError && !data.updateAvailable && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted"
              >
                <CheckCircle2
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-success"
                />
                {data.checkedAt
                  ? `H-Tosho v${data.currentVersion} is up to date.`
                  : "Use Check for updates to look for a newer release on GitHub."}
              </p>
            )}

            {data.updateAvailable && latest && (
              <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2/40 p-3.5 sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      v{data.currentVersion} → v{latest.version}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {latest.name !== latest.tagName
                        ? `${latest.name} · `
                        : ""}
                      {latest.publishedAt
                        ? `Published ${timeAgo(latest.publishedAt)}`
                        : latest.tagName}
                      {latest.bundleSize
                        ? ` · ${formatBytes(latest.bundleSize)}`
                        : ""}
                    </p>
                  </div>
                  <a
                    href={latest.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary underline-offset-4 hover:underline max-lg:min-h-11 pointer-coarse:min-h-11"
                  >
                    View release on GitHub
                    <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  </a>
                </div>

                {latest.notes && (
                  <Disclosure
                    label="Release notes"
                    className="border-t border-border pt-2"
                    summaryClassName="px-0 text-foreground"
                  >
                    <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-sans text-xs leading-relaxed text-foreground">
                      {latest.notes}
                    </pre>
                  </Disclosure>
                )}

                {requiresDockerReplace && data.docker && (
                  <div
                    role="alert"
                    className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning/10 p-3.5 text-sm"
                  >
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle
                        aria-hidden="true"
                        className="mt-0.5 h-5 w-5 shrink-0 text-warning"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground">
                          Docker image must be completely replaced
                        </p>
                        <p className="mt-1 text-pretty text-sm text-muted">
                          This release cannot be updated from inside the running
                          container. Replace the Docker image and recreate the
                          container to upgrade to v{latest.version}.
                        </p>
                      </div>
                    </div>

                    {data.docker.reasons.length > 0 && (
                      <ul className="list-disc space-y-1 pl-7 text-xs text-foreground">
                        {data.docker.reasons.map((reason) => (
                          <li key={reason.code} className="break-words">
                            {reason.summary}
                          </li>
                        ))}
                      </ul>
                    )}

                    <p className="rounded-md border border-warning/30 bg-surface/70 px-3 py-2 text-xs text-muted">
                      <span className="font-medium text-foreground">
                        Keep your data safe:
                      </span>{" "}
                      Your account, settings, and history live in{" "}
                      <code className="font-mono text-foreground">
                        {data.docker.dataDirectory}
                      </code>{" "}
                      and are preserved when recreating the container. Do not
                      run{" "}
                      <code className="font-mono text-foreground">
                        docker compose down -v
                      </code>
                      .
                    </p>

                    <div className="flex flex-col gap-2.5">
                      <CopyCommand
                        label="Prebuilt Docker image"
                        command={data.docker.pullCommand}
                      />
                      <CopyCommand
                        label="Local Git checkout with Docker Compose"
                        command={data.docker.buildCommand}
                      />
                    </div>
                  </div>
                )}

                {!requiresDockerReplace &&
                  !data.canUpdateInApp &&
                  data.unavailableReason && (
                    <div
                      role="status"
                      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
                    >
                      <AlertTriangle
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                      />
                      <span className="min-w-0 break-words">
                        {data.unavailableReason}
                      </span>
                    </div>
                  )}

                {(isUpdating || isRestarting) && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Loader2
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 animate-spin text-primary"
                      />
                      <span className="min-w-0 break-words">
                        {data.progress.message ||
                          `Updating to v${latest.version}…`}
                      </span>
                    </div>
                    <ProgressBar
                      label="App update progress"
                      value={
                        data.progress.phase === "downloading" &&
                        data.progress.bytesTotal
                          ? (data.progress.bytesReceived ?? 0)
                          : 0
                      }
                      max={
                        data.progress.phase === "downloading" &&
                        data.progress.bytesTotal
                          ? data.progress.bytesTotal
                          : 0
                      }
                      active
                    />
                    {data.progress.phase === "downloading" &&
                      typeof data.progress.bytesReceived === "number" && (
                        <p className="text-xs text-muted">
                          {formatBytes(data.progress.bytesReceived)}
                          {data.progress.bytesTotal
                            ? ` of ${formatBytes(data.progress.bytesTotal)}`
                            : ""}
                        </p>
                      )}
                    {isRestarting && (
                      <p className="text-xs text-muted">
                        {restartingTimedOut
                          ? "H-Tosho is taking longer than expected to come back. Reload this page manually once the server is running."
                          : "Waiting for the updated server to come back online. This page will reload automatically and ask you to sign in again."}
                      </p>
                    )}
                    {isRestarting && restartingTimedOut && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="self-start"
                        onClick={() => window.location.reload()}
                      >
                        Reload page
                      </Button>
                    )}
                  </div>
                )}

                {!isUpdating &&
                  !isRestarting &&
                  (applyError ||
                    (data.progress.phase === "failed" &&
                      data.progress.error)) && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"
                    >
                      <XCircle
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-danger"
                      />
                      <span className="min-w-0 break-words">
                        <span className="font-medium">
                          Update did not complete.
                        </span>{" "}
                        {applyError ?? data.progress.error} Your current
                        installation (v{data.currentVersion}) is still running.
                      </span>
                    </div>
                  )}

                {!requiresDockerReplace &&
                  data.canUpdateInApp &&
                  !isUpdating &&
                  !isRestarting && (
                    <div className="flex flex-col gap-2.5">
                      {hasActiveWork && (
                        <p
                          role="alert"
                          className="flex items-start gap-2 text-xs text-warning"
                        >
                          <AlertTriangle
                            aria-hidden="true"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          />
                          <span>
                            Finish or pause{" "}
                            {[
                              activeJobs > 0
                                ? `${activeJobs} active ${activeJobs === 1 ? "task" : "tasks"}`
                                : "",
                              activeDownloads > 0
                                ? `${activeDownloads} active ${activeDownloads === 1 ? "download" : "downloads"}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" and ")}{" "}
                            before updating so nothing is interrupted mid-write.
                          </span>
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-3">
                        <Button
                          type="button"
                          disabled={hasActiveWork || applyMutation.isPending}
                          onClick={() => setConfirmOpen(true)}
                          className="max-lg:min-h-11 pointer-coarse:min-h-11"
                        >
                          <Download aria-hidden="true" className="h-4 w-4" />
                          Update to v{latest.version}
                        </Button>
                        <span className="text-xs text-muted">
                          H-Tosho will restart briefly after applying the
                          update.
                        </span>
                      </div>
                    </div>
                  )}
              </div>
            )}
          </>
        ) : null}
      </CardContent>

      {latest && data && (
        <ConfirmDialog
          open={confirmOpen}
          title={`Update H-Tosho to v${latest.version}?`}
          description={
            data.installMode === "docker"
              ? `H-Tosho will download and verify the v${latest.version} update bundle, stage it in ${data.docker?.dataDirectory ?? "/data"}/updates, and restart automatically.`
              : `H-Tosho will fetch ${latest.tagName}, install dependencies, rebuild the app, and restart automatically.`
          }
          details={
            <p className="text-xs text-muted">
              Your account, settings, matches, and library files are preserved.
              You will be asked to sign in again after the brief restart.
              {data.installMode === "docker"
                ? " If the new version fails to start, H-Tosho automatically rolls back to the base Docker image."
                : ""}
            </p>
          }
          confirmLabel={`Update to v${latest.version}`}
          pending={applyMutation.isPending}
          onConfirm={() => applyMutation.mutate(latest.version)}
          onOpenChange={setConfirmOpen}
        />
      )}
    </Card>
  );
}
