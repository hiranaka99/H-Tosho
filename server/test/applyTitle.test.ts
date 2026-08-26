import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-apply-title-'));
const seriesDir = path.join(dataDir, 'Live!');
fs.mkdirSync(seriesDir);
process.env.HTOSHO_DATA_DIR = dataDir;

// The DB module reads HTOSHO_DATA_DIR at module initialization, so these test imports must follow the environment setup.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { parseComicInfo } = await import('../src/downloader/comicinfo.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } = await import('../src/services/settings.js');
const { api } = await import('../src/routes/api.js');

initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'secret' });
setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: dataDir });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface RequestLog {
  url: string;
  init?: RequestInit;
}

const EMPTY_METADATA = { id: 1, seriesId: 42, summary: '', genres: [], tags: [], writers: [], coverArtists: [], publishers: [], characters: [], pencillers: [], inkers: [], imprints: [], colorists: [], letterers: [], editors: [], translators: [], teams: [], locations: [], ageRating: 0, releaseYear: 0, language: '', maxCount: 0, totalCount: 0, publicationStatus: 0, webLinks: '' };

/**
 * Kavita-side mock for the rename flow. Before the library scan the folder
 * holds only the old series (id 42); once a scan is requested, the renamed
 * files surface as a new sibling entry in the same folder and the old record
 * is left without books — what real Kavita does when ComicInfo.Series changes.
 */
function kavitaRenameMock(
  state: { scanned: boolean; requests: RequestLog[] },
  dir: string,
  oldName: string,
  newName: string,
  newId: number,
) {
  const oldSeries = { id: 42, libraryId: 7, name: oldName, sortName: oldName, folderPath: dir };
  const newSeries = { id: newId, libraryId: 7, name: newName, sortName: newName, folderPath: dir };
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    state.requests.push({ url, init });
    if (url.endsWith('/api/Series/42')) {
      if (init?.method === 'DELETE') return Response.json({ ok: true });
      return Response.json(oldSeries);
    }
    if (url.endsWith(`/api/Series/${newId}`)) return Response.json(newSeries);
    if (url.includes('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Test', type: 0, folders: [dataDir] }]);
    if (url.includes('/api/Series/all-v2')) {
      return Response.json(state.scanned ? [oldSeries, newSeries] : [oldSeries]);
    }
    if (url.includes('/api/Library/scan')) {
      state.scanned = true;
      return Response.json({ ok: true });
    }
    if (url.includes('/api/Search/chapters-by-series?seriesId=42')) return Response.json([]);
    if (url.includes('/api/Series/metadata?')) return Response.json(EMPTY_METADATA);
    if (init?.method === 'POST') return Response.json({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test('selected MangaDex title rewrites every chapter, waits for the new entry, and targets it', async () => {
  const files = ['Chapter 1.cbz', 'Chapter 2.cbz'].map((name, index) => {
    const file = path.join(seriesDir, name);
    fs.writeFileSync(file, buildZip([
      { name: 'page.jpg', data: Buffer.from(`image-${index}`) },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Title>Chapter ${index + 1}</Title><Series>Old Name</Series></ComicInfo>`) },
    ]));
    return file;
  });
  const state = { scanned: false, requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/00faf1ea-5086-4d75-9621-5a597e523e21?')) {
      return Response.json({ data: { id: '00faf1ea-5086-4d75-9621-5a597e523e21', attributes: { title: { 'ja-ro': 'Live!: Soto de Koubi Shiyou!' }, altTitles: [{ en: "Let's Do It Outside!" }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaRenameMock(state, seriesDir, 'Old Name', 'Live!: Soto de Koubi Shiyou!', 43)(input, init);
  }) as typeof fetch;

  const res = await api.request('/series/42/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'mangadex',
      providerSeriesId: '00faf1ea-5086-4d75-9621-5a597e523e21',
      selectedTitle: 'Live!: Soto de Koubi Shiyou!',
      excludedFields: ['summary', 'genres', 'tags', 'writers', 'artists', 'releaseDate', 'language', 'status', 'url'],
      cover: false,
    }),
  });

  assert.equal(res.status, 200);
  const result = await res.json();
  // Step 1: every chapter carries the new Series value.
  assert.equal(result.titleFilesUpdated, 2);
  assert.equal(result.titleFilesVerified, 2);
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Live!: Soto de Koubi Shiyou!');
  // Step 2: a library scan is fired and the new sibling entry becomes the target.
  assert.equal(state.requests.filter((request) => request.url.includes('/api/Library/scan')).length, 1);
  assert.equal(state.requests.filter((request) => request.url.endsWith('/api/Series/scan')).length, 0);
  assert.equal(result.newSeriesId, 43);
  // The old record lost its books and is removed; nothing is pushed to it.
  assert.ok(state.requests.some((request) => request.url.endsWith('/api/Series/42') && request.init?.method === 'DELETE'));
  assert.equal(state.requests.filter((request) => request.url.endsWith('/api/Series/update')).length, 0);
});

test('AniList match rewrites ComicInfo.Series when the title differs (no selectedTitle)', async () => {
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
  const state = { scanned: false, requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('graphql.anilist.co')) {
      return Response.json({ data: { Media: { id: 129747, title: { romaji: 'Bitch na In`ane-sama' }, format: 'ONE_SHOT', coverImage: {}, description: '', averageScore: 0, startDate: null, genres: [], tags: [], studios: null, status: 'FINISHED' } } });
    }
    return kavitaRenameMock(state, anilistDir, 'Bitch na Inane-sama', 'Bitch na In`ane-sama', 45)(input, init);
  }) as typeof fetch;

  const res = await api.request('/series/42/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'anilist',
      providerSeriesId: '129747',
      excludedFields: ['summary', 'genres', 'tags', 'writers', 'artists', 'releaseDate', 'language', 'status', 'url'],
      cover: false,
    }),
  });

  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.titleFilesUpdated, 2);
  assert.equal(result.titleFilesVerified, 2);
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Bitch na In`ane-sama');
  assert.equal(state.requests.filter((request) => request.url.includes('/api/Library/scan')).length, 1);
  // Kavita derives the name from the files, so the title must not be re-pushed via the API.
  assert.equal(state.requests.filter((request) => request.url.endsWith('/api/Series/update')).length, 0);
  assert.equal(result.newSeriesId, 45);
});

test('remaining metadata is pushed to the new entry, and the match row follows it', async () => {
  const fullDir = path.join(dataDir, 'Full Sync');
  fs.mkdirSync(fullDir);
  for (const name of ['Chapter 1.cbz', 'Chapter 2.cbz']) {
    fs.writeFileSync(path.join(fullDir, name), buildZip([
      { name: 'page.jpg', data: Buffer.from('image') },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old Name</Series></ComicInfo>') },
    ]));
  }
  const state = { scanned: false, requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/00faf1ea-5086-4d75-9621-5a597e523e21?')) {
      return Response.json({ data: { id: '00faf1ea-5086-4d75-9621-5a597e523e21', attributes: { title: { 'ja-ro': 'Live!: Soto de Koubi Shiyou!' }, altTitles: [{ en: "Let's Do It Outside!" }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaRenameMock(state, fullDir, 'Old Name', 'Live!: Soto de Koubi Shiyou!', 47)(input, init);
  }) as typeof fetch;

  const res = await api.request('/series/42/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'mangadex',
      providerSeriesId: '00faf1ea-5086-4d75-9621-5a597e523e21',
      selectedTitle: 'Live!: Soto de Koubi Shiyou!',
      cover: false,
    }),
  });

  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.newSeriesId, 47);
  // Step 3: the remaining metadata lands on the new entry — write + re-lock.
  assert.ok(result.pushed.includes('language'));
  const metadataWrites = state.requests.filter((request) => request.url.endsWith('/api/Series/metadata') && request.init?.method === 'POST');
  assert.equal(metadataWrites.length, 2);
  for (const request of metadataWrites) {
    const body = JSON.parse(String(request.init?.body));
    assert.equal(body.seriesMetadata.seriesId, 47);
  }
  // The match row follows the rename: new id matched, old id gone.
  const db = getDb();
  const newRow = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 47)).get();
  assert.ok(newRow);
  assert.equal(newRow.status, 'matched');
  assert.equal(newRow.providerId, 'mangadex');
  const oldRow = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 42)).get();
  assert.equal(oldRow, undefined);
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
  const state = { scanned: false, requests: [] as RequestLog[] };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.mangadex.org/manga/001f1dae-a245-4125-9ee3-f8e80c634990?')) {
      // Display title is the romanized one; the name the folder actually
      // matches lives in altTitles — the matcher offers it as selectedTitle.
      return Response.json({ data: { id: '001f1dae-a245-4125-9ee3-f8e80c634990', attributes: { title: { en: 'DH! ~Himorogi Hyaku Yome Gatari~' }, altTitles: [{ en: 'Demon-Hentai - Shrine of One Hundred Wives' }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    }
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    return kavitaRenameMock(state, altDir, 'Old Name', 'Demon-Hentai - Shrine of One Hundred Wives', 49)(input, init);
  }) as typeof fetch;

  const res = await api.request('/series/42/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'mangadex',
      providerSeriesId: '001f1dae-a245-4125-9ee3-f8e80c634990',
      selectedTitle: 'Demon-Hentai - Shrine of One Hundred Wives',
      excludedFields: ['summary', 'genres', 'tags', 'writers', 'artists', 'releaseDate', 'language', 'status', 'url'],
      cover: false,
    }),
  });

  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.titleFilesUpdated, 2);
  assert.equal(result.newSeriesId, 49);
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Demon-Hentai - Shrine of One Hundred Wives');
});
