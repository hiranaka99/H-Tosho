import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Job } from '../src/jobs/queue.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-cbz-edit-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required because the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb } = await import('../src/db/index.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { parseComicInfo } = await import('../src/downloader/comicinfo.js');
const { readComicInfo, setSeriesTitleInCbzFiles } = await import('../src/lib/cbz.js');
const { runJob } = await import('../src/jobs/executor.js');
const { setKavitaConnection } = await import('../src/services/settings.js');

initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'secret' });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('editing ComicInfo.Series updates Kavita and forces a targeted series scan', async () => {
  const file = path.join(dataDir, 'Atashi.cbz');
  fs.writeFileSync(file, buildZip([
    { name: '001.jpg', data: Buffer.from('image') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Atashi ga Nuite Ageyo kka?</Series></ComicInfo>') },
  ]));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/Series/42')) {
      return Response.json({ id: 42, libraryId: 7, name: 'Atashi ga Nuite Ageyo kka?', sortName: 'Atashi ga Nuite Ageyo kka?' });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const job: Job = {
    id: 1,
    type: 'edit-comicinfo',
    payload: { path: file, fields: { Series: 'Atashi ga Nuite Ageyokka?' }, seriesId: 42 },
    status: 'running',
    progressCurrent: 0,
    progressTotal: 0,
    result: null,
    errorMessage: null,
    createdAt: '',
    startedAt: '',
    finishedAt: null,
  };
  await runJob(job, () => {});

  assert.equal(parseComicInfo((await readComicInfo(file))!).fields.Series, 'Atashi ga Nuite Ageyokka?');
  const update = requests.find((request) => request.url.endsWith('/api/Series/update'));
  assert.equal(JSON.parse(String(update?.init?.body)).name, 'Atashi ga Nuite Ageyokka?');
  const scan = requests.find((request) => request.url.endsWith('/api/Series/scan'));
  assert.deepEqual(JSON.parse(String(scan?.init?.body)), {
    libraryId: 7,
    seriesId: 42,
    forceUpdate: true,
    forceColorscape: false,
  });
});

test('rewrites ComicInfo.Series in every CBZ while preserving chapter metadata', async () => {
  const files = ['Chapter 1.cbz', 'Chapter 2.cbz'].map((name, index) => {
    const file = path.join(dataDir, name);
    fs.writeFileSync(file, buildZip([
      { name: '001.jpg', data: Buffer.from(`image-${index}`) },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Title>Chapter ${index + 1}</Title><Series>Old Name</Series><Number>${index + 1}</Number></ComicInfo>`) },
    ]));
    return file;
  });

  assert.deepEqual(await setSeriesTitleInCbzFiles(files, 'Live!: Soto de Koubi Shiyou!'), { changed: 2, verified: 2 });
  for (const [index, file] of files.entries()) {
    const fields = parseComicInfo((await readComicInfo(file))!).fields;
    assert.equal(fields.Series, 'Live!: Soto de Koubi Shiyou!');
    assert.equal(fields.Title, `Chapter ${index + 1}`);
    assert.equal(fields.Number, String(index + 1));
  }
  assert.deepEqual(await setSeriesTitleInCbzFiles(files, 'Live!: Soto de Koubi Shiyou!'), { changed: 0, verified: 2 });
});
