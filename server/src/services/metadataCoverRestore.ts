import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import type { KavitaClient } from "../kavita/client.js";
import type { MetadataSnapshot } from "../contracts/metadataHistory.js";
import type {
  CoverTarget,
  CoverRestoreSelection,
  CoverRestorePreview,
  RecordedCover,
  CoverNativeLockChoice,
} from "../contracts/metadataCovers.js";
import {
  coverHistory,
  hasRetainedCoverAsset,
  type CoverCheckpointRow,
} from "./metadataCovers.js";
import {
  observeCover,
  retainCoverObservation,
  sameCoverObservation,
  coverTargetKey,
  loadCoverAsset,
  type CoverObservation,
  type CoverEvidence,
} from "./coverObservations.js";
import { getKavitaConnection } from "./settings.js";
import { kavitaConnectionKey } from "./kavitaState.js";

export interface ApprovedCoverRestore {
  target: CoverTarget;
  name: string;
  sourceOperationId: string;
  sourceAssetId: string;
  requestedLock: boolean;
  nativeLock: CoverNativeLockChoice;
  expected: Omit<CoverObservation, "data">;
}
export interface PreparedCoverRestores {
  approved: ApprovedCoverRestore[];
  previews: CoverRestorePreview[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const assetHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function isEvidence(value: unknown): value is CoverEvidence {
  if (
    !object(value) ||
    !positiveId(value.seriesId) ||
    !positiveId(value.libraryId) ||
    !nullableText(value.token) ||
    (value.folderPath !== undefined && !nullableText(value.folderPath)) ||
    (value.installationId !== undefined &&
      typeof value.installationId !== "string")
  )
    return false;
  const volume = value.volume;
  return (
    volume === undefined ||
    (object(volume) &&
      positiveId(volume.id) &&
      positiveId(volume.seriesId) &&
      typeof volume.createdUtc === "string" &&
      Number.isFinite(Date.parse(volume.createdUtc)) &&
      assetHash(volume.membership))
  );
}
function isApproved(value: unknown): value is ApprovedCoverRestore {
  if (
    !object(value) ||
    !object(value.target) ||
    !["series", "volume"].includes(String(value.target.kind)) ||
    (value.target.kind === "volume"
      ? !positiveId(value.target.volumeId)
      : value.target.volumeId !== undefined) ||
    typeof value.name !== "string" ||
    typeof value.sourceOperationId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.sourceOperationId) ||
    !assetHash(value.sourceAssetId) ||
    typeof value.requestedLock !== "boolean" ||
    !["preserve", "saved", "locked", "unlocked"].includes(
      String(value.nativeLock)
    )
  )
    return false;
  const expected = value.expected;
  if (
    !object(expected) ||
    !["captured", "absent"].includes(String(expected.state)) ||
    (expected.assetId !== null && !assetHash(expected.assetId)) ||
    !nullableText(expected.mediaType) ||
    !(expected.locked === null || typeof expected.locked === "boolean") ||
    !nullableText(expected.nativeLockReason) ||
    typeof expected.name !== "string" ||
    !isEvidence(expected.evidence)
  )
    return false;
  return value.target.kind === "series"
    ? expected.evidence.volume === undefined
    : expected.evidence.volume?.id === value.target.volumeId;
}
export function parseApprovedCoverRestores(
  json: string
): ApprovedCoverRestore[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length > 2000 || !value.every(isApproved))
    throw new Error("Approved cover restore evidence is malformed");
  return value;
}

function historicalIdentityMatches(
  row: CoverCheckpointRow,
  target: CoverTarget,
  side: "before" | "after",
  selected: MetadataSnapshot,
  current: CoverObservation
): boolean {
  if (
    selected.series.id !== current.evidence.seriesId ||
    selected.series.libraryId !== current.evidence.libraryId ||
    (Object.hasOwn(selected.series, "folderPath") &&
      selected.series.folderPath !== current.evidence.folderPath)
  )
    return false;
  const json =
    side === "before" ? row.beforeEvidenceJson : row.afterEvidenceJson;
  const evidence: unknown = json ? JSON.parse(json) : null;
  if (
    object(evidence) &&
    typeof evidence.installationId === "string" &&
    evidence.installationId !== current.evidence.installationId
  )
    return false;
  if (target.kind === "series") return true;
  if (!object(evidence) || !object(evidence.volume) || !current.evidence.volume)
    return false;
  // Creation identity survives ordinary chapter additions/renumbering but detects reused numeric IDs.
  return (
    evidence.volume.id === target.volumeId &&
    evidence.volume.seriesId === selected.series.id &&
    evidence.volume.createdUtc === current.evidence.volume.createdUtc
  );
}
function publicObservation(value: CoverObservation): RecordedCover {
  return {
    state: value.state,
    assetId: value.assetId,
    mediaType: value.mediaType,
    byteSize: value.data?.length ?? null,
    nativeLocked: value.locked,
    nativeLockReason: value.nativeLockReason,
    reason: null,
  };
}

export async function prepareCoverRestores(
  client: KavitaClient,
  current: MetadataSnapshot,
  selected: MetadataSnapshot,
  operationId: string,
  side: "before" | "after",
  selections: CoverRestoreSelection[],
  lockedFields: readonly string[],
  retainCurrent?: (
    preview: CoverRestorePreview,
    observed: CoverObservation
  ) => void
): Promise<PreparedCoverRestores> {
  const result: PreparedCoverRestores = { approved: [], previews: [] };
  if (!selections.length) return result;
  const db = getDb();
  const key = kavitaConnectionKey(getKavitaConnection().baseUrl),
    history = coverHistory(operationId);
  const seriesRow = selections.some((s) => s.kind !== "volume")
    ? db
        .select()
        .from(schema.metadataSeriesCovers)
        .where(eq(schema.metadataSeriesCovers.operationId, operationId))
        .get()
    : undefined;
  const volumeRowsById = new Map(
    selections.some((s) => s.kind === "volume")
      ? db
          .select()
          .from(schema.metadataVolumeCovers)
          .where(eq(schema.metadataVolumeCovers.operationId, operationId))
          .all()
          .map((row) => [row.volumeId, row] as const)
      : []
  );
  for (const selection of selections) {
    const target: CoverTarget =
      selection.kind === "volume"
        ? { kind: "volume", volumeId: selection.volumeId! }
        : { kind: "series" };
    const checkpoint =
      target.kind === "series"
        ? history?.series
        : history?.volumes.find((item) => item.volumeId === target.volumeId);
    const row =
      target.kind === "series"
        ? seriesRow
        : volumeRowsById.get(target.volumeId);
    const nativeLock = selection.nativeLock ?? "preserve";
    const restoreTo: RecordedCover = checkpoint
      ? checkpoint[side]
      : {
          state: "unavailable",
          assetId: null,
          mediaType: null,
          byteSize: null,
          nativeLocked: null,
          reason: "No retained image exists for this target",
        };
    const preview: CoverRestorePreview = {
      target,
      name:
        checkpoint?.name ??
        (target.kind === "series"
          ? "Series cover"
          : `Volume #${target.volumeId}`),
      current: {
        state: "unavailable",
        assetId: null,
        mediaType: null,
        byteSize: null,
        nativeLocked: null,
        reason: "Current cover has not been inspected",
      },
      restoreTo,
      available: false,
      reason: null,
      nativeLock,
      requestedLock: null,
      nativeLockReadbackAvailable: false,
      laterEdit: false,
    };
    result.previews.push(preview);
    try {
      if (
        !row ||
        !checkpoint ||
        !checkpoint.restoreAvailability[side].available
      )
        throw new Error(
          checkpoint?.restoreAvailability[side].reason ??
            "This cover snapshot is unavailable"
        );
      if (
        !restoreTo.assetId ||
        !hasRetainedCoverAsset(
          current.series.id,
          operationId,
          restoreTo.assetId
        )
      )
        throw new Error(
          "The retained source image failed authorization or integrity checks"
        );
      const observed = await observeCover(
        client,
        current.series.id,
        target,
        current,
        key
      );
      preview.current = publicObservation(observed);
      preview.nativeLockReadbackAvailable = observed.locked !== null;
      if (retainCurrent) retainCurrent(preview, observed);
      else retainCoverObservation(observed);
      if (!historicalIdentityMatches(row, target, side, selected, observed))
        throw new Error(
          "Historical cover belongs to a changed series, installation or volume identity"
        );
      if (lockedFields.includes("cover"))
        throw new Error(
          "Cover is protected from H-Tosho sync; unlock it and refresh the preview"
        );
      const requestedLock =
        nativeLock === "locked"
          ? true
          : nativeLock === "unlocked"
            ? false
            : nativeLock === "saved"
              ? restoreTo.nativeLocked
              : observed.locked;
      if (requestedLock === null)
        throw new Error(
          nativeLock === "saved"
            ? "The saved native lock was not captured; choose Locked or Unlocked explicitly"
            : "Kavita does not expose the current volume lock; choose Locked or Unlocked explicitly, then refresh"
        );
      preview.requestedLock = requestedLock;
      preview.available = true;
      const after = checkpoint.after;
      preview.laterEdit =
        after.state !== observed.state ||
        after.assetId !== observed.assetId ||
        (after.nativeLocked !== null &&
          observed.locked !== null &&
          after.nativeLocked !== observed.locked);
      const { data: _data, ...expected } = observed;
      result.approved.push({
        target,
        name: preview.name,
        sourceOperationId: operationId,
        sourceAssetId: restoreTo.assetId,
        requestedLock,
        nativeLock,
        expected,
      });
    } catch (error) {
      preview.reason =
        error instanceof Error
          ? error.message
          : "Cover restoration is unavailable";
    }
  }
  return result;
}

export async function recheckCoverRestores(
  client: KavitaClient,
  current: MetadataSnapshot,
  covers: ApprovedCoverRestore[],
  sourceOperationId: string
): Promise<Map<string, CoverObservation>> {
  const key = kavitaConnectionKey(getKavitaConnection().baseUrl);
  const observedByKey = new Map<string, CoverObservation>();
  for (const cover of covers) {
    if (
      cover.sourceOperationId !== sourceOperationId ||
      cover.expected.evidence.seriesId !== current.series.id ||
      !hasRetainedCoverAsset(
        current.series.id,
        sourceOperationId,
        cover.sourceAssetId
      )
    )
      throw new Error(
        "Approved cover source no longer belongs to this operation"
      );
    const observed = await observeCover(
      client,
      current.series.id,
      cover.target,
      current,
      key
    );
    if (!sameCoverObservation(cover.expected, observed))
      throw new Error(
        `${cover.name}: current image, native lock or indexed identity changed after preview; review required`
      );
    observedByKey.set(coverTargetKey(cover.target), observed);
  }
  return observedByKey;
}

/** Current preview images are authorized by their retained preview or durable approved plan. */
export function retainedPreviewCoverAsset(
  seriesId: number,
  previewId: string,
  assetId: string
): { data: Buffer; mediaType: string } | null {
  if (
    !positiveId(seriesId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(previewId) ||
    !assetHash(assetId)
  )
    return null;
  const db = getDb(),
    key = kavitaConnectionKey(getKavitaConnection().baseUrl);
  const preview = db
    .select()
    .from(schema.metadataRestorePreviews)
    .where(
      and(
        eq(schema.metadataRestorePreviews.id, previewId),
        eq(schema.metadataRestorePreviews.seriesId, seriesId),
        eq(schema.metadataRestorePreviews.connectionKey, key)
      )
    )
    .get();
  const plan = db
    .select()
    .from(schema.metadataRestorePlans)
    .where(
      and(
        eq(schema.metadataRestorePlans.previewId, previewId),
        eq(schema.metadataRestorePlans.seriesId, seriesId),
        eq(schema.metadataRestorePlans.connectionKey, key)
      )
    )
    .get();
  try {
    if (preview && Date.parse(preview.expiresAt) > Date.now()) {
      const value: unknown = JSON.parse(preview.previewJson);
      if (
        !object(value) ||
        !Array.isArray(value.covers) ||
        !value.covers.some(
          (cover) =>
            object(cover) &&
            object(cover.current) &&
            cover.current.assetId === assetId
        )
      )
        return null;
    } else if (
      !plan ||
      !parseApprovedCoverRestores(plan.coversJson).some(
        (cover) => cover.expected.assetId === assetId
      )
    )
      return null;
  } catch {
    return null;
  }
  return loadCoverAsset(assetId);
}
