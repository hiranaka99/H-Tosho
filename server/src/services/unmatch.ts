import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import type { KavitaClient } from "../kavita/client.js";
import type { SeriesMetadata } from "../providers/types.js";
import { buildSeriesPayload } from "./sync.js";
import { invalidateSeriesArtists } from "./seriesArtists.js";
import { libraryMutations } from "../lib/mutations.js";
import { getFieldPolicy } from "./fieldPolicies.js";
import { EXCLUDABLE_FIELDS } from "../contracts/metadata.js";
import { withMetadataHistory } from "./metadataHistory.js";
import { recoverMergeProtectionForSeriesOwned } from "./mergeProtection.js";
import { mapLimit } from "../lib/http.js";
export function removeSeriesMatch(
  client: KavitaClient,
  seriesId: number
): Promise<{ removed: boolean }> {
  return libraryMutations.run([`series:${seriesId}`], async () => {
    await recoverMergeProtectionForSeriesOwned(client, seriesId);
    if (
      !getDb()
        .select({ id: schema.seriesMatches.id })
        .from(schema.seriesMatches)
        .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
        .get()
    )
      return { removed: false };
    return withMetadataHistory(
      client,
      seriesId,
      "unmatch",
      {},
      async (journal) => {
        const series = await client.getSeriesById(seriesId);
        const db = getDb();
        const row = db
          .select()
          .from(schema.seriesMatches)
          .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
          .get();
        if (row) {
          const history = db
            .select()
            .from(schema.syncHistory)
            .where(eq(schema.syncHistory.kavitaSeriesId, seriesId))
            .orderBy(desc(schema.syncHistory.id))
            .all();
          const boundary = history.findIndex(
            (entry) => entry.action === "unmatched"
          );
          const details = (
            boundary < 0 ? history : history.slice(0, boundary)
          ).map((entry) => parseHistoryDetails(entry.detailsJson));
          const protectedFields = getFieldPolicy(seriesId).lockedFields;
          const protectedPayloadKeys = new Set<string>(
            protectedFields.map((field) =>
              field === "cover" ? "cover" : EXCLUDABLE_FIELDS[field]
            )
          );
          const pushed = [
            ...new Set(
              details.flatMap((entry) =>
                Array.isArray(entry?.pushed)
                  ? entry.pushed.filter(
                      (field): field is string => typeof field === "string"
                    )
                  : []
              )
            ),
          ].filter((field) => !protectedPayloadKeys.has(field));
          const metadata = row.metadataJson
            ? (JSON.parse(row.metadataJson) as SeriesMetadata)
            : null;
          const coverUpdated =
            !protectedFields.includes("cover") &&
            details.some((entry) => entry?.coverUpdated === true);
          const volumeCoversUpdated =
            !protectedFields.includes("cover") &&
            details.some(
              (entry) =>
                typeof entry?.volumeCoversUpdated === "number" &&
                entry.volumeCoversUpdated > 0
            );
          const volumeCoverIds: number[] = [];
          if (volumeCoversUpdated) {
            const volumes = await client.getVolumes(seriesId);
            const ids = new Set(
              details.flatMap((entry) =>
                Array.isArray(entry?.volumeCoverIds)
                  ? entry.volumeCoverIds.filter(
                      (id): id is number =>
                        typeof id === "number" && Number.isSafeInteger(id)
                    )
                  : []
              )
            );
            // Legacy count-only history limits resets to saved provider volume numbers.
            const legacy = details.some(
              (entry) =>
                Number(entry?.volumeCoversUpdated) > 0 &&
                !Array.isArray(entry?.volumeCoverIds)
            );
            for (const volume of volumes)
              if (
                ids.has(volume.id) ||
                (legacy &&
                  metadata?.volumeCovers?.some(
                    (cover) => cover.number === volume.number
                  ))
              )
                volumeCoverIds.push(volume.id);
          }
          // Every original cover must be durable before any metadata or cover cleanup.
          if (coverUpdated) await journal.captureSeriesCover();
          await mapLimit(volumeCoverIds, 4, (volumeId) =>
            journal.captureVolumeCover(volumeId)
          );
          if (metadata && pushed.length > 0)
            await client.removeSeriesMetadata(
              seriesId,
              buildSeriesPayload(metadata),
              pushed
            );
          if (coverUpdated) {
            await journal.captureSeriesCover();
            journal.beginCoverWrite({ kind: "series" }, false);
            await client.resetSeriesCover(seriesId);
            journal.acknowledgeCoverWrite({ kind: "series" });
          }
          for (const volumeId of volumeCoverIds) {
            await journal.captureVolumeCover(volumeId);
            journal.beginCoverWrite({ kind: "volume", volumeId }, false);
            await client.resetVolumeCover(volumeId);
            journal.acknowledgeCoverWrite({ kind: "volume", volumeId });
          }
          await client.scanSeries(series.libraryId, seriesId);

          db.transaction(() => {
            db.delete(schema.seriesMatches)
              .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
              .run();
            db.insert(schema.syncHistory)
              .values({
                kavitaSeriesId: seriesId,
                seriesTitle: series.name,
                action: "unmatched",
                detailsJson: JSON.stringify({
                  providerId: row.providerId,
                  matchScore: row.matchScore,
                  removedFields: pushed,
                  preservedFields: protectedFields,
                  coverReset: coverUpdated,
                  volumeCoversReset: volumeCoversUpdated,
                }),
              })
              .run();
          });
          invalidateSeriesArtists(seriesId);
        }
        return { removed: !!row };
      }
    );
  });
}

export function parseHistoryDetails(
  json: string | null
): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* corrupt details — surface the action only */
  }
  return null;
}
