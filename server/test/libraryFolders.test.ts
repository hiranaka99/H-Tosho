import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Job } from '../src/jobs/queue.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-library-folders-'));
process.env.HTOSHO_DATA_DIR = dataDir;
const { initDb } = await import('../src/db/index.js');
initDb();
const { api } = await import('../src/routes/api.js');
const { DEFAULT_DOWNLOADER, parseDownloaderSettings, setDownloaderSettings, setKavitaConnection } = await import('../src/services/settings.js');
const { runJob } = await import('../src/jobs/executor.js');
const { getProvider } = await import('../src/providers/registry.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
const { parseComicInfo } = await import('../src/downloader/comicinfo.js');
const downloads = path.join(dataDir, 'downloads');
const manga = path.join(dataDir, 'manga');
const mappings = [{ kavitaPath: '/kavita/Doujins', localPath: downloads }, { kavitaPath: '/kavita/Manga', localPath: manga }];
const originalFetch = globalThis.fetch;
const provider = getProvider('anilist')!;
const originalMetadata = provider.getSeriesMetadata;
afterEach(() => { globalThis.fetch = originalFetch; provider.getSeriesMetadata = originalMetadata; });

test('saves multiple mappings and preserves them when an older client saves downloader settings', async () => {
  const save = (body: unknown) => api.request('/settings/downloader', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await save({ ...DEFAULT_DOWNLOADER, downloadDirectory: downloads, libraryPathMappings: mappings })).status, 200);
  assert.deepEqual((await (await api.request('/settings/downloader')).json()).libraryPathMappings, mappings);
  const { libraryPathMappings: _ignored, ...legacy } = DEFAULT_DOWNLOADER;
  assert.equal((await save({ ...legacy, downloadDirectory: downloads })).status, 200);
  assert.deepEqual((await (await api.request('/settings/downloader')).json()).libraryPathMappings, mappings);
  const mapSave = (body: unknown) => api.request('/settings/library-path-mappings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await mapSave({ libraryPathMappings: [{ kavitaPath: '/kavita/Manga', localPath: manga }] })).status, 200);
  assert.deepEqual(await (await api.request('/settings/downloader')).json(), { ...DEFAULT_DOWNLOADER, downloadDirectory: downloads, libraryPathMappings: [{ kavitaPath: '/kavita/Manga', localPath: manga }] });
  assert.equal((await mapSave({ libraryPathMappings: [{ kavitaPath: '/kavita/Manga', localPath: 'relative' }] })).status, 400);
  assert.equal((await mapSave({})).status, 400);
  assert.deepEqual((await (await api.request('/settings/downloader')).json()).libraryPathMappings, [{ kavitaPath: '/kavita/Manga', localPath: manga }]);
});

test('validates mapping paths and duplicate roots while accepting older configurations', () => {
  assert.deepEqual(parseDownloaderSettings(DEFAULT_DOWNLOADER)?.libraryPathMappings, []);
  for (const value of [null, {}, [{ kavitaPath: 'relative', localPath: manga }], [{ kavitaPath: '/media/Manga', localPath: 'relative' }], [{ kavitaPath: '/media/../Manga', localPath: manga }], [mappings[0], { ...mappings[0], kavitaPath: '/kavita/Doujins/' }]]) {
    assert.equal(parseDownloaderSettings({ ...DEFAULT_DOWNLOADER, libraryPathMappings: value }), null);
  }
});

test('locates and renames mapped Manga archives without changing an identically named Doujin folder', async () => {
  const title = 'Shared title';
  const mangaDir = path.join(manga, title);
  const doujinDir = path.join(downloads, title);
  for (const dir of [mangaDir, doujinDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Chapter 1.cbz'), buildZip([{ name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Series>${title}</Series></ComicInfo>`) }]));
  }
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: downloads });
  assert.equal((await api.request('/settings/library-path-mappings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ libraryPathMappings: mappings }) })).status, 200);
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test-key' });
  let name = title;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/Library/libraries')) return Response.json([{ id: 2, name: 'Manga', type: 0, folders: ['/kavita/OtherRoot', '/kavita/Manga'] }]);
    if (url.endsWith('/Series/1')) return Response.json({ id: 1, libraryId: 2, name, folderPath: `/kavita/Manga/${title}` });
    if (url.endsWith('/Series/update')) { name = JSON.parse(String(init?.body)).name; return Response.json({}); }
    if (url.includes('/Series/metadata?')) return Response.json({ id: 1, seriesId: 1 });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  provider.getSeriesMetadata = async () => ({ providerId: 'anilist', providerSeriesId: '1', title: 'Accepted title', genres: [], tags: [], artists: [], writers: [] });
  const roots = await (await api.request('/cbz/roots')).json();
  assert.deepEqual(new Set(roots.roots), new Set([downloads, manga]));
  const files = await (await api.request('/cbz/series/1')).json();
  assert.equal(files.dir, mangaDir);
  const job: Job = { id: 999, type: 'apply-series', payload: { seriesId: 1, providerId: 'anilist', providerSeriesId: '1', cover: false }, status: 'running', progressCurrent: 0, progressTotal: 1, result: null, errorMessage: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
  const result = await runJob(job, () => {});
  assert.deepEqual(result, { processed: 1, matched: 1, failed: 0, titleFilesUpdated: 1, titleFilesVerified: 1 });
  assert.equal(name, 'Accepted title');
  assert.equal(parseComicInfo((await readComicInfo(path.join(mangaDir, 'Chapter 1.cbz')))!).fields.Series, 'Accepted title');
  assert.equal(parseComicInfo((await readComicInfo(path.join(doujinDir, 'Chapter 1.cbz')))!).fields.Series, title);
});
