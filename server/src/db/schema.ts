import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Drizzle ORM schema for H-Tosho's local SQLite store.
 * All persistent app state: provider credentials, priorities, field-level
 * aggregation config, library overrides, match cache, jobs and sync history.
 */

export const providerCredentials = sqliteTable('provider_credentials', {
  providerId: text('provider_id').primaryKey(),
  credentialsJson: text('credentials_json').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
});

export const providerPriorities = sqliteTable('provider_priorities', {
  providerId: text('provider_id').primaryKey(),
  position: integer('position').notNull(),
});

export const libraryOverrides = sqliteTable('library_overrides', {
  libraryId: integer('library_id').primaryKey(),
  priorityJson: text('priority_json').notNull().default('[]'),
  autoMatch: integer('auto_match', { mode: 'boolean' }).notNull().default(true),
});

export const seriesMatches = sqliteTable('series_matches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kavitaSeriesId: integer('kavita_series_id').notNull().unique(),
  /** unmatched | matched | syncing | failed */
  status: text('status').notNull().default('unmatched'),
  providerId: text('provider_id'),
  providerSeriesId: text('provider_series_id'),
  matchScore: real('match_score'),
  /** All provider-managed metadata fields match Kavita's current values. */
  aligned: integer('aligned', { mode: 'boolean' }).notNull().default(false),
  /** Aggregated metadata (JSON) captured at match time */
  metadataJson: text('metadata_json'),
  errorMessage: text('error_message'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});
/**
 * Local index of MangaDex adult-rated titles (suggestive/erotica/pornographic).
 * Chapterless manga are absent from MangaDex's title search index, so mature
 * series are matched against this cached catalog instead.
 */
export const mangadexCatalog = sqliteTable('mangadex_catalog', {
  mangaId: text('manga_id').primaryKey(),
  titleEn: text('title_en'),
  originalTitle: text('original_title'),
  altTitlesJson: text('alt_titles_json').notNull().default('[]'),
  descriptionEn: text('description_en'),
  year: integer('year'),
  status: text('status'),
  contentRating: text('content_rating'),
  malId: text('mal_id'),
  alId: text('al_id'),
  muId: text('mu_id'),
  /** MangaDex updatedAt (ISO) — used for incremental refresh high-water mark. */
  mdUpdatedAt: text('md_updated_at').notNull(),
  fetchedAt: text('fetched_at').notNull(),
  /** Primary cover file name on uploads.mangadex.org (resolved lazily, cached). */
  coverFile: text('cover_file'),
});

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** sync-library | match-series | update-series */
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  /** queued | running | completed | failed */
  status: text('status').notNull().default('queued'),
  progressCurrent: integer('progress_current').notNull().default(0),
  progressTotal: integer('progress_total').notNull().default(0),
  resultJson: text('result_json'),
  errorMessage: text('error_message'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

export const jobLogs = sqliteTable('job_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const syncHistory = sqliteTable('sync_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kavitaSeriesId: integer('kavita_series_id').notNull(),
  seriesTitle: text('series_title'),
  /** matched | updated | failed | unmatched | cover | cleared */
  action: text('action').notNull(),
  detailsJson: text('details_json'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const downloadQueue = sqliteTable('download_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** hitomi | nhentai */
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  title: text('title'),
  /** queued | downloading | completed | failed | paused */
  status: text('status').notNull().default('queued'),
  progressCurrent: integer('progress_current').notNull().default(0),
  progressTotal: integer('progress_total').notNull().default(0),
  speed: real('speed'),
  currentFile: text('current_file'),
  /** Total image bytes received so far this run. */
  bytesCurrent: integer('bytes_current').notNull().default(0),
  /** Total image bytes expected for the run (0 until known). */
  bytesTotal: integer('bytes_total').notNull().default(0),
  /** cbz | folder */
  outputFormat: text('output_format').notNull().default('cbz'),
  outputPath: text('output_path'),
  errorMessage: text('error_message'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

export const keyValueStore = sqliteTable('key_value_store', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});
