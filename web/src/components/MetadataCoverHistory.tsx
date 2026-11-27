import * as React from "react";
import type {
  RecordedCover,
  CoverHistory,
  CoverCheckpoint,
} from "../../../server/src/contracts/metadataCovers";
import { Button, Pager } from "./ui";

export function RecordedCoverImage({
  seriesId,
  operationId,
  label,
  cover,
  src,
}: {
  seriesId: number;
  operationId: string;
  label: string;
  cover: RecordedCover;
  src?: string;
}) {
  const [attempt, setAttempt] = React.useState(0),
    [state, setState] = React.useState<"loading" | "loaded" | "error">(
      "loading"
    );
  const baseUrl =
    src ??
    (cover.assetId
      ? `/api/series/${seriesId}/metadata-history/${encodeURIComponent(operationId)}/assets/${encodeURIComponent(cover.assetId)}`
      : null);
  const url = baseUrl
    ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}attempt=${attempt}`
    : null;
  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="text-xs font-medium text-muted">
        {label}
      </figcaption>
      {cover.state === "captured" && url ? (
        <>
          {state !== "error" && (
            <img
              key={url}
              src={url}
              alt={`${label} recorded cover`}
              loading="lazy"
              decoding="async"
              onLoad={() => setState("loaded")}
              onError={() => setState("error")}
              className="h-44 max-w-full rounded object-contain object-left"
            />
          )}
          {state === "loading" && (
            <p role="status" className="text-xs text-muted">
              Loading retained cover…
            </p>
          )}
          {state === "error" && (
            <div role="alert" className="space-y-2">
              <p className="text-xs text-danger">
                Retained cover could not be displayed.
              </p>
              <Button
                className="min-h-11"
                size="sm"
                variant="outline"
                onClick={() => {
                  setState("loading");
                  setAttempt((value) => value + 1);
                }}
              >
                Retry {label.toLowerCase()} cover
              </Button>
            </div>
          )}
          <p className="break-words text-xs text-muted">
            {cover.mediaType} · {cover.byteSize?.toLocaleString()} bytes
          </p>
        </>
      ) : (
        <p className="break-words text-sm">
          {cover.state === "absent"
            ? "No cover image was present."
            : (cover.reason ?? "This cover image was not captured.")}
        </p>
      )}
      <p className="text-xs text-muted">
        Kavita cover lock:{" "}
        {cover.nativeLocked === null
          ? "Not recorded"
          : cover.nativeLocked
            ? "locked"
            : "unlocked"}
      </p>
      {cover.nativeLocked === null && cover.nativeLockReason && (
        <p className="text-xs text-muted">{cover.nativeLockReason}</p>
      )}
    </figure>
  );
}

function CheckpointImages({
  seriesId,
  operationId,
  checkpoint,
}: {
  seriesId: number;
  operationId: string;
  checkpoint: CoverCheckpoint;
}) {
  const [open, setOpen] = React.useState(checkpoint.kind === "series");
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 border-t border-border"
    >
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
        {checkpoint.kind === "series"
          ? "Series cover history"
          : `${checkpoint.name} · Volume #${checkpoint.volumeId}`}
      </summary>
      {open && (
        <div className="min-w-0 space-y-3 pb-3">
          <p className="text-xs text-muted">
            Capture: {checkpoint.status}.{" "}
            {checkpoint.changed === true
              ? "The image or a recorded native lock changed."
              : checkpoint.changed === false
                ? "The image and recorded native lock stayed the same."
                : "Some image/native-lock evidence is unavailable."}
          </p>
          <div className="grid min-w-0 grid-cols-2 gap-4 sm:max-w-lg">
            {(["before", "after"] as const).map((side) => (
              <RecordedCoverImage
                key={`${seriesId}:${operationId}:${side}:${checkpoint[side].assetId}:${checkpoint[side].state}`}
                seriesId={seriesId}
                operationId={operationId}
                label={side === "before" ? "Before" : "After (observed)"}
                cover={checkpoint[side]}
              />
            ))}
          </div>
          {checkpoint.requestedLock !== null && (
            <p className="text-xs text-muted">
              Requested native lock:{" "}
              {checkpoint.requestedLock ? "locked" : "unlocked"} · API
              acknowledgement:{" "}
              {checkpoint.writeAcknowledged
                ? "confirmed"
                : "not recorded/confirmed"}
              . Recorded values above are independent observations.
            </p>
          )}
        </div>
      )}
    </details>
  );
}

export function MetadataCoverHistory({
  seriesId,
  operationId,
  history,
}: {
  seriesId: number;
  operationId: string;
  history?: CoverHistory;
}) {
  const [page, setPage] = React.useState(1);
  const count = Math.max(1, Math.ceil((history?.volumes.length ?? 0) / 20));
  const currentPage = Math.min(page, count);
  return (
    <section
      aria-label="Cover history"
      className="mt-4 min-w-0 space-y-3 border-t border-border pt-4"
    >
      <h3 className="text-sm font-semibold">Cover history</h3>
      {history?.series && (
        <CheckpointImages
          seriesId={seriesId}
          operationId={operationId}
          checkpoint={history.series}
        />
      )}
      {!!history?.volumes.length && (
        <div className="min-w-0 space-y-2">
          <h4 className="text-sm font-medium">
            Volume cover history ({history.volumes.length})
          </h4>
          {history.volumes
            .slice((currentPage - 1) * 20, currentPage * 20)
            .map((checkpoint) => (
              <CheckpointImages
                key={checkpoint.volumeId}
                seriesId={seriesId}
                operationId={operationId}
                checkpoint={checkpoint}
              />
            ))}
          {count > 1 && (
            <Pager page={currentPage} count={count} onPageChange={setPage} />
          )}
        </div>
      )}
      {!history && (
        <p className="max-w-prose text-xs text-muted">
          No cover snapshot was recorded for this operation. Earlier updates
          have no saved image backup.
        </p>
      )}
      <p className="max-w-prose text-xs text-muted">
        Viewing saved images does not change your library. Captured images can
        be selected in the reviewed restore controls below; Kavita may
        resize/re-encode uploads.
      </p>
    </section>
  );
}
