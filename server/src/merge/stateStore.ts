import fs from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { JobExecutionState, JobPayload } from "../contracts/jobs.js";
import type { MergeProtectionState } from "../contracts/mergeProtection.js";
import { PROTECTABLE_FIELDS } from "../contracts/metadata.js";
import { getDb, schema } from "../db/index.js";
import type { Job } from "../jobs/queue.js";
import {
  readJobPayload,
  readStateObject,
  type JobStateHydration,
} from "../jobs/storage.js";
import { archiveResource } from "../lib/mutations.js";
import { pathContains } from "../lib/paths.js";
import { isPositiveId, isRecord } from "../lib/guards.js";

const validFields = (value: unknown): boolean =>
  Array.isArray(value) &&
  (value as unknown[]).every(
    (field) =>
      typeof field === "string" && PROTECTABLE_FIELDS.some((f) => f === field)
  );

export type MergeStateUpdate = Pick<
  JobPayload,
  "mergeDownloadIds" | "sourceFiles" | "chapters" | "mergeProtection"
>;

/** Hydrate merge-owned execution state from `jobs.state_json` (client payloads can never forge mergeProtection). */
export function hydrateMergeState(
  persistedState: Record<string, unknown>,
  rawPayload: Record<string, unknown>
): JobStateHydration {
  const combined = { ...rawPayload, ...persistedState };
  const state: Partial<JobExecutionState> = {};
  if (isRecord(combined.mergeDownloadIds)) {
    state.mergeDownloadIds = Object.fromEntries(
      Object.entries(combined.mergeDownloadIds).filter(
        (entry): entry is [string, number] => isPositiveId(entry[1])
      )
    );
  }
  if (
    isRecord(combined.chapters) &&
    Object.values(combined.chapters).every((value) => typeof value === "string")
  ) {
    state.chapters = combined.chapters as Record<string, string>;
  }
  if (
    Array.isArray(combined.sourceFiles) &&
    combined.sourceFiles.every((value) => typeof value === "string")
  ) {
    state.sourceFiles = combined.sourceFiles;
  }
  let validationError: string | undefined;
  // Only the server state column can authorize retained Protected Merge evidence.
  if (persistedState.mergeProtection !== undefined) {
    const protection = persistedState.mergeProtection;
    if (
      !isRecord(protection) ||
      typeof protection.connectionKey !== "string" ||
      !protection.connectionKey ||
      typeof protection.targetDir !== "string" ||
      typeof protection.seriesName !== "string" ||
      !Array.isArray(protection.sourceSeriesIds) ||
      !protection.sourceSeriesIds.every(isPositiveId) ||
      (protection.targetSeriesId !== undefined &&
        !isPositiveId(protection.targetSeriesId)) ||
      (protection.completedTargetSeriesId !== undefined &&
        !isPositiveId(protection.completedTargetSeriesId)) ||
      (protection.rootJobId !== undefined &&
        !isPositiveId(protection.rootJobId)) ||
      (protection.moves !== undefined &&
        (!Array.isArray(protection.moves) ||
          !protection.moves.every(
            (move) =>
              isRecord(move) &&
              typeof move.source === "string" &&
              typeof move.destination === "string" &&
              typeof move.sha256 === "string" &&
              /^[a-f0-9]{64}$/.test(move.sha256) &&
              (move.status === "pending" || move.status === "published")
          ))) ||
      !validFields(protection.inheritedFields) ||
      !Array.isArray(protection.policies) ||
      !protection.policies.every(
        (policy) =>
          isRecord(policy) &&
          isPositiveId(policy.seriesId) &&
          Number.isSafeInteger(policy.revision) &&
          Number(policy.revision) >= 0 &&
          validFields(policy.lockedFields)
      ) ||
      !Array.isArray(protection.identities) ||
      !protection.identities.every(
        (identity) =>
          isRecord(identity) &&
          isPositiveId(identity.seriesId) &&
          isPositiveId(identity.libraryId) &&
          (identity.folderPath === undefined ||
            typeof identity.folderPath === "string")
      ) ||
      !Array.isArray(protection.archives) ||
      !protection.archives.every(
        (archive) =>
          isRecord(archive) &&
          typeof archive.path === "string" &&
          (archive.seriesId === undefined || isPositiveId(archive.seriesId))
      )
    ) {
      validationError = "Invalid retained merge protection evidence";
    } else {
      state.mergeProtection = protection as unknown as MergeProtectionState;
    }
  }
  return { state, validationError };
}

export function initialMergeState(
  payload: JobPayload
): Record<string, unknown> {
  return {
    mergeDownloadIds: payload.mergeDownloadIds,
    sourceFiles: payload.mergeDownloadIds ? payload.sourceFiles : undefined,
    chapters: payload.mergeDownloadIds ? payload.chapters : undefined,
  };
}

export function stateForMergeRetry(failedJob: Job): Record<string, unknown> {
  return {
    mergeProtection: failedJob.payload.mergeProtection,
    sourceFiles: failedJob.payload.sourceFiles,
    chapters: failedJob.payload.chapters,
    mergeDownloadIds: failedJob.payload.mergeDownloadIds,
  };
}

/** Preserve independent checkpoints and complete every Retry Family sibling atomically. */
export function persistMergeState(
  jobId: number,
  update: MergeStateUpdate,
  invalidateCache?: (jobIds: number | readonly number[]) => void
): void {
  const db = getDb();
  const row = db
    .select({ type: schema.jobs.type, stateJson: schema.jobs.stateJson })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .get();
  if (!row || row.type !== "merge-series") return;
  const touched: number[] = [jobId];
  db.transaction(() => {
    db.update(schema.jobs)
      .set({
        stateJson: JSON.stringify({
          ...readStateObject(row.stateJson),
          ...update,
        }),
      })
      .where(eq(schema.jobs.id, jobId))
      .run();
    const protection = update.mergeProtection;
    if (!protection?.completedTargetSeriesId || !protection.rootJobId) return;
    const moved = new Map(
      (protection.moves ?? [])
        .filter((move) => move.status === "published")
        .map((move) => [move.source, move.destination])
    );
    const siblings = db
      .select({
        id: schema.jobs.id,
        type: schema.jobs.type,
        payloadJson: schema.jobs.payloadJson,
        stateJson: schema.jobs.stateJson,
      })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, "merge-series"),
          sql`json_valid(${schema.jobs.stateJson}) AND json_extract(${schema.jobs.stateJson}, '$.mergeProtection.rootJobId') = ${protection.rootJobId}`
        )
      )
      .all();
    for (const sibling of siblings) {
      if (sibling.id === jobId) continue;
      const saved = readStateObject(sibling.stateJson);
      const decoded = readJobPayload(
        sibling.type,
        sibling.payloadJson,
        sibling.stateJson,
        hydrateMergeState
      ).payload;
      const previous = decoded.mergeProtection;
      if (
        !previous ||
        previous.rootJobId !== protection.rootJobId ||
        previous.connectionKey !== protection.connectionKey
      )
        continue;
      const chapters = decoded.chapters
        ? Object.fromEntries(
            Object.entries(decoded.chapters).map(([file, number]) => [
              moved.get(file) ?? file,
              number,
            ])
          )
        : undefined;
      const mergeProtection: MergeProtectionState = {
        ...previous,
        targetSeriesId: protection.targetSeriesId,
        completedTargetSeriesId: protection.completedTargetSeriesId,
        policies: protection.policies,
        inheritedFields: protection.inheritedFields,
        identities: protection.identities,
        moves: protection.moves,
        archives: previous.archives.map((archive) => ({
          ...archive,
          path: moved.get(archive.path) ?? archive.path,
        })),
      };
      db.update(schema.jobs)
        .set({
          stateJson: JSON.stringify({
            ...saved,
            sourceFiles: decoded.sourceFiles?.map(
              (file) => moved.get(file) ?? file
            ),
            chapters,
            mergeProtection,
          }),
        })
        .where(eq(schema.jobs.id, sibling.id))
        .run();
      touched.push(sibling.id);
    }
  });
  invalidateCache?.(touched);
}

export function queryIncompleteMergeRows(connectionKey: string) {
  const stateColumn = schema.jobs.stateJson;
  const retained = (field: string) =>
    sql`(case when json_valid(${stateColumn}) then json_extract(${stateColumn}, ${`$.mergeProtection.${field}`}) end)`;
  return getDb()
    .select({
      id: schema.jobs.id,
      type: schema.jobs.type,
      status: schema.jobs.status,
      payloadJson: schema.jobs.payloadJson,
      stateJson: schema.jobs.stateJson,
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.type, "merge-series"),
        sql`${retained("connectionKey")} = ${connectionKey}`,
        sql`not (${schema.jobs.status} = 'completed' and ${retained("completedTargetSeriesId")} is not null)`
      )
    )
    .all();
}

export function hasPublishedOnDisk(protection: MergeProtectionState): boolean {
  const targetKey = archiveResource(protection.targetDir);
  return (
    protection.archives.some(
      (archive) =>
        pathContains(targetKey, archiveResource(archive.path)) &&
        fs.existsSync(archive.path)
    ) ||
    (protection.moves ?? []).some((move) => fs.existsSync(move.destination))
  );
}

/** Fast read-only probe so unlocked recovery callers skip library locks when nothing is pending. */
export function hasPendingMergeRecovery(connectionKey: string): boolean {
  if (!connectionKey) return false;
  const rows = queryIncompleteMergeRows(connectionKey);
  if (!rows.length) return false;
  return rows.some((row) => {
    const state = readJobPayload(
      row.type,
      row.payloadJson,
      row.stateJson,
      hydrateMergeState
    ).payload.mergeProtection;
    return (
      !!state &&
      state.connectionKey === connectionKey &&
      hasPublishedOnDisk(state)
    );
  });
}

/** Failed merges with corrupt retained state or unrecovered published archives must never be cleared. */
export function canClearFailedMergeRow(row: {
  payloadJson: string;
  stateJson: string;
}): boolean {
  const decoded = readJobPayload(
    "merge-series",
    row.payloadJson,
    row.stateJson,
    hydrateMergeState
  );
  if (decoded.validationError && /"mergeProtection"\s*:/.test(row.stateJson))
    return false;
  const protection = decoded.payload.mergeProtection;
  if (!protection || protection.completedTargetSeriesId !== undefined)
    return true;
  return !hasPublishedOnDisk(protection);
}
