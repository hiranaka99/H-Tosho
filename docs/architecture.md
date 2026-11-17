# Application ownership and maintenance

- `server/src/contracts/` defines job commands, download snapshots and pure metadata rules. The frontend imports shared types and preview rules without importing server I/O.
- `contracts/artists.ts` shares artist identities, paginated results and safe URL
  parsing. Optional provider artist methods back the authenticated artist routes;
  MyAnimeList people/works read public MAL pages with shared pacing and a
  bounded five-minute HTML cache; credentials remain on official MAL metadata calls.
  `ArtistWorksBrowser` keeps provider selection and pagination inside IdentifyModal
  and sends chosen works through its existing metadata review/application flow.
- `jobs/queue.ts` validates every enqueue, owns job conflicts, and stores immutable command JSON separately from execution state. Read APIs project legacy history without writing it. `jobs/storage.ts` keeps invalid saved commands inspectable and prevents execution.
- `jobs/executor.ts` dispatches validated commands to focused handlers. `lib/mutations.ts` coordinates overlapping series work; broad scans, merges, deletion and path-only edits require exclusive library ownership. Independent explicit series can run concurrently.
- `lib/cbz.ts` coordinates complete archive edits and publishes through unique staging files. Downloads reserve their output paths; folder merges and deletion use the same coordinator with ancestor/descendant conflicts. Waiting for ownership is cancellable.
- `services/sync.ts` owns the common automatic/manual application flow and atomic match/history persistence. `contracts/metadata.ts` supplies shared preview and application rules. `services/unmatch.ts` uses the same mutation boundary.
- `services/mergeProtection.ts` resolves indexed source/target policy and XML title
  effects for library, path-only and gallery merges before publication. Server-derived
  identity, policy union and move intents persist in separate job execution state;
  archive hashes reconcile unfinished move checkpoints after restart. Publication
  guards run under existing archive ownership, without nested coordinator deadlocks.
  Verified regrouping transfers current source/target protection before later sync;
  late-index recovery is idempotent and does not resurrect a deliberate later unlock.
  Merge name confirmation uses actual post-write readback, not the pre-rename object.
  ComicInfo authoring remains explicit, protection-preserving and series-journaled.
- `services/metadataHistory.ts` captures connection-scoped before/observed-after
  snapshots before local or remote mutations. `services/metadataRestore.ts` owns
  short-lived reviewed previews, atomic idempotent approval/Task creation,
  durable pinned plans, expected-state checks, and linked restore operations.
  `contracts/metadataRestore.ts` shares field mappings and exact-value availability;
  `KavitaClient.restoreSeriesMetadataExact()` performs single-attempt writes with
  freshly read DTOs, exact list replacement, native-lock preservation, and verified
  readback. It does not use provider aggregation or change accepted matches.
  External-client races are best effort, not conditional writes. Kavita v0.9.0
  normalizes null text, summary/list whitespace and web links, and ignores release
  years below 1000; those historical values remain explicitly unavailable
  ([series endpoint](https://github.com/Kareadita/Kavita/blob/v0.9.0/Kavita.Services/SeriesService.cs),
  [year validation](https://github.com/Kareadita/Kavita/blob/v0.9.0/Kavita.Common/Helpers/NumberHelper.cs)).
  Server-derived age-rating changes are detected as review-required partial work,
  not reported as selective success. Finalized/ambiguous restore plans never replay
  blindly; queued never-started plans survive restart. Migration 6 adds restore
  persistence and source links; retention pins active plans independently of logs.
- `services/metadataArchiveRestore.ts` resolves current library roots and path
  mappings, requires complete CBZ index/folder agreement, and prepares server-only
  file authority. Migration 7 adds durable archive plans without manufacturing
  authority for older approvals. Complete-file SHA-256, non-XML content SHA-256,
  device/inode, size, timestamp and XML evidence are rechecked under archive
  ownership and immediately before atomic publication. History records archive
  preparation, applying and observed/unverified checkpoints; interrupted attempts
  never replay automatically. Older archive snapshots lacking content identity
  stay readable but cannot authorize XML restoration.
  Consumed previews expire after approval has copied their authority; finalized
  plan XML is released once both linked history records age out. Compact
  idempotency receipts remain, and active plans retain their complete authority.
- `lib/comicInfoRestore.ts` edits selected top-level XML spans without rebuilding
  unrelated XML. Complete document replacement/removal requires explicit review;
  unsafe grouping changes, ambiguous XML and unsupported namespaces are rejected.
  The ZIP writer retains unrelated compressed payloads, original headers/extras,
  attributes, comments and data descriptors, including when removing ComicInfo.
  Title restores pair every indexed CBZ with the remote title. The exact title
  writer temporarily protects an unlocked sort name and restores its original
  native flag with fresh DTO/readback checks, because Kavita can derive sort names
  during rename ([upstream controller](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Server/Controllers/SeriesController.cs)).
  Sort/localized names and flags are also recorded for inspecting interrupted
  checkpoints. Archive-only restores do not trigger a Kavita scan; the next
  ordinary scan reads their XML. Completed Tasks report verified archive counts.
- `services/metadataCovers.ts`, `coverObservations.ts` and migrations 8/13 retain
  series/volume checkpoints and content-addressed raster BLOBs. Capture is opt-in: a validated
  `HTOSHO_COVER_HISTORY_LIMIT_MIB` (10–16384 MiB) confirms the operator's payload
  budget; unset leaves the existing cover workflow available with explicit
  not-captured history. Each image is capped at 5 MiB, and each active capture
  reserves 5 MiB for readback before admitting its before asset. Global payload
  accounting includes reservations and deduplicates identical assets across
  retained references without evicting any live/pinned history. The 256 MiB
  reference budget is provisional; actual library capacity remains an operator
  decision, and SQLite/WAL overhead is additional.
  Provider series-cover capture precedes title/archive/metadata writes; each cover
  target rechecks image hash, available native lock and indexed identity before upload.
  Failed preparation skips that cover while eligible scalar work can finish;
  unmatch prepares required series/volume backups before any cleanup writes.
  After observations survive cancellation/partial failure; unavailable readback
  is unverified. Startup interruption releases reservations and retains original
  observations. Retention deletes cover checkpoints with expired operations and
  garbage-collects only assets unreferenced by every retained/pinned checkpoint.
- Retained cover handlers are authenticated and scoped by the active connection,
  series and operation reference; a content hash alone grants no access. Binary
  reads are bounded and uncached, served as validated raster types with nosniff
  and private/no-store headers. Cover filenames, identity paths, credentials and
  credential-bearing provider URLs are not exposed as asset authority.
  The [image controller](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Server/Controllers/ImageController.cs)
  supports series/volume reads. The
  [volume DTO](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Models/DTOs/VolumeDto.cs)
  declares a native cover lock, but releases that omit it are recorded as unknown.
  `services/metadataCoverRestore.ts` validates historical volume creation identity,
  current chapter/file membership, native-lock choices and authorized assets.
  Preview and approved-plan references pin current and source images, including
  unavailable previews and ordinary queue delays. Migration 13 preserves existing
  series backups and adds volume checkpoints/cover plans without manufacturing history.
  Supported [cover uploads](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Server/Controllers/UploadController.cs)
  use retained input bytes and explicit conversion consent because
  [thumbnail processing](https://github.com/Kareadita/Kavita/blob/develop/Kavita.Services/ImageService.cs)
  can resize/re-encode them. This is not byte-exact image restoration: originals
  remain retained and the actual output is journaled. Missing native volume-lock
  readback requires an explicit Locked/Unlocked choice; API acknowledgement and
  observed flags stay separate. Silent no-ops and unavailable readback are unverified.
- `providers/anilistClient.ts` serializes AniList calls across all workflows,
  paces requests below its documented degraded limit, and respects response quota
  and cooldown headers. Bounded retries and abort signals cover both queued and
  in-flight requests; recovered rate limits are not recorded as failed searches.
- `kavita/libraryPaths.ts` owns filesystem translation. `kavita/scans.ts` distinguishes completed, unavailable and timed-out waits; callers retain operation-specific verification in `libraryOperations.ts`.
- `downloader/engine.ts` owns queue transitions and durable retry deadlines. Request retries and image transfer live in `requests.ts` and `transfer.ts`. The coarse `status` remains compatible with older clients; `state`, `errorCode`, `retryAt` and `phase` expose the precise lifecycle. `attempt` and `revision` order polling and SSE snapshots.
- `services/unifiedSearch.ts` owns the unified search session: per-provider compiled lanes fetched concurrently with settled-result handling, strict cross-provider grouping (title, first artist, language, page count — missing pieces never wildcard), bounded interleaved pages over replayable cursors, one-time scoped lane retries, and invalidation on account/settings/principal change. `services/unifiedQuery.ts` compiles the shared query syntax per provider. `services/ehentaiAccount.ts` stores account cookies encrypted (AES-256-GCM) with revision tracking; `downloader/ehentaiGate.ts` bounds E-Hentai request volume. `downloader/ehentai.ts`, `ehentaiClient.ts`, and `ehentaiXml.ts` cover native search, gdata-batch metadata, and lazy page resolution for E-Hentai/ExHentai.
- `services/recommendations.ts` serializes displayed-set mutations and commits selections with serve history in a transaction. Dismissal, feedback and undo share eligibility and reconciliation. Taste aggregation lives in `recommendationProfile.ts`.
- `services/matchSuggestions.ts` discovers candidates without applying metadata. The
  `scan-matchable` job runs daily and on demand; suggestions and candidate rejections
  persist separately from accepted matches, scoped to the Kavita server address.
  `services/downloadDiscovery.ts` queues persistent `scan-downloaded` jobs after
  publication, imports only the output folder through Kavita's path mappings,
  waits for indexing, and scopes candidate discovery to the resulting series.
  Merge-owned downloads enqueue discovery only after their final merge publishes.
  Home reuses the Downloader’s recommendation cache, watched inbox, gallery cards,
  previews, and shared `useGalleryDownload` setup/duplicate/queue workflow. Activity
  combines existing sync history and completed download records.
- `db/schema.ts` is the schema authoring source, including defaults and indexes. `db/migrations.ts` bootstraps from those declarations and runs numbered upgrades transactionally. Add an explicit new migration for changes to existing installations; never rely on bootstrap to alter an existing table. Legacy filename imports retain ownership, approvals and job checkpoints.
- `web/src/pages/downloader/` owns search transitions, selection, recommendation and watched-feed models, and focused presentation. Gallery components observe only their own download task through a query selector. Unified search state (`useUnifiedSearch.ts`, `UnifiedSearchTab.tsx`) commits provider pages, merges variant updates into earlier entries, and keeps per-source retry offers client-side; the detail modal's **Available from** group re-targets the resolved variant.
- `services/watchedSearches.ts` atomically commits seen/find/check bookkeeping with
  notification events/contributions. Migration 12 adds per-watch in-app/immediate/digest
  modes without replaying historical discoveries. Events deduplicate by source/gallery
  while retaining overlapping labels and origin Task IDs.
  `services/followingDelivery.ts` prepares immutable immediate/digest deliveries,
  commits a dispatch checkpoint before webhook HTTP, verifies receipts, and records
  disabled/suppressed/failed/unknown outcomes separately from provider success.
  Bounded known retries reuse frozen membership; startup holds unfinished sends as
  unknown. Revision-bound, idempotent manual recovery reviews current destination,
  eligible membership and duplicate risk. Invalidated watch contributions never revive
  automatically after pause/resume, deletion, mode changes or settings cutovers.
  `services/followingClock.ts` uses the server-only Temporal polyfill for IANA-zone
  daily cutoffs: earlier DST fold occurrence, gap-length forward shift, persistent UTC
  deadline and one bounded catch-up batch per local day. No discovery/delivery path
  enqueues downloads. Credentials remain only in existing notification settings.

Run `npm run typecheck`, `npm test`, and `npm run test:e2e` for changes across these boundaries. Tests use isolated databases and provider fixtures. The regression suite includes concurrent archive edits, recommendation interleaving, malformed persisted commands, upgrade rollback, durable retry recovery, and stale download snapshots.

The maintainability changes were verified with 429 server tests, 37 frontend tests, and 32 desktop/mobile browser checks. Typechecking and the production build passed. An isolated compiled-server smoke check covered account setup/login, SPA routing, command rejection, background job execution, schema versions, persisted history, and interrupted-job recovery after restart. Docker source ordering includes the shared contracts before the frontend build. The Linux/amd64 image also built and passed isolated container checks for HTTP authentication, static and precompressed assets, settings, job execution, native SQLite migrations/integrity, concurrent CBZ edits, and restart persistence/recovery. Desktop and mobile browsers passed login, settings, theme, jobs, downloader, deep-link, reload and logout checks against that image without JavaScript or asset errors. Docker Compose configuration validation passed; test containers and volumes were removed afterwards. Live Kavita and external providers were exercised through fixtures rather than a production installation.

The E-Hentai/ExHentai and unified-search increment was verified with focused server tests (grouping, pagination, cursor replay/stale/expiry, partial failure and scoped retry, session invalidation, account classification, canonical URL/ID handling), the full server and frontend suites, a production build, and desktop/mobile browser checks over fixture providers covering tab placement and deep links, cross-provider grouping with provenance, the detail view's variant chooser, exact unique totals, and the one-time scoped retry. E-Hentai behavior was verified against live error paths (unauthenticated and rejected sessions) and fixture data; authenticated search, gdata-batch metadata, preview, and download against a real account were not exercised in this environment and remain owner-verified.
