import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Job } from '../src/jobs/queue.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-merge-rescan-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required because the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb } = await import('../src/db/index.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { runJob } = await import('../src/jobs/executor.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } = await import('../src/services/settings.js');

initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'secret' });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
  const series = () => [{ id: 50, libraryId: 7, name: 'Promeia', folderPath: targetDir }];
  return (async (input: unknown) => {
    const url = String(input);
    state.requests.push(url);
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
        state.indexed = [...state.preExistingFiles, ...allMoved.slice(0, 2)];
        return Response.json({ ok: true });
      }
      state.taskPending = true;
      state.lastScanned = `t${libraryScans + 1}`;
      state.indexed = [...state.preExistingFiles, ...allMoved];
      return Response.json({ ok: true });
    }
    if (url.endsWith('/api/Series/scan')) {
      // Targeted rescan picks up whatever the in-flight pass missed.
      state.taskPending = true;
      state.indexed = [...state.preExistingFiles, ...allMoved];
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
      const files = [existing, path.join(targetDir, 'Part 5.cbz')];
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
    if (url.endsWith('/api/Series/scan')) {
      taskPending = true;
      return Response.json({ ok: true });
    }
    if (url.includes('/api/Search/chapters-by-series?seriesId=213')) {
      const files = [existing, path.join(targetDir, 'Iribitari 4.5 [hitomi-3969289].cbz')];
      return Response.json(files.map((f, i) => ({ id: i + 1, number: String(i === 0 ? 3 : 2), files: [{ id: i + 1, filePath: f }] })));
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  // The download directory is the only bridge between the two mount points.
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: hostRoot });
  const job: Job = { ...makeJob([src], targetDir), payload: { sourceFiles: [src], seriesId: 213, chapters: { [src]: '2' } } };
  const result = await runJob(job, () => {});

  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  // The rescan was requested and verified against the known series instead of
  // being skipped with "no Kavita library contains this folder".
  assert.ok(requests.some((r) => r.startsWith('POST ') && r.endsWith('/api/Series/scan')), 'series rescan requested despite path mismatch');
  assert.ok(requests.some((r) => r.includes('/api/Search/chapters-by-series?seriesId=213')), 'indexed files verified against the known series');
});

test('edit-comicinfo re-requests the scan until Kavita indexes the new chapter number', async () => {
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
  const result = await runJob(job, (level, message) => logs.push(`${level}: ${message}`));

  assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
  assert.equal(state.scans, 2, 'stale chapter number triggers a follow-up rescan');
  const xml = await readComicInfo(file);
  assert.ok(xml?.includes('<Number>3</Number>') || xml?.includes('<Number><![CDATA[3]]></Number>'), `file carries the new number, got: ${xml}`);
  assert.ok(logs.some((l) => l.startsWith('success') && l.includes('as chapter 3')), 'verified indexed under the new number');
});

test('edit-comicinfo reports a manual-scan warning when Kavita never picks up the new number', async () => {
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
    const logs: string[] = [];
    const result = await runJob(job, (level, message) => logs.push(`${level}: ${message}`));

    assert.deepEqual(result, { processed: 1, matched: 0, failed: 0 });
    assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('manual scan')), `gives up with an actionable warning, got: ${logs.join(' | ')}`);
  } finally {
    delete process.env.HTOSHO_EDIT_VERIFY_TIMEOUT_MS;
  }
});
