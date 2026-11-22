import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { SearchResult } from '../src/providers/types.js';

process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-home-'));
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { setKavitaConnection, setProviderSetting } = await import('../src/services/settings.js');
const { getProvider } = await import('../src/providers/registry.js');
const { listMatchSuggestions, rejectMatchCandidate, restoreMatchCandidate, scanMatchSuggestions } = await import('../src/services/matchSuggestions.js');
const { api } = await import('../src/routes/api.js');
initDb();
const provider = getProvider('anilist')!;
const originalSearch = provider.search, originalFetch = globalThis.fetch;
let candidates: SearchResult[];
let unavailable = false;
const scan = () => scanMatchSuggestions({ checkCancelled() {}, progress() {}, log() {} });

beforeEach(() => {
  const db = getDb();
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  for (const table of [schema.matchSuggestions, schema.rejectedMatchCandidates, schema.seriesMatches, schema.syncHistory, schema.downloadQueue, schema.jobs]) db.delete(table).run();
  for (const id of ['anilist', 'mangadex', 'myanimelist']) setProviderSetting(id, { enabled: id === 'anilist' });
  candidates = [{ providerId: 'anilist', providerSeriesId: 'first', title: 'Sample title', type: 'MANGA' }];
  unavailable = false;
  provider.search = async () => { if (unavailable) throw new Error('Provider unavailable'); return candidates; };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/Library/libraries')) return Response.json([{ id: 1, name: 'Manga', type: 0 }]);
    if (url.includes('/Series/all-v2')) return Response.json([
      { id: 1, libraryId: 1, name: 'Sample title', coverImage: 'cover.jpg' },
      { id: 2, libraryId: 1, name: 'Already matched' },
    ]);
    throw new Error(`Scan must not mutate Kavita or request full metadata: ${url}`);
  }) as typeof fetch;
  db.insert(schema.seriesMatches).values({ kavitaSeriesId: 2, status: 'matched', confirmed: true }).run();
});
afterEach(() => { provider.search = originalSearch; globalThis.fetch = originalFetch; });

test('background scan discovers only unmatched series without accepting or applying a match', async () => {
  const progress: number[][] = [];
  const result = await scanMatchSuggestions({ checkCancelled() {}, log() {}, progress: (current, total) => progress.push([current, total]) });
  assert.deepEqual(result, { processed: 1, matchable: 1, failed: 0 });
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  assert.equal(listMatchSuggestions()[0].candidate.providerSeriesId, 'first');
  assert.equal(getDb().select().from(schema.seriesMatches).all().length, 1);
  assert.equal(getDb().select().from(schema.syncHistory).all().length, 0);
  const response = await api.request('/home/matches');
  const body = await response.json();
  assert.equal(body.items[0].cover, '/api/kavita/series/1/cover?v=cover.jpg');
});

test('a persisted rejection hides the same candidate on repeat scans but allows a different one', async () => {
  await scan();
  assert.equal(rejectMatchCandidate(1, 'anilist', 'first'), true);
  await scan();
  assert.equal(listMatchSuggestions().length, 0);
  assert.equal(getDb().select().from(schema.rejectedMatchCandidates).all().length, 1);
  candidates = [{ ...candidates[0], providerSeriesId: 'different' }];
  await scan();
  assert.equal(listMatchSuggestions()[0].candidate.providerSeriesId, 'different');
  assert.equal(rejectMatchCandidate(1, 'anilist', 'stale'), false);
});

test('restoring a rejected candidate makes it reappear and is idempotent', async () => {
  await scan();
  assert.equal(rejectMatchCandidate(1, 'anilist', 'first'), true);
  assert.equal(listMatchSuggestions().length, 0);
  restoreMatchCandidate(1, 'anilist', 'first');
  restoreMatchCandidate(1, 'anilist', 'first');
  assert.equal(listMatchSuggestions()[0].candidate.providerSeriesId, 'first');
  assert.equal(getDb().select().from(schema.rejectedMatchCandidates).all().length, 0);
});

test('provider outages preserve prior suggestions and fail visibly instead of reporting no matches', async () => {
  await scan();
  unavailable = true;
  await assert.rejects(scan(), /Providers could not complete/);
  assert.equal(listMatchSuggestions().length, 1);
});

test('a partial provider outage keeps successful discoveries and records a warning', async () => {
  const other = getProvider('mangadex')!, original = other.search;
  setProviderSetting('mangadex', { enabled: true });
  other.search = async () => { throw new Error('Unavailable'); };
  try {
    const result = await scan();
    assert.equal(result.matchable, 1);
    assert.equal(result.failed, 1);
  } finally { other.search = original; }
});

test('a long gallery title scans through the real MAL adapter without provider warnings', async () => {
  const title = 'Would You Still Crush on Your Older Childhood Friend Even if She Was a Naughty Girl?';
  setProviderSetting('myanimelist', { enabled: true, credentials: { clientId: 'fixture-client-id' } });
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.myanimelist.net') {
      if (Array.from(url.searchParams.get('q') ?? '').length > 64) return Response.json({ message: 'invalid q' }, { status: 400 });
      return Response.json({ data: [{ node: { id: 42, title, type: 'manga' } }] });
    }
    if (url.pathname.endsWith('/Series/all-v2')) return Response.json([{ id: 1, name: title, libraryId: 1 }]);
    return fixtureFetch(input, init);
  };
  const warnings: string[] = [];
  const result = await scanMatchSuggestions({ checkCancelled() {}, progress() {}, log: (level, message) => { if (level === 'warn') warnings.push(message); } });
  assert.deepEqual(result, { processed: 1, matchable: 1, failed: 0 });
  assert.deepEqual(warnings, []);
  assert.equal(listMatchSuggestions()[0].candidate.providerId, 'myanimelist');
  assert.equal(listMatchSuggestions()[0].candidate.score, 1);
});

test('accepted and removed galleries disappear from suggestions, and scans support cancellation', async () => {
  await scan();
  getDb().insert(schema.seriesMatches).values({ kavitaSeriesId: 1, status: 'matched' }).run();
  assert.equal(listMatchSuggestions().length, 0);
  await scan();
  assert.equal(getDb().select().from(schema.matchSuggestions).all().length, 0);
  await assert.rejects(scanMatchSuggestions({ checkCancelled() { throw new Error('Cancelled'); }, progress() {}, log() {} }), /Cancelled/);
});

test('suggestions and rejections stay isolated when switching Kavita servers', async () => {
  await scan();
  rejectMatchCandidate(1, 'anilist', 'first');
  setKavitaConnection({ baseUrl: 'https://other-kavita.test', apiKey: 'other' });
  assert.equal(listMatchSuggestions().length, 0);
  await scan();
  assert.equal(listMatchSuggestions().length, 1, 'same numeric ids on another server have no rejected candidates');
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  assert.equal(listMatchSuggestions().length, 0, 'original rejection is preserved');
});

test('recent activity combines completed downloads with match history in UTC time order', async () => {
  const db = getDb();
  db.insert(schema.syncHistory).values({ kavitaSeriesId: 1, seriesTitle: 'Matched title', action: 'matched', createdAt: '2026-11-15 10:00:00' }).run();
  db.insert(schema.downloadQueue).values([
    { source: 'hitomi', galleryId: 'completed', title: 'Downloaded title', status: 'completed', finishedAt: '2026-11-15T10:01:00Z' },
    { source: 'hitomi', galleryId: 'pending', title: 'Pending title', status: 'queued' },
  ]).run();
  const rows = await (await api.request('/home/activity')).json();
  assert.deepEqual(rows.map((item: { action: string }) => item.action), ['downloaded', 'matched']);
});

test('scan requests deduplicate active jobs and reject invalid or stale dismissals', async () => {
  const first = { id: Number(getDb().insert(schema.jobs).values({ type: 'scan-matchable', status: 'queued' }).run().lastInsertRowid) };
  const second = await (await api.request('/home/matches/scan', { method: 'POST' })).json();
  assert.equal(first.id, second.id);
  assert.equal(second.alreadyRunning, true);
  const reject = (id: string, body: unknown) => api.request(`/home/matches/${id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await reject('bad', {})).status, 400);
  assert.equal((await reject('1', { providerId: 'anilist', providerSeriesId: 'stale' })).status, 409);
  setKavitaConnection({ baseUrl: '', apiKey: '' });
  assert.equal((await api.request('/home/matches/scan', { method: 'POST' })).status, 503);
});
