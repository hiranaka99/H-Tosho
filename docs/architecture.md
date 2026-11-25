# Application ownership and maintenance

Where each responsibility lives, and the rules each owner keeps. User-facing
behaviour is documented in the [README](../README.md); release history is in the
[changelog](../CHANGELOG.md).

## Contracts, jobs and persistence

- `server/src/contracts/` defines job commands, download snapshots and pure
  metadata rules. The frontend imports shared types and preview rules without
  importing server I/O.
- `jobs/queue.ts` validates every enqueue, owns job conflicts, and stores
  immutable command JSON separately from execution state. Read APIs project
  legacy history without writing it. `jobs/storage.ts` keeps invalid saved
  commands inspectable and prevents execution.
- `jobs/executor.ts` dispatches validated commands to focused handlers.
  Read-only jobs (`scan-matchable`, `refresh-matched`, `check-watched-searches`,
  `clear-overrides`) take no library ownership and do not invalidate the
  duplicate-library cache.
- `db/schema.ts` is the schema authoring source, including defaults and indexes.
  `db/migrations.ts` bootstraps from those declarations and runs numbered
  upgrades transactionally. Add an explicit new migration for changes to
  existing installations; never rely on bootstrap to alter an existing table or
  edit an already-applied migration. Legacy filename imports retain ownership,
  approvals and job checkpoints.
- Matches, approvals and library overrides are scoped to the Kavita server
  address (`services/kavitaState.ts`); newer library tables carry an explicit
  `connection_key` instead of joining the legacy table swap.

## Library mutations and archives

- `lib/mutations.ts` coordinates overlapping series work. Broad scans, merges,
  deletion and path-only edits require exclusive library ownership;
  independent explicit series can run concurrently.
- `lib/cbz.ts` coordinates complete archive edits and publishes through unique
  staging files. Downloads reserve their output paths; folder merges and
  deletion use the same coordinator with ancestor/descendant conflicts.
  Waiting for ownership is cancellable.
- `kavita/libraryPaths.ts` owns filesystem translation. `kavita/scans.ts`
  distinguishes completed, unavailable and timed-out waits; callers retain
  operation-specific verification in `libraryOperations.ts`.

## Metadata matching and sync

- `services/sync.ts` owns the common automatic/manual application flow and
  atomic match/history persistence. `contracts/metadata.ts` supplies shared
  preview and application rules. `services/unmatch.ts` uses the same mutation
  boundary. The applied provider metadata is stored on the match row
  (`series_matches.metadata_json`).
- `services/matchSuggestions.ts` discovers candidates for unmatched series
  without applying metadata. The `scan-matchable` job runs daily and on demand;
  suggestions and candidate rejections persist separately from accepted
  matches, scoped to the Kavita server address.
- `services/matchRefresh.ts` runs the scheduled `refresh-matched` job (every
  `matchRefreshIntervalDays`, default 7, 0 off; also on demand from Home and
  Settings). For each matched series it re-reads exactly the matched provider
  entry; it never searches, so a new or better candidate never produces an
  alert. `contracts/matchUpdates.ts` diffs that entry against the applied
  metadata, ignoring protected fields, values the provider stopped returning,
  removed tags (tags merge additively) and any title the user chose from the
  applied title options. `match_updates` keeps the latest provider state and a
  fingerprint per series; changes are recomputed on read, so Apply & Sync,
  unmatch, a rematch or new protection resolve an update immediately.
  Dismissal hides one provider state until it changes; Discord announces each
  state once and never replays a backlog. The job writes nothing to Kavita.
- `services/downloadDiscovery.ts` queues persistent `scan-downloaded` jobs after
  publication, imports only the output folder through Kavita's path mappings,
  waits for indexing, and scopes candidate discovery to the resulting series.
  Merge-owned downloads enqueue discovery only after their final merge publishes.
- `providers/anilistClient.ts` serializes AniList calls across all workflows,
  paces requests below its documented degraded limit, and respects response
  quota and cooldown headers. Bounded retries and abort signals cover both
  queued and in-flight requests; recovered rate limits are not recorded as
  failed searches.
- `contracts/artists.ts` shares artist identities, paginated results and safe URL
  parsing. Optional provider artist methods back the authenticated artist
  routes; MyAnimeList people/works read public MAL pages with shared pacing and
  a bounded five-minute HTML cache, and credentials remain on official MAL
  metadata calls. `ArtistWorksBrowser` keeps provider selection and pagination
  inside IdentifyModal and sends chosen works through its existing review and
  application flow.

## Field protection and merges

- `services/fieldPolicies.ts` stores revisioned, connection-scoped protected
  fields. Provider sync, title/CBZ rewrites, covers and unmatch skip protected
  fields at execution time, not only in the review UI.
- `services/mergeProtection.ts` resolves indexed source/target policy and XML
  title effects for library, path-only and gallery merges before publication.
  Server-derived identity, policy union and move intents persist in separate
  job execution state; archive hashes reconcile unfinished move checkpoints
  after restart. Publication guards run under existing archive ownership,
  without nested coordinator deadlocks. Verified regrouping transfers current
  source/target protection before later sync; late-index recovery is idempotent
  and does not resurrect a deliberate later unlock. Merge name confirmation uses
  actual post-write readback. ComicInfo authoring remains explicit,
  protection-preserving and series-journaled.

## Metadata history and restore

- `services/metadataHistory.ts` captures connection-scoped before/observed-after
  snapshots before local or remote mutations. Retention keeps 180 days plus the
  latest 20 finished operations per series, independently of Task cleanup.
- `services/metadataRestore.ts` owns short-lived reviewed previews, atomic
  idempotent approval/Task creation, durable pinned plans, expected-state
  checks, and linked restore operations. `contracts/metadataRestore.ts` shares
  field mappings and exact-value availability.
  `KavitaClient.restoreSeriesMetadataExact()` performs single-attempt writes
  with freshly read DTOs, exact list replacement, native-lock preservation, and
  verified readback. It does not use provider aggregation or change accepted
  matches. External-client races are best effort, not conditional writes.
  Kavita v0.9.0 normalizes null text, summary/list whitespace and web links, and
  ignores release years below 1000; those historical values remain explicitly
  unavailable
  ([series endpoint](https://github.com/Kareadita/Kavita/blob/v0.9.0/Kavita.Services/SeriesService.cs),
  [year validation](https://github.com/Kareadita/Kavita/blob/v0.9.0/Kavita.Common/Helpers/NumberHelper.cs)).
  Server-derived age-rating changes are detected as review-required partial
  work, not reported as selective success. Finalized or ambiguous restore plans
  never replay blindly; queued never-started plans survive restart.
- `services/metadataArchiveRestore.ts` resolves current library roots and path
  mappings, requires complete CBZ index/folder agreement, and prepares
  server-only file authority. Complete-file SHA-256, non-XML content SHA-256,
  device/inode, size, timestamp and XML evidence are rechecked under archive
  ownership and immediately before atomic publication. History records archive
  preparation, applying and observed/unverified checkpoints; interrupted
  attempts never replay automatically. Older archive snapshots lacking content
  identity stay readable but cannot authorize XML restoration. Consumed
  previews expire after approval has copied their authority; finalized plan XML
  is released once both linked history records age out.
- `lib/comicInfoRestore.ts` edits selected top-level XML spans without
  rebuilding unrelated XML. Complete document replacement/removal requires
  explicit review; unsafe grouping changes, ambiguous XML and unsupported
  namespaces are rejected. The ZIP writer retains unrelated compressed payloads,
  original headers/extras, attributes, comments and data descriptors, including
  when removing ComicInfo. Title restores pair every indexed CBZ with the remote
  title. The exact title writer temporarily protects an unlocked sort name and
  restores its original native flag with fresh DTO/readback checks, because
  Kavita can derive sort names during rename
  ([upstream controller](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Server/Controllers/SeriesController.cs)).
  Archive-only restores do not trigger a Kavita scan; the next ordinary scan
  reads their XML.

## Cover history and restore

- `services/metadataCovers.ts` and `coverObservations.ts` retain series/volume
  checkpoints and content-addressed raster BLOBs. Capture is opt-in: a
  validated `HTOSHO_COVER_HISTORY_LIMIT_MIB` (10–16384 MiB) confirms the
  operator's payload budget; unset leaves the existing cover workflow available
  with explicit not-captured history. Each image is capped at 5 MiB, and each
  active capture reserves 5 MiB for readback before admitting its before asset.
  Global accounting includes reservations and deduplicates identical assets
  without evicting any live or pinned history. SQLite/WAL overhead is additional.
- Provider series-cover capture precedes title/archive/metadata writes; each
  cover target rechecks image hash, available native lock and indexed identity
  before upload. Failed preparation skips that cover while eligible scalar work
  can finish; unmatch prepares required series/volume backups before any
  cleanup writes. Unavailable readback is recorded as unverified. Startup
  interruption releases reservations and retains original observations.
- Retained cover handlers are authenticated and scoped by the active connection,
  series and operation reference; a content hash alone grants no access. Binary
  reads are bounded and uncached, served as validated raster types with nosniff
  and private/no-store headers. Cover filenames, identity paths, credentials and
  credential-bearing provider URLs are never asset authority.
- `services/metadataCoverRestore.ts` validates historical volume identity,
  current chapter/file membership, native-lock choices and authorized assets.
  Preview and approved-plan references pin current and source images.
  Supported [cover uploads](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Server/Controllers/UploadController.cs)
  use retained input bytes and explicit conversion consent because
  [thumbnail processing](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Services/ImageService.cs)
  can resize/re-encode them. This is not byte-exact restoration: originals stay
  retained and the actual output is journaled. Missing native volume-lock
  readback requires an explicit Locked/Unlocked choice; API acknowledgement and
  observed flags stay separate.

## Gallery sources and search

- `downloader/hitomi.ts`, `nhentai.ts`, `ehentai.ts` (with `ehentaiClient.ts` and
  `ehentaiGdata.ts`) implement native search, metadata and lazy page resolution.
  `services/ehentaiAccount.ts` stores account cookies encrypted (AES-256-GCM)
  with revision tracking; `downloader/ehentaiGate.ts` bounds E-Hentai request
  volume.
- E-Hentai gallery resolution follows only the same gallery's numbered
  thumbnail continuations and requires a complete, contiguous image list.
  Preview resolution selects the primary viewer image (`#img`); H@H ports are
  permitted only for an origin exposed by that viewer, with public DNS pinned on
  every request and redirect. Session cookies stay on the family site. Artist
  values are quoted in native searches, generated tag links and shared query
  compilation.
- `services/unifiedSearch.ts` owns the All sources search session: per-provider
  compiled lanes fetched concurrently with settled-result handling, strict
  cross-provider grouping (title, first artist, language, page count; missing
  pieces never wildcard), bounded interleaved pages over replayable cursors,
  one-time scoped lane retries, and invalidation on account/settings/principal
  change. A new query can stream NDJSON events so each provider's cards appear
  as it answers. `services/unifiedQuery.ts` compiles the shared query syntax per
  provider.
- `services/unifiedTitle.ts` builds comparison-only title keys from recognized
  author/event, language and digital annotations. `censorshipEdition()` reads
  the censorship edition from title labels and source tags; it keeps unmarked,
  censored and uncensored/decensored editions in separate groups, and
  contradictory labels never join either. Artist, language and page count must
  still match. Unknown annotations, chapter numbers, translator labels and
  color editions remain significant.
- `services/unifiedSuggestions.ts` merges provider autocomplete into
  deduplicated shared filters, with individual provider deadlines and
  partial-failure handling. Both search bars use `GallerySearchInput` for
  keyboard selection, caret-aware insertion, and cancellation of stale lookups.

## Downloads, duplicates and better editions

- `downloader/engine.ts` owns queue transitions and durable retry deadlines.
  Request retries and image transfer live in `requests.ts` and `transfer.ts`.
  The coarse `status` remains compatible with older clients; `state`,
  `errorCode`, `retryAt` and `phase` expose the precise lifecycle. `attempt` and
  `revision` order polling and SSE snapshots. Download origin is frozen at
  enqueue time.
- `services/galleryDuplicates.ts` compares galleries with owned downloads and
  local CBZ ComicInfo (title, artist, language, page count, source links and
  filename IDs). These are metadata matches, never image comparisons. Archive
  identities are cached per file stamp and pruned when archives disappear.
- Better editions are part of the same check. `betterEditionReasons()` reports an
  incoming gallery as an uncensored/decensored edition of an owned copy that is
  censored or not marked either way: same work with censorship labels removed,
  same artist and language, and a page count within two pages or 10%. Such a
  match carries `betterEdition: true`; it is compared even on the same source
  (decensored uploads are separate galleries there), does not count as a
  duplicate for recommendation filtering, and still asks for review before
  download. Library archives read the edition from ComicInfo `Tags` as well as
  titles. Following checks record the owned copy on new finds
  (`watched_search_new.better_edition_json`) for the feed, Home and Discord.
  Nothing is replaced or deleted automatically.

## Recommendations and Following

- `services/recommendations.ts` serializes displayed-set mutations and commits
  selections with serve history in a transaction. Dismissal, feedback and undo
  share eligibility and reconciliation. Taste aggregation lives in
  `recommendationProfile.ts`.
- `services/watchedSearches.ts` owns watches, folders, pause/cadence and the
  bounded due-work sweep (at most 20 due watches every 15 seconds, with
  per-watch ownership so checks never overlap). A check atomically commits
  seen/find/check bookkeeping; the first check seeds silently. Discord delivery
  is direct and deduplicated per source/gallery through a single send
  checkpoint on the discovery; outcomes are recorded in the check Task. There
  is no delivery queue, digest or backlog replay, and paused or edited watches
  never notify for obsolete work.
- `services/suggestedFollows.ts` suggests artists behind at least two downloaded
  galleries (a liked pick counts double) that no watch covers on any source and
  that are not muted or dismissed. It reads only local history. Following
  creates an ordinary named watch, compiled for the source most of that
  artist's galleries came from; dismissals are stored separately from
  recommendation feedback.
- No discovery, suggestion, refresh or notification path enqueues downloads.
  Credentials stay only in their settings.

## Frontend

- `web/src/pages/downloader/` owns search transitions, selection,
  recommendation and watched-feed models, and focused presentation. Gallery
  components observe only their own download task through a query selector.
  `useUnifiedSearch.ts` and `UnifiedSearchTab.tsx` commit streamed provider
  pages, merge variant updates into earlier entries, and keep per-source retry
  offers client-side; the detail modal's **Available from** group re-targets
  the resolved variant. `ownership.ts` turns library reports into one verdict
  per card (in library, downloaded, possible duplicate, better edition).
- Home reuses the Downloader's recommendation cache, watched inbox, gallery
  cards, previews and shared `useGalleryDownload` setup/duplicate/queue
  workflow. It lists matching candidates, provider updates for matched series,
  and new or better-edition Following finds; reviewing an update opens the
  normal comparison on the already-matched candidate.

## Checks

Run `npm run typecheck`, `npm test`, and `npm run test:e2e` for changes across
these boundaries. Tests use isolated databases and provider fixtures; live
Kavita and external providers are exercised through fixtures, not a production
installation. Authenticated E-Hentai/ExHentai search, preview and download
against a real account remain owner-verified.
