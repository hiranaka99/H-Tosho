import { rememberDuplicateLibraryRoots } from "../../services/galleryDuplicates.js";
import { Hono } from "hono";
import { rewriteDoujinCover } from "../media.js";
import {
  getRecommendations,
  dismissAndReplace,
  undoDismiss,
  refreshRecommendations,
  setExcludedLibraries,
  applyRecommendationFeedback,
} from "../../services/recommendations.js";
import {
  getRecommendationFeedback,
  type FeedbackAction,
} from "../../services/recommendationFeedback.js";
import { getRecommendationSettings } from "../../services/settings.js";

import { connectedClient, errMsg } from "./helpers.js";
export const api = new Hono();
api.get("/recommendations", async (c) => {
  try {
    const set = await getRecommendations();
    // Hitomi covers need the /media proxy (their CDN requires a Referer the browser can't send).

    return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Re-roll today's picks with a fresh seed (manual refresh from the UI). */
api.post("/recommendations/refresh", async (c) => {
  try {
    const set = await refreshRecommendations();
    return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Permanently dismiss a gallery and promote a cached replacement. */
api.post("/recommendations/dismiss", async (c) => {
  const body = await c.req
    .json<{ source?: unknown; galleryId?: unknown }>()
    .catch(() => null);
  const source = body?.source;
  const galleryId =
    typeof body?.galleryId === "string" ? body.galleryId.trim() : "";
  if ((source !== "hitomi" && source !== "nhentai") || !galleryId) {
    return c.json(
      { error: "source (hitomi|nhentai) and galleryId are required" },
      400
    );
  }
  const set = await dismissAndReplace(source, galleryId);
  return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
});

api.post("/recommendations/undo-dismiss", async (c) => {
  const body = await c.req
    .json<{ source?: unknown; galleryId?: unknown }>()
    .catch(() => null);
  const source = body?.source;
  const galleryId =
    typeof body?.galleryId === "string" ? body.galleryId.trim() : "";
  if ((source !== "hitomi" && source !== "nhentai") || !galleryId)
    return c.json(
      { error: "source (hitomi|nhentai) and galleryId are required" },
      400
    );
  const set = await undoDismiss(source, galleryId);
  return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
});

/** Which Kavita libraries feed the recommendation profile. */
api.get("/recommendations/settings", (c) =>
  c.json(getRecommendationSettings())
);

api.get("/recommendations/feedback", (c) =>
  c.json(getRecommendationFeedback())
);
api.post("/recommendations/feedback", async (c) => {
  const raw = await c.req.json<unknown>().catch(() => null);
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const actions: FeedbackAction[] = [
    "like",
    "unlike",
    "mute-artist",
    "unmute-artist",
    "mute-tag",
    "unmute-tag",
  ];
  const action =
    typeof body?.action === "string" &&
    (actions as readonly string[]).includes(body.action)
      ? (body.action as FeedbackAction)
      : null;
  const artist = typeof body?.artist === "string" ? body.artist : undefined;
  const tag = typeof body?.tag === "string" ? body.tag : undefined;
  if (
    !body ||
    !action ||
    body.source !== "hitomi" ||
    typeof body.galleryId !== "string" ||
    !body.galleryId.trim() ||
    body.galleryId.length > 200 ||
    (action.includes("artist") &&
      (!artist || !artist.trim() || artist.length > 200)) ||
    (action.includes("tag") && (!tag || !tag.trim() || tag.length > 200))
  ) {
    return c.json({ error: "Invalid recommendation feedback" }, 400);
  }
  try {
    const result = await applyRecommendationFeedback(action, {
      source: "hitomi",
      galleryId: body.galleryId.trim(),
      artist,
      tag,
    });
    return c.json({
      ...result,
      recommendations: {
        ...result.recommendations,
        items: result.recommendations.items.map(rewriteDoujinCover),
      },
    });
  } catch (error) {
    return c.json({ error: errMsg(error) }, 400);
  }
});

/** Replace the excluded-library list — today's cached set is re-generated. */
api.post("/recommendations/settings", async (c) => {
  const body = await c.req
    .json<{ excludedLibraryIds?: unknown }>()
    .catch(() => null);
  if (
    !body ||
    !Array.isArray(body.excludedLibraryIds) ||
    body.excludedLibraryIds.some((x) => typeof x !== "number")
  ) {
    return c.json(
      { error: "excludedLibraryIds must be an array of numbers" },
      400
    );
  }
  setExcludedLibraries(body.excludedLibraryIds as number[]);
  return c.json(getRecommendationSettings());
});

/** Light Kavita library list (id + name) for the recommendation settings row. */
api.get("/recommendations/libraries", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  try {
    const libs = await client.getLibraries();
    rememberDuplicateLibraryRoots(libs);
    return c.json(libs.map((l) => ({ id: l.id, name: l.name })));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// ---------------- ComicInfo editor ----------------

/** Browse roots for the file picker: the configured download directory plus Kavita library paths. */
