import type { DownloadErrorCode } from "../../../../server/src/contracts/downloads";
import { Link } from "react-router";
import { FolderOpen } from "lucide-react";
import { downloadErrorHelp } from "../../lib/downloadErrors";
import { Button, Badge, Spinner, Disclosure } from "../../components/ui";

import {
  DOWNLOADER_SETTINGS_URL,
  SOURCE_SETTINGS_URL,
  type DownloadSetup,
} from "./state";
export function DownloadDestination({
  setup,
  compact = false,
}: {
  setup: DownloadSetup;
  compact?: boolean;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted"
      role="status"
    >
      {setup.status === "loading" ? (
        <>
          <Spinner /> Checking download settings…
        </>
      ) : setup.status === "error" ? (
        <>
          <span>Could not check the download folder.</span>
          <Button size="sm" variant="outline" onClick={setup.onRetry}>
            Retry settings
          </Button>
        </>
      ) : setup.status === "missing" ? (
        <>
          {!compact && <span>Choose where downloads will be saved.</span>}
          <Link
            className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4"
            to={DOWNLOADER_SETTINGS_URL}
          >
            Set output folder
          </Link>
        </>
      ) : (
        <>
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-all">Save to {setup.directory}</span>
          <Badge tone="muted">
            {setup.format === "cbz" ? "CBZ" : "Image folder"}
          </Badge>
          <Link
            className="inline-flex min-h-9 items-center text-primary underline underline-offset-4"
            to={DOWNLOADER_SETTINGS_URL}
          >
            Change
          </Link>
        </>
      )}
    </div>
  );
}

export function DownloadFailure({
  message,
  code,
  source,
}: {
  message: string;
  code?: DownloadErrorCode | null;
  source?: string;
}) {
  const help = downloadErrorHelp(message, code, source);
  return (
    <div className="space-y-1">
      <p className="text-pretty text-sm text-danger">{help.message}</p>
      {help.settings && (
        <Link
          className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline underline-offset-4 max-lg:min-h-11 pointer-coarse:min-h-11"
          to={
            /denied access/.test(help.message)
              ? SOURCE_SETTINGS_URL
              : DOWNLOADER_SETTINGS_URL
          }
        >
          {/denied access/.test(help.message)
            ? "Open source settings"
            : "Open download settings"}
        </Link>
      )}
      <Disclosure
        label="Technical details"
        className="text-muted"
        summaryClassName="w-fit justify-start px-0 text-xs max-lg:min-h-11 pointer-coarse:min-h-11"
      >
        <p className="break-all pb-1 text-xs">{message}</p>
      </Disclosure>
    </div>
  );
}
