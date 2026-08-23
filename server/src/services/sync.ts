import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  KavitaAgeRating,
  KavitaPublicationStatus,
  type SeriesMetadataPayload,
} from '../kavita/types.js';
import type { SeriesMetadata } from '../providers/types.js';
import type { AggregationOptions } from './settings.js';
import { getKavitaConnection, getNotificationSettings } from './settings.js';
import { notify } from '../notify/dispatcher.js';

/** Fields H-Tosho can push to a Kavita series. */
export interface ApplyResult {
  seriesId: number;
  pushed: string[];
  coverUpdated: boolean;
  locked: boolean;
  errors: string[];
}

const PUBLICATION_STATUS: Record<NonNullable<SeriesMetadata['status']>, KavitaPublicationStatus | undefined> = {
  ONGOING: KavitaPublicationStatus.Ongoing,
  HIATUS: KavitaPublicationStatus.Hiatus,
  COMPLETED: KavitaPublicationStatus.Completed,
  CANCELLED: KavitaPublicationStatus.Cancelled,
  UNKNOWN: undefined,
};

function releaseYear(meta: SeriesMetadata): number | undefined {
  if (meta.year && meta.year >= 1 && meta.year <= 9999) return meta.year;
  if (!meta.releaseDate) return undefined;
  const year = Number(meta.releaseDate.slice(0, 4));
  return year >= 1 && year <= 9999 ? year : undefined;
}

function ageRating(value: number | undefined): KavitaAgeRating | undefined {
  if (value === undefined) return undefined;
  return Object.values(KavitaAgeRating).includes(value) ? (value as KavitaAgeRating) : undefined;
}

/** Map a unified SeriesMetadata + config into a Kavita series metadata payload. */
export function buildSeriesPayload(
  meta: SeriesMetadata,
  agg: AggregationOptions,
  fieldConfig: Record<string, string | null>,
): SeriesMetadataPayload {
  const payload: SeriesMetadataPayload = {};
  const fromPrimary = (f: string) => (fieldConfig[f] ?? null) === null || fieldConfig[f] === meta.providerId;

  if (meta.title && fromPrimary('title')) payload.name = meta.title;
  if (meta.sortTitle && fromPrimary('sortTitle')) payload.sortName = meta.sortTitle;
  if (meta.summary && fromPrimary('summary')) payload.summary = meta.summary;
  const genres = agg.mergeGenres ? meta.genres : meta.genres.slice(0, 10);
  if (genres.length && fromPrimary('genres')) payload.genres = genres;
  const tags = agg.mergeTags ? meta.tags : meta.tags.slice(0, 10);
  if (tags.length && fromPrimary('tags')) payload.tags = tags;
  if (meta.writers.length && fromPrimary('writers')) payload.writers = meta.writers;
  if (meta.artists.length && fromPrimary('artists')) payload.artists = meta.artists;
  if (meta.publishers.length && fromPrimary('publishers')) payload.publishers = meta.publishers;
  if (meta.imprints.length && fromPrimary('imprints')) payload.imprints = meta.imprints;
  const mappedAgeRating = ageRating(meta.ageRating);
  if (mappedAgeRating !== undefined && fromPrimary('ageRating')) payload.ageRating = mappedAgeRating;
  if (meta.rating != null && fromPrimary('rating')) payload.rating = meta.rating;
  const year = releaseYear(meta);
  if (year !== undefined && fromPrimary('releaseDate')) payload.releaseYear = year;
  if (meta.language && fromPrimary('language')) payload.language = meta.language;
  if (meta.status && PUBLICATION_STATUS[meta.status] !== undefined && fromPrimary('status')) {
    payload.publicationStatus = PUBLICATION_STATUS[meta.status];
  }
  if (meta.url && fromPrimary('url')) payload.webLinks = meta.url;
  return payload;
}

/**
 * Apply matched metadata to a Kavita series:
 * 1. Read/merge/write identity and metadata fields
 * 2. Stage and apply cover image (if enabled + available)
 * 3. Record sync history + fire notifications
 */
export async function applyToKavita(
  client: KavitaClient,
  seriesId: number,
  meta: SeriesMetadata,
  opts: {
    agg: AggregationOptions;
    fieldConfig: Record<string, string | null>;
    cover: Buffer | null;
    title: string;
  },
): Promise<ApplyResult> {
  const errors: string[] = [];
  const pushed: string[] = [];
  let coverUpdated = false;
  let locked = false;

  const payload = buildSeriesPayload(meta, opts.agg, opts.fieldConfig);
  const fields = Object.keys(payload).filter((k) => (payload as Record<string, unknown>)[k] !== undefined);
  if (fields.length) {
    try {
      await client.updateSeriesMetadata(seriesId, payload);
      pushed.push(...fields);
    } catch (err) {
      errors.push(`metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.agg.replaceCover && opts.cover && opts.cover.length > 0) {
    try {
      await client.updateSeriesCover(seriesId, opts.cover, opts.agg.lockCovers);
      coverUpdated = true;
      locked = opts.agg.lockCovers;
      pushed.push('cover');
    } catch (err) {
      errors.push(`cover: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Persist history
  const db = getDb();
  db.insert(schema.syncHistory)
    .values({
      kavitaSeriesId: seriesId,
      seriesTitle: opts.title,
      action: errors.length ? 'failed' : 'updated',
      detailsJson: JSON.stringify({ provider: meta.providerId, pushed, coverUpdated, locked, errors }),
    })
    .run();

  // Notifications (fire-and-forget)
  const notif = getNotificationSettings();
  if (notif.discord.enabled || notif.apprise.enabled) {
    notify({
      title: errors.length ? `Sync failed: ${opts.title}` : `Updated: ${opts.title}`,
      body: `${meta.providerId} - ${pushed.join(', ') || 'no fields'}`,
      coverUrl: meta.coverUrl ?? undefined,
      success: errors.length === 0,
    }).catch(() => {});
  }

  // Update match row
  const row = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
  if (row) {
    db.update(schema.seriesMatches)
      .set({
        status: errors.length ? 'failed' : 'matched',
        lastSyncedAt: new Date().toISOString(),
        errorMessage: errors.length ? errors.join('; ') : null,
      })
      .where(eq(schema.seriesMatches.kavitaSeriesId, seriesId))
      .run();
  }

  return { seriesId, pushed, coverUpdated, locked, errors };
}

/** Download a cover from a provider URL, returning null on failure. */
export async function fetchCover(client: KavitaClient, url?: string): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const buf = await client.downloadImage(url);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export function getConnectedClient(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}