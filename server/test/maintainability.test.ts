import { readJobPayload } from '../src/jobs/storage.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MutationCoordinator } from '../src/lib/mutations.js';
import { parseJobCommand } from '../src/contracts/jobs.js';
import { downloadState } from '../src/contracts/downloads.js';
import { migrateSchema, splitLegacyJobState } from '../src/db/migrations.js';
import { buildZip } from '../src/downloader/zip.js';
import { readComicInfo, setComicInfoFields } from '../src/lib/cbz.js';
import { parseComicInfo } from '../src/downloader/comicinfo.js';
import { waitForScan } from '../src/kavita/scans.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('conflicting mutations serialize, independent targets overlap, and broad work is not starved', async () => {
  const owner = new MutationCoordinator();
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = owner.run(['series:1'], async () => { order.push('first'); await gate.promise; });
  await tick();
  const same = owner.run(['series:1'], async () => { order.push('same'); });
  const independent = owner.run(['series:2'], async () => { order.push('independent'); });
  await independent;
  assert.deepEqual(order, ['first', 'independent']);
  const broad = owner.run(['*'], async () => { order.push('broad'); });
  const later = owner.run(['series:3'], async () => { order.push('later'); });
  await tick();
  assert.equal(order.includes('later'), false);
  gate.resolve();
  await Promise.all([first, same, broad, later]);
  assert.deepEqual(order, ['first', 'independent', 'same', 'broad', 'later']);
  await assert.rejects(owner.run(['series:1'], async () => { throw new Error('failed'); }), /failed/);
  await owner.run(['series:1'], async () => {});
});

test('concurrent ComicInfo field edits preserve both changes and every image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-concurrent-archives-'));
  try {
    const file = path.join(dir, 'book.cbz');
    fs.writeFileSync(file, buildZip([{ name: '001.jpg', data: Buffer.from('image') }, { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Original</Series></ComicInfo>') }]));
    await Promise.all([setComicInfoFields(file, { Number: '3' }), setComicInfoFields(file, { Title: 'Chapter' })]);
    const fields = parseComicInfo((await readComicInfo(file))!).fields;
    assert.equal(fields.Series, 'Original');
    assert.equal(fields.Number, '3');
    assert.equal(fields.Title, 'Chapter');
    assert.deepEqual(fs.readdirSync(dir), ['book.cbz']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('job command validation rejects malformed targets and strips internal checkpoints', () => {
  for (const payload of [{ seriesId: '1' }, { seriesId: 0 }, { seriesIds: [1, '2'] }, {}]) assert.throws(() => parseJobCommand('match-series', payload));
  assert.throws(() => parseJobCommand('apply-series', { seriesId: 1, providerId: 'anilist' }));
  assert.throws(() => parseJobCommand('edit-comicinfo', { path: '/book.cbz', fields: { Number: 3 } }));
  assert.deepEqual(parseJobCommand('match-series', { seriesIds: [1], context: { series: [] }, mergeDownloadIds: { fake: 99 } }), { type: 'match-series', payload: { seriesIds: [1] } });
});

test('schema bootstrap and legacy upgrades preserve data and apply once', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, progress_current INTEGER DEFAULT 0, progress_total INTEGER DEFAULT 0, result_json TEXT, error_message TEXT, created_at TEXT DEFAULT current_timestamp, started_at TEXT, finished_at TEXT)");
    db.prepare('INSERT INTO jobs (id,type,payload_json,status) VALUES (1,?,?,?)').run('match-series', JSON.stringify({ seriesIds: [42], context: { series: [{ id: 42, name: 'Original' }] } }), 'queued');
    migrateSchema(db);
    const row = db.prepare('SELECT payload_json, state_json FROM jobs WHERE id=1').get() as { payload_json: string; state_json: string };
    assert.deepEqual(JSON.parse(row.payload_json), { seriesIds: [42] });
    assert.equal(JSON.parse(row.state_json).context.series[0].name, 'Original');
    migrateSchema(db);
    assert.equal((db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, 3);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='match_suggestions'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='rejected_match_candidates'").get());
    assert.equal((db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n, 1);
    const columns = db.prepare('PRAGMA table_info(download_queue)').all() as { name: string }[];
    assert.ok(['retry_at', 'retry_count', 'attempt', 'revision', 'error_code'].every(name => columns.some(column => column.name === name)));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='field_config'").get(), undefined);
  } finally { db.close(); }
});

test('failed schema migration rolls back changes and does not stamp its version', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE download_queue (id INTEGER PRIMARY KEY)');
    assert.throws(() => migrateSchema(db));
    assert.equal((db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='series_matches'").get(), undefined);
  } finally { db.close(); }
});

test('download lifecycle distinguishes cancellation and a scheduled retry from permanent failure', () => {
  assert.deepEqual(downloadState({ status: 'failed', errorCode: 'cancelled', retryAt: null, retryCount: 0 }), { type: 'cancelled' });
  assert.deepEqual(downloadState({ status: 'failed', errorCode: 'network', retryAt: 'later', retryCount: 1 }), { type: 'retry-wait', retryAt: 'later', retryCount: 1 });
  assert.deepEqual(downloadState({ status: 'failed', errorCode: 'download-failed', retryAt: null, retryCount: 0 }), { type: 'failed' });
});

test('scan waiting distinguishes unavailable status, deadline, and completed scans', async () => {
  assert.equal(await waitForScan({ async isTaskRunning() { throw new Error('offline'); } }, { deadline: Date.now() + 100 }), 'status-unavailable');
  assert.equal(await waitForScan({ async isTaskRunning() { return true; } }, { deadline: Date.now() - 1 }), 'timed-out');
  let reads = 0;
  assert.equal(await waitForScan({ async isTaskRunning() { return ++reads === 1; } }, { deadline: Date.now() + 100, pollMs: 1 }), 'completed');
});


test('malformed persisted commands remain inspectable without becoming empty global scans', () => {
  for (const json of ['null', '[]', '1', '{broken']) {
    const decoded = readJobPayload('scan-new', json, 'null');
    assert.ok(decoded.validationError);
    assert.deepEqual(decoded.payload, { seriesId: undefined, libraryId: undefined, seriesIds: undefined, path: undefined });
  }
  const invalid = readJobPayload('match-series', '{"seriesIds":[42,"bad"]}', '{"context":{"series":[null,{"id":42,"name":"Known"}]}}');
  assert.ok(invalid.validationError);
  assert.deepEqual(invalid.payload.context?.series, [{ id: 42, name: 'Known' }]);
});

test('failed archive rewrites leave the original file and no staging litter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-archive-failure-'));
  try {
    const file = path.join(dir, 'broken.cbz');
    fs.writeFileSync(file, 'not a ZIP');
    await assert.rejects(setComicInfoFields(file, { Number: '2' }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a ZIP');
    assert.deepEqual(fs.readdirSync(dir), ['broken.cbz']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('legacy imports retain existing checkpoints while separating newly imported commands', () => {
  const db = new Database(':memory:');
  try {
    migrateSchema(db);
    const checkpoint = { context: { series: [{ id: 42, name: 'Authoritative' }] }, mergeDownloadIds: { 'hitomi:1': 9 } };
    db.prepare('INSERT INTO jobs (id,type,payload_json,state_json) VALUES (1,?,?,?)').run('match-series', JSON.stringify({ seriesIds: [42], context: { series: [{ id: 42, name: 'Old fallback' }] } }), JSON.stringify(checkpoint));
    splitLegacyJobState(db);
    const row = db.prepare('SELECT payload_json, state_json FROM jobs WHERE id=1').get() as { payload_json: string; state_json: string };
    assert.deepEqual(JSON.parse(row.payload_json), { seriesIds: [42] });
    assert.deepEqual(JSON.parse(row.state_json), checkpoint);
    splitLegacyJobState(db);
    assert.deepEqual(JSON.parse((db.prepare('SELECT state_json FROM jobs WHERE id=1').get() as { state_json: string }).state_json), checkpoint);
  } finally { db.close(); }
});


test('folder ownership waits for active files and pending ownership can be cancelled', async () => {
  const owner = new MutationCoordinator(), gate = Promise.withResolvers<void>();
  const folder = path.join(os.tmpdir(), 'htosho-folder-ownership');
  const first = owner.run([path.join(folder, 'book.cbz')], async () => gate.promise);
  await tick();
  const controller = new AbortController();
  let entered = false;
  const folderWrite = owner.run([folder], async () => { entered = true; }, controller.signal);
  assert.equal(owner.isBusy(path.join(folder, 'another.cbz')), true);
  controller.abort(new Error('cancelled while waiting'));
  await assert.rejects(folderWrite, /cancelled while waiting/);
  assert.equal(entered, false);
  assert.equal(owner.isBusy(path.join(folder, 'another.cbz')), false);
  gate.resolve();
  await first;
  await owner.run([folder], async () => {});
});
