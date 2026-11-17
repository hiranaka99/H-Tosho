import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

// Isolate the (lazily created) settings DB from any real data dir before the
// provider module (and its settings import) is loaded.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-nhentai-test-'));

const { nhentaiProvider, nhentaiRateLimits } = await import('../src/downloader/nhentai.js');
const { DEFAULT_DOWNLOADER, setDownloaderSettings } = await import('../src/services/settings.js');

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

let requests: Array<{ url: string; init: RequestInit | undefined }>;
let handler: FetchHandler;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, init });
  return handler(url, init);
}) as typeof fetch;

beforeEach(() => {
  // Keep the tests fast: collapse the client-side throttle intervals.
  for (const cls of ['search', 'listing', 'gallery', 'tags', 'suggest'] as const) {
    nhentaiRateLimits.intervalMs[cls] = 0;
    nhentaiRateLimits.anonIntervalMs[cls] = 0;
  }
  nhentaiRateLimits.backoffBaseMs = 1;
  delete process.env.NHENTAI_API_KEY;
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER });
  requests = [];
  handler = () => new Response('{}', { status: 404 });
});

afterEach(() => {
  delete process.env.NHENTAI_API_KEY;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CDN = {
  image_servers: [
    'https://i1.nhentai.net',
    'https://i2.nhentai.net',
    'https://i3.nhentai.net',
  ],
  thumb_servers: ['https://t1.nhentai.net'],
};

const TAGS_BY_ID: Record<number, { id: number; type: string; name: string; slug: string; url: string; count: number }> = {
  10: { id: 10, type: 'artist', name: 'artist a', slug: 'artist-a', url: '/artist/artist-a/', count: 5 },
  20: { id: 20, type: 'tag', name: 'tag x', slug: 'tag-x', url: '/tag/tag-x/', count: 6 },
  30: { id: 30, type: 'parody', name: 'parody p', slug: 'parody-p', url: '/parody/parody-p/', count: 7 },
  40: { id: 40, type: 'group', name: 'circle c', slug: 'circle-c', url: '/group/circle-c/', count: 8 },
  50: { id: 50, type: 'character', name: 'char ch', slug: 'char-ch', url: '/character/char-ch/', count: 9 },
  60: { id: 60, type: 'language', name: 'english', slug: 'english', url: '/language/english/', count: 10 },
  70: { id: 70, type: 'tag', name: 'tag y', slug: 'tag-y', url: '/tag/tag-y/', count: 11 },
};

function searchPayload(): unknown {
  return {
    result: [
      {
        id: 123,
        media_id: 'm123',
        english_title: 'Some Title',
        japanese_title: '日本語タイトル',
        thumbnail: 'galleries/m123/thumb.webp',
        num_pages: 12,
        tag_ids: [10, 20, 30, 40, 50, 60, 70],
      },
    ],
    num_pages: 1,
    per_page: 25,
    total: 1,
  };
}

function galleryDetailPayload(): unknown {
  return {
    id: 123,
    media_id: 'm123',
    title: { english: 'Some Title', japanese: '日本語タイトル', pretty: 'Pretty Title' },
    cover: { path: 'galleries/m123/cover.webp' },
    thumbnail: { path: 'galleries/m123/thumb.webp' },
    scanlator: ' Scan Group ',
    num_pages: 1,
    upload_date: 1700000000,
    tags: Object.values(TAGS_BY_ID),
    pages: [{ number: 1, path: 'galleries/m123/1.jpg', thumbnail: 'galleries/m123/1t.jpg', width: 100, height: 100 }],
  };
}

test('search rows carry tag/artist/series/group/character/language metadata resolved from tag_ids', async () => {
  const tagIdsUrls: string[] = [];
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) return jsonResponse(CDN);
    if (url.includes('/api/v2/search')) return jsonResponse(searchPayload());
    if (url.includes('/api/v2/tags/ids')) {
      tagIdsUrls.push(url);
      const ids = new URL(url).searchParams.get('ids')!.split(',').map(Number);
      return jsonResponse(ids.map((id) => TAGS_BY_ID[id]).filter(Boolean));
    }
    return jsonResponse({}, 404);
  };

  const rows = await nhentaiProvider.search('some query');
  assert.equal(rows.length, 1);
  const row = rows[0] as typeof rows[0] & {
    tagNamespaces?: (string | undefined)[];
    series?: string;
    parodies?: string[];
    groups?: string[];
    characters?: string[];
  };

  assert.equal(row.galleryId, '123');
  assert.equal(row.title, 'Some Title');
  assert.equal(row.pageCount, 12);
  assert.equal(row.coverUrl, 'https://t1.nhentai.net/galleries/m123/thumb.webp');
  assert.equal(row.url, 'https://nhentai.net/g/123/');

  // Tags in tag_ids order, with the parallel namespace array.
  assert.deepEqual(row.tags, ['artist a', 'tag x', 'parody p', 'circle c', 'char ch', 'english', 'tag y']);
  assert.deepEqual(row.tagNamespaces, ['artist', 'tag', 'parody', 'group', 'character', 'language', 'tag']);
  assert.deepEqual(row.artists, ['artist a']);
  assert.deepEqual(row.parodies, ['parody p']);
  assert.equal(row.series, 'parody p');
  assert.deepEqual(row.groups, ['circle c']);
  assert.deepEqual(row.characters, ['char ch']);
  assert.equal(row.language, 'English');

  // All ids of the page were batch-resolved in one /tags/ids call.
  assert.equal(tagIdsUrls.length, 1);
  assert.ok(tagIdsUrls[0].includes('ids=10,20,30,40,50,60,70'));
});

test('search URL uses the documented query/page/sort parameters (no limit param)', async () => {
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) return jsonResponse(CDN);
    if (url.includes('/api/v2/search')) return jsonResponse({ result: [], num_pages: 0, per_page: 25, total: 0 });
    return jsonResponse([]);
  };

  await nhentaiProvider.search('k', 5, 'popular-week');
  const searchReq = requests.find((r) => r.url.includes('/api/v2/search'))!;
  const u = new URL(searchReq.url);
  assert.equal(u.pathname, '/api/v2/search');
  assert.equal(u.searchParams.get('query'), 'k language:english');
  assert.equal(u.searchParams.get('page'), '1');
  assert.equal(u.searchParams.get('sort'), 'popular-week');
  assert.equal(u.searchParams.get('limit'), null);
});

test('API key is sent as `Authorization: Key <key>` on every request', async () => {
  process.env.NHENTAI_API_KEY = 'test-key-123';
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) return jsonResponse(CDN);
    if (url.includes('/api/v2/galleries/123')) return jsonResponse(galleryDetailPayload());
    if (url.includes('/api/v2/tags/search')) return jsonResponse([]);
    return jsonResponse({}, 404);
  };

  await nhentaiProvider.getGallery('123');
  // The CDN config may be cached from earlier tests, so at least the gallery
  // request itself must have fired — and every captured request must carry the
  // documented `Authorization: Key <key>` header.
  assert.ok(requests.length >= 1);
  const authHeaders = requests
    .map((r) => (r.init?.headers as Record<string, string>)?.Authorization)
    .filter(Boolean);
  assert.ok(authHeaders.length === requests.length);
  for (const h of authHeaders) assert.equal(h, 'Key test-key-123');
});

test('suggest uses the official POST /api/v2/tags/search first when an API key is configured', async () => {
  process.env.NHENTAI_API_KEY = 'test-key-123';
  const postBodies: string[] = [];
  handler = (url, init) => {
    if (url.includes('/api/v2/tags/search')) {
      assert.equal(init?.method, 'POST');
      postBodies.push(String(init?.body));
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      assert.equal(auth, 'Key test-key-123');
      assert.equal((init?.headers as Record<string, string>)?.['Content-Type'], 'application/json');
      return jsonResponse([
        { id: 10, type: 'artist', name: 'artist a', slug: 'artist-a', url: '/artist/artist-a/', count: 5 },
      ]);
    }
    return jsonResponse({}, 404);
  };

  const out = await nhentaiProvider.suggest('art', 5);
  // The direct POST answered — no curl subprocess was needed, and the request
  // body followed the documented AutocompleteRequest shape.
  assert.equal(postBodies.length, 1);
  assert.deepEqual(JSON.parse(postBodies[0]), { query: 'art', limit: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'artist');
  assert.equal(out[0].filter, 'artist:"artist a"');
});

test('page URLs use the first image server with same-quality alternates as fallbacks', async () => {
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) return jsonResponse(CDN);
    if (url.includes('/api/v2/galleries/123')) return jsonResponse(galleryDetailPayload());
    return jsonResponse({}, 404);
  };

  const gallery = await nhentaiProvider.getGallery('123');
  assert.equal(gallery.pages[0], 'https://i1.nhentai.net/galleries/m123/1.jpg');
  // Full-res alternate server first — NOT the low-res thumbnail.
  assert.equal(gallery.pageFallbacks?.[0], 'https://i2.nhentai.net/galleries/m123/1.jpg');

  // Detail mapping: scanlator, titleAlt, parodies/groups/characters, language.
  assert.equal(gallery.scanlator, 'Scan Group');
  assert.equal(gallery.title, 'Pretty Title');
  assert.equal(gallery.titleAlt, '日本語タイトル');
  assert.deepEqual(gallery.parodies, ['parody p']);
  assert.equal(gallery.series, 'parody p');
  assert.deepEqual(gallery.groups, ['circle c']);
  assert.deepEqual(gallery.characters, ['char ch']);
  assert.equal(gallery.language, 'English');
  assert.equal(gallery.uploadedAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(gallery.coverUrl, 'https://t1.nhentai.net/galleries/m123/cover.webp');

  // resolvePageUrl with forceRefresh rebuilds against fresh CDN config; with a
  // single image server left, the thumbnail becomes the last-resort fallback.
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) {
      return jsonResponse({ image_servers: ['https://i9.nhentai.net'], thumb_servers: ['https://t9.nhentai.net'] });
    }
    return jsonResponse({}, 404);
  };
  const rebuilt = await gallery.resolvePageUrl!(0, { forceRefresh: true });
  assert.deepEqual(rebuilt, {
    url: 'https://i9.nhentai.net/galleries/m123/1.jpg',
    fallback: 'https://t9.nhentai.net/galleries/m123/1t.jpg',
  });
  assert.equal(await gallery.resolvePageUrl!(5), null);
});

test('429 responses are retried with capped backoff, then succeed', async () => {
  let searchCalls = 0;
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) return jsonResponse(CDN);
    if (url.includes('/api/v2/search')) {
      searchCalls++;
      return searchCalls <= 2 ? jsonResponse({ error: 'slow down' }, 429) : jsonResponse(searchPayload());
    }
    if (url.includes('/api/v2/tags/ids')) return jsonResponse(Object.values(TAGS_BY_ID));
    return jsonResponse({}, 404);
  };

  const rows = await nhentaiProvider.search('k');
  assert.equal(searchCalls, 3);
  assert.equal(rows.length, 1);
});

test('sustained 429 exhausts the bounded retries and surfaces a rate-limit error', async () => {
  let searchCalls = 0;
  handler = (url) => {
    if (url.includes('/api/v2/cdn')) return jsonResponse(CDN);
    if (url.includes('/api/v2/search')) {
      searchCalls++;
      return jsonResponse({ error: 'slow down' }, 429);
    }
    return jsonResponse({}, 404);
  };

  await assert.rejects(
    nhentaiProvider.search('k'),
    /rate-limiting this search/,
  );
  // Initial attempt + nhentaiRateLimits.maxRetries (3) retries.
  assert.equal(searchCalls, 4);
});

for (const { query, expected } of [
  { query: 'artist:"Sample Artist" -tag:"full color" pages:>20 favorites:>=100 uploaded:<7d', expected: 'artist:"Sample Artist" -tag:"full color" pages:>20 favorites:>=100 uploaded:<7d language:english' },
  { query: 'LANGUAGES:"Japanese" sample', expected: 'LANGUAGES:"Japanese" sample' },
  { query: 'artist:mana language:english language:japanese', expected: 'artist:mana language:english language:japanese' },
  { query: '-language:japanese sample', expected: '-language:japanese sample language:english' },
  { query: 'title:"a language:japanese example"', expected: 'title:"a language:japanese example" language:english' },
  { query: '"exact phrase" parodies:sample pages:<=30', expected: '"exact phrase" parodies:sample pages:<=30 language:english' },
]) {
  test(`website query syntax stays intact with the default language: ${query}`, async () => {
    handler = url => url.includes('/api/v2/search') ? jsonResponse({ result: [], num_pages: 0, total: 0 }) : jsonResponse(CDN);
    await nhentaiProvider.search(query);
    assert.equal(new URL(requests.find(request => request.url.includes('/api/v2/search'))!.url).searchParams.get('query'), expected);
  });
}

test('artist searches use exact artist listings with English filtering, bans, and filtered pagination', async () => {
  const artist = { id: 9010, type: 'artist', name: 'mana', slug: 'mana' };
  const english = { id: 9060, type: 'language', name: 'english', slug: 'english' };
  const japanese = { id: 9061, type: 'language', name: 'japanese', slug: 'japanese' };
  const banned = { id: 9020, type: 'tag', name: 'blocked tag', slug: 'blocked-tag' };
  const other = { id: 9011, type: 'artist', name: 'manatsu', slug: 'manatsu' };
  const rows = [
    { id: 9001, english_title: 'English one', tag_ids: [9010, 9060], num_pages: 12 },
    { id: 9002, english_title: 'Japanese', tag_ids: [9010, 9061], num_pages: 13 },
    { id: 9003, english_title: 'English banned', tag_ids: [9010, 9060, 9020], num_pages: 14 },
    { id: 9004, english_title: 'English two', tag_ids: [9010, 9060], num_pages: 15 },
    { id: 9005, english_title: 'Wrong artist', tag_ids: [9011, 9060], num_pages: 16 },
  ];
  handler = (raw) => {
    const url = new URL(raw);
    if (url.pathname === '/api/v2/cdn') return jsonResponse(CDN);
    if (url.pathname === '/api/v2/tags/artist/mana') return jsonResponse(artist);
    if (url.pathname === '/api/v2/tags/language/english') return jsonResponse(english);
    if (url.pathname === '/api/v2/tags/language/japanese') return jsonResponse(japanese);
    if (url.pathname === '/api/v2/tags/ids') return jsonResponse([artist, english, japanese, banned, other]);
    if (url.pathname === '/api/v2/galleries/tagged') {
      assert.equal(url.searchParams.get('tag_id'), '9010');
      assert.equal(url.searchParams.get('sort'), 'popular-week');
      assert.equal(url.searchParams.get('per_page'), '100');
      return jsonResponse({ result: url.searchParams.get('page') === '1' ? rows.slice(0, 3) : rows.slice(3), num_pages: 2, per_page: 3, total: null });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, nhentaiBannedTags: ['blocked tag'] });
  const first = await nhentaiProvider.searchPage!('artist:"mana"', 0, 1, 'popular-week');
  assert.equal(first.total, 2);
  assert.deepEqual(first.items.map((row) => row.galleryId), ['9001']);
  assert.deepEqual(first.items[0].artists, ['mana']);
  const next = await nhentaiProvider.searchPage!('artist:mana', 1, 1, 'popular-week');
  assert.equal(next.total, 2);
  assert.deepEqual(next.items.map((row) => row.galleryId), ['9004']);
  assert.equal(requests.filter((r) => r.url.includes('/galleries/tagged')).length, 2, 'paging reuses the artist index');
  assert.deepEqual((await nhentaiProvider.search('https://nhentai.net/artist/mana/', 10, 'popular-week')).map((row) => row.galleryId), ['9001', '9004']);
  const explicit = await nhentaiProvider.searchPage!('language:japanese artist:"mana"', 0, 25, 'popular-week');
  assert.deepEqual(explicit.items.map((row) => row.galleryId), ['9002']);
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, nhentaiBannedTags: [] });
  assert.equal((await nhentaiProvider.searchPage!('artist:mana', 0, 25, 'popular-week')).total, 3, 'changed bans apply to the cached index');
  assert.ok(!requests.some((r) => new URL(r.url).pathname === '/api/v2/search'));
});

test('an unknown exact artist returns no matches without falling back to fuzzy search', async () => {
  handler = () => jsonResponse({}, 404);
  assert.deepEqual(await nhentaiProvider.searchPage!('artist:"no such exact artist"', 0, 25), { items: [], total: 0 });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/tags/artist/no-such-exact-artist'));
});

test('artist listing failures remain errors and can be retried', async () => {
  const artist = { id: 9990, type: 'artist', name: 'retry artist', slug: 'retry-artist' };
  let fail = true;
  handler = (url) => {
    if (url.endsWith('/tags/artist/retry-artist')) return jsonResponse(artist);
    if (url.includes('/tags/language/english')) return jsonResponse({ id: 9060, type: 'language', name: 'english', slug: 'english' });
    if (url.includes('/galleries/tagged')) return fail ? jsonResponse({}, 403) : jsonResponse({ result: [], num_pages: 0 });
    throw new Error('Unexpected request');
  };
  await assert.rejects(nhentaiProvider.search('artist:"retry artist"'), /artist listing failed/);
  fail = false;
  assert.deepEqual(await nhentaiProvider.search('artist:"retry artist"'), []);
});

test('configured exclusions preserve scoped multi-word tags', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, nhentaiBannedTags: ['full color', 'artists:"Sample Artist"', 'FULL COLOR'] });
  handler = url => url.includes('/api/v2/search') ? jsonResponse({ result: [], num_pages: 0, total: 0 }) : jsonResponse(CDN);
  await nhentaiProvider.search('sample');
  assert.equal(new URL(requests.find(request => request.url.includes('/api/v2/search'))!.url).searchParams.get('query'), 'sample language:english -"full color" -artist:"Sample Artist"');
});

for (const sort of ['default', 'popular', 'popular-today', 'popular-week', 'popular-month', 'popular-year'] as const) {
  test(`search forwards the documented nHentai sort: ${sort}`, async () => {
    handler = url => url.includes('/api/v2/search') ? jsonResponse({ result: [], num_pages: 0, total: 0 }) : jsonResponse(CDN);
    await nhentaiProvider.search('sample', 5, sort);
    const supported = sort !== 'default' && sort !== 'popular-year';
    assert.equal(new URL(requests.find(request => request.url.includes('/api/v2/search'))!.url).searchParams.get('sort'), supported ? sort : null);
  });
}

function pagePayload(page: number, total: number, perPage = 25) {
  return {
    result: Array.from({ length: Math.max(0, Math.min(perPage, total - (page - 1) * perPage)) }, (_, index) => ({
      id: (page - 1) * perPage + index + 1, english_title: 'Sample title', num_pages: 28, tag_ids: [],
    })),
    num_pages: Math.ceil(total / perPage), per_page: perPage, total,
  };
}

test('paged searches access matches beyond the old 250-result ceiling with one search request', async () => {
  handler = url => url.includes('/api/v2/search') ? jsonResponse(pagePayload(Number(new URL(url).searchParams.get('page')), 1301)) : jsonResponse(CDN);
  const result = await nhentaiProvider.searchPage!('sample', 1100, 25, 'popular-week');
  assert.equal(result.total, 1301);
  assert.deepEqual(result.items.map(item => Number(item.galleryId)), Array.from({ length: 25 }, (_, index) => 1101 + index));
  const searches = requests.filter(request => request.url.includes('/api/v2/search'));
  assert.equal(searches.length, 1);
  assert.equal(new URL(searches[0].url).searchParams.get('page'), '45');
  assert.equal(new URL(searches[0].url).searchParams.get('query'), 'sample language:english');
});

test('unaligned search windows slice adjacent API pages without duplicates', async () => {
  handler = url => url.includes('/api/v2/search') ? jsonResponse(pagePayload(Number(new URL(url).searchParams.get('page')), 60)) : jsonResponse(CDN);
  const result = await nhentaiProvider.searchPage!('sample', 24, 3);
  assert.equal(result.total, 60);
  assert.deepEqual(result.items.map(item => Number(item.galleryId)), [25, 26, 27]);
  assert.equal(requests.filter(request => request.url.includes('/api/v2/search')).length, 2);
});

test('nullable totals use the last native page for an exact count', async () => {
  handler = url => url.includes('/api/v2/search') ? jsonResponse({ ...pagePayload(Number(new URL(url).searchParams.get('page')), 52), total: null }) : jsonResponse(CDN);
  const result = await nhentaiProvider.searchPage!('sample', 0, 25);
  assert.equal(result.total, 52);
  assert.equal(result.items.length, 25);
  assert.deepEqual(requests.filter(request => request.url.includes('/api/v2/search')).map(request => new URL(request.url).searchParams.get('page')), ['1', '3']);
});

test('a changed API page size is honored when resolving an offset', async () => {
  handler = url => url.includes('/api/v2/search') ? jsonResponse(pagePayload(Number(new URL(url).searchParams.get('page')), 63, 10)) : jsonResponse(CDN);
  const result = await nhentaiProvider.searchPage!('sample', 20, 5);
  assert.equal(result.total, 63);
  assert.deepEqual(result.items.map(item => Number(item.galleryId)), [21, 22, 23, 24, 25]);
  assert.deepEqual(requests.filter(request => request.url.includes('/api/v2/search')).map(request => new URL(request.url).searchParams.get('page')), ['1', '3']);
});

test('gallery URLs and #IDs resolve directly without adding search filters', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, nhentaiBannedTags: ['sample'] });
  handler = url => url.includes('/api/v2/galleries/123') ? jsonResponse(galleryDetailPayload()) : jsonResponse(CDN);
  for (const query of ['https://nhentai.net/g/123/', '#123']) {
    const result = await nhentaiProvider.searchPage!(query, 0, 25);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].galleryId, '123');
  }
  assert.ok(!requests.some(request => request.url.includes('/api/v2/search')));
});

test('scoped autocomplete uses the website aliases, unquotes prefixes and retains typed names', async () => {
  process.env.NHENTAI_API_KEY = 'test-key';
  handler = (url, init) => {
    assert.equal(url, 'https://nhentai.net/api/v2/tags/search');
    assert.deepEqual(JSON.parse(String(init?.body)), { type: 'artist', query: 'sample artist', limit: 5 });
    return jsonResponse([{ type: 'artist', name: 'Sample Artist', count: 42 }]);
  };
  const result = await nhentaiProvider.suggest!('-artists:"sample artist', 5);
  assert.equal(result[0].filter, 'artist:"Sample Artist"');
});

test('numeric, date and title autocomplete never waste a tag API request', async () => {
  for (const query of ['pages:>20', 'uploaded:7d', 'favorites:>=100', 'title:"sample"']) assert.deepEqual(await nhentaiProvider.suggest!(query), []);
  assert.equal(requests.length, 0);
});
