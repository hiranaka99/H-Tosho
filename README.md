# H-Tosho

A modern metadata fetcher & manager for **Kavita**. H-Tosho automatically or
manually fetches and syncs rich metadata and cover art from multiple
manga/novel providers directly into a Kavita media server instance — and can
download doujinshi galleries from Hitomi.la and nHentai straight into your
libraries.

The Kavita integration supports **Kavita server v0.9.x or newer** and uses Auth
Keys through the `x-api-key` header. The DTOs are generated from the official
**v0.9.0.22 OpenAPI contract** — note that this is the API *contract* version,
which is distinct from the Kavita *server* build number (e.g. `0.9.0.2`).

## Features

- **Kavita-exclusive** — talks only to Kavita's REST API. No Komga-style
  abstraction layer.
- **Extensible provider engine** — a unified `MetadataProvider` interface plus
  a registry makes adding/removing metadata sources trivial.
- **Priority-driven matching** — fuzzy, normalization-aware title matching
  evaluated in configurable provider order (global plus per-library overrides);
  the first confident match wins.
- **Per-field control** — preview exactly what will be pushed as a side-by-side
  diff and deselect individual fields before applying a match.
- **Doujinshi downloader** — search Hitomi.la & nHentai, download galleries as
  `.cbz` archives or image folders through a live queue with pause/resume/
  cancel/retry, and optionally trigger a Kavita library scan on completion.
- **Watched searches** — save doujinshi queries to re-run on every auto-scan
  cycle; new results ping Discord.
- **Daily recommendations** — picks a fresh selection of galleries from Hitomi.la & nHentai based on the tags and artists in your downloaded library; stable within a day, manually refreshable for a different selection.
- **Modern dark-mode dashboard** — Libraries, Downloader, Jobs and Settings
  pages with live job monitoring and drag-and-drop provider prioritization.
- **Discord notifications** — push formatted updates (with cover art) when
  items are matched/updated or watched searches find new galleries.

## Supported providers

| Provider | API | Notes |
| --- | --- | --- |
| AniList | GraphQL | Primary source for manga & light novels |
| MangaDex | REST | No credentials required |
| MyAnimeList | REST | Requires Client ID |

Doujinshi sources: **Hitomi.la** and **nHentai** (optional API key).

## Tech stack

- **Frontend**: Vite + React + TypeScript, Tailwind CSS 4, TanStack Query,
  Radix UI primitives, Lucide icons.
- **Backend**: Hono on Node.js (TypeScript), native `fetch`.
- **Storage**: SQLite via Drizzle ORM using the `better-sqlite3` driver.
- **Deployment**: Multi-stage Dockerfile + `docker-compose.yml`.

## Getting started (local dev)

Requires Node.js ≥ 20.

```bash
npm install
npm run dev
```

This starts the API server on http://localhost:8787 and the Vite dev server on
http://localhost:5173 (the dev server proxies `/api` to the backend).

## Building

```bash
npm run build
```

Builds the frontend into `web/dist` and the backend into `server/dist`.

## Running production

The server serves the built frontend from `web/dist` and the API under `/api`,
so a single process is all you need:

```bash
npm run build
node server/dist/index.js
```

Then open http://localhost:8787.

### Docker

```bash
docker compose up -d --build
```

This exposes port `8787` and persists the SQLite database in the
`h-tosho-data` volume.

To keep state and downloaded galleries on the host instead of in named
volumes, use the bind-mount example:

```bash
docker compose -f docker-compose.example.yml up -d --build
```

It mounts `./data` for the SQLite database and `./downloads` as
`/mnt/downloads`. Set the download directory in **Settings → Downloader** to
`/mnt/downloads`, and point your Kavita library at the host's `./downloads`.

## Configuration

1. In Kavita, open **User Settings → Manage Auth Keys** and create an Auth Key
   for an admin account. H-Tosho needs admin access because Kavita protects
   metadata and cover updates with its admin policy.
2. Open **Settings → General → Kavita connection**, enter the Kavita server
   root (for example `http://kavita:5000`, without `/api`) and the Auth Key,
   then click **Save & test connection**.
3. In **Settings → Providers**, add provider credentials (e.g. MyAnimeList
   Client ID), test each provider, and drag to reorder the search priority.
4. Tune per-library behavior in **Libraries** (auto-match toggle and clearing
   overrides); deselect individual fields in the identify dialog when applying a match.
5. In **Settings → Notifications**, configure and test the Discord webhook.
6. Optional: in **Settings → Downloader**, set the output folder, format,
   concurrency limits, nHentai API key and banned tags; add watched searches
   from the Downloader page or the same tab.
7. In **Libraries**, trigger matching or the scan for newly ingested series;
   monitor progress in **Jobs**.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | API/server port |
| `HOST` | `127.0.0.1` | Bind address — local-only by default; the API has no auth, so set `0.0.0.0` only if you accept LAN exposure |
| `HTOSHO_DATA_DIR` | `server/data` | SQLite data directory |
| `NHENTAI_API_KEY` | *(unset)* | Optional nHentai API key fallback; a key set in Settings takes precedence |

## Project layout

```
server/src/
  app.ts              # Hono app: API + static SPA serving, CORS, token auth
  index.ts            # Entrypoint: DB init, job queue, polling, HTTP server
  db/                 # Drizzle schema + SQLite bootstrap
  kavita/             # Kavita REST client (auth, libraries, metadata push)
  providers/          # Provider interface, base class, 3 providers, registry
  match/              # Normalization, fuzzy matching
  downloader/         # Hitomi/nHentai sources, download engine, .cbz writer
  services/           # Settings, sync/apply, watched searches, series artists
  notify/             # Discord notification dispatcher
  jobs/               # Queue + job executor
  routes/             # REST API routes + media proxy (cover Referer handling)
web/src/
  components/         # UI primitives, identification modal, sidebar status
  pages/              # Libraries, Downloader, Jobs, Settings
  lib/                # API client, download events context, utils
Dockerfile
docker-compose.yml
```

## Adding a new provider

1. Create `server/src/providers/<id>.ts` extending `BaseProvider`.
2. Implement `id`, `name`, `color`, `supportedTypes`, `requiresCredentials`,
   `providesFields`, `baseUrl`, `search()`, and `getSeriesMetadata()`.
3. Export a singleton and register it in `server/src/providers/registry.ts`.

Doujinshi sources follow the same pattern: implement the `DoujinProvider`
interface in `server/src/downloader/` and register it in
`downloader/providers.ts`.
