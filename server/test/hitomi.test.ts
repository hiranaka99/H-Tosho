import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

// Isolate the (lazily created) settings DB from any real data dir before the
// provider module (and its settings import) is loaded.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-hitomi-test-'));

const { hitomiProvider } = await import('../src/downloader/hitomi.js');
const { DEFAULT_DOWNLOADER, setDownloaderSettings } = await import('../src/services/settings.js');

const API_BASE = 'https://ltn.gold-usergeneratedcontent.net';
const VERSION = 'v-test';

// ---------------------------------------------------------------------------
// Mock world
// ---------------------------------------------------------------------------
// One consistent world for every test in this file: the provider module caches
// the galleriesindex version on first use, so all searches resolve against the
// same B-tree root built below.
//
// "cat" → ids 101..108 (newest-first), types interleaved so image set / artist
// CG entries sit between kept ones:
//   101 doujinshi, 102 imageset, 103 artistcg, 104 manga,
//   105 doujinshi, 106 imageset, 107 doujinshi, 108 doujinshi
// "dog" → ids 201..230, every one an image set (type-heavy query).
// "loli" → two cat galleries (banned-tag tests).

const CAT_IDS = [101, 102, 103, 104, 105, 106, 107, 108];
const DOG_IDS = Array.from({ length: 30 }, (_, i) => 201 + i);
const LOLI_IDS = [105, 107];
const MOON_IDS = [101, 104, 108, 301];
const MANY_IDS = Array.from({ length: 1301 }, (_, index) => 40_001 + index);
const TYPE_BY_ID: Record<number, string> = Object.fromEntries([
  ...CAT_IDS.map((id) => [id, 'doujinshi']),
  [102, 'imageset'],
  [103, 'artistcg'],
  [104, 'manga'],
  [106, 'imageset'],
  ...DOG_IDS.map((id) => [id, 'imageset']),
  [301, 'doujinshi'],
  ...MANY_IDS.map(id => [id, 'doujinshi']),
  [40_026, 'imageset'],
]);

function hashTerm(term: string): Uint8Array {
  return new Uint8Array(crypto.createHash('sha256').update(term, 'utf8').digest().subarray(0, 4));
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

/** B-tree node buffer: the given keys each with one data pointer. */
function btreeNodeBuffer(keys: Uint8Array[], datas: [number, number][]): Buffer {
  const int32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const parts: number[] = [...int32(keys.length)];
  for (const key of keys) parts.push(...int32(4), ...key);
  parts.push(...int32(datas.length));
  for (const [off, len] of datas) {
    // uint64 BE offset (high word zero), int32 BE length.
    parts.push(0, 0, 0, 0, ...int32(off));
    parts.push(...int32(len));
  }
  for (let i = 0; i < 17; i++) parts.push(0, 0, 0, 0, 0, 0, 0, 0); // B+1 subnodes, all zero
  return Buffer.from(parts);
}

/** Big-endian int32 id list (the `.data` / `.nozomi` payload shape). */
function idsBuffer(ids: number[]): Buffer {
  const buf = Buffer.alloc(4 + ids.length * 4);
  buf.writeInt32BE(ids.length, 0);
  ids.forEach((id, i) => buf.writeInt32BE(id, 4 + i * 4));
  return buf;
}

const CAT_DATA_OFFSET = 1_000_000;
const DOG_DATA_OFFSET = 2_000_000;
const LOLI_DATA_OFFSET = 3_000_000;
const MOON_DATA_OFFSET = 4_000_000;
const BLUE_DATA_OFFSET = 5_000_000;
const MANY_DATA_OFFSET = 6_000_000;
const catData = idsBuffer(CAT_IDS);
const dogData = idsBuffer(DOG_IDS);
const loliData = idsBuffer(LOLI_IDS);
const moonData = idsBuffer(MOON_IDS);
const blueData = idsBuffer([101, 103]);
const manyData = idsBuffer(MANY_IDS);
// The `.data` file serves every term's id list; look it up by range offset.
const DATA_BY_OFFSET: Record<number, Buffer> = {
  [CAT_DATA_OFFSET]: catData,
  [DOG_DATA_OFFSET]: dogData,
  [LOLI_DATA_OFFSET]: loliData,
  [MOON_DATA_OFFSET]: moonData,
  [BLUE_DATA_OFFSET]: blueData,
  [MANY_DATA_OFFSET]: manyData,
};
const rootEntries = [
  { key: hashTerm('cat'), offset: CAT_DATA_OFFSET, data: catData },
  { key: hashTerm('dog'), offset: DOG_DATA_OFFSET, data: dogData },
  { key: hashTerm('loli'), offset: LOLI_DATA_OFFSET, data: loliData },
  { key: hashTerm('moon'), offset: MOON_DATA_OFFSET, data: moonData },
  { key: hashTerm('blue sky'), offset: BLUE_DATA_OFFSET, data: blueData },
  { key: hashTerm('many'), offset: MANY_DATA_OFFSET, data: manyData },
].sort((a, b) => cmpBytes(a.key, b.key));
const rootNodeBuffer = btreeNodeBuffer(
  rootEntries.map((e) => e.key),
  rootEntries.map((e) => [e.offset, e.data.length]),
);

function galleryInfo(id: number): string {
  return `var galleryinfo = ${JSON.stringify({
    id,
    title: `Cat Gallery ${id}`,
    language: id === 301 ? 'japanese' : 'english',
    type: TYPE_BY_ID[id],
    date: id === 101 ? '2026-08-01' : '2026-08-01 00:00:00',
    files: [{ name: 'page1.jpg', hash: 'ab'.repeat(32), haswebp: 1 }],
    tags: [],
    artists: [],
    groups: id === 101 ? [{ group: 'shirukke no ooi zakuro', url: '/group/shirukke-no-ooi-zakuro-all.html' }] : [],
  })};`;
}

// Trivial routing table satisfying loadGG's shape check (m/s functions, b string).
const GG_JS = 'gg.m = function (g) { return 0; }; gg.s = function (h) { return "/p/"; }; gg.b = "base/";';

let fetchedUrls: string[] = [];
let servedVersion = VERSION;
const NOZOMI: Record<string, number[]> = {
  '/n/artist/evil-all.nozomi': [104],
  '/n/index-english.nozomi': [...CAT_IDS, ...DOG_IDS],
  '/n/index-japanese.nozomi': [301],
  '/n/index-all.nozomi': [...CAT_IDS, ...DOG_IDS, 301, ...MANY_IDS],
  '/n/type/imageset-all.nozomi': [102, 106, ...DOG_IDS, 40_026],
  '/n/artist/sample group-all.nozomi': [104, 101, 108],
  '/n/tag/female:blue sky-all.nozomi': [101, 108],
  '/n/popular/year-english.nozomi': [108, 104, 105, 101, 107, 103, 102, 106],
  '/n/popular/month-english.nozomi': [103, 107, 101],
  '/n/popular/week-english.nozomi': [101, 104, 108],
  '/n/popular/today-english.nozomi': [107, 101],
  '/n/artist/popular/week/sample group-all.nozomi': [108, 101, 104],
  '/n/date/published-english.nozomi': [104, 108, 101, 107, 105, 103, 102, 106],
};

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  fetchedUrls.push(url);
  if (url.includes('/galleriesindex/version')) return new Response(servedVersion);
  if (url.endsWith('.index')) return new Response(rootNodeBuffer);
  if (url.endsWith('.data')) {
    const range = String((init?.headers as Record<string, string> | undefined)?.Range ?? '');
    const offset = Number(range.replace(/^bytes=/, '').split('-')[0]);
    return new Response(DATA_BY_OFFSET[offset] ?? Buffer.alloc(4));
  }
  if (url.includes('/n/')) {
    const ids = NOZOMI[decodeURI(new URL(url).pathname)];
    return ids ? new Response(idsBuffer(ids).subarray(4)) : new Response(null, { status: 404 });
  }
  if (url.startsWith('https://tagindex.hitomi.la/')) return new Response(JSON.stringify([['Sample Group', 42, 'artist']]));
  const gallery = /\/galleries\/(\d+)\.js$/.exec(url);
  if (gallery) {
    const id = Number(gallery[1]);
    if (!TYPE_BY_ID[id]) throw new Error(`Unexpected gallery fetch: ${url}`);
    return new Response(galleryInfo(id));
  }
  if (url.endsWith('/gg.js')) return new Response(GG_JS);
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

beforeEach(() => {
  fetchedUrls = [];
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('gallery details retain Hitomi group objects for circle display and ComicInfo metadata', async () => {
  const gallery = await hitomiProvider.getGallery('101');
  assert.deepEqual(gallery.groups, ['shirukke no ooi zakuro']);
});

for (const input of ['101', 'https://hitomi.la/reader/101.html#2', 'https://hitomi.la/galleries/101.html', 'https://hitomi.la/doujinshi/123-example-english-101.html?x=1', 'https://hitomi.la/101']) {
  test(`direct Hitomi lookup and paged search accept ${input}`, async () => {
    const gallery = await hitomiProvider.getGallery(input);
    assert.equal(gallery.galleryId, '101');
    const results = await hitomiProvider.search(input);
    assert.deepEqual(results.map(item => item.galleryId), ['101']);
    const page = await hitomiProvider.searchPage!(input, 0, 25);
    assert.equal(page.total, 1);
    assert.deepEqual(page.items.map(item => item.galleryId), ['101']);
    assert.deepEqual((await hitomiProvider.searchPage!(input, 25, 25)).items, []);
    assert.ok(!fetchedUrls.some(url => url.includes('/galleriesindex/') || url.includes('/n/')));
  });
}
test('Hitomi lookup rejects unrelated hosts and non-gallery URLs', async () => {
  for (const input of ['https://hitomi.la.evil.test/reader/101.html', 'https://example.test/reader/101.html', 'https://hitomi.la/artist/example.html', 'https://hitomi.la/reader/101.html/extra']) {
    await assert.rejects(hitomiProvider.getGallery(input), /Could not parse/);
  }
  assert.deepEqual(fetchedUrls, []);
});

test('search omits image set galleries but keeps artist CG, backfilling to the limit', async () => {
  const results = await hitomiProvider.search('cat', 5);

  // Image sets (102, 106) are dropped; later candidates backfill so the result
  // still reaches the requested limit. Artist CG (103) is a normal search hit.
  assert.deepEqual(
    results.map((r) => r.galleryId),
    ['101', '103', '104', '105', '107'],
  );
  assert.equal(results[0].uploadedAt, '2026-08-01T00:00:00.000Z');
  for (const id of [102, 106]) {
    // Fetched to learn the type, but never surfaced.
    assert.ok(fetchedUrls.some((u) => u.endsWith(`/galleries/${id}.js`)), `expected a lookup for ${id}`);
    assert.ok(!results.some((r) => r.galleryId === String(id)));
  }
});

test('search keeps index order when the limit exceeds the kept galleries', async () => {
  const results = await hitomiProvider.search('cat', 24);
  assert.deepEqual(
    results.map((r) => r.galleryId),
    ['101', '103', '104', '105', '107', '108'],
  );
});

test('search honors excludeTypes, dropping artist CG galleries like the recommendations engine does', async () => {
  const results = await hitomiProvider.search('cat', 5, undefined, { excludeTypes: ['artistcg'] });

  // Excluded types (102, 103, 106) are dropped; later candidates backfill so
  // the result still reaches the requested limit.
  assert.deepEqual(
    results.map((r) => r.galleryId),
    ['101', '104', '105', '107', '108'],
  );
  for (const id of [102, 103, 106]) {
    // Fetched to learn the type, but never surfaced.
    assert.ok(fetchedUrls.some((u) => u.endsWith(`/galleries/${id}.js`)), `expected a lookup for ${id}`);
    assert.ok(!results.some((r) => r.galleryId === String(id)));
  }
});

test('search honors skip, sampling a later slice of the ranking without hydrating skipped ids', async () => {
  const results = await hitomiProvider.search('cat', 3, undefined, { skip: 2 });

  // The ranking is [101..108]; skipping two leading positions starts at 103
  // (102 is an image set that would be dropped anyway). Kept order preserved.
  assert.deepEqual(results.map((r) => r.galleryId), ['103', '104', '105']);
  assert.ok(!fetchedUrls.some((u) => u.endsWith('/galleries/101.js')), 'skipped ids must not be hydrated');
});

test('search bounds the hydration scan at 4x the limit on type-heavy queries', async () => {
  const results = await hitomiProvider.search('dog', 5);

  assert.equal(results.length, 0);
  // 30 candidate ids, but only target*4 = 20 lookups may run.
  const galleryLookups = fetchedUrls.filter((u) => /\/galleries\/\d+\.js$/.test(u));
  assert.equal(galleryLookups.length, 20);
});

test('search excludes galleries carrying a configured banned tag', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['loli'] });
  const results = await hitomiProvider.search('cat', 24);

  // 105 and 107 carry the banned "loli" tag; they are dropped before
  // hydration, so no gallery lookup for them is even issued.
  assert.deepEqual(results.map((r) => r.galleryId), ['101', '103', '104', '108']);
  for (const id of [105, 107]) {
    assert.ok(!fetchedUrls.some((u) => u.endsWith(`/galleries/${id}.js`)), `banned ${id} must not be hydrated`);
  }
});

test('searching a banned tag explicitly still returns its galleries', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['loli'] });
  const results = await hitomiProvider.search('loli', 24);

  // The query names the banned tag verbatim — an explicit request that skips
  // the exclusion, so its galleries surface normally.
  assert.deepEqual(results.map((r) => r.galleryId), ['105', '107']);
});

test('search excludes galleries matching a namespaced banned tag via nozomi', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['artist:evil'] });
  const results = await hitomiProvider.search('cat', 24);

  // The ban resolves through the artist nozomi filter (104 flagged), so only
  // that gallery is dropped — unlike a plain keyword, which matches any field.
  assert.ok(fetchedUrls.includes(`${API_BASE}/n/artist/evil-all.nozomi`));
  assert.deepEqual(results.map((r) => r.galleryId), ['101', '103', '105', '107', '108']);
});

// Ordered expectations derived from the official results.js/search.js algorithm.
for (const { query, sort, expected } of [
  { query: 'CAT -loli', expected: [101, 103, 104, 108] },
  { query: 'cat moon', expected: [101, 104, 108] },
  { query: 'cat OR moon', expected: [101, 103, 104, 105, 107, 108] },
  { query: 'cat or dog moon or loli', expected: [101, 104, 105, 107, 108] },
  { query: '-dog', expected: [101, 103, 104, 105, 107, 108] },
  { query: 'cat —artist:evil', expected: [101, 103, 105, 107, 108] },
  { query: 'blue_sky', expected: [101, 103] },
  { query: 'female:blue_sky', expected: [101, 108] },
  { query: 'moon', expected: [101, 104, 108] },
  { query: 'moon language:japanese', expected: [301] },
  { query: 'artist:sample_group cat', expected: [104, 101, 108] },
  { query: 'cat orderbydirection:ascending', expected: [108, 107, 105, 104, 103, 101] },
  { query: 'cat orderby:popular', expected: [108, 104, 105, 101, 107, 103] },
  { query: 'cat sortby:popularity sortbykey:month', expected: [103, 107, 101] },
  { query: 'artist:sample_group cat orderby:popular orderbykey:week', expected: [108, 101, 104] },
  { query: 'artist:sample_group cat', sort: 'popular-week' as const, expected: [108, 101, 104] },
  { query: 'cat', sort: 'popular-month' as const, expected: [103, 107, 101] },
  { query: 'cat orderby:datepublished', expected: [104, 108, 101, 107, 105, 103] },
  { query: 'cat', sort: 'date-published' as const, expected: [104, 108, 101, 107, 105, 103] },
  { query: 'cat orderby:popular orderbykey:missing', expected: [] },
]) {
  test(`official query semantics: ${query}${sort ? ` (${sort})` : ''}`, async () => {
    const results = await hitomiProvider.search(query, 24, sort);
    assert.deepEqual(results.map(result => Number(result.galleryId)), expected);
  });
}

test('random ordering preserves the filtered gallery set', async () => {
  const results = await hitomiProvider.search('cat -loli orderby:random', 24);
  assert.deepEqual(results.map(result => Number(result.galleryId)).sort((a, b) => a - b), [101, 103, 104, 108]);
});

test('autocomplete scopes namespaces and encodes multi-word prefixes like the website', async () => {
  const suggestions = await hitomiProvider.suggest('-artist:sample_gr');
  assert.ok(fetchedUrls.includes('https://tagindex.hitomi.la/artist/s/a/m/p/l/e/_/g/r.json'));
  assert.equal(suggestions[0].filter, 'artist:Sample_Group');
  await hitomiProvider.suggest('artist:');
  assert.ok(fetchedUrls.includes('https://tagindex.hitomi.la/artist.json'));
});

test('sort autocomplete offers the website periods in popularity context', async () => {
  const suggestions = await hitomiProvider.suggest('orderbykey:', 10, 'cat orderby:popular orderbykey:');
  assert.deepEqual(suggestions.map(suggestion => suggestion.filter), ['orderbykey:today', 'orderbykey:week', 'orderbykey:month', 'orderbykey:year']);
  assert.equal(fetchedUrls.length, 0);
});

test('keyword index versions refresh and concurrent gallery hydration shares one routing request', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 60_000);
  servedVersion = 'v-refreshed';
  const results = await hitomiProvider.search('cat', 24);
  assert.equal(results.length, 6);
  assert.ok(fetchedUrls.some(url => url.includes('/galleriesindex/version')));
  assert.ok(fetchedUrls.some(url => url.endsWith('/galleries.v-refreshed.index')));
  assert.equal(fetchedUrls.filter(url => url.endsWith('/gg.js')).length, 1);
});

test('search pages count and skip image sets before slicing the ranking', async () => {
  const first = await hitomiProvider.searchPage!('cat', 0, 3);
  const second = await hitomiProvider.searchPage!('cat', 3, 3);
  assert.equal(first.total, 6);
  assert.equal(second.total, 6);
  assert.deepEqual(first.items.map(item => Number(item.galleryId)), [101, 103, 104]);
  assert.deepEqual(second.items.map(item => Number(item.galleryId)), [105, 107, 108]);
  assert.ok(!fetchedUrls.some(url => /\/galleries\/(102|106)\.js$/.test(url)));
});

test('search pages can browse beyond 1000 matches and hydrate only the requested page', async () => {
  const result = await hitomiProvider.searchPage!('many language:all', 1100, 25);
  const expected = MANY_IDS.filter(id => id !== 40_026).slice(1100, 1125);
  assert.equal(result.total, 1300);
  assert.deepEqual(result.items.map(item => Number(item.galleryId)), expected);
  assert.equal(fetchedUrls.filter(url => /\/galleries\/\d+\.js$/.test(url)).length, 25);
});

test('paged totals retain configured bans and out-of-range pages stay empty', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['loli'] });
  const result = await hitomiProvider.searchPage!('cat', 99, 25);
  assert.equal(result.total, 4);
  assert.deepEqual(result.items, []);
});

test('random search pages share one ranking snapshot without duplicates or gaps', async () => {
  const first = await hitomiProvider.searchPage!('cat', 0, 2, 'random');
  const second = await hitomiProvider.searchPage!('cat', 2, 4, 'random');
  const again = await hitomiProvider.searchPage!('cat', 0, 2, 'random');
  assert.deepEqual(again.items.map(item => item.galleryId), first.items.map(item => item.galleryId));
  assert.deepEqual([...first.items, ...second.items].map(item => Number(item.galleryId)).sort((a, b) => a - b), [101, 103, 104, 105, 107, 108]);
});

test('search filters excludeIds before hydration, wraps skip on small pools, and honors opts.language', async t => {
  const excluded = await hitomiProvider.search('cat', 3, undefined, { excludeIds: new Set([101, 103]) });
  assert.deepEqual(excluded.map(r => r.galleryId), ['104', '105', '107']);
  assert.ok(!fetchedUrls.some(u => u.endsWith('/galleries/101.js') || u.endsWith('/galleries/103.js')), 'excluded IDs must not be hydrated');

  fetchedUrls = [];
  const wrapped = await hitomiProvider.search('cat', 4, undefined, { skip: 20, wrapSkip: true });
  assert.ok(wrapped.length >= 3, 'wrapSkip must keep small pools populated instead of returning empty');

  fetchedUrls = [];
  // Step past the short ranking-index cache so the language index is refetched.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 5 * 60_000);
  const jp = await hitomiProvider.search('moon', 10, undefined, { language: 'japanese' });
  assert.deepEqual(jp.map(r => r.galleryId), ['301']);
  assert.ok(fetchedUrls.includes(`${API_BASE}/n/index-japanese.nozomi`));
});

test('ranking indexes are cached briefly and reordering never mutates the cached copy', async () => {
  const first = await hitomiProvider.search('cat', 24);
  fetchedUrls = [];
  const ascending = await hitomiProvider.search('cat orderbydirection:ascending', 24);
  const shuffled = await hitomiProvider.search('cat orderby:random', 24);
  const again = await hitomiProvider.search('cat', 24);
  assert.ok(!fetchedUrls.some(url => url.endsWith('/n/index-english.nozomi')), 'a fresh ranking index is served from the cache');
  assert.deepEqual(ascending.map(r => r.galleryId), first.map(r => r.galleryId).reverse());
  assert.deepEqual(shuffled.map(r => r.galleryId).sort(), first.map(r => r.galleryId).sort());
  assert.deepEqual(again.map(r => r.galleryId), first.map(r => r.galleryId));
});

test('merged ban sets are reused across searches without re-resolving entries', async () => {
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['artist:evil', 'loli'] });
  const first = await hitomiProvider.search('cat', 24);
  fetchedUrls = [];
  const second = await hitomiProvider.search('cat', 24);
  assert.deepEqual(second.map(r => r.galleryId), first.map(r => r.galleryId));
  assert.ok(!second.some(r => r.galleryId === '104'), 'the namespaced ban still applies');
  assert.ok(!fetchedUrls.some(url => url.includes('/n/artist/evil-all.nozomi')), 'cached bans are not re-resolved');
  assert.equal(fetchedUrls.filter(url => url.endsWith('.data')).length, 1, 'only the searched keyword reads the data file');
});
