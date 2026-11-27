import { jobQueue, JobCancelled, type Job, type JobContext } from "./queue.js";
import type { KavitaClient } from "../kavita/client.js";
export interface Target {
  id: number;
  name: string;
  libraryId?: number;
}

export function rememberContext(job: Job, context: JobContext): void {
  const saved = jobQueue.updateContext(job.id, context);
  if (saved) {
    job.context = saved;
    job.payload.context = saved;
  }
}

export function throwIfJobCancelled(jobId: number): void {
  if (jobQueue.isCancelRequested(jobId)) throw new JobCancelled();
}

export function rememberTargets(job: Job, targets: Target[]): void {
  const explicitIds = new Set([
    ...(job.payload.seriesId !== undefined ? [job.payload.seriesId] : []),
    ...(job.payload.seriesIds ?? []),
  ]);
  const libraryIds = new Set(targets.map((target) => target.libraryId));
  const resolvedExplicit =
    explicitIds.size > 0 &&
    targets.filter((target) => explicitIds.has(target.id)).length ===
      explicitIds.size;
  rememberContext(job, {
    series: targets.map(({ id, name }) => ({ id, name })),
    libraryId:
      job.payload.libraryId ??
      job.context?.libraryId ??
      (resolvedExplicit && libraryIds.size === 1
        ? targets[0]?.libraryId
        : undefined),
  });
}

export function rememberLibraries(
  job: Job,
  libraries: { id: number; name: string }[]
): void {
  const libraryId =
    job.payload.libraryId ??
    job.context?.libraryId ??
    (libraries.length === 1 ? libraries[0].id : undefined);
  const library = libraries.find((entry) => entry.id === libraryId);
  rememberContext(job, { series: [], libraryId, libraryName: library?.name });
}

export async function rememberAvailableLibraries(
  job: Job,
  client: KavitaClient
): Promise<void> {
  if (job.context?.libraryName) return;
  try {
    rememberLibraries(job, await client.getLibraries());
  } catch {
    // Identity enrichment must not prevent the existing operation from running.
  }
}

export async function rememberSeriesLibrary(
  job: Job,
  client: KavitaClient,
  series: Target
): Promise<void> {
  rememberTargets(job, [series]);
  await rememberAvailableLibraries(job, client);
}
