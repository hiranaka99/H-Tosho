import * as React from "react";
import { Button, Pager, Select } from "./ui";
import { RecordedCoverImage } from "./MetadataCoverHistory";
import {
  type CoverCheckpoint,
  type CoverRestoreSelection,
  type CoverRestorePreview,
  type CoverNativeLockChoice,
} from "../../../server/src/contracts/metadataCovers";

interface CoverSelectionProps {
  checkpoints: CoverCheckpoint[];
  side: "before" | "after";
  selections: CoverRestoreSelection[];
  disabled: boolean;
  protectedCover: boolean;
  onChange: (selections: CoverRestoreSelection[]) => void;
  onUnlock: () => void;
}

export function CoverRestoreSelectionControls({
  checkpoints,
  side,
  selections,
  disabled,
  protectedCover,
  onChange,
  onUnlock,
}: CoverSelectionProps) {
  const [page, setPage] = React.useState(1);
  const count = Math.max(1, Math.ceil(checkpoints.length / 20)),
    currentPage = Math.min(page, count);
  if (!checkpoints.length) return null;
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-3 border-t border-border pt-3"
    >
      <legend className="text-xs font-medium">
        Retained cover images to restore
      </legend>
      <p className="max-w-prose text-xs text-muted">
        Choose saved images to upload through Kavita's supported cover API.
        Review image conversion and native locks in the preview.
      </p>
      {protectedCover && (
        <div className="space-y-2">
          <p className="text-xs text-foreground dark:text-warning">
            Series and volume covers are protected from H-Tosho sync. Explicitly
            unlock, then prepare a fresh preview.
          </p>
          <Button
            className="min-h-11"
            size="sm"
            variant="outline"
            onClick={onUnlock}
          >
            Unlock cover protection
          </Button>
        </div>
      )}
      {checkpoints
        .slice((currentPage - 1) * 20, currentPage * 20)
        .map((checkpoint) => {
          const selected = selections.find(
            (item) =>
              item.kind === checkpoint.kind &&
              item.volumeId === checkpoint.volumeId
          );
          const label =
            checkpoint.kind === "series"
              ? "Series cover"
              : `${checkpoint.name} (volume #${checkpoint.volumeId})`;
          const availability = checkpoint.restoreAvailability[side];
          const setSelection = (selection: CoverRestoreSelection | null) =>
            onChange([
              ...selections.filter(
                (item) =>
                  item.kind !== checkpoint.kind ||
                  item.volumeId !== checkpoint.volumeId
              ),
              ...(selection ? [selection] : []),
            ]);
          const target: CoverRestoreSelection = {
            kind: checkpoint.kind,
            ...(checkpoint.kind === "volume"
              ? { volumeId: checkpoint.volumeId }
              : {}),
          };
          return (
            <div
              key={`${checkpoint.kind}:${checkpoint.volumeId ?? ""}`}
              className="min-w-0 space-y-2 border-t border-border py-2"
            >
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Restore ${label}`}
                  disabled={!availability.available || protectedCover}
                  checked={!!selected}
                  onChange={() =>
                    setSelection(
                      selected ? null : { ...target, nativeLock: "preserve" }
                    )
                  }
                />
                Restore {label}
              </label>
              {!availability.available && (
                <p className="break-words text-xs text-muted">
                  {availability.reason}
                </p>
              )}
              {selected && (
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
                  Kavita cover lock for {label}
                  <Select
                    className="min-h-11 w-full max-w-sm"
                    aria-label={`Kavita cover lock for ${label}`}
                    value={selected.nativeLock ?? "preserve"}
                    onChange={(event) =>
                      setSelection({
                        ...selected,
                        nativeLock: event.target.value as CoverNativeLockChoice,
                      })
                    }
                  >
                    <option value="preserve">
                      Preserve current lock (requires readback)
                    </option>
                    <option
                      value="saved"
                      disabled={checkpoint[side].nativeLocked === null}
                    >
                      Restore captured lock
                    </option>
                    <option value="locked">Apply Locked explicitly</option>
                    <option value="unlocked">Apply Unlocked explicitly</option>
                  </Select>
                </label>
              )}
            </div>
          );
        })}
      {count > 1 && (
        <Pager page={currentPage} count={count} onPageChange={setPage} />
      )}
    </fieldset>
  );
}

export function CoverRestorePreviewImages({
  seriesId,
  operationId,
  previewId,
  covers,
}: {
  seriesId: number;
  operationId: string;
  previewId: string;
  covers: CoverRestorePreview[];
}) {
  if (!covers.length) return null;
  return (
    <div className="min-w-0 space-y-3">
      <h5 className="text-sm font-semibold">Cover image changes</h5>
      {covers.map((cover) => (
        <div
          key={`${cover.target.kind}:${cover.target.kind === "volume" ? cover.target.volumeId : ""}`}
          className="min-w-0 space-y-2 border-t border-border pt-3"
        >
          <p className="break-words text-sm font-medium">
            {cover.name}
            {cover.target.kind === "volume"
              ? ` · Volume #${cover.target.volumeId}`
              : ""}
          </p>
          {!cover.available && (
            <p className="text-sm text-danger">{cover.reason}</p>
          )}
          {cover.laterEdit && (
            <p className="text-xs text-foreground dark:text-warning">
              A later cover change exists. Restoring will replace the currently
              observed image.
            </p>
          )}
          <div className="grid min-w-0 grid-cols-2 gap-4 sm:max-w-lg">
            <RecordedCoverImage
              key={`${seriesId}:${previewId}:${cover.current.assetId}`}
              seriesId={seriesId}
              operationId={operationId}
              label="Current"
              cover={cover.current}
              src={
                cover.current.assetId
                  ? `/api/series/${seriesId}/metadata-restore-previews/${encodeURIComponent(previewId)}/assets/${encodeURIComponent(cover.current.assetId)}`
                  : undefined
              }
            />
            <RecordedCoverImage
              key={`${seriesId}:${operationId}:${cover.restoreTo.assetId}:${cover.restoreTo.state}`}
              seriesId={seriesId}
              operationId={operationId}
              label="Saved image to upload"
              cover={cover.restoreTo}
            />
          </div>
          <p className="text-xs text-muted">
            Native lock choice: {cover.nativeLock} · requested state:{" "}
            {cover.requestedLock === null
              ? "unavailable"
              : cover.requestedLock
                ? "locked"
                : "unlocked"}
            .
          </p>
          {cover.target.kind === "volume" &&
            cover.current.state !== "unavailable" &&
            !cover.nativeLockReadbackAvailable && (
              <p className="max-w-prose text-xs text-foreground dark:text-warning">
                This server does not expose native volume-lock readback. Choose
                Locked or Unlocked explicitly; the image and API acknowledgement
                can be observed, but the native flag will not be reported as
                independently verified.
              </p>
            )}
        </div>
      ))}
    </div>
  );
}
