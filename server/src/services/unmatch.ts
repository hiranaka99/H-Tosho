import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { KavitaClient } from '../kavita/client.js';
import type { SeriesMetadata } from '../providers/types.js';
import { buildSeriesPayload } from './sync.js';
import { invalidateSeriesArtists } from './seriesArtists.js';
import { libraryMutations } from '../lib/mutations.js';
export function removeSeriesMatch(client: KavitaClient, seriesId: number): Promise<{ removed: boolean }> {
  return libraryMutations.run([`series:${seriesId}`], async () => {
    const series = await client.getSeriesById(seriesId);
    const db = getDb();
    const row = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
    if (row) {
      const history = db
        .select()
        .from(schema.syncHistory)
        .where(eq(schema.syncHistory.kavitaSeriesId, seriesId))
        .orderBy(desc(schema.syncHistory.id))
        .all();
      const boundary = history.findIndex(entry => entry.action === 'unmatched');
      const details = (boundary < 0 ? history : history.slice(0, boundary)).map((entry) => parseHistoryDetails(entry.detailsJson));
      const pushed = [...new Set(details.flatMap((entry) =>
        Array.isArray(entry?.pushed) ? entry.pushed.filter((field): field is string => typeof field === 'string') : [],
      ))];
      const metadata = row.metadataJson ? JSON.parse(row.metadataJson) as SeriesMetadata : null;
      if (metadata && pushed.length > 0) await client.removeSeriesMetadata(seriesId, buildSeriesPayload(metadata), pushed);
      const coverUpdated = details.some((entry) => entry?.coverUpdated === true);
      if (coverUpdated) await client.resetSeriesCover(seriesId);
      const volumeCoversUpdated = details.some((entry) => typeof entry?.volumeCoversUpdated === 'number' && entry.volumeCoversUpdated > 0);
      if (volumeCoversUpdated) {
        const volumes = await client.getVolumes(seriesId);
        const ids = new Set(details.flatMap(entry => Array.isArray(entry?.volumeCoverIds)
          ? entry.volumeCoverIds.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id)) : []));
        // Older history stored only a count. Limit its fallback to volumes
        // present in the saved provider metadata, never every Kavita volume.
        const legacy = details.some(entry => Number(entry?.volumeCoversUpdated) > 0 && !Array.isArray(entry?.volumeCoverIds));
        for (const volume of volumes) if (ids.has(volume.id) || (legacy && metadata?.volumeCovers?.some(cover => cover.number === volume.number))) {
          await client.resetVolumeCover(volume.id);
        }
      }
      await client.scanSeries(series.libraryId, seriesId);

      db.transaction(() => {
        db.delete(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).run();
        db.insert(schema.syncHistory)
          .values({
            kavitaSeriesId: seriesId,
            seriesTitle: series.name,
            action: 'unmatched',
            detailsJson: JSON.stringify({ providerId: row.providerId, matchScore: row.matchScore, removedFields: pushed, coverReset: coverUpdated, volumeCoversReset: volumeCoversUpdated }),
          })
          .run();
      });
      invalidateSeriesArtists(seriesId);
    }
    return { removed: !!row };
  });
}

export function parseHistoryDetails(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* corrupt details — surface the action only */
  }
  return null;
}
