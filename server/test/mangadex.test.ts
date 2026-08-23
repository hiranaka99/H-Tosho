import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mangaDexProvider, parseDescriptionTags } from '../src/providers/mangadex.js';

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

  it('preferredSeriesCoverUrl returns the Volume 1 cover for dialog previews', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            // Main cover_art has no volume and must not be returned.
            { id: 'c0', attributes: { volume: null, fileName: 'main.jpg', locale: 'ja', updatedAt: '2021-01-01T00:00:00+00:00' } },
            // Vol 1 exists in two locales; English wins even though ja is newer.
            { id: 'c1a', attributes: { volume: '1', fileName: 'vol1-en.jpg', locale: 'en', updatedAt: '2023-02-20T23:52:26+00:00' } },
            { id: 'c1b', attributes: { volume: '1', fileName: 'vol1-ja.jpg', locale: 'ja', updatedAt: '2024-01-01T00:00:00+00:00' } },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    assert.equal(
      await mangaDexProvider.preferredSeriesCoverUrl('manga-1'),
      'https://uploads.mangadex.org/covers/manga-1/vol1-en.jpg',
    );
  });

  it('preferredSeriesCoverUrl returns undefined without a Volume 1 cover or when the collection fails', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            { id: 'c0', attributes: { volume: null, fileName: 'main.jpg', locale: 'ja', updatedAt: '2021-01-01T00:00:00+00:00' } },
            { id: 'c2', attributes: { volume: '2', fileName: 'vol2-ja.png', locale: 'ja', updatedAt: '2023-03-29T14:19:23+00:00' } },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    assert.equal(await mangaDexProvider.preferredSeriesCoverUrl('manga-1'), undefined);

    globalThis.fetch = async () => new Response('boom', { status: 500 });
    assert.equal(await mangaDexProvider.preferredSeriesCoverUrl('manga-1'), undefined);
  });
});

describe('parseDescriptionTags', () => {
  it('extracts markdown-table tag rows (captured Aizome description)', () => {
    const desc = [
      '1. Sleep Learning',
      '2. All for Love',
      '',
      '| Namespace | Tags |',
      '|:-|:-',
      '|MALE| glasses, harem, schoolboy uniform, sleeping, virginity',
      '|FEMALE| ahegao, big breasts, blowjob, cunnilingus',
      '|MIXED| group, incest, mmf threesome',
      '|OTHER| tankoubon',
    ].join('\n');
    assert.deepEqual(parseDescriptionTags(desc), [
      'glasses', 'harem', 'schoolboy uniform', 'sleeping', 'virginity',
      'ahegao', 'big breasts', 'blowjob', 'cunnilingus',
      'group', 'incest', 'mmf threesome', 'tankoubon',
    ]);
  });

  it('extracts bold-label tag lines (captured KonoSuba parody description)', () => {
    const desc = [
      "Instead of Kuzuma, we got a big ol'bald guy who got isekai and chose the power of Hypnosis\\",
      'With it, he makes Megumin his \u25efna\u25efle',
      '',
      '**TAGS**',
      '**PARODY** kono subarashii sekai ni syukufuku o',
      '**CHARACTER** aqua, megumin',
      '**MALE** bald, big penis, muscle',
      '**FEMALE** asphyxiation, bandages, bikini',
      '**MIXED** ffm threesome, group',
      '**OTHER** multi-work series',
    ].join('\n');
    assert.deepEqual(parseDescriptionTags(desc), [
      'kono subarashii sekai ni syukufuku o', 'aqua', 'megumin',
      'bald', 'big penis', 'muscle',
      'asphyxiation', 'bandages', 'bikini',
      'ffm threesome', 'group', 'multi-work series',
    ]);
  });

  it('handles the hybrid table-header + bold-rows format with stray pipes', () => {
    const desc = [
      '| NAMESPACE | TAGS |',
      '| :- | :- |',
      '**MALE** | shotacon',
      '**FEMALE** | anal, cheating',
    ].join('\n');
    assert.deepEqual(parseDescriptionTags(desc), ['shotacon', 'anal', 'cheating']);
  });

  it('extracts plain Tags: lines case-insensitively', () => {
    assert.deepEqual(
      parseDescriptionTags("Oolong did what every 90's kid wanted to do.\nTags: Mind break, Mind control, Rape."),
      ['Mind break', 'Mind control', 'Rape'],
    );
    assert.deepEqual(parseDescriptionTags('tags: bunny girl, cheating'), ['bunny girl', 'cheating']);
  });

  it('dedupes case-insensitively across formats and keeps first spelling', () => {
    const desc = '|MALE| glasses, harem\n**FEMALE** Glasses, Harem, bikini';
    assert.deepEqual(parseDescriptionTags(desc), ['glasses', 'harem', 'bikini']);
  });

  it('ignores prose, unknown namespaces, and header-only lines', () => {
    const desc = [
      'The tags on this volume are wrong.',
      'A story about a witch and her friends. **Note:** not a tag line.',
      '|MALE|', // no value
      '**TAGS**', // header, no value
      '| NAMESPACE | TAGS |',
    ].join('\n');
    assert.deepEqual(parseDescriptionTags(desc), []);
  });

  it('caps the result at 60 tags and accepts null/empty input', () => {
    const many = Array.from({ length: 70 }, (_, i) => `tag${i}`).join(', ');
    assert.equal(parseDescriptionTags(`|MALE| ${many}`).length, 60);
    assert.deepEqual(parseDescriptionTags(null), []);
    assert.deepEqual(parseDescriptionTags(undefined), []);
    assert.deepEqual(parseDescriptionTags(''), []);
  });
});

describe('MangaDexProvider description tag merging', () => {
  it('appends parsed description tags after structured tags, deduped case-insensitively', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga/manga-1?')) {
        return Response.json({
          result: 'ok',
          response: 'entity',
          data: {
            id: 'manga-1',
            attributes: {
              title: { en: 'Series One' },
              status: 'completed',
              originalLanguage: 'ja',
              tags: [
                { id: 't1', attributes: { name: { en: 'Loli' } } },
                { id: 't2', attributes: { name: { en: 'Incest' } } },
              ],
              description: {
                en: [
                  '| Namespace | Tags |',
                  '|:-|:-',
                  '|MALE| glasses, harem',
                  '|MIXED| group, incest, mmf threesome',
                  '|OTHER| tankoubon',
                ].join('\n'),
              },
            },
            relationships: [],
          },
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        return Response.json({ result: 'ok', response: 'collection', data: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await mangaDexProvider.getSeriesMetadata('manga-1');

    // Structured tags keep their position and canonical spelling; 'incest'
    // from the table is deduped against structured 'Incest'.
    assert.deepEqual(meta.tags, ['Loli', 'Incest', 'glasses', 'harem', 'group', 'mmf threesome', 'tankoubon']);
    assert.deepEqual(meta.genres, meta.tags);
  });
});
