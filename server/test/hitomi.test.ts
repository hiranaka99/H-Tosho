import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { hitomiProvider } from '../src/downloader/hitomi.js';

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

const CAT_IDS = [101, 102, 103, 104, 105, 106, 107, 108];
const DOG_IDS = Array.from({ length: 30 }, (_, i) => 201 + i);
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
const catData = idsBuffer(CAT_IDS);
const dogData = idsBuffer(DOG_IDS);
// B-tree keys must be ascending; keep the data pointers aligned with that order.
const rootEntries = [
  { key: hashTerm('cat'), offset: CAT_DATA_OFFSET, data: catData },
  { key: hashTerm('dog'), offset: DOG_DATA_OFFSET, data: dogData },
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
    date: '2026-08-01 00:00:00',
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
    return new Response(range.startsWith(`bytes=${CAT_DATA_OFFSET}`) ? catData : dogData);
  }
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('search omits image set and artist CG galleries, backfilling to the limit', async () => {
  const results = await hitomiProvider.search('cat', 5);

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

test('search keeps index order when the limit exceeds the kept galleries', async () => {
  const results = await hitomiProvider.search('cat', 24);
  assert.deepEqual(
    results.map((r) => r.galleryId),
    ['101', '104', '105', '107', '108'],
  );
});

test('search bounds the hydration scan at 4x the limit on type-heavy queries', async () => {
  const results = await hitomiProvider.search('dog', 5);

  assert.equal(results.length, 0);
  // 30 candidate ids, but only target*4 = 20 lookups may run.
  const galleryLookups = fetchedUrls.filter((u) => /\/galleries\/\d+\.js$/.test(u));
  assert.equal(galleryLookups.length, 20);
});
