import { Hono } from "hono";
import { jobQueue } from "../../jobs/queue.js";
import { getDoujinProvider } from "../../downloader/providers.js";
import { rewriteDoujinCover } from "../media.js";
import {
  addWatchedSearch,
  listNewGalleries,
  listWatchedSearches,
  getWatchedSearch,
  watchedSearchesExist,
  updateWatchedSearch,
  removeWatchedSearch,
  listGalleryFeed,
  setGalleriesReviewed,
  FollowingError,
  listWatchedSearchFolders,
  addWatchedSearchFolder,
  patchWatchedSearchFolder,
  removeWatchedSearchFolder,
} from "../../services/watchedSearches.js";
import { isDoujinSource, type DoujinSource } from "../../contracts/doujin.js";
import {
  followSuggestedArtist,
  listSuggestedFollows,
  setSuggestedFollowDismissed,
} from "../../services/suggestedFollows.js";
import {
  FOLLOWING_TARGET_LIMIT,
  type CheckWatchedSearchesCommand,
  type WatchedSearchPatch,
  type WatchedSearchFolderPatch,
} from "../../contracts/following.js";

import { intParam } from "./helpers.js";
export const api = new Hono();
api.onError((error, c) => {
  if (error instanceof FollowingError)
    return c.json({ error: error.message }, error.status);
  throw error;
});
api.get("/watched-searches", (c) => c.json(listWatchedSearches()));

api.get("/watched-searches/suggestions", (c) =>
  c.json({ items: listSuggestedFollows() })
);

api.post("/watched-searches/suggestions/follow", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    artist?: unknown;
    source?: unknown;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["artist", "source"].includes(key)) ||
    typeof body.artist !== "string" ||
    !isDoujinSource(body.source)
  )
    return c.json({ error: "Provide an artist and source." }, 400);
  return c.json(followSuggestedArtist(body.artist, body.source), 201);
});

api.post("/watched-searches/suggestions/dismiss", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    artist?: unknown;
    dismissed?: unknown;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["artist", "dismissed"].includes(key)) ||
    typeof body.artist !== "string" ||
    typeof body.dismissed !== "boolean"
  )
    return c.json({ error: "Provide an artist and dismissed." }, 400);
  setSuggestedFollowDismissed(body.artist, body.dismissed);
  return c.json({ ok: true });
});

api.get("/watched-searches/feed", (c) => {
  const view = c.req.query("view") ?? "inbox",
    source = c.req.query("source"),
    watch = c.req.query("searchId"),
    folder = c.req.query("folderId");
  const offset = Number(c.req.query("offset") ?? 0),
    limit = Number(c.req.query("limit") ?? 25);
  if (
    !["inbox", "history"].includes(view) ||
    (source && source !== "hitomi" && source !== "nhentai") ||
    (watch !== undefined &&
      (!Number.isSafeInteger(Number(watch)) || Number(watch) < 1)) ||
    (folder !== undefined &&
      folder !== "unfiled" &&
      (!Number.isSafeInteger(Number(folder)) || Number(folder) < 1)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return c.json({ error: "Invalid feed filters or page." }, 400);
  const feed = listGalleryFeed({
    view: view as "inbox" | "history",
    source,
    searchId: watch ? Number(watch) : undefined,
    folderId:
      folder === "unfiled"
        ? "unfiled"
        : folder !== undefined
          ? Number(folder)
          : undefined,
    offset,
    limit,
  });
  return c.json({ ...feed, items: feed.items.map(rewriteDoujinCover) });
});

api.post("/watched-searches/review", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    items?: { source: DoujinSource; galleryId: string }[];
    reviewed?: boolean;
  } | null;
  if (
    !body ||
    typeof body.reviewed !== "boolean" ||
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > 100 ||
    body.items.some(
      (item) =>
        !item ||
        !["hitomi", "nhentai"].includes(item.source) ||
        typeof item.galleryId !== "string" ||
        !item.galleryId.trim()
    )
  )
    return c.json(
      { error: "Provide 1–100 galleries and a reviewed state." },
      400
    );
  if (!setGalleriesReviewed(body.items, body.reviewed))
    return c.json(
      { error: "Discovery not found. Refresh the feed and try again." },
      404
    );
  return c.json({ ok: true });
});

/** Newest-first feed of galleries the watches reported as new ("Recently added"). */
api.get("/watched-searches/new", (c) => {
  const limitParam = Number(c.req.query("limit") ?? "100");
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), 500)
      : 100;
  // Hitomi covers need the /media proxy (their CDN requires a Referer the browser can't send).
  return c.json(listNewGalleries(limit).map(rewriteDoujinCover));
});

api.post("/watched-searches", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    source?: unknown;
    query?: unknown;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["source", "query"].includes(key))
  )
    return c.json({ error: "Provide source and query." }, 400);
  if (typeof body.source !== "string" || !getDoujinProvider(body.source))
    return c.json(
      {
        error: `Unknown source: ${typeof body.source === "string" ? body.source : ""}`,
      },
      400
    );
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return c.json({ error: "query is required" }, 400);
  const added = addWatchedSearch(body.source as DoujinSource, query);
  return c.json(added, 201);
});

api.delete("/watched-searches/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid watched search id" }, 400);
  const body = (await c.req.json().catch(() => null)) as {
    expectedRevision?: number;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "expectedRevision") ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    return c.json({ error: "Provide expectedRevision." }, 400);
  if (!removeWatchedSearch(id, body.expectedRevision!))
    return c.json({ error: "Watched search not found" }, 404);
  return c.json({ ok: true });
});

api.post("/watched-searches/check", async (c) => {
  const text = await c.req.text();
  let body: unknown = {};
  try {
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return c.json({ error: "Invalid check request." }, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "watchIds")
  )
    return c.json({ error: "Provide {} or watchIds only." }, 400);
  const ids = "watchIds" in body ? body.watchIds : undefined;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > FOLLOWING_TARGET_LIMIT ||
      ids.some((id) => !Number.isSafeInteger(id) || id < 1))
  )
    return c.json(
      { error: `Provide 1–${FOLLOWING_TARGET_LIMIT} positive watch IDs.` },
      400
    );
  const watchIds =
    ids === undefined
      ? undefined
      : [...new Set(ids as number[])].sort((a, b) => a - b);
  if (watchIds && !watchedSearchesExist(watchIds))
    return c.json(
      { error: "Watched search not found. Refresh and try again." },
      404
    );
  const active = jobQueue.active();
  const same = active.find((job) => {
    if (job.type !== "check-watched-searches") return false;
    const command = job.payload as CheckWatchedSearchesCommand;
    if (command.mode === "due") return false;
    const runningIds =
      command.watchIds === undefined
        ? undefined
        : [...new Set(command.watchIds)].sort((a, b) => a - b);
    return watchIds === undefined
      ? runningIds === undefined
      : runningIds !== undefined &&
          watchIds.length === runningIds.length &&
          watchIds.every((id, index) => id === runningIds[index]);
  });
  if (same) return c.json({ id: same.id, alreadyRunning: true }, 202);
  if (active.length)
    return c.json(
      {
        error:
          "An unrelated Task is active. Wait for it to finish before checking these watches.",
      },
      409
    );
  const id = jobQueue.enqueue("check-watched-searches", {
    mode: "manual",
    ...(watchIds !== undefined ? { watchIds } : {}),
  });
  return c.json({ id, alreadyRunning: false }, 202);
});

api.get("/watched-searches/check-status", (c) =>
  c.json(
    jobQueue.active().find((job) => job.type === "check-watched-searches") ??
      jobQueue.latest("check-watched-searches")
  )
);

api.get("/watched-searches/:id", (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid watched search id" }, 400);
  const watch = getWatchedSearch(id);
  return watch
    ? c.json(watch)
    : c.json({ error: "Watched search not found." }, 404);
});

api.patch("/watched-searches/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid watched search id" }, 400);
  const patch = (await c.req.json().catch(() => null)) as WatchedSearchPatch;
  return c.json(updateWatchedSearch(id, patch));
});

api.get("/watched-search-folders", (c) => c.json(listWatchedSearchFolders()));
api.post("/watched-search-folders", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "name") ||
    typeof body.name !== "string"
  )
    return c.json({ error: "Provide a folder name." }, 400);
  return c.json(addWatchedSearchFolder(body.name), 201);
});

api.patch("/watched-search-folders/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid folder id." }, 400);
  const patch = (await c.req
    .json()
    .catch(() => null)) as WatchedSearchFolderPatch;
  return c.json(patchWatchedSearchFolder(id, patch));
});

api.delete("/watched-search-folders/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid folder id." }, 400);
  const body = (await c.req.json().catch(() => null)) as {
    expectedRevision?: number;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "expectedRevision") ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    return c.json({ error: "Provide expectedRevision." }, 400);
  if (!removeWatchedSearchFolder(id, body.expectedRevision!))
    return c.json({ error: "Folder not found." }, 404);
  return c.json({ ok: true });
});
