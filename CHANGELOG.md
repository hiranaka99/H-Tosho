# Changelog

## v4.3.1

- Fix a startup database migration crash (`no such table: main.match_updates`) when upgrading
  existing v4.1 or v4.2 installations to v4.3. Skip indexes whose target table or column has
  not been created yet so earlier index migrations succeed before later migrations create
  those tables and indexes.

## v4.3.0

- Update H-Tosho from inside the app under Settings → Account → App updates, with a sidebar
  indicator when a new release is available. Git checkouts fetch, install, rebuild, and restart
  automatically; Docker installations apply verified in-app release bundles with automatic startup
  rollback when only application code changed, and warn with copyable pull/rebuild commands
  whenever the Dockerfile, Node.js version, or server runtime dependencies require completely
  replacing the Docker image.
- Check matched series for provider updates every 7 days (configurable, or on demand).
  Each series is re-read from the exact entry it is matched to, so a new or better
  candidate never raises an alert. Changes appear under Provider updates on Home with
  Review update and Dismiss, respect protected fields, resolve after Apply & Sync, and
  are announced once on Discord.
- Mark uncensored and decensored editions of galleries you own as Better edition in
  Discover, For you, Following and Home, including decensored uploads on the same
  source and editions stated only by tags. The download review offers Download better
  edition; Following records better-edition finds for Home and Discord.
- Suggest artists to follow from your downloads and liked picks. Follow creates a named
  watch on the artist's main source; dismissed and muted artists are not suggested.
- Stream unified search results per provider as each source answers, with a Searching
  indicator for lanes still running, and use nHentai's dedicated cover image on search cards.
- Add fit-to-width and 1x–4x zoom with drag-to-pan and keyboard navigation to the gallery
  page reader, remembering the last page per gallery and preferred fit mode for the session.
  Group gallery detail tags by namespace with per-namespace colors and show live download
  progress and confirmed library copies in the modal.
- Refine Home and Following triage: keyboard shortcuts (`j`/`k`/`d`/`u`), 5 min–24 h watch
  check intervals, caught-up and filtered empty states, source-watch labels, failure chips
  and sync errors on Home, a Kavita setup card when disconnected, and larger cover previews
  in identification review.
- Optimize SPA shell ETag and Brotli/gzip caching, run database retention pruning daily in
  long-lived processes, coalesce E-Hentai image writes, parallelize download publishing,
  and add database indexes for downloads, merges, and unreviewed watched results.
- Refresh README screenshots for v4.2.0 and rewrite architecture notes by ownership area.

## v4.2.0

- Rework the Download Manager with separate queue and paginated history views, counts by
  status, and Kavita import status for completed downloads. Pause or resume the whole queue,
  retry failed downloads in bulk, and prioritize individual items.
- Make downloads more resilient with progressive retries, provider cooldowns, clearer
  quota and disk-full errors, and refreshed E-Hentai viewer links on retry. Validate
  downloaded images before creating archives and improve cleanup and recovery after shutdown.
- Improve For You recommendations using tag combinations, groups, parodies, and Kavita
  reading and rating signals. Mute tags, dismiss suggestions, and browse pages that wrap
  around. Picks skip active downloads, unreviewed Following galleries, and known library
  duplicates. Prefetch covers for each day's picks.
- Share gallery selection across Discover search and For You, keep the download destination
  next to selection actions, and let users follow supported providers from an All sources
  search using each provider's query. Recover cleanly when searches are canceled, and match
  E-Hentai tag filters and exclusions exactly.
- Improve library duplicate detection for renamed or re-annotated titles. Keep part and
  sequel markers distinct and require matching page counts for looser title matches.
- Load Kavita series when a library opens and refresh cached artist metadata in the
  background. Add database indexes, batch retention cleanup, compress larger responses,
  and reduce filesystem work and progress polling.
- Organize Settings into Kavita, Sources, Downloads, Notifications, and Account. Keep
  drafts across tabs and show save actions in a sticky bar with clearer validation.
  Preview fonts before choosing one. Montserrat and Roboto are served locally.
- Strengthen API and settings validation, bound archive and media reads, and rate-limit
  failed sign-ins. Expand server test coverage for redirects, media, and download recovery.
- Fix shared auth and download state during development hot reloads. Clean up local design
  review artifacts and update the design reference.

## v4.1.0

- Refine the Settings tab. Account and downloader tabs show a marker when they hold unsaved
  changes, with draft feedback. Kavita connection Test and Save are now separate actions, and
  a saved connection can be reverted. When the saved Discord settings differ from the draft,
  you choose explicitly between Load and Replace. Validation errors appear only on fields
  you have touched.

- Streamline Discover search and selection. The separate unified search tab is replaced by
  All sources / per-provider search scopes. The selection tray adds download-each and
  select-all-page actions, and loading, failure, hint and Following inbox states are clearer.

- Add undo and clearer review flows on Home. Rejected match candidates and reviewed following
  galleries can be undone, bulk review and waiting-count links are supported, and empty
  states, action styling and accessibility labels are refined.

- Improve the Libraries review workflow with status chips, confidence sorting and match-run
  outcome summaries. Adds a library tools menu, card preview actions, bulk unmatch and
  keyboard grid navigation, with clearer review queue labels, touch targets and contrast.

- Rework the Identify dialog from a design critique into a guided review. Reviewing a match
  now leads with what will change: Apply says exactly how many changes it will make
  ("Apply 5 changes"), fields that already match or have nothing to sync fold under
  "N fields won’t change", and protected fields sit apart with a lock and an inline Unlock
  instead of looking like fields you deselected. A match below the review threshold shows its
  score and a warning, and changing the title says it rewrites ComicInfo.xml in every chapter
  file. The covers are a compact pair at the top, the title chooser is part of the Title row,
  and the artist browser is one Back away rather than competing with the comparison. Match
  candidates show their confidence and are ranked best first, with no nested scroller. Provider
  badges now meet text contrast in both themes, the provider filters report their selected
  state, and closing the dialog returns focus to the button that opened it.

- Rework the Tasks tab from a design critique. Stopping a task now takes an inline
  confirmation that says what is kept, and opening Details no longer focuses a
  destructive action. Rows lead with the action, use a type glyph instead of an empty
  cover, and show clean completions as a quiet check. Failed tasks open on a plain-language
  explanation with the next step (including a Retry-After countdown), with the raw error
  under Error details. Status is now tabs with counts (All, Active, Needs attention,
  Finished) that open on Needs attention when something needs it, and the sidebar says
  "Needs attention" with the same count. From 1280px wide, Details is a non-modal side
  panel with progress, an estimate, a freshness stamp and open, following logs for running
  tasks; arrow keys move between tasks, and rows stay put while the pointer is over the list.

## v4.0.1

- Normalize leading artist/circle credits in unified search, including arbitrary
  aliases, `[Circle (Artist)]`, nested brackets and stacked credits, independently
  of artist spelling or search query. Preserve original source titles, meaningful
  chapter/color/language labels, and artist/page-count/censorship-edition checks.

## v4.0.0

- Stabilize release tests by allowing filesystem work to finish before advancing
  mock clocks, correcting Kavita title/ownership fixtures, and tolerating browser
  coordinate rounding while retaining the 44px control-height check.

- Improve unified-search title grouping by recognizing author/event prefixes
  and language/digital labels. Keep unmarked, censored, and uncensored/decensored
  editions in separate groups, retaining original titles and chapter/color differences.

- Add native E-Hentai/ExHentai tag autocomplete and shared-filter suggestions
  in unified search, with keyboard selection and caret-aware term replacement.

- Route nHentai artist-only searches and artist-page URLs through exact artist
  tag listings, preserving language, banned tags, sorting, and filtered pagination.

- Default E-Hentai/ExHentai searches to English, prefer English on multilingual
  results, and exclude known language mismatches. Explicit language filters still apply.

- Limit E-Hentai/ExHentai search results to Doujinshi, Manga, and Artist CG,
  including unified searches and subsequent result pages.

- Fix E-Hentai/ExHentai gallery details, sprite thumbnail links, and paginated
  image lists. Resolve the primary viewer image and its approved H@H port for
  previews. Quote artist queries and generated tag links so artist searches work.

- Fix E-Hentai/ExHentai searches against the current compact list markup,
  gallery tokens, continuation links, and JSON metadata API. Apply language
  filters with native tags and allow covers from the current ehgt.org CDN.

- Add E-Hentai/ExHentai as a third doujinshi source, backed by an account saved
  in Settings → Downloader. The account's cookies are encrypted at rest
  (AES-256-GCM) and never sent to the browser; search, previews, and downloads
  use the saved site (E-Hentai or ExHentai) behind a bounded request gate.
  Download origin is frozen at enqueue time in the queue, so queue, resume,
  merge, and duplicate identity stay correct across account and site switches.

- Add a **Unified search** tab to Discover, immediately after **Search**, that
  runs one query across Hitomi.la, nHentai, and E-Hentai/ExHentai concurrently.
  A shared syntax (artist/group/parody/character/language filters, quoted
  phrases, `-` exclusions, keywords) compiles per provider; filters a source
  does not support are reported on its status chip without failing the search.
  Repeated editions — same title, first artist, language, and page count —
  group into one entry listing every real source, with provenance on the card
  and an **Available from** choice in the details view that re-targets preview,
  source link, and download. Pages deliver 25 unique entries with replayable
  cursors, an exact unique total when every applicable source is exhausted,
  and per-source partial failure with a one-time scoped retry that re-fetches
  only the failed lane. Saving a different E-Hentai account or changing
  downloader settings invalidates in-flight sessions.

- Add Following names/folders, revision-safe editing and reordering, pause/resume,
  inherited or custom cadence, and compact icon actions. Persist bounded due-work
  scheduling and recheck watch identity/preferences after provider responses.
  Paused checks retain in-app discoveries without Discord or resuming the watch;
  global automatic-off overrides custom intervals. Folder filters precede gallery
  deduplication; removed-watch provenance and shared review history remain readable.
  Migration 10 reconciles legacy duplicate watches without discarding discoveries.
  Save completion preserves another watch's open draft, folder changes clear
  stale exact-watch filters, and named search controls expose their visible
  names to assistive technology.

- Simplify Following notifications to direct, deduplicated Discord sends or in-app
  finds. Remove the delivery log, recovery queue, daily digest, and digest settings.
  Retain Discord credentials, watch preferences, discoveries, and normal Task history;
  archive existing delivery outcome totals on their Tasks before retiring storage.

- Enforce title protection across library, path-only and gallery merge publication,
  preserve source/target policy unions through regrouping/restart, and require real
  preflight/unlock review in merge dialogs. Direct ComicInfo authoring remains allowed,
  shows protection status and preserves policies. Retain durable move/identity evidence
  for interrupted merges without claiming whole-merge undo. Verify the observed renamed
  title and prepare every required unmatch cover backup before any cleanup write.

- Add opt-in series/volume-cover history and supported-API restoration, retaining
  original bytes, available native locks, indexed volume identity and authenticated
  Current / Saved image comparisons. Require explicit resize/re-encoding consent:
  Kavita's output is journaled, not advertised as byte-exact. Unreadable volume locks
  require explicit Locked/Unlocked choice; API acknowledgement stays separate from
  independent flag verification. Configure `HTOSHO_COVER_HISTORY_LIMIT_MIB` for bounded
  capture, reserved readback, deduplication and retention of preview/approved assets.

- Add exact selective scalar/list restoration from Metadata history, with
  Current → Restore to previews, explicit review, protection-aware field selection,
  optional recorded native-lock restoration, and linked restore Tasks/history.
- Keep restore warnings readable in both themes and disable provider Apply & Sync
  and Unmatch while Metadata history is open.
- Persist idempotent approved restore plans and pin their source snapshots through
  queue delays. Recheck selected values, policy, connection and target identity at
  execution; retain partial/interrupted outcomes and require fresh review instead
  of blind retry. Unsupported exact values and absent/unverified images stay unavailable.
- Add paired title restoration and selected ComicInfo.xml field restoration,
  with explicit full-document replacement/removal, allowed-root/index checks,
  complete-file/content fingerprints, durable file checkpoints and verified
  archive counts in Tasks. Keep unrelated XML and ZIP metadata intact, preserve
  current sort/localized names and native flags, and block stale or incomplete
  file sets. Older archive snapshots without content identity remain browseable.

## v3.5.3

- Run one matching scan for galleries downloaded as a new merged series, after
  every chapter has settled. Register the selected galleries together and scan
  the shared series folder so quick downloads cannot start premature checks.
- Show Hitomi group/circle names in gallery details and keep their group search
  links working, including `shirukke no ooi zakuro`.

## v3.5.2

- Include AniList one-shots and alternate titles in metadata searches, fixing
  missed candidates such as `Warui Ko to no Bukiyou de Ecchi na Kyoudou Seikatsu`.

- Use short temporary names when rewriting CBZ metadata so valid long archive
  names do not exceed filesystem limits during Apply & Sync. Preserve atomic
  replacement and report genuine path-length errors separately from mount errors.
- Accept MyAnimeList name searches that redirect directly to a single artist's
  profile, fixing the “unrecognized artist page” error for queries such as
  `kirin kakeru`.

## v3.5.1

- Replace the discontinued Jikan public API with direct MyAnimeList artist-page
  browsing. Keep artist search, people URLs, cached covers, and pagination working
  without another service. Retry transient failures and show actionable connection
  errors instead of a bare “fetch failed” message.

## v3.5.0

- Add MyAnimeList artist browsing through Jikan, including people URLs, cached
  cover tiles, and the existing official MAL metadata review before applying.
- Include adult titles and alternate titles in MyAnimeList searches; use its
  Client ID header, official media types, author fields, and publishing status.

## v3.4.1

- Pace AniList requests across scans, metadata review, and artist browsing, and
  honor full rate-limit cooldowns before retrying HTTP 429 or GraphQL rate-limit
  responses. Keep scans cancellable while waiting and preserve genuine errors
  after bounded retries.

## v3.4.0

- Import completed downloads into Kavita and discover metadata candidates in
  background jobs for review on Home. Match only the imported galleries, keep
  existing dismissals, and surface indexing/provider failures in Jobs without
  failing completed downloads or automatically applying metadata.
- Keep the daily match-discovery timer active when watched-search polling starts.
- Start provider search when returning from a Home match review to the match
  list, fixing a disabled search that left the dialog stuck on its loading state.

## v3.3.2

- Remove the duplicate jump-to-page input and Go button from pagination, keeping
  Previous, numbered pages, and Next.

## v3.3.1

- Show artist works as a responsive cover grid in matching dialogs, with larger
  complete covers and compact title, type, and year captions.
- Keep the Back to matches button at its intended height when the grid scrolls.

## v3.3.0

- Browse artists’ works from matching dialogs, separated into AniList and MangaDex
  tabs. Search saved artist names or paste a provider artist URL, page through
  works, and review a selection in the existing metadata comparison before syncing.
- Use AniList’s documented GraphQL endpoint for metadata and artist requests.
- Bound MyAnimeList search keywords to its accepted length, avoiding HTTP 400
  `invalid q` warnings for long gallery titles and too-short search terms.
  Keep the original title for match confidence scoring and report genuine
  provider failures normally.
- Keep the Home matching and saved-search panels at equal heights on desktop.

## v3.2.0

- Add Home as the default page and the first sidebar item, with shared daily
  recommendations, unreviewed saved-search finds, and recent match/download activity.
- Discover metadata candidates for unmatched Kavita galleries in a daily background
  scan or with Scan now. Review candidates before applying metadata; No match found
  remembers rejected candidates while allowing different candidates to appear later.

## v3.1.2

- Keep Unmatch cover resets within the current matching cycle and reset only
  volume covers H-Tosho applied, preserving unrelated custom covers.
- Keep matches, approvals, sync history, library overrides, and library jobs
  separate for each Kavita server address; restore them when switching back.
  Finish active library work before changing servers.
- Abort active download transfers and retry waits on Cancel so queue slots
  are freed promptly.
- Accept Hitomi reader and gallery URLs in direct lookup and paged search,
  including title slugs, query strings, and reader page fragments.

## v3.1.1

- Fix MangaDex covers failing to load when the image proxy's browser
  User-Agent triggers MangaDex's bot challenge.

## v3.1.0

- Rename the destination series while merging galleries from Search,
  Recommended, or Watched. Review the proposed name before queueing; the
  merge updates existing and incoming archive metadata and Kavita together.
- Add gallery selection and both merge actions to Recommended, using the
  same desktop shortlist and mobile action tray as Search and Watched.
- Apply the chosen library merge name independently of a custom target folder,
  and prefer the exact mapped destination when folders share a name.
- Clarify the resulting series name for new merged downloads, validate name
  drafts, and lock library merge inputs while the job is being queued.
- Preserve rename drafts after queue errors and reuse completed downloads when
  retrying a failed merge or Kavita name update.

## v3.0.0

- Split large API, background-job, downloader, recommendation, and frontend
  modules into focused components with documented ownership.
- Share metadata preview/application rules and use one automatic/manual sync
  flow, with transactional match and history updates.
- Validate typed job commands at the queue boundary, keep immutable commands
  separate from execution checkpoints, and preserve legacy history without
  writing during reads.
- Coordinate overlapping series, archive, download, merge, and deletion work;
  make pending ownership cancellable and use unique archive staging files.
- Persist download retry deadlines and explicit lifecycle/error state, recover
  interrupted work, and order progress snapshots by attempt and revision.
- Serialize recommendation changes and share eligibility/replacement policy
  across dismissal, feedback, and undo.
- Bootstrap SQLite from the declared schema and apply numbered transactional
  migrations that preserve existing data and job checkpoints.
- Extract downloader search/selection models and focused UI components; observe
  only relevant download progress and remove unused code.
- Copy shared server contracts before compiling the frontend in Docker.
- Verify 429 server tests, 37 frontend tests, 32 desktop/mobile browser checks,
  and isolated production/Docker startup, archive, SQLite, and restart checks.

Existing installations upgrade their SQLite data automatically. Keep the
existing data directory or Docker volume when updating. Node.js 22.22 or newer
remains required.

## v2.14.0

- Load daily recommendations when the app opens, keep picks stable through
  navigation, downloads, reconnects, metadata updates, and preference changes,
  and persist empty daily sets. Refresh picks remains an explicit action.
- Restore the last Downloader tab when returning from Libraries or other pages,
  while allowing explicit search and download links to choose their own tabs.
- Search Libraries by saved tags as well as series titles and artists. Use
  `tag:` to restrict matches to tags, with cached Kavita metadata and stored
  match tags as a fallback when metadata cannot be read.

## v2.13.0

- Translate the active query on every provider switch, preserving exclusions,
  quoted names, namespace aliases, and shared sorts. Explain unsupported filters
  before searching, restore exact queries on unchanged round trips, and apply
  the same translation to watched-query drafts.
- Align nHentai search with the official API and website: default to English,
  preserve quoted phrases and scoped/range/date filters, scope autocomplete,
  and browse native pages beyond 250 matches while retaining selections.
- Match Hitomi's exclusion, OR, namespace ranking, sort directives, and scoped
  autocomplete while retaining the English default and image-set exclusion.
  Add monthly popularity, published-date, and random sort controls; refresh
  keyword index versions and share concurrent CDN-routing requests.
- Page Hitomi search across the full matching catalog, fetching 25 galleries
  at a time and retaining selections across pages instead of stopping at 1000.
- Keep Watched Inbox and History, and place Dismiss beside each gallery's
  download action. Dismissed galleries remain in History and can return to Inbox.
- Enlarge the watched-query field, share Search's tag/artist autocomplete with
  watched queries, and remove explanatory text from the Watched tab.
- Polish Watched control alignment, saved-query hierarchy, and filter spacing;
  keep removal confirmations open while pending and after failed requests.
- Animate watched-search expansion, review feedback, and saved-list changes;
  preserve keyboard access, autocomplete, and reduced-motion preferences.
- Defer rendering collapsed watch lists and latest finds, poll status less often
  while idle, and batch animation layout measurements.

## v2.12.1

- Update all direct dependencies to current stable releases, including React 19,
  React Router 8, Vite 8, and Hono's Node adapter 2. Require Node.js 22.22 or newer.
- Migrate routing to the consolidated React Router package and resolve shared
  React runtime and type definitions consistently across frontend libraries.
- Generate Brotli/gzip assets at build time and cache content-hashed assets for
  faster loading and repeat visits, while revalidating the frontend shell.
- Return 404 for missing built assets instead of serving the frontend HTML.
- Add HTTP adapter, Tailwind 4 class-merging, and desktop/mobile browser checks
  covering login, navigation, themes, settings drafts, and download streaming.
- Exclude local dependencies, runtime data, downloads, and credentials from
  Docker build contexts. Verify Docker builds, Linux tests, and persisted state
  after container restarts.

## v2.12.0

- Search pipe-separated title variants during metadata matching, including
  Houkai Kazoku | Dysfunctional Family's MangaDex alternate title.
- Stop Discord notifications for manual metadata matches through Apply & Sync;
  preserve job results, warnings, history, and automatic-match notifications.

## v2.11.0

- Preserve remaining Recommended picks and their order after downloads; apply
  updated preferences when picks are explicitly refreshed.
- Make Watched an inbox and persistent discovery history, with saved review
  state, watch/source filters, paginated results, and individual/bulk review.
- Keep watch controls above discoveries and disclose saved-search management.
  Show queued/running/completed/failed check outcomes and link to the job.
- Separate each watch's latest check outcome from its retained finds; report
  failed attempts and refresh discoveries when a check finishes.
- Preserve artist/language metadata without extra gallery requests, keep history
  when a watch is removed, and rename bulk entry to Select galleries.

## v2.10.1

- Only interrupt downloads and merge downloads when duplicate matches are found.
  Incomplete library metadata alone no longer opens a confirmation dialog.

## v2.10.0

### Cross-source duplicate detection

- Show library matches on Search, Recommended, and Watched cards before download.
  Recognize merged chapters by their original titles, ComicInfo source links,
  and preserved gallery IDs in filenames, independently of the renamed series
  or cleared queue history. Exact matches show In library; metadata matches
  offer Review duplicate.
- Review matching Hitomi/nHentai galleries against owned or active downloads and
  local CBZ metadata before single downloads or either merge workflow starts.
- Compare normalized titles and alternate titles with shared artists; distinguish
  known language and page-count differences. Show matching sources, file paths,
  and evidence, with Cancel and a per-gallery Download anyway choice.
- Persist detection metadata independently of download history, reuse fresh
  provider metadata, cache archive reads, and report incomplete local coverage.
  Learn library roots through normal browsing without requiring live Kavita
  requests while downloading.
- Enforce duplicate review at download enqueue and merge execution, including
  concurrent requests, while preserving merge drafts and cancellation ownership.


### ComicInfo editor

- Edit ComicInfo through grouped metadata fields; remove the Raw XML view and
  mode switch while preserving nested metadata and attributes.
- Confirm before discarding unsaved drafts across opened archives; warn before
  leaving the browser page with unsaved edits or an in-flight save request.
- Keep the archive name and Queue save action visible while scrolling. Group
  fields by task, distinguish language name from language code, and show changed
  fields with text as well as color.
- Remove panel subtitles and explanatory field copy; retain labels, save status,
  errors, and discard warnings.
- Increase the editor's height on larger screens while keeping viewport-safe
  margins on phones and shorter displays.
- Distinguish queued saves from completed archive writes with a persistent job
  reference. Preserve edits made while a save request is in flight.

### Libraries motion

- Keep visible series spatially connected through sorting, filtering, and merge
  selection changes. Reveal additions to the selected-series shortlist and draw
  the selection check without adding per-card page-load delays.
- Cancel interrupted transitions, stop motion in hidden tabs, and respect reduced
  motion preferences. Keep cover hover movement limited to precise pointers.

### Downloader motion

- Animate gallery-result and merge-shortlist changes with bounded continuity
  transitions. Reuse the queue motion lifecycle and remove per-card load delays.
- Keep hidden shortlist copies out of animations, cancel interrupted movement,
  honor reduced motion, and reserve cover hover movement for precise pointers.


### Browsing and previews

- Streamline Search, Recommended, Watched, Downloads, and Libraries with more
  consistent actions, selection controls, responsive layouts, and concise copy.
- Share the page-preview viewer between downloaded series and gallery previews.
  Add image loading and retry states, preserve keyboard navigation, and prefetch
  adjacent pages after the current image loads while respecting data-saving
  connections.
- Cache library filtering and sorting, use indexed queue lookups, and reduce
  unnecessary card updates during download polling.
- Animate sidebar navigation and settings tabs, respecting reduced motion and
  keeping mobile navigation focus accessible.

### Upgrading

Update and rebuild with your existing data volume and library mounts. For Docker,
run `docker compose up -d --build`. Existing settings, metadata, and download
history remain. Open Libraries once to refresh known library folders; local
archive metadata is indexed when checking gallery ownership and duplicates.

## v2.9.0

### Downloader and selection

- Keep selected galleries in a shared shortlist with cover thumbnails, titles,
  individual removal, and clear-all actions. Keep merge actions within reach on
  mobile without covering focused content.
- Make library selection explicit with checkboxes, selected-card styling, and
  a removable list of selected series.

### Merge into an existing series

- Review incoming galleries and existing chapter numbers in one dialog. Keep
  chapter edits as drafts until Queue merge; support positive decimal chapter
  numbers and flag conflicting numbers without rejecting untouched legacy data.
- Include missing gallery downloads in the merge job, use CBZ output regardless
  of the normal download format, and reuse available archives or active downloads.
- Wait for all galleries before moving archives or applying existing chapter
  edits. Defer merge-owned download scans until the final series is ready.
- Preserve download checkpoints across job retries, update download history when
  archives move, and keep independently started downloads separate from merge
  cancellation. Reject invalid download plans before queueing work.

### Upgrading

Update and rebuild with your existing data volume and library mounts. For Docker,
run `docker compose up -d --build`. The merge-download ownership column is added
automatically; existing settings and download history remain.

## v2.8.0

### Libraries

- Open existing matches directly in field-by-field review. Add a review queue
  position, Skip to next, and Apply & next without bypassing field selection.
- Keep comparison actions and selected-field counts visible while scrolling.
  Disclose library actions and mobile sorting/merge selection; place page
  previews to the right of the artist and remove the Identify series label.
- Remove the leading context-menu divider, including for series without artists.
- Show failure reasons, distinguish empty libraries from filtered results, and
  report unmatched and failed counts separately. Preserve browsing position
  when closing metadata review.
- Remove alignment status, its API fields, computations, and stored flag.
  Upgrade existing databases without removing matches or explicit approvals.
- Add left/right click navigation to Libraries and Downloader page previews.
  Keep arrow keys and page controls, and stop at the first and last page.

### Recommendations

- Replenish cached candidates when artist/work diversity or provider exclusions
  leave too few usable picks, before falling back to previously shown galleries.
- Exclude visible galleries from popular reserves so dismissals can replace
  every displayed pick without repeating cards or performing new searches.

### Jobs

- Enlarge cover thumbnails in the activity list and detail drawer, and adapt
  action wrapping for narrower screens.
- Simplify Libraries and Downloader pagination by removing the jump input.

### Upgrading

Update and rebuild with your existing data volume and library mounts. For Docker,
run `docker compose up -d --build`. The retired alignment column is removed
automatically; saved matches, explicit approvals, settings, and history remain.

## v2.7.0

### Jobs

- Reduce activity rows to a cover, target, action and timing, status, and Details.
  Remove repeated explanations and result summaries; show brief batch outcomes
  and failure guidance only when they add useful information.
- Add Kavita cover thumbnails to job rows and the detail drawer, with batch
  counts and fallbacks for unavailable covers. Keep images stable during polling.
- Move recorded results, affected series, timing, logs, technical data, and
  individual history cleanup into Details. Keep retry and cancel available in
  the list; open logs automatically for failed jobs.
- Consolidate status counts into one filter and disclose the job-type filter.
  Search still includes affected series names, outcomes, and errors.
- Preserve series and library names in job history, including bulk targets and
  targets renamed or deleted by a job. Recover older explicit targets from local
  history when available; identify unknown names clearly.
- Include completed and cancelled jobs in Finished. Flag completed batches with
  failed items as needing attention and announce status changes to assistive
  technology.

### Settings

- Add field-specific validation and instructions for connection URLs, account
  credentials, folder mappings, schedules, and download performance settings.
- Mark tabs containing unsaved changes and show save feedback beside section
  actions. Preserve settings drafts during tab changes.
- Clarify that provider connection tests use saved credentials, prevent tests
  while changes are unsaved, and explain connection failures and recovery.
- Keep download destination and format prominent; move performance controls
  and the optional nHentai API key into Advanced.

### Motion and Downloader

- Smooth mobile navigation opening and closing, keep closed navigation inert,
  and restore keyboard focus to the menu button after closing.
- Add toast exit motion and pause countdowns while hovered, focused, or the
  browser tab is hidden.
- Use short page transitions, smooth selection indicators and progress updates,
  and show indeterminate progress when item counts are unknown.
- Add download queue continuity and selection feedback, with reduced-motion
  alternatives and paused animations in hidden navigation or browser tabs.
- Remove the dark overlay when hovering over Downloader covers.

### Reliability

- Honor cancellation during ComicInfo chapter verification, allow deferred Kavita
  scans to run before retrying, and fail verification timeouts instead of reporting
  success over stale chapter numbers.
- Preserve Kavita's series name during chapter-only ComicInfo edits and report
  chapter lookup errors instead of repeatedly rescanning an unavailable series.
- Report conflicting Kavita chapter entries for a renumbered archive instead of
  repeatedly scanning or reporting success based on the first matching entry.
- Fix Windows development startup hanging under `concurrently` by using Node's
  native file watcher with the `tsx` loader for the API server.

### Upgrading

Update the source checkout and rebuild your deployment. For Docker installations,
run `docker compose up -d --build` with your existing data volume and library mounts.

## v2.6.0

### Libraries and metadata review

- Default library sorting to **Date added**, newest first, while retaining the
  other sorting choices and session persistence.
- Route metadata updates through field-by-field review. Show current metadata
  loading and retry states before enabling Apply & Sync, and preserve the
  selected provider, result position and focus when returning to matches.
- Simplify Identify to one current-match summary and one Review changes action.
  Remove its history section and duplicate auto-match messages; keep manual URL
  matching and provider diagnostics behind disclosures.
- Clarify metadata groups on mobile and show queued, running, completed or failed
  library jobs with a direct link to Jobs. Prevent repeat clicks while queuing.
- Restructure the series card action menu into groups — view pages, find more by
  the same artist on Hitomi.la or nHentai, manage the series (ComicInfo.xml and
  matching), and destructive actions. Dividers separate the groups and
  **Delete files** now carries the danger color.

### Downloader

- Show the download destination and output format before queuing. Offer
  **Set output folder** when setup is missing; block unconfigured downloads in
  both the interface and API. Merged downloads require configured CBZ output.
- Preserve each source's exact search, unfinished input and sort when switching
  providers, including existing session caches. Stop silently translating or
  dropping search filters.
- Place gallery metadata directly below its title and keep tags expanded.
  Preserve the desktop preview/details split, with a visible mobile Download
  footer. Align Close and Download with the save path where space allows.
- Consolidate recommendation feedback into one control, including gallery
  dismissal and Undo, so download status stays readable. Remove redundant help
  copy from the feedback dialog.
- Explain common download failures with recovery steps and optional technical
  details. Add independent retries for gallery details and preview pages.

### Repository maintenance

- Add durable product and design documentation. Exclude local Impeccable state,
  caches, critique reports and QA previews from version control, and remove
  completed temporary QA artifacts.

### Upgrading

Update the source checkout and rebuild your deployment. For Docker installations,
run `docker compose up -d --build` with your existing data volume and library mounts.

## v2.5.0

### Watched searches

- Suppress watched-search notifications for results whose upload date is older
  than fourteen days. Provider index hiccups (e.g. hitomi.la serving a
  mid-rebuild search window) can push old galleries back into the result list;
  those are now remembered as seen without pinging Discord or the Recently
  added feed. Results without an upload date are unaffected, and each
  suppression is logged with the watch's query.
- Discord notification counts include only eligible new galleries, matching
  the listed results and the Recently added feed.

### Interface

- Show the running app version under the H-Tosho brand in the sidebar and
  mobile header. The server serves its own package version, so the label
  always matches the deployment.
- Libraries page: sort the series list by **Date added** (newest first) in
  addition to the default A–Z order. The date is Kavita's series creation
  date; series without one sort last. The choice persists for the session.

### Documentation

- Rewrite the README around installation, first setup, library management,
  downloading, and troubleshooting, with desktop and mobile screenshots using
  real manga cover art and credited sources.

### Upgrading

Update the source checkout and rebuild your deployment. For Docker installations,
run `docker compose up -d --build` with your existing data volume and library mounts.

## v2.4.0

### Recommendation controls

- Move Recommendation feedback into a compact **Feedback** button beside
  **Refresh picks**, with saved likes and artist mutes in a dialog.
- Remove gallery snoozing from the interface and API. Existing saved snoozes
  no longer hide galleries; saved likes and artist mutes remain intact.
- Explain that **More like this** favors a gallery's artists and tags after
  refreshing picks, while **Mute** immediately hides recommendations listing
  that artist until unmuted.
- Remove automatic Kavita library ownership scans, the **Check library** bar,
  library-match labels, and download blocking based on Kavita ownership.
- Use thumbs down to dismiss galleries manually, with persistent dismissals
  and Undo. Selected libraries still inform recommendation preferences, and
  H-Tosho still tracks its own completed downloads and prevents queue duplicates.

### Focus appearance

- Merge the focused field border and outline into one visible indicator,
  fixing the double outline on the sign-in screen.

### Upgrading

Update the source checkout and rebuild your deployment. For Docker installations,
run `docker compose up -d --build` with your existing data volume and library mounts.

## v2.3.0

### Appearance and interaction

- Refine the familiar layout with softer corners, subtle shadows, clearer focus
  states, and larger page headings while retaining the Sakura pink and plum themes.
- Add hover and press feedback to buttons and selection controls, sliding tab
  indicators, and smooth content transitions in Settings, Downloader, and Libraries.
- Respect reduced-motion preferences, including when they change during an animation.
- Keep Settings forms mounted across tab changes so unsaved drafts remain intact.

### Library switching

- Update only the series content when switching libraries, keeping the header,
  library controls, search focus, and filters in place.
- Preserve each library's pagination and cached results, including when navigating
  Back and Forward. Clear selected series and close the merge dialog on library changes.

### Upgrading

Update the source checkout and rebuild your deployment. For Docker installations,
run `docker compose up -d --build` with your existing data volume and library mounts.

## v2.2.0

### Sakura branding and appearance

- Use the Sakura Torii Under a Glowing Moon artwork as the app icon in the
  desktop sidebar, mobile header, sign-in screen, browser tab, and touch icon.
- Refresh both light and dark themes with sakura pink accents, blush surfaces,
  and plum neutrals, including buttons, navigation, focus outlines, and loading
  placeholders. Main text and button labels retain at least 4.5:1 contrast.
- Version icon URLs so browsers refresh cached artwork after upgrading.

### Upgrading

Update the source checkout and rebuild your deployment. For Docker installations,
run `docker compose up -d --build` with your existing data volume and library mounts.

## v2.1.3

### Page-count pills

- Display page counts as compact pills such as `24p`, matching Recommended,
  across library cards and watched items, including on mobile.
- Place library pills at the bottom-right of covers to keep the action menu clear.
- Share the pill component across library, search, recommended, and watched views,
  with full page-count labels for accessibility and tooltips.

## v2.1.2

### Library and watched items

- Display page counts on library cards, watched gallery feed cards, and expanded
  watched search results when available.
- Preserve provider page counts when saving new watched results. Existing
  databases gain the page-count column automatically on startup; entries without
  saved counts remain readable and omit the count.

## v2.1.1

### Downloads

- Fix re-downloads and retries on Windows when replacing an existing CBZ archive
  or gallery image. Existing output is moved aside during publishing and restored
  if the replacement cannot be completed.

## v2.1.0

H-Tosho 2.1 adds actionable job failures, library-aware duplicate detection,
and persistent recommendation feedback.

### Jobs and recovery

- Explain recognized failures and link directly to the relevant series, title
  editor, library folder mappings, Kavita connection, or provider settings.
- Support series and settings deep links, including on mobile.
- Clear individual failed jobs or all failed jobs with confirmation. Clearing
  removes job history and logs without changing media or retrying work.

### Library-aware duplicate detection

- Check all Kavita libraries for ownership, independently of recommendation
  library selections and the sampled taste profile.
- Match recognized provider links and gallery IDs embedded in folder names.
  Use metadata only when title, artist set, page count, and language all agree;
  similar titles alone do not count as duplicates.
- Hide owned galleries from recommendations, show library links on owned search
  results and gallery details, and block duplicate downloads on the server.
- Add ownership-check progress, connection warnings, and a manual Check library
  action. Complete results are cached for ten minutes and invalidated after
  relevant changes. When configured Kavita checks are incomplete, new downloads
  wait for a successful ownership check; downloads without Kavita remain supported.

### Recommendation feedback

- Add More like this to influence the next refreshed picks without marking a
  gallery owned.
- Mute individual artists or snooze a gallery for seven or thirty days.
- Persist feedback across reloads and provide controls to undo preferences,
  unmute artists, and end snoozes early. Snoozes expire automatically.
- Apply mutes and snoozes to fresh picks, cached cards, replacements, and history.

### Validation and upgrading

The server regression suite passes all 289 tests. Production builds and desktop
and mobile browser checks also pass.

Back up your app data, update the source checkout, and rebuild your deployment.
For Docker installations, run `docker compose up -d --build`. Keep your existing
data volume and library mounts; no manual database migration is required.

## v2.0.0

H-Tosho 2.0 brings a streamlined blue/navy interface, better recommendations,
safer downloads, and clearer activity and settings workflows.

### Interface

- Refresh dark and light themes with coordinated blue accents, cool surfaces,
  consistent controls, and improved keyboard focus and mobile layouts.
- Simplify Libraries to a tile-only view with artist names, a compact toolbar,
  and selection controls alongside filters. Hide empty review counts and remove
  redundant management, selection, and helper controls.
- Simplify Recommended cards and their toolbar: remove source badges, tags, and
  recommendation-reason text; use an icon-only dismiss action and a full-width
  download action beside it. Choose contributing libraries directly in the toolbar.

### Recommendations

- Improve ranking with common-tag downweighting and softer tag/series diversity
  penalties, while preventing repeated artists and reliably identified editions.
- Separate dismissed galleries from ownership, support Undo, and retain downloaded
  ownership after queue history is cleared.
- Apply current exclusions to fresh picks, cached cards, replacements, and history.
- Reuse bounded candidate pools and sample Kavita libraries evenly, updating
  recommendation signals after metadata changes.

### Downloads, jobs, and settings

- Stage downloads before publishing so cancellation preserves existing output
  and failed CBZ replacements leave the previous archive intact. Cancellation is
  unavailable once publishing begins.
- Synchronize deleted download entries and cleared completed history across clients.
- Improve Jobs with status filters, progress and result details, filterable logs,
  retry/cancel actions, and sidebar activity shortcuts.
- Preserve settings drafts in memory and offer Save & leave, Discard, or Stay
  when navigating away. Sensitive draft values are not persisted to browser storage.

### Upgrading

Back up your app data, update the source checkout, and rebuild your deployment.
For Docker installations, run `docker compose up -d --build`. Keep your existing
data volume and library mounts; database additions are applied on startup.

Custom API clients should replace `POST /api/recommendations/owned` with
`POST /api/recommendations/dismiss` for recommendation feedback. Undo is available
through `POST /api/recommendations/undo-dismiss`. Existing owned-gallery records
remain owned; dismissing a gallery no longer changes ownership.
