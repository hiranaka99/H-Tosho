import * as React from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ArrowDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  FOLLOWING_INTERVAL_MINUTES,
  type FollowingInterval,
  type NotificationMode,
  type WatchedSearch,
  type WatchedSearchFolder,
} from "../../../../server/src/contracts/following";
import { api, ApiError } from "../../lib/api";
import { Button, Input, Select } from "../../components/ui";
import { ConfirmDialog } from "../../components/dialog";
import { cn } from "../../lib/utils";

export const WATCH_DRAG_TYPE = "application/x-h-tosho-watch";

function WatchFolderDropTarget({
  folderId,
  folderName,
  draggedWatch,
  disabled,
  onMove,
  children,
  content,
}: {
  folderId: number | null;
  folderName: string;
  draggedWatch: WatchedSearch | null;
  disabled: boolean;
  onMove: (watch: WatchedSearch, folderId: number | null) => void;
  children: React.ReactNode;
  content: React.ReactNode;
}) {
  const [over, setOver] = React.useState(false);
  const acceptsWatch =
    !disabled && draggedWatch !== null && draggedWatch.folderId !== folderId;
  const active = acceptsWatch && over;
  React.useEffect(() => {
    if (!draggedWatch) setOver(false);
  }, [draggedWatch]);
  return (
    <li
      data-watch-folder-id={folderId ?? "unfiled"}
      aria-label={folderName}
      className={cn(
        "rounded-lg border border-transparent px-2 py-2 sm:px-3",
        acceptsWatch && "border-dashed border-primary/40",
        active && "border-primary bg-primary/10"
      )}
      onDragOver={(event) => {
        if (
          !acceptsWatch ||
          !event.dataTransfer.types.includes(WATCH_DRAG_TYPE)
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (
          !acceptsWatch ||
          event.dataTransfer.getData(WATCH_DRAG_TYPE) !==
            String(draggedWatch.id)
        )
          return;
        event.preventDefault();
        onMove(draggedWatch, folderId);
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {folderId === null ? (
          <Inbox aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
        ) : active ? (
          <FolderOpen
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-primary"
          />
        ) : (
          <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {acceptsWatch && (
        <p
          className={cn(
            "mt-1 break-words pl-6 text-xs",
            active ? "text-primary" : "text-muted"
          )}
        >
          {active ? "Release to move watch here" : "Drop watch here"}
        </p>
      )}
      {content}
    </li>
  );
}

export function cadenceLabel(minutes: number): string {
  if (minutes === 0) return "Off";
  if (minutes < 60) return `${minutes} min`;
  return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
}

export function WatchEditor({
  watch,
  folders,
  foldersReady,
  globalInterval,
  onClose,
  onSaved,
  onRefresh,
  initialFocus = "name",
}: {
  watch: WatchedSearch;
  folders: WatchedSearchFolder[];
  foldersReady: boolean;
  globalInterval: number;
  initialFocus?: "name" | "folder";
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(watch.displayName ?? "");
  const [folder, setFolder] = React.useState(
    watch.folderId === null ? "" : String(watch.folderId)
  );
  const [interval, setInterval] = React.useState(
    watch.intervalMinutes === null ? "" : String(watch.intervalMinutes)
  );
  const [notificationMode, setNotificationMode] =
    React.useState<NotificationMode>(watch.notificationMode);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  const [conflictRevision, setConflictRevision] = React.useState<number | null>(
    null
  );
  const stale =
    conflictRevision !== null && watch.revision === conflictRevision;
  const selectedFolderExists =
    !folder || folders.some((item) => String(item.id) === folder);
  const id = React.useId();
  const nameInvalid = name.trim().length > 120;
  async function save() {
    if (
      pending ||
      stale ||
      nameInvalid ||
      !selectedFolderExists ||
      !foldersReady
    )
      return;
    setPending(true);
    setError("");
    try {
      await api.updateWatchedSearch(watch.id, {
        expectedRevision: watch.revision,
        displayName: name.trim() || null,
        folderId: folder ? Number(folder) : null,
        intervalMinutes: interval
          ? (Number(interval) as FollowingInterval)
          : null,
        notificationMode,
      });
      await Promise.all([
        onRefresh(),
        qc.invalidateQueries({ queryKey: ["watched-gallery-feed"] }),
      ]);
      onSaved();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setConflictRevision(watch.revision);
        setError(
          "This watch changed elsewhere. Your draft is kept. Review the latest saved values below, then save again."
        );
        await onRefresh();
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (failure instanceof ApiError && failure.status === 404)
          await onRefresh();
      }
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      aria-label={`Edit watch ${watch.displayName ?? watch.query}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="mt-3 flex flex-col gap-3 border-t border-border pt-3"
    >
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_12rem]">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          Watch name
          <Input
            autoFocus={initialFocus === "name"}
            aria-label="Watch name"
            className="h-11"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            maxLength={120}
            placeholder={watch.query}
            aria-describedby={`${id}-name-hint`}
            aria-invalid={nameInvalid}
          />
          <span id={`${id}-name-hint`}>Defaults to query.</span>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          Folder
          <Select
            autoFocus={initialFocus === "folder"}
            aria-label="Folder"
            className="h-11"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            disabled={pending || !foldersReady}
          >
            <option value="">Unfiled</option>
            {!selectedFolderExists && (
              <option value={folder}>Folder removed — choose another</option>
            )}
            {folders.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          Check interval
          <Select
            aria-label="Check interval"
            className="h-11"
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
            disabled={pending}
          >
            <option value="">
              {globalInterval === 0
                ? "Default (off)"
                : `Default (every ${cadenceLabel(globalInterval)})`}
            </option>
            {FOLLOWING_INTERVAL_MINUTES.map((minutes) => (
              <option key={minutes} value={minutes}>
                Every {cadenceLabel(minutes)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Notification delivery
        <Select
          aria-label="Notification delivery"
          className="min-h-11 sm:max-w-xs"
          value={notificationMode}
          onChange={(event) =>
            setNotificationMode(event.target.value as NotificationMode)
          }
          disabled={pending}
        >
          <option value="in-app">In-app only</option>
          <option value="immediate">Immediate Discord</option>
        </Select>
      </label>
      <p className="-mt-2 text-xs text-muted">
        Discord delivery uses the webhook in{" "}
        <Link
          className="font-medium text-primary underline underline-offset-4"
          to="/settings?tab=notifications"
        >
          Settings → Notifications
        </Link>
        .
      </p>
      {globalInterval === 0 && (
        <p className="text-xs text-muted">
          Automatic checks are off for every watch while the default interval is
          Off. Change it at the bottom of this panel.
        </p>
      )}
      {error && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-danger">
          <p>{error}</p>
          {conflictRevision !== null && (
            <p className="break-words text-xs text-muted">
              Latest saved: {watch.displayName ?? watch.query} ·{" "}
              {folders.find((item) => item.id === watch.folderId)?.name ??
                "Unfiled"}{" "}
              ·{" "}
              {watch.intervalMinutes === null
                ? "Default interval"
                : `Every ${cadenceLabel(watch.intervalMinutes)}`}{" "}
              · {watch.pausedAt ? "Paused" : "Active"}
            </p>
          )}
          {stale && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 self-start"
              onClick={() => void onRefresh()}
            >
              Reload latest watch
            </Button>
          )}
        </div>
      )}
      {!selectedFolderExists && (
        <p role="alert" className="text-xs text-danger">
          The selected folder no longer exists. Choose a folder or Unfiled
          before saving.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11"
          size="sm"
          type="submit"
          disabled={
            pending ||
            stale ||
            nameInvalid ||
            !selectedFolderExists ||
            !foldersReady
          }
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save
          watch
        </Button>
        <Button
          className="min-h-11"
          size="sm"
          variant="ghost"
          type="button"
          disabled={pending}
          onClick={onClose}
        >
          Cancel edit
        </Button>
      </div>
    </form>
  );
}

export function FollowingFolders({
  folders,
  watches,
  watchesReady,
  renderWatch,
  onRefresh,
  draggedWatch,
  movePending,
  onMoveWatch,
}: {
  folders: WatchedSearchFolder[];
  onRefresh: () => Promise<unknown>;
  draggedWatch: WatchedSearch | null;
  movePending: boolean;
  onMoveWatch: (watch: WatchedSearch, folderId: number | null) => void;
  watches: WatchedSearch[];
  watchesReady: boolean;
  renderWatch: (watch: WatchedSearch) => React.ReactNode;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const createTrigger = React.useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [editName, setEditName] = React.useState("");
  const [removeTarget, setRemoveTarget] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  const [conflicted, setConflicted] = React.useState<{
    id: number;
    revision: number;
  } | null>(null);
  const stale =
    conflicted !== null &&
    folders.some(
      (folder) =>
        folder.id === conflicted.id && folder.revision === conflicted.revision
    );
  const target = folders.find((folder) => folder.id === removeTarget);
  const id = React.useId();
  function closeCreate() {
    setCreating(false);
    setName("");
    setError("");
    requestAnimationFrame(() => createTrigger.current?.focus());
  }
  const groups = React.useMemo(() => {
    const next = new Map<number | null, WatchedSearch[]>(
      folders.map((folder) => [folder.id, []])
    );
    next.set(null, []);
    for (const watch of watches)
      (next.get(watch.folderId) ?? next.get(null)!).push(watch);
    return next;
  }, [folders, watches]);
  function renderContents(folderId: number | null) {
    if (!watchesReady) return null;
    const items = groups.get(folderId) ?? [];
    return (
      <div
        data-watch-folder-content={folderId ?? "unfiled"}
        className="mt-1 border-l border-border pl-2 sm:ml-3 sm:pl-4"
      >
        {items.length ? (
          items.map(renderWatch)
        ) : (
          <p className="py-3 text-xs text-muted">Empty</p>
        )}
      </div>
    );
  }
  async function mutate(
    action: () => Promise<unknown>,
    folder?: WatchedSearchFolder
  ): Promise<boolean> {
    if (pending || stale) return false;
    setPending(true);
    setError("");
    try {
      await action();
      await Promise.all([
        onRefresh(),
        qc.invalidateQueries({ queryKey: ["watched-searches"] }),
        qc.invalidateQueries({ queryKey: ["watched-gallery-feed"] }),
      ]);
      setConflicted(null);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        if (folder) setConflicted({ id: folder.id, revision: folder.revision });
        setError(
          "A folder changed elsewhere. Drafts kept; the latest folder list has been requested. Review it and try again."
        );
        await onRefresh();
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (failure instanceof ApiError && failure.status === 404)
          await onRefresh();
      }
      return false;
    } finally {
      setPending(false);
    }
  }
  async function move(folder: WatchedSearchFolder, direction: -1 | 1) {
    const index = folders.findIndex((item) => item.id === folder.id);
    const neighbor = folders[index + direction];
    if (!neighbor) return;
    await mutate(
      () =>
        api.updateWatchedSearchFolder(folder.id, {
          expectedRevision: folder.revision,
          position: index + direction,
        }),
      folder
    );
  }
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-heading`} className="text-sm font-semibold">
          Folders
        </h3>
        {creating ? (
          <form
            id={`${id}-create`}
            aria-label="Add a watch folder"
            aria-busy={pending}
            data-owns-escape=""
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim())
                void mutate(() => api.addWatchedSearchFolder(name.trim())).then(
                  (saved) => {
                    if (saved) closeCreate();
                  }
                );
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending) {
                event.preventDefault();
                event.stopPropagation();
                closeCreate();
              }
            }}
            className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:max-w-md"
          >
            <label htmlFor={`${id}-name`} className="sr-only">
              New folder name
            </label>
            <Input
              id={`${id}-name`}
              autoFocus
              className="h-11 min-w-0 flex-1 sm:w-56"
              placeholder="Folder name"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            <Button
              className="min-h-11 shrink-0"
              size="sm"
              type="submit"
              disabled={pending || stale || !name.trim()}
            >
              {pending && (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              )}
              Create
            </Button>
            <Button
              className="h-11 w-11 shrink-0"
              size="icon"
              variant="ghost"
              type="button"
              disabled={pending}
              aria-label="Cancel new folder"
              title="Cancel"
              onClick={closeCreate}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </form>
        ) : (
          <Button
            ref={createTrigger}
            className="min-h-11 shrink-0"
            size="sm"
            variant="ghost"
            type="button"
            disabled={pending || stale}
            aria-expanded={creating}
            aria-controls={`${id}-create`}
            onClick={() => {
              setError("");
              setCreating(true);
            }}
          >
            <FolderPlus aria-hidden="true" className="h-4 w-4" />
            New folder
          </Button>
        )}
      </div>
      {error && (
        <div
          id={`${id}-error`}
          role="alert"
          className="flex flex-col gap-2 text-sm text-danger"
        >
          <p>{error}</p>
          {stale && (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 self-start"
              onClick={() => void onRefresh()}
            >
              Reload folders
            </Button>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-3" aria-label="Watch folders">
        {folders.map((folder, index) => (
          <WatchFolderDropTarget
            key={folder.id}
            folderId={folder.id}
            folderName={folder.name}
            draggedWatch={draggedWatch}
            disabled={pending || stale || movePending || editing === folder.id}
            onMove={onMoveWatch}
            content={renderContents(folder.id)}
          >
            {editing === folder.id ? (
              <form
                aria-label={`Rename folder ${folder.name}`}
                className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (editName.trim())
                    void mutate(
                      () =>
                        api.updateWatchedSearchFolder(folder.id, {
                          expectedRevision: folder.revision,
                          name: editName.trim(),
                        }),
                      folder
                    ).then((saved) => {
                      if (saved) setEditing(null);
                    });
                }}
              >
                <label className="min-w-0 flex-1 text-xs text-muted">
                  Folder name
                  <Input
                    autoFocus
                    className="mt-1 h-11"
                    maxLength={120}
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    disabled={pending}
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="min-h-11"
                    type="submit"
                    disabled={pending || stale || !editName.trim()}
                  >
                    Save folder
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
                    type="button"
                    disabled={pending}
                    onClick={() => setEditing(null)}
                  >
                    Cancel rename
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h4 className="min-w-0 break-words font-sans text-sm font-medium">
                    {folder.name}
                  </h4>
                  {watchesReady && (
                    <span
                      className="shrink-0 text-xs tabular-nums text-muted"
                      aria-label={`${groups.get(folder.id)!.length} watches`}
                    >
                      {groups.get(folder.id)!.length}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11"
                    disabled={pending || stale || index === 0}
                    aria-label={`Move folder ${folder.name} up`}
                    onClick={() => void move(folder, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11"
                    disabled={pending || stale || index === folders.length - 1}
                    aria-label={`Move folder ${folder.name} down`}
                    onClick={() => void move(folder, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11"
                    disabled={pending}
                    aria-label={`Rename folder ${folder.name}`}
                    onClick={() => {
                      setEditing(folder.id);
                      setEditName(folder.name);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11"
                    disabled={pending}
                    aria-label={`Delete folder ${folder.name}`}
                    onClick={() => setRemoveTarget(folder.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </WatchFolderDropTarget>
        ))}
        <WatchFolderDropTarget
          folderId={null}
          folderName="Unfiled"
          draggedWatch={draggedWatch}
          disabled={pending || stale || movePending}
          onMove={onMoveWatch}
          content={renderContents(null)}
        >
          <div className="flex min-h-11 items-center gap-2">
            <h4 className="text-sm font-medium">Unfiled</h4>
            {watchesReady && (
              <span
                className="text-xs tabular-nums text-muted"
                aria-label={`${groups.get(null)!.length} watches`}
              >
                {groups.get(null)!.length}
              </span>
            )}
          </div>
        </WatchFolderDropTarget>
      </ul>
      <ConfirmDialog
        open={removeTarget !== null}
        title="Delete watch folder?"
        description={
          target
            ? `Delete “${target.name}”? Its watches move to Unfiled. Discoveries and review history are kept.`
            : "This folder no longer exists. Close this dialog to continue."
        }
        details={
          error ? (
            <p role="alert" className="break-words text-sm text-danger">
              {error}
            </p>
          ) : undefined
        }
        confirmLabel={stale ? "Reload folders" : "Delete folder"}
        pending={pending}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoveTarget(null);
        }}
        onConfirm={() => {
          if (stale) void onRefresh();
          else if (target && !pending)
            void mutate(
              () => api.removeWatchedSearchFolder(target.id, target.revision),
              target
            ).then((saved) => {
              if (saved) setRemoveTarget(null);
            });
          else if (!target) setRemoveTarget(null);
        }}
      />
    </section>
  );
}
