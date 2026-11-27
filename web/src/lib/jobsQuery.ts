import type { Query } from "@tanstack/react-query";
import type { Job } from "./api";

/**
 * Poll cadence for ['jobs']: fast while anything is queued/running, slow when idle.
 *
 * Every observer with a `refetchInterval` runs its own timer, so two observers
 * on this key poll twice. SidebarStatus (always mounted) owns this interval;
 * other observers (Tasks page, Libraries) read the same cache without one.
 */
export function jobsPollInterval(
  query: Query<Job[], Error, Job[], readonly unknown[]>
): number {
  return query.state.data?.some(
    (j) => j.status === "running" || j.status === "queued"
  )
    ? 2500
    : 15_000;
}
