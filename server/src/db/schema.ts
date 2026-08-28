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

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** scan-new | match-unmatched | match-library | match-series | sync-series | apply-series | clear-overrides | check-watched-searches | edit-comicinfo | merge-series (see src/jobs/queue.ts JOB_TYPES) */
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
  /** When set, the task writes into this shared folder (series merge) instead of its own per-gallery folder. */
  mergeFolder: text('merge_folder'),
  /** Manual chapter number written to ComicInfo.Number for merged downloads. */
  chapterNumber: integer('chapter_number'),
  /** Queue priority: claimNext picks higher values first (ties break on id ASC). */
  priority: integer('priority').notNull().default(0),
  errorMessage: text('error_message'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

/**
 * Saved doujin searches that are re-run periodically; new results trigger a
 * Discord notification. `source` + `query` mirror the Downloader's search box
 * (e.g. source=hitomi, query="artist:konboi language:english").
 */
export const watchedSearches = sqliteTable('watched_searches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** hitomi | nhentai */
  source: text('source').notNull(),
  query: text('query').notNull(),
  lastCheckedAt: text('last_checked_at'),
  lastResultCount: integer('last_result_count'),
  /** New galleries from the last check that found something (JSON array; null = no check yet). */
  lastResultsJson: text('last_results_json'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});

/** Galleries already reported for a watched search (dedupe across checks). */
export const watchedSearchSeen = sqliteTable('watched_search_seen', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  searchId: integer('search_id').notNull(),
  /** Redundant with the parent row so a deleted search's history stays queryable. */
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  firstSeenAt: text('first_seen_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});
/**
 * Tag/artist profile data for downloaded galleries, powering the daily
 * recommendations. Written when a download resolves its gallery metadata and
 * lazily backfilled for pre-existing downloads, so the recommendation engine
 * never has to re-fetch source metadata it already knows.
 */
export const galleryTags = sqliteTable('gallery_tags', {
  /** hitomi | nhentai */
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  title: text('title'),
  /** Tag entries as {name, ns} objects; ns is null when the tag is a plain keyword. */
  tagsJson: text('tags_json').notNull().default('[]'),
  artistsJson: text('artists_json').notNull().default('[]'),
  language: text('language'),
  fetchedAt: text('fetched_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});


export const keyValueStore = sqliteTable('key_value_store', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});

export const ownedGalleries = sqliteTable('owned_galleries', {
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  markedAt: text('marked_at')
    .notNull()
    .default(sql`(current_timestamp)`),
});

