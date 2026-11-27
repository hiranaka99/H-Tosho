/** Retention budgets are hard admission limits; active history is never evicted to admit a new image. */
export const MAX_RETAINED_COVER_BYTES = 5 * 1024 * 1024;
export const MAX_RETAINED_COVER_STORE_BYTES = 256 * 1024 * 1024;
export const COVER_RESTORE_CONVERSION_WARNING =
  "Kavita may resize and re-encode the saved image using its current cover settings. Original backup bytes stay retained; the observed restored image is journaled. This is not byte-exact restoration.";
export type RecordedCoverState = "captured" | "absent" | "unavailable";
export interface RecordedCover {
  state: RecordedCoverState;
  assetId: string | null;
  mediaType: string | null;
  byteSize: number | null;
  nativeLocked: boolean | null;
  nativeLockReason?: string | null;
  reason: string | null;
}
export type CoverTarget =
  { kind: "series" } | { kind: "volume"; volumeId: number };
export type CoverNativeLockChoice =
  "preserve" | "saved" | "locked" | "unlocked";
export interface CoverRestoreSelection {
  kind: "series" | "volume";
  volumeId?: number;
  nativeLock?: CoverNativeLockChoice;
}
export interface CoverCheckpoint {
  kind: "series" | "volume";
  volumeId?: number;
  name: string;
  status: string;
  before: RecordedCover;
  after: RecordedCover;
  changed: boolean | null;
  requestedLock: boolean | null;
  writeAcknowledged: boolean;
  restoreAvailability: {
    before: { available: boolean; reason: string | null };
    after: { available: boolean; reason: string | null };
  };
}
export interface CoverHistory {
  series?: CoverCheckpoint;
  volumes: CoverCheckpoint[];
}
export interface CoverRestorePreview {
  target: CoverTarget;
  name: string;
  current: RecordedCover;
  restoreTo: RecordedCover;
  available: boolean;
  reason: string | null;
  nativeLock: CoverNativeLockChoice;
  requestedLock: boolean | null;
  nativeLockReadbackAvailable: boolean;
  laterEdit: boolean;
}
