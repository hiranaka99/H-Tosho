# H-Tosho

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People managing their own self-hosted Kavita manga and light-novel libraries.
Metadata cleanup and gallery discovery/downloads are both core jobs, as
confirmed by the project owner during initialization.

## Product Purpose

Help users identify series, improve titles, descriptions, tags, and covers,
and keep new library additions organized. Also help users discover and download
doujinshi, tune recommendations, and follow saved searches for new releases.

Success means users can maintain useful library metadata, understand proposed
changes before applying them, and find and track galleries through the same app.

## Positioning

H-Tosho is a companion to Kavita. Its existing mechanism connects external
metadata sources to a user's library, presents current and proposed metadata
for field-by-field review, and applies selected changes through background jobs.
Gallery discovery, downloads, recommendations, and watched searches complement
this library-management workflow. No competitive superiority claim is established.

## Operating Context

- Users run their own installation through Docker Compose or Node.js and sign
  in with an account belonging to that installation.
- Kavita connection setup uses a server address and an admin Auth Key. Container
  installations need an address reachable from inside the container.
- Desktop and mobile browsers access the same web application. The main areas
  are Home, Libraries, Discover, Tasks, and Settings.
- Typical library workflow: choose a library and series, identify a candidate,
  compare metadata, choose fields to update, and use Apply & Sync. Tasks exposes
  progress and warnings; uncertain automatic matches appear in Needs review.
- Typical discovery workflow: search or browse recommendations, preview a
  gallery, download selected results, and track progress. Watched searches
  collect new finds for users to review and choose to download.

## Capabilities and Constraints

The owner confirmed four durable requirements: preserve Kavita integration,
review before applying metadata, local data persistence, and desktop/mobile web
support. No additional product-specific requirements were requested.

Existing capabilities and implementation facts are documented in README.md
and the repository:

- Metadata providers are AniList, MangaDex, and MyAnimeList; provider credentials
  and availability depend on the chosen source. The README targets Kavita
  v0.9.x or newer; verify compatibility when changing the integration.
- Users can choose which proposed metadata fields to apply and supply a
  provider URL when a suggested match is wrong.
- Matching dialogs can browse AniList, MangaDex, or MyAnimeList works by artist name or
  supported artist URL, prefill saved artist names, and send a selected work
  through the existing metadata comparison before Apply & Sync.
- Automatic matching, a review queue, ComicInfo.xml editing, and series merging
  support ongoing library maintenance.
- Gallery sources are Hitomi.la, nHentai, and E-Hentai/ExHentai. E-Hentai/ExHentai
  needs the user's own account, saved in Settings → Downloader; its cookies are
  encrypted at rest and never sent to the browser. Unified search runs one query
  across all three sources, groups repeated editions into one entry listing every
  real source, and shows per-source status so one failing source leaves the others
  visible. Downloads support CBZ archives or image folders, queue controls, and
  duplicate prevention.
- Users can protect selected metadata fields from provider sync. Metadata history
  records provider updates, unmatch, ComicInfo edits, merges, and restores, and
  supports previewed, selective restores (including archive fields) that users
  review before queuing; Tasks reports the verified result. Cover history is
  opt-in, with a configurable storage limit, and supports reviewed cover restores.
  Restores never silently overwrite: protected fields need an explicit unlock, and
  partial or interrupted outcomes require fresh review rather than blind retry.
- Following (watched searches) supports names, folders, pause/resume, and
  inherited or custom check cadence. Notifications are direct, deduplicated
  Discord sends or in-app finds only.
- Tasks is both a progress view and a review surface: it opens on Needs attention
  when something needs it, explains failures in plain language with the next step,
  and asks for inline confirmation before stopping a task.
- Completed downloads in a shared Kavita library are imported in background jobs
  and checked for metadata candidates to review on Home before applying changes.
- Recommendation feedback, muted artists, dismissed galleries, watched
  searches, and optional Discord notifications are existing features.
- File edits, title changes written into CBZ metadata, merges, and downloads
  require appropriate filesystem access. Docker library-folder mappings must
  identify the same files Kavita uses.
- Accounts, settings, and history persist in local app storage or the configured
  Docker data volume. Future changes must preserve this persistence.
- The existing stack is a React/TypeScript/Vite frontend with Tailwind CSS and
  a Node.js/Hono backend using SQLite. This is an established codebase.
- For development, run `npm run dev` from the repository root. Vite serves the
  web app on port 5173 and proxies API/media requests to the backend on port 8787. The web app entry is `web/index.html`.

These implementation details describe the current app rather than a promise
that provider behavior, ports, or dependency versions will never change.

## Brand Commitments

The existing product name is H-Tosho. The app uses
`web/public/h-tosho-icon.png` as its brand mark. Existing interface copy is in
English and uses task-oriented terms such as Libraries, Needs review,
Apply & Sync, Discover, For you, Following, Tasks, and Settings.

No additional binding voice or brand requirements were established during init.

## Evidence on Hand

- `README.md`: product capabilities, installation, setup, workflows, and help.
- `CHANGELOG.md`: recorded release changes.
- `web/src/App.tsx` and `web/src/pages/`: implemented navigation and workflows.
- `server/src/`: integration, metadata, matching, download, persistence, and job
  behavior.
- `docs/screenshots/libraries.png`, `metadata-preview.png`, and
  `libraries-mobile.png`: screenshots of the actual interface rendered with
  fictional sample series and generated covers (`npm run screenshots`).
- `docs/screenshots/README.md`: identifies series, artists, covers, counts,
  confidence scores, connection state, and metadata as fictional sample data.

No customer testimonials, adoption figures, or performance benchmarks were
established in this initialization. Do not present sample data as measured proof.

## Product Principles

1. Treat metadata management and gallery discovery/downloads as core workflows.
2. Keep proposed metadata changes understandable and selectable before applying
   them; make uncertain automatic results available for review.
3. Preserve the connection between Kavita records and the files users manage.
4. Preserve local accounts, settings, history, and saved preferences across
   normal restarts and updates.
5. Keep core workflows usable in desktop and mobile browsers.

## Accessibility & Inclusion

Desktop and mobile web support is confirmed. The implementation already
includes keyboard focus handling, labeled controls, reduced-motion support,
and light/dark/system theme selection. Preserve these existing capabilities
when refining the interface. No additional user-specific accessibility needs
or formal conformance standard were established during initialization.
