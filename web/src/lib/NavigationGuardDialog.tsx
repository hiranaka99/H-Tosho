import * as React from "react";
import type { Blocker } from "react-router";
import { Button } from "../components/ui";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../components/dialog";
import type { useSettingsNavigation } from "./SettingsDrafts";

/** Loaded on first blocked navigation so the dialog primitives stay out of the startup bundle. */
export default function NavigationGuardDialog({
  blocker,
  drafts,
}: {
  blocker: Blocker;
  drafts: ReturnType<typeof useSettingsNavigation>;
}) {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const stay = () => {
    if (saving || drafts.pending) return;
    setError("");
    if (blocker.state === "blocked") blocker.reset();
  };
  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(event) => {
          if (saving || drafts.pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (saving || drafts.pending) event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-4 p-5 pr-12">
          <div>
            <DialogTitle>Save your settings changes?</DialogTitle>
            <DialogDescription className="mt-2">
              You have unsaved changes in {drafts.labels.join(", ")}. Save them
              before leaving, discard them, or stay to continue editing.
            </DialogDescription>
          </div>
          {!drafts.canSave && !saving && (
            <p className="text-sm text-muted">
              {drafts.invalid.length > 0
                ? `Fix the highlighted fields in ${drafts.invalid.map((entry) => entry.label).join(", ")} to save, or discard your changes.`
                : "Wait for the current save to finish before saving all changes."}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button
              variant="outline"
              disabled={saving || drafts.pending}
              onClick={stay}
            >
              Stay
            </Button>
            <Button
              variant="outline"
              disabled={saving || drafts.pending}
              onClick={() => {
                drafts.discardAll();
                setError("");
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              Discard
            </Button>
            <Button
              disabled={!drafts.canSave || saving}
              onClick={() => {
                void (async () => {
                  setSaving(true);
                  setError("");
                  try {
                    await drafts.saveAll();
                    if (blocker.state === "blocked") blocker.proceed();
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : String(cause)
                    );
                  } finally {
                    setSaving(false);
                  }
                })();
              }}
            >
              {saving ? "Saving…" : "Save & leave"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
