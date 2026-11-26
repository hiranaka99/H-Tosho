import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { KavitaClient as KavitaClientType } from '../src/kavita/client.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-merge-perf-'));
process.env.HTOSHO_DATA_DIR = dataDir;
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } = await import('../src/services/settings.js');
const { saveFieldPolicy, getFieldPolicy } = await import('../src/services/fieldPolicies.js');
const { resolveMergeProtection, recoverMergeProtectionForSeriesOwned, MergeChapterCache } = await import('../src/services/mergeProtection.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { archiveResource, archiveResourceAsync, libraryMutations } = await import('../src/lib/mutations.js');
const { jobQueue } = await import('../src/jobs/queue.js');
const { KavitaClient } = await import('../src/kavita/client.js');
initDb();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

let nextId = 5000;
function fixture(label: string) {
  const root = path.join(dataDir, label); fs.mkdirSync(root, { recursive: true });
  setKavitaConnection({ baseUrl: 'https://merge-perf.test', apiKey: 'fixture' });
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: root, libraryPathMappings: [] });
  const sourceId = nextId++, targetId = nextId++;
  const source = path.join(root, 'Source', 'Chapter.cbz'), targetDir = path.join(root, 'Target'), targetFile = path.join(targetDir, 'Existing.cbz');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(source, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Target</Series></ComicInfo>') }]));
  fs.writeFileSync(targetFile, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Target</Series></ComicInfo>') }]));
  let series = [{ id: sourceId, libraryId: 7, name: 'Source', folderPath: path.dirname(source) }, { id: targetId, libraryId: 7, name: 'Target', folderPath: targetDir }];
  const files = new Map<number, string[]>([[sourceId, [source]], [targetId, [targetFile]]]);
  const chapterCalls: number[] = [];
  const client = {
    getLibraries: async () => [{ id: 7, name: 'Library', path: root, paths: [root] }],
    getSeries: async () => series,
    getChaptersBySeries: async (id: number) => { chapterCalls.push(id); return (files.get(id) ?? []).map(file => ({ files: [{ filePath: file }] })); },
  } as unknown as KavitaClientType;
  return { root, sourceId, targetId, source, targetDir, targetFile, files, client, chapterCalls, replaceSeries: (value: typeof series) => { series = value; } };
}

test('archiveResourceAsync resolves exactly like archiveResource', async () => {
  const f = fixture('identity');
  for (const file of [f.source, f.targetDir, path.join(f.targetDir, 'not yet published.cbz')]) assert.equal(await archiveResourceAsync(file), archiveResource(file));
});

test('a chapter cache reuses Kavita listings across rechecks, never retains failures, and expires', async () => {
  const f = fixture('chapter-cache');
  const cache = new MergeChapterCache(60_000);
  const first = await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, undefined, { chapterCache: cache });
  assert.equal(f.chapterCalls.length, 2);
  const again = await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, first.state, { chapterCache: cache });
  assert.equal(f.chapterCalls.length, 2, 'rechecks inside one merge step reuse chapter listings');
  assert.deepEqual(again.state.sourceSeriesIds, first.state.sourceSeriesIds);
  // Local evidence is still read fresh: a title lock committed mid-step blocks the next recheck.
  await saveFieldPolicy(f.sourceId, ['title'], getFieldPolicy(f.sourceId).revision);
  fs.writeFileSync(f.source, buildZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Changed</Series></ComicInfo>') }]));
  const locked = await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, first.state, { chapterCache: cache });
  assert.equal(locked.preview.canQueue, false);
  assert.equal(f.chapterCalls.length, 2);
  cache.clear();
  await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, first.state, { chapterCache: cache });
  assert.equal(f.chapterCalls.length, 4, 'clear() forces fresh listings');
  await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, first.state);
  assert.equal(f.chapterCalls.length, 6, 'no cache means every call reads Kavita');

  let fail = true;
  const flaky = { ...f.client, getChaptersBySeries: async (id: number) => { if (fail) throw new Error('Kavita down'); return f.client.getChaptersBySeries(id); } } as unknown as KavitaClientType;
  const failing = new MergeChapterCache(60_000);
  await assert.rejects(resolveMergeProtection(flaky, { sourceFiles: [f.source], targetDir: f.targetDir }, undefined, { chapterCache: failing }), /Kavita down/);
  fail = false;
  await resolveMergeProtection(flaky, { sourceFiles: [f.source], targetDir: f.targetDir }, undefined, { chapterCache: failing });

  const expiring = new MergeChapterCache(0);
  const before = f.chapterCalls.length;
  await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, undefined, { chapterCache: expiring });
  await new Promise(resolve => setTimeout(resolve, 5));
  await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }, undefined, { chapterCache: expiring });
  assert.equal(f.chapterCalls.length, before + 4, 'expired entries are fetched again');
});

test('late-index recovery skips Kavita when no retained merge can apply, and still recovers failed merges', async () => {
  const f = fixture('recovery-prefilter');
  await saveFieldPolicy(f.sourceId, ['summary'], getFieldPolicy(f.sourceId).revision);
  const unrelated = nextId++;
  f.chapterCalls.length = 0;

  // Not yet published: its archive is still outside the target folder.
  const pending = await resolveMergeProtection(f.client, { targetDir: f.targetDir, sourceFiles: [f.source] });
  const pendingId = jobQueue.enqueue('merge-series', { targetDir: f.targetDir, sourceFiles: [f.source] });
  jobQueue.updateMergeState(pendingId, { mergeProtection: pending.state });
  getDb().update(schema.jobs).set({ status: 'failed' }).where(eq(schema.jobs.id, pendingId)).run();
  // A job that itself completed, with verified inheritance.
  const done = await resolveMergeProtection(f.client, { targetDir: f.targetDir, sourceFiles: [f.targetFile] });
  const doneId = jobQueue.enqueue('merge-series', { targetDir: f.targetDir, sourceFiles: [f.targetFile] });
  jobQueue.updateMergeState(doneId, { mergeProtection: { ...done.state, completedTargetSeriesId: f.targetId } });
  getDb().update(schema.jobs).set({ status: 'completed' }).where(eq(schema.jobs.id, doneId)).run();
  // Malformed state never breaks the JSON prefilter.
  const brokenId = jobQueue.enqueue('merge-series', { targetDir: f.targetDir, sourceFiles: [f.source] });
  getDb().update(schema.jobs).set({ stateJson: '{not json' }).where(eq(schema.jobs.id, brokenId)).run();
  f.chapterCalls.length = 0;

  await libraryMutations.run([`series:${unrelated}`], () => recoverMergeProtectionForSeriesOwned(f.client, unrelated));
  assert.deepEqual(f.chapterCalls, [], 'nothing published and nothing unfinished: no Kavita lookup');

  // Publish the failed merge's archive; a new target ID indexes it late.
  const moved = path.join(f.targetDir, path.basename(f.source));
  fs.renameSync(f.source, moved);
  pending.state.archives[0].path = moved;
  jobQueue.updateMergeState(pendingId, { mergeProtection: pending.state });
  const newId = nextId++;
  f.replaceSeries([{ id: newId, libraryId: 7, name: 'Target', folderPath: f.targetDir }]);
  f.files.clear(); f.files.set(newId, [f.targetFile, moved]);
  await libraryMutations.run([`series:${newId}`], () => recoverMergeProtectionForSeriesOwned(f.client, newId));
  assert.deepEqual(getFieldPolicy(newId).lockedFields, ['summary']);
  assert.equal(jobQueue.get(pendingId)!.payload.mergeProtection!.completedTargetSeriesId, newId);
});

test('job logs return the newest lines oldest-first, and active-type checks need no hydration', () => {
  const id = jobQueue.enqueue('clear-overrides', {});
  getDb().update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, id)).run();
  assert.equal(jobQueue.hasActiveType('clear-overrides'), true);
  assert.equal(jobQueue.hasActiveType('scan-matchable'), false);
  for (let index = 0; index < 2100; index++) jobQueue.log(id, 'info', `line ${index}`);
  const logs = jobQueue.logs(id);
  assert.equal(logs.length, 2000);
  assert.equal(logs.at(-1)!.message, 'line 2099');
  assert.ok(logs.every((log, index) => index === 0 || log.id > logs[index - 1].id));
  assert.equal(jobQueue.logs(id, 3).map(log => log.message).join(','), 'line 2097,line 2098,line 2099');
  getDb().update(schema.jobs).set({ status: 'completed' }).where(eq(schema.jobs.id, id)).run();
  assert.equal(jobQueue.hasActiveType('clear-overrides'), false);
});

test('isTaskRunning settles on the first running answer and remembers a legacy-only server', async () => {
  const requests: string[] = [];
  const stalled = Promise.withResolvers<Response>();
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('methodName=ScanLibrary&queue=default')) return Response.json(true);
    return stalled.promise;
  };
  const client = new KavitaClient('https://kavita.example', 'secret');
  assert.equal(await client.isTaskRunning(), true, 'one running scan answers without waiting for slower calls');
  assert.equal(requests.length, 6);
  stalled.resolve(Response.json(false));

  requests.length = 0;
  let bare = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('methodName=')) return new Response('The methodName field is required.', { status: 400 });
    bare++;
    return Response.json(bare < 3);
  };
  const legacy = new KavitaClient('https://kavita.example', 'secret');
  assert.equal(await legacy.isTaskRunning(), true);
  assert.equal(requests.length, 7);
  assert.equal(await legacy.isTaskRunning(), true);
  assert.equal(requests.length, 8, 'a pre-0.9.1 server is asked only the bare call afterwards');
  assert.equal(await legacy.isTaskRunning(), false);

  requests.length = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (!url.includes('methodName=')) return new Response('The methodName field is required.', { status: 400 });
    return Response.json(false);
  };
  assert.equal(await legacy.isTaskRunning(), false, 'an upgraded server returns to scoped calls');
  assert.equal(requests.length, 7);
});

test('resolveMergeProtection skips unrelated mapped series and fails closed on unmapped series', async () => {
  const f = fixture('scoped-chapters');
  const unrelatedId = nextId++;
  const unrelatedDir = path.join(f.root, 'UnrelatedMapped');
  fs.mkdirSync(unrelatedDir, { recursive: true });
  f.replaceSeries([
    { id: f.sourceId, libraryId: 7, name: 'Source', folderPath: path.dirname(f.source) },
    { id: f.targetId, libraryId: 7, name: 'Target', folderPath: f.targetDir },
    { id: unrelatedId, libraryId: 7, name: 'Completely Different Title', folderPath: unrelatedDir },
  ]);
  f.files.set(unrelatedId, [path.join(unrelatedDir, 'Other.cbz')]);

  await resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir });
  assert.equal(f.chapterCalls.includes(unrelatedId), false, 'unrelated mapped series skips getChaptersBySeries');
  assert.ok(f.chapterCalls.includes(f.sourceId) && f.chapterCalls.includes(f.targetId));

  // Unmapped series are still inspected so missing mappings fail closed.
  f.chapterCalls.length = 0;
  f.replaceSeries([
    { id: f.sourceId, libraryId: 7, name: 'Source', folderPath: path.dirname(f.source) },
    { id: f.targetId, libraryId: 7, name: 'Target', folderPath: f.targetDir },
    { id: unrelatedId, libraryId: 7, name: 'Unmapped', folderPath: undefined as unknown as string },
  ]);
  f.files.set(unrelatedId, ['/unmapped-kavita-library/Unmapped/Book.cbz']);
  await assert.rejects(
    resolveMergeProtection(f.client, { sourceFiles: [f.source], targetDir: f.targetDir }),
    /Map Kavita library paths/,
  );
  assert.equal(f.chapterCalls.includes(unrelatedId), true);
});

test('GET /series/:id/field-locks responds without waiting on libraryMutations when no incomplete merge exists', async () => {
  const f = fixture('field-locks-fastpath');
  getDb().delete(schema.jobs).where(eq(schema.jobs.type, 'merge-series')).run();
  await saveFieldPolicy(f.sourceId, ['title'], 0);
  const { api } = await import('../src/routes/api.js');

  const gate = Promise.withResolvers<void>();
  const holder = libraryMutations.run(['*'], () => gate.promise);
  try {
    let settled = false;
    const response = await Promise.race([
      api.request(`/series/${f.sourceId}/field-locks`).then((res) => { settled = true; return res; }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('field-locks timed out while libraryMutations was held')), 2000)),
    ]);
    assert.equal(settled, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { lockedFields: ['title'], revision: 1 });
  } finally {
    gate.resolve();
    await holder;
  }
});
