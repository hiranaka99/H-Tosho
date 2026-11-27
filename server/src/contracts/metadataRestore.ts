import type { MetadataSnapshot, RecordedValue } from "./metadataHistory.js";
import type {
  CoverRestoreSelection,
  CoverRestorePreview,
} from "./metadataCovers.js";

/** Title requires complete accessible archive inventory; retained images have separately reviewed API restore plans. */
export const RESTORABLE_METADATA_FIELDS = [
  "title",
  "summary",
  "genres",
  "tags",
  "writers",
  "artists",
  "releaseDate",
  "language",
  "status",
  "url",
] as const;
export type RestorableMetadataField =
  (typeof RESTORABLE_METADATA_FIELDS)[number];
export type RestoreSnapshotSide = "before" | "after";
export const RESTORE_FIELD_MAPPINGS = {
  title: { key: "name", lock: "nameLocked" },
  summary: { key: "summary", lock: "summaryLocked" },
  genres: { key: "genres", lock: "genresLocked" },
  tags: { key: "tags", lock: "tagsLocked" },
  writers: { key: "writers", lock: "writerLocked" },
  artists: { key: "pencillers", lock: "pencillerLocked" },
  releaseDate: { key: "releaseYear", lock: "releaseYearLocked" },
  language: { key: "language", lock: "languageLocked" },
  status: { key: "publicationStatus", lock: "publicationStatusLocked" },
  url: { key: "webLinks" },
} as const;

export function isRestorableMetadataField(
  value: unknown
): value is RestorableMetadataField {
  return (
    typeof value === "string" &&
    RESTORABLE_METADATA_FIELDS.some((field) => field === value)
  );
}

/** Compare list contents, not transient Kavita IDs or ordering; retain null/absence/text distinctions. */
export function metadataValueKey(
  cell: RecordedValue | undefined,
  includeLock = true
): string {
  if (!cell) return "uncaptured";
  const value = Array.isArray(cell.value)
    ? (cell.value as unknown[])
        .map((item): unknown => {
          if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>;
            return rec.name ?? rec.title;
          }
          return item;
        })
        .sort((a, b) =>
          (JSON.stringify(a) ?? "undefined").localeCompare(
            JSON.stringify(b) ?? "undefined"
          )
        )
    : cell.value;
  return JSON.stringify({
    present: cell.present,
    ...(cell.present ? { value } : {}),
    ...(includeLock && cell.nativeLocked !== undefined
      ? { nativeLocked: cell.nativeLocked }
      : {}),
  });
}

/** Only values representable by Kavita's metadata endpoint can be promised exactly. */
export function getMetadataRestoreFieldAvailability(
  field: string,
  cell: RecordedValue | undefined
): RestoreFieldAvailability {
  const mapping = isRestorableMetadataField(field)
    ? RESTORE_FIELD_MAPPINGS[field]
    : undefined;
  const nativeLockAvailable =
    !!mapping && "lock" in mapping && typeof cell?.nativeLocked === "boolean";
  const unavailable = (reason: string): RestoreFieldAvailability => ({
    field,
    available: false,
    reason,
    nativeLockAvailable,
  });
  if (field === "cover")
    return unavailable(
      "Cover images use the retained-image restore controls, not scalar metadata fields."
    );
  if (!mapping)
    return unavailable(
      "This field is not supported by selective metadata restoration."
    );
  if (!cell) return unavailable("The field was not captured in this snapshot.");
  if (typeof cell.present !== "boolean")
    return unavailable(
      "The snapshot does not record whether this field was present."
    );
  if (!cell.present)
    return unavailable(
      "Kavita cannot remove this DTO field; an absent field cannot be restored as empty or null."
    );
  if (!Object.prototype.hasOwnProperty.call(cell, "value"))
    return unavailable("The captured field value is missing.");
  if (
    field === "genres" ||
    field === "tags" ||
    field === "writers" ||
    field === "artists"
  ) {
    if (!Array.isArray(cell.value))
      return unavailable(
        "Kavita requires a list for this field; null cannot be restored as an empty list."
      );
    const rawNames = (cell.value as unknown[]).map((item): unknown =>
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)[
              field === "genres" || field === "tags" ? "title" : "name"
            ]
          : undefined
    );
    if (
      !rawNames.every(
        (name): name is string =>
          typeof name === "string" && Boolean(name.trim())
      )
    )
      return unavailable(
        "Every captured list entry must have a non-blank name."
      );
    const names = rawNames;
    if (names.some((name) => name.trim() !== name))
      return unavailable(
        "Kavita trims list entry names; surrounding whitespace cannot be restored exactly."
      );
    if (new Set(names).size !== names.length)
      return unavailable(
        "Kavita metadata lists cannot contain duplicate entries."
      );
  } else if (field === "releaseDate") {
    // Kavita 0.9's NumberHelper.IsValidYear ignores years below 1000;
    // releaseYear is also a non-nullable .NET Int32.
    if (
      typeof cell.value !== "number" ||
      !Number.isInteger(cell.value) ||
      cell.value < 1000 ||
      cell.value > 2_147_483_647
    ) {
      return unavailable(
        "Kavita only writes release years from 1000 through the 32-bit integer maximum; null and zero cannot be restored."
      );
    }
  } else if (field === "status") {
    if (
      typeof cell.value !== "number" ||
      !Number.isInteger(cell.value) ||
      cell.value < 0 ||
      cell.value > 4
    ) {
      return unavailable(
        "The captured publication status is not a supported Kavita status (0–4)."
      );
    }
  } else if (cell.value === null) {
    return unavailable(
      "Kavita converts null text to an empty string; exact null restoration is not supported."
    );
  } else if (typeof cell.value !== "string") {
    return unavailable("The captured field must be text.");
  } else if (
    field === "title" &&
    (!cell.value.trim() ||
      cell.value.trim() !== cell.value ||
      /[\u0000-\u001f]/.test(cell.value))
  ) {
    return unavailable(
      "A title must be non-blank text without surrounding whitespace or control characters."
    );
  } else if (field === "summary" && cell.value.trim() !== cell.value) {
    return unavailable(
      "Kavita trims summary text; the captured surrounding whitespace cannot be restored exactly."
    );
  } else if (
    field === "url" &&
    cell.value
      .split(",")
      .filter((part) => part.length > 0)
      .map((part) => part.trim())
      .join(",") !== cell.value
  ) {
    return unavailable(
      "Kavita normalizes comma-separated web links; the captured text cannot be restored exactly."
    );
  }
  return { field, available: true, reason: null, nativeLockAvailable };
}

export interface RestorePreviewRequest {
  snapshot: RestoreSnapshotSide;
  fields: RestorableMetadataField[];
  nativeLockFields?: RestorableMetadataField[];
  archives?: ArchiveRestoreSelection[];
  covers?: CoverRestoreSelection[];
}
export interface ArchiveRestoreSelection {
  id: number;
  mode: "fields" | "document";
  fields?: string[];
}
export interface ArchiveRestorePreview {
  id: number | null;
  target: string;
  mode: "fields" | "document" | "title";
  available: boolean;
  reason: string | null;
  laterEdit: boolean;
  changes: {
    field: string;
    current: RecordedValue;
    restoreTo: RecordedValue;
  }[];
}
export interface RestoreFieldAvailability {
  field: string;
  available: boolean;
  reason: string | null;
  nativeLockAvailable: boolean;
}
export interface MetadataRestorePreview {
  id: string;
  operationId: string;
  seriesId: number;
  snapshot: RestoreSnapshotSide;
  expiresAt: string;
  policyRevision: number;
  requestedFields: RestorableMetadataField[];
  effectiveFields: RestorableMetadataField[];
  nativeLockFields: RestorableMetadataField[];
  fields: {
    field: RestorableMetadataField;
    current: RecordedValue;
    restoreTo: RecordedValue;
    protected: boolean;
    available: boolean;
    reason: string | null;
    laterEdit: boolean;
  }[];
  conflicts: string[];
  canRestore: boolean;
  archives?: ArchiveRestorePreview[];
  covers?: CoverRestorePreview[];
}
export interface RestoreMetadataCommand {
  seriesId: number;
  connectionKey: string;
  planId: string;
}
export type MetadataRestoreResult = {
  restored: RestorableMetadataField[];
  restoredArchives?: number;
  restoredCovers?: number;
  unverifiedCoverLocks?: number;
  operationId: string;
};
export interface ExactMetadataRestoreOptions {
  expected: MetadataSnapshot;
  nativeLockFields: RestorableMetadataField[];
  checkCancelled?: () => void;
}
export type ExactMetadataRestoreValues = Partial<
  Record<RestorableMetadataField, RecordedValue>
>;

export function titleRestoreCapability(
  context: MetadataSnapshot["titleContext"]
): string | null {
  if (
    !context ||
    typeof context.sortNameLocked !== "boolean" ||
    typeof context.localizedNameLocked !== "boolean" ||
    typeof context.coverImageLocked !== "boolean"
  ) {
    return "Kavita did not return the sort-name, localized-name and cover locks needed to preserve unrelated title settings.";
  }
  if (
    ![context.sortName, context.localizedName].every(
      (value) =>
        value === null || (typeof value === "string" && value.trim() === value)
    )
  ) {
    return "Current sort/localized names are missing or would be normalized by Kavita; an exact title restore is unavailable.";
  }
  return null;
}
