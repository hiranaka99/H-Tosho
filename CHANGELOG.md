# Changelog

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
