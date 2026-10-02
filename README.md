# H-Tosho

A metadata manager for **Kavita** that keeps your manga, light novel and
doujinshi libraries clean — and helps you find what to read next.

H-Tosho matches your Kavita series against popular metadata sources (AniList,
MangaDex, MyAnimeList) and pushes the best title, description, tags, cover art
and more straight into Kavita. It can also search **Hitomi.la** and **nHentai**,
download galleries into your libraries, watch for new releases, and suggest
fresh picks based on what you already own.

Works with **Kavita server v0.9.x or newer**.

Current release: **v2.1.0**. See [release notes](CHANGELOG.md).

## What it does

- **One-click identification** — browse any Kavita library, pick a series, and
  H-Tosho finds the best match across your providers. Preview exactly what will
  change in a side-by-side diff, then apply everything or deselect individual
  fields (title, description, tags, cover, …). Applied series and volume covers
  are locked in Kavita so later library scans cannot replace them.
- **Automatic matching** — new series added to Kavita are matched on a schedule
  you control. Automatic matches below 80% confidence are flagged for review.
  Applying a candidate confirms it and clears the review badge, while retaining
  the original confidence score.
- **Doujinshi downloader** — search Hitomi.la and nHentai by keyword, tag or
  artist, preview galleries, and download them as `.cbz` archives or image
  folders. The queue supports pause, resume, cancel and retry, detects
  duplicates, and can trigger a Kavita scan when finished so new media appears
  in your server automatically.
  Downloads are staged before publishing: cancellation preserves existing files,
  and failed CBZ replacements leave the previous archive intact. Cancellation is
  unavailable once the output commit begins. Deleting history or clearing completed
  downloads updates other connected clients without reloading.
- **Daily recommendations** — up to twelve picks ranked from completed downloads
  and Kavita libraries. Common tags are downweighted; tag/series overlap receives
  a soft diversity penalty, while artists and reliably identified language editions
  do not repeat within a set. Popular picks fill thin personalized pools; older
  picks return only after fresh options run out. “Don't recommend this gallery
  again” dismisses that gallery without marking it owned, with an Undo control.
  Downloaded ownership survives clearing queue history. Current bans apply to fresh
  picks, cached cards, replacements and recycled history; automatic searches never
  override bans. Recommendations load only when their tab opens, and refreshes
  reuse a bounded 30-minute candidate pool while fresh candidates remain. Kavita
  signals are sampled across libraries and updated incrementally after metadata edits.
- **Watched searches** — save any doujinshi query and H-Tosho re-checks it on a
  schedule (every 5 minutes to every 24 hours). New galleries land in the
  "Recently added" feed and ping your Discord channel.
- **Merging tools** — download several galleries into one folder so they become
  a single Kavita series, move already-downloaded galleries into an existing
  series (with chapter numbers), or merge two existing series together.
- **ComicInfo editor** — edit the `ComicInfo.xml` inside any of your `.cbz`
  files directly from the Libraries page: fix titles, authors, tags and more,
  with a raw XML mode for full control.
- **Discord notifications** — get formatted messages (with cover art) when
  series are matched or updated, and when watched searches find something new.
- **Activity & Jobs** — every match, scan, merge and ComicInfo edit runs as a
  background job. The Jobs page leads with clickable Active / Needs attention /
  Completed counts, orders running work first, and opens a detail drawer (a
  full-screen sheet on mobile) with the target, timing, progress, readable
  results and warnings, retry and cancel, and filterable logs with a
  follow-latest toggle that never yanks your scroll position. Sidebar counts for
  active jobs, failed jobs and failed downloads link straight to the matching
  filtered view.
- **Safe settings** — unsaved changes show per-section status and are kept while
  you move around the app (in memory only; secrets are never written to browser
  storage). Leaving Settings or closing the tab with unsaved changes offers
  Save & leave, Discard or Stay.

## Metadata sources

| Source | Notes |
| --- | --- |
| AniList | Primary source for manga & light novels — no setup needed |
| MangaDex | No credentials required |
| MyAnimeList | Requires a Client ID (free to create) |

Doujinshi sources: **Hitomi.la** and **nHentai**. nHentai accepts an optional
API key for higher rate limits (Settings → Downloader).

## Getting started

### Docker (recommended)

```bash
docker compose up -d --build
```

Then open http://localhost:8787. Your data (settings, match history, download
queue) is stored in the `h-tosho-data` volume and survives restarts.

To keep everything as plain folders on your machine instead, use the bind-mount
example:

```bash
docker compose -f docker-compose.example.yml up -d --build
```

It stores the app data in `./data` and exposes `./downloads` inside the
container at `/mnt/downloads`. In **Settings → Downloader**, set the output
folder to `/mnt/downloads`, and point a Kavita library at your host's
`./downloads` folder.

To edit CBZ files in several existing libraries, mount each library into
H-Tosho with write access. For example, alongside your current Doujin mount:

```yaml
volumes:
  - h-tosho-data:/data
  - /mnt/NAS/Doujins:/mnt/downloads
  - /mnt/NAS/Manga:/mnt/manga
```

In **Settings → General → Kavita library folders**, H-Tosho lists every
Kavita library root. For each root, enter the absolute path to that **same
folder as seen by H-Tosho** (for example `/media/Manga` in Kavita maps to
`/mnt/manga` in H-Tosho), then click **Save folders**. A library may have
multiple roots; configure each one you need to edit. Use **Add another folder**
for a nested mount or a root Kavita does not list. Leave a folder empty when
Kavita's path is already accessible from H-Tosho. Settings → Downloader →
Output folder still controls new downloads only. These mappings also let the
ComicInfo browser and series merges find existing CBZ files.

When a title cannot be changed, the job shows **Done with warnings**, records
the reason in its log and match history, and labels the Discord notification
**Synced with warnings**. Other selected metadata and covers can still sync.

### Run from source

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

This builds the app and starts it on http://localhost:8787 — one process serves
both the web interface and the API.

## First run

1. **Create your account** — on first launch you'll be asked to set a username
   and password (minimum 8 characters). This protects the app; every visit
   after that signs in with it. Change it anytime in Settings → General →
   Account security.
2. **Connect Kavita** — in Kavita, open **User Settings → Manage Auth Keys**
   and create an Auth Key for an admin account (H-Tosho needs admin rights to
   update metadata and covers). Then in H-Tosho go to **Settings → General →
   Kavita connection**, enter the server address (e.g. `http://kavita:5000`,
   without `/api`) and the Auth Key, and click **Save & test connection**. A
   green "Kavita connected" indicator in the sidebar confirms it works.
   In **Settings → General → Kavita library folders**, set each library's
   H-Tosho path when its Kavita path is not directly accessible (mount the
   library with write access first to edit CBZ files).
3. **Pick your providers** — Settings → Providers. Add a MyAnimeList Client ID
   if you want that source, test each one, and drag them into your preferred
   search order.
4. **Set up downloading (optional)** — Settings → Downloader: choose the output
   folder (point it at a Kavita library folder to auto-pick up new media), the
   format (`.cbz` recommended), how many downloads can run at once, an optional
   nHentai API key, and tags to always skip. Toggle **Auto-sync Kavita** to scan
   your server after each download.
5. **Notifications (optional)** — Settings → Notifications: paste a Discord
   webhook URL, choose what to be notified about, and send a test message.

From here, open **Libraries**, pick a library, and start identifying series —
or head to the **Downloader** to search for new galleries.

**Apply & Sync** queues a background job. The Libraries page continues showing
Kavita's current cover until the job finishes and Kavita reports the new one;
check **Jobs** for cover-upload errors if it does not change.

## Touring the app

- **Libraries** — browse every Kavita library and its series with match status,
  confidence scores and cover art. Identify or re-identify any series (the
  identify dialog also shows each series' match history), review uncertain
  matches (the sidebar badge opens Needs review across all libraries), edit a series' ComicInfo
  files, and merge selected series.
- **Downloader** — four tabs:
  - *Search* — find galleries on Hitomi.la or nHentai, sort by newest or
    popularity, preview page counts, and download single galleries or a whole
    selection (optionally merged into one series).
  - *Recommended* — Up to twelve personalized, popular, or least-recently-shown
    picks with one-click refresh and a thumbs-down button to dismiss a gallery
    without marking it owned, with Undo and a cached replacement when available.
    You can choose which Kavita libraries feed the recommendation profile.
    Use the card's **Tune recommendations** menu for More like this, artist muting,
    or a 7-/30-day snooze. The **Recommendation feedback** section lets you undo
    preferences, unmute artists, or end snoozes, including after a reload.
  - *Watched* — manage your watched searches, their check schedule, and browse
    the "Recently added" feed of new finds.
  - *Downloads* — the live download queue: progress, pause/resume/cancel/retry,
    a separate Needs attention section for failures, and completed history.
- **Jobs** — every background task (scans, matching, merges, ComicInfo edits,
  watched-search checks) with status, logs, cancel and retry.
  Known failures link to the relevant folder mappings, connection settings, or
  series/title editor. Failed jobs can be cleared individually or in bulk, with
  confirmation; this removes their history and logs, not library files.
- **Settings** — Kavita connection, auto-scan interval, appearance (light /
  dark / system theme), account security, providers, notifications and the
  downloader.

## Library ownership checks

Search results identify galleries already in Kavita and link to the matching
series. Downloads are checked on the server using provider metadata, and owned
galleries are excluded from every recommendation path, including cached cards.
Ownership checks use **all** Kavita libraries, even libraries excluded from your
recommendation taste profile.

Provider links in Kavita metadata and explicit `[hitomi-ID]` / `[nhentai-ID]`
folder identifiers establish gallery identity. Without those, H-Tosho requires
matching title, artist set, page count, and language; a similar title alone is
never enough. Galleries lacking that information may not be recognized.

The ownership index is cached for ten minutes and invalidated after library
jobs or connection changes. The first scan can take time for large libraries;
**Check library** refreshes the index manually and reports scan progress or
connection problems. When a configured Kavita connection cannot be fully checked,
new downloads wait for you to resolve the connection rather than silently bypass
duplicate protection. Downloading without a configured Kavita connection still works.

More like this adds a preference vote without marking a gallery owned. It affects
the next refresh. Artist mutes and snoozes apply immediately; snoozes expire
automatically, and all three types of feedback survive app restarts.

## Security notes

- The app listens on `127.0.0.1` only by default — nothing is reachable from
  your network unless you deliberately change that (set `HOST=0.0.0.0` for
  Docker or remote access).
- Everything behind the login gate: the web interface and all data endpoints.
  The login session lasts 30 days; sign out from the sidebar at any time.
