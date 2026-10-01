# Changelog

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
