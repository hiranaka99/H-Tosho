import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, test, type TestContext } from 'node:test';
import type { Job } from '../src/jobs/queue.js';
import { parseComicInfo } from '../src/downloader/comicinfo.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-merge-rescan-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required because the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb } = await import('../src/db/index.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { runJob } = await import('../src/jobs/executor.js');
const { listMetadataHistory, metadataHistoryDetail } = await import('../src/services/metadataHistory.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } = await import('../src/services/settings.js');

initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'secret' });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function finishWithScanClock<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let done = false;
  const result = run().finally(() => { done = true; });
  // The caller asserts rejections after the virtual polling loop finishes.
  void result.catch(() => {});
  const deadline = performance.now() + 5000;
  while (!done && performance.now() < deadline) {
    for (let flush = 0; flush < 20; flush++) await setImmediate();
    if (done) return result;
    t.mock.timers.tick(5_000);
  }
  assert.fail('Scan verification did not finish');
}

/** One .cbz per source folder, like three separately downloaded chapters. */
function makeSources(): string[] {
  return [1, 2, 3].map((n) => {
    const dir = path.join(dataDir, `src-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Chapter ${n}.cbz`);
    fs.writeFileSync(file, buildZip([
      { name: '001.jpg', data: Buffer.from(`image-${n}`) },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old Name</Series></ComicInfo>') },
    ]));
    return file;
  });
}

function makeJob(sourceFiles: string[], targetDir: string): Job {
  return {
    id: 1,
    type: 'merge-series',
    payload: { sourceFiles, targetDir },
    status: 'running',
    progressCurrent: 0,
    progressTotal: 0,
    result: null,
    errorMessage: null,
    createdAt: '',
    startedAt: '',
    finishedAt: null,
  };
}

test('one merge job commits staged existing chapters without moving or renaming them', async () => {
  const sources = makeSources();
  const targetDir = path.join(dataDir, 'staged-chapters');
  fs.mkdirSync(targetDir, { recursive: true });
  const existing = path.join(targetDir, 'Existing.cbz');
  fs.writeFileSync(existing, buildZip([
    { name: '001.jpg', data: Buffer.from('existing-image') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Keep This Name</Series><Number>12</Number></ComicInfo>') },
  ]));
  const cleared = path.join(targetDir, 'Cleared.cbz');
  fs.writeFileSync(cleared, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Keep This Name</Series><Number>8</Number></ComicInfo>') }]));
  const state: FakeKavita = { requests: [], indexed: [existing, cleared], lastScanned: 't0', preExistingSeries: true, preExistingFiles: [existing, cleared], dropFirstLibraryScan: false, taskPending: false };
  globalThis.fetch = fakeKavita(state, targetDir, sources);
  const job = makeJob(sources, targetDir);
  job.payload.existingChapters = { [existing]: '7.5', [cleared]: '' };
  job.payload.chapters = { [sources[0]]: '13' };
  const result = await runJob(job, () => {});
  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  assert.ok(fs.existsSync(existing));
  const metadata = parseComicInfo((await readComicInfo(existing))!);
  assert.equal(metadata.fields.Number, '7.5');
  assert.equal(metadata.fields.Series, 'Keep This Name');
  assert.equal(parseComicInfo((await readComicInfo(cleared))!).fields.Number ?? '', '');
  const movedMetadata = await readComicInfo(path.join(targetDir, path.basename(sources[0])));
  assert.equal(parseComicInfo(movedMetadata!).fields.Number, '13');
});

test('invalid existing chapter edits fail before any incoming archive moves', async () => {
  const sources = makeSources();
  const targetDir = path.join(dataDir, 'invalid-staged-chapters');
  fs.mkdirSync(targetDir, { recursive: true });
  const job = makeJob(sources, targetDir);
  job.payload.existingChapters = { [sources[0]]: '4' };
  await assert.rejects(runJob(job, () => {}), /not an existing target archive/);
  assert.ok(sources.every(file => fs.existsSync(file)));
  assert.deepEqual(fs.readdirSync(targetDir), []);
  const existing = path.join(targetDir, 'Existing.cbz');
  fs.writeFileSync(existing, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Number>12</Number></ComicInfo>') }]));
  job.payload.existingChapters = { [existing]: '0' };
  await assert.rejects(runJob(job, () => {}), /positive numbers or blank/);
  assert.ok(sources.every(file => fs.existsSync(file)));
  assert.equal(parseComicInfo((await readComicInfo(existing))!).fields.Number, '12');
});

for (const preExistingSeries of [false, true]) test(`library merge uses the chosen name with a custom folder (${preExistingSeries ? 'existing' : 'new'} destination)`, async t => {
  const sources = makeSources();
  const targetDir = path.join(dataDir, `custom-folder-${preExistingSeries}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const existing = path.join(targetDir, 'Existing.cbz');
  fs.writeFileSync(existing, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old Name</Series><Number>7</Number><Writer>Keep Author</Writer></ComicInfo>') }]));
  const state: FakeKavita = { requests: [], indexed: preExistingSeries ? [existing] : [], lastScanned: 't0', preExistingSeries, preExistingFiles: [existing], dropFirstLibraryScan: false, taskPending: false };
  const fixtureFetch = fakeKavita(state, targetDir, sources.map(file => path.join(targetDir, path.basename(file))));
  const updates: { id: number; name: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/api/Series/update')) updates.push(JSON.parse(String(init?.body)));
    if (String(input).includes('/api/Search/chapters-by-series?seriesId=49')) return Response.json([]);
    const response = await fixtureFetch(input, init);
    if (String(input).includes('/api/Series/all-v2')) {
      const series = await response.json() as { id: number; libraryId: number; name: string; folderPath: string }[];
      if (series.length) series.unshift({ id: 49, libraryId: 7, name: 'Unrelated series', folderPath: path.join(dataDir, 'Other artist', path.basename(targetDir)) });
      return Response.json(series);
    }
    return response;
  }) as typeof fetch;
  const job = makeJob(sources, targetDir);
  job.payload.seriesName = '  Collected & Renamed  ';
  job.payload.chapters = { [sources[0]]: '1.5' };
  const result = await finishWithScanClock(t, () => runJob(job, () => {}));
  assert.equal(result.failed, 0);
  assert.deepEqual(updates.map(update => ({ id: update.id, name: update.name })), [{ id: 50, name: 'Collected & Renamed' }]);
  const updateIndex = state.requests.findIndex(url => url.endsWith('/api/Series/update'));
  const scanIndex = state.requests.findIndex(url => url.includes('/api/Library/scan') || url.endsWith('/api/Series/scan'));
  assert.equal(updateIndex < scanIndex, preExistingSeries, 'Existing destinations are renamed before scanning; new ones after discovery');
  for (const file of fs.readdirSync(targetDir)) assert.equal(parseComicInfo((await readComicInfo(path.join(targetDir, file)))!).fields.Series, 'Collected & Renamed');
  const metadata = parseComicInfo((await readComicInfo(existing))!).fields;
  assert.equal(metadata.Number, '7');
  assert.equal(metadata.Writer, 'Keep Author');
  assert.equal(parseComicInfo((await readComicInfo(path.join(targetDir, path.basename(sources[0]))))!).fields.Number, '1.5');
});

interface FakeKavita {
  requests: string[];
  /** Files Kavita has indexed for the merged series (absolute paths). */
  indexed: string[];
  lastScanned: string;
  /** Series exists in Kavita from the start (pre-existing folder). */
  preExistingSeries: boolean;
  /** Books already in the target folder before the merge. */
  preExistingFiles: string[];
  /** The first library scan request is dropped because an older scan is still in flight. */
  dropFirstLibraryScan: boolean;
  /** A scan task shows up in is-task-running until the next poll after a scan request. */
  taskPending: boolean;
}

/**
 * Fake Kavita server. `allMoved` are the files a completed scan would index into the
 * merged series; `state.indexed` is what Kavita actually has at any moment.
 */
function fakeKavita(state: FakeKavita, targetDir: string, allMoved: string[]) {
  let libraryScans = 0;
  let seriesName='Promeia';
  const series = () => [{ id: 50, libraryId: 7, name: seriesName, folderPath: targetDir }];
  const moved = allMoved.map(file=>path.join(targetDir,path.basename(file)));
  return (async (input: unknown,init?:RequestInit) => {
    const url = String(input);
    state.requests.push(url);
    if (url.endsWith('/api/Series/update')) {
      const update:unknown=JSON.parse(String(init?.body));
      if (!update || typeof update!=='object' || !('name' in update) || typeof update.name!=='string') throw Error('Invalid fixture series title');
      seriesName=update.name;return Response.json({ok:true});
    }
    if (url.includes('/api/Library/libraries')) {
      return Response.json([{ id: 7, name: 'Downloads', folders: [dataDir], type: 0, lastScanned: state.lastScanned }]);
    }
    if (url.includes('/api/Server/is-task-running')) {
      // The scan requested on the previous call is in flight exactly once: the
      // first poll after it reports running, the next one idle.
      if (state.taskPending) {
        state.taskPending = false;
        return Response.json(true);
      }
      return Response.json(false);
    }
    if (url.endsWith('/api/Series/50')) return Response.json(series()[0]);
    if (url.includes('/api/Series/all-v2')) {
      const registered = state.preExistingSeries || state.indexed.length > 0;
      return Response.json(registered ? series() : []);
    }
    if (url.includes('/api/Library/scan')) {
      libraryScans += 1;
      // First request lands while an older scan is still walking the tree: it is
      // dropped, and that in-flight pass finishes having indexed only part of the move.
      if (state.dropFirstLibraryScan && libraryScans === 1) {
        state.lastScanned = 't1';
        state.indexed = [...state.preExistingFiles, ...moved.slice(0, 2)];
        return Response.json({ ok: true });
      }
      state.taskPending = true;
      state.lastScanned = `t${libraryScans + 1}`;
      state.indexed = [...state.preExistingFiles, ...moved];
      return Response.json({ ok: true });
    }
    if (url.endsWith('/api/Series/scan')) {
      // Targeted rescan picks up whatever the in-flight pass missed.
      state.taskPending = true;
      state.indexed = [...state.preExistingFiles, ...moved];
      return Response.json({ ok: true });
    }
    if (url.includes('/api/Search/chapters-by-series')) {
      const chapters = state.indexed.map((file, i) => ({ id: i + 1, files: [{ id: i + 1, filePath: file }] }));
      return Response.json(chapters);
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
}

test('merge rescan verifies every moved file lands in Kavita', async () => {
  const sources = makeSources();
  const targetDir = path.join(dataDir, 'Promeia');
  // The reported bug: an auto-sync scan from the last download is still running when the
  // merge fires its rescan. That in-flight pass registers the series with only the first
  // two chapters; the verification loop must rescan until chapter 3 is indexed too.
  const state: FakeKavita = {
    requests: [],
    indexed: [],
    lastScanned: 't0',
    preExistingSeries: false,
    preExistingFiles: [],
    dropFirstLibraryScan: true,
    taskPending: false,
  };
  globalThis.fetch = fakeKavita(state, targetDir, sources);

  const result = await runJob(makeJob(sources, targetDir), () => {});

  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  assert.equal(state.requests.filter((u) => u.includes('/api/Library/scan')).length, 1, 'one library scan (the dropped one)');
  assert.ok(state.requests.some((u) => u.endsWith('/api/Series/scan')), 'targeted series rescan follows up');
  const names = fs.readdirSync(targetDir).sort();
  assert.deepEqual(names, ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz']);
});

test('merge rescan succeeds when the first scan indexes everything', async () => {
  const sources = makeSources();
  const targetDir = path.join(dataDir, 'Promeia-clean');
  const state: FakeKavita = {
    requests: [],
    indexed: [],
    lastScanned: 't0',
    preExistingSeries: false,
    preExistingFiles: [],
    dropFirstLibraryScan: false,
    taskPending: false,
  };
  globalThis.fetch = fakeKavita(state, targetDir, sources);

  const result = await runJob(makeJob(sources, targetDir), () => {});

  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  assert.equal(state.requests.filter((u) => u.includes('/api/Library/scan')).length, 1);
  assert.ok(!state.requests.some((u) => u.endsWith('/api/Series/scan')), 'no follow-up scan needed');
});

test('merge rescan is not skewed by books already in the target folder', async () => {
  const sources = makeSources();
  const targetDir = path.join(dataDir, 'Promeia-existing');
  const preExisting = path.join(targetDir, 'Special.cbz');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(preExisting, buildZip([{ name: '001.jpg', data: Buffer.from('special') }]));
  const state: FakeKavita = {
    requests: [],
    indexed: [preExisting],
    lastScanned: 't0',
    preExistingSeries: true,
    preExistingFiles: [preExisting],
    dropFirstLibraryScan: false,
    taskPending: false,
  };
  globalThis.fetch = fakeKavita(state, targetDir, sources);

  const result = await runJob(makeJob(sources, targetDir), () => {});

  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  // Series-level rescan only — the series already exists in Kavita.
  assert.ok(!state.requests.some((u) => u.includes('/api/Library/scan')));
  assert.ok(state.requests.some((u) => u.endsWith('/api/Series/scan')));
});

test('merge into an existing Kavita series targets that series folder and stamps its Series name', async () => {
  // The target series already exists in Kavita with one chapter on disk.
  const targetDir = path.join(dataDir, 'Ojisan');
  fs.mkdirSync(targetDir, { recursive: true });
  const existing = path.join(targetDir, 'Chapter 4.cbz');
  fs.writeFileSync(existing, buildZip([
    { name: '001.jpg', data: Buffer.from('image-x') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>The Time-Stopper Ojisan</Series><Number>4</Number></ComicInfo>') },
  ]));

  // The separately downloaded part, still in its own per-gallery folder.
  const srcDir = path.join(dataDir, 'src-5');
  fs.mkdirSync(srcDir, { recursive: true });
  const src = path.join(srcDir, 'Part 5.cbz');
  fs.writeFileSync(src, buildZip([
    { name: '001.jpg', data: Buffer.from('image-5') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>He Was Here!! The Time-Stopper Ojisan 5</Series></ComicInfo>') },
  ]));

  const requests: string[] = [];
  let scanned = false;
  let taskPending = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/api/Server/is-task-running')) {
      if (taskPending) {
        taskPending = false;
        return Response.json(true);
      }
      return Response.json(false);
    }
    if (url.endsWith('/api/Series/50')) {
      return Response.json({ id: 50, libraryId: 7, name: 'The Time-Stopper Ojisan', folderPath: 'Ojisan' });
    }
    if (url.includes('/api/Library/libraries')) {
      return Response.json([{ id: 7, name: 'Downloads', folders: [dataDir], type: 0, lastScanned: scanned ? 't1' : 't0' }]);
    }
    if (url.includes('/api/Series/all-v2')) {
      return Response.json([
        { id: 50, libraryId: 7, name: 'The Time-Stopper Ojisan', folderPath: 'Ojisan' },
        { id: 51, libraryId: 7, name: 'He Was Here!! The Time-Stopper Ojisan 5', folderPath: 'src-5' },
      ]);
    }
    if (url.endsWith('/api/Series/scan') || url.includes('/api/Library/scan')) {
      scanned = true;
      taskPending = true;
      return Response.json({ ok: true });
    }
    if (url.includes('/api/Search/chapters-by-series')) {
      const id=Number(new URL(url).searchParams.get('seriesId'));
      const files = id===51 ? [src] : [existing,...(scanned?[path.join(targetDir,'Part 5.cbz')]:[])];
      return Response.json(files.map((f, i) => ({ id: i + 1, files: [{ id: i + 1, filePath: f }] })));
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const job: Job = { ...makeJob([src], targetDir), payload: { sourceFiles: [src], seriesId: 50, chapters: { [src]: '5' } } };
  const result = await runJob(job, () => {});

  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  // The archive moved into the target series folder…
  assert.deepEqual(fs.readdirSync(targetDir).sort(), ['Chapter 4.cbz', 'Part 5.cbz']);
  // …and adopted the existing ComicInfo.Series value plus its chapter number.
  const xml = await readComicInfo(path.join(targetDir, 'Part 5.cbz'));
  assert.ok(xml?.includes('The Time-Stopper Ojisan]]>') || xml?.includes('<Series>The Time-Stopper Ojisan</Series>'), `stamped series name, got: ${xml}`);
  assert.ok(xml?.includes('<Number><![CDATA[5]]></Number>') || xml?.includes('<Number>5</Number>'), `stamped chapter number, got: ${xml}`);
  // The emptied source folder's stale Kavita series is removed.
  assert.ok(requests.some((r) => r.startsWith('DELETE') && r.endsWith('/api/Series/51')), 'stale source series deleted');
  const operation = listMetadataHistory(50).items[0];
  assert.equal(operation.origin, 'merge-metadata');
  assert.equal(operation.status, 'unverified', 'a moved source is not advertised as a verified/restorable archive');
  const history = metadataHistoryDetail(50, operation.id)!;
  assert.equal(history.archives.length, 2, 'capture incoming and existing archive metadata');
  assert.equal(history.archives.find(archive => archive.target === 'Part 5.cbz')!.afterPresent, null);
  assert.equal(history.archives.find(archive => archive.target === 'Chapter 4.cbz')!.status, 'observed');
});

test('merge into an existing series still rescans when host and Kavita paths differ (bind mount)', async () => {
  // Production regression: H-Tosho's download directory is a bind mount of
  // Kavita's library root (/mnt/downloads vs /media/Doujins), so no path
  // comparison can find the library. The job's seriesId must drive the rescan —
  // otherwise Kavita never re-indexes the moved and stamped files.
  const hostRoot = path.join(dataDir, 'mnt-downloads');
  const targetDir = path.join(hostRoot, "Drop-in Gyaru Let's Me Use Her Pussy");
  fs.mkdirSync(targetDir, { recursive: true });
  const existing = path.join(targetDir, 'Drop-in Gyaru Lets Me Use Her Pussy 5.cbz');
  fs.writeFileSync(existing, buildZip([
    { name: '001.jpg', data: Buffer.from('image-b') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Drop-in Gyaru Lets Me Use Her Pussy</Series><Number>2</Number></ComicInfo>') },
  ]));
  const srcDir = path.join(hostRoot, 'Iribitari Gal ni Manko Tsukawasete morau Hanashi 4.5 [hitomi-3969289]');
  fs.mkdirSync(srcDir, { recursive: true });
  const src = path.join(srcDir, 'Iribitari 4.5 [hitomi-3969289].cbz');
  fs.writeFileSync(src, buildZip([
    { name: '001.jpg', data: Buffer.from('image-c') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Iribitari 4.5</Series></ComicInfo>') },
  ]));

  const requests: string[] = [];
  let taskPending = false;
  let indexedAfterScan = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/api/Server/is-task-running')) {
      if (taskPending) {
        taskPending = false;
        return Response.json(true);
      }
      return Response.json(false);
    }
    if (url.endsWith('/api/Series/213')) {
      return Response.json({ id: 213, libraryId: 7, name: 'Drop-in Gyaru Lets Me Use Her Pussy', folderPath: '/media/Doujins/Drop-in Gyaru Let\'s Me Use Her Pussy' });
    }
    if (url.includes('/api/Library/libraries')) {
      // Kavita's view of the library root — a different mount point than hostRoot.
      return Response.json([{ id: 7, name: 'Doujins', folders: ['/media/Doujins'], type: 0, lastScanned: 't0' }]);
    }
    if (url.includes('/api/Series/all-v2')) {
      return Response.json([{ id:213,libraryId:7,name:'Drop-in Gyaru Lets Me Use Her Pussy',folderPath:'/media/Doujins/Drop-in Gyaru Let\'s Me Use Her Pussy' }]);
    }
    if (url.endsWith('/api/Series/scan')) {
      taskPending = true;
      indexedAfterScan = true;
      return Response.json({ ok: true });
    }
    if (url.includes('/api/Search/chapters-by-series?seriesId=213')) {
      const files = indexedAfterScan ? [existing, path.join(targetDir, 'Iribitari 4.5 [hitomi-3969289].cbz')] : [existing];
      return Response.json(files.map((f, i) => ({ id: i + 1, number: String(i === 0 ? 3 : 2), files: [{ id: i + 1, filePath: `/media/Doujins/${path.relative(hostRoot,f).replace(/\\/g,'/')}` }] })));
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  // Protection authority requires an explicit mapping, not folder-name guessing.
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: hostRoot,libraryPathMappings:[{kavitaPath:'/media/Doujins',localPath:hostRoot}] });
  const job: Job = { ...makeJob([src], targetDir), payload: { sourceFiles: [src], seriesId: 213, chapters: { [src]: '2' } } };
  const result = await runJob(job, () => {});

  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  // The rescan was requested and verified against the known series instead of
  // being skipped with "no Kavita library contains this folder".
  assert.ok(requests.some((r) => r.startsWith('POST ') && r.endsWith('/api/Series/scan')), 'series rescan requested despite path mismatch');
  assert.ok(requests.some((r) => r.includes('/api/Search/chapters-by-series?seriesId=213')), 'indexed files verified against the known series');
});

test('edit-comicinfo retries a deferred scan until Kavita indexes the new chapter number', async (t) => {
  const dir = path.join(dataDir, 'renumber');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Chapter 5.cbz');
  fs.writeFileSync(file, buildZip([
    { name: '001.jpg', data: Buffer.from('image-r') },
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Renumber</Series><Number>2</Number></ComicInfo>') },
  ]));

  const state = { scans: 0, taskPending: false };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/Server/is-task-running')) {
      if (state.taskPending) {
        state.taskPending = false;
        return Response.json(true);
      }
      return Response.json(false);
    }
    if (url.endsWith('/api/Series/50')) {
      return Response.json({ id: 50, libraryId: 7, name: 'Renumber', folderPath: dir });
    }
    if (url.endsWith('/api/Series/scan')) {
      state.scans += 1;
      state.taskPending = true;
      return Response.json({ ok: true });
    }
    if (url.includes('/api/Search/chapters-by-series?seriesId=50')) {
      // The first completed scan still reports the old number; only after the
      // follow-up rescan does Kavita show the one we wrote.
      return Response.json([{ id: 1, number: state.scans >= 2 ? '3' : '2', files: [{ id: 1, filePath: file }] }]);
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const job: Job = { ...makeJob([], dir), type: 'edit-comicinfo', payload: { path: file, seriesId: 50, fields: { Number: '3' } } };
  const logs: string[] = [];
  const result = await finishWithScanClock(t, () => runJob(job, (level, message) => logs.push(`${level}: ${message}`)));

  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  assert.equal(state.scans, 2, 'stale chapter number triggers a follow-up rescan');
  const xml = await readComicInfo(file);
  assert.ok(xml?.includes('<Number>3</Number>') || xml?.includes('<Number><![CDATA[3]]></Number>'), `file carries the new number, got: ${xml}`);
  assert.ok(logs.some((l) => l.startsWith('success') && l.includes('as chapter 3')), 'verified indexed under the new number');
});

test('edit-comicinfo fails with manual-scan guidance when Kavita never picks up the new number', async (t) => {
  process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS = '1000';
  try {
    const dir = path.join(dataDir, 'renumber-stuck');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'Chapter 5.cbz');
    fs.writeFileSync(file, buildZip([
      { name: '001.jpg', data: Buffer.from('image-s') },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Stuck</Series><Number>2</Number></ComicInfo>') },
    ]));

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/Server/is-task-running')) return Response.json(false);
      if (url.endsWith('/api/Series/50')) {
        return Response.json({ id: 50, libraryId: 7, name: 'Stuck', folderPath: dir });
      }
      if (url.endsWith('/api/Series/scan')) return Response.json({ ok: true });
      if (url.includes('/api/Search/chapters-by-series?seriesId=50')) {
        // Kavita keeps answering with the old number no matter how often we rescan.
        return Response.json([{ id: 1, number: '2', files: [{ id: 1, filePath: file }] }]);
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const job: Job = { ...makeJob([], dir), type: 'edit-comicinfo', payload: { path: file, seriesId: 50, fields: { Number: '3' } } };
    await assert.rejects(
      finishWithScanClock(t, () => runJob(job, () => {})),
      /ComicInfo\.xml was saved.*manual scan/,
    );
  } finally {
    delete process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS;
  }
});
