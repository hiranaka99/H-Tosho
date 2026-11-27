import fs from "node:fs";
import path from "node:path";
import {
  parseJobCommand,
  validMergeChapter,
  validateMergeDownloads,
} from "../contracts/jobs.js";
import type {
  MergeProtectionPreview,
  MergeProtectionRequest,
} from "../contracts/mergeProtection.js";
import { parseComicInfo } from "../downloader/comicinfo.js";
import { sanitizeFilename } from "../downloader/util.js";
import { JobCancelled, type JobTypeLifecycleHook } from "../jobs/lifecycle.js";
import type { Job, LogFn } from "../jobs/queue.js";
import { readJobPayload } from "../jobs/storage.js";
import { mapKavitaPathToLocalPath } from "../kavita/libraryPaths.js";
import {
  hashArchiveFile,
  listCbzFiles,
  mergeCbzFiles,
  readComicInfo,
  resolveExistingFile,
  setComicInfoFields,
} from "../lib/cbz.js";
import { sleep } from "../lib/http.js";
import {
  archiveMutations,
  archiveResource,
  libraryMutations,
} from "../lib/mutations.js";
import { lastSegment, pathContains } from "../lib/paths.js";
import { inheritFieldPoliciesOwned } from "../services/fieldPolicies.js";
import {
  withMetadataHistory,
  type MetadataJournal,
} from "../services/metadataHistory.js";
import {
  MergeChapterCache,
  parseMergeProtectionRequest,
  requireMergeAuthority,
  resolveMergeAuthority,
  type ResolvedMergeAuthority,
} from "./authority.js";
import { stageMergeDownloads } from "./staging.js";
import {
  canClearFailedMergeRow,
  hasPendingMergeRecovery,
  hydrateMergeState,
  initialMergeState,
  persistMergeState,
  queryIncompleteMergeRows,
  stateForMergeRetry,
} from "./stateStore.js";
import {
  ProtectedMergeError,
  type AttachedMergeDownload,
  type DownloadPublicationTarget,
  type KavitaMergeSession,
  type MergeLibraryIndexPort,
  type MergeJobResult,
  type MergedDownloadRegistration,
  type ProtectedMerge,
  type ProtectedMergeDeps,
  type ProtectedMergeTiming,
  type ResolvedMergeTiming,
  type SyncOnly,
} from "./types.js";
import {
  removeVacantSourceSeries,
  rescanAndVerifyMerge,
} from "./verification.js";

export * from "./types.js";

const DEFAULT_TIMING: ResolvedMergeTiming = {
  chapterCacheTtlMs: 5_000,
  downloadFallbackPollMs: 30_000,
  scanPollMs: 5_000,
  scanGraceMs: 15_000,
  mergeVerifyTimeoutMs: 25 * 60_000,
  now: Date.now,
  sleep,
};

const DEFAULT_LIBRARY_INDEX: MergeLibraryIndexPort = {
  checkDownloadDuplicates: async () => new Set(),
  invalidateDuplicateLibrary: () => {},
  queueMatchDiscovery: () => {},
};

function validateExistingMergeChapters(
  edits: Record<string, string> | undefined,
  targetDir: string
): [string, string][] {
  const entries = Object.entries(edits ?? {});
  if (!entries.length) return entries;
  const targetArchives = new Set(listCbzFiles(targetDir).map(archiveResource));
  for (const [file, number] of entries) {
    if (!targetArchives.has(archiveResource(file)))
      throw new Error(
        `Chapter edit is not an existing target archive: ${file}`
      );
    if (!validMergeChapter(number))
      throw new Error(
        "Existing chapter edits must be positive numbers or blank"
      );
  }
  return entries;
}

/** Construct a deepened Protected Merge module behind explicit remote/collaborator ports. */
export function createProtectedMerge(
  deps: ProtectedMergeDeps,
  timingOverrides?: ProtectedMergeTiming
): ProtectedMerge {
  const timing: ResolvedMergeTiming = { ...DEFAULT_TIMING, ...timingOverrides };
  const libraryIndex: MergeLibraryIndexPort = {
    ...DEFAULT_LIBRARY_INDEX,
    ...deps.libraryIndex,
  };
  const invalidateCache = (jobIds: number | readonly number[]) =>
    deps.jobs.invalidateContextCache(jobIds);

  const checkCancelled = (jobId: number, signal?: AbortSignal) => {
    if (signal?.aborted || deps.jobs.isCancelRequested(jobId))
      throw new JobCancelled();
  };

  const requireSession = (
    message: string,
    status: 409 | 503 = 409
  ): KavitaMergeSession => {
    const session = deps.kavita.current();
    if (!session) throw new ProtectedMergeError(message, status);
    return session;
  };

  const reviewRequestForJob = (
    job: Job,
    fallbackSourceFiles?: string[]
  ): MergeProtectionRequest => ({
    seriesId: job.payload.seriesId,
    sourceSeriesIds: job.payload.sourceSeriesIds,
    sourceFiles: job.payload.sourceFiles ?? fallbackSourceFiles,
    targetDir: job.payload.targetDir,
    seriesName: job.payload.seriesName?.trim() || undefined,
  });

  /** Only durable, hash-verified Move Intents can repair the move/checkpoint crash window. */
  async function recoverPendingMoveIntents(
    job: Job,
    signal?: AbortSignal
  ): Promise<void> {
    const state = job.payload.mergeProtection;
    if (!state) return;
    const session = deps.kavita.current();
    if (!session || state.connectionKey !== session.connectionKey) {
      throw new Error("Kavita connection changed before merge recovery");
    }
    for (const move of state.moves ?? []) {
      if (move.status !== "pending") continue;
      await archiveMutations.run(
        [
          archiveResource(state.targetDir),
          archiveResource(move.source),
          archiveResource(move.destination),
        ],
        async () => {
          checkCancelled(job.id, signal);
          if (
            move.source === move.destination ||
            !pathContains(
              archiveResource(state.targetDir),
              archiveResource(move.destination)
            )
          ) {
            throw new Error("Invalid pending merge destination");
          }
          const source = resolveExistingFile(move.source);
          const destination = resolveExistingFile(move.destination);
          if (!source && !destination) {
            throw new Error(
              "Neither archive in the pending merge publication exists; restore the archive before retrying"
            );
          }
          if (
            (source &&
              (await hashArchiveFile(source, signal)) !== move.sha256) ||
            (destination &&
              (await hashArchiveFile(destination, signal)) !== move.sha256)
          ) {
            throw new Error(
              "Pending merge archive content changed; review the source and destination before retrying"
            );
          }
          if (destination) {
            const proposedFiles = (job.payload.sourceFiles ?? []).map((file) =>
              file === move.source && !source ? move.destination : file
            );
            const proposedArchives = state.archives.map((archive) =>
              archive.path === move.source && !source
                ? { ...archive, path: move.destination }
                : archive
            );
            await resolveMergeAuthority(
              session,
              deps.kavita,
              deps.settings,
              {
                targetDir: state.targetDir,
                sourceFiles: [...new Set([...proposedFiles, move.destination])],
                seriesName: state.seriesName,
              },
              { ...state, archives: proposedArchives }
            );
            if (source) {
              // Cross-volume copy finished before source removal; original survives, discard exact duplicate.
              await fs.promises.unlink(destination);
            } else {
              job.payload.sourceFiles = proposedFiles;
              state.archives = proposedArchives;
              if (job.payload.chapters?.[move.source] !== undefined) {
                job.payload.chapters = {
                  ...job.payload.chapters,
                  [move.destination]: job.payload.chapters[move.source],
                };
                delete job.payload.chapters[move.source];
              }
              deps.downloads.markOutputPublished(move.source, move.destination);
              move.status = "published";
            }
          }
          persistMergeState(
            job.id,
            {
              mergeProtection: state,
              sourceFiles: job.payload.sourceFiles,
              chapters: job.payload.chapters,
            },
            invalidateCache
          );
        },
        signal
      );
    }
  }

  /** Phase 1 (outside libraryMutations): recover pending Move Intents, review authority, and stage downloads. */
  async function prepareMergeForPublication(
    job: Job,
    log: LogFn,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const command = parseJobCommand(job.type, job.payload);
    if (command.type !== "merge-series")
      throw new Error("Invalid merge command");
    job.payload = { ...job.payload, ...command.payload };
    if (
      job.payload.mergeProtection?.moves?.some(
        (move) => move.status === "pending"
      )
    ) {
      await libraryMutations.run(
        ["*"],
        () => recoverPendingMoveIntents(job, signal),
        signal
      );
    }
    if (job.payload.targetDir)
      validateExistingMergeChapters(
        job.payload.existingChapters,
        job.payload.targetDir
      );
    checkCancelled(job.id, signal);
    const session = requireSession(
      "Kavita is not configured; protection cannot be verified"
    );
    const checked = await resolveMergeAuthority(
      session,
      deps.kavita,
      deps.settings,
      reviewRequestForJob(job),
      job.payload.mergeProtection
    );
    requireMergeAuthority(checked.preview);
    validateExistingMergeChapters(
      job.payload.existingChapters,
      checked.targetDir
    );
    checked.state.rootJobId ??= job.id;
    job.payload.mergeProtection = checked.state;
    job.payload.sourceFiles = checked.state.archives.map(
      (archive) => archive.path
    );
    persistMergeState(
      job.id,
      { mergeProtection: checked.state, sourceFiles: job.payload.sourceFiles },
      invalidateCache
    );
    const downloaded = await stageMergeDownloads(
      {
        downloads: deps.downloads,
        jobs: deps.jobs,
        settings: deps.settings,
        libraryIndex,
      },
      timing,
      job,
      log,
      signal
    );
    checkCancelled(job.id, signal);
    job.payload.sourceFiles = [
      ...new Set([...job.payload.sourceFiles, ...downloaded.files]),
    ];
    job.payload.chapters = { ...job.payload.chapters, ...downloaded.chapters };
    persistMergeState(
      job.id,
      { sourceFiles: job.payload.sourceFiles, chapters: job.payload.chapters },
      invalidateCache
    );
  }

  /** Phase 2 body (already inside libraryMutations['*'] and optional metadataHistory journal). */
  async function runFinalMerge(
    session: KavitaMergeSession,
    job: Job,
    log: LogFn,
    signal: AbortSignal | undefined,
    journal: MetadataJournal | undefined,
    review: ResolvedMergeAuthority,
    chapterCache: MergeChapterCache
  ): Promise<MergeJobResult> {
    let sourceFiles = job.payload.sourceFiles ?? [];
    validateMergeDownloads(job.payload.downloads);
    if (!sourceFiles.length && !job.payload.downloads?.length)
      throw new Error("At least one .cbz file or gallery is required");
    checkCancelled(job.id, signal);
    for (const file of sourceFiles) {
      if (!resolveExistingFile(file) || !file.toLowerCase().endsWith(".cbz"))
        throw new Error(`Source archive not found: ${file}`);
    }
    for (const number of Object.values(job.payload.chapters ?? {})) {
      if (!validMergeChapter(number))
        throw new Error(
          "Incoming chapter numbers must be positive numbers or blank"
        );
    }
    const renamedSeries = job.payload.seriesName?.trim();
    const checked = review;
    requireMergeAuthority(checked.preview);
    const targetDir = checked.targetDir;
    const stampName = checked.state.seriesName;
    job.payload.mergeProtection = checked.state;
    sourceFiles = checked.state.archives.map((archive) => archive.path);
    job.payload.sourceFiles = sourceFiles;
    persistMergeState(
      job.id,
      { mergeProtection: checked.state, sourceFiles },
      invalidateCache
    );
    const knownSeries = checked.preview.series.map((series) => ({
      id: series.seriesId,
      name: series.name,
    }));
    const libraryIds = [
      ...new Set(
        checked.preview.series
          .map((s) => s.libraryId)
          .filter((id): id is number => id > 0)
      ),
    ];
    if (knownSeries.length) {
      deps.jobs.updateContext(job.id, {
        series: knownSeries,
        libraryId: libraryIds.length === 1 ? libraryIds[0] : undefined,
      });
    }

    const recheck = async (reuseChapters = false) => {
      checkCancelled(job.id, signal);
      if (!reuseChapters) chapterCache.clear();
      const current = await resolveMergeAuthority(
        session,
        deps.kavita,
        deps.settings,
        reviewRequestForJob(job, sourceFiles),
        job.payload.mergeProtection,
        reuseChapters ? chapterCache : undefined
      );
      requireMergeAuthority(current.preview);
      if (current.state.seriesName !== stampName)
        throw new Error("Effective series name changed; refresh merge review");
      job.payload.mergeProtection = current.state;
      persistMergeState(
        job.id,
        { mergeProtection: current.state },
        invalidateCache
      );
    };
    const loopRecheck = () => recheck(true);
    if (!targetDir) throw new Error("targetDir required");
    const existingEdits = validateExistingMergeChapters(
      job.payload.existingChapters,
      targetDir
    );
    fs.mkdirSync(targetDir, { recursive: true });
    fs.accessSync(targetDir, fs.constants.W_OK);
    await recheck(true);
    const chapters = job.payload.chapters;
    await journal?.captureArchives([
      ...new Set([...sourceFiles, ...listCbzFiles(targetDir)]),
    ]);
    checkCancelled(job.id, signal);
    const sourceSeriesIds = job.payload.mergeProtection.sourceSeriesIds.filter(
      (id) => id !== job.payload.mergeProtection!.targetSeriesId
    );
    checkCancelled(job.id, signal);
    log("info", `Merging ${sourceFiles.length} file(s) into ${targetDir}`);

    const r = await mergeCbzFiles(
      sourceFiles,
      targetDir,
      chapters,
      stampName ?? lastSegment(targetDir),
      (source, destination) => {
        deps.downloads.markOutputPublished(source, destination);
        job.payload.sourceFiles = (job.payload.sourceFiles ?? []).map((file) =>
          file === source ? destination : file
        );
        job.payload.mergeProtection!.archives =
          job.payload.mergeProtection!.archives.map((archive) =>
            archive.path === source
              ? { ...archive, path: destination }
              : archive
          );
        const pending = job.payload.mergeProtection!.moves?.find(
          (move) => move.source === source && move.destination === destination
        );
        if (pending) pending.status = "published";
        if (job.payload.chapters?.[source] !== undefined) {
          job.payload.chapters = {
            ...job.payload.chapters,
            [destination]: job.payload.chapters[source],
          };
          if (source !== destination) delete job.payload.chapters[source];
        }
        persistMergeState(
          job.id,
          {
            sourceFiles: job.payload.sourceFiles,
            chapters: job.payload.chapters,
            mergeProtection: job.payload.mergeProtection,
          },
          invalidateCache
        );
      },
      signal,
      async (source, destination) => {
        await loopRecheck();
        if (source === destination) return;
        const sha256 = await hashArchiveFile(source, signal);
        if (
          job.payload.mergeProtection!.connectionKey !==
          deps.kavita.connectionKey()
        ) {
          throw new Error(
            "Kavita connection changed before archive publication"
          );
        }
        job.payload.mergeProtection!.moves = [
          ...(job.payload.mergeProtection!.moves ?? []).filter(
            (move) => move.source !== source
          ),
          { source, destination, sha256, status: "pending" },
        ];
        persistMergeState(
          job.id,
          { mergeProtection: job.payload.mergeProtection },
          invalidateCache
        );
      }
    );

    checkCancelled(job.id, signal);
    for (const f of r.failed) log("warn", `Skipped ${f.file}: ${f.error}`);
    if (r.moved.length === 0)
      throw new Error("No files could be moved — check the source paths");

    let chapterEditFailures = 0;
    const editedPaths = new Set<string>();
    for (const [file, number] of existingEdits) {
      checkCancelled(job.id, signal);
      const resolved = path.resolve(file);
      try {
        const fields: Record<string, string> = { Number: number.trim() };
        if (renamedSeries) fields.Series = renamedSeries;
        await setComicInfoFields(resolved, fields, loopRecheck);
        editedPaths.add(archiveResource(resolved));
        log(
          "success",
          `Updated existing chapter number: ${path.basename(file)}`
        );
      } catch (error) {
        chapterEditFailures += 1;
        log(
          "warn",
          `Could not update existing chapter ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (renamedSeries) {
      for (const file of listCbzFiles(targetDir)) {
        checkCancelled(job.id, signal);
        if (editedPaths.has(archiveResource(file))) continue;
        const xml = await readComicInfo(file);
        if (!xml || parseComicInfo(xml).fields.Series !== renamedSeries) {
          await setComicInfoFields(
            file,
            { Series: renamedSeries },
            loopRecheck
          );
        }
      }
      checkCancelled(job.id, signal);
      await recheck();
      log(
        "success",
        `Set merged series name to "${renamedSeries}" in all target archives`
      );
    }
    log(
      "success",
      `Moved ${r.moved.length} file(s) into one folder as "${stampName ?? lastSegment(targetDir)}"; stamped chapter numbers on ${r.chaptered.length}`
    );
    if (!renamedSeries && !sourceSeriesIds.length) await recheck();
    await removeVacantSourceSeries(
      session,
      deps.settings,
      sourceSeriesIds,
      log,
      targetDir,
      async (id) => {
        await recheck();
        return job.payload.mergeProtection!.targetSeriesId !== id;
      }
    );
    const verified = await rescanAndVerifyMerge(
      session,
      deps.settings,
      deps.jobs,
      timing,
      targetDir,
      r.moved,
      log,
      {
        jobId: job.id,
        seriesId: job.payload.mergeProtection.targetSeriesId ?? null,
        libraryId: job.payload.mergeProtection.libraryId ?? null,
        seriesName: renamedSeries,
        signal,
        beforeRename: async (id) => {
          await recheck();
          if (job.payload.mergeProtection!.targetSeriesId !== id) {
            throw new Error(
              "Indexed merge target identity changed before its Kavita title could be updated"
            );
          }
        },
      }
    );
    if (!verified && job.payload.mergeProtection.libraryId !== undefined) {
      throw new Error(
        "Merged archives were not verified in Kavita; retry to finish protection inheritance before syncing"
      );
    }
    if (verified) {
      await recheck();
      if (
        job.payload.mergeProtection.targetSeriesId !== verified.id ||
        job.payload.mergeProtection.libraryId !== verified.libraryId
      ) {
        throw new Error(
          "Verified merge target ownership changed before protection inheritance"
        );
      }
      const protection = job.payload.mergeProtection;
      const policy = inheritFieldPoliciesOwned(
        verified.id,
        protection.inheritedFields,
        protection.connectionKey,
        protection.policies
      );
      protection.inheritedFields = policy.lockedFields;
      protection.policies = [
        ...protection.policies.filter(
          (saved) => saved.seriesId !== verified.id
        ),
        {
          seriesId: verified.id,
          revision: policy.revision,
          lockedFields: policy.lockedFields,
        },
      ];
      protection.identities = [
        ...protection.identities.filter(
          (identity) => identity.seriesId !== verified.id
        ),
        {
          seriesId: verified.id,
          libraryId: verified.libraryId,
          folderPath: targetDir,
        },
      ];
      protection.targetSeriesId = verified.id;
      protection.completedTargetSeriesId = verified.id;
      persistMergeState(
        job.id,
        { mergeProtection: protection },
        invalidateCache
      );
      if (renamedSeries && verified.name !== renamedSeries) {
        throw new Error(
          "Archives were merged and protection retained, but Kavita did not confirm the renamed title. Retry to finish the rename."
        );
      }
    }
    if (r.failed.length || chapterEditFailures) {
      throw new Error(
        "Merge metadata was only partially committed. Protection was retained; retry this job to finish remaining archive edits."
      );
    }
    if (job.payload.downloads?.length && verified) {
      try {
        libraryIndex.queueMatchDiscovery(targetDir, renamedSeries ?? undefined);
      } catch (error) {
        log(
          "warn",
          `Could not queue match discovery: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return {
      processed: r.moved.length,
      matched: 0,
      failed: r.failed.length + chapterEditFailures,
      ...(verified ? {} : { verificationSkipped: true }),
    };
  }

  async function recoverSeriesWithinLock(seriesId: number): Promise<void> {
    const session = deps.kavita.current();
    if (!session) return;
    const key = session.connectionKey;
    const mappings =
      deps.settings.getDownloaderPaths().libraryPathMappings ?? [];
    const rows = queryIncompleteMergeRows(key);
    const intents = rows
      .map((row) => ({
        row,
        decoded: readJobPayload(
          row.type,
          row.payloadJson,
          row.stateJson,
          hydrateMergeState
        ),
      }))
      .filter(
        (item) =>
          item.decoded.payload.mergeProtection?.connectionKey === key &&
          item.decoded.payload.mergeProtection.completedTargetSeriesId !==
            seriesId
      )
      .filter(({ decoded }) => {
        const retainedState = decoded.payload.mergeProtection!;
        return (
          retainedState.archives.some(
            (archive) =>
              pathContains(
                archiveResource(retainedState.targetDir),
                archiveResource(archive.path)
              ) && fs.existsSync(archive.path)
          ) ||
          (retainedState.moves ?? []).some((move) =>
            fs.existsSync(move.destination)
          )
        );
      });
    if (!intents.length) return;
    const chapters = await session.getChaptersBySeries(seriesId);
    const indexed = new Set(
      chapters.flatMap((chapter) =>
        (chapter.files ?? []).flatMap((file) =>
          file.filePath
            ? [
                archiveResource(
                  mapKavitaPathToLocalPath(file.filePath, mappings) ??
                    file.filePath
                ),
              ]
            : []
        )
      )
    );
    for (const { row, decoded } of intents) {
      const state = decoded.payload.mergeProtection!;
      const published = state.archives.filter(
        (archive) =>
          pathContains(
            archiveResource(state.targetDir),
            archiveResource(archive.path)
          ) && fs.existsSync(archive.path)
      );
      const proposedArchives = [...state.archives];
      for (const move of state.moves ?? []) {
        if (
          !indexed.has(archiveResource(move.destination)) ||
          !fs.existsSync(move.destination) ||
          published.some(
            (archive) =>
              archiveResource(archive.path) ===
              archiveResource(move.destination)
          )
        ) {
          continue;
        }
        const source = state.archives.find(
          (archive) =>
            archiveResource(archive.path) === archiveResource(move.source)
        );
        if (!source)
          throw new ProtectedMergeError(
            "Pending publication has no retained source identity"
          );
        // Read-only fingerprint check; caller may already hold archive ownership.
        if (
          move.status === "pending" &&
          (await hashArchiveFile(move.destination)) !== move.sha256
        ) {
          throw new ProtectedMergeError(
            "Pending archive changed before its policy could be inherited; review and retry the merge"
          );
        }
        const archive = { ...source, path: move.destination };
        published.push(archive);
        if (!fs.existsSync(move.source)) {
          proposedArchives.splice(proposedArchives.indexOf(source), 1, archive);
          move.status = "published";
        } else {
          proposedArchives.push(archive);
        }
      }
      if (
        !published.some((archive) => indexed.has(archiveResource(archive.path)))
      )
        continue;
      if (decoded.validationError)
        throw new ProtectedMergeError(
          "Retained merge protection is invalid; repair it before syncing"
        );
      if (
        !published.every((archive) =>
          indexed.has(archiveResource(archive.path))
        )
      ) {
        throw new ProtectedMergeError(
          "An unfinished merge is still split between indexed series; retry it before syncing"
        );
      }
      if (deps.kavita.connectionKey() !== key)
        throw new ProtectedMergeError(
          "Kavita connection changed while recovering merge protection"
        );
      const checked = await resolveMergeAuthority(
        session,
        deps.kavita,
        deps.settings,
        {
          targetDir: state.targetDir,
          sourceFiles: published.map((archive) => archive.path),
          seriesName: state.seriesName,
        },
        { ...state, archives: proposedArchives }
      );
      if (checked.state.targetSeriesId !== seriesId) {
        throw new ProtectedMergeError(
          "Late merge target identity is ambiguous; rescan and retry before syncing"
        );
      }
      const policy = inheritFieldPoliciesOwned(
        seriesId,
        checked.state.inheritedFields,
        key,
        checked.state.policies
      );
      checked.state.inheritedFields = policy.lockedFields;
      checked.state.policies = [
        ...checked.state.policies.filter(
          (saved) => saved.seriesId !== seriesId
        ),
        {
          seriesId,
          revision: policy.revision,
          lockedFields: policy.lockedFields,
        },
      ];
      checked.state.completedTargetSeriesId = seriesId;
      const moved = new Map(
        (checked.state.moves ?? [])
          .filter((move) => move.status === "published")
          .map((move) => [move.source, move.destination])
      );
      const sourceFiles = decoded.payload.sourceFiles?.map(
        (file) => moved.get(file) ?? file
      );
      const restoredChapters = decoded.payload.chapters
        ? Object.fromEntries(
            Object.entries(decoded.payload.chapters).map(([file, number]) => [
              moved.get(file) ?? file,
              number,
            ])
          )
        : undefined;
      persistMergeState(
        row.id,
        {
          mergeProtection: checked.state,
          sourceFiles,
          chapters: restoredChapters,
        },
        invalidateCache
      );
    }
  }

  const jobLifecycleHook: JobTypeLifecycleHook = {
    hydrateState: hydrateMergeState,
    initialState: initialMergeState,
    stateForRetry: stateForMergeRetry,
    canClearFailed: canClearFailedMergeRow,
    onStopped: (jobId) => {
      deps.downloads.cancelByMergeJob(jobId);
    },
  };

  return {
    async preview(rawOrRequest: unknown): Promise<MergeProtectionPreview> {
      const session = requireSession("Kavita not configured", 503);
      const request = parseMergeProtectionRequest(rawOrRequest);
      const result = await resolveMergeAuthority(
        session,
        deps.kavita,
        deps.settings,
        request
      );
      return result.preview;
    },

    async registerMergedDownloads<TPrepared, TResult>(
      mergeFolder: string,
      steps: MergedDownloadRegistration<TPrepared, TResult>
    ): Promise<SyncOnly<TResult>> {
      const folder = mergeFolder.trim();
      if (!folder || /[\\/\u0000-\u001f\u007f]/.test(folder)) {
        throw new ProtectedMergeError(
          "mergeFolder must be a plain series name without control characters",
          400
        );
      }
      const session = requireSession(
        "Kavita is required to review merged download protection",
        409
      );
      const dl = deps.settings.getDownloaderPaths();
      if (!dl.downloadDirectory.trim()) {
        throw new ProtectedMergeError(
          "Set an output folder in Downloader settings before starting merged downloads",
          400
        );
      }
      const targetDir = path.join(
        path.resolve(dl.downloadDirectory),
        sanitizeFilename(folder, "merged")
      );
      const chapterCache = new MergeChapterCache(
        timing.chapterCacheTtlMs,
        timing.now
      );
      const initial = await resolveMergeAuthority(
        session,
        deps.kavita,
        deps.settings,
        { targetDir, seriesName: folder },
        undefined,
        chapterCache
      );
      requireMergeAuthority(initial.preview);

      const prepared = await steps.prepare();

      const postSession = requireSession(
        "Kavita is required to review merged download protection",
        409
      );
      const rechecked = await resolveMergeAuthority(
        postSession,
        deps.kavita,
        deps.settings,
        {
          targetDir: initial.state.targetDir,
          seriesName: initial.state.seriesName,
        },
        initial.state,
        chapterCache
      );
      requireMergeAuthority(rechecked.preview);

      // Synchronous turn: zero await between download inserts and durable merge_job_id linkage.
      // A download that was inserted but never linked would publish as an
      // unprotected plain download, so every failure path cancels it.
      const attached: AttachedMergeDownload[] = [];
      let open = true;
      const attach = (entry: AttachedMergeDownload) => {
        if (!open) {
          deps.downloads.cancel(entry.downloadId);
          throw new ProtectedMergeError(
            "Cannot attach downloads after merged registration has committed",
            409
          );
        }
        attached.push(entry);
      };
      try {
        const result = steps.enqueue(prepared, attach);
        open = false;
        if (
          result !== null &&
          typeof result === "object" &&
          "then" in (result as object) &&
          typeof (result as unknown as PromiseLike<unknown>).then === "function"
        ) {
          throw new ProtectedMergeError(
            "Merged download registration enqueue step must be synchronous",
            409
          );
        }
        if (attached.length > 0) {
          const plans = attached.map((entry) => ({
            source: entry.source,
            galleryId: entry.galleryId,
            title: entry.title,
            chapter: entry.chapter,
            allowDuplicate: entry.allowDuplicate,
            ...(entry.url ? { url: entry.url } : {}),
          }));
          const ids = Object.fromEntries(
            attached.map((entry) => [
              `${entry.source}:${entry.galleryId}`,
              entry.downloadId,
            ])
          );
          const jobId = deps.jobs.enqueueMergeJob(
            {
              targetDir: rechecked.state.targetDir,
              seriesName: rechecked.state.seriesName,
              downloads: plans,
            },
            { mergeProtection: rechecked.state, mergeDownloadIds: ids }
          );
          deps.downloads.attachToMergeJob(Object.values(ids), jobId);
        }
        return result;
      } catch (error) {
        open = false;
        // Try every cancel; one failure must not strand the rest or mask the cause.
        for (const entry of attached) {
          try {
            deps.downloads.cancel(entry.downloadId);
          } catch {
            /* The original error is the one the caller needs. */
          }
        }
        throw error;
      }
    },

    async guardDownloadPublication<T>(
      target: DownloadPublicationTarget,
      commit: () => Promise<T>,
      signal?: AbortSignal
    ): Promise<T> {
      const runGuard = async (): Promise<T> => {
        const current = deps.downloads.get(target.downloadId);
        const mergeJob =
          current?.mergeJobId != null
            ? deps.jobs.get(current.mergeJobId)
            : null;
        if (
          mergeJob &&
          (mergeJob.validationError ||
            mergeJob.status === "failed" ||
            mergeJob.status === "cancelled")
        ) {
          throw new Error(
            mergeJob.status === "cancelled"
              ? "Cancelled by user"
              : "Merge job cannot authorize this download publication; retry the merge after reviewing its failure"
          );
        }
        if (target.legacyMergeFolder || mergeJob) {
          const session = requireSession(
            "Kavita is required to verify merged download protection",
            409
          );
          const request: MergeProtectionRequest = mergeJob
            ? reviewRequestForJob(mergeJob)
            : {
                targetDir: target.targetDir,
                seriesName: target.legacyMergeFolder!,
              };
          const checked = await resolveMergeAuthority(
            session,
            deps.kavita,
            deps.settings,
            request,
            mergeJob?.payload.mergeProtection
          );
          requireMergeAuthority(checked.preview);
          if (mergeJob) {
            persistMergeState(
              mergeJob.id,
              { mergeProtection: checked.state },
              invalidateCache
            );
          }
        }
        return commit();
      };
      // Legacy direct-merge rows acquire library ownership strictly before archive ownership.
      if (target.legacyMergeFolder) {
        return libraryMutations.run(
          ["*"],
          () =>
            archiveMutations.run(
              [
                archiveResource(target.targetDir),
                ...(target.previousOutputPath
                  ? [archiveResource(target.previousOutputPath)]
                  : []),
              ],
              runGuard,
              signal
            ),
          signal
        );
      }
      return runGuard();
    },

    async executeMergeJob(
      job: Job,
      log: LogFn,
      signal?: AbortSignal
    ): Promise<MergeJobResult> {
      await prepareMergeForPublication(job, log, signal);
      return libraryMutations.run(
        ["*"],
        async () => {
          checkCancelled(job.id, signal);
          libraryIndex.invalidateDuplicateLibrary();
          try {
            const command = parseJobCommand(job.type, job.payload);
            if (command.type !== "merge-series")
              throw new Error("Invalid merge command");
            job.payload = { ...job.payload, ...command.payload };
            const session = requireSession(
              "Kavita is not configured; protection cannot be verified"
            );
            const chapterCache = new MergeChapterCache(
              timing.chapterCacheTtlMs,
              timing.now
            );
            const current = await resolveMergeAuthority(
              session,
              deps.kavita,
              deps.settings,
              reviewRequestForJob(job),
              job.payload.mergeProtection,
              chapterCache
            );
            requireMergeAuthority(current.preview);
            job.payload.mergeProtection = current.state;
            persistMergeState(
              job.id,
              { mergeProtection: current.state },
              invalidateCache
            );
            const targetId = current.state.targetSeriesId;
            if (targetId) {
              return await withMetadataHistory(
                session,
                targetId,
                "merge-metadata",
                job.payload.seriesName ? { title: job.payload.seriesName } : {},
                (journal) =>
                  runFinalMerge(
                    session,
                    job,
                    log,
                    signal,
                    journal,
                    current,
                    chapterCache
                  ),
                job.id
              );
            }
            return await runFinalMerge(
              session,
              job,
              log,
              signal,
              undefined,
              current,
              chapterCache
            );
          } finally {
            libraryIndex.invalidateDuplicateLibrary();
          }
        },
        signal
      );
    },

    async recoverSeries(seriesId: number): Promise<void> {
      const key = deps.kavita.connectionKey();
      if (!key || !hasPendingMergeRecovery(key)) return;
      await libraryMutations.run([`series:${seriesId}`], () =>
        recoverSeriesWithinLock(seriesId)
      );
    },

    recoverSeriesWithinLock,
    jobLifecycleHook,
  };
}
