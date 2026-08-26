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
const { setKavitaConnection } = await import('../src/services/settings.js');

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
      state.lastScanned = `t${libraryScans + 1}`;
      state.indexed = [...state.preExistingFiles, ...allMoved];
      return Response.json({ ok: true });
    }
    if (url.endsWith('/api/Series/scan')) {
      // Targeted rescan picks up whatever the in-flight pass missed.
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
  };
  globalThis.fetch = fakeKavita(state, targetDir, sources);

  const result = await runJob(makeJob(sources, targetDir), () => {});

  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  // Series-level rescan only — the series already exists in Kavita.
  assert.ok(!state.requests.some((u) => u.includes('/api/Library/scan')));
  assert.ok(state.requests.some((u) => u.endsWith('/api/Series/scan')));
});
