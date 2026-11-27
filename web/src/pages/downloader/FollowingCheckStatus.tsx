import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { cn, timeAgo } from "../../lib/utils";
import { toast } from "../../lib/toast";
import { Button } from "../../components/ui";
import type { WatchedSearch } from "../../../../server/src/contracts/following";

export const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});
export const TIME_SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** The soonest automatic check across active watches, or null when none is scheduled. */
export function nextScheduledCheck(watches: WatchedSearch[]): string | null {
  return watches.reduce<string | null>(
    (soonest, watch) =>
      !watch.pausedAt &&
      watch.effectiveIntervalMinutes > 0 &&
      watch.nextCheckAt &&
      (!soonest || watch.nextCheckAt < soonest)
        ? watch.nextCheckAt
        : soonest,
    null
  );
}

export const formatCheckTime = (iso: string) =>
  TIME_SHORT_FMT.format(new Date(iso));

/**
 * One line above the inbox answers "is this working?": when watches last ran,
 * when they run next, and a manual check. Upkeep stays in the side sheet.
 */
export function FollowingCheckStatus({
  watches,
}: {
  watches: WatchedSearch[];
}) {
  const qc = useQueryClient();
  const [checking, setChecking] = React.useState(false);
  const [requestedJob, setRequestedJob] = React.useState<number | null>(null);
  const checkQuery = useQuery({
    queryKey: ["watched-check-status"],
    queryFn: api.watchedCheckStatus,
    // Fast while a check runs; at rest it keeps pace with the feed's own refresh.
    refetchInterval: (query) =>
      checking ||
      requestedJob !== null ||
      ["queued", "running"].includes(query.state.data?.status ?? "")
        ? 2500
        : 60_000,
  });
  const checkJob = checkQuery.data;
  const checkActive =
    checking ||
    (requestedJob !== null &&
      checkJob?.id !== requestedJob &&
      !checkQuery.isError) ||
    checkJob?.status === "queued" ||
    checkJob?.status === "running";
  // null until the first status is seen: a check that had already finished when
  // this mounted is not a new completion, so it must not refetch the lists.
  // A check seen queued/running records '' and invalidates once it finishes.
  const completionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!checkJob) return;
    const done = !["queued", "running"].includes(checkJob.status);
    const stamp = done ? `${checkJob.id}:${checkJob.status}` : "";
    if (completionRef.current === null) {
      completionRef.current = stamp;
      return;
    }
    if (!done || completionRef.current === stamp) return;
    completionRef.current = stamp;
    void qc.invalidateQueries({ queryKey: ["watched-searches"] });
    void qc.invalidateQueries({ queryKey: ["watched-gallery-feed"] });
    setRequestedJob(null);
  }, [checkJob, qc]);
  async function checkNow() {
    if (checkActive) return;
    setChecking(true);
    try {
      const queued = await api.checkWatchedSearches();
      setRequestedJob(queued.id);
      await checkQuery.refetch();
    } catch (e) {
      toast({
        tone: "danger",
        title: "Could not queue check",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setChecking(false);
    }
  }
  const jobFinished =
    checkJob?.status === "completed" && checkJob.finishedAt
      ? new Date(checkJob.finishedAt).toISOString()
      : null;
  const lastChecked = watches.reduce<string | null>(
    (latest, watch) =>
      watch.lastCheckedAt && (!latest || watch.lastCheckedAt > latest)
        ? watch.lastCheckedAt
        : latest,
    jobFinished
  );
  const nextCheck = nextScheduledCheck(watches);
  const activeWatches = watches.filter(
    (watch) => watch.pausedAt === null
  ).length;
  const summary = checkJob?.result as
    { newGalleries?: number; failed?: number } | undefined;
  const failedWatches = watches.filter((watch) => watch.lastError).length;
  const warn =
    !checkActive && (checkJob?.status === "failed" || failedWatches > 0);
  let primary: React.ReactNode;
  if (checkActive)
    primary =
      checkJob?.status === "running"
        ? `Checking ${checkJob.progressCurrent} of ${checkJob.progressTotal} watches…`
        : "Check queued…";
  else if (checkJob?.status === "failed") primary = "Last check failed";
  else if (lastChecked)
    primary = (
      <>
        Checked{" "}
        <time
          dateTime={lastChecked}
          title={DATE_TIME_FMT.format(new Date(lastChecked))}
        >
          {timeAgo(lastChecked)}
        </time>
        {checkJob?.status === "completed" && summary?.newGalleries
          ? ` · ${summary.newGalleries} new`
          : ""}
      </>
    );
  else primary = "Not checked yet";
  const secondary = checkActive ? null : nextCheck ? (
    <>
      next{" "}
      <time
        dateTime={nextCheck}
        title={DATE_TIME_FMT.format(new Date(nextCheck))}
      >
        {TIME_SHORT_FMT.format(new Date(nextCheck))}
      </time>
    </>
  ) : activeWatches === 0 ? (
    "all watches paused"
  ) : (
    "automatic checks off"
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <p role="status" className="min-w-0">
        <span
          key={`${checkJob?.id}:${checkJob?.status}:${checkActive}`}
          className={cn(
            "watched-check-status inline-block break-words",
            warn && "text-warning"
          )}
        >
          {primary}
          {secondary && <> · {secondary}</>}
          {!checkActive && failedWatches > 0 && checkJob?.status !== "failed"
            ? ` · ${failedWatches} ${failedWatches === 1 ? "watch" : "watches"} failed`
            : ""}
        </span>
      </p>
      {checkJob && !checkActive && (
        <Link
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 max-lg:min-h-11 pointer-coarse:min-h-11"
          to={`/jobs?job=${checkJob.id}`}
        >
          View check
        </Link>
      )}
      {checkQuery.isError && (
        <Button
          size="sm"
          variant="ghost"
          className="h-11"
          onClick={() => void checkQuery.refetch()}
        >
          Retry status
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2 h-11"
        onClick={() => void checkNow()}
        disabled={checkActive || activeWatches === 0 || checkQuery.isPending}
        title={
          activeWatches === 0
            ? "Resume a watch to check it"
            : "Check active watches once; paused watches are skipped"
        }
      >
        <RefreshCw
          aria-hidden="true"
          className={cn("h-3.5 w-3.5", checkActive && "animate-spin")}
        />{" "}
        Check now
      </Button>
    </div>
  );
}
