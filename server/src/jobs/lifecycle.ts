import type { JobPayload, JobType } from "../contracts/jobs.js";
import type { Job, JobStatus } from "./queue.js";
import type { JobStateHydrator } from "./storage.js";

export type JobStopReason = "cancelled" | "failed" | "interrupted";

/** Thrown by the executor when a running job observes a cancellation request. */
export class JobCancelled extends Error {
  constructor() {
    super("Job cancelled");
    this.name = "JobCancelled";
  }
}

/** Narrow job-type lifecycle seam keeping generic queue storage free of domain-specific state logic. */
export interface JobTypeLifecycleHook {
  hydrateState?: JobStateHydrator;
  initialState?(payload: JobPayload): Record<string, unknown> | undefined;
  /** Set to false when a failed job must never be re-run as a copy. Defaults to true. */
  retryable?: boolean;
  stateForRetry?(failedJob: Job): Record<string, unknown> | undefined;
  canClearFailed?(row: {
    id: number;
    payloadJson: string;
    stateJson: string;
  }): boolean;
  onStopped?(jobId: number, reason: JobStopReason): void;
  onSettled?(
    jobId: number,
    status: Extract<JobStatus, "completed" | "cancelled" | "failed">,
    error?: string
  ): void;
}

const lifecycleHooks = new Map<JobType, JobTypeLifecycleHook>();

export function registerJobLifecycleHook(
  type: JobType,
  hook: JobTypeLifecycleHook
): void {
  lifecycleHooks.set(type, hook);
}

export function getJobLifecycleHook(
  type: JobType
): JobTypeLifecycleHook | undefined {
  return lifecycleHooks.get(type);
}
