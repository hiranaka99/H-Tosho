# H-Tosho

**Better titles, descriptions, tags, and covers for your Kavita library.**

H-Tosho matches your manga and light novels against AniList, MangaDex, and
MyAnimeList, shows you what would change, and applies only what you approve. It
also finds and downloads doujinshi into your library.

Works with Kavita v0.9 or newer · Current version: **v4.4.0** ·
[Changelog](CHANGELOG.md)

![H-Tosho Libraries page showing five sample series with generated covers and their match status](docs/screenshots/libraries.png)

## Features

- **Fix metadata with a preview.** Compare your current metadata with a
  provider's, choose the fields to change, and apply.
- **Keep new series matched.** New additions are matched automatically, and
  uncertain matches wait for your review.
- **Protect and undo.** Lock fields you edited by hand, and restore earlier
  metadata or covers from history.
- **Hear about changes.** A weekly check flags new volumes, status changes, or
  covers on series you've matched.
- **Discover and download doujinshi.** Search Hitomi.la, nHentai, and your own
  E-Hentai/ExHentai account, and save galleries as CBZ files straight into your
  library.
- **Follow artists and searches.** Saved searches collect new releases, with
  optional Discord notifications.
- **Recommendations and duplicate checks.** Get daily picks based on your
  library, and a warning before you download something you already own.
- **Edit files.** Edit ComicInfo.xml inside CBZ files and merge related series.

The [user guide](docs/guide.md) covers every feature in detail.

## Install

### Docker (recommended)

```bash
mkdir h-tosho && cd h-tosho
curl -fsSLO https://raw.githubusercontent.com/hiranaka99/H-Tosho/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:8787**, or your server's address on port 8787. Your
data is kept in the `h-tosho-data` volume.

The prebuilt image is for linux/amd64. On ARM, clone the repository, uncomment
`build: .` in `docker-compose.yml`, and run `docker compose up -d --build`.

### Without Docker

Requires Node.js 26.13.1 or newer.

```bash
git clone https://github.com/hiranaka99/H-Tosho.git
cd H-Tosho
npm install
npm start
```

H-Tosho listens on `127.0.0.1:8787` and keeps its data in `server/data`. See
[Configuration](#configuration) to change either.

## Getting started

1. **Create your account** on the first visit.
2. **Connect Kavita.** In Kavita, create an Auth Key for an admin account under
   **User Settings → Manage Auth Keys**. In H-Tosho, enter your Kavita address
   (without `/api`) and the key under **Settings → General → Kavita connection**.
   In Docker, use an address the container can reach, such as
   `http://kavita:5000`. `localhost` there means the H-Tosho container itself.
3. **Choose your metadata sources** under **Settings → Providers**. AniList and
   MangaDex work without an account; MyAnimeList needs a Client ID.
4. **Open Libraries**, click a series, review the proposed changes, and choose
   **Apply & Sync**.

### Library folders

Matching only needs the Kavita connection. To download into your library,
edit CBZ files, or merge series, H-Tosho also needs write access to the folders
Kavita uses. Mount them in `docker-compose.yml`:

```yaml
volumes:
  - h-tosho-data:/data
  - /srv/books/manga:/mnt/manga
  - /srv/books/doujinshi:/mnt/downloads
```

Then, under **Settings → General → Kavita library folders**, map each Kavita
folder to where H-Tosho sees it (for example `/media/Manga` → `/mnt/manga`).
For downloads, set **Settings → Downloader → Output folder** to a folder that a
Kavita library watches, such as `/mnt/downloads` here.

If you'd rather keep app data and downloads in plain folders than in a Docker
volume, use [`docker-compose.example.yml`](docker-compose.example.yml) instead.

## Configuration

Everything else is set in the app. These optional environment variables cover
the rest:

| Variable                         | Default                                      | Purpose                                                                                            |
| -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PORT`                           | `8787`                                       | Port to listen on.                                                                                 |
| `HOST`                           | `127.0.0.1` (`0.0.0.0` in the Compose files) | Address to listen on. Use `0.0.0.0` to reach H-Tosho from other devices.                           |
| `HTOSHO_DATA_DIR`                | `server/data` (`/data` in the Compose files) | Where the database and app data are stored.                                                        |
| `HTOSHO_COVER_HISTORY_LIMIT_MIB` | off                                          | Keep original covers so they can be restored later. Set a storage budget from `10` to `16384` MiB. |
| `NHENTAI_API_KEY`                | none                                         | nHentai API key for higher rate limits. A key saved in Settings takes precedence.                  |
| `HTOSHO_GITHUB_TOKEN`            | none                                         | GitHub token for update checks, if you hit GitHub's rate limit.                                    |
| `HTOSHO_UPDATE_CHECK_DISABLED`   | off                                          | Set to `1` to turn off automatic update checks.                                                    |

## Updating

H-Tosho checks for new releases and can update itself under
**Settings → Account → App updates**. When a release needs a new Docker image,
it tells you; then run:

```bash
docker compose pull && docker compose up -d
```

To back up, stop H-Tosho and copy its data volume or folder. Never run
`docker compose down -v`: it deletes your data.

## Troubleshooting

| Problem                            | What to try                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Kavita won't connect               | Check the address and the admin Auth Key. In Docker, the address must be reachable from H-Tosho.         |
| A title or CBZ file doesn't change | Check the library folder mappings and write permissions, then open the job in **Tasks**.                 |
| A download failed                  | See **Downloads → Needs attention**. Check the output folder; an nHentai API key helps with rate limits. |
| A followed search finds nothing    | The first check is silent by design. Use **Check now** to run it again.                                  |

Every scan, match, edit, and download is logged in **Tasks**, with the error
when something fails.

Found a bug? [Open an issue](https://github.com/hiranaka99/H-Tosho/issues).
Report security problems privately as described in [SECURITY.md](SECURITY.md).
Want to help? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

H-Tosho is self-hosted software. It does not host, mirror, or distribute any
content; it only connects to the services you configure. Some supported sources
contain adult material. Use H-Tosho only where you are of legal age and where
that content is lawful. You are responsible for following each site's terms of
service and the copyright laws that apply to you.

H-Tosho is an independent project and is not affiliated with Kavita, AniList,
MangaDex, MyAnimeList, E-Hentai, nHentai, or Hitomi.la.

## License

H-Tosho is released under the [MIT License](LICENSE).
