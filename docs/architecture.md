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
- `providers/anilistClient.ts` serializes AniList calls across all workflows,
  paces requests below its documented degraded limit, and respects response quota
  and cooldown headers. Bounded retries and abort signals cover both queued and
  in-flight requests; recovered rate limits are not recorded as failed searches.
- `kavita/libraryPaths.ts` owns filesystem translation. `kavita/scans.ts` distinguishes completed, unavailable and timed-out waits; callers retain operation-specific verification in `libraryOperations.ts`.
- `downloader/engine.ts` owns queue transitions and durable retry deadlines. Request retries and image transfer live in `requests.ts` and `transfer.ts`. The coarse `status` remains compatible with older clients; `state`, `errorCode`, `retryAt` and `phase` expose the precise lifecycle. `attempt` and `revision` order polling and SSE snapshots.
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
- `web/src/pages/downloader/` owns search transitions, selection, recommendation and watched-feed models, and focused presentation. Gallery components observe only their own download task through a query selector.

Run `npm run typecheck`, `npm test`, and `npm run test:e2e` for changes across these boundaries. Tests use isolated databases and provider fixtures. The regression suite includes concurrent archive edits, recommendation interleaving, malformed persisted commands, upgrade rollback, durable retry recovery, and stale download snapshots.

The maintainability changes were verified with 429 server tests, 37 frontend tests, and 32 desktop/mobile browser checks. Typechecking and the production build passed. An isolated compiled-server smoke check covered account setup/login, SPA routing, command rejection, background job execution, schema versions, persisted history, and interrupted-job recovery after restart. Docker source ordering includes the shared contracts before the frontend build. The Linux/amd64 image also built and passed isolated container checks for HTTP authentication, static and precompressed assets, settings, job execution, native SQLite migrations/integrity, concurrent CBZ edits, and restart persistence/recovery. Desktop and mobile browsers passed login, settings, theme, jobs, downloader, deep-link, reload and logout checks against that image without JavaScript or asset errors. Docker Compose configuration validation passed; test containers and volumes were removed afterwards. Live Kavita and external providers were exercised through fixtures rather than a production installation.
