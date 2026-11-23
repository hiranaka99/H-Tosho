import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
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

export const metadataOperations = sqliteTable('metadata_operations', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  connectionKey: text('connection_key').notNull(),
  seriesId: integer('series_id').notNull(),
  jobId: integer('job_id'),
  restoredFromOperationId: text('restored_from_operation_id'),
  origin: text('origin').notNull(),
  status: text('status').notNull().default('running'),
  version: integer('version').notNull().default(1),
  fieldsJson: text('fields_json').notNull(),
  desiredJson: text('desired_json').notNull(),
  policyRevision: integer('policy_revision').notNull(),
  beforeJson: text('before_json').notNull(),
  afterJson: text('after_json'),
  message: text('message'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
}, table => [index('idx_metadata_operations_series').on(table.connectionKey, table.seriesId, table.sequence)]);

export const metadataOperationSteps = sqliteTable('metadata_operation_steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  operationId: text('operation_id').notNull(),
  target: text('target').notNull(),
  beforeJson: text('before_json').notNull(),
  afterJson: text('after_json'),
  status: text('status').notNull().default('prepared'),
}, table => [uniqueIndex('idx_metadata_operation_target').on(table.operationId, table.target)]);

/** Content-addressed binary assets, served only through an authorized operation reference. */
export const metadataAssets = sqliteTable('metadata_assets', {
  id: text('id').primaryKey(),
  mediaType: text('media_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  data: blob('data', {mode:'buffer'}).notNull(),
});

/** One series-cover checkpoint per operation; volume checkpoints share the same retained assets. */
export const metadataSeriesCovers = sqliteTable('metadata_series_covers', {
  operationId: text('operation_id').primaryKey(),
  status: text('status').notNull().default('preparing'),
  beforeState: text('before_state').notNull().default('unavailable'),
  beforeAssetId: text('before_asset_id'),
  beforeLocked: integer('before_locked', {mode:'boolean'}),
  beforeEvidenceJson: text('before_evidence_json'),
  beforeReason: text('before_reason'),
  afterState: text('after_state').notNull().default('unavailable'),
  afterAssetId: text('after_asset_id'),
  afterLocked: integer('after_locked', {mode:'boolean'}),
  afterReason: text('after_reason'),
  afterEvidenceJson: text('after_evidence_json'),
  requestedLock: integer('requested_lock', { mode: 'boolean' }),
  writeAcknowledged: integer('write_acknowledged', { mode: 'boolean' }).notNull().default(false),
  reservedBytes: integer('reserved_bytes').notNull().default(0),
}, table => [
  index('idx_metadata_series_covers_before').on(table.beforeAssetId),
  index('idx_metadata_series_covers_after').on(table.afterAssetId),
]);

export const metadataVolumeCovers = sqliteTable('metadata_volume_covers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  operationId: text('operation_id').notNull(),
  volumeId: integer('volume_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('preparing'),
  beforeState: text('before_state').notNull().default('unavailable'),
  beforeAssetId: text('before_asset_id'),
  beforeLocked: integer('before_locked', { mode: 'boolean' }),
  beforeEvidenceJson: text('before_evidence_json'),
  beforeReason: text('before_reason'),
  afterState: text('after_state').notNull().default('unavailable'),
  afterAssetId: text('after_asset_id'),
  afterLocked: integer('after_locked', { mode: 'boolean' }),
  afterEvidenceJson: text('after_evidence_json'),
  afterReason: text('after_reason'),
  requestedLock: integer('requested_lock', { mode: 'boolean' }),
  writeAcknowledged: integer('write_acknowledged', { mode: 'boolean' }).notNull().default(false),
  reservedBytes: integer('reserved_bytes').notNull().default(0),
}, table => [
  uniqueIndex('idx_metadata_volume_cover_operation').on(table.operationId, table.volumeId),
  index('idx_metadata_volume_covers_before').on(table.beforeAssetId),
  index('idx_metadata_volume_covers_after').on(table.afterAssetId),
]);

/** Unconsumed previews expire; approved plans copy all write authority durably. */
export const metadataRestorePreviews = sqliteTable('metadata_restore_previews', {
  id: text('id').primaryKey(),
  connectionKey: text('connection_key').notNull(),
  seriesId: integer('series_id').notNull(),
  sourceOperationId: text('source_operation_id').notNull(),
  previewJson: text('preview_json').notNull(),
  expectedJson: text('expected_json').notNull(),
  desiredJson: text('desired_json').notNull(),
  archivesJson: text('archives_json').notNull().default('[]'),
  coversJson: text('covers_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
}, table => [
  index('idx_metadata_restore_preview_expiry').on(table.expiresAt),
  index('idx_metadata_restore_preview_source').on(table.sourceOperationId),
]);

export const metadataRestorePlans = sqliteTable('metadata_restore_plans', {
  id: text('id').primaryKey(),
  previewId: text('preview_id').notNull(),
  connectionKey: text('connection_key').notNull(),
  seriesId: integer('series_id').notNull(),
  sourceOperationId: text('source_operation_id').notNull(),
  operationId: text('operation_id'),
  jobId: integer('job_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').notNull().default('approved'),
  expectedJson: text('expected_json').notNull(),
  desiredJson: text('desired_json').notNull(),
  archivesJson: text('archives_json').notNull().default('[]'),
  coversJson: text('covers_json').notNull().default('[]'),
  nativeLockFieldsJson: text('native_lock_fields_json').notNull(),
  policyRevision: integer('policy_revision').notNull(),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
  message: text('message'),
}, table => [
  uniqueIndex('idx_metadata_restore_idempotency').on(table.connectionKey, table.idempotencyKey),
  uniqueIndex('idx_metadata_restore_plan_preview').on(table.previewId),
  index('idx_metadata_restore_plan_job').on(table.jobId),
  index('idx_metadata_restore_plan_source').on(table.sourceOperationId),
  index('idx_metadata_restore_plan_operation').on(table.operationId),
]);

export const seriesFieldPolicies = sqliteTable('series_field_policies', {
  connectionKey: text('connection_key').notNull(),
  seriesId: integer('series_id').notNull(),
  lockedFieldsJson: text('locked_fields_json').notNull().default('[]'),
  revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
}, table => [uniqueIndex('idx_series_field_policy').on(table.connectionKey, table.seriesId)]);

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
  /** A user explicitly accepted this provider candidate. Independent of title similarity. */
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
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
}, table => [
  index('idx_series_matches_status_review').on(table.status, table.confirmed, table.matchScore),
]);

/** Read-only discovery results, separate from accepted matches and Kavita metadata. */
export const matchSuggestions = sqliteTable('match_suggestions', {
  connectionKey: text('connection_key').notNull(),
  seriesId: integer('series_id').notNull(),
  name: text('name').notNull(),
  libraryId: integer('library_id').notNull(),
  libraryName: text('library_name').notNull(),
  cover: text('cover'),
  candidatesJson: text('candidates_json').notNull(),
  checkedAt: text('checked_at').notNull(),
}, table => [uniqueIndex('idx_match_suggestions_series').on(table.connectionKey, table.seriesId)]);

/** A rejection applies to one candidate; a different candidate can surface later. */
export const rejectedMatchCandidates = sqliteTable('rejected_match_candidates', {
  connectionKey: text('connection_key').notNull(),
  seriesId: integer('series_id').notNull(),
  providerId: text('provider_id').notNull(),
  providerSeriesId: text('provider_series_id').notNull(),
  rejectedAt: text('rejected_at').notNull(),
}, table => [uniqueIndex('idx_rejected_match_candidate').on(table.connectionKey, table.seriesId, table.providerId, table.providerSeriesId)]);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** scan-new | match-unmatched | match-library | match-series | sync-series | apply-series | clear-overrides | check-watched-searches | edit-comicinfo | merge-series (see src/jobs/queue.ts JOB_TYPES) */
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  stateJson: text('state_json').notNull().default('{}'),
  /** queued | running | completed | failed */
  status: text('status').notNull().default('queued'),
  progressCurrent: integer('progress_current').notNull().default(0),
  progressTotal: integer('progress_total').notNull().default(0),
  resultJson: text('result_json'),
  errorMessage: text('error_message'),
  errorCode: text('error_code'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
}, (table) => [
  index('idx_jobs_status').on(table.status),
  index('idx_jobs_finished_at').on(table.finishedAt),
  index('idx_jobs_type_id').on(table.type, table.id),
]);

export const jobLogs = sqliteTable('job_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
}, (table) => [
  index('idx_job_logs_job_id').on(table.jobId),
]);

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
}, (table) => [
  index('idx_sync_history_series').on(table.kavitaSeriesId),
  index('idx_sync_history_created').on(table.createdAt),
]);

export const downloadQueue = sqliteTable('download_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** hitomi | nhentai | ehentai */
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  /**
   * Provider-resolved canonical gallery URL, frozen at enqueue time (e.g.
   * `https://exhentai.org/g/<gid>/<token>/`). Nullable for sources without a
   * canonical URL. Never carries credentials; the worker re-resolves with
   * current server-side credentials.
   */
  sourceUrl: text('source_url'),
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
  /** A merge job owns this download and performs the final Kavita scan. */
  mergeJobId: integer('merge_job_id'),
  /** Queue priority: claimNext picks higher values first (ties break on id ASC). */
  priority: integer('priority').notNull().default(0),
  errorMessage: text('error_message'),
  phase: text('phase'),
  errorCode: text('error_code'),
  retryAt: text('retry_at'),
  retryCount: integer('retry_count').notNull().default(0),
  attempt: integer('attempt').notNull().default(0),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
}, (table) => [
  index('idx_download_queue_gallery').on(table.source, table.galleryId),
  index('idx_download_queue_claim').on(table.status, table.priority),
  index('idx_download_queue_status_finished').on(table.status, table.finishedAt),
  index('idx_download_queue_status_id').on(table.status, table.id),
  index('idx_download_queue_merge_folder').on(table.mergeFolder),
  index('idx_download_queue_output_path').on(table.outputPath),
]);

export const watchedSearchFolders = sqliteTable('watched_search_folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(current_timestamp)`),
  updatedAt: text('updated_at').notNull().default(sql`(current_timestamp)`),
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
  displayName: text('display_name'),
  folderId: integer('folder_id'),
  pausedAt: text('paused_at'),
  intervalMinutes: integer('interval_minutes'),
  notificationMode: text('notification_mode').notNull().default('immediate'),
  revision: integer('revision').notNull().default(0),
  nextCheckAt: text('next_check_at'),
  lastCheckedAt: text('last_checked_at'),
  lastResultCount: integer('last_result_count'),
  /** New galleries from the last check that found something (JSON array; null = no check yet). */
  lastResultsJson: text('last_results_json'),
  lastNewCount: integer('last_new_count'),
  lastFindsAt: text('last_finds_at'),
  lastAttemptedAt: text('last_attempted_at'),
  lastFailedAt: text('last_failed_at'),
  lastError: text('last_error'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex('idx_watched_searches_source_query').on(table.source, table.query),
  index('idx_watched_searches_due').on(table.nextCheckAt, table.id),
]);

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
}, (table) => [
  uniqueIndex('idx_watched_search_seen_unique').on(table.searchId, table.source, table.galleryId),
]);
/**
 * Galleries a watch reported as new, with enough metadata to render them in
 * the Downloader's inbox and history without re-scraping. Discoveries remain
 * after review or watch removal; the feed is paginated at query time.
 */
export const watchedSearchNew = sqliteTable('watched_search_new', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  searchId: integer('search_id').notNull(),
  source: text('source').notNull(),
  /** The watch query that found the gallery (shown as "via …" in the feed). */
  query: text('query').notNull(),
  /** Readable provenance retained after the watch is removed. */
  watchLabel: text('watch_label').notNull().default(''),
  galleryId: text('gallery_id').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  coverUrl: text('cover_url'),
  pageCount: integer('page_count'),
  artistsJson: text('artists_json').notNull().default('[]'),
  language: text('language'),
  reviewedAt: text('reviewed_at'),
  /** A single send checkpoint prevents duplicate Discord messages across overlapping watches. */
  notificationAttemptedAt: text('notification_attempted_at'),
  /** ISO 8601 timestamp of the check that first reported the gallery. */
  foundAt: text('found_at').notNull(),
}, (table) => [
  uniqueIndex('idx_watched_search_new_unique').on(table.searchId, table.source, table.galleryId),
  index('idx_watched_search_new_found').on(table.foundAt, table.id),
  index('idx_watched_search_new_gallery').on(table.source, table.galleryId),
  index('idx_watched_search_new_dedupe').on(table.source, table.galleryId, table.foundAt, table.id),
]);

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
  parodiesJson: text('parodies_json').notNull().default('[]'),
  charactersJson: text('characters_json').notNull().default('[]'),
  groupsJson: text('groups_json').notNull().default('[]'),
  language: text('language'),
  fetchedAt: text('fetched_at')
    .notNull()
    .default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex('idx_gallery_tags_unique').on(table.source, table.galleryId),
]);


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
}, (table) => [
  uniqueIndex('idx_owned_galleries_unique').on(table.source, table.galleryId),
]);

/** Explicit recommendation feedback, separate from ownership and taste. */
export const dismissedGalleries = sqliteTable('dismissed_galleries', {
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  title: text('title'),
  artistsJson: text('artists_json').notNull().default('[]'),
  tagsJson: text('tags_json').notNull().default('[]'),
  dismissedAt: text('dismissed_at').notNull().default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex('idx_dismissed_galleries_unique').on(table.source, table.galleryId),
]);

/** Recently served recommendation payloads, one row per gallery. */
export const recommendationHistory = sqliteTable('recommendation_history', {
  source: text('source').notNull(),
  galleryId: text('gallery_id').notNull(),
  servedDate: text('served_date').notNull(),
  servedAt: text('served_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  itemJson: text('item_json').notNull(),
}, (table) => [
  uniqueIndex('idx_recommendation_history_unique').on(table.source, table.galleryId),
  index('idx_recommendation_history_served').on(table.servedAt),
  index('idx_recommendation_history_served_date').on(table.servedDate),
]);

