import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { KavitaClient } from '../src/kavita/client.js';
import { KavitaAgeRating, KavitaPublicationStatus, type KavitaSeriesMetadataDto } from '../src/kavita/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function currentMetadata(): KavitaSeriesMetadataDto {
  return {
    id: 7,
    seriesId: 42,
    summary: 'Old summary',
    genres: [{ id: 1, title: 'Action' }],
    tags: [{ id: 2, title: 'Existing tag' }],
    writers: [{ id: 3, name: 'Old Writer' }],
    coverArtists: [{ id: 4, name: 'Preserved Cover Artist' }],
    publishers: [],
    characters: [{ id: 5, name: 'Preserved Character' }],
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
    language: 'en',
    maxCount: 12,
    totalCount: 10,
    publicationStatus: KavitaPublicationStatus.Ongoing,
    webLinks: 'https://old.example',
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

describe('KavitaClient', () => {
  it('uses v0.9 account and server endpoints and requires an admin Auth Key', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'secret');
      if (url.endsWith('/api/Account')) {
        return Response.json({ id: 1, username: 'admin', roles: ['Admin'] });
      }
      return Response.json({
        kavitaVersion: '0.9.0.2',
        installId: 'install-1',
        isDocker: true,
        firstInstallVersion: '0.8.4',
      });
    };

    const info = await new KavitaClient('https://kavita.example/api/', ' secret ').testConnection();

    assert.deepEqual(urls, [
      'https://kavita.example/api/Server/server-info-slim',
      'https://kavita.example/api/Account',
    ]);
    assert.deepEqual(info, {
      version: '0.9.0.2',
      installId: 'install-1',
      isDocker: true,
      firstInstallDate: undefined,
      firstInstallVersion: '0.8.4',
    });
  });

  it('returns actionable authentication and authorization errors', async () => {
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(
      () => new KavitaClient('https://kavita.example', 'bad-key').testConnection(),
      /Auth Key is valid and belongs to an admin user/,
    );

    globalThis.fetch = async (input) =>
      String(input).endsWith('/api/Account')
        ? Response.json({ id: 2, roles: ['Download'] })
        : Response.json({ kavitaVersion: '0.9.0.2' });
    await assert.rejects(
      () => new KavitaClient('https://kavita.example', 'non-admin').testConnection(),
      /requires an admin user/,
    );
  });

  it('rejects Kavita server versions older than the supported v0.9 API', async () => {
    globalThis.fetch = async () => Response.json({ kavitaVersion: '0.8.7.4' });
    await assert.rejects(
      () => new KavitaClient('https://kavita.example', 'secret').testConnection(),
      /requires Kavita 0\.9\.0 or newer/,
    );
  });

  it('uses current library types and the v2 series filter contract', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/api/Library/libraries')) {
        return Response.json([
          { id: 2, name: 'Manga', type: 0, folders: ['/media/manga'], folderWatching: true },
          { id: 3, name: 'Novels', type: 4, folders: ['/media/novels'] },
          { id: 4, name: 'Comics', type: 5, folders: ['/media/comics'] },
        ]);
      }
      return Response.json([
        { id: 42, libraryId: 2, name: 'Example', sortName: 'Example', coverImage: 'series42.png' },
      ]);
    };

    const client = new KavitaClient('https://kavita.example', 'secret');
    const libraries = await client.getLibraries();
    const series = await client.getSeries(2);

    assert.equal(libraries[0]?.path, '/media/manga');
    assert.deepEqual(libraries.map((library) => library.mediaFormat), ['manga', 'book', 'comic']);
    assert.equal(series[0]?.name, 'Example');
    assert.equal(series[0]?.cover, 'series42.png');
    assert.match(requests[1]?.url ?? '', /\/api\/Series\/all-v2\?PageNumber=1&PageSize=0/);
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      statements: [{ comparison: 5, field: 19, value: '2' }],
      combination: 0,
      entityType: 0,
      limitTo: 0,
    });
  });

  it('read-merges full metadata before using the split v0.9 update endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/api/Series/42')) {
        return Response.json({
          id: 42,
          libraryId: 2,
          name: 'Old title',
          localizedName: 'Localized title',
          sortName: 'Old sort',
          coverImageLocked: true,
          localizedNameLocked: true,
          aniListId: 123,
        });
      }
      if (url.includes('/api/Series/metadata?')) return Response.json(currentMetadata());
      return Response.json({ ok: true });
    };

    await new KavitaClient('https://kavita.example', 'secret').updateSeriesMetadata(42, {
      name: 'New title',
      summary: 'New summary',
      tags: ['New tag'],
      writers: ['New Writer'],
      artists: ['New Artist'],
      releaseYear: 2024,
      publicationStatus: KavitaPublicationStatus.Completed,
    });

    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      '/api/Series/42',
      '/api/Series/update',
      '/api/Series/metadata',
      '/api/Series/metadata',
    ]);

    const identity = JSON.parse(String(requests[1]?.init?.body));
    assert.equal(identity.name, 'New title');
    assert.equal(identity.localizedName, 'Localized title');
    assert.equal(identity.aniListId, 123);
    assert.equal(identity.nameLocked, true);

    const metadata = JSON.parse(String(requests[3]?.init?.body)).seriesMetadata;
    assert.equal(metadata.summary, 'New summary');
    assert.deepEqual(metadata.tags, [{ id: 0, title: 'New tag' }]);
    assert.deepEqual(metadata.writers, [{ id: 0, name: 'New Writer' }]);
    assert.deepEqual(metadata.pencillers, [{ id: 0, name: 'New Artist' }]);
    assert.equal(metadata.summaryLocked, true);
    assert.equal(metadata.tagsLocked, true);
    assert.equal(metadata.writerLocked, true);
    assert.equal(metadata.pencillerLocked, true);
    assert.equal(metadata.releaseYearLocked, true);
    assert.equal(metadata.publicationStatusLocked, true);
    assert.deepEqual(metadata.coverArtists, [{ id: 4, name: 'Preserved Cover Artist' }]);
    assert.deepEqual(metadata.characters, [{ id: 5, name: 'Preserved Character' }]);
  });

  it('posts a base64 cover payload and forwards the cover lock state', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ ok: true });
    };

    await new KavitaClient('https://kavita.example', 'secret').updateSeriesCover(42, Buffer.from('image'), true);

    // A single inline base64 POST — no staging round-trip (the /Upload/upload-by-file
    // endpoint does not exist on Kavita 0.9.0.x servers).
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://kavita.example/api/Upload/series');
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      id: 42,
      url: Buffer.from('image').toString('base64'),
      lockCover: true,
    });
  });

  it('targets the correct Kavita library scan endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ ok: true });
    };

    const client = new KavitaClient('https://kavita.example', 'secret');
    await client.scanLibrary(7);
    await client.scanSeries(7, 42);
    await client.scanAllLibraries();

    assert.deepEqual(requests.map((request) => request.url), [
      'https://kavita.example/api/Library/scan?libraryId=7',
      'https://kavita.example/api/Series/scan',
      'https://kavita.example/api/Library/scan-all',
    ]);
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      libraryId: 7,
      seriesId: 42,
      forceUpdate: true,
      forceColorscape: false,
    });
  });
});
