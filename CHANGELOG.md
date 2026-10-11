# Changelog

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
