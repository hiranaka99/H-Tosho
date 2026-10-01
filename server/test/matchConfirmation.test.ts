import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { Job, JobPayload } from '../src/jobs/queue.js';

process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-confirm-'));
const { initDb, getDb, schema } = await import('../src/db/index.js');
initDb();
const { setKavitaConnection, setProviderSetting } = await import('../src/services/settings.js');
const { getProvider } = await import('../src/providers/registry.js');
const { runJob } = await import('../src/jobs/executor.js');
const { api } = await import('../src/routes/api.js');
const provider = getProvider('anilist')!;
const originalSearch = provider.search;
const originalMetadata = provider.getSeriesMetadata;
const originalFetch = globalThis.fetch;
let candidateId = 'accepted';
let failPush = false;

beforeEach(() => {
  getDb().delete(schema.seriesMatches).run();
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test-key' });
  for (const id of ['anilist', 'mangadex', 'myanimelist']) setProviderSetting(id, { enabled: id === 'anilist' });
  candidateId = 'accepted';
  failPush = false;
  provider.search = async () => [{ providerId: 'anilist', providerSeriesId: candidateId, title: 'Example', type: 'MANGA' }];
  provider.getSeriesMetadata = async (id) => ({ providerId: 'anilist', providerSeriesId: id, title: 'Example', genres: [], tags: [], writers: [], artists: [] });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/Series/1')) return Response.json({ id: 1, libraryId: 1, name: 'Example' });
    if (url.includes('/Series/metadata?')) return Response.json({ seriesId: 1 });
    if (url.endsWith('/Series/update')) return failPush ? Response.json({}, { status: 403 }) : Response.json({});
    if (url.endsWith('/Series/scan')) return Response.json({});
    if (url.endsWith('/Library/libraries')) return Response.json([{ id: 1, name: 'Manga', type: 0 }]);
    if (url.includes('/Series/all-v2')) return Response.json([{ id: 1, libraryId: 1, name: 'Example' }]);
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  provider.search = originalSearch;
  provider.getSeriesMetadata = originalMetadata;
});

function job(type: Job['type'], payload: JobPayload): Job {
  return { id: 999, type, payload, status: 'running', progressCurrent: 0, progressTotal: 1, result: null, errorMessage: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
}
const row = () => getDb().select().from(schema.seriesMatches).get()!;
const apply = () => runJob(job('apply-series', { seriesId: 1, providerId: 'anilist', providerSeriesId: candidateId, score: 0.39, cover: false }), () => {});

test('confirmation survives score recalculation and syncing the same identity, but not a different match', async () => {
  await apply();
  assert.equal(row().confirmed, true);
  assert.equal(row().matchScore, 0.39);
  const library = await (await api.request('/kavita/libraries/1/series')).json();
  assert.equal(library[0].confirmed, true, 'library cards receive the stored confirmation');
  assert.equal((await api.request('/series/1/identify')).status, 200);
  assert.equal(row().confirmed, true);
  assert.equal(row().matchScore, 1, 'identify still refreshes the numerical score');
  await runJob(job('sync-series', { seriesIds: [1] }), () => {});
  assert.equal(row().confirmed, true);
  candidateId = 'different';
  await runJob(job('match-series', { seriesId: 1 }), () => {});
  assert.equal(row().providerSeriesId, 'different');
  assert.equal(row().confirmed, false, 'another candidate needs its own approval');
});

test('failed applies do not approve a new candidate, and retries record confirmation', async () => {
  failPush = true;
  assert.equal((await apply()).failed, 1);
  assert.equal(row().status, 'failed');
  assert.equal(row().confirmed, false);
  failPush = false;
  await apply();
  assert.equal(row().confirmed, true);
  assert.equal((await (await api.request('/series/low-confidence')).json()).count, 0);
  failPush = true;
  await apply();
  assert.equal(row().confirmed, true, 'a sync error does not revoke an existing approval');
  candidateId = 'different';
  await apply();
  assert.equal(row().confirmed, false, 'approval cannot carry over to a failed replacement');
});

test('unmatching removes confirmation and the next automatic match is unconfirmed', async () => {
  await apply();
  assert.equal((await api.request('/series/1/match', { method: 'DELETE' })).status, 200);
  assert.equal(getDb().select().from(schema.seriesMatches).all().length, 0);
  await runJob(job('match-series', { seriesId: 1 }), () => {});
  assert.equal(row().confirmed, false);
});
