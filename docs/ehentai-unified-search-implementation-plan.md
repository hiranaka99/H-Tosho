# E-Hentai / ExHentai provider and unified search implementation plan

Status: implementation specification; no application code has been changed by this plan.

Implement two increments in this order:

1. Add E-Hentai / ExHentai as a gallery download provider, including an account configurable from H-Tosho Settings.
2. Add unified search across Hitomi.la, nHentai, and the E-Hentai / ExHentai provider, in a separate **Unified search** tab immediately after **Search** inside Discover.

This document is an execution guide for an AI coding agent. Repository observations below describe the inspected code, not proposed interfaces. Sections marked **Proposed** define the implementation to build. Re-read affected files before editing; existing work and migration numbers may have changed.

## Mandatory UI workflow: Impeccable

**The implementing agent MUST use the Impeccable skill for all UI work in this plan.** This includes UI planning, implementation, accessibility, and polish for Settings, Discover, Unified search, gallery cards/details, and shared components.

- Read `skill://impeccable` before starting UI work and follow its setup/context-loading instructions for the existing `web` application.
- Follow the skill's applicable planning/design guidance; preserve the existing product context and `web/DESIGN.md` rather than introducing a second visual convention.
- Read the skill's `reference/craft-floor.md` immediately before any UI edit, and apply its requirements throughout implementation.
- Verify the actual rendered UI in a browser at desktop/mobile sizes and in light/dark themes, including keyboard/focus behavior and the states required below. Source inspection or screenshots of unrelated surfaces do not replace this verification.

## 1. Required outcomes and chosen defaults

| Requirement                       | Implementation decision                                                                                                                                                    | Completion evidence                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Download E-Hentai galleries       | Register logical source `ehentai`; support public E-Hentai browsing and the existing download queue/output formats.                                                        | Search, preview, and publish a complete gallery through the real queue.                                                 |
| Download ExHentai galleries       | The same logical provider has an explicit E-Hentai / ExHentai site setting. ExHentai requires a valid account session and verified access.                                 | An authorized account can preview/download an ExHentai gallery; an unauthorized session cannot be mistaken for success. |
| Configure the account in Settings | Add an E-Hentai / ExHentai account card under **Settings → Downloader**, separate from metadata-provider credentials.                                                      | Save, test, replace, remove, reload, and server-restart scenarios work without returning stored secrets to the browser. |
| Search all three providers        | Fan out one committed query to Hitomi.la, nHentai, and the selected E-Hentai-family site.                                                                                  | A real backend aggregation request returns results from three deterministic provider fixtures.                          |
| Display duplicates once           | Deduplicate within a unified search session, including subsequent pages; retain every known provider variant behind one entry.                                             | Repeated/provider-overlapping results produce one card, including duplicates encountered on later pages.                |
| Make the source visible           | Every unified card displays its primary provider and all known alternate providers. Use **E-Hentai** or **ExHentai** for the actual origin, not an ambiguous family label. | Source labels remain visible on desktop/mobile and agree with the gallery opened/downloaded.                            |
| Preserve existing Search          | Add **Unified search** beside **Search**; do not replace Search or turn `unified` into a download provider.                                                                | Both tabs retain separate drafts, committed queries, results, navigation state, and functional actions.                 |

### Scope interpretation

- There are **three logical download providers**, not four: `hitomi`, `nhentai`, and `ehentai`. E-Hentai and ExHentai are two access sites within the third provider. Shared gallery identities must not create duplicate downloads merely because the hostname differs.
- Default the new site setting to **E-Hentai**. Public E-Hentai use must not require an ExHentai account. Selecting ExHentai is explicit; never silently substitute public E-Hentai when ExHentai access fails.
- Configure the existing account by importing its authenticated session cookies. The Settings form accepts `ipb_member_id`, `ipb_pass_hash`, and an ExHentai `igneous` value when required by the session. This satisfies account configuration without storing the account password or automating a fragile forum login/CAPTCHA flow. Username/password login automation is not part of these increments.
- Preserve the installed visual system, single-provider native search, CBZ/image-folder output, merge protection, duplicate review, queue lifecycle, and Kavita post-download discovery.
- Do not add E-Hentai as an AniList/MangaDex/MyAnimeList metadata provider. Do not redesign Discover, add torrents, purchase archives, spend GP/credits, or create automatic cross-provider saved searches.
- Existing single-provider Following should accept the new registered source where its normal workflow exposes it. Do not expand the intentionally Hitomi-focused recommendation selection/feedback policy as a side effect.

## 2. Repository map: use these integration points

Paths are relative to the repository root. Links point to existing files; proposed files are listed separately.

| Area                     | Existing files / symbols                                                                                                                                                                                                                                                                                       | Consequence for the implementation                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gallery contracts        | [`server/src/downloader/types.ts`](../server/src/downloader/types.ts): `DoujinSource`, `DoujinSearchResult`, `DoujinGallery`, `DoujinProvider`                                                                                                                                                                 | This is the gallery-provider system. `DoujinSource` currently contains only `hitomi` and `nhentai`; gallery IDs are strings.                                                                                                         |
| Provider registry        | [`server/src/downloader/providers.ts`](../server/src/downloader/providers.ts): `doujinProviders`, `getDoujinProvider`, `listDoujinProviders`                                                                                                                                                                   | Register the new provider here, not in `server/src/providers/`.                                                                                                                                                                      |
| Provider examples        | [`server/src/downloader/hitomi.ts`](../server/src/downloader/hitomi.ts), [`server/src/downloader/nhentai.ts`](../server/src/downloader/nhentai.ts)                                                                                                                                                             | Reuse normalized metadata, provider exclusions, and bounded request patterns; do not copy an entire provider implementation.                                                                                                         |
| Search/gallery HTTP      | [`server/src/routes/api/doujin.ts`](../server/src/routes/api/doujin.ts)                                                                                                                                                                                                                                        | `/doujin/search` uses numeric offset/limit or a bounded array; `/doujin/gallery` resolves metadata and strips server-only resolver/header fields. Add aggregation and cursor routes without breaking existing consumers.             |
| Download HTTP            | [`server/src/routes/api/downloads.ts`](../server/src/routes/api/downloads.ts): `prepareDownload`, `prepareMergeGroup`                                                                                                                                                                                          | Canonicalization must precede completed/active/owned checks. Resolve authoritative metadata before enqueueing.                                                                                                                       |
| Queue and transfer       | [`server/src/downloader/engine.ts`](../server/src/downloader/engine.ts), [`transfer.ts`](../server/src/downloader/transfer.ts), [`requests.ts`](../server/src/downloader/requests.ts)                                                                                                                          | Use the existing queue, atomic page writes, restart/resume, progress, and packing. Adapt live resolution instead of adding a second downloader.                                                                                      |
| Duplicate identities     | [`server/src/services/galleryDuplicates.ts`](../server/src/services/galleryDuplicates.ts): `resolveDuplicateGallery`, `duplicateReasons`, `recordGalleryIdentity`                                                                                                                                              | Reuse metadata normalization where appropriate. Current duplicate evidence is conservative, not proof of identical bytes; missing language/page count can still produce a review suggestion. Search collapsing needs stricter rules. |
| Filename/metadata        | [`server/src/downloader/util.ts`](../server/src/downloader/util.ts): `galleryFilesystemName`; [`comicinfo.ts`](../server/src/downloader/comicinfo.ts)                                                                                                                                                          | Gallery IDs must be filename-safe. Keep the canonical gallery Web URL and correct reading order in ComicInfo/output.                                                                                                                 |
| Persistent settings      | [`server/src/services/settings.ts`](../server/src/services/settings.ts), [`server/src/routes/api/settings.ts`](../server/src/routes/api/settings.ts)                                                                                                                                                           | Downloader settings use a cached SQLite key/value record. Existing GETs expose their stored values; do **not** put the new session secrets in that public record.                                                                    |
| DB/migrations            | [`server/src/db/schema.ts`](../server/src/db/schema.ts), [`migrations.ts`](../server/src/db/migrations.ts), [`index.ts`](../server/src/db/index.ts)                                                                                                                                                            | `source` and `gallery_id` are text. Storage lives under `DATA_DIR`, configurable by `HTOSHO_DATA_DIR`. Existing-table changes require the next numbered migration.                                                                   |
| Authentication/media     | [`server/src/app.ts`](../server/src/app.ts), [`server/src/routes/media.ts`](../server/src/routes/media.ts)                                                                                                                                                                                                     | `/api/*` and `/media` are authenticated. The existing media proxy permits specific CDNs, validates redirect hosts, and caches by URL. It cannot safely serve authenticated E-Hentai image pages merely by adding a domain.           |
| Client HTTP/types        | [`web/src/lib/api.ts`](../web/src/lib/api.ts)                                                                                                                                                                                                                                                                  | Frontend duplicates the source union and search DTO. It lacks the search-result `url` currently available server-side. Add explicit public account/unified/cursor contracts; never serialize `DoujinGallery` wholesale.              |
| Discover navigation      | [`web/src/pages/Downloader.tsx`](../web/src/pages/Downloader.tsx)                                                                                                                                                                                                                                              | The visible route is Discover, but its component/file is `Downloader`. Tabs are Search, For you, Following, Downloads. Several tab guards and deep links explicitly assume the existing set.                                         |
| Discover state           | [`web/src/pages/downloader/state.ts`](../web/src/pages/downloader/state.ts), [`searchState.ts`](../web/src/pages/downloader/searchState.ts)                                                                                                                                                                    | Session storage restores single-source drafts/query/sort/page. Add a separate unified state object, not another fake source entry in `searches`.                                                                                     |
| Shared gallery UI        | [`GalleryCard.tsx`](../web/src/pages/downloader/GalleryCard.tsx), [`GalleryDetailModal.tsx`](../web/src/pages/downloader/GalleryDetailModal.tsx), [`useGalleryDownload.ts`](../web/src/pages/downloader/useGalleryDownload.ts), [`useGallerySelection.ts`](../web/src/pages/downloader/useGallerySelection.ts) | Cards already display a source badge in full mode and observe tasks by `source:galleryId`. Reuse their actions; adapt grouped entries without passing a group ID to the queue.                                                       |
| Settings UX              | [`web/src/pages/Settings.tsx`](../web/src/pages/Settings.tsx): `DownloaderSettingsCard`                                                                                                                                                                                                                        | Uses `useSettingsDraft`, draft feedback, and unsaved-navigation handling. The account editor must participate in that same lifecycle.                                                                                                |
| Native query translation | [`web/src/lib/searchTranslation.ts`](../web/src/lib/searchTranslation.ts), [`utils.ts`](../web/src/lib/utils.ts): `buildTagSearchFragment`                                                                                                                                                                     | Translation assumes two providers; unknown destinations currently look like nHentai. Add explicit third-provider handling instead of falling through.                                                                                |
| Other source-facing UI   | [`Libraries.tsx`](../web/src/pages/Libraries.tsx), [`Home.tsx`](../web/src/pages/Home.tsx), [`GallerySelectionBar.tsx`](../web/src/components/GallerySelectionBar.tsx), [`DuplicateReview.tsx`](../web/src/components/DuplicateReview.tsx)                                                                     | Fix exhaustive maps, hard-coded source options, and binary source-label ternaries. Preserve these pages' existing jobs/layout.                                                                                                       |
| Commands and UI tests    | [`package.json`](../package.json), [`server/package.json`](../server/package.json), [`web/package.json`](../web/package.json), [`web/playwright.config.ts`](../web/playwright.config.ts), [`web/test/e2e-server.ts`](../web/test/e2e-server.ts)                                                                | Node/tsx tests and Playwright desktop/mobile projects exist. Browser tests use an isolated real app/DB at port 18787; unknown live provider traffic fails closed.                                                                    |

### Important traps already visible in the code

1. `resolvePageCandidates` catches resolver errors and falls back to static URLs. E-Hentai auth/quota/parser failures must propagate, not turn into downloads of an `/s/` HTML page.
2. Transfer derives page names/extensions from URLs, including resumed pages. E-Hentai image-page references do not identify the final image format; persist/derive the real extension for resumed pages.
3. Current gallery preflight caching is keyed by source/input and provider function, not account revision/site. Session changes must invalidate E-Hentai preflight, metadata, media, and unified-search state.
4. Current `/media?u=` is a caller-supplied URL proxy. A broad public-IP or wildcard-host exception here would be an SSRF regression.
5. `galleryDuplicates.ts` only recognizes Hitomi/nHentai Web URLs and numeric filename suffixes. New galleries must remain recognizable after Task history is cleared.
6. Source guards also occur in merge-job payload parsing and Following/recommendation routes. Typechecking alone will not detect every binary ternary or runtime allowlist.
7. `GalleryCard` selection/task identity is a real provider gallery. A deduplicated unified entry is a display group, not a new provider or downloadable gallery ID.

## 3. External constraints and evidence

Use current site behavior as the authority during implementation. These sources were read to prepare the plan; no live authenticated ExHentai session was exercised.

- [EHWiki API](https://ehwiki.org/wiki/API): metadata API is `POST https://api.e-hentai.org/api.php`; `gdata` requires `(gid, token)`; `namespace: 1` preserves tag namespaces; maximum 25 entries per request. The documented API is metadata/token lookup, **not a general gallery search or image-list API**.
- [EHWiki Gallery Searching](https://ehwiki.org/wiki/Gallery_Searching): native operators/namespaces, query limits, default-filter overrides, and navigation by Next/Prev/seek rather than an assumed exact numbered-page total. Searches are documented as at most once per three seconds.
- [EHWiki Galleries](https://ehwiki.org/wiki/Galleries): several list modes, configurable gallery/thumbnail page sizes, and resampled viewer images. Parsers must not assume every user has the default list mode or thumbnail count.
- [EHWiki Technical Issues](https://ehwiki.org/wiki/Technical_Issues): image-view quota, HTTP 509, unavailable galleries, transient outages, and excessive-request bans. HTTP success alone does not prove a usable image/gallery response.
- [EHWiki Downloading](https://ehwiki.org/wiki/Downloading) and [Archives](https://ehwiki.org/wiki/Archives): viewer-image downloads, originals, and archive downloads have different costs/limits. Original-image actions may consume quota/GP; archives may charge GP/credits.
- [gallery-dl example configuration](https://raw.githubusercontent.com/mikf/gallery-dl/master/docs/gallery-dl-example.conf): maintained client configuration demonstrates authenticated-cookie setup using `ipb_member_id`, `ipb_pass_hash`, and `igneous`. This is implementation precedent, not an official guarantee that every account has the same cookie requirements.

Implementation consequences:

- Read search/gallery HTML for listing/page references; batch metadata with the API where the requested site's authorization and actual behavior allow it. Do not assume a public metadata response establishes ExHentai access.
- Before coding the parser, obtain sanitized representative HTML/JSON for successful public/authenticated requests, access-denied responses, zero results, multipage galleries, and image-quota failures. Do not commit credentials, account identifiers, private response dumps, or explicit imagery as fixtures.
- Use an authorized adult user's own access. Do not bypass access restrictions, CAPTCHA, content warnings, or upstream bans. A restricted content-warning response should be a clear actionable state, not automatically accepted.
- Download the image served by the normal viewer. Do not click original-image or paid archive controls automatically, and do not call a resampled viewer image “original quality.”

## 4. Proposed shared contracts and identity rules

### 4.1 One source definition, explicit capabilities

Create a small pure shared contract module, proposed path `server/src/contracts/doujin.ts`, with:

- `DOUJIN_SOURCES = ['hitomi', 'nhentai', 'ehentai']` and its source type/guard.
- Public gallery-origin information and the cursor/unified DTOs specified below.
- Only JSON-safe types and pure validation/normalization; no settings, HTTP, DB, or provider imports.

Migrate the duplicated source unions and their callers to this contract. Use language-server references before changing exported symbols. Do not leave a second union or a compatibility alias behind. Keep server-only provider closures and request headers in the downloader implementation, outside public contracts.

Extend provider-list metadata only where needed: selected site/display name, availability summary, and supported paging/sort capabilities. Source ID stays `ehentai`; the effective display name can be E-Hentai or ExHentai. Do not expose session values or account-derived request headers.

### 4.2 E-Hentai gallery identity

Proposed canonical `galleryId`: `<gid>-<token>`, for example `1234567-abcdef1234`.

- Keep both components as validated strings; the token is indispensable. Accept valid full `/g/<gid>/<token>/` URLs from `e-hentai.org` and `exhentai.org`, plus the canonical internal ID.
- Reject malformed locators, unsupported hosts, userinfo, misleading subdomains, non-HTTPS gallery URLs, control characters, and paths that are not actual gallery locators.
- A bare numeric ID is insufficient to resolve a gallery without its token. In native search it may be handled by a verified `gid:` lookup that recovers the real URL; do not fabricate a token or reuse another provider's numeric ID.
- E-Hentai and ExHentai representations of the same validated `(gid, token)` share a canonical family identity and queue/ownership key. Different gallery revision IDs remain distinct; `parent_gid`/`current_gid` is not permission to replace the requested revision silently.
- Preserve the resolved canonical `url` and an explicit site discriminator (`e-hentai` or `exhentai`) in public gallery/search metadata.

### 4.3 Freeze a queued gallery's site, not its secrets

A result found on ExHentai must not silently start downloading a public-host gallery after Settings changes.

Proposed change: add nullable `source_url` to `download_queue` and optional `sourceUrl` to the appropriate download commands/snapshots.

1. Browser actions send the selected real gallery's `source`, canonical `galleryId`, and canonical `sourceUrl` when available.
2. The server validates that URL's provider and `(gid, token)` agree with the ID, then resolves it with the current authorized session. Treat client-supplied URLs as untrusted.
3. Enqueue stores the **provider-resolved** canonical URL, not a caller-supplied arbitrary target. Existing sources/tasks work with null.
4. The worker resolves `sourceUrl ?? galleryId`; current credentials are obtained server-side per request. No cookie/header snapshot belongs in the queue, job payload, SSE, ComicInfo, or filename.
5. Resume/retry keeps the frozen site/gallery revision. If access is removed, it fails with actionable account guidance rather than switching sites.
6. Carry this optional origin through merged-download commands and their restart/reconstruction paths. Extend the next numbered migration; preserve all existing rows and queue states.

Update duplicate/prepared-gallery cache keys to include canonical origin and E-Hentai account revision, while ownership/completed/active identity remains the shared family ID. This distinguishes request authorization from gallery ownership.

## 5. Increment 1: E-Hentai / ExHentai provider and account configuration

### P1.1 — Build persistent, write-only session configuration

**Proposed files:** `server/src/contracts/ehentai.ts`, `server/src/services/ehentaiAccount.ts`. Add routes to the existing Settings API module.

Keep E-Hentai account storage separate from the ordinary `downloader` JSON returned by GET. Store non-secret site selection/revision and an encrypted session envelope in a dedicated key/value record.

Proposed authenticated routes, under the existing `/api` prefix:

| Route                         | Request                                                             | Response / semantics                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /settings/ehentai`       | None                                                                | Public view: site, revision, configured/has-cookie flags, last-tested access states/time, sanitized guidance. Never stored cookie values.                                 |
| `PUT /settings/ehentai`       | `site`, `expectedRevision`, optional complete `session` replacement | Validate, revision-check, persist, invalidate runtime caches. Omitted session preserves the stored session. Empty fields are not a deletion command.                      |
| `POST /settings/ehentai/test` | Explicit choice of saved session or supplied unsaved draft          | Verify access without downloading gallery images; return separate E-Hentai account and ExHentai access results. Testing a draft does not save it.                         |
| `DELETE /settings/ehentai`    | `expectedRevision`                                                  | Remove the saved account session, reset its access evidence, advance revision, and invalidate account-scoped runtime state. Preserve unrelated Settings/download history. |

Define the JSON contract before implementing the form. Required rules:

- Accept only supported fields and bounded cookie values. Reject CR/LF, NUL, delimiters/header injection, malformed JSON, partial session replacements, and oversized requests. Do not enforce an invented fixed cookie length.
- `ipb_member_id` and `ipb_pass_hash` form an authenticated session pair. `igneous` is optional at the schema level; actual ExHentai validation decides whether the provided session works. Mere presence of `igneous` never means access is verified.
- Return HTTP 400 for invalid local input and 409 for stale revision, not a generic upstream failure. Preserve submitted drafts on failure/conflict.
- GET/save/test responses use `Cache-Control: private, no-store`. Avoid including raw upstream response bodies, cookies, redirect query strings, or request headers in errors/logs.
- Changing ordinary download settings must never overwrite/clear the account session; changing the site alone preserves the session.

**At-rest storage:** no existing credential encryption primitive was found in the inspected backend. Implement a small provider-specific AES-256-GCM envelope using Node crypto, with a random key persisted under `DATA_DIR` in a dedicated restricted file. Create the key only when needed, with exclusive creation and restrictive permissions where supported; handle simultaneous creation by reading the existing valid key. Use a fresh nonce and authentication tag per write. Never derive the key from the account/session or store it in the SQLite record.

- Persist key and encrypted record across Node/Docker restarts. Document backup requirements.
- Missing/corrupt key or failed authentication is an explicit configuration error; never regenerate a key over ciphertext or fall back to plaintext.
- Encryption protects against a database-only disclosure, not compromise of the server or entire data volume. State this limitation honestly.

**Gate:** API settings/draft conflict tests plus a separate-process restart proof show session persistence and zero stored-secret disclosure in HTTP responses.

### P1.2 — Implement access checking and one bounded provider client

**Proposed files:** `server/src/downloader/ehentaiClient.ts`, `ehentaiUrl.ts`, `ehentai.ts`. Keep parsing helpers pure where possible.

Build one server-side E-Hentai-family client used by settings tests, search, metadata, page resolution, previews, and downloads.

- Construct cookie headers only for the exact authorized E-Hentai/ExHentai endpoints. Do not send forum/account cookies to `api.e-hentai.org`, thumbnail/CDN/H@H hosts, or redirects unless live evidence establishes an explicit necessary same-party rule.
- Parse/retain cookies by their real host/path scope; do not concatenate arbitrary browser cookie dumps into a generic request header.
- Validate redirects manually and rebuild headers for each target. Never forward credentials on a cross-host redirect just because the source was allowed.
- Check positive gallery/account markers and the final host/content type. Distinguish not configured, account invalid, E-Hentai authenticated but ExHentai unavailable, ExHentai verified, upstream unavailable, rate/quota limited, content warning, and unexpected parser response.
- ExHentai success requires an actual successful ExHentai gallery/list response plus authenticated access evidence. HTTP 200, metadata API success, a blank page, an access-denial image, or a cookie string is not sufficient.
- Last successful testing is evidence with a timestamp, not permanent authorization. Revalidate on real operations; classify expiration/removal correctly.
- Use a shared abort-aware request gate across both family hosts and all app workflows. Start with conservative HTML request pacing of at least three seconds between request starts and one concurrent HTML/page-resolution request; honor Retry-After/cooldowns. Batch API metadata at no more than 25 IDs and respect its separately documented pacing.
- Apply conservative image-fetch limits across active family downloads, not separately per gallery. Global user settings may reduce load but may not bypass provider safety limits.
- Place finite deadlines/body caps on metadata/HTML operations. Cancel queued and in-flight work on request cancellation or account cutover; never spin on an access denial, quota exhaustion, or ban.

**Gate:** sanitized local responses prove positive access, invalid/expired session, denial disguised as HTTP 200, unexpected HTML, and quota states. No test requires a real account or a quota-consuming live request.

### P1.3 — Implement native search, metadata, and paging

Register `ehentaiProvider` after its basic client works. Implement the existing `getGallery` and bounded `search` methods, plus the cursor seam below.

1. Build native search URLs with URL/URLSearchParams; do not interpolate raw query text into URLs.
2. Parse gallery links/listing continuation from known list modes; do not rely on gallery thumbnails as the only link source.
3. Batch `(gid, token)` metadata through `gdata` with `namespace: 1` when verified for the requested site. Use authenticated gallery/list metadata when the public API cannot satisfy authorized ExHentai metadata. Never silently omit restricted results because public metadata lookup failed.
4. Normalize display title, alternate title when present, origin URL/site, UTC `uploadedAt`, language, tags/namespaces, artists, groups, parodies, characters, category, and page count. Convert API string numbers deliberately; avoid treating unknown counts as zero.
5. Preserve provider tag namespaces, including `female`, `male`, `mixed`, `other`, `artist`, `group`, `parody`, `character`, and `language`.
6. Follow the existing default-language convention: default English for a normal search; an explicit supported language selection overrides that default. Do not copy another provider's query syntax into E-Hentai.
7. Add `ehentaiBannedTags` using the existing downloader banned-tag convention. Apply exclusions before exposing search results, including unified search. Migrate defaults/preserve older stored settings and older ordinary Settings writes that omit this new field.
8. Offer only verified native sort options. Do not present nHentai/Hitomi popularity periods as supported by default.
9. Handle unavailable/expunged/updated galleries without substituting a different revision. Empty search results and a broken parser are different outcomes.

**Proposed paging seam:** introduce a provider `searchChunk` operation with an opaque provider cursor, bounded limit, optional abort signal, `items`, `nextCursor`, and `exhausted`/known-total metadata. Put its public DTO in the shared contract; keep upstream URL/cursor validation server-side.

- For E-Hentai, retain/follow the returned Next link or equivalent verified continuation. Check that query, site, account revision, and allowed endpoint/path match. Do not invent numeric offsets or exact totals.
- Add a dedicated cursor-search HTTP operation for native E-Hentai Search. Leave existing Hitomi/nHentai `/doujin/search` offset behavior intact. Native E-Hentai uses previous loaded chunks/Load more rather than a false numbered `Pager`.
- Unified search uses this same bounded seam. Adapt Hitomi/nHentai through their existing efficient paging where possible; if a source lacks it, implement a bounded source-specific continuation adapter. Do **not** call `search(query, 1000)` on every unified page.
- Keep `search(query, limit, ...)` genuinely functional for existing background callers, honoring the requested bound and provider pacing. Do not implement it as a stub or an always-empty compatibility method.

**Gate:** local search fixtures cover list modes, zero results, >25 metadata entries, API per-item errors, non-default language, exclusions, and two continuation pages without fabricated totals.

### P1.4 — Resolve pages lazily and use the real queue

`getGallery` must obtain ordered image-page references across all gallery thumbnail pages and return authoritative metadata without downloading every image or opening every image viewer page during duplicate preflight.

- Detect incomplete/repeated thumbnail pagination; require the collected ordered page references to agree with the authoritative gallery page count. Stop with a parser/unavailable error rather than packaging a partial gallery as complete.
- Reuse the live resolver concept already present in `DoujinGallery`. Explicitly extend the internal page contract to represent lazy image-page references; keep static direct-image behavior for existing providers.
- Resolve a requested `/s/<page-token>/<gid>-<page>` immediately before transfer/preview to the actual viewer image URL. Support the provider's verified image-reload/alternate URL mechanism once when an image host fails.
- Thread `AbortSignal` through gallery/page resolution, its pacing wait, and image transfer.
- Keep auth/quota/content-warning/parser errors typed and terminal/actionable; remove the existing generic resolver-error suppression for these cases. Never send an image-page HTML URL as a static fallback.
- Add narrowly scoped resolved-request metadata/policy where needed: final image extension, approved targets, per-target non-secret headers, and provider response validation. Do not put an unrestricted Cookie header in `gallery.requestHeaders` and reuse it for every image host.
- Accept only actual supported image responses. Reject login/error HTML, quota/denial placeholders, empty bodies, and known non-gallery images even when HTTP status is 200. Validate before publishing the final temporary page name.
- Preserve actual extensions across restart/resume. Use a small per-task page manifest or equivalent persisted page-format evidence; do not name every resumed image `.jpg` based on an `/s/` URL.
- Preserve `.part` + atomic rename, bounded streaming, ordered page names, progress/SSE, pause/resume/cancel, CBZ/folder output, merge publication, and final ComicInfo generation.
- No retry layer may multiply permanent auth/quota errors into the existing generic multi-attempt/30-second CDN loop. Extend `classifyDownloadError` and shared download guidance for provider account/quota states as needed; use the queue's durable retry semantics for genuine transient failures.

**Gate:** genuine queue/transfer fixtures publish readable CBZ and folder output with the expected ordered pages/ComicInfo. Cover a multipage gallery, mixed image formats, cancelled lazy resolution, an expired image URL, a terminal quota response, and resume in a new process. Verify no HTML/placeholder image is published as a completed page.

### P1.5 — Add authenticated provider-aware previews and covers

Implement provider-owned same-origin media references for E-Hentai; proposed route family `/media/ehentai/...` with gallery/site identity and page index or an opaque server-issued reference.

- Extend authentication mounting to protect `/media/*` as well as existing `/media`. A new subroute must not accidentally rely on protection for only the old exact path.
- Public responses expose only gallery identity/site and same-origin preview/cover URLs. Resolve actual network targets server-side from verified provider metadata.
- Do not allow clients to authorize arbitrary remote targets through `?u=` or a claimed provider/source field. Keep existing generic CDN allowlists closed.
- Thumbnail/static provider hosts can use exact verified host rules. H@H viewer images may involve other public hosts/IPs/ports: handle only URLs obtained from the authorized provider page, not a global allow-any-public-host exception.
- Reject private/loopback/link-local/metadata destinations, unsafe IPv6/mapped addresses, userinfo, unsafe schemes, and unauthorized redirects. Validate DNS results/actual connection target and each redirect; avoid a validate-then-refetch DNS-rebinding gap.
- Never send account cookies to H@H/static image hosts. Recompute Referer/headers for the actual destination.
- Lazy preview requests resolve only the page being viewed. A gallery modal must not fetch all viewer pages just to show metadata/page count.
- Apply image-response validation, cancellation, and body limits here too. Covers remain size-bounded; previews must support legitimate full viewer-image sizes rather than blindly applying the current cover cap.
- Account/site/revision are part of authorization/cache identity. Removing/changing a session invalidates protected media references and prevents old browser/server caches from continuing to expose ExHentai images. Start with `private, no-store` for restricted previews and avoid putting them into the existing global disk cache.

**Gate:** authenticated browser preview loads a real local fixture image; unauthenticated/media-subroute, revoked-session, arbitrary-target, private-address, redirect-cookie-leak, and over-limit requests are rejected.

### P1.6 — Finish Settings and all source-facing call sites

**Settings → Downloader** gets a separate account card with:

- E-Hentai / ExHentai site selector.
- Masked session fields with explicit labels and instructions for copying the account's own cookies after browser login. ExHentai instructions say the user must already be able to access ExHentai.
- Saved-account/configured indicators without pre-filling stored secrets.
- **Save account**, **Test access**, and **Remove account** actions; confirmation only for explicit removal.
- Separate account-valid and ExHentai-access states with timestamp and useful recovery guidance. “Saved” and “Verified” are different states.
- Normal draft dirty/save/stay/discard behavior. Draft testing does not clear edits; successful save clears sensitive input values; incoming status/query refreshes do not overwrite a newer edit.

Update source maps/labels, Discover subtitle, provider options, source-aware tag links, artist deep links, selection trays, duplicate review, Task display, and Following source guards. Specifically inspect:

- `server/src/contracts/jobs.ts` merge-download source validation and optional `sourceUrl` serialization.
- `server/src/routes/api/watched.ts` source/review validation and `services/watchedSearches.ts` provider use.
- `web/src/lib/utils.ts` source argument and E-Hentai exact/escaped tag fragments.
- `web/src/lib/searchTranslation.ts` all six directed provider-switch combinations. Preserve round-trip drafts; unsupported/lossy operators require review and must not auto-commit a widened query.
- `web/src/pages/Libraries.tsx` artist-source map/options and `/downloader?source=ehentai&q=...` navigation.
- Existing recommendation routes/eligibility: keep their deliberate policy explicit. Do not label E-Hentai as nHentai through an `else` branch or silently broaden recommendation semantics.
- `galleryDuplicates.ts` E-Hentai/ExHentai Web URL extraction and `[ehentai-<gid>-<token>]` filename identity after history is cleared.

**Increment 1 exit:** registered provider, Settings account lifecycle, native search, detail preview, real download, origin-preserving restart/resume, merged-download compatibility, ownership detection, and desktop/mobile account UX are complete. Do not begin UI aggregation with a nonfunctional provider stub.

## 6. Increment 2: Unified search

### P2.1 — Define the unified query contract

Unified search is a separate workflow, not a mode switch on the existing provider-native query field.

**Default common input:** ordinary keywords/quoted phrases and documented shared filters (`artist`, `group`, `parody`, `character`, `language`, with supported exclusions). Preserve the raw user input separately from its parsed/common representation.

- Parse once on the server into a small typed common query; compile that query to each provider's actual syntax. Reuse/move pure tokenization and normalization where it prevents divergent semantics, but do not run the two-provider UI translator as the aggregator.
- Keyword matching/ranking can legitimately differ by catalog. Explain this briefly; never advertise identical relevance or complete cross-site recall.
- Preserve exclusions and explicit language. If a filter cannot be represented without widening a provider query, return a per-provider unsupported-query state or reject the common query with actionable guidance. Never silently drop it or infer a male/female namespace.
- Reject unmatched quotes/invalid common syntax before starting requests. Enforce each provider's documented query limits and expose the specific incompatibility.
- Do not broadcast native gallery IDs/URLs to unrelated catalogs. Recognized gallery URLs resolve only on the owning logical provider and show other providers as not applicable. Ambiguous bare numeric IDs require selecting native Search/a provider; they must not open three unrelated galleries.
- Keep provider-native-only operators, full native autocomplete, and native sort controls in **Search**. Unified input can be a normal labeled shared Input initially; do not add live three-provider scraping on every keystroke.
- Default ordering is explicitly **Provider order**: each provider's default native search order, interleaved fairly. Do not invent a globally comparable popularity score or claim a unified newest order when timestamps are absent/non-comparable.

### P2.2 — Implement backend aggregation with explicit partial failure

**Proposed file:** `server/src/services/unifiedSearch.ts`. Add `POST /doujin/search/unified` to the existing doujin API module.

First request: `{ query, limit: 25 }`. Continuation: the same query plus an opaque application cursor. A cursor must be bound to normalized query/options, selected family site, account/settings/exclusion revisions, and authenticated app-session context.

Proposed public result shape:

```ts
interface UnifiedSearchEntry extends PublicDoujinSearchResult {
  entryId: string; // display-group identity; never a queue gallery ID
  variants: GalleryVariant[]; // complete real-source refs and their summaries
}

interface UnifiedSearchPage {
  items: UnifiedSearchEntry[]; // new entries, never repeats of delivered entries
  updates: UnifiedSearchEntry[]; // variants added to entries delivered earlier
  nextCursor: string | null;
  hasMore: boolean;
  loadedUniqueCount: number;
  providers: ProviderSearchStatus[];
}
```

`PublicDoujinSearchResult`, `GalleryVariant`, and `ProviderSearchStatus` are proposed shared JSON DTOs, not existing symbols. A variant retains actual source, gallery ID, canonical URL/site, title, cover, artists, language, page count, and provider position. Status distinguishes success/exhausted, failed, unavailable/not-configured, rate/quota limited, unsupported query, and not applicable; include sanitized guidance and retryability.

Execution rules:

1. Start all three independent provider lanes concurrently, each with a bounded first chunk and deadline. Use settled-result handling so one provider cannot erase two successful lanes.
2. Normalize/filter each lane before grouping. Respect the saved family site/session and each provider's bans.
3. Interleave candidates in deterministic source order, one candidate per available lane at a time. Network completion order must not change which candidate becomes primary.
4. Deduplicate before filling the output chunk. Carry unconsumed candidates to the next request; do not discard entries because a page limit was reached.
5. Request more source chunks only when necessary to fill the unique-result page or establish exhaustion. Bound work per HTTP request; if the budget is reached, return fewer entries with a truthful continuation/work status, not false exhaustion.
6. Return successful results with provider-specific failure messages. If all applicable lanes fail, return an actionable aggregate error/status, not a successful “No results.” Only successful exhausted zero-result lanes justify “No results.”
7. Allow retrying a failed lane within the current search session; keep existing successful results, cursors, and dedup state. Do not re-scrape all successful lanes just to retry one outage.
8. Cancel provider work when the request/search is replaced, within the limits of shared provider requests. Abort-aware pacing must release queued work.
9. Do not sum provider totals into a unique total. Show “N unique galleries loaded”; advertise an exact total only if all lanes are exhausted and deduplication actually covered their returned results.

### P2.3 — Deduplicate conservatively, retaining provenance

There are two different operations:

- **Search grouping:** one visible card for strongly matched gallery editions.
- **Download ownership/preflight:** existing source identity and duplicate review that decide whether to queue a download.

Search grouping is not byte-identical proof and must not create owned records, completed Tasks, approvals, or accepted metadata matches.

Proposed deterministic algorithm:

1. Always coalesce exact repeated provider/gallery identities. Treat the same validated E-Hentai `(gid, token)` across the two family hosts as one identity.
2. Build metadata fingerprints once per candidate. Normalize Unicode NFKC, HTML entities, case, punctuation/spacing, documented language aliases, and artist names. Keep raw metadata for display.
3. Normalize known source wrappers only when their meaning is backed by metadata: leading artist/circle wrappers and trailing language/provider-upload annotations. Do not blindly remove bracketed text.
4. Retain chapter/volume/part numbers and edition qualifiers such as color/monochrome, censored/uncensored, revised, compilation, or materially different credited translation editions.
5. A cross-provider automatic group requires matching normalized work title (or supported alternate-title alias), compatible edition qualifiers, matching nonempty normalized artist identity, matching **known** language, and matching **known** positive page count. Conflicting known artist/edition metadata prevents merging.
6. Missing metadata is not a wildcard. Use bounded existing/provider metadata hydration when needed; E-Hentai can batch metadata, while other sources must not trigger unbounded image-page fetching. If identity remains uncertain, preserve distinct entries rather than hide a potentially different edition.
7. Use indexed fingerprint/exact-identity maps, not an all-pairs fuzzy-title comparison. Compute keys once; retain compact identity state for the active session.
8. Where aliases produce ambiguous clusters, require compatibility with all members. Do not let A≈B and B≈C merge A and C when those editions conflict.
9. Retain every complete variant and source label in the group. Keep the initial primary/`entryId` stable during that search; do not replace it when a slower/new page supplies a supposedly better source.
10. A duplicate discovered after its card was delivered yields an `updates` entry for that old `entryId`, not a new card. The client adds its variant/badge in place.

**Honesty constraint:** metadata cannot establish that all similarly named scans contain identical images without fetching/comparing content. The implementation must collapse strong same-edition matches, avoid title-only false positives, and document why uncertain editions remain separate. Do not promise perfect byte-level deduplication or silently add image hashing/downloads to search.

### P2.4 — Maintain one search session across pagination

Use a small bounded server-side search-session store with opaque random cursors. This is ephemeral search state, not a new persistent catalog/index.

Store per active session:

- Immutable query/options/site/settings/account identity.
- Per-provider continuation, buffered unconsumed candidates, exhaustion/failure status, and provider rank.
- Exact identities and fingerprint groups already seen, with stable representative/entry IDs.
- Delivered entries, pending group updates, and continuation-response replay state.

Required behavior:

- Serialize continuation mutation per session. Repeating the same cursor replays the same response; two overlapping requests cannot skip results or emit duplicates.
- Deduplicate across every loaded page in the active session, not only inside each response or visible grid page.
- Bound session count, idle lifetime, and memory; evict idle sessions before allocating unbounded data. Size limits/expiry are explicit restart-search errors, never a silently truncated “complete” search.
- Account/site/exclusion cutover invalidates affected sessions immediately. Reject old cursors rather than returning cached restricted results.
- An expired cursor/server restart returns a typed restart-required response; the UI retains the query and offers **Search again**. Never resume at page 1 under the old cursor while pretending continuity.
- Cache/replay state contains no cookies or raw authenticated HTML. Do not serialize application/upstream cursor blobs into sessionStorage or treat a client-supplied continuation URL as authority.

### P2.5 — Add the Discover tab and isolated state

**Proposed frontend files:** `web/src/pages/downloader/UnifiedSearchTab.tsx`, `useUnifiedSearch.ts`; small pure reducer/model only if needed.

Change the Discover section order to:

`Search | Unified search | For you | Following | Downloads`

Extend `DownloaderTab` with `unified`, and support `/downloader?tab=unified`. Explicit unified tab selection takes precedence over the current logic that forces every `q` deep link into native Search. Native `source`/`q` links continue to work.

Keep unified state separate from native `searches`:

- Input draft, committed query, and common options.
- Loaded entry order/entry map, pending state, lane statuses, and current server cursor in memory/query cache.
- SessionStorage persists only non-sensitive input/committed options/tab state. After reload, start a fresh session for the restored committed query; do not restore dead server cursors or stale restricted results.
- Search submit/reset does not overwrite the other tab's input/committed results. Switching tabs does not trigger unnecessary provider calls.
- Use query/request identity and account/settings revision to reject stale responses. An old result must not replace a newly submitted query or a newer edited Settings state.
- Pagination is **Load more** with an accurate loaded count, not `Pager` backed by summed totals. Prevent overlapping loads; apply `updates` without changing existing card order/selection.

Update all integration guards, not only the tab item list: tab restoration, URL resolution, query enablement, `showSelection`, selection clearing, `matchItems`, library-match inputs, motion identity, shared modal callbacks, and tab-specific empty/error content.

### P2.6 — Reuse real gallery actions for grouped entries

- Render a single `GalleryCard`-compatible entry using its stable primary summary, with primary source text visible and additional source badges/“Also on” provenance. Keep source labels visible without hover/color-only meaning.
- Extend shared card/detail presentation deliberately, or use a thin grouping wrapper; do not copy the entire card/modal or queue workflow.
- Detail modal provides an **Available from** selector/list when multiple variants exist. Selecting a variant changes the actual metadata/preview/gallery link/download target; it does not create a second search entry.
- The default card action downloads the stable primary variant. Never automatically retry a failed download from another provider or switch the site's hostname.
- Downloads, detail API requests, duplicate preflight, library matches, merged downloads, and merge-into-series always receive a concrete variant's `source`, `galleryId`, and validated origin URL. `entryId`/`unified` never reach provider endpoints.
- Inspect task/ownership state across variants, but only authoritative source matches produce an “owned/downloaded” claim. Metadata grouping alone is not an ownership record.
- Group selection is keyed by `entryId`; action snapshots resolve one explicit variant per selected group. Preserve click order for merge chapter numbering. A late group update must not change a selected download target; changing the variant explicitly updates that choice without queueing both copies.
- Keep the existing duplicate-review dialog and approval semantics. Selecting one grouped search entry does not bypass cross-provider duplicate review.
- Source-specific tag clicks from details navigate to native Search for that concrete source with correctly compiled native syntax.
- Do not display a nonfunctional “Watch all providers” action. Watching remains the existing single-provider workflow; adding a cross-provider watch lifecycle is outside this request.

### P2.7 — Complete interaction/accessibility states

Use the existing `SegmentedTabs`, `TabPanel`, `Card`, `Input`, `Badge`, `ErrorState`, `EmptyState`, and loading primitives. This is an **Operate** surface: preserve compact gallery-first layout and existing themes/tokens.

Required states:

- Before first search: explain that one query searches three logical providers and repeated editions are grouped.
- Initial loading: skeleton/grid loading with accessible status; do not show stale results as if they belong to the new committed query.
- Results: unique-loaded count, source-status summary, visible provider labels, selection/download actions, Load more when meaningful.
- Partial failure/unconfigured ExHentai: successful galleries remain usable; clear per-source guidance links to Settings → Downloader and a scoped retry.
- All failed: actionable error, not “No results.”
- True zero results: searched-provider summary and query, with no false success claim for failed providers.
- Loading additional results: preserve existing cards/order/selection and focused control.
- Expired/invalidated session: keep query, discard unsafe cached authority, offer Search again; account removal must not continue displaying protected cached previews.

Verify five tabs fit or remain navigable at mobile widths without truncating inaccessible labels or causing whole-page horizontal scrolling. Preserve keyboard tab navigation, aria-selected/panel associations, visible focus, touch target rules, reduced motion, light/dark themes, long multilingual titles, and wrapped source/error text. Source color supports text; it does not replace it.

## 7. Implementation order and ownership

Execute this order. Each step has a functional gate; do not leave UI-only stubs or placeholder provider methods.

| Step | Deliverable                                                                                         | Depends on                                     |
| ---- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Shared source/origin/public contracts; canonical URL parsing; migration for frozen download origin  | Repository reference mapping                   |
| 2    | Encrypted account storage, revisioned Settings endpoints, client access classification/request gate | 1                                              |
| 3    | Native provider search/chunks, metadata normalization, exclusions, registry                         | 2                                              |
| 4    | Lazy resolver, response validation, provider-safe media, real queue/resume/merge integration        | 3                                              |
| 5    | Account Settings UI, third-source native UI/caller migration, increment-1 smoke proof/docs          | 4                                              |
| 6    | Common-query compiler and session-aware aggregation/dedup/pagination service                        | 3; increment 1 complete before public delivery |
| 7    | Unified tab/state, provenance/variant actions, partial-failure UX                                   | 6                                              |
| 8    | Focused end-to-end proof, final documentation, remove temporary smoke artifacts                     | 7                                              |

If delegating implementation, first settle the shared contracts and keep one integration owner. Backend account/provider/transfer work and frontend Settings work can proceed independently only after their API contract is fixed; aggregation logic and frontend unified UX likewise share an agreed page/variant contract. Assign disjoint files; do not have agents concurrently reshape `api.ts`, `Downloader.tsx`, or the shared contracts.

## 8. Verification plan

Use deterministic, isolated provider fixtures for automated checks; network/account availability must not affect the ordinary suite. The existing test harness sets `HTOSHO_DATA_DIR` **before dynamic imports**, because the DB module captures it at load. Restore modified provider/fetch hooks and close/remove temporary resources.

Add tests for genuinely uncertain consumer-visible edges, not source text, incidental labels/defaults, API wiring echoes, or mere “did not throw” assertions. Reuse existing coverage where it already exercises the path.

### Backend coverage

| Area                 | Required scenario and observable assertion                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locator/identity     | Public/restricted URLs for the same `(gid, token)` canonicalize together; invalid token/host/path rejected; different revisions stay distinct.                                            |
| Settings security    | Secret replacement/preservation/removal works; stale save returns 409; GET/save/test/SSE/errors never contain cookie values; header injection rejected.                                   |
| Persistence          | New-process restart reads the same encrypted session/key and frozen queue origin; corrupt/missing key is explicit, not silently reset.                                                    |
| Access               | Successful ExHentai response differs from public-account-only, expired cookies, HTTP-200 denial/blank HTML, warning, and quota states.                                                    |
| Provider metadata    | Correct namespaced artists/tags/language/page count/timestamp, batched API requests, per-gallery API failure handling, and exclusions.                                                    |
| Lazy download        | Preflight does not fetch viewer image bytes; requested pages resolve lazily; complete CBZ/folder output has correct images/extensions/ComicInfo/reading order.                            |
| Resume and cutover   | Paused/crashed task resumes verified complete pages without corrupt format names; account removal stops restricted traffic; site setting changes do not rewrite queued origins.           |
| Request safety       | Cookies not forwarded to CDN/H@H or disallowed redirects; unauthorized/private/DNS-rebound targets rejected; quota/error HTML not published as images.                                    |
| Grouping positive    | Same strong title/artist/language/page-count edition across three providers yields one entry with three variants; exact repeats coalesce.                                                 |
| Grouping negative    | Different languages, chapter numbers, artists, page counts, color/censor/translation editions, and missing evidence remain distinct. Alias bridges cannot collapse incompatible editions. |
| Pagination           | A duplicate on a later provider chunk updates an earlier card; buffered unique entries are not lost; repeated/concurrent cursor requests replay correctly.                                |
| Partial failure      | One failed lane leaves two lanes usable; zero-success/all-failed is an error; failed-lane retry preserves successful entries and their dedup state.                                       |
| Lifecycle            | Replaced query, account/exclusion revision change, cursor tampering, expiry, and server restart cannot leak stale results or silently restart pagination.                                 |
| Native compatibility | Existing Hitomi/nHentai offset routes and provider-switch behavior work; EH watch/source/merge validation is accepted where intended; recommendation policy is unchanged.                 |

Existing focused starting points: `server/test/queueHardening.test.ts`, `media.test.ts`, `downloadQueue.test.ts`, `downloadCancellation.test.ts`, `downloadDiscovery.test.ts`, and `web/test/searchTranslation.test.ts`.

### Browser/real-surface proof

Extend the isolated `web/test/e2e-server.ts` fixture deliberately. It currently disables general live provider calls/workers. Supply only authorized local gallery/query fixtures and bounded real download execution for the scenarios being tested; leave unknown requests fail-closed. Do not merely intercept the unified API with a pre-deduplicated response and claim the backend aggregator worked.

Run focused desktop and mobile scenarios:

1. Settings account save/test/remove, masked saved state, stale-save recovery, unsaved-navigation handling, and reload.
2. Discover has a separate Unified search tab immediately beside Search; both query drafts persist independently, including direct-link/reload/back behavior.
3. A real aggregation request produces one card for the three-provider duplicate plus distinct-language/chapter editions. All source labels are visible.
4. Load more discovers an alternate provider for an already visible gallery, updates its provenance, and adds no duplicate card.
5. One source fails/has no ExHentai access; successful results still open/preview/download, and Settings guidance/scoped retry works.
6. Change a grouped entry's selected variant: detail/preview/external URL/download command use that actual source; only one gallery is queued. Multi-selection preserves one variant per group and merge order.
7. Account removal or a new query during delayed work prevents stale private results/preview authorization from being used.
8. Inspect light/dark, narrow mobile, long titles, keyboard navigation/focus, touch layout, loading/empty/error states, and actual rendered previews. Capture focused screenshots as evidence, without private gallery imagery or credentials.

An optional authorized live smoke run may verify current E-Hentai/ExHentai markup and one small user-selected gallery. Keep credentials out of committed fixtures/output and use conservative pacing. If no authorized account is available, finish deterministic implementation/coverage and explicitly report **live ExHentai access unverified**; never replace that proof with public metadata API success.

### Commands for the implementing agent

Run from the repository root unless a command supplies a workspace/cwd. Substitute the new focused test filenames actually created; the names below are proposed, not files claimed to exist.

```bash
# Focused server checks, from server/ after implementing the relevant increment:
npx tsx --test test/ehentai.test.ts test/ehentaiAccount.test.ts test/unifiedSearch.test.ts

# Focused translation/query model checks, from web/:
npx tsx --test test/searchTranslation.test.ts test/unifiedSearch.test.ts

# Shared type/build boundary:
npm run typecheck
npm run build

# Target the new/affected browser scenarios in both configured projects:
npm run test:e2e --workspace @h-tosho/web -- --grep 'E-Hentai|ExHentai|Unified search'
```

Use the narrowest applicable checks once after each completed increment, not repeated mid-edit build/format/test loops. Before final delivery, run affected existing regression files that exercise changed contracts. A full-suite run is appropriate only when requested or a shared-boundary change genuinely requires it; document the exact commands/results actually observed.

## 9. Documentation and final acceptance

After functional smoke proof, update:

- `README.md`: third gallery provider, account-cookie setup/removal/access testing, E-Hentai versus ExHentai selection, quota/quality limitations, Unified search location/semantics, provider provenance, and partial failures.
- `docs/architecture.md`: account/request ownership, provider-safe media, lazy page resolution, canonical/frozen origin, aggregation/dedup/cursor session ownership.
- `CHANGELOG.md`: separate entries for provider/account support and the subsequent Unified search increment. Do not claim authorized live access was tested when only fixtures were exercised.

Remove throwaway scripts and private response dumps. Keep only deterministic useful fixtures and permanent code/docs. Do not clear existing Task/history/ownership data or alter unrelated feature plans.

### Final checklist for the implementing agent

- [ ] `ehentai` is a genuine registered third gallery source; E-Hentai and ExHentai site semantics are explicit.
- [ ] Account is configurable/testable/removable under Settings → Downloader, with durable secure session storage and no readback of secrets.
- [ ] Public use works without ExHentai access; restricted use fails clearly unless the configured account has access.
- [ ] Gallery IDs include tokens; canonical identities and frozen origins survive queueing, merge, history clearing, and restart.
- [ ] Native search, gallery metadata, lazy authenticated previews, CBZ/folder downloads, pause/resume/cancel/retry, and existing Kavita/merge protections work end to end.
- [ ] Unified search queries all three logical providers for a compatible common query and honestly exposes unavailable/failed lanes.
- [ ] Strong duplicate editions display once across all loaded pages, retaining stable IDs and all provider variants; distinct/uncertain editions are not falsely hidden.
- [ ] Each unified entry visibly identifies its actual source(s); variant actions target the chosen real gallery.
- [ ] Unified search is a separate tab immediately after Search; existing Search behavior/state/deep links remain intact.
- [ ] Cursor replay, cancellation, stale responses, session expiry, and account/exclusion cutovers are covered.
- [ ] Desktop/mobile/light/dark/keyboard surfaces and actual preview/download scenarios have observed verification.
- [ ] Documentation describes shipped behavior and verification limitations; no placeholders, compatibility shims, private dumps, or unrelated changes remain.
