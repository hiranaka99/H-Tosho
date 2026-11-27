import {
  parseJobCommand,
  type JobPayload,
  type JobContext,
} from "../contracts/jobs.js";
import type { MergeProtectionState } from "../contracts/mergeProtection.js";
import { PROTECTABLE_FIELDS } from "../contracts/metadata.js";
import { getDb, schema } from "../db/index.js";
import { and, eq, sql } from "drizzle-orm";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function readObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return record(value) ? value : {};
  } catch {
    return {};
  }
}

/** Historical rows stay inspectable, but a malformed command is never made executable by fallback. */
export function readJobPayload(
  type: unknown,
  json: string,
  stateJson = "{}"
): { payload: JobPayload; validationError?: string } {
  let raw: Record<string, unknown> = {};
  let objectPayload = false;
  try {
    const parsed: unknown = JSON.parse(json);
    if (record(parsed)) {
      raw = parsed;
      objectPayload = true;
    }
  } catch {
    /* Recorded as a validation failure below. */
  }
  const persistedState = readObject(stateJson),
    state = { ...raw, ...persistedState };
  let payload: JobPayload;
  let validationError: string | undefined;
  try {
    if (!objectPayload) throw new Error("Job payload must be an object");
    payload = parseJobCommand(type, raw).payload;
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
    payload = {
      seriesId: id(raw.seriesId) ? raw.seriesId : undefined,
      libraryId: id(raw.libraryId) ? raw.libraryId : undefined,
      seriesIds: Array.isArray(raw.seriesIds)
        ? raw.seriesIds.filter(id)
        : undefined,
      path: typeof raw.path === "string" ? raw.path : undefined,
    };
  }
  if (record(state.context) && Array.isArray(state.context.series)) {
    const context: JobContext = {
      series: state.context.series.filter(
        (target): target is { id: number; name: string } =>
          record(target) && id(target.id) && typeof target.name === "string"
      ),
      libraryId: id(state.context.libraryId)
        ? state.context.libraryId
        : undefined,
      libraryName:
        typeof state.context.libraryName === "string"
          ? state.context.libraryName
          : undefined,
    };
    payload.context = context;
  }
  if (Array.isArray(state.contextPendingSeriesIds))
    payload.contextPendingSeriesIds = state.contextPendingSeriesIds.filter(id);
  if (record(state.mergeDownloadIds))
    payload.mergeDownloadIds = Object.fromEntries(
      Object.entries(state.mergeDownloadIds).filter(
        (entry): entry is [string, number] => id(entry[1])
      )
    );
  if (
    record(state.chapters) &&
    Object.values(state.chapters).every((value) => typeof value === "string")
  )
    payload.chapters = state.chapters as Record<string, string>;
  if (
    Array.isArray(state.sourceFiles) &&
    state.sourceFiles.every((value) => typeof value === "string")
  )
    payload.sourceFiles = state.sourceFiles;
  // Only the server state column can authorize retained merge evidence.
  if (type === "merge-series" && persistedState.mergeProtection !== undefined) {
    const protection = persistedState.mergeProtection;
    const validFields = (value: unknown): boolean =>
      Array.isArray(value) &&
      (value as unknown[]).every(
        (field) =>
          typeof field === "string" &&
          PROTECTABLE_FIELDS.some((f) => f === field)
      );
    if (
      !record(protection) ||
      typeof protection.connectionKey !== "string" ||
      !protection.connectionKey ||
      typeof protection.targetDir !== "string" ||
      typeof protection.seriesName !== "string" ||
      !Array.isArray(protection.sourceSeriesIds) ||
      !protection.sourceSeriesIds.every(id) ||
      (protection.targetSeriesId !== undefined &&
        !id(protection.targetSeriesId)) ||
      (protection.completedTargetSeriesId !== undefined &&
        !id(protection.completedTargetSeriesId)) ||
      (protection.rootJobId !== undefined && !id(protection.rootJobId)) ||
      (protection.moves !== undefined &&
        (!Array.isArray(protection.moves) ||
          !protection.moves.every(
            (move) =>
              record(move) &&
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
          record(policy) &&
          id(policy.seriesId) &&
          Number.isSafeInteger(policy.revision) &&
          Number(policy.revision) >= 0 &&
          validFields(policy.lockedFields)
      ) ||
      !Array.isArray(protection.identities) ||
      !protection.identities.every(
        (identity) =>
          record(identity) &&
          id(identity.seriesId) &&
          id(identity.libraryId) &&
          (identity.folderPath === undefined ||
            typeof identity.folderPath === "string")
      ) ||
      !Array.isArray(protection.archives) ||
      !protection.archives.every(
        (archive) =>
          record(archive) &&
          typeof archive.path === "string" &&
          (archive.seriesId === undefined || id(archive.seriesId))
      )
    ) {
      validationError = "Invalid retained merge protection evidence";
    } else
      payload.mergeProtection = protection as unknown as MergeProtectionState;
  }
  return { payload, validationError };
}

/** Preserve independent checkpoints and complete every retry's retained publication evidence atomically. */
export function persistMergeState(
  jobId: number,
  update: Pick<
    JobPayload,
    "mergeDownloadIds" | "sourceFiles" | "chapters" | "mergeProtection"
  >
): void {
  const db = getDb();
  const row = db
    .select({ type: schema.jobs.type, stateJson: schema.jobs.stateJson })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .get();
  if (!row || row.type !== "merge-series") return;
  db.transaction(() => {
    db.update(schema.jobs)
      .set({
        stateJson: JSON.stringify({ ...readObject(row.stateJson), ...update }),
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
      const saved = readObject(sibling.stateJson),
        decoded = readJobPayload(
          sibling.type,
          sibling.payloadJson,
          sibling.stateJson
        ).payload,
        previous = decoded.mergeProtection;
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
      const mergeProtection = {
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
    }
  });
}
