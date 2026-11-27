import { mkdtempSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { KavitaClient } from "../src/kavita/client.js";
import {
  KavitaAgeRating,
  KavitaPublicationStatus,
  type KavitaSeriesMetadataDto,
} from "../src/kavita/types.js";
import type { SeriesMetadata } from "../src/providers/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function currentMetadata(): KavitaSeriesMetadataDto {
  return {
    id: 7,
    seriesId: 42,
    summary: "Old summary",
    genres: [{ id: 1, title: "Action" }],
    tags: [{ id: 2, title: "Existing tag" }],
    writers: [{ id: 3, name: "Old Writer" }],
    coverArtists: [{ id: 4, name: "Preserved Cover Artist" }],
    publishers: [],
    characters: [{ id: 5, name: "Preserved Character" }],
    pencillers: [],
    inkers: [],
    imprints: [],
    colorists: [],
    letterers: [],
    editors: [],
    translators: [],
    teams: [],
    locations: [],
    ageRating: KavitaAgeRating.Unknown,
    releaseYear: 2020,
    language: "en",
    maxCount: 12,
    totalCount: 10,
    publicationStatus: KavitaPublicationStatus.Ongoing,
    webLinks: "https://old.example",
    languageLocked: false,
    summaryLocked: false,
    ageRatingLocked: false,
    publicationStatusLocked: false,
    genresLocked: false,
    tagsLocked: false,
    writerLocked: true,
    characterLocked: true,
    coloristLocked: false,
    editorLocked: false,
    inkerLocked: false,
    imprintLocked: false,
    lettererLocked: false,
    pencillerLocked: true,
    publisherLocked: false,
    translatorLocked: false,
    teamLocked: false,
    locationLocked: false,
    coverArtistLocked: true,
    releaseYearLocked: false,
  };
}

describe("KavitaClient", () => {
  it("uses v0.9 account and server endpoints and requires an admin Auth Key", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(new Headers(init?.headers).get("x-api-key"), "secret");
      if (url.endsWith("/api/Account")) {
        return Response.json({ id: 1, username: "admin", roles: ["Admin"] });
      }
      return Response.json({
        kavitaVersion: "0.9.0.2",
        installId: "install-1",
        isDocker: true,
        firstInstallVersion: "0.8.4",
      });
    };

    const info = await new KavitaClient(
      "https://kavita.example/api/",
      " secret "
    ).testConnection();

    assert.deepEqual(urls, [
      "https://kavita.example/api/Server/server-info-slim",
      "https://kavita.example/api/Account",
    ]);
    assert.deepEqual(info, {
      version: "0.9.0.2",
      installId: "install-1",
      isDocker: true,
      firstInstallDate: undefined,
      firstInstallVersion: "0.8.4",
    });
  });

  it("returns actionable authentication and authorization errors", async () => {
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(
      () =>
        new KavitaClient("https://kavita.example", "bad-key").testConnection(),
      /Auth Key is valid and belongs to an admin user/
    );

    globalThis.fetch = async (input) =>
      String(input).endsWith("/api/Account")
        ? Response.json({ id: 2, roles: ["Download"] })
        : Response.json({ kavitaVersion: "0.9.0.2" });
    await assert.rejects(
      () =>
        new KavitaClient(
          "https://kavita.example",
          "non-admin"
        ).testConnection(),
      /requires an admin user/
    );
  });

  it("rejects Kavita server versions older than the supported v0.9 API", async () => {
    globalThis.fetch = async () => Response.json({ kavitaVersion: "0.8.7.4" });
    await assert.rejects(
      () =>
        new KavitaClient("https://kavita.example", "secret").testConnection(),
      /requires Kavita 0\.9\.0 or newer/
    );
  });

  it("uses current library types and the v2 series filter contract", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/Library/libraries")) {
        return Response.json([
          {
            id: 2,
            name: "Manga",
            type: 0,
            folders: ["/media/manga"],
            folderWatching: true,
          },
          { id: 3, name: "Novels", type: 4, folders: ["/media/novels"] },
          { id: 4, name: "Comics", type: 5, folders: ["/media/comics"] },
        ]);
      }
      return Response.json([
        {
          id: 42,
          libraryId: 2,
          name: "Example",
          sortName: "Example",
          coverImage: "series42.png",
          created: "2026-09-15T10:00:00Z",
        },
      ]);
    };

    const client = new KavitaClient("https://kavita.example", "secret");
    const libraries = await client.getLibraries();
    const series = await client.getSeries(2);

    assert.equal(libraries[0]?.path, "/media/manga");
    assert.deepEqual(
      libraries.map((library) => library.mediaFormat),
      ["manga", "book", "comic"]
    );
    assert.equal(series[0]?.name, "Example");
    assert.equal(series[0]?.cover, "series42.png");
    assert.equal(series[0]?.created, "2026-09-15T10:00:00Z");
    assert.match(
      requests[1]?.url ?? "",
      /\/api\/Series\/all-v2\?PageNumber=1&PageSize=0/
    );
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      statements: [{ comparison: 5, field: 19, value: "2" }],
      combination: 0,
      entityType: 0,
      limitTo: 0,
    });
  });

  it("read-merges full metadata and writes with the two-phase lock protocol", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/Series/42")) {
        return Response.json({
          id: 42,
          libraryId: 2,
          name: "Old title",
          localizedName: "Localized title",
          sortName: "Old sort",
          coverImageLocked: true,
          localizedNameLocked: true,
          aniListId: 123,
        });
      }
      if (url.includes("/api/Series/metadata?"))
        return Response.json(currentMetadata());
      if (url.includes("/api/Person?name=New%20Writer"))
        return Response.json({ id: 55, name: "New Writer" });
      if (url.includes("/api/Person?name=New%20Artist"))
        return new Response(null, { status: 404 });
      return Response.json({ ok: true });
    };

    await new KavitaClient(
      "https://kavita.example",
      "secret"
    ).updateSeriesMetadata(42, {
      name: "New title",
      summary: "New summary",
      tags: ["New tag"],
      writers: ["New Writer"],
      artists: ["New Artist"],
      releaseYear: 2024,
      publicationStatus: KavitaPublicationStatus.Completed,
    });

    // No /api/Person/update call: unknown people ride along as id-0 entries and
    // are created by the metadata write itself.
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      [
        "/api/Series/42",
        "/api/Series/update",
        "/api/Series/metadata",
        "/api/Person",
        "/api/Person",
        "/api/Series/metadata",
        "/api/Series/metadata",
      ]
    );

    const identity = JSON.parse(String(requests[1]?.init?.body));
    assert.equal(identity.name, "New title");
    assert.equal(identity.localizedName, "Localized title");
    assert.equal(identity.aniListId, 123);
    assert.equal(identity.nameLocked, true);
    // Identity updates must pass the existing sort title through untouched.
    assert.equal(identity.sortName, "Old sort");
    assert.equal(identity.sortNameLocked, false);

    // Phase 1: values land with every patched field's lock flag cleared — Kavita
    // skips a field's value whenever its lock flag is set in the payload.
    const phase1 = JSON.parse(String(requests[5]?.init?.body)).seriesMetadata;
    assert.equal(phase1.summary, "New summary");
    assert.deepEqual(phase1.tags, [{ id: 0, title: "New tag" }]);
    // Existing persons are referenced by their real Kavita person id…
    assert.deepEqual(phase1.writers, [{ id: 55, name: "New Writer" }]);
    // …unknown ones go out as id 0 so the write creates them.
    assert.deepEqual(phase1.pencillers, [{ id: 0, name: "New Artist" }]);
    assert.equal(phase1.summaryLocked, false);
    assert.equal(phase1.tagsLocked, false);
    assert.equal(phase1.writerLocked, false);
    assert.equal(phase1.pencillerLocked, false);
    assert.equal(phase1.releaseYearLocked, false);
    assert.equal(phase1.publicationStatusLocked, false);
    assert.deepEqual(phase1.coverArtists, [
      { id: 4, name: "Preserved Cover Artist" },
    ]);
    assert.deepEqual(phase1.characters, [
      { id: 5, name: "Preserved Character" },
    ]);

    // Phase 2: same values re-posted with the patched fields re-locked so Kavita's
    // own provider fetches don't overwrite them.
    const phase2 = JSON.parse(String(requests[6]?.init?.body)).seriesMetadata;
    assert.equal(phase2.summary, "New summary");
    assert.deepEqual(phase2.writers, [{ id: 55, name: "New Writer" }]);
    assert.deepEqual(phase2.pencillers, [{ id: 0, name: "New Artist" }]);
    assert.equal(phase2.summaryLocked, true);
    assert.equal(phase2.tagsLocked, true);
    assert.equal(phase2.writerLocked, true);
    assert.equal(phase2.pencillerLocked, true);
    assert.equal(phase2.releaseYearLocked, true);
    assert.equal(phase2.publicationStatusLocked, true);
  });

  it("sends unknown people with id 0 so the metadata write creates them", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/api/Person?name=Ghost%20Writer"))
        return new Response(null, { status: 404 });
      if (url.includes("/api/Series/metadata?"))
        return Response.json(currentMetadata());
      return Response.json({ ok: true });
    };

    await new KavitaClient(
      "https://kavita.example",
      "secret"
    ).updateSeriesMetadata(42, {
      summary: "New summary",
      writers: ["Ghost Writer"],
    });

    const posts = requests.filter((request) =>
      request.url.endsWith("/api/Series/metadata")
    );
    assert.equal(posts.length, 2);
    const phase1 = JSON.parse(String(posts[0]?.init?.body)).seriesMetadata;
    // A name Kavita does not know yet is not dropped — id 0 makes the write create it.
    assert.deepEqual(phase1.writers, [{ id: 0, name: "Ghost Writer" }]);
    assert.equal(phase1.writerLocked, false);
    assert.equal(phase1.summary, "New summary");
    const phase2 = JSON.parse(String(posts[1]?.init?.body)).seriesMetadata;
    assert.deepEqual(phase2.writers, [{ id: 0, name: "Ghost Writer" }]);
    assert.equal(phase2.writerLocked, true);
  });

  it("posts a base64 cover payload and forwards the cover lock state", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ ok: true });
    };

    await new KavitaClient(
      "https://kavita.example",
      "secret"
    ).updateSeriesCover(42, Buffer.from("image"), true);

    // A single inline base64 POST — no staging round-trip (the /Upload/upload-by-file
    // endpoint does not exist on Kavita 0.9.0.x servers).
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://kavita.example/api/Upload/series");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      id: 42,
      url: Buffer.from("image").toString("base64"),
      lockCover: true,
    });
  });

  it("targets the correct Kavita library scan endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ ok: true });
    };

    const client = new KavitaClient("https://kavita.example", "secret");
    await client.scanLibrary(7);
    await client.scanSeries(7, 42);
    await client.scanAllLibraries();

    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "https://kavita.example/api/Library/scan?libraryId=7",
        "https://kavita.example/api/Series/scan",
        "https://kavita.example/api/Library/scan-all",
      ]
    );
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      libraryId: 7,
      seriesId: 42,
      forceUpdate: true,
      forceColorscape: false,
    });
  });

  it("posts a scan-folder body carrying the admin key and no series-match abort", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ ok: true });
    };

    await new KavitaClient("https://kavita.example", "secret").scanFolder(
      7,
      "C:\\downloads\\Author_Title"
    );

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "https://kavita.example/api/Library/scan-folder"
    );
    // ScanFolderDto has no library field: the server resolves the library from
    // the folder path and re-authenticates via the body's apiKey.
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      apiKey: "secret",
      folderPath: "C:\\downloads\\Author_Title",
      abortOnNoSeriesMatch: false,
    });
  });

  it("reports scan tasks via 0.9.1 method-scoped is-task-running calls", async () => {
    let body: string = "false";
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = new KavitaClient("https://kavita.example", "secret");

    body = "true";
    assert.equal(await client.isTaskRunning(), true);
    body = '"true"';
    assert.equal(
      await client.isTaskRunning(),
      true,
      "a quoted-string body still means running"
    );
    body = "false";
    assert.equal(await client.isTaskRunning(), false);

    // Every call carries a scan method name and one of the two Hangfire queues.
    const methods: string[] = [];
    for (const url of requests) {
      assert.ok(
        url.startsWith(
          "https://kavita.example/api/Server/is-task-running?methodName="
        ),
        url
      );
      assert.ok(/&queue=(default|scan)$/.test(url), url);
      const method = new URL(url).searchParams.get("methodName") ?? "";
      if (!methods.includes(method)) methods.push(method);
    }
    assert.deepEqual(methods.sort(), [
      "ScanLibraries",
      "ScanLibrary",
      "ScanSeries",
    ]);
  });

  it("falls back to the bare is-task-running call when no scoped call is answered", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("methodName="))
        return new Response("The methodName field is required.", {
          status: 400,
        });
      return new Response("true", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = new KavitaClient("https://kavita.example", "secret");

    assert.equal(await client.isTaskRunning(), true);
    assert.ok(
      requests.some(
        (url) => url === "https://kavita.example/api/Server/is-task-running"
      ),
      "the legacy bare call must be made when every scoped call fails"
    );
  });

  it("stages covers through Kavita (upload-by-url) and applies the staged bytes as base64", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/Upload/upload-by-url"))
        return Response.json("coverupload_2026_1.jpg");
      if (url.includes("/api/Image/cover-upload?")) {
        return new Response(Buffer.from("staged-image"), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      return Response.json({ ok: true });
    };

    await new KavitaClient(
      "https://kavita.example",
      "secret"
    ).updateSeriesCoverFromUrl(42, "https://cdn.example/cover.jpg", false);

    assert.equal(requests.length, 3);
    assert.equal(
      requests[0]?.url,
      "https://kavita.example/api/Upload/upload-by-url"
    );
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      url: "https://cdn.example/cover.jpg",
    });
    // Kavita's cover endpoints only accept inline base64 on v0.9, so the staged
    // temp file must be read back before it can be applied.
    assert.match(
      requests[1]?.url ?? "",
      /\/api\/Image\/cover-upload\?filename=coverupload_2026_1\.jpg&apiKey=secret$/
    );
    assert.equal(requests[2]?.url, "https://kavita.example/api/Upload/series");
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
      id: 42,
      url: Buffer.from("staged-image").toString("base64"),
      lockCover: false,
    });
  });

  it("falls back to a local cover download + base64 apply when upload-by-url fails", async () => {
    // applyToKavita writes sync history, so point the DB at a throwaway
    // directory before the db module loads (dynamic-import module boundary).
    process.env.HTOSHO_DATA_DIR = mkdtempSync(
      path.join(tmpdir(), "htosho-client-cover-")
    );
    const { initDb } = await import("../src/db/index.js");
    const { applyToKavita } = await import("../src/services/sync.js");
    initDb();

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/Upload/upload-by-url"))
        return new Response("url-not-valid", { status: 400 });
      if (url === "https://cdn.example/cover.jpg") {
        return new Response(Buffer.from("local-image"), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      return Response.json({ ok: true });
    };

    const client = new KavitaClient("https://kavita.example", "secret");
    const metadata: SeriesMetadata = {
      providerId: "mangadex",
      providerSeriesId: "md-1",
      title: "Test Series",
      genres: [],
      tags: [],
      writers: [],
      artists: [],
    };
    const result = await applyToKavita(client, 42, metadata, {
      coverUrl: "https://cdn.example/cover.jpg",
      title: "Test Series",
    });

    assert.equal(result.coverUpdated, true);
    const seriesCover = requests.find((r) =>
      r.url.endsWith("/api/Upload/series")
    );
    assert.ok(
      seriesCover,
      "the base64 series-cover endpoint must still be used"
    );
    assert.deepEqual(JSON.parse(String(seriesCover.init?.body)), {
      id: 42,
      url: Buffer.from("local-image").toString("base64"),
      lockCover: true,
    });
    assert.equal(
      requests.some((r) => r.url.includes("/api/Image/cover-upload")),
      false,
      "a failed staging must not leave the flow trying to read a staged upload"
    );
  });
});
