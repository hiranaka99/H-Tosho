# H-Tosho

**Give your Kavita library better titles, descriptions, tags, and covers.**

H-Tosho helps you identify manga and light novels, review metadata before applying
it, and keep new additions organized. It also includes a doujinshi downloader,
recommendations, and watched searches for new releases.

Works with **Kavita v0.9.x or newer**. Current version: **v2.11.0** ·
[Release notes](CHANGELOG.md)

![H-Tosho Libraries showing real covers for Spy x Family, Chainsaw Man, Demon Slayer, Dandadan, and Kaiju No. 8](docs/screenshots/libraries.png)

*The actual interface with a sample library. Covers are from the official VIZ
shop; counts, match results, and metadata are example data.
[Screenshot details and cover credits](docs/screenshots/README.md).*

[Install](#install) · [First setup](#first-setup) ·
[Use your library](#use-your-library) · [Discover and download](#discover-and-download) ·
[Help](#help)

## What you can do

- **Clean up your library.** Find a series through AniList, MangaDex, or
  MyAnimeList, compare it with your current Kavita metadata, and choose what to
  update.
- **Keep new series organized.** Enable automatic matching and review uncertain
  results in **Needs review**.
- **Discover and download doujinshi.** Search Hitomi.la or nHentai, preview
  galleries, and save them as CBZ files or image folders.
- **Follow artists and searches.** Save a query and see new finds in
  **Recently added**, with optional Discord notifications.
- **Get recommendations you can tune.** Ask for more like a gallery, mute an
  artist, or dismiss a pick you do not want.
- **Review possible duplicate downloads.** Compare galleries across Hitomi and
  nHentai with owned downloads and local CBZ metadata before downloading.
- **Fix files and organize series.** Edit ComicInfo.xml inside CBZ files and
  merge related series.

## Install

### Docker

Install Docker with Docker Compose, then download or clone this repository:

```bash
git clone https://github.com/hiranaka99/H-Tosho.git
cd H-Tosho
docker compose up -d --build
```

Open **http://localhost:8787**. If Docker runs on another machine, use that
machine's address with port `8787`.

Your account, settings, and history are saved in the `h-tosho-data` volume.
Keep this volume when updating or recreating the container.

If you want to download galleries or edit existing CBZ files, also set up the
[library folders](#make-your-library-folders-accessible) below.

### Without Docker

Install **Node.js 22 or newer**, download or clone the repository, and run these
commands from its folder:

```bash
npm install
npm start
```

Open **http://localhost:8787**. App data is saved in `server/data` by default;
`HTOSHO_DATA_DIR` lets you choose another location.

## First setup

1. **Create your H-Tosho account.** Choose a username and a password of at least
   eight characters. You will use this account to sign in to this installation.
2. **Connect Kavita.** Create an Auth Key for a Kavita admin account under
   **User Settings → Manage Auth Keys**. In H-Tosho, open
   **Settings → General → Kavita connection**, enter your Kavita address
   without `/api` and the Auth Key, then choose **Save & test connection**.
   The sidebar shows the connection status.
3. **Choose your metadata sources.** Open **Settings → Providers**. AniList and
   MangaDex work without credentials. MyAnimeList needs a Client ID. Enable the
   sources you want and arrange their search order.
4. **Open Libraries.** Select a library and click a series to identify it.

For Docker, the Kavita address must be reachable **from the H-Tosho container**.
Use a hostname such as `http://kavita:5000` when both containers share a Docker
network, or your Kavita server's network address. `localhost` inside the
H-Tosho container refers to H-Tosho itself.

### Make your library folders accessible

Metadata matching uses your Kavita connection. Renaming series through their
CBZ metadata, editing ComicInfo.xml, and moving or merging files also need
access to the library folders with write permission.

For Docker, add your folders to the `volumes` list in `docker-compose.yml`:

```yaml
volumes:
  - h-tosho-data:/data
  - /srv/books/manga:/mnt/manga
  - /srv/books/doujinshi:/mnt/downloads
```

Replace the paths on the left with folders on your Docker host. Restart with
`docker compose up -d`, then open
**Settings → General → Kavita library folders**. Map each Kavita folder to the
same folder as H-Tosho sees it:

| Folder shown by Kavita | Folder available to H-Tosho |
| --- | --- |
| `/media/Manga` | `/mnt/manga` |
| `/media/Doujinshi` | `/mnt/downloads` |

Choose **Save folders**. Leave a mapping empty if Kavita's path is already
accessible from H-Tosho. Map every root you need when a library has several
folders.

For new downloads, set **Settings → Downloader → Output folder** to
`/mnt/downloads` and make sure Kavita also has a library pointed at that shared
folder. Enable **Auto-sync Kavita** to request a scan after downloads finish.

Prefer app data and downloads in local folders? The included
[bind-mount example](docker-compose.example.yml) uses `./data` and `./downloads`:

```bash
docker compose -f docker-compose.example.yml up -d --build
```

With this example, use `/mnt/downloads` as H-Tosho's output folder.

## Use your library

### Identify a series and review the changes

1. Open **Libraries**, choose a library, and click a series cover or title to
   identify it or review metadata. **Preview pages**, to the right of the artist,
   opens the book separately.
   In library and Downloader previews, click the right half of the page to go
   forward or the left half to go back. Arrow keys and page controls also work.
2. Existing matches open directly in the comparison. Use **Back to matches**
   to select another candidate.
3. Uncheck any fields you want to keep, and choose a title if alternatives are
   offered.
4. Choose **Apply & Sync**. H-Tosho applies your selection in the background;
   **Jobs** shows its progress and any warnings.

![Dark-theme metadata preview for Spy x Family, showing current and proposed fields, cover art, and Apply & Sync](docs/screenshots/metadata-preview.png)

*Review the title, description, creators, tags, and cover before applying them.
This preview uses sample metadata and real cover art.*

If the suggested match is wrong, paste the series' AniList, MangaDex, or
MyAnimeList URL under **Use a provider URL** and choose **Load**.
Provider search diagnostics are expandable below the matches. Sync progress
and warnings are available in **Jobs**.
Use **Back to matches** to compare another candidate; your provider filter and
list position are preserved. Applying stays disabled until both current and
proposed metadata are available. Failed requests offer a retry.
The comparison footer keeps the selected-field count and apply action visible
while you scroll. A match records identification, not whether metadata is up to
date; the retired alignment status is no longer calculated or stored.

Applied series and volume covers are locked in Kavita so later scans keep them.
Changing a title also updates the Series field in the series' CBZ files, so
configure your library folders before renaming.

### Match new additions automatically

Open **Library actions** to turn on **Auto-match new series** for the libraries
you want to monitor, refresh from Kavita, or **Match all unmatched**.
Set the check frequency under **Settings → General → Auto-scan interval**.
Refresh and matching actions show when they are queuing, then display library
job progress on the page, including on mobile. Choose **View job** for details.

Unconfirmed matches below 80% confidence appear in **Needs review**. Choose
**Start review** to work through the filtered queue. **Apply & next** queues the
selected changes and opens the next series; **Skip to next** leaves it unchanged.
The queue position stays visible, and closing returns you to the library list.

Libraries defaults to **Sort · Date added**, showing the newest series first.
Your selected sort order is remembered for the current browser session.

### Check for duplicate galleries

Search, Recommended, and Watched cards check the local library before download.
Merged chapters keep their own identity even when their series is renamed:
ComicInfo source links and gallery IDs in filenames show **In library**, while
title/artist matches offer **Review duplicate**. Clearing download history does
not remove these matches.

Downloads and merge downloads compare normalized titles (including alternate
source titles), artists, language, and page counts. Matching copies appear in
**Possible duplicates** with their source and file location. Choose **Cancel**
to keep your current selection or **Download anyway** to continue with the
selected gallery. Same-source galleries already owned or queued retain their
existing duplicate guard.

Local checks read ComicInfo metadata from CBZ files in the output folder, mapped
library folders, and library paths learned when you open Libraries. You do not
need Kavita to be online during a download. Archive metadata is cached and
rechecked periodically; unreadable folders and archives without title/artist
metadata are reported as incomplete coverage.
Incomplete coverage alone does not interrupt downloads; duplicate matches still
require review before proceeding.

These are metadata matches, not image comparisons. Known differences in language
or page count stay separate; missing metadata, unrelated source title variants,
and archives without usable ComicInfo may prevent a match. Detection metadata
persists independently of cleared download history.

### Edit metadata or merge series

Open a series card's **⋮** menu and choose **Edit ComicInfo.xml** to edit its
CBZ metadata through grouped fields. Saving preserves nested metadata and
attributes. Language name and language code are separate metadata fields.

Use **Change archive** to switch files without losing their unsaved drafts.
Closing with unsaved edits asks before discarding them. **Queue save** submits a
background write; follow the displayed job reference to check completion. The
archive name and save action remain visible while scrolling.

To combine related series, choose **Select to merge**, select the ones to combine,
and use the merge action. On phones, sorting and selection are under
**Sort & merge**. H-Tosho needs writable access to their files.

<details>
<summary>See the mobile interface</summary>

<p>The same library tools are available on a phone, with navigation in the menu.</p>
<img src="docs/screenshots/libraries-mobile.png" alt="H-Tosho mobile library view with Chainsaw Man and Dandadan covers" width="360">

</details>

## Discover and download

Open **Downloader** to access four tabs:

| Tab | What to do here |
| --- | --- |
| **Search** | Search Hitomi.la or nHentai by keyword, tag, artist, or gallery ID. Preview a result, then download it or select several. |
| **Recommended** | Browse up to twelve picks, select the Kavita libraries that inform your preferences, and use **Refresh picks** for another set. |
| **Watched** | Manage saved searches and browse new finds in **Recently added**. |
| **Downloads** | Track progress, pause or resume downloads, retry failures, and view completed downloads. |

Before downloading, open **Settings → Downloader** and choose your output
folder and format. **CBZ** puts each gallery in an archive; **Folder** saves its
images in a directory. You can also set download concurrency, excluded tags,
and an optional nHentai API key. The Downloader shows the current folder and
format, and offers **Set output folder** before you can queue your first download.

Each source remembers its own search, unfinished input, and sort order. Switching
sources restores that source's search without translating or dropping filters.

H-Tosho prevents duplicate queued downloads and remembers galleries downloaded
through the app. To remove unwanted recommendations, open a card's **Tune
recommendations** menu and choose **Don’t recommend this gallery**. Use **Undo**
to restore a dismissed gallery.

### Tune your recommendations

Use a card's **Tune recommendations** menu to choose **More like this**, dismiss
the gallery, or mute an artist. More like this influences the next refresh; a mute immediately hides
recommendations featuring that artist, including collaborations.

The **Feedback** button beside **Refresh picks** lets you undo saved preferences
or unmute artists. Use thumbs down to dismiss a single gallery, and
**Dismissed galleries** to undo dismissals. These choices survive restarts.

### Watch for new releases

Run a search, then choose **Watch** to save that query. Under **Watched**, choose
how often to check it or use **Check now** to check manually.

Watch controls stay above the feed. **Manage watches** opens saved searches and
the add form. Check progress and outcomes remain visible, with a link to the job.

The first check records the existing results quietly. Later checks add new
finds to **Inbox** and send Discord messages if notifications are
enabled. Results with a known upload date older than fourteen days are skipped
to keep old galleries from being announced as new. Results without a usable
upload date are still eligible.

Watches find galleries for you; choose the ones you want to download from the
feed. Filter discoveries by watch or source. **Mark reviewed** removes a find
from Inbox while keeping it in **History**; **Return to inbox** reverses that
choice. Review state is saved across sessions and shared by watches that found
the same gallery. Stopping a watch keeps its discoveries in History.

Artist and language are saved from search results when available. Older finds
gain that context when later checks return metadata for them. **Select galleries**
supports downloading together, merging, and marking selected finds reviewed.

### Enable Discord notifications

Open **Settings → Notifications**, enable Discord, paste your channel's webhook
URL, save, and send a test message. Notifications include metadata updates and
new watched-search results.

## Help

| Problem | What to check |
| --- | --- |
| **Kavita will not connect** | Test the connection in Settings. Check the server address and admin Auth Key. In Docker, use an address reachable from the container. |
| **A title will not change, or a CBZ cannot be edited** | Check write permissions and **Kavita library folders**. The mapped path must point to the same files Kavita uses. Open the job for the specific warning. |
| **The cover has not updated** | Wait for **Apply & Sync** to finish. Check **Jobs** for cover-upload errors, then refresh the library. |
| **A download failed** | Open **Downloads → Needs attention** for the error. Check the output folder and source settings, then retry. An nHentai API key can help with rate limits. |
| **A watch has no new results** | Its first check is silent. Check the saved query and interval, or use **Check now**. Old uploads are suppressed when their date is known. |

**Jobs** contains the results and logs for scans, matches, merges, edits, and
watched-search checks. Failed jobs offer retry and, where available, a link to
the relevant setting. Clearing failed-job history removes its logs, not library
files.

### Update and back up

For a Git checkout running in Docker:

```bash
git pull
docker compose up -d --build
```

If you use the bind-mount example, include `-f docker-compose.example.yml` in
the Compose command. For a source installation, stop the app, update the
checkout, run `npm install`, and restart with `npm start`.

Back up your app data and library folders. Stop H-Tosho before copying its data
folder or Docker volume for a consistent backup. Keep the existing data volume
when upgrading; do not use `docker compose down -v` unless you intend to erase
the saved app data.

### Access from another device

The included Docker configuration exposes port `8787` on the host. A source
installation listens on `127.0.0.1` by default; set `HOST=0.0.0.0` when you want
to reach it over your network. Sign in with your H-Tosho account on each device.

Found a problem? [Open an issue](https://github.com/hiranaka99/H-Tosho/issues)
with your H-Tosho version, what you expected, and the relevant job error. Remove
passwords, Auth Keys, and webhook URLs from anything you share.
