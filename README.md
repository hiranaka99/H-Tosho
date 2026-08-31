# H-Tosho

A metadata manager for **Kavita** that keeps your manga, light novel and
doujinshi libraries clean — and helps you find what to read next.

H-Tosho matches your Kavita series against popular metadata sources (AniList,
MangaDex, MyAnimeList) and pushes the best title, description, tags, cover art
and more straight into Kavita. It can also search **Hitomi.la** and **nHentai**,
download galleries into your libraries, watch for new releases, and suggest
fresh picks based on what you already own.

Works with **Kavita server v0.9.x or newer**.

## What it does

- **One-click identification** — browse any Kavita library, pick a series, and
  H-Tosho finds the best match across your providers. Preview exactly what will
  change in a side-by-side diff, then apply everything or deselect individual
  fields (title, description, tags, cover, …).
- **Automatic matching** — new series added to Kavita are matched on a schedule
  you control. Matches below 80% confidence are flagged with a badge so you can
  review them in Libraries instead of being pushed blindly.
- **Doujinshi downloader** — search Hitomi.la and nHentai by keyword, tag or
  artist, preview galleries, and download them as `.cbz` archives or image
  folders. The queue supports pause, resume, cancel and retry, detects
  duplicates, and can trigger a Kavita scan when finished so new media appears
  in your server automatically.
- **Daily recommendations** — a fresh set of twelve picks every day, based on
  the tags, artists and series in your downloaded library and your Kavita
  collection. Refresh to re-roll, or mark a pick as owned so it never comes up
  again.
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
- **Live job monitor** — every match, scan, merge and ComicInfo edit runs as a
  background job you can watch, cancel or retry from the Jobs page.

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

## Touring the app

- **Libraries** — browse every Kavita library and its series with match status,
  confidence scores and cover art. Identify or re-identify any series (the
  identify dialog also shows each series' match history), review low-confidence
  matches (the badge in the sidebar counts them), edit a series' ComicInfo
  files, and merge selected series.
- **Downloader** — four tabs:
  - *Search* — find galleries on Hitomi.la or nHentai, sort by newest or
    popularity, preview page counts, and download single galleries or a whole
    selection (optionally merged into one series).
  - *Recommended* — Today's twelve picks with one-click refresh and an "owned"
    button. You can choose which Kavita libraries feed the recommendations in
    this tab's settings row.
  - *Watched* — manage your watched searches, their check schedule, and browse
    the "Recently added" feed of new finds.
  - *Manager* — the live download queue: progress, pause/resume/cancel/retry,
    duplicate badges, and completed history.
- **Jobs** — every background task (scans, matching, merges, ComicInfo edits,
  watched-search checks) with status, logs, cancel and retry.
- **Settings** — Kavita connection, auto-scan interval, appearance (light /
  dark / system theme), account security, providers, notifications and the
  downloader.

## Security notes

- The app listens on `127.0.0.1` only by default — nothing is reachable from
  your network unless you deliberately change that (set `HOST=0.0.0.0` for
  Docker or remote access).
- Everything behind the login gate: the web interface and all data endpoints.
  The login session lasts 30 days; sign out from the sidebar at any time.
