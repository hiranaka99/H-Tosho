import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-download-views-'));
process.env.HTOSHO_DATA_DIR = dataDir;
// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { DownloadQueue } = await import('../src/downloader/engine.js');
const { DEFAULT_DOWNLOADER, setKavitaConnection } = await import('../src/services/settings.js');
const { currentMatchConnection } = await import('../src/services/matchSuggestions.js');
const { downloadLibraryStates } = await import('../src/services/downloadLibraryState.js');
initDb();

const queue = new DownloadQueue(() => ({ ...DEFAULT_DOWNLOADER }));
const iso = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 1, 12, 0) - minutesAgo * 60_000).toISOString();

function insertTask(values: Partial<typeof schema.downloadQueue.$inferInsert>): number {
  return getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: `g-${Math.random()}`, title: 'Task', ...values })
    .returning({ id: schema.downloadQueue.id }).get().id;
}

beforeEach(() => {
  const db = getDb();
  for (const table of [schema.jobs, schema.matchSuggestions, schema.downloadQueue]) db.delete(table).run();
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
});

test('the manager list never drops active or failed tasks behind a long completed history', () => {
  const failed = insertTask({ status: 'failed', errorMessage: 'HTTP 403', errorCode: 'access-denied', finishedAt: iso(500) });
  const paused = insertTask({ status: 'paused' });
  for (let index = 0; index < 8; index++) insertTask({ status: 'completed', outputPath: `/out/${index}.cbz`, finishedAt: iso(index) });

  const list = queue.listForManager(3);
  const ids = list.map((task) => task.id);
  assert.ok(ids.includes(failed), 'an old failure stays visible');
  assert.ok(ids.includes(paused), 'paused work stays visible');
  assert.equal(list.filter((task) => task.status === 'completed').length, 3, 'completed history is capped');
  // The newest finishes are the ones kept.
  assert.deepEqual(list.filter((task) => task.status === 'completed').map((task) => task.outputPath).sort(), ['/out/0.cbz', '/out/1.cbz', '/out/2.cbz']);
});

test('completed history pages by finish time and reports the full count', () => {
  for (let index = 0; index < 5; index++) insertTask({ status: 'completed', outputPath: `/out/${index}.cbz`, finishedAt: iso(index * 10) });
  insertTask({ status: 'queued' });
  const first = queue.completedHistory(0, 2);
  const second = queue.completedHistory(2, 2);
  assert.equal(first.total, 5);
  assert.deepEqual(first.items.map((task) => task.outputPath), ['/out/0.cbz', '/out/1.cbz']);
  assert.deepEqual(second.items.map((task) => task.outputPath), ['/out/2.cbz', '/out/3.cbz']);
});

test('library state follows the newest import task for each completed download', () => {
  const db = getDb();
  const out = path.resolve(dataDir, 'lib');
  const imported = insertTask({ status: 'completed', outputPath: path.join(out, 'A', 'A.cbz') });
  const importing = insertTask({ status: 'completed', outputPath: path.join(out, 'B', 'B.cbz') });
  const failed = insertTask({ status: 'completed', outputPath: path.join(out, 'C', 'C.cbz') });
  const untracked = insertTask({ status: 'completed', outputPath: path.join(out, 'D', 'D.cbz') });
  const job = (status: string, file: string, context?: unknown, errorMessage?: string) => db.insert(schema.jobs).values({
    type: 'scan-downloaded', status, payloadJson: JSON.stringify({ path: path.join(out, file), connectionKey: currentMatchConnection() }),
    stateJson: JSON.stringify(context ? { context } : {}), errorMessage: errorMessage ?? null,
  }).returning({ id: schema.jobs.id }).get().id;

  job('failed', 'A/A.cbz', undefined, 'An older attempt');
  const importedJob = job('completed', 'A/A.cbz', { series: [{ id: 41, name: 'Series A' }], libraryId: 1 });
  const importingJob = job('running', 'B/B.cbz');
  const failedJob = job('failed', 'C/C.cbz', undefined, 'Could not locate the Kavita library folder');
  db.insert(schema.matchSuggestions).values({
    connectionKey: currentMatchConnection(), seriesId: 41, name: 'Series A', libraryId: 1, libraryName: 'Doujinshi',
    candidatesJson: JSON.stringify([{ providerId: 'anilist', providerSeriesId: '1', title: 'Series A', score: 0.9 }]), checkedAt: iso(0),
  }).run();

  const states = downloadLibraryStates([imported, importing, failed, untracked]);
  assert.deepEqual(states[imported], { state: 'imported', jobId: importedJob, series: [{ id: 41, name: 'Series A' }], review: true });
  assert.deepEqual(states[importing], { state: 'importing', jobId: importingJob });
  assert.deepEqual(states[failed], { state: 'failed', jobId: failedJob, message: 'Could not locate the Kavita library folder' });
  assert.equal(states[untracked], undefined, 'no import task means no claim about Kavita');
});
