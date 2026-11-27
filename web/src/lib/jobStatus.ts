import type { Job } from "./api";

export function isActive(job: Job): boolean {
  return job.status === "running" || job.status === "queued";
}

/** A completed job whose recorded result carries warnings, errors or unconfirmed work. */
export function hasWarnings(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Object.entries(result as Record<string, unknown>).some(
    ([key, value]) => {
      if (
        /^(warnings?|errors?|failed|notificationFailed|notificationUnknown|unknown)$/i.test(
          key
        )
      ) {
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === "object" && value !== null)
          return Object.keys(value).length > 0;
        return typeof value === "number" ? value > 0 : Boolean(value);
      }
      return typeof value === "object" && hasWarnings(value);
    }
  );
}

/** Failed work, or work that finished but left something behind for the user to look at. */
export function needsAttention(job: Job): boolean {
  return (
    job.status === "failed" ||
    (job.status === "completed" && hasWarnings(job.result))
  );
}
