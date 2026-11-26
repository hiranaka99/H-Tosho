import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getKavitaConnection } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';

const APPLY_ORIGINS = new Set(['provider-apply', 'automatic-sync']);
const APPLY_ACTIONS = new Set(['matched', 'updated', 'failed']);

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export interface AppliedCovers {
  /** Provider URL of the series cover H-Tosho pushed. */
  coverUrl: string;
  /** Provider volume-cover URLs offered with that push; null when unknown. */
  volumeCoverUrls: string[] | null;
}

const urls = (value: unknown): string[] | null => Array.isArray(value) ? value.filter((url): url is string => typeof url === 'string' && !!url) : null;

/**
 * The provider covers H-Tosho last pushed to this series in Kavita, or null
 * when that is unknown or another operation has replaced the cover since. The
 * identify dialog uses it to avoid proposing the same cover again.
 */
export function appliedSeriesCovers(seriesId: number): AppliedCovers | null {
  const db = getDb();
  const match = db.select({ metadataJson: schema.seriesMatches.metadataJson }).from(schema.seriesMatches)
    .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
  if (!match) return null;

  // Restores, unmatches and merges write covers too. Only a provider apply as
  // the newest acknowledged series-cover write means the provider cover is current.
  const ops = schema.metadataOperations, covers = schema.metadataSeriesCovers;
  const lastWrite = db.select({ origin: ops.origin }).from(covers)
    .innerJoin(ops, eq(ops.id, covers.operationId))
    .where(and(eq(ops.seriesId, seriesId), eq(ops.connectionKey, kavitaConnectionKey(getKavitaConnection().baseUrl)), eq(covers.writeAcknowledged, true)))
    .orderBy(desc(ops.sequence)).limit(1).get();
  if (lastWrite && !APPLY_ORIGINS.has(lastWrite.origin)) return null;

  const history = db.select({ action: schema.syncHistory.action, detailsJson: schema.syncHistory.detailsJson }).from(schema.syncHistory)
    .where(eq(schema.syncHistory.kavitaSeriesId, seriesId)).orderBy(desc(schema.syncHistory.id)).all();
  let newestApply = true;
  for (const entry of history) {
    if (entry.action === 'unmatched') return null;
    if (!APPLY_ACTIONS.has(entry.action)) continue;
    const details = parseObject(entry.detailsJson);
    if (details?.coverUpdated === true) {
      if (typeof details.coverUrl === 'string' && details.coverUrl) return { coverUrl: details.coverUrl, volumeCoverUrls: urls(details.volumeCoverUrls) };
      // Older history did not record the URL. The match row is written in the
      // same transaction as the newest apply entry, so its cover is the one pushed.
      if (!newestApply) return null;
      const metadata = parseObject(match.metadataJson);
      const coverUrl = metadata?.coverUrl;
      const volumeCovers = Array.isArray(metadata?.volumeCovers) ? metadata.volumeCovers.map((cover: unknown) => (cover as { url?: unknown } | null)?.url) : null;
      return typeof coverUrl === 'string' && coverUrl ? { coverUrl, volumeCoverUrls: urls(volumeCovers) } : null;
    }
    newestApply = false;
  }
  return null;
}
