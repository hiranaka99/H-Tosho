import {
  removeSeriesMatch,
  parseHistoryDetails,
} from "../../services/unmatch.js";
import {
  getFieldPolicy,
  saveFieldPolicy,
  FieldPolicyConflict,
} from "../../services/fieldPolicies.js";
import {
  listMetadataHistory,
  metadataHistoryDetail,
} from "../../services/metadataHistory.js";
import {
  createMetadataRestorePreview,
  enqueueMetadataRestore,
  MetadataRestoreError,
} from "../../services/metadataRestore.js";
import type { RestorePreviewRequest } from "../../contracts/metadataRestore.js";
import { retainedCoverAsset } from "../../services/metadataCovers.js";
import { retainedPreviewCoverAsset } from "../../services/metadataCoverRestore.js";
import { protectedMerge } from "../../merge/index.js";
import { parseJobCommand, type JobPayloads } from "../../contracts/jobs.js";
import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "../../db/index.js";
import { getProvider } from "../../providers/registry.js";
import { mangaDexProvider } from "../../providers/mangadex.js";
import type { CandidateMatch } from "../../match/autoMatcher.js";
import { titleScore } from "../../match/normalize.js";
import { parseManualProviderUrl } from "../../match/manualMatch.js";
import { getCredentialMap, providerOrderFor } from "../../services/settings.js";
import { jobQueue, type JobPayload } from "../../jobs/queue.js";
import { autoMatch, fetchProviderMetadata } from "../../match/autoMatcher.js";
import { rewriteMangaDexCoverUrl } from "../media.js";
import { appliedSeriesCovers } from "../../services/appliedCover.js";
import { mapLimit } from "../../lib/http.js";

import {
  connectedClient,
  resolveJobContext,
  errMsg,
  intParam,
  kavitaCoverUrl,
} from "./helpers.js";
export const api = new Hono();
api.get("/series/:id/metadata-history/:operationId/assets/:assetId", (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null || id <= 0)
    return c.json({ error: "Invalid series id" }, 400);
  const asset = retainedCoverAsset(
    id,
    c.req.param("operationId"),
    c.req.param("assetId")
  );
  if (!asset)
    return c.json(
      { error: "Retained cover image not found for this operation" },
      404
    );
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  c.header("Content-Type", asset.mediaType);
  const buffer = asset.data.buffer;
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, asset.data.byteOffset, asset.data.byteLength)
      : Uint8Array.from(asset.data);
  return c.body(bytes);
});
api.get(
  "/series/:id/metadata-restore-previews/:previewId/assets/:assetId",
  (c) => {
    const id = intParam(c.req.param("id"));
    if (id === null || id <= 0)
      return c.json({ error: "Invalid series id" }, 400);
    const asset = retainedPreviewCoverAsset(
      id,
      c.req.param("previewId"),
      c.req.param("assetId")
    );
    if (!asset)
      return c.json(
        { error: "Current preview image not found for this series" },
        404
      );
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Content-Type", asset.mediaType);
    const buffer = asset.data.buffer;
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, asset.data.byteOffset, asset.data.byteLength)
        : Uint8Array.from(asset.data);
    return c.body(bytes);
  }
);
api.get("/series/:id/metadata-history", (c) => {
  const id = intParam(c.req.param("id")),
    raw = c.req.query("cursor");
  const cursor = raw === undefined ? undefined : intParam(raw);
  if (
    id === null ||
    id <= 0 ||
    cursor === null ||
    (cursor !== undefined && cursor <= 0)
  )
    return c.json({ error: "Invalid history cursor or series id" }, 400);
  return c.json(listMetadataHistory(id, cursor));
});
api.get("/series/:id/metadata-history/:operationId", (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null || id <= 0)
    return c.json({ error: "Invalid series id" }, 400);
  const result = metadataHistoryDetail(id, c.req.param("operationId"));
  return result
    ? c.json(result)
    : c.json({ error: "Metadata operation not found" }, 404);
});
api.post(
  "/series/:id/metadata-history/:operationId/restore-preview",
  async (c) => {
    const id = intParam(c.req.param("id"));
    if (id === null || id <= 0)
      return c.json({ error: "Invalid series id" }, 400);
    const client = connectedClient();
    if (!client) return c.json({ error: "Kavita not configured" }, 503);
    const body: unknown = await c.req.json().catch(() => null);
    try {
      return c.json(
        await createMetadataRestorePreview(
          client,
          id,
          c.req.param("operationId"),
          body as RestorePreviewRequest
        )
      );
    } catch (error) {
      return c.json(
        { error: errMsg(error) },
        error instanceof MetadataRestoreError ? error.status : 502
      );
    }
  }
);
api.post("/series/:id/metadata-restore", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null || id <= 0)
    return c.json({ error: "Invalid series id" }, 400);
  if (!connectedClient())
    return c.json({ error: "Kavita not configured" }, 503);
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) =>
        !["previewId", "idempotencyKey", "acceptCoverConversion"].includes(key)
    ) ||
    !("previewId" in body) ||
    typeof body.previewId !== "string" ||
    !("idempotencyKey" in body) ||
    typeof body.idempotencyKey !== "string" ||
    ("acceptCoverConversion" in body &&
      typeof body.acceptCoverConversion !== "boolean")
  ) {
    return c.json({ error: "Invalid restore approval request" }, 400);
  }
  try {
    return c.json(
      enqueueMetadataRestore(
        id,
        body.previewId,
        body.idempotencyKey,
        (command) => jobQueue.enqueue("restore-metadata", command),
        "acceptCoverConversion" in body && body.acceptCoverConversion === true
      ),
      202
    );
  } catch (error) {
    return c.json(
      { error: errMsg(error) },
      error instanceof MetadataRestoreError ? error.status : 502
    );
  }
});
api.get("/series/:id/field-locks", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null || id <= 0)
    return c.json({ error: "Invalid series id" }, 400);
  await protectedMerge.recoverSeries(id);
  return c.json(getFieldPolicy(id));
});
api.put("/series/:id/field-locks", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null || id <= 0)
    return c.json({ error: "Invalid series id" }, 400);
  const body = await c.req
    .json<{ lockedFields?: unknown; expectedRevision?: unknown } | null>()
    .catch(() => null);
  if (!body || typeof body !== "object")
    return c.json({ error: "Invalid field policy" }, 400);
  try {
    await protectedMerge.recoverSeries(id);
    return c.json(
      await saveFieldPolicy(id, body.lockedFields, body.expectedRevision)
    );
  } catch (error) {
    return c.json(
      { error: errMsg(error) },
      error instanceof FieldPolicyConflict ? 409 : 400
    );
  }
});
const LOW_CONFIDENCE_THRESHOLD = 0.8;
api.get("/series/low-confidence", (c) => {
  // SQL count instead of loading the table and filtering in JS; a NULL score
  // fails the `<` comparison, matching the old `matchScore !== null` guard.
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.seriesMatches)
    .where(
      and(
        eq(schema.seriesMatches.status, "matched"),
        eq(schema.seriesMatches.confirmed, false),
        lt(schema.seriesMatches.matchScore, LOW_CONFIDENCE_THRESHOLD)
      )
    )
    .get();
  return c.json({
    count: Number(row?.n ?? 0),
    threshold: LOW_CONFIDENCE_THRESHOLD,
  });
});

/** Artists and tags of one match from a single metadata parse. */
function matchArtistsAndTags(metadataJson: string | null): {
  artists: string[];
  tags: string[];
} {
  if (!metadataJson) return { artists: [], tags: [] };
  let meta: unknown;
  try {
    meta = JSON.parse(metadataJson);
  } catch {
    return { artists: [], tags: [] };
  }
  // Same rules as stringsFromMatchMetadata: trimmed non-empty strings from an array.
  const read = (field: "artists" | "tags"): string[] => {
    if (!meta || typeof meta !== "object" || !(field in meta)) return [];
    const values = (meta as Record<string, unknown>)[field];
    return Array.isArray(values)
      ? values
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0
          )
          .map((value) => value.trim())
      : [];
  };
  return { artists: read("artists"), tags: read("tags") };
}

/** Review only uncertain matches, using live names and library membership. */
api.get("/series/needs-review", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  const matches = getDb()
    .select()
    .from(schema.seriesMatches)
    .where(
      and(
        eq(schema.seriesMatches.status, "matched"),
        eq(schema.seriesMatches.confirmed, false),
        lt(schema.seriesMatches.matchScore, LOW_CONFIDENCE_THRESHOLD)
      )
    )
    .all();
  if (matches.length === 0) return c.json([]);
  const byId = new Map(matches.map((match) => [match.kavitaSeriesId, match]));
  try {
    const libraries = await client.getLibraries();
    // Fetch identities only, avoiding the metadata fan-out of the library view.
    // Fail visibly if any library cannot be read rather than report a partial queue.
    const results = await Promise.all(
      libraries.map(async (library) => {
        const series = await client.getSeries(library.id);
        return series
          .filter((s) => byId.has(s.id))
          .map((s) => {
            const match = byId.get(s.id)!;
            return {
              id: s.id,
              name: s.name,
              libraryId: library.id,
              libraryName: library.name,
              bookCount: s.bookCount,
              pageCount: s.pages ?? null,
              cover: s.cover
                ? kavitaCoverUrl(s.id, s.cover, match.lastSyncedAt)
                : null,
              status: match.status,
              providerId: match.providerId,
              matchScore: match.matchScore,
              confirmed: match.confirmed,
              lastSyncedAt: match.lastSyncedAt,
              ...matchArtistsAndTags(match.metadataJson),
            };
          });
      })
    );
    return c.json(
      results
        .flat()
        .sort(
          (a, b) =>
            a.matchScore! - b.matchScore! || a.name.localeCompare(b.name)
        )
    );
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

api.get("/series/:id", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  try {
    const seriesId = intParam(c.req.param("id"));
    if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
    // Fetch live series DTO and Kavita metadata concurrently.
    const [series, kavita] = await Promise.all([
      client.getSeriesById(seriesId),
      client.getSeriesMetadata(seriesId).catch(() => null),
    ]);
    const row = getDb()
      .select()
      .from(schema.seriesMatches)
      .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
      .get();
    let metadata: unknown = null;
    if (row?.metadataJson) {
      try {
        metadata = JSON.parse(row.metadataJson) as unknown;
      } catch {
        metadata = null;
      }
    }
    return c.json({ series, match: row ?? null, metadata, kavita });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** The provider cover H-Tosho last applied, in the same form the identify dialog previews. */
api.get("/series/:id/applied-cover", (c) => {
  const seriesId = intParam(c.req.param("id"));
  if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
  const applied = appliedSeriesCovers(seriesId);
  return c.json({
    coverUrl: rewriteMangaDexCoverUrl(applied?.coverUrl) ?? null,
    volumeCoverUrls:
      applied?.volumeCoverUrls?.map(
        (url) => rewriteMangaDexCoverUrl(url) ?? url
      ) ?? null,
  });
});

api.get("/series/:id/identify", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  try {
    const seriesId = intParam(c.req.param("id"));
    if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
    const series = await client.getSeriesById(seriesId);
    const { credentials, enabledProviders } = getCredentialMap();
    const providerOrder = providerOrderFor(series.libraryId, enabledProviders);
    const outcome = await autoMatch(series, {
      providerOrder,
      credentials,
      enabledProviders,
      searchAll: true,
    });
    // Refresh stored confidence when the current match surfaces in this search.
    const existingMatch = getDb()
      .select({
        providerId: schema.seriesMatches.providerId,
        providerSeriesId: schema.seriesMatches.providerSeriesId,
        matchScore: schema.seriesMatches.matchScore,
      })
      .from(schema.seriesMatches)
      .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
      .get();
    if (existingMatch) {
      const current = outcome.candidates.find(
        (cand) =>
          cand.providerId === existingMatch.providerId &&
          cand.providerSeriesId === existingMatch.providerSeriesId
      );
      if (current && current.score !== existingMatch.matchScore) {
        getDb()
          .update(schema.seriesMatches)
          .set({ matchScore: current.score })
          .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
          .run();
      }
    }
    // MangaDex search thumbnails resolve the main cover_art, but Apply & Sync
    // pushes the Volume 1 cover when one exists — swap the thumbnail so the
    // dialog previews exactly what will land in Kavita.
    await mapLimit(
      outcome.candidates.filter((cand) => cand.providerId === "mangadex"),
      4,
      async (cand) => {
        const preferred = await mangaDexProvider.preferredSeriesCoverUrl(
          cand.providerSeriesId
        );
        if (preferred) cand.coverUrl = preferred;
      }
    );
    // MangaDex's cover CDN serves a placeholder card to third-party browser
    // Referers (anything but mangadex.org / "localhost"), so route candidate
    // covers through the same-origin media proxy.
    return c.json({
      ...outcome,
      candidates: outcome.candidates.map((cand) => ({
        ...cand,
        coverUrl: rewriteMangaDexCoverUrl(cand.coverUrl),
      })),
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

api.post("/series/:id/manual-match", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as {
    url?: unknown;
  } | null;
  if (typeof body?.url !== "string")
    return c.json({ error: "url is required" }, 400);
  const ref = parseManualProviderUrl(body.url);
  if (!ref)
    return c.json(
      { error: "Enter a MangaDex, MyAnimeList, or AniList series URL" },
      400
    );

  try {
    const seriesId = intParam(c.req.param("id"));
    if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
    const { credentials } = getCredentialMap();
    const [series, meta] = await Promise.all([
      client.getSeriesById(seriesId),
      fetchProviderMetadata(ref.providerId, ref.providerSeriesId, credentials),
    ]);
    const candidate: CandidateMatch = {
      providerId: ref.providerId,
      providerSeriesId: ref.providerSeriesId,
      title: meta.title,
      type: ref.type,
      year: meta.year,
      coverUrl: rewriteMangaDexCoverUrl(meta.coverUrl),
      summary: meta.summary,
      score: titleScore(series.name, meta.title),
    };
    return c.json(candidate);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/**
 * Queue a user-selected candidate for push to Kavita ("Apply & Sync"). The
 * push includes the ComicInfo.Series rename flow, which waits for Kavita's
 * scan — potentially minutes — so it runs as a background job: holding this
 * request open that long is what intermediate gateways were timing out with
 * HTTP 504. Progress shows in the sidebar; results land in the Jobs page.
 */
api.post("/series/:id/apply", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  const raw = await c.req.json<unknown>();
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (!body || !body.providerId || !body.providerSeriesId)
    return c.json({ error: "providerId and providerSeriesId required" }, 400);
  const seriesId = intParam(c.req.param("id"));
  if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
  let commandPayload: JobPayloads["apply-series"];
  try {
    const command = parseJobCommand("apply-series", { ...body, seriesId });
    if (command.type !== "apply-series")
      return c.json({ error: "Invalid apply command" }, 400);
    commandPayload = command.payload;
  } catch (error) {
    return c.json({ error: errMsg(error) }, 400);
  }
  const targetPayload: JobPayload = { seriesId };
  const context = await resolveJobContext(targetPayload, client);
  const id = jobQueue.enqueue("apply-series", {
    seriesId,
    context,
    contextPendingSeriesIds: targetPayload.contextPendingSeriesIds,
    providerId: commandPayload.providerId,
    providerSeriesId: commandPayload.providerSeriesId,
    selectedTitle: commandPayload.selectedTitle,
    excludedFields: commandPayload.excludedFields,
    cover: commandPayload.cover,
    score: commandPayload.score,
  });
  return c.json({ id });
});

/** Remove the local match and metadata/cover that its latest successful sync applied. */
api.delete("/series/:id/match", async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: "Kavita not configured" }, 503);
  try {
    const seriesId = intParam(c.req.param("id"));
    if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
    const result = await removeSeriesMatch(client, seriesId);
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Recent sync/match history for one series (newest first, capped at 100). */
api.get("/series/:id/history", (c) => {
  const seriesId = intParam(c.req.param("id"));
  if (seriesId === null) return c.json({ error: "Invalid series id" }, 400);
  const rows = getDb()
    .select()
    .from(schema.syncHistory)
    .where(eq(schema.syncHistory.kavitaSeriesId, seriesId))
    .orderBy(desc(schema.syncHistory.id))
    .limit(100)
    .all();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      details: parseHistoryDetails(r.detailsJson),
      createdAt: r.createdAt,
    }))
  );
});

/**
 * Fetch full metadata for a specific provider series — the same path Apply &
 * Sync uses, so the identify dialog can preview exactly what would be pushed
 * to Kavita.
 */
api.get("/providers/:id/series/:seriesId", async (c) => {
  const provider = getProvider(c.req.param("id"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  try {
    const { credentials } = getCredentialMap();
    const meta = await fetchProviderMetadata(
      provider.id,
      c.req.param("seriesId"),
      credentials
    );
    return c.json({
      ...meta,
      coverUrl: rewriteMangaDexCoverUrl(meta.coverUrl),
      volumeCovers: meta.volumeCovers?.map((v) => ({
        ...v,
        url: rewriteMangaDexCoverUrl(v.url) ?? v.url,
      })),
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

// ---------------- Providers & settings ----------------
