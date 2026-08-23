import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mangaDexProvider } from '../src/providers/mangadex.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MangaDexProvider cover URLs', () => {
  it('resolves search candidate covers via /cover/{id} fileName, not the relationship id', async () => {
    const coverRequests: string[] = [];
    const searchUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga?')) {
        searchUrls.push(url);
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            {
              id: 'manga-1',
              attributes: { title: { en: 'Series One' }, year: 2025, description: { en: 'Desc one' } },
              relationships: [{ id: 'cover-uuid-1', type: 'cover_art' }],
            },
            {
              id: 'manga-2',
              attributes: { title: { en: 'Series Two' } },
              relationships: [{ id: 'cover-uuid-2', type: 'cover_art' }],
            },
            {
              id: 'manga-3',
              attributes: { title: { en: 'No Cover' } },
              relationships: [],
            },
          ],
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover/')) {
        coverRequests.push(url);
        const id = url.split('/').pop();
        if (id === 'cover-uuid-1') {
          return Response.json({ result: 'ok', response: 'entity', data: { attributes: { fileName: 'file-one.jpg' } } });
        }
        if (id === 'cover-uuid-2') {
          return new Response('not found', { status: 404 });
        }
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const results = await mangaDexProvider.search('test');

    assert.equal(results.length, 3);
    // MangaDex's default search scope hides pornographic-rated titles; without
    // requesting every rating explicitly, adult series are invisible to live
    // search and can never be identified.
    const searchParams = new URL(searchUrls[0]).searchParams;
    for (const rating of ['safe', 'suggestive', 'erotica', 'pornographic']) {
      assert.ok(
        searchParams.getAll('contentRating[]').includes(rating),
        `missing contentRating[]=${rating}`,
      );
    }
    // The CDN path must use the fileName served by /cover/{id}; using the raw
    // cover relationship id as the file name 404s on uploads.mangadex.org.
    assert.equal(results[0].coverUrl, 'https://uploads.mangadex.org/covers/manga-1/file-one.jpg');
    // A failed /cover lookup degrades to no thumbnail instead of a broken URL.
    assert.equal(results[1].coverUrl, undefined);
    assert.equal(results[2].coverUrl, undefined);
    assert.deepEqual(coverRequests.sort(), [
      'https://api.mangadex.org/cover/cover-uuid-1',
      'https://api.mangadex.org/cover/cover-uuid-2',
    ]);
  });

  it('builds series metadata cover URLs from the resolved fileName without query params', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga/manga-1?')) {
        return Response.json({
          result: 'ok',
          response: 'entity',
          data: {
            id: 'manga-1',
            attributes: { title: { en: 'Series One' }, status: 'ongoing', originalLanguage: 'ja' },
            relationships: [
              { id: 'cover-uuid-1', type: 'cover_art' },
              { id: 'user-1', type: 'author', attributes: { name: 'Author One' } },
            ],
          },
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        return Response.json({ result: 'ok', response: 'collection', data: [] });
      }
      if (url.startsWith('https://api.mangadex.org/cover/')) {
        return Response.json({ result: 'ok', response: 'entity', data: { attributes: { fileName: 'file-one.jpg' } } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await mangaDexProvider.getSeriesMetadata('manga-1');

    assert.equal(meta.coverUrl, 'https://uploads.mangadex.org/covers/manga-1/file-one.jpg');
    assert.deepEqual(meta.artists, ['Author One']);
  });
  it('selects one cover per volume with English preferred over Japanese and newest upload winning within a locale', async () => {
    const coverCollectionRequests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga/manga-1?')) {
        return Response.json({
          result: 'ok',
          response: 'entity',
          data: {
            id: 'manga-1',
            attributes: { title: { en: 'Series One' }, status: 'ongoing', originalLanguage: 'ja' },
            relationships: [{ id: 'cover-uuid-1', type: 'cover_art' }],
          },
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        coverCollectionRequests.push(url);
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            // Main/series-level cover: no volume, must be skipped.
            { id: 'c0', attributes: { volume: null, fileName: 'main.jpg', locale: 'ja', updatedAt: '2021-01-01T00:00:00+00:00' } },
            // Vol 1: English and Japanese both exist; English wins even though the ja upload is newer.
            { id: 'c1a', attributes: { volume: '1', fileName: 'vol1-en.jpg', locale: 'en', updatedAt: '2023-02-20T23:52:26+00:00' } },
            { id: 'c1b', attributes: { volume: '1', fileName: 'vol1-ja.jpg', locale: 'ja', updatedAt: '2024-01-01T00:00:00+00:00' } },
            // Vol 2: Japanese only; falls back to ja.
            { id: 'c2a', attributes: { volume: '2', fileName: 'vol2-ja.png', locale: 'ja', updatedAt: '2023-03-29T14:19:23+00:00' } },
            // Vol 3: two English uploads; the newer one wins.
            { id: 'c3a', attributes: { volume: '3', fileName: 'vol3-en-old.jpg', locale: 'en', updatedAt: '2023-11-29T17:56:29+00:00' } },
            { id: 'c3b', attributes: { volume: '3', fileName: 'vol3-en-new.jpg', locale: 'en', updatedAt: '2024-06-01T00:00:00+00:00' } },
            // Invalid volume values are skipped.
            { id: 'c4a', attributes: { volume: 'abc', fileName: 'bad.jpg', locale: 'en', updatedAt: '2023-01-01T00:00:00+00:00' } },
          ],
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover/')) {
        return Response.json({ result: 'ok', response: 'entity', data: { attributes: { fileName: 'file-one.jpg' } } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await mangaDexProvider.getSeriesMetadata('manga-1');

    assert.deepEqual(meta.volumeCovers, [
      { number: 1, url: 'https://uploads.mangadex.org/covers/manga-1/vol1-en.jpg' },
      { number: 2, url: 'https://uploads.mangadex.org/covers/manga-1/vol2-ja.png' },
      { number: 3, url: 'https://uploads.mangadex.org/covers/manga-1/vol3-en-new.jpg' },
    ]);
    // Series cover must be the Volume 1 cover, not the main cover_art.
    assert.equal(meta.coverUrl, 'https://uploads.mangadex.org/covers/manga-1/vol1-en.jpg');
    assert.deepEqual(coverCollectionRequests, [
      'https://api.mangadex.org/cover?manga%5B%5D=manga-1&limit=100&offset=0&order%5Bvolume%5D=asc',
    ]);
  });

  it('keeps series metadata when the cover collection fails', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga/manga-1?')) {
        return Response.json({
          result: 'ok',
          response: 'entity',
          data: {
            id: 'manga-1',
            attributes: { title: { en: 'Series One' }, status: 'ongoing', originalLanguage: 'ja' },
            relationships: [{ id: 'cover-uuid-1', type: 'cover_art' }],
          },
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        return new Response('boom', { status: 500 });
      }
      if (url.startsWith('https://api.mangadex.org/cover/')) {
        return Response.json({ result: 'ok', response: 'entity', data: { attributes: { fileName: 'file-one.jpg' } } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await mangaDexProvider.getSeriesMetadata('manga-1');

    assert.equal(meta.title, 'Series One');
    assert.equal(meta.coverUrl, 'https://uploads.mangadex.org/covers/manga-1/file-one.jpg');
    assert.equal(meta.volumeCovers, undefined);
  });
});
