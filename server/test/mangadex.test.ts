import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mangaDexProvider, parseDescriptionTags, stripDescriptionTagLines } from '../src/providers/mangadex.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MangaDexProvider cover URLs', () => {
  it('resolves search candidate covers in one batched /cover collection request', async () => {
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
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        coverRequests.push(url);
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            // Only manga-1's cover resolves; manga-2's row is absent, which is
            // the bulk equivalent of the old per-id 404 → no thumbnail.
            {
              id: 'cover-uuid-1',
              attributes: { fileName: 'file-one.jpg' },
              relationships: [{ id: 'manga-1', type: 'manga' }],
            },
          ],
        });
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
    // The CDN path must use the fileName served by the /cover collection; using
    // the raw cover relationship id as the file name 404s on uploads.mangadex.org.
    assert.equal(results[0].coverUrl, 'https://uploads.mangadex.org/covers/manga-1/file-one.jpg');
    // An unresolvable cover degrades to no thumbnail instead of a broken URL.
    assert.equal(results[1].coverUrl, undefined);
    assert.equal(results[2].coverUrl, undefined);
    // One batched collection request covers every cover-bearing candidate.
    assert.equal(coverRequests.length, 1);
    const coverParams = new URL(coverRequests[0]).searchParams;
    assert.deepEqual(coverParams.getAll('manga[]').sort(), ['manga-1', 'manga-2', 'manga-3']);
    assert.equal(coverParams.get('limit'), '100');
  });

  it('retries an empty long-title search without glue words', async () => {
    const searchQueries: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga?')) {
        const title = new URL(url).searchParams.get('title') ?? '';
        searchQueries.push(title);
        if (searchQueries.length === 1) return Response.json({ result: 'ok', response: 'collection', data: [] });
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [{
            id: '1d2967dd-d157-4cbb-84ed-ea7cf7140d14',
            attributes: {
              title: { 'ja-ro': 'Yume de Furarete Hajimaru Yuri' },
              altTitles: [{ en: 'A Yuri Love Story That Begins with Getting Dumped in a Dream' }],
            },
            relationships: [],
          }],
        });
      }
      if (url.startsWith('https://api.mangadex.org/cover?')) {
        return Response.json({ result: 'ok', response: 'collection', data: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const results = await mangaDexProvider.search('Our Yuri Started with Me Getting Rejected in a Dream');

    assert.deepEqual(searchQueries, [
      'Our Yuri Started with Me Getting Rejected in a Dream',
      'Yuri Started Getting Rejected Dream',
    ]);
    assert.equal(results[0]?.providerSeriesId, '1d2967dd-d157-4cbb-84ed-ea7cf7140d14');
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
            attributes: { title: { en: 'When Mama and Papa Aren\'t Home' }, altTitles: [{ 'ja-ro': 'Papa to Mama ga Inai Aida ni...' }, { ja: 'パパとママがいない間に…' }], year: 2020, status: 'completed', originalLanguage: 'ja' },
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
    assert.deepEqual(meta.titleOptions, ["When Mama and Papa Aren't Home", 'Papa to Mama ga Inai Aida ni...', 'パパとママがいない間に…']);
  });

  it('offers every title variant as a ComicInfo.Series option, not just display + romanized', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga/manga-1?')) {
        return Response.json({
          result: 'ok',
          response: 'entity',
          data: {
            id: 'manga-1',
            attributes: {
              title: { en: 'DH! ~Himorogi Hyaku Yome Gatari~' },
              altTitles: [
                { en: 'Demon-Hentai - Shrine of One Hundred Wives' },
                { ja: 'でぃーエッチ！〜ひもろぎ百嫁語〜' },
              ],
              status: 'completed',
              originalLanguage: 'ja',
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

    // The matcher can select any variant as the candidate title (bestVariant), so
    // every one must survive apply validation — including an alternate English
    // title that is neither the display title nor a romanization.
    assert.deepEqual(meta.titleOptions, [
      'DH! ~Himorogi Hyaku Yome Gatari~',
      'Demon-Hentai - Shrine of One Hundred Wives',
      'でぃーエッチ！〜ひもろぎ百嫁語〜',
    ]);
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

    // A fresh manga id: the Volume-1 test above caches manga-1's cover in the
    // provider's TTL cache, which must not leak into this scenario.
    assert.equal(await mangaDexProvider.preferredSeriesCoverUrl('manga-no-vol1'), undefined);

    globalThis.fetch = async () => new Response('boom', { status: 500 });
    assert.equal(await mangaDexProvider.preferredSeriesCoverUrl('manga-no-vol1'), undefined);
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

  it('extracts table rows with decorated namespace cells (captured Imouto description shape)', () => {
    const desc = [
      '1. Instead of her boyfriend...',
      '2. Since you asked for a video...',
      '',
      '| Namespace | Tags |',
      '| :- | :- |',
      '|-**MALE**: | bondage, cheating, mouth mask, orgasm denial, sole male',
      '|-**FEMALE**: | ahegao, anal, big breasts, blowjob, cheating, cunnilingus',
      '|-**MIXED** : | ffm threesome, group, incest',
      '|-**OTHER**: | story arc, tankoubon',
    ].join('\n');
    assert.deepEqual(parseDescriptionTags(desc), [
      'bondage', 'cheating', 'mouth mask', 'orgasm denial', 'sole male',
      'ahegao', 'anal', 'big breasts', 'blowjob', 'cunnilingus',
      'ffm threesome', 'group', 'incest',
      'story arc', 'tankoubon',
    ]);
  });

  it('extracts bold-label lines with a trailing colon and ignores decorated unknown namespaces', () => {
    assert.deepEqual(parseDescriptionTags('**FEMALE**: ahegao, anal'), ['ahegao', 'anal']);
    assert.deepEqual(parseDescriptionTags('|-**NOTE**: | hello, world'), []);
  });
});

describe('stripDescriptionTagLines', () => {
  it('removes markdown-table tag blocks including header and separator rows (captured Aizome shape)', () => {
    const desc = [
      '1. Sleep Learning',
      '2. All for Love',
      '',
      '| Namespace | Tags |',
      '|:-|:-',
      '|MALE| glasses, harem',
      '|FEMALE| ahegao, big breasts',
      '|OTHER| tankoubon',
    ].join('\n');
    assert.equal(stripDescriptionTagLines(desc), '1. Sleep Learning\n2. All for Love');
  });

  it('removes bold-label tag blocks including the bare TAGS header (captured KonoSuba parody shape)', () => {
    const desc = [
      "Instead of Kuzuma, we got a big ol'bald guy who got isekai.",
      '',
      '**TAGS**',
      '**PARODY** kono subarashii sekai ni syukufuku o',
      '**CHARACTER** aqua, megumin',
      '**MALE** bald, muscle',
    ].join('\n');
    assert.equal(stripDescriptionTagLines(desc), "Instead of Kuzuma, we got a big ol'bald guy who got isekai.");
  });

  it('removes standalone Tags: lines; returns "" when only tags remain, undefined when nothing matches', () => {
    assert.equal(stripDescriptionTagLines('A story.\nTags: Cheating, Milf'), 'A story.');
    assert.equal(stripDescriptionTagLines('Tags: Cheating, Milf'), '');
    assert.equal(stripDescriptionTagLines('Just a plain description.'), undefined);
    assert.equal(stripDescriptionTagLines(null), undefined);
  });

  it('keeps pipe tables and bold runs that contain no known namespace', () => {
    const desc = [
      '| Vol | Title |',
      '|:-|:-|',
      '|1| First |',
      '',
      '**Note:** not a tag block.',
    ].join('\n');
    assert.equal(stripDescriptionTagLines(desc), undefined);
  });

  it('removes decorated-namespace table blocks, keeping the prose above them', () => {
    const desc = [
      '1. Instead of her boyfriend...',
      '2. Since you asked for a video...',
      '',
      '| Namespace | Tags |',
      '| :- | :- |',
      '|-**MALE**: | bondage, cheating',
      '|-**FEMALE**: | ahegao, anal',
    ].join('\n');
    assert.equal(stripDescriptionTagLines(desc), '1. Instead of her boyfriend...\n2. Since you asked for a video...');
  });

  it('keeps decorated-namespace table rows whose namespace is unknown', () => {
    assert.equal(stripDescriptionTagLines('|-**NOTE**: | hello, world'), undefined);
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
                { id: 't1', attributes: { name: { en: 'Loli' }, group: 'theme' } },
                { id: 't2', attributes: { name: { en: 'Incest' }, group: 'genre' } },
              ],
              description: {
                en: [
                  'A doujinshi about school life.',
                  '',
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
    // Only the structured tag classified as a genre by MangaDex lands in genres;
    // themes and description-extracted tags stay in tags only.
    assert.deepEqual(meta.genres, ['Incest']);
    // The tag table is stripped from the summary; prose survives.
    assert.equal(meta.summary, 'A doujinshi about school life.');
  });

  it('yields an empty summary (not undefined) when the description is tag blocks only', async () => {
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
              tags: [{ id: 't1', attributes: { name: { en: 'Loli' }, group: 'theme' } }],
              description: {
                en: [
                  '| Namespace | Tags |',
                  '|:-|:-',
                  '|MALE| glasses, harem',
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

    // No prose survives the strip — an empty summary (not undefined) so sync
    // clears any stale tag table already in Kavita.
    assert.equal(meta.summary, '');
    assert.deepEqual(meta.tags, ['Loli', 'glasses', 'harem', 'tankoubon']);
  });
  it('splits structured tags into genres by MangaDex group (captured KonoSuba parody shape)', async () => {
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
              status: 'ongoing',
              originalLanguage: 'ja',
              tags: [
                { id: 't1', attributes: { name: { en: 'Loli' }, group: 'theme' } },
                { id: 't2', attributes: { name: { en: 'Magic' }, group: 'theme' } },
                { id: 't3', attributes: { name: { en: 'Harem' }, group: 'theme' } },
                { id: 't4', attributes: { name: { en: 'Isekai' }, group: 'genre' } },
                { id: 't5', attributes: { name: { en: 'Doujinshi' }, group: 'format' } },
                { id: 't6', attributes: { name: { en: 'Fantasy' }, group: 'genre' } },
              ],
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

    // Mirrors the MangaDex page: Genres shows Fantasy + Isekai only, while
    // themes (Loli, Magic, Harem) and format (Doujinshi) are tags.
    assert.deepEqual(meta.genres, ['Isekai', 'Fantasy']);
    assert.deepEqual(meta.tags, ['Loli', 'Magic', 'Harem', 'Isekai', 'Doujinshi', 'Fantasy']);
  });
});

describe('MangaDexProvider inlined cover_art', () => {
  it('uses cover_art fileNames from search and detail relationships without /cover round-trips', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('https://api.mangadex.org/manga?')) {
        return Response.json({ result: 'ok', data: [{ id: 'manga-9', attributes: { title: { en: 'Inline' } }, relationships: [{ id: 'cover-9', type: 'cover_art', attributes: { fileName: 'inline.jpg' } }] }] });
      }
      if (url.startsWith('https://api.mangadex.org/manga/manga-9?')) {
        return Response.json({ result: 'ok', data: { id: 'manga-9', attributes: { title: { en: 'Inline' } }, relationships: [{ id: 'cover-9', type: 'cover_art', attributes: { fileName: 'inline.jpg' } }] } });
      }
      if (url.startsWith('https://api.mangadex.org/cover?manga%5B%5D=manga-9&limit=100&offset=')) {
        return Response.json({ result: 'ok', data: [] }); // volume covers only
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const [result] = await mangaDexProvider.search('inline');
    assert.equal(result.coverUrl, 'https://uploads.mangadex.org/covers/manga-9/inline.jpg');
    assert.ok(new URL(urls[0]).searchParams.getAll('includes[]').includes('cover_art'));
    const meta = await mangaDexProvider.getSeriesMetadata('manga-9');
    assert.equal(meta.coverUrl, 'https://uploads.mangadex.org/covers/manga-9/inline.jpg');
    const detail = urls.find((url) => url.startsWith('https://api.mangadex.org/manga/manga-9?'))!;
    assert.ok(new URL(detail).searchParams.getAll('includes[]').includes('cover_art'));
    assert.ok(!urls.some((url) => url.startsWith('https://api.mangadex.org/cover/')), 'no per-id cover lookup');
  });

  it('honors an aborted signal', async () => {
    globalThis.fetch = async () => { throw new Error('fetch must not run'); };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(mangaDexProvider.search('anything', undefined, controller.signal));
  });
});
