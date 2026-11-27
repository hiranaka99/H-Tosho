import fs from "node:fs";
import { JobCancelled } from "../jobs/lifecycle.js";
import type { Job, LogFn } from "../jobs/queue.js";
import { persistMergeState } from "./stateStore.js";
import type {
  MergeAuxPort,
  MergeDownloadPort,
  MergeJobPort,
  MergeSettingsPort,
  ResolvedMergeTiming,
} from "./types.js";

/** All merge downloads must finish before any archives move or existing chapter drafts commit. */
export async function stageMergeDownloads(
  deps: {
    downloads: MergeDownloadPort;
    jobs: MergeJobPort;
    settings: MergeSettingsPort;
    aux: MergeAuxPort;
  },
  timing: ResolvedMergeTiming,
  job: Job,
  log: LogFn,
  signal?: AbortSignal
): Promise<{ files: string[]; chapters: Record<string, string> }> {
  const plans = job.payload.downloads ?? [];
  if (!plans.length) return { files: [], chapters: {} };
  if (!deps.settings.getDownloaderPaths().downloadDirectory.trim()) {
    throw new Error(
      "Set an output folder in Downloader settings before starting merge downloads."
    );
  }
  const queue = deps.downloads;
  const tracked: {
    plan: (typeof plans)[number];
    id: number;
    owned: boolean;
  }[] = [];
  const checkCancelled = () => {
    if (signal?.aborted || deps.jobs.isCancelRequested(job.id))
      throw new JobCancelled();
  };
  const archiveExists = (task: ReturnType<typeof queue.get>) =>
    !!task?.outputPath?.toLowerCase().endsWith(".cbz") &&
    fs.existsSync(task.outputPath);
  const remember = (key: string, id: number) => {
    job.payload.mergeDownloadIds = {
      ...job.payload.mergeDownloadIds,
      [key]: id,
    };
    persistMergeState(
      job.id,
      { mergeDownloadIds: job.payload.mergeDownloadIds },
      (ids) => deps.jobs.invalidateContextCache(ids)
    );
  };

  try {
    type ClassifiedPlan =
      | {
          kind: "reuse";
          plan: (typeof plans)[number];
          key: string;
          task: NonNullable<ReturnType<typeof queue.get>>;
          owned: boolean;
        }
      | { kind: "need-download"; plan: (typeof plans)[number]; key: string };
    const classified: ClassifiedPlan[] = [];
    for (const plan of plans) {
      checkCancelled();
      const key = `${plan.source}:${plan.galleryId}`;
      const saved = job.payload.mergeDownloadIds?.[key];
      let task = saved ? queue.get(saved) : null;
      // Internal checkpoints never attach another gallery's task.
      if (
        task &&
        (task.source !== plan.source || task.galleryId !== plan.galleryId)
      ) {
        throw new Error("Merge download checkpoint does not match its gallery");
      }
      if (!task) {
        const done = queue.findCompleted(plan.source, plan.galleryId);
        task =
          queue.findActive(plan.source, plan.galleryId) ??
          (done && archiveExists(done) ? done : null);
      }
      if (task?.mergeJobId != null && task.mergeJobId !== job.id) {
        const owner = deps.jobs.get(task.mergeJobId);
        if (owner?.status === "queued" || owner?.status === "running") {
          throw new Error(
            `${plan.title} is already assigned to merge job #${owner.id}. Finish or cancel that merge in Jobs first.`
          );
        }
      }
      if (
        saved !== undefined &&
        task?.mergeJobId != null &&
        task.mergeJobId !== job.id
      ) {
        // A verified retry assumes its inactive predecessor's reservation, never an independent task.
        queue.reassignMergeJob(task.id, task.mergeJobId, job.id);
        task = queue.get(task.id);
      }
      if (
        task?.status === "failed" &&
        task.mergeJobId != null &&
        !queue.hasPendingRetry(task.id) &&
        !queue.isRunning(task.id)
      ) {
        queue.retry(task.id);
        task = queue.get(task.id);
      }
      if (
        !task ||
        (task.status === "completed" && !archiveExists(task)) ||
        (task.status === "failed" &&
          task.mergeJobId == null &&
          !queue.hasPendingRetry(task.id) &&
          !queue.isRunning(task.id))
      ) {
        classified.push({ kind: "need-download", plan, key });
      } else {
        classified.push({
          kind: "reuse",
          plan,
          key,
          task,
          owned: saved !== undefined && task.mergeJobId != null,
        });
      }
    }

    const plansToCheck = classified
      .filter(
        (c): c is Extract<ClassifiedPlan, { kind: "need-download" }> =>
          c.kind === "need-download" && !c.plan.allowDuplicate
      )
      .map((c) => c.plan);
    const hasMatchByKey =
      plansToCheck.length > 0
        ? await deps.aux.checkDownloadDuplicates(
            plansToCheck,
            job.payload.sourceFiles
          )
        : new Set<string>();
    checkCancelled();

    for (const item of classified) {
      if (item.kind === "reuse") {
        tracked.push({ plan: item.plan, id: item.task.id, owned: item.owned });
        remember(item.key, item.task.id);
        log(
          "info",
          `${item.task.status === "completed" ? "Reusing archive" : "Waiting for download"}: ${item.plan.title} (task #${item.task.id})`
        );
        continue;
      }
      const { plan, key } = item;
      if (!plan.allowDuplicate) {
        // An independent task may have appeared while duplicate metadata was resolving.
        const raced =
          queue.findActive(plan.source, plan.galleryId) ??
          queue.findCompleted(plan.source, plan.galleryId);
        if (raced && (raced.status !== "completed" || archiveExists(raced))) {
          if (raced.mergeJobId != null && raced.mergeJobId !== job.id) {
            const owner = deps.jobs.get(raced.mergeJobId);
            if (owner?.status === "queued" || owner?.status === "running") {
              throw new Error(
                `${plan.title} is already assigned to merge job #${owner.id}.`
              );
            }
          }
          tracked.push({
            plan,
            id: raced.id,
            owned: raced.mergeJobId === job.id,
          });
          remember(key, raced.id);
          continue;
        }
        if (hasMatchByKey.has(key)) {
          throw new Error(
            `Possible duplicate for ${plan.title}. Review this gallery in Downloader before queueing the merge again.`
          );
        }
      }
      const id = queue.enqueueForMerge({
        source: plan.source,
        galleryId: plan.galleryId,
        title: plan.title,
        chapter: plan.chapter.trim() ? Number(plan.chapter) : undefined,
        mergeJobId: job.id,
        url: plan.url,
      });
      tracked.push({ plan, id, owned: true });
      remember(key, id);
      log("info", `Download queued: ${plan.title} (task #${id})`);
    }

    let lastComplete = -1;
    const completedOutputs = new Map<number, string>();
    for (;;) {
      checkCancelled();
      let complete = 0;
      for (const entry of tracked) {
        const task = queue.get(entry.id);
        if (!task)
          throw new Error(
            `Download removed: ${entry.plan.title}. Retry the merge to download it again.`
          );
        if (
          task.status === "failed" &&
          !queue.isRunning(task.id) &&
          task.state.type !== "retry-wait"
        ) {
          throw new Error(
            `Download failed for ${entry.plan.title}: ${task.errorMessage ?? "unknown error"}. Retry the merge in Jobs.`
          );
        }
        if (task.status !== "completed" || queue.isRunning(task.id)) continue;
        if (!archiveExists(task)) {
          if (task.outputFormat === "folder") {
            entry.id = queue.enqueueForMerge({
              source: entry.plan.source,
              galleryId: entry.plan.galleryId,
              title: entry.plan.title,
              chapter: entry.plan.chapter.trim()
                ? Number(entry.plan.chapter)
                : undefined,
              mergeJobId: job.id,
              url: entry.plan.url,
            });
            entry.owned = true;
            remember(`${entry.plan.source}:${entry.plan.galleryId}`, entry.id);
            log(
              "info",
              `Downloading CBZ copy: ${entry.plan.title} (task #${entry.id})`
            );
            continue;
          }
          throw new Error(
            `Downloaded archive not found for ${entry.plan.title}. Check Downloads before retrying the merge.`
          );
        }
        completedOutputs.set(entry.id, task.outputPath!);
        complete += 1;
      }
      if (complete !== lastComplete) {
        lastComplete = complete;
        deps.jobs.setProgress(job.id, complete, tracked.length);
      }
      if (complete === tracked.length) break;
      const watchedIds = new Set(tracked.map((entry) => entry.id));
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubTask();
          unsubRemovals();
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const unsubTask = queue.subscribe((task) => {
          if (
            watchedIds.has(task.id) &&
            (task.status === "completed" || task.status === "failed")
          )
            done();
        });
        const unsubRemovals = queue.subscribeRemovals((ids) => {
          if (ids.some((id) => watchedIds.has(id))) done();
        });
        const timer = setTimeout(done, timing.downloadFallbackPollMs);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    checkCancelled();
    const outputFor = (id: number) =>
      completedOutputs.get(id) ?? queue.get(id)!.outputPath!;
    const files = tracked.map((entry) => outputFor(entry.id));
    const chapters = Object.fromEntries(
      tracked
        .filter((entry) => entry.plan.chapter.trim())
        .map((entry) => [outputFor(entry.id), entry.plan.chapter.trim()])
    );
    log(
      "success",
      `All ${tracked.length} download(s) ready; applying the merge`
    );
    return { files, chapters };
  } catch (error) {
    // Stop only downloads owned by this merge; independent downloads keep their own state.
    for (const entry of tracked) if (entry.owned) queue.cancel(entry.id);
    throw error;
  }
}
