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
const TYPE_BY_ID: Record<number, string> = Object.fromEntries([
  ...CAT_IDS.map((id) => [id, 'doujinshi']),
  [102, 'imageset'],
  [103, 'artistcg'],
  [104, 'manga'],
  [106, 'imageset'],
  ...DOG_IDS.map((id) => [id, 'imageset']),
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
const catData = idsBuffer(CAT_IDS);
const dogData = idsBuffer(DOG_IDS);
const loliData = idsBuffer(LOLI_IDS);
// The `.data` file serves every term's id list; look it up by range offset.
const DATA_BY_OFFSET: Record<number, Buffer> = {
  [CAT_DATA_OFFSET]: catData,
  [DOG_DATA_OFFSET]: dogData,
  [LOLI_DATA_OFFSET]: loliData,
};
const rootEntries = [
  { key: hashTerm('cat'), offset: CAT_DATA_OFFSET, data: catData },
  { key: hashTerm('dog'), offset: DOG_DATA_OFFSET, data: dogData },
  { key: hashTerm('loli'), offset: LOLI_DATA_OFFSET, data: loliData },
].sort((a, b) => cmpBytes(a.key, b.key));
const rootNodeBuffer = btreeNodeBuffer(
  rootEntries.map((e) => e.key),
  rootEntries.map((e) => [e.offset, e.data.length]),
);

function galleryInfo(id: number): string {
  return `var galleryinfo = ${JSON.stringify({
    id,
    title: `Cat Gallery ${id}`,
    language: 'english',
    type: TYPE_BY_ID[id],
    date: id === 101 ? '2026-08-01' : '2026-08-01 00:00:00',
    files: [{ name: 'page1.jpg', hash: 'ab'.repeat(32), haswebp: 1 }],
    tags: [],
    artists: [],
  })};`;
}

// Trivial routing table satisfying loadGG's shape check (m/s functions, b string).
const GG_JS = 'gg.m = function (g) { return 0; }; gg.s = function (h) { return "/p/"; }; gg.b = "base/";';

let fetchedUrls: string[] = [];

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  fetchedUrls.push(url);
  if (url.includes('/galleriesindex/version')) return new Response(VERSION);
  if (url.endsWith('.index')) return new Response(rootNodeBuffer);
  if (url.endsWith('.data')) {
    const range = String((init?.headers as Record<string, string> | undefined)?.Range ?? '');
    const offset = Number(range.replace(/^bytes=/, '').split('-')[0]);
    return new Response(DATA_BY_OFFSET[offset] ?? Buffer.alloc(4));
  }
  if (url === `${API_BASE}/n/artist/evil-all.nozomi`) return new Response(idsBuffer([104]));
  if (url === `${API_BASE}/n/index-english.nozomi`) return new Response(idsBuffer([...CAT_IDS, ...DOG_IDS]));
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
