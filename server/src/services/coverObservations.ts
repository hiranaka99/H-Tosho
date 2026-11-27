import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import type { KavitaClient } from "../kavita/client.js";
import type { KavitaVolumeCoverDto } from "../kavita/types.js";
import type { MetadataSnapshot } from "../contracts/metadataHistory.js";
import type { CoverTarget } from "../contracts/metadataCovers.js";
import {
  MAX_RETAINED_COVER_BYTES,
  MAX_RETAINED_COVER_STORE_BYTES,
} from "../contracts/metadataCovers.js";
import { getKavitaConnection } from "./settings.js";
import { kavitaConnectionKey } from "./kavitaState.js";

export function coverStorageBudget(
  value: string | undefined = process.env.HTOSHO_COVER_HISTORY_LIMIT_MIB
): number {
  if (value === undefined) return MAX_RETAINED_COVER_STORE_BYTES;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 10 ||
    Number(value) > 16_384
  ) {
    throw new Error(
      "Cover-history storage limit must be an integer from 10 through 16384 MiB; the cover write was not started"
    );
  }
  return Number(value) * 1024 * 1024;
}

/** Validate raster signatures, never accepting SVG/HTML under an image media type. Bytes remain unmodified. */
export function coverMediaType(data: Buffer): string {
  if (!data.length || data.length > MAX_RETAINED_COVER_BYTES)
    throw new Error("Cover history requires an image between 1 byte and 5 MiB");
  if (
    data.length >= 33 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR" &&
    data.toString("ascii", data.length - 8, data.length - 4) === "IEND"
  )
    return "image/png";
  if (
    data.length >= 4 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[data.length - 2] === 255 &&
    data[data.length - 1] === 217
  )
    return "image/jpeg";
  if (
    data.length >= 20 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length
  )
    return "image/webp";
  if (
    data.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)) &&
    data[data.length - 1] === 0x3b
  )
    return "image/gif";
  if (
    data.length >= 16 &&
    data.toString("ascii", 4, 8) === "ftyp" &&
    data.readUInt32BE(0) <= data.length &&
    /avif|avis/.test(
      data.toString("ascii", 8, Math.min(data.readUInt32BE(0), 128))
    )
  )
    return "image/avif";
  throw new Error(
    "Cover response is not a supported complete PNG, JPEG, WebP, GIF or AVIF raster image"
  );
}

export interface CoverEvidence {
  seriesId: number;
  libraryId: number;
  folderPath?: string | null;
  installationId?: string;
  token: string | null;
  volume?: {
    id: number;
    seriesId: number;
    createdUtc: string;
    membership: string;
  };
}
export interface CoverObservation {
  state: "captured" | "absent";
  assetId: string | null;
  data: Buffer | null;
  mediaType: string | null;
  locked: boolean | null;
  nativeLockReason: string | null;
  name: string;
  evidence: CoverEvidence;
}

export function coverTargetKey(target: CoverTarget): string {
  return target.kind === "series" ? "series" : `volume:${target.volumeId}`;
}

function volumeMembership(volume: KavitaVolumeCoverDto): string {
  if (!Array.isArray(volume.chapters) || volume.chapters.length > 2000)
    throw new Error(
      "Volume chapter membership is unavailable or exceeds the cover identity limit"
    );
  const references: string[] = [];
  for (const chapter of volume.chapters) {
    if (
      !Number.isSafeInteger(chapter.id) ||
      chapter.id <= 0 ||
      !Array.isArray(chapter.files)
    )
      throw new Error("Volume chapter identity is unavailable");
    references.push(`chapter:${chapter.id}`);
    for (const file of chapter.files) {
      if (references.length >= 10000)
        throw new Error(
          "Volume file membership exceeds the cover identity limit"
        );
      if (typeof file.filePath !== "string" || !file.filePath)
        throw new Error("Volume file identity is unavailable");
      references.push(`file:${chapter.id}:${file.id ?? ""}:${file.filePath}`);
    }
  }
  references.sort();
  return createHash("sha256").update(JSON.stringify(references)).digest("hex");
}

/** The Kavita reads a cover observation needs. */
export type CoverObservationClient = Pick<
  KavitaClient,
  | "getSeriesDto"
  | "getServerInfo"
  | "getSeriesCoverForHistory"
  | "getVolumeCoverForHistory"
  | "getVolumeForCoverHistory"
>;

export async function observeCover(
  client: CoverObservationClient,
  seriesId: number,
  target: CoverTarget,
  expected: MetadataSnapshot,
  connectionKey: string
): Promise<CoverObservation> {
  const activeConnection = () =>
    kavitaConnectionKey(getKavitaConnection().baseUrl);
  if (activeConnection() !== connectionKey)
    throw new Error("Kavita connection changed during cover observation");
  const [series, info, volume] = await Promise.all([
    client.getSeriesDto(seriesId),
    typeof client.getServerInfo === "function"
      ? client.getServerInfo()
      : Promise.resolve(undefined),
    target.kind === "volume"
      ? client.getVolumeForCoverHistory(target.volumeId)
      : Promise.resolve(null),
  ]);
  if (
    series.id !== seriesId ||
    series.libraryId !== expected.series.libraryId ||
    (Object.hasOwn(expected.series, "folderPath") &&
      series.folderPath !== expected.series.folderPath)
  )
    throw new Error("Series identity changed during cover observation");
  if (
    expected.installationId !== undefined &&
    info?.installId !== expected.installationId
  )
    throw new Error("Kavita installation changed during cover observation");
  if (
    target.kind === "volume" &&
    volume &&
    (volume.id !== target.volumeId ||
      volume.seriesId !== seriesId ||
      !Number.isFinite(Date.parse(volume.createdUtc)))
  )
    throw new Error("Volume identity no longer belongs to this series");
  const token = volume ? volume.coverImage : series.coverImage;
  if (token !== null && typeof token !== "string")
    throw new Error("Kavita did not return the cover image identity");
  const rawLock = volume ? volume.coverImageLocked : series.coverImageLocked;
  if (rawLock !== undefined && typeof rawLock !== "boolean")
    throw new Error("Kavita returned an invalid native cover lock");
  if (!volume && typeof rawLock !== "boolean")
    throw new Error("Kavita did not return the original series-cover lock");
  const locked = typeof rawLock === "boolean" ? rawLock : null;
  const nativeLockReason =
    locked === null
      ? "This Kavita release does not expose the current volume-cover lock. Its value was not inferred."
      : null;
  const image = volume
    ? await client.getVolumeCoverForHistory(volume.id)
    : await client.getSeriesCoverForHistory(seriesId);
  if (!image && token !== null && token !== "")
    throw new Error(
      "Cover image is unreadable; a failed image read is not an absent cover"
    );
  const evidence: CoverEvidence = {
    seriesId,
    libraryId: series.libraryId,
    token,
    ...(Object.hasOwn(series, "folderPath")
      ? { folderPath: series.folderPath }
      : {}),
    ...(info?.installId ? { installationId: info.installId } : {}),
    ...(volume
      ? {
          volume: {
            id: volume.id,
            seriesId: volume.seriesId,
            createdUtc: volume.createdUtc,
            membership: volumeMembership(volume),
          },
        }
      : {}),
  };
  const [afterSeries, afterVolume] = await Promise.all([
    client.getSeriesDto(seriesId),
    volume ? client.getVolumeForCoverHistory(volume.id) : Promise.resolve(null),
  ]);
  if (
    activeConnection() !== connectionKey ||
    afterSeries.id !== series.id ||
    afterSeries.libraryId !== series.libraryId ||
    afterSeries.folderPath !== series.folderPath ||
    (afterVolume
      ? afterVolume.coverImage !== token ||
        afterVolume.coverImageLocked !== rawLock ||
        afterVolume.createdUtc !== volume!.createdUtc ||
        afterVolume.seriesId !== seriesId ||
        volumeMembership(afterVolume) !== evidence.volume!.membership
      : afterSeries.coverImage !== token ||
        afterSeries.coverImageLocked !== rawLock)
  )
    throw new Error(
      "Cover or indexed identity changed while it was being observed"
    );
  return {
    state: image ? "captured" : "absent",
    assetId: image
      ? createHash("sha256").update(image.data).digest("hex")
      : null,
    data: image?.data ?? null,
    mediaType: image ? coverMediaType(image.data) : null,
    locked,
    nativeLockReason,
    name: volume
      ? volume.name?.trim() || `Volume #${volume.id}`
      : "Series cover",
    evidence,
  };
}

export function sameCoverObservation(
  expected: Omit<CoverObservation, "data">,
  current: CoverObservation
): boolean {
  return (
    expected.state === current.state &&
    expected.assetId === current.assetId &&
    expected.locked === current.locked &&
    JSON.stringify(expected.evidence) === JSON.stringify(current.evidence)
  );
}

function coverBudgetUsage(db: ReturnType<typeof getDb>): number {
  const used = db
    .select({
      bytes: sql<number>`coalesce(sum(${schema.metadataAssets.byteSize}), 0)`,
    })
    .from(schema.metadataAssets)
    .get()!.bytes;
  const seriesReserved = db
    .select({
      bytes: sql<number>`coalesce(sum(${schema.metadataSeriesCovers.reservedBytes}), 0)`,
    })
    .from(schema.metadataSeriesCovers)
    .where(sql`${schema.metadataSeriesCovers.reservedBytes} > 0`)
    .get()!.bytes;
  const volumeReserved = db
    .select({
      bytes: sql<number>`coalesce(sum(${schema.metadataVolumeCovers.reservedBytes}), 0)`,
    })
    .from(schema.metadataVolumeCovers)
    .where(sql`${schema.metadataVolumeCovers.reservedBytes} > 0`)
    .get()!.bytes;
  return used + seriesReserved + volumeReserved;
}

export function retainCoverWithBudgetCheck(
  value: CoverObservation,
  requireReadbackFits: boolean
): void {
  const db = getDb();
  const budget = coverStorageBudget();
  let currentUsage: number | undefined;
  if (value.assetId && value.data && value.mediaType) {
    const existing = db
      .select()
      .from(schema.metadataAssets)
      .where(eq(schema.metadataAssets.id, value.assetId))
      .get();
    if (existing) {
      if (
        existing.byteSize !== value.data.length ||
        existing.data.length !== existing.byteSize ||
        createHash("sha256").update(existing.data).digest("hex") !==
          value.assetId
      )
        throw new Error(
          "An existing retained image asset failed integrity checks; the cover write was not started"
        );
    } else {
      currentUsage = coverBudgetUsage(db);
      if (currentUsage + value.data.length > budget)
        throw new Error(
          "Retained cover storage reached its configured budget; no retained history was evicted. Increase the cover-history budget before retrying"
        );
      db.insert(schema.metadataAssets)
        .values({
          id: value.assetId,
          mediaType: value.mediaType,
          byteSize: value.data.length,
          data: value.data,
        })
        .run();
      currentUsage += value.data.length;
    }
  }
  if (requireReadbackFits) {
    const total = currentUsage ?? coverBudgetUsage(db);
    if (total > budget)
      throw new Error(
        "Insufficient cover-history storage for guaranteed readback; increase its budget before writing"
      );
  }
}

export function retainCoverObservation(value: CoverObservation): void {
  retainCoverWithBudgetCheck(value, false);
}

export function coverReadbackReservationFits(): boolean {
  return coverBudgetUsage(getDb()) <= coverStorageBudget();
}

export function hasCoverAssetMetadata(assetId: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(assetId)) return false;
  const asset = getDb()
    .select({ byteSize: schema.metadataAssets.byteSize })
    .from(schema.metadataAssets)
    .where(eq(schema.metadataAssets.id, assetId))
    .get();
  return (
    !!asset && asset.byteSize > 0 && asset.byteSize <= MAX_RETAINED_COVER_BYTES
  );
}

export function loadCoverAsset(
  assetId: string
): { data: Buffer; mediaType: string } | null {
  if (!/^[a-f0-9]{64}$/.test(assetId)) return null;
  const asset = getDb()
    .select()
    .from(schema.metadataAssets)
    .where(eq(schema.metadataAssets.id, assetId))
    .get();
  if (
    !asset ||
    !asset.data.length ||
    asset.data.length > MAX_RETAINED_COVER_BYTES ||
    asset.data.length !== asset.byteSize ||
    createHash("sha256").update(asset.data).digest("hex") !== assetId
  )
    return null;
  try {
    if (coverMediaType(asset.data) !== asset.mediaType) return null;
  } catch {
    return null;
  }
  return { data: asset.data, mediaType: asset.mediaType };
}
