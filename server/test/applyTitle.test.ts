import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { Job, JobPayload } from '../src/jobs/queue.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-apply-title-'));
const seriesDir = path.join(dataDir, 'Live!');
fs.mkdirSync(seriesDir);
process.env.HTOSHO_DATA_DIR = dataDir;

// The DB module reads HTOSHO_DATA_DIR at module initialization, so these test imports must follow the environment setup.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { parseComicInfo } = await import('../src/downloader/comicinfo.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER, setNotificationSettings, DEFAULT_NOTIFICATIONS } = await import('../src/services/settings.js');
const { runJob } = await import('../src/jobs/executor.js');
const { jobQueue } = await import('../src/jobs/queue.js');
const { api } = await import('../src/routes/api.js');

initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'secret' });
setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: dataDir });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setNotificationSettings(DEFAULT_NOTIFICATIONS);
});

interface RequestLog {
  url: string;
  init?: RequestInit;
}

const EMPTY_METADATA = { id: 1, seriesId: 42, summary: '', genres: [], tags: [], writers: [], coverArtists: [], publishers: [], characters: [], pencillers: [], inkers: [], imprints: [], colorists: [], letterers: [], editors: [], translators: [], teams: [], locations: [], ageRating: 0, releaseYear: 0, language: '', maxCount: 0, totalCount: 0, publicationStatus: 0, webLinks: '' };

/**
 * Kavita-side mock for the apply flow. The record (id 42) starts under
 * `oldName`; a POST /Series/update carrying a name renames it in place — what
 * real Kavita 0.9.x does. No scans, no sibling entries.
 */
function kavitaApplyMock(state: { requests: RequestLog[]; currentName?: string }, dir: string, oldName: string) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    state.requests.push({ url, init });
    if (url.endsWith('/api/Series/update')) {
      const body = JSON.parse(String(init?.body));
      if (typeof body.name === 'string' && body.name.trim()) state.currentName = body.name;
      return Response.json({ ok: true });
    }
    if (url.endsWith('/api/Series/42')) {
      const currentName = state.currentName ?? oldName;
      return Response.json({ id: 42, libraryId: 7, name: currentName, sortName: currentName, folderPath: dir });
    }
    if (url.includes('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Test', type: 0, folders: [dataDir] }]);
    if (url.includes('/api/Series/metadata?')) return Response.json(EMPTY_METADATA);
    if (init?.method === 'POST') return Response.json({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

/** apply-series jobs run through the same executor path as every other background job. */
const makeJob = (id: number, payload: JobPayload): Job => ({
  id,
  type: 'apply-series',
  payload,
  status: 'running',
  progressCurrent: 0,
  progressTotal: 1,
  result: null,
  errorMessage: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
});

test('selected MangaDex title rewrites every chapter and renames the record via API', async () => {
  const files = ['Chapter 1.cbz', 'Chapter 2.cbz'].map((name, index) => {
    const file = path.join(seriesDir, name);
    fs.writeFileSync(file, buildZip([
      { name: 'page.jpg', data: Buffer.from(`image-${index}`) },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Title>Chapter ${index + 1}</Title><Series>Old Name</Series></ComicInfo>`) },
    ]));
    return file;
  });
  const state = { requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/00faf1ea-5086-4d75-9621-5a597e523e21?')) {
      return Response.json({ data: { id: '00faf1ea-5086-4d75-9621-5a597e523e21', attributes: { title: { 'ja-ro': 'Live!: Soto de Koubi Shiyou!' }, altTitles: [{ en: "Let's Do It Outside!" }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaApplyMock(state, seriesDir, 'Old Name')(input, init);
  }) as typeof fetch;

  const historyBefore = getDb().select().from(schema.syncHistory).all().length;
  const summary = await runJob(makeJob(900, {
    seriesId: 42,
    providerId: 'mangadex',
    providerSeriesId: '00faf1ea-5086-4d75-9621-5a597e523e21',
    selectedTitle: 'Live!: Soto de Koubi Shiyou!',
    excludedFields: ['summary', 'genres', 'tags', 'writers', 'artists', 'releaseDate', 'language', 'status', 'url'],
    cover: false,
    score: 0.39,
  }), () => {});

  assert.equal(summary.processed, 1);
  assert.equal(summary.matched, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.titleFilesUpdated, 2);
  assert.equal(summary.titleFilesVerified, 2);
  assert.ok(summary.pushed?.includes('name'));
  assert.equal(summary.coverUpdated, false);
  assert.equal(summary.volumeCoversUpdated, 0);
  // Every chapter carries the new Series value.
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Live!: Soto de Koubi Shiyou!');
  // The record is renamed in place via /Series/update — no scan, no new entry.
  const updates = state.requests.filter((request) => request.url.endsWith('/api/Series/update'));
  assert.equal(updates.length, 1);
  assert.equal(JSON.parse(String(updates[0].init?.body)).name, 'Live!: Soto de Koubi Shiyou!');
  assert.equal(state.requests.filter((request) => request.url.includes('/api/Library/scan')).length, 0);
  // The match row stays on the same record id.
  const db = getDb();
  const row = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 42)).get();
  assert.ok(row);
  assert.equal(row.status, 'matched');
  assert.equal(row.confirmed, true, 'applying a candidate records the user approval');
  assert.equal(row.matchScore, 0.39, 'approval must not inflate the automatic confidence');
  assert.equal((await (await api.request('/series/low-confidence')).json()).count, 0);
  assert.deepEqual(await (await api.request('/series/needs-review')).json(), []);
  assert.equal(getDb().select().from(schema.syncHistory).all().length, historyBefore + 1, 'one apply creates one history entry');
});

test('punctuation-only title change rewrites ComicInfo.Series and renames via API without a scan', async () => {
  const anilistDir = path.join(dataDir, 'Bitch na Inane-sama');
  fs.mkdirSync(anilistDir);
  const files = ['Vol 1.cbz', 'Vol 2.cbz'].map((name, index) => {
    const file = path.join(anilistDir, name);
    fs.writeFileSync(file, buildZip([
      { name: 'page.jpg', data: Buffer.from(`image-${index}`) },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Title>Vol ${index + 1}</Title><Series>Bitch na Inane-sama</Series></ComicInfo>`) },
    ]));
    return file;
  });
  const state = { requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('graphql.anilist.co')) {
      return Response.json({ data: { Media: { id: 129747, title: { romaji: 'Bitch na In`ane-sama' }, format: 'ONE_SHOT', coverImage: {}, description: '', averageScore: 0, startDate: null, genres: [], tags: [], studios: null, status: 'FINISHED' } } });
    }
    return kavitaApplyMock(state, anilistDir, 'Bitch na Inane-sama')(input, init);
  }) as typeof fetch;

  const summary = await runJob(makeJob(901, {
    seriesId: 42,
    providerId: 'anilist',
    providerSeriesId: '129747',
    excludedFields: ['summary', 'genres', 'tags', 'writers', 'artists', 'releaseDate', 'language', 'status', 'url'],
    cover: false,
  }), () => {});

  assert.equal(summary.processed, 1);
  assert.equal(summary.matched, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.titleFilesUpdated, 2);
  assert.equal(summary.titleFilesVerified, 2);
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Bitch na In`ane-sama');
  // The punctuation-only difference still goes through /Series/update so
  // Kavita's display name follows the files — and no scan is fired.
  const updates = state.requests.filter((request) => request.url.endsWith('/api/Series/update'));
  assert.equal(updates.length, 1);
  assert.equal(JSON.parse(String(updates[0].init?.body)).name, 'Bitch na In`ane-sama');
  assert.equal(state.requests.filter((request) => request.url.includes('/api/Library/scan')).length, 0);
});

test('remaining metadata is pushed to the same record, and the match row stays put', async () => {
  const fullDir = path.join(dataDir, 'Full Sync');
  fs.mkdirSync(fullDir);
  for (const name of ['Chapter 1.cbz', 'Chapter 2.cbz']) {
    fs.writeFileSync(path.join(fullDir, name), buildZip([
      { name: 'page.jpg', data: Buffer.from('image') },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old Name</Series></ComicInfo>') },
    ]));
  }
  const state = { requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/00faf1ea-5086-4d75-9621-5a597e523e21?')) {
      return Response.json({ data: { id: '00faf1ea-5086-4d75-9621-5a597e523e21', attributes: { title: { 'ja-ro': 'Live!: Soto de Koubi Shiyou!' }, altTitles: [{ en: "Let's Do It Outside!" }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaApplyMock(state, fullDir, 'Old Name')(input, init);
  }) as typeof fetch;

  const summary = await runJob(makeJob(902, {
    seriesId: 42,
    providerId: 'mangadex',
    providerSeriesId: '00faf1ea-5086-4d75-9621-5a597e523e21',
    selectedTitle: 'Live!: Soto de Koubi Shiyou!',
    cover: false,
  }), () => {});

  assert.equal(summary.processed, 1);
  assert.equal(summary.matched, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.titleFilesUpdated, 2);
  assert.equal(summary.titleFilesVerified, 2);
  // The rename and the remaining metadata land on the same record — write + re-lock.
  const updates = state.requests.filter((request) => request.url.endsWith('/api/Series/update'));
  assert.equal(updates.length, 1);
  assert.equal(JSON.parse(String(updates[0].init?.body)).name, 'Live!: Soto de Koubi Shiyou!');
  const metadataWrites = state.requests.filter((request) => request.url.endsWith('/api/Series/metadata') && request.init?.method === 'POST');
  assert.equal(metadataWrites.length, 2);
  for (const request of metadataWrites) {
    const body = JSON.parse(String(request.init?.body));
    assert.equal(body.seriesMetadata.seriesId, 42);
  }
  // The match row stays on the same record id.
  const db = getDb();
  const row = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 42)).get();
  assert.ok(row);
  assert.equal(row.status, 'matched');
  assert.equal(row.providerId, 'mangadex');
});

test('alternate English title (not display or romanized) is accepted as selectedTitle', async () => {
  const altDir = path.join(dataDir, 'Demon-Hentai');
  fs.mkdirSync(altDir);
  const files = ['Chapter 1.cbz', 'Chapter 2.cbz'].map((name, index) => {
    const file = path.join(altDir, name);
    fs.writeFileSync(file, buildZip([
      { name: 'page.jpg', data: Buffer.from(`image-${index}`) },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Title>Chapter ${index + 1}</Title><Series>Old Name</Series></ComicInfo>`) },
    ]));
    return file;
  });
  const state = { requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/001f1dae-a245-4125-9ee3-f8e80c634990?')) {
      // Display title is the romanized one; the name the folder actually
      // matches lives in altTitles — the matcher offers it as selectedTitle.
      return Response.json({ data: { id: '001f1dae-a245-4125-9ee3-f8e80c634990', attributes: { title: { en: 'DH! ~Himorogi Hyaku Yome Gatari~' }, altTitles: [{ en: 'Demon-Hentai - Shrine of One Hundred Wives' }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaApplyMock(state, altDir, 'Old Name')(input, init);
  }) as typeof fetch;

  const summary = await runJob(makeJob(903, {
    seriesId: 42,
    providerId: 'mangadex',
    providerSeriesId: '001f1dae-a245-4125-9ee3-f8e80c634990',
    selectedTitle: 'Demon-Hentai - Shrine of One Hundred Wives',
    excludedFields: ['summary', 'genres', 'tags', 'writers', 'artists', 'releaseDate', 'language', 'status', 'url'],
    cover: false,
  }), () => {});

  assert.equal(summary.processed, 1);
  assert.equal(summary.matched, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.titleFilesUpdated, 2);
  assert.equal(summary.titleFilesVerified, 2);
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Demon-Hentai - Shrine of One Hundred Wives');
});

test('inaccessible CBZ files skip only the rename and still apply the match', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const notifications: Array<{ embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }> }> = [];
  setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.test/webhook' } });
  const state = { requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://discord.test/webhook') {
      notifications.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (url.includes('api.mangadex.org/manga/00faf1ea-5086-4d75-9621-5a597e523e21?')) {
      return Response.json({ data: { id: '00faf1ea-5086-4d75-9621-5a597e523e21', attributes: { title: { 'ja-ro': 'Live!: Soto de Koubi Shiyou!' }, status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaApplyMock(state, path.join(dataDir, 'not-mounted'), 'Old Name')(input, init);
  }) as typeof fetch;

  const result = await runJob(makeJob(905, {
    seriesId: 42,
    providerId: 'mangadex',
    providerSeriesId: '00faf1ea-5086-4d75-9621-5a597e523e21',
    cover: false,
  }), (level, message) => logs.push({ level, message }));

  assert.equal(result.processed, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.warnings, 1);
  assert.equal(result.pushed?.includes('name'), false);
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('Title was not changed')));
  const history = await (await api.request('/series/42/history')).json();
  assert.match(history[0].details.warnings[0], /Mount.*retry Apply & Sync/);
  assert.match(notifications[0].embeds[0].title, /^Synced with warnings/);
  assert.match(notifications[0].embeds[0].fields.find((field) => field.name === 'Notes')!.value, /Title was not changed/);
  assert.equal(state.requests.some((request) => request.url.endsWith('/api/Series/update')), false);
  const row = getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 42)).get();
  assert.equal(row?.status, 'matched');
});

test('a rejected selectedTitle fails the job without touching files or the match row', async () => {
  const rejDir = path.join(dataDir, 'Rejected Title');
  fs.mkdirSync(rejDir);
  const file = path.join(rejDir, 'Chapter 1.cbz');
  fs.writeFileSync(file, buildZip([
    { name: 'page.jpg', data: Buffer.from('image') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old Name</Series></ComicInfo>') },
  ]));
  const state = { requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/001f1dae-a245-4125-9ee3-f8e80c634990?')) {
      return Response.json({ data: { id: '001f1dae-a245-4125-9ee3-f8e80c634990', attributes: { title: { en: 'DH! ~Himorogi Hyaku Yome Gatari~' }, altTitles: [{ en: 'Demon-Hentai - Shrine of One Hundred Wives' }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaApplyMock(state, rejDir, 'Old Name')(input, init);
  }) as typeof fetch;

  await assert.rejects(
    runJob(makeJob(904, {
      seriesId: 42,
      providerId: 'mangadex',
      providerSeriesId: '001f1dae-a245-4125-9ee3-f8e80c634990',
      selectedTitle: 'Not A Provider Title',
    }), () => {}),
    /selectedTitle is not provided by this metadata source/,
  );
  // Validation runs before any side effect: no files rewritten, no rename sent.
  assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Old Name');
  assert.equal(state.requests.filter((request) => request.url.endsWith('/api/Series/update')).length, 0);
});

test('POST /series/:id/apply enqueues an apply-series job and rejects concurrent applies', async () => {
  // Hold the (otherwise unregistered) handler slot with a gate so the enqueued
  // job stays active while the guard is exercised.
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  jobQueue.registerHandler(async () => { await gate; return {}; });
  globalThis.fetch = kavitaApplyMock({ requests: [] }, seriesDir, 'Original target');
  try {
    const res = await api.request('/series/42/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: 'mangadex',
        providerSeriesId: '001f1dae-a245-4125-9ee3-f8e80c634990',
        selectedTitle: 'Demon-Hentai - Shrine of One Hundred Wives',
        excludedFields: ['genres'],
        cover: false,
        score: 0.97,
      }),
    });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const job = jobQueue.get(id)!;
    assert.equal(job.type, 'apply-series');
    assert.deepEqual(job.context?.series, [{ id: 42, name: 'Original target' }]);
    // A second apply for the same series while one is active is refused.
    const again = await api.request('/series/42/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'mangadex', providerSeriesId: '001f1dae-a245-4125-9ee3-f8e80c634990' }),
    });
    assert.equal(again.status, 409);
  } finally {
    release!();
  }
});
