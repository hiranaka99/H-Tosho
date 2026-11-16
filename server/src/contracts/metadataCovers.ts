/** Retention budgets are hard admission limits; active history is never evicted to admit a new image. */
export const MAX_RETAINED_COVER_BYTES = 5 * 1024 * 1024;
export const MAX_RETAINED_COVER_STORE_BYTES = 256 * 1024 * 1024;
export const COVER_RESTORE_UNAVAILABLE = 'Cover restoration is unavailable: Kavita resizes and re-encodes uploads, so exact saved bytes cannot currently be restored.';
export type RecordedCoverState = 'captured' | 'absent' | 'unavailable';
export interface RecordedCover {
  state: RecordedCoverState;
  assetId: string | null;
  mediaType: string | null;
  byteSize: number | null;
  nativeLocked: boolean | null;
  reason: string | null;
}
export interface SeriesCoverHistory {
  status: string;
  before: RecordedCover;
  after: RecordedCover;
  changed: boolean | null;
  restoreAvailable: false;
  restoreReason: string;
  volumeCovers: 'not captured';
}
