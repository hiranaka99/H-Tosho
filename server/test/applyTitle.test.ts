import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-apply-title-'));
const seriesDir = path.join(dataDir, 'Live!');
fs.mkdirSync(seriesDir);
process.env.HTOSHO_DATA_DIR = dataDir;

// The DB module reads HTOSHO_DATA_DIR at module initialization, so these test imports must follow the environment setup.
const { initDb } = await import('../src/db/index.js');
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

test('selected MangaDex title rewrites every chapter and requests a series scan', async () => {
  const files = ['Chapter 1.cbz', 'Chapter 2.cbz'].map((name, index) => {
    const file = path.join(seriesDir, name);
    fs.writeFileSync(file, buildZip([
      { name: 'page.jpg', data: Buffer.from(`image-${index}`) },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Title>Chapter ${index + 1}</Title><Series>Old Name</Series></ComicInfo>`) },
    ]));
    return file;
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/Series/42')) return Response.json({ id: 42, libraryId: 7, name: 'Old Name', sortName: 'Old Name', folderPath: seriesDir });
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Test', type: 0, folders: [dataDir] }]);
    if (url.includes('api.mangadex.org/manga/00faf1ea-5086-4d75-9621-5a597e523e21?')) return Response.json({ data: { id: '00faf1ea-5086-4d75-9621-5a597e523e21', attributes: { title: { 'ja-ro': 'Live!: Soto de Koubi Shiyou!' }, altTitles: [{ en: "Let's Do It Outside!" }], status: 'completed', originalLanguage: 'ja' }, relationships: [] } });
    if (url.includes('api.mangadex.org/cover?')) return Response.json({ response: 'collection', data: [] });
    if (url.includes('/api/Series/metadata?')) return Response.json({ id: 1, seriesId: 42, summary: '', genres: [], tags: [], writers: [], coverArtists: [], publishers: [], characters: [], pencillers: [], inkers: [], imprints: [], colorists: [], letterers: [], editors: [], translators: [], teams: [], locations: [], ageRating: 0, releaseYear: 0, language: '', maxCount: 0, totalCount: 0, publicationStatus: 0, webLinks: '' });
    if (init?.method === 'POST') return Response.json({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
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
  assert.equal(result.titleFilesUpdated, 2);
  assert.equal(result.titleFilesVerified, 2);
  for (const file of files) assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Live!: Soto de Koubi Shiyou!');
  assert.equal(requests.filter((request) => request.url.endsWith('/api/Series/scan')).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith('/api/Series/update')).length, 0);
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
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/Series/42')) return Response.json({ id: 42, libraryId: 7, name: 'Bitch na Inane-sama', sortName: 'Bitch na Inane-sama', folderPath: anilistDir });
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Test', type: 0, folders: [dataDir] }]);
    if (url.includes('graphql.anilist.co')) return Response.json({ data: { Media: { id: 129747, title: { romaji: 'Bitch na In`ane-sama' }, format: 'ONE_SHOT', coverImage: {}, description: '', averageScore: 0, startDate: null, genres: [], tags: [], studios: null, status: 'FINISHED' } } });
    if (init?.method === 'POST') return Response.json({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
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
  assert.equal(requests.filter((request) => request.url.endsWith('/api/Series/scan')).length, 1);
  // Kavita 0.9 ignores the API name push, so the title must not be re-pushed after the file rewrite.
  assert.equal(requests.filter((request) => request.url.endsWith('/api/Series/update')).length, 0);
});
