import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { after, afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { JobPayload, JobType } from '../src/jobs/queue.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-job-context-'));
process.env.HTOSHO_DATA_DIR = dataDir;
// The DB module snapshots HTOSHO_DATA_DIR at load time; imports must follow this test's temporary-directory setup.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { jobQueue } = await import('../src/jobs/queue.js');
const { api } = await import('../src/routes/api.js');
const { runJob } = await import('../src/jobs/executor.js');
const { setKavitaConnection, setProviderSetting } = await import('../src/services/settings.js');
const { getProvider } = await import('../src/providers/registry.js');
const { KavitaClient } = await import('../src/kavita/client.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
initDb();
const originalFetch = globalThis.fetch;
const originalTaskStatus = KavitaClient.prototype.isTaskRunning;
afterEach(() => {
  globalThis.fetch = originalFetch;
  KavitaClient.prototype.isTaskRunning = originalTaskStatus;
});
after(() => { getDb().$client.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function insertJob(type: JobType, payload: JobPayload, status = 'running'): number {
  return Number(getDb().insert(schema.jobs).values({ type, payloadJson: JSON.stringify(payload), status }).run().lastInsertRowid);
}
function storedPayload(id: number): JobPayload {
  const row = getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get()!;
  return { ...JSON.parse(row.payloadJson), ...JSON.parse(row.stateJson) };
}

// Runnable integration smoke: real HTTP Kavita client + API + temporary SQLite,
// followed by a fresh SQLite connection to prove names survive beyond hydration.
test('API target context smoke with temporary DB and fake Kavita server', async () => {
  let liveName = 'Original target';
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/Library/libraries') res.end(JSON.stringify([{ id: 7, name: 'Comics', type: 0 }]));
    else if (req.url === '/api/Series/42') res.end(JSON.stringify({ id: 42, libraryId: 7, name: liveName }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    setKavitaConnection({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test' });
    const response = await api.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'match-series', libraryId: 7, seriesIds: [42, 404] }) });
    assert.equal(response.status, 202);
    const { id } = await response.json() as { id: number };
    const expected = { series: [{ id: 42, name: 'Original target' }, { id: 404, name: 'Series #404' }], libraryId: 7, libraryName: 'Comics' };
    assert.deepEqual(jobQueue.get(id)?.context, expected);
    assert.deepEqual(storedPayload(id).context, expected);
    liveName = 'Renamed target';
    const before = requests.length;
    const list = await (await api.request('/jobs')).json() as Array<{ id: number; context: unknown }>;
    assert.deepEqual(list.find((job) => job.id === id)?.context, expected);
    assert.deepEqual((await (await api.request(`/jobs/${id}`)).json()).job.context, expected);
    assert.equal(requests.length, before, 'list and detail polling perform no remote identity lookups');
    const dbPath = getDb().$client.name;
    const fresh = new Database(dbPath, { readonly: true });
    try {
      const row = fresh.prepare('SELECT payload_json, state_json FROM jobs WHERE id = ?').get(id) as { payload_json: string };
      assert.deepEqual(({ ...JSON.parse(row.payload_json), ...JSON.parse((row as { state_json?: string }).state_json ?? '{}') }).context, expected);
    } finally { fresh.close(); }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('queue updates retain original names, fill unresolved IDs and preserve retry snapshots', () => {
  const id = insertJob('match-series', { seriesIds: [10, 11], context: { series: [{ id: 10, name: 'First name' }, { id: 11, name: 'Series #11' }], libraryId: 7, libraryName: 'Original library' } }, 'failed');
  jobQueue.updateContext(id, { series: [{ id: 10, name: 'Renamed' }, { id: 11, name: 'Discovered' }, { id: 12, name: 'Batch target' }], libraryId: 7, libraryName: 'Renamed library' });
  const expected = { series: [{ id: 10, name: 'First name' }, { id: 11, name: 'Discovered' }, { id: 12, name: 'Batch target' }], libraryId: 7, libraryName: 'Original library' };
  assert.deepEqual(jobQueue.get(id)?.context, expected);
  const retryId = jobQueue.retryJob(id)!;
  assert.notEqual(retryId, id);
  assert.deepEqual(jobQueue.get(retryId)?.context, expected);
  assert.deepEqual(storedPayload(retryId).context, expected);
});

test('legacy history recovers local names once, then snapshots them through later history changes', () => {
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 100, seriesTitle: 'Locally known', action: 'matched' }).run();
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 100, seriesTitle: null, action: 'failed' }).run();
  const id = insertJob('match-series', { seriesIds: [100, 101] }, 'completed');
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error('must stay local'); }) as typeof fetch;
  const expected = [{ id: 100, name: 'Locally known' }, { id: 101, name: 'Series #101' }];
  assert.deepEqual(jobQueue.get(id)?.context?.series, expected);
  assert.equal(storedPayload(id).context, undefined, 'reading legacy history must not persist a snapshot');
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 100, seriesTitle: 'Later rename', action: 'updated' }).run();
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 101, seriesTitle: 'New history', action: 'matched' }).run();
  assert.deepEqual(jobQueue.get(id)?.context?.series, [{ id: 100, name: 'Locally known' }, { id: 101, name: 'New history' }]);
  assert.equal(fetches, 0);
});

test('unconfigured Kavita still enqueues explicit unresolved targets', async () => {
  setKavitaConnection({ baseUrl: '', apiKey: '' });
  const response = await api.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'delete-series', seriesId: 900 }) });
  assert.equal(response.status, 202);
  const { id } = await response.json() as { id: number };
  assert.deepEqual(jobQueue.get(id)?.context?.series, [{ id: 900, name: 'Series #900' }]);
});

test('executor saves batch discoveries even when another requested ID cannot resolve', async () => {
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/api/Series/20')) return Response.json({ id: 20, libraryId: 7, name: 'Resolved before failure' });
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Comics', type: 0 }]);
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const id = insertJob('match-series', { libraryId: 7, seriesIds: [20, 21] });
  await assert.rejects(runJob(jobQueue.get(id)!, () => {}), /HTTP 404/);
  assert.deepEqual(storedPayload(id).context?.series, [{ id: 20, name: 'Resolved before failure' }, { id: 21, name: 'Series #21' }]);
  assert.equal(storedPayload(id).context?.libraryName, 'Comics');
});

test('internal library jobs retain all discovered target names and library scope', async () => {
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  for (const providerId of ['anilist', 'mangadex', 'myanimelist']) setProviderSetting(providerId, { enabled: false });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 8, name: 'Scheduled library', type: 0 }]);
    if (url.includes('/api/Series/all-v2')) return Response.json([{ id: 30, libraryId: 8, name: 'First batch title' }, { id: 31, libraryId: 8, name: 'Second batch title' }]);
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const id = insertJob('match-unmatched', {});
  const result = await runJob(jobQueue.get(id)!, () => {});
  assert.equal(result.processed, 2);
  assert.deepEqual(storedPayload(id).context, { series: [{ id: 30, name: 'First batch title' }, { id: 31, name: 'Second batch title' }], libraryId: 8, libraryName: 'Scheduled library' });
});

test('apply discovers original target before provider failure', async () => {
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  const provider = getProvider('anilist')!;
  const originalMetadata = provider.getSeriesMetadata;
  provider.getSeriesMetadata = async () => { throw new Error('provider unavailable'); };
  globalThis.fetch = (async (input) => String(input).endsWith('/api/Library/libraries')
    ? Response.json([{ id: 7, name: 'Comics', type: 0 }])
    : Response.json({ id: 40, libraryId: 7, name: 'Before apply' })) as typeof fetch;
  try {
    const id = insertJob('apply-series', { seriesId: 40, providerId: 'anilist', providerSeriesId: 'candidate', selectedTitle: 'New title' });
    await assert.rejects(runJob(jobQueue.get(id)!, () => {}), /provider unavailable/);
    assert.deepEqual(storedPayload(id).context, { series: [{ id: 40, name: 'Before apply' }], libraryId: 7, libraryName: 'Comics' });
  } finally { provider.getSeriesMetadata = originalMetadata; }
});

test('delete snapshots target before files disappear', async () => {
  const root = path.join(dataDir, 'DeleteLibrary');
  const dir = path.join(root, 'Removed title');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapter.cbz'), buildZip([{ name: '001.jpg', data: Buffer.from('image') }]));
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 9, name: 'Delete library', folders: [root], type: 0 }]);
    if (url.endsWith('/api/Series/50')) return Response.json({ id: 50, libraryId: 9, name: 'Removed title', folderPath: dir });
    return Response.json({});
  }) as typeof fetch;
  const id = insertJob('delete-series', { seriesId: 50 });
  assert.deepEqual(await runJob(jobQueue.get(id)!, () => {}), { deleted: 1 });
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(storedPayload(id).context, { series: [{ id: 50, name: 'Removed title' }], libraryId: 9, libraryName: 'Delete library' });
});

test('edit saves Kavita name before changing archive and series title', async () => {
  const file = path.join(dataDir, 'edit.cbz');
  fs.writeFileSync(file, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old title</Series></ComicInfo>') }]));
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  KavitaClient.prototype.isTaskRunning = async () => { throw new Error('status unavailable'); };
  const id = insertJob('edit-comicinfo', { seriesId: 60, path: file, fields: { Series: 'New title' } });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Comics', type: 0 }]);
    if (url.endsWith('/api/Series/60')) return Response.json({ id: 60, libraryId: 7, name: 'Old title' });
    if (url.endsWith('/api/Series/update')) {
      assert.equal(storedPayload(id).context?.series[0].name, 'Old title');
      assert.match((await readComicInfo(file))!, /New title/);
    }
    return Response.json({});
  }) as typeof fetch;
  await assert.rejects(runJob(jobQueue.get(id)!, () => {}), /scan status could not be verified/);
  assert.equal(storedPayload(id).context?.series[0].name, 'Old title');
});

test('unavailable Kavita cannot prevent enqueue and retains locally known targets', async () => {
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 901, seriesTitle: 'Known during outage', action: 'matched' }).run();
  globalThis.fetch = (async () => Response.json({}, { status: 403 })) as typeof fetch;
  const response = await api.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'match-series', libraryId: 7, seriesIds: [901, 902] }) });
  assert.equal(response.status, 202);
  const { id } = await response.json() as { id: number };
  assert.deepEqual(jobQueue.get(id)?.context?.series, [{ id: 901, name: 'Known during outage' }, { id: 902, name: 'Series #902' }]);
});

test('merge saves existing target and source names before moving and deleting source records', async () => {
  const root = path.join(dataDir, 'MergeLibrary');
  const sourceDir = path.join(root, 'Source title');
  const targetDir = path.join(root, 'Target title');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const source = path.join(sourceDir, 'chapter.cbz');
  fs.writeFileSync(source, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Source title</Series></ComicInfo>') }]));
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  KavitaClient.prototype.isTaskRunning = async () => { throw new Error('status unavailable'); };
  const id = insertJob('merge-series', { seriesId: 70, sourceFiles: [source] });
  let sourceDeleted = false;
  const target = { id: 70, libraryId: 7, name: 'Target title', folderPath: targetDir };
  const oldSource = { id: 71, libraryId: 7, name: 'Source title', folderPath: sourceDir };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Merge library', folders: [root], type: 0 }]);
    if (url.endsWith('/api/Series/70')) return Response.json(target);
    if (url.includes('/api/Series/all-v2')) return Response.json([target, oldSource]);
    if (url.endsWith('/api/Series/71') && init?.method === 'DELETE') {
      sourceDeleted = true;
      assert.equal(storedPayload(id).context?.series.find((series) => series.id === 71)?.name, 'Source title');
      assert.equal(fs.existsSync(source), false);
    }
    if (url.includes('/api/Search/chapters-by-series')) return Response.json([{ files: [{ filePath: path.join(targetDir, 'chapter.cbz') }] }]);
    return Response.json({});
  }) as typeof fetch;
  const result = await runJob(jobQueue.get(id)!, () => {});
  assert.equal(result.processed, 1);
  assert.equal(sourceDeleted, true);
  assert.deepEqual(storedPayload(id).context, { series: [{ id: 70, name: 'Target title' }, { id: 71, name: 'Source title' }], libraryId: 7, libraryName: 'Merge library' });
});

test('local-history names upgrade once live series resolves, then preserve the original live name', () => {
  getDb().insert(schema.syncHistory).values({ kavitaSeriesId: 950, seriesTitle: 'Old local history', action: 'matched' }).run();
  const id = insertJob('delete-series', { seriesId: 950 });
  assert.equal(jobQueue.get(id)?.context?.series[0].name, 'Old local history');
  jobQueue.updateContext(id, { series: [{ id: 950, name: 'Live original' }], libraryId: 7 });
  assert.equal(jobQueue.get(id)?.context?.series[0].name, 'Live original');
  jobQueue.updateContext(id, { series: [{ id: 950, name: 'Later rename' }], libraryId: 7 });
  assert.equal(jobQueue.get(id)?.context?.series[0].name, 'Live original');
});
