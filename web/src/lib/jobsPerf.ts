import type { Job } from "./api";
import { toIsoUtc } from "./utils";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Pick a shared `useNow` interval aligned with `timeAgo` rounding boundaries, or
 * `null` once a job is old enough to display a static date.
 */
export function createdAgoIntervalMs(
  createdAtIso: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!createdAtIso) return null;
  const then = new Date(toIsoUtc(createdAtIso)).getTime();
  if (Number.isNaN(then)) return null;
  const ageMs = Math.max(0, nowMs - then);
  if (ageMs < MINUTE_MS) return 10_000;
  if (ageMs < HOUR_MS) return 60_000;
  if (ageMs < DAY_MS) return 300_000;
  return null;
}

const jobHaystackCache = new WeakMap<Job, string>();

/**
 * Lazily compute and memoize a job's lowercased search haystack per immutable
 * `Job` object reference.
 */
export function getJobHaystack(job: Job, build: (job: Job) => string): string {
  const cached = jobHaystackCache.get(job);
  if (cached !== undefined) return cached;
  const normalized = build(job).toLowerCase();
  jobHaystackCache.set(job, normalized);
  return normalized;
}
