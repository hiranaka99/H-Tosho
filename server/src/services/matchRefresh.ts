import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { KavitaClient } from "../kavita/client.js";
import { mapLimit } from "../lib/http.js";
import {
  fetchProviderMetadata,
  fetchProviderMetadataBatch,
} from "../match/autoMatcher.js";
import { notify, providerName } from "../notify/dispatcher.js";
import type { SeriesMetadata } from "../providers/types.js";
import {
  diffMatchedMetadata,
  matchedMetadataProjection,
  type MatchUpdate,
  type MatchUpdateChange,
} from "../contracts/matchUpdates.js";
import type { FieldPolicy } from "../contracts/metadata.js";
import { getFieldPolicies } from "./fieldPolicies.js";
import { currentMatchConnection } from "./matchSuggestions.js";
import { getCredentialMap, getKavitaConnection } from "./settings.js";

/**
 * Scheduled refresh of matched series. Each series is re-read from exactly the
 * provider candidate it is matched to and compared with the metadata applied
 * last. Searching never happens here, so a new or better candidate is never an
 * alert. Results are review prompts only: nothing is written to Kavita.
 */

type MatchRow = typeof schema.matchUpdates.$inferSelect;
const fingerprint = (meta: SeriesMetadata) =>
  createHash("sha256").update(matchedMetadataProjection(meta)).digest("hex");

function parseMetadata(json: string | null | undefined): SeriesMetadata | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as SeriesMetadata;
    return value &&
      typeof value === "object" &&
      typeof value.providerId === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

interface MatchedRow {
  seriesId: number;
  providerId: string;
  providerSeriesId: string;
  score: number | null;
  applied: SeriesMetadata;
}
/** Current exact matches, with the provider metadata last applied to each. */
function matchedSeries(ids?: number[]): Map<number, MatchedRow> {
  const table = schema.seriesMatches;
  const out = new Map<number, MatchedRow>();
  const ingest = (
    rows: {
      seriesId: number;
      status: string;
      providerId: string | null;
      providerSeriesId: string | null;
      matchScore: number | null;
      metadataJson: string | null;
    }[]
  ) => {
    for (const row of rows) {
      const applied = parseMetadata(row.metadataJson);
      if (
        row.status !== "matched" ||
        !row.providerId ||
        !row.providerSeriesId ||
        !applied
      )
        continue;
      // The stored metadata must describe this very candidate.
      if (
        applied.providerId !== row.providerId ||
        String(applied.providerSeriesId) !== row.providerSeriesId
      )
        continue;
      out.set(row.seriesId, {
        seriesId: row.seriesId,
        providerId: row.providerId,
        providerSeriesId: row.providerSeriesId,
        score: row.matchScore,
        applied,
      });
    }
  };
  if (ids) {
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 500) {
      ingest(
        getDb()
          .select({
            seriesId: table.kavitaSeriesId,
            status: table.status,
            providerId: table.providerId,
            providerSeriesId: table.providerSeriesId,
            matchScore: table.matchScore,
            metadataJson: table.metadataJson,
          })
          .from(table)
          .where(inArray(table.kavitaSeriesId, unique.slice(i, i + 500)))
          .all()
      );
    }
    return out;
  }
  ingest(
    getDb()
      .select({
        seriesId: table.kavitaSeriesId,
        status: table.status,
        providerId: table.providerId,
        providerSeriesId: table.providerSeriesId,
        matchScore: table.matchScore,
        metadataJson: table.metadataJson,
      })
      .from(table)
      .where(eq(table.status, "matched"))
      .all()
  );
  return out;
}

/** Pending changes for one stored refresh row, or none once the match moved on. */
function pendingChanges(
  row: MatchRow,
  match: MatchedRow | undefined,
  latest: SeriesMetadata | null,
  lockedFields: FieldPolicy["lockedFields"]
): MatchUpdateChange[] {
  if (
    !match ||
    match.providerId !== row.providerId ||
    match.providerSeriesId !== row.providerSeriesId
  )
    return [];
  return latest ? diffMatchedMetadata(match.applied, latest, lockedFields) : [];
}

function toUpdate(
  row: MatchRow,
  latest: SeriesMetadata | null,
  changes: MatchUpdateChange[],
  score: number | null
): MatchUpdate {
  return {
    seriesId: row.seriesId,
    name: row.name,
    libraryId: row.libraryId,
    libraryName: row.libraryName,
    cover: row.cover,
    providerId: row.providerId,
    providerSeriesId: row.providerSeriesId,
    candidateTitle: latest?.title ?? row.name,
    candidateCoverUrl: latest?.coverUrl ?? null,
    score,
    changes,
    detectedAt: row.detectedAt,
    checkedAt: row.checkedAt,
  };
}

interface CollectedMatchUpdate {
  item: MatchUpdate;
  latestHash: string;
  notifiedHash: string | null;
}

function collectMatchUpdates(
  connectionKey = currentMatchConnection()
): CollectedMatchUpdate[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.matchUpdates)
    .where(eq(schema.matchUpdates.connectionKey, connectionKey))
    .all();
  if (!rows.length) return [];
  const seriesIds = rows.map((row) => row.seriesId);
  const matches = matchedSeries(seriesIds);
  const policies = getFieldPolicies(seriesIds);
  const resolved: number[] = [];
  const collected: CollectedMatchUpdate[] = [];
  for (const row of rows) {
    const match = matches.get(row.seriesId);
    const latest = parseMetadata(row.latestJson);
    const lockedFields = policies.get(row.seriesId)?.lockedFields ?? [];
    const changes = pendingChanges(row, match, latest, lockedFields);
    if (!changes.length) {
      resolved.push(row.seriesId);
      continue;
    }
    if (row.dismissedHash === row.latestHash) continue;
    collected.push({
      item: toUpdate(row, latest, changes, match?.score ?? null),
      latestHash: row.latestHash,
      notifiedHash: row.notifiedHash,
    });
  }
  if (resolved.length) {
    for (let i = 0; i < resolved.length; i += 500) {
      db.delete(schema.matchUpdates)
        .where(
          and(
            eq(schema.matchUpdates.connectionKey, connectionKey),
            inArray(schema.matchUpdates.seriesId, resolved.slice(i, i + 500))
          )
        )
        .run();
    }
  }
  return collected.sort(
    (a, b) =>
      b.item.detectedAt.localeCompare(a.item.detectedAt) ||
      a.item.name.localeCompare(b.item.name)
  );
}

/** Updates waiting for review. Applying, unmatching, rematching or protecting fields resolves them immediately. */
export function listMatchUpdates(): MatchUpdate[] {
  return collectMatchUpdates().map((entry) => entry.item);
}

/** Hide this provider state; a later provider change surfaces again. */
export function dismissMatchUpdate(
  seriesId: number,
  dismissed: boolean
): boolean {
  const table = schema.matchUpdates,
    where = and(
      eq(table.connectionKey, currentMatchConnection()),
      eq(table.seriesId, seriesId)
    );
  const row = getDb()
    .select({ latestHash: table.latestHash })
    .from(table)
    .where(where)
    .get();
  if (!row) return false;
  getDb()
    .update(table)
    .set({ dismissedHash: dismissed ? row.latestHash : null })
    .where(where)
    .run();
  return true;
}

export interface MatchRefreshResult {
  [key: string]: number;
  processed: number;
  updates: number;
  unchanged: number;
  failed: number;
  skipped: number;
}

export async function refreshMatchedSeries(options: {
  checkCancelled: () => void;
  progress: (current: number, total: number) => void;
  log: (level: "info" | "warn" | "success", message: string) => void;
  signal?: AbortSignal;
}): Promise<MatchRefreshResult> {
  const connection = getKavitaConnection(),
    connectionKey = currentMatchConnection();
  if (!connection.baseUrl || !connection.apiKey)
    throw new Error("Kavita is not configured");
  const client = new KavitaClient(connection.baseUrl, connection.apiKey),
    db = getDb();
  const check = () => {
    options.checkCancelled();
    if (currentMatchConnection() !== connectionKey)
      throw new Error(
        "Kavita connection changed during refresh. Refresh again."
      );
  };
  // Live Kavita series supply names/covers and keep removed series out of Home.
  const libraries = await client.getLibraries();
  check();
  const listings = await mapLimit(libraries, 4, async (library) => {
    check();
    return client.getSeries(library.id);
  });
  check();
  const live = new Map<
    number,
    {
      name: string;
      libraryId: number;
      libraryName: string;
      cover: string | null;
    }
  >();
  for (const [index, library] of libraries.entries())
    for (const series of listings[index])
      live.set(series.id, {
        name: series.name,
        libraryId: library.id,
        libraryName: library.name,
        cover: series.cover ?? null,
      });
  const matches = [...matchedSeries().values()].filter((match) =>
    live.has(match.seriesId)
  );
  const table = schema.matchUpdates;
  const existing = new Map(
    db
      .select()
      .from(table)
      .where(eq(table.connectionKey, connectionKey))
      .all()
      .map((row) => [row.seriesId, row])
  );
  const matchIds = new Set(matches.map((match) => match.seriesId));
  const gone = [...existing.keys()].filter((id) => !matchIds.has(id));
  for (let i = 0; i < gone.length; i += 500) {
    db.delete(table)
      .where(
        and(
          eq(table.connectionKey, connectionKey),
          inArray(table.seriesId, gone.slice(i, i + 500))
        )
      )
      .run();
  }

  const REFRESH_BATCH_SIZE = 50;
  const { credentials, enabledProviders } = getCredentialMap();
  const result: MatchRefreshResult = {
    processed: 0,
    updates: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
  };
  options.progress(0, matches.length);
  const initialPolicies = getFieldPolicies(
    matches.map((match) => match.seriesId)
  );
  const byProvider = new Map<string, MatchedRow[]>();
  for (const match of matches) {
    check();
    if (!enabledProviders.includes(match.providerId)) {
      result.skipped++;
      options.progress(++result.processed, matches.length);
      continue;
    }
    let group = byProvider.get(match.providerId);
    if (!group) {
      group = [];
      byProvider.set(match.providerId, group);
    }
    group.push(match);
  }
  for (const [providerId, group] of byProvider) {
    for (let i = 0; i < group.length; i += REFRESH_BATCH_SIZE) {
      check();
      const chunk = group.slice(i, i + REFRESH_BATCH_SIZE);
      const chunkIds = chunk.map((match) => match.seriesId);
      const uniqueIds = [
        ...new Set(chunk.map((match) => match.providerSeriesId)),
      ];
      const matchesByProviderId = new Map<string, MatchedRow[]>();
      for (const match of chunk) {
        let list = matchesByProviderId.get(match.providerSeriesId);
        if (!list) {
          list = [];
          matchesByProviderId.set(match.providerSeriesId, list);
        }
        list.push(match);
      }
      const skipVolumeCovers = new Set<string>();
      for (const [providerSeriesId, items] of matchesByProviderId) {
        if (
          items.every((m) =>
            initialPolicies.get(m.seriesId)?.lockedFields.includes("cover")
          )
        ) {
          skipVolumeCovers.add(providerSeriesId);
        }
      }

      let batch: Map<string, SeriesMetadata> | null = null;
      let chunkFailed = false;
      try {
        batch = await fetchProviderMetadataBatch(
          providerId,
          uniqueIds,
          credentials,
          options.signal,
          { skipVolumeCovers }
        );
      } catch (error) {
        check();
        const msg = error instanceof Error ? error.message : String(error);
        if (chunk.length > 1 && /\b400\b/.test(msg)) {
          batch = null;
        } else {
          chunkFailed = true;
          for (const match of chunk) {
            const series = live.get(match.seriesId)!;
            result.failed++;
            options.log(
              "warn",
              `${series.name}: could not read ${providerName(match.providerId)} entry ${match.providerSeriesId}: ${msg}`
            );
            options.progress(++result.processed, matches.length);
          }
        }
      }
      if (chunkFailed) continue;

      const latestBySeriesId = new Map<number, SeriesMetadata>();
      const failedInChunk = new Set<number>();
      const fallbackCache = new Map<string, SeriesMetadata | Error>();
      for (const match of chunk) {
        check();
        const series = live.get(match.seriesId)!;
        const batchHit = batch?.get(match.providerSeriesId);
        if (batchHit) {
          latestBySeriesId.set(match.seriesId, batchHit);
          continue;
        }
        const cachedFallback = fallbackCache.get(match.providerSeriesId);
        if (cachedFallback instanceof Error) {
          failedInChunk.add(match.seriesId);
          result.failed++;
          options.log(
            "warn",
            `${series.name}: could not read ${providerName(match.providerId)} entry ${match.providerSeriesId}: ${cachedFallback.message}`
          );
          continue;
        }
        if (cachedFallback) {
          latestBySeriesId.set(match.seriesId, cachedFallback);
          continue;
        }
        try {
          const fetched = await fetchProviderMetadata(
            match.providerId,
            match.providerSeriesId,
            credentials,
            options.signal
          );
          fallbackCache.set(match.providerSeriesId, fetched);
          latestBySeriesId.set(match.seriesId, fetched);
        } catch (error) {
          check();
          const err = error instanceof Error ? error : new Error(String(error));
          fallbackCache.set(match.providerSeriesId, err);
          failedInChunk.add(match.seriesId);
          result.failed++;
          options.log(
            "warn",
            `${series.name}: could not read ${providerName(match.providerId)} entry ${match.providerSeriesId}: ${err.message}`
          );
        }
        check();
      }

      // Re-read the chunk's matches and policies once before committing diffs.
      const currentMatches = matchedSeries(chunkIds);
      const currentPolicies = getFieldPolicies(chunkIds);
      const pendingLogs: string[] = [];
      db.transaction((tx) => {
        for (const match of chunk) {
          if (failedInChunk.has(match.seriesId)) continue;
          const latest = latestBySeriesId.get(match.seriesId);
          if (!latest) continue;
          const series = live.get(match.seriesId)!;
          const where = and(
            eq(table.connectionKey, connectionKey),
            eq(table.seriesId, match.seriesId)
          );
          const current = currentMatches.get(match.seriesId);
          const lockedFields =
            currentPolicies.get(match.seriesId)?.lockedFields ?? [];
          const changes =
            current &&
            current.providerId === match.providerId &&
            current.providerSeriesId === match.providerSeriesId
              ? diffMatchedMetadata(current.applied, latest, lockedFields)
              : [];
          if (!changes.length) {
            tx.delete(table).where(where).run();
            result.unchanged++;
          } else {
            const latestHash = fingerprint(latest),
              now = new Date().toISOString(),
              previous = existing.get(match.seriesId);
            const sameState =
              previous?.latestHash === latestHash &&
              previous.providerId === match.providerId &&
              previous.providerSeriesId === match.providerSeriesId;
            const value = {
              connectionKey,
              seriesId: match.seriesId,
              providerId: match.providerId,
              providerSeriesId: match.providerSeriesId,
              name: series.name,
              libraryId: series.libraryId,
              libraryName: series.libraryName,
              cover: series.cover,
              latestHash,
              latestJson: JSON.stringify(latest),
              checkedAt: now,
              detectedAt: sameState ? previous.detectedAt : now,
              dismissedHash: sameState ? previous.dismissedHash : null,
              notifiedHash: sameState ? previous.notifiedHash : null,
            };
            tx.insert(table)
              .values(value)
              .onConflictDoUpdate({
                target: [table.connectionKey, table.seriesId],
                set: value,
              })
              .run();
            result.updates++;
            pendingLogs.push(
              `${series.name}: ${changes.map((change) => change.summary).join(" · ")}`
            );
          }
        }
      });
      for (const line of pendingLogs) options.log("info", line);
      for (let k = 0; k < chunk.length; k++)
        options.progress(++result.processed, matches.length);
    }
  }
  options.log(
    result.failed ? "warn" : "success",
    `Checked ${result.processed} matched series; ${result.updates} have provider updates${result.failed ? `; ${result.failed} could not be read` : ""}${result.skipped ? `; ${result.skipped} skipped (provider disabled)` : ""}.`
  );
  if (
    matches.length > 0 &&
    result.failed === matches.length - result.skipped &&
    result.failed > 0
  )
    throw new Error(
      "Providers could not be read. Check provider settings and retry."
    );
  await notifyNewUpdates(connectionKey, options.log);
  return result;
}

/** One Discord message per refresh, only for provider states not announced before. */
async function notifyNewUpdates(
  connectionKey: string,
  log: (level: "info" | "warn" | "success", message: string) => void
): Promise<void> {
  const table = schema.matchUpdates,
    db = getDb();
  const fresh = collectMatchUpdates(connectionKey)
    .filter((entry) => entry.notifiedHash !== entry.latestHash)
    .map((entry) => entry.item);
  if (!fresh.length) return;
  const freshIds = fresh.map((item) => item.seriesId);
  const markNotified = () => {
    for (let i = 0; i < freshIds.length; i += 500) {
      db.update(table)
        .set({ notifiedHash: sql`${table.latestHash}` })
        .where(
          and(
            eq(table.connectionKey, connectionKey),
            inArray(table.seriesId, freshIds.slice(i, i + 500))
          )
        )
        .run();
    }
  };
  try {
    const outcome = await notify({
      title:
        fresh.length === 1
          ? "Provider update for a matched series"
          : `Provider updates for ${fresh.length} matched series`,
      success: true,
      description: "Review them on Home before applying anything.",
      fields: fresh.slice(0, 10).map((item) => ({
        name: item.name.slice(0, 200),
        value: item.changes.map((change) => change.summary).join("\n"),
      })),
    });
    // Disabled delivery still counts as announced: enabling Discord later never replays a backlog.
    markNotified();
    if (outcome.status === "delivered")
      log(
        "success",
        `Discord notification sent for ${fresh.length} provider update${fresh.length === 1 ? "" : "s"}`
      );
  } catch (error) {
    markNotified();
    log(
      "warn",
      `Discord notification for provider updates failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
