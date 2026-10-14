import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export function upsertMatch(r: {
  kavitaSeriesId: number;
  status: 'unmatched' | 'matched' | 'failed';
  confirmed?: boolean;
  providerId: string | null;
  providerSeriesId: string | null;
  matchScore: number | null;
  metadataJson: string | null;
  errorMessage: string | null;
}): void {
  const existing = getDb().select({
    confirmed: schema.seriesMatches.confirmed,
    providerId: schema.seriesMatches.providerId,
    providerSeriesId: schema.seriesMatches.providerSeriesId,
  }).from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, r.kavitaSeriesId)).get();
  // Re-matching may select a different candidate; an approval belongs only to
  // the exact provider identity. Re-syncing that identity preserves it.
  const confirmed = r.confirmed ?? Boolean(r.providerId && r.providerSeriesId && existing?.confirmed
    && existing.providerId === r.providerId && existing.providerSeriesId === r.providerSeriesId);
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: r.kavitaSeriesId,
      status: r.status,
      providerId: r.providerId,
      providerSeriesId: r.providerSeriesId,
      matchScore: r.matchScore,
      confirmed,
      metadataJson: r.metadataJson,
      errorMessage: r.errorMessage,
      lastSyncedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.seriesMatches.kavitaSeriesId,
      set: {
        status: r.status,
        providerId: r.providerId,
        providerSeriesId: r.providerSeriesId,
        matchScore: r.matchScore,
        confirmed,
        metadataJson: r.metadataJson,
        errorMessage: r.errorMessage,
        lastSyncedAt: new Date().toISOString(),
      },
    })
    .run();
}

export function recordHistory(seriesId: number, title: string | null, action: string, details: unknown): void {
  getDb()
    .insert(schema.syncHistory)
    .values({ kavitaSeriesId: seriesId, seriesTitle: title, action, detailsJson: JSON.stringify(details) })
    .run();
}
