# H-Tosho

A modern metadata fetcher & manager for **Kavita**. H-Tosho automatically or
manually fetches, aggregates, and syncs rich metadata and
cover art from multiple manga/novel providers directly into a Kavita media
server instance.

The Kavita integration supports **Kavita server v0.9.x or newer** and uses Auth
Keys through the `x-api-key` header. The DTOs are generated from the official
**v0.9.0.22 OpenAPI contract** — note that this is the API *contract* version,
which is distinct from the Kavita *server* build number (e.g. `0.9.0.2`).

## Features

- **Kavita-exclusive** — talks only to Kavita's REST API. No Komga-style
  abstraction layer.
- **Extensible provider engine** — a unified `MetadataProvider` interface plus
  a registry makes adding/removing metadata sources trivial.
- **Field-level aggregation** — blend fields across providers (e.g. summary
  from MangaUpdates, tags from AniList, cover from MangaDex) with per-field
  sourcing overrides.
- **Priority-driven matching** — fuzzy, normalization-aware title matching
  evaluated in configurable provider order, with library-level overrides.
- **Modern dark-mode dashboard** — live job monitoring, side-by-side metadata
  diff, and drag-and-drop provider prioritization.
- **Discord + Apprise notifications** — push formatted updates (with cover
  art) when items are matched/updated.

## Supported providers

| Provider | API | Notes |
| --- | --- | --- |
| AniList | GraphQL | Primary source for manga & light novels |
| MangaUpdates | HTML | No official API; tolerant HTML parser |
| MangaDex | REST | No credentials required |
| MyAnimeList | REST | Requires Client ID |
| Bangumi | REST | Optional Chinese/Japanese metadata source |

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

## Configuration

1. In Kavita, open **User Settings → Manage Auth Keys** and create an Auth Key
   for an admin account. H-Tosho needs admin access because Kavita protects
   metadata and cover updates with its admin policy.
2. Open **Settings → Kavita connection**, enter the Kavita server root (for
   example `http://kavita:5000`, without `/api`) and the Auth Key, then click
   **Save & test connection**.
3. Optionally add provider credentials (e.g. MyAnimeList Client ID) and test
   each provider.
4. Reorder provider priorities (drag-and-drop) and configure aggregation and
   per-field sourcing.
5. In **Libraries**, trigger matching or the scan for newly ingested series;
   monitor progress in **Jobs**.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | API/server port |
| `HOST` | `0.0.0.0` | Bind address |
| `HTOSHO_DATA_DIR` | `server/data` | SQLite data directory |

## Project layout

```
server/src/
  app.ts              # Hono app: API + static SPA serving
  index.ts            # Entrypoint: DB init, job queue, polling, HTTP server
  db/                 # Drizzle schema + SQLite bootstrap
  kavita/             # Kavita REST client (auth, libraries, metadata push)
  providers/          # Provider interface, base class, 5 providers, registry
  matching/           # Normalization + fuzzy matching engine
  services/           # Settings, aggregation/apply, notifications
  jobs/               # Queue + job executor
  routes/             # REST API routes
web/src/
  components/         # UI primitives + identification modal
  pages/              # Dashboard, Libraries, Jobs, Settings
  lib/                # API client + utils
Dockerfile
docker-compose.yml
```

## Adding a new provider

1. Create `server/src/providers/<id>.ts` extending `BaseProvider`.
2. Implement `id`, `name`, `color`, `supportedTypes`, `requiresCredentials`,
   `providesFields`, `baseUrl`, `search()`, and `getSeriesMetadata()`.
3. Export a singleton and register it in `server/src/providers/registry.ts`.