import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { eq } from 'drizzle-orm';
import type { DoujinSearchResult } from '../src/downloader/types.js';
import type { WatchedGalleryFeed } from '../src/contracts/following.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'htosho-following-runtime-'));
process.env.HTOSHO_DATA_DIR = dataDir;
// Static service imports would snapshot the data directory before test isolation.
const { getDb, schema } = await import('../src/db/index.js');
const {
  addWatchedSearch, getWatchedSearch, updateWatchedSearch, removeWatchedSearch,
  addWatchedSearchFolder, listWatchedSearchFolders, patchWatchedSearchFolder, removeWatchedSearchFolder,
  initializeWatchedSchedule, rescheduleWatchedSearches, dueWatchedSearchIds,
  checkWatchedSearches, listGalleryFeed, setGalleriesReviewed, backfillNewGalleries,
} = await import('../src/services/watchedSearches.js');
const { setWatchedSearchIntervalMinutes, setNotificationSettings } = await import('../src/services/settings.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { JobCancelled, jobQueue } = await import('../src/jobs/queue.js');
const { api } = await import('../src/routes/api/watched.js');
const original = doujinProviders.hitomi;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
let now = NOW;
let searches: { query: string; limit: number | undefined }[] = [];
let respond: (query: string, limit?: number) => Promise<DoujinSearchResult[]> = async () => [];
const log = () => {};

function gallery(id: string): DoujinSearchResult {
  return { source: 'hitomi', galleryId: id, title: `Gallery ${id}`, tags: [], artists: [], url: `https://hitomi.la/g/${id}` };
}

function captureDiscord(t: TestContext): string[] {
  const messages: string[] = [];
  setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/fixture' } });
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    assert.match(String(input), /^https:\/\/discord\.com\/api\/webhooks\//);
    messages.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  return messages;
}

beforeEach(t => {
  now = NOW;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  const db = getDb();
  for (const table of [schema.watchedSearchSeen, schema.watchedSearchNew, schema.watchedSearches, schema.watchedSearchFolders, schema.jobLogs, schema.jobs, schema.downloadQueue]) db.delete(table).run();
  setWatchedSearchIntervalMinutes(15);
  setNotificationSettings({ discord: { enabled: false, webhookUrl: '' } });
  searches = [];
  respond = async () => [];
  doujinProviders.hitomi = {
    id: 'hitomi', name: 'Hitomi.la', color: '#ff5722',
    async getGallery() { throw new Error('Following must not hydrate or download galleries'); },
    async search(query, limit) { searches.push({ query, limit }); return respond(query, limit); },
  };
});
after(() => { doujinProviders.hitomi = original; });

test('cadence inherits, global-off overrides custom intervals, and organization preserves due time', () => {
  const watch = addWatchedSearch('hitomi', 'artist:cadence');
  assert.equal(watch.effectiveIntervalMinutes, 15);
  assert.equal(watch.coverageLimit, 50);
  assert.equal(watch.nextCheckAt, new Date(now + 15 * 60_000).toISOString());
  const folder = addWatchedSearchFolder(' Favorites ');
  const edited = updateWatchedSearch(watch.id, { expectedRevision: watch.revision, displayName: ' My artist ', folderId: folder.id });
  assert.equal(edited.displayName, 'My artist');
  assert.equal(edited.nextCheckAt, watch.nextCheckAt);
  assert.equal(addWatchedSearch('hitomi', ' artist:cadence ').id, watch.id);
  const custom = updateWatchedSearch(watch.id, { expectedRevision: edited.revision, intervalMinutes: 60 });
  assert.equal(custom.effectiveIntervalMinutes, 60);
  assert.equal(custom.nextCheckAt, new Date(now + 60 * 60_000).toISOString());
  setWatchedSearchIntervalMinutes(360);
  rescheduleWatchedSearches(now);
  assert.equal(getWatchedSearch(watch.id)!.effectiveIntervalMinutes, 60);
  setWatchedSearchIntervalMinutes(0);
  rescheduleWatchedSearches(now);
  assert.equal(getWatchedSearch(watch.id)!.effectiveIntervalMinutes, 0);
  assert.equal(getWatchedSearch(watch.id)!.nextCheckAt, null);
  assert.deepEqual(dueWatchedSearchIds(now + 1_000_000_000), []);
  const disabled = addWatchedSearch('hitomi', 'artist:off');
  assert.equal(disabled.nextCheckAt, null);
  setWatchedSearchIntervalMinutes(360);
  rescheduleWatchedSearches(now);
  assert.equal(getWatchedSearch(disabled.id)!.nextCheckAt, new Date(now + 360 * 60_000).toISOString());
  const inherited = updateWatchedSearch(watch.id, { expectedRevision: custom.revision, intervalMinutes: null, displayName: '' });
  assert.equal(inherited.displayName, null);
  assert.equal(inherited.effectiveIntervalMinutes, 360);
  const paused = updateWatchedSearch(watch.id, { expectedRevision: inherited.revision, paused: true });
  assert.equal(paused.nextCheckAt, null);
  assert.equal(paused.effectiveIntervalMinutes, 0);
  now += 60_000;
  const resumed = updateWatchedSearch(watch.id, { expectedRevision: paused.revision, paused: false });
  assert.equal(resumed.nextCheckAt, new Date(now + 360 * 60_000).toISOString());
});

test('startup preserves future timestamps and staggers overdue work into bounded persistent sweeps', () => {
  const db = getDb();
  const watches = Array.from({ length: 45 }, (_, i) => addWatchedSearch('hitomi', `artist:overdue-${i}`));
  for (const watch of watches) db.update(schema.watchedSearches).set({ nextCheckAt: null }).where(eq(schema.watchedSearches.id, watch.id)).run();
  const future = addWatchedSearch('hitomi', 'artist:future');
  const paused = addWatchedSearch('hitomi', 'artist:paused');
  updateWatchedSearch(paused.id, { expectedRevision: paused.revision, paused: true });
  initializeWatchedSchedule(now);
  assert.equal(getWatchedSearch(future.id)!.nextCheckAt, future.nextCheckAt);
  assert.equal(getWatchedSearch(paused.id)!.nextCheckAt, null);
  assert.deepEqual(dueWatchedSearchIds(now), watches.slice(0, 20).map(watch => watch.id));
  assert.equal(dueWatchedSearchIds(now + 15_000, 100).length, 40);
  assert.equal(dueWatchedSearchIds(now + 30_000, 100).length, 45);
  assert.equal(dueWatchedSearchIds(now + 30_000).length, 20);
  assert.equal(getWatchedSearch(watches[40].id)!.nextCheckAt, new Date(now + 30_000).toISOString());
  initializeWatchedSchedule(now);
  assert.equal(getWatchedSearch(watches[40].id)!.nextCheckAt, new Date(now + 30_000).toISOString());
});

test('due execution rechecks pause, global-off and refreshed schedule before requesting a provider', async () => {
  const watch = addWatchedSearch('hitomi', 'artist:due');
  const command = { mode: 'due' as const, watchIds: [watch.id] };
  assert.equal((await checkWatchedSearches(log, undefined, undefined, command)).checked, 0);
  initializeWatchedSchedule(now + 15 * 60_000);
  now += 15 * 60_000;
  setWatchedSearchIntervalMinutes(0);
  assert.equal((await checkWatchedSearches(log, undefined, undefined, command)).checked, 0);
  setWatchedSearchIntervalMinutes(15);
  updateWatchedSearch(watch.id, { expectedRevision: watch.revision, paused: true });
  assert.equal((await checkWatchedSearches(log, undefined, undefined, command)).checked, 0);
  updateWatchedSearch(watch.id, { expectedRevision: watch.revision + 1, paused: false });
  assert.equal((await checkWatchedSearches(log, undefined, undefined, command)).checked, 0);
  assert.deepEqual(searches, []);
});

test('bulk checks skip paused watches while explicit Check once retains in-app finds without Discord', async t => {
  const messages = captureDiscord(t);
  const target = addWatchedSearch('hitomi', 'artist:target');
  respond = async () => [gallery('seed')];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [target.id] });
  assert.deepEqual(messages, []);
  const paused = updateWatchedSearch(target.id, { expectedRevision: target.revision, paused: true });
  const other = addWatchedSearch('hitomi', 'artist:other');
  searches = [];
  await checkWatchedSearches(log);
  assert.deepEqual(searches.map(call => call.query), [other.query]);
  searches = [];
  respond = async () => [gallery('new')];
  const checked = await checkWatchedSearches(log, undefined, undefined, { watchIds: [target.id] });
  assert.deepEqual(searches, [{ query: target.query, limit: 50 }]);
  assert.equal(checked.newGalleries, 1);
  assert.equal(checked.notified, 0);
  assert.deepEqual(messages, []);
  const latest = getWatchedSearch(target.id)!;
  assert.equal(latest.pausedAt, paused.pausedAt);
  assert.equal(latest.nextCheckAt, null);
  assert.equal(latest.revision, paused.revision);
  assert.deepEqual(listGalleryFeed({ searchId: target.id }).items.map(item => item.galleryId), ['new']);
  assert.equal(getDb().select().from(schema.downloadQueue).all().length, 0);
});

test('per-watch ownership prevents overlapping due/manual work but allows independent watches', async () => {
  const target = addWatchedSearch('hitomi', 'artist:owned');
  const other = addWatchedSearch('hitomi', 'artist:independent');
  const gate = Promise.withResolvers<DoujinSearchResult[]>();
  respond = async query => query === target.query ? gate.promise : [];
  getDb().update(schema.watchedSearches).set({ nextCheckAt: new Date(now).toISOString() }).where(eq(schema.watchedSearches.id, target.id)).run();
  const first = checkWatchedSearches(log, undefined, undefined, { mode: 'due', watchIds: [target.id] });
  assert.equal((await checkWatchedSearches(log, undefined, undefined, { watchIds: [target.id] })).checked, 0);
  assert.equal((await checkWatchedSearches(log, undefined, undefined, { watchIds: [other.id] })).checked, 1);
  assert.deepEqual(dueWatchedSearchIds(now), []);
  gate.resolve([gallery('seed')]);
  assert.equal((await first).checked, 1);
  assert.deepEqual(searches.map(call => call.query), [target.query, other.query]);
  respond = async () => [];
  assert.equal((await checkWatchedSearches(log, undefined, undefined, { watchIds: [target.id] })).checked, 1);
});

for (const change of ['pause', 'rename', 'move', 'delete', 'folder-delete'] as const) {
  test(`in-flight ${change} discards obsolete responses without modifying discoveries, seen IDs or schedule`, async t => {
    const messages = captureDiscord(t);
    const folder = addWatchedSearchFolder('Folder');
    const originalWatch = addWatchedSearch('hitomi', `artist:race-${change}`);
    const watch = updateWatchedSearch(originalWatch.id, { expectedRevision: originalWatch.revision, folderId: folder.id });
    respond = async () => [gallery('seed')];
    await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
    const before = getWatchedSearch(watch.id)!;
    const gate = Promise.withResolvers<DoujinSearchResult[]>();
    respond = async () => gate.promise;
    const pending = checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
    if (change === 'delete') removeWatchedSearch(watch.id, before.revision);
    else if (change === 'folder-delete') removeWatchedSearchFolder(folder.id, folder.revision);
    else updateWatchedSearch(watch.id, { expectedRevision: before.revision, ...(change === 'pause' ? { paused: true } : change === 'rename' ? { displayName: 'Renamed' } : { folderId: null }) });
    const afterEdit = getWatchedSearch(watch.id);
    gate.resolve([gallery('obsolete')]);
    assert.equal((await pending).checked, 0);
    assert.deepEqual(messages, []);
    assert.deepEqual(getWatchedSearch(watch.id), afterEdit);
    assert.equal(listGalleryFeed({ searchId: watch.id }).items.length, 0);
    const seen = getDb().select().from(schema.watchedSearchSeen).where(eq(schema.watchedSearchSeen.searchId, watch.id)).all();
    assert.deepEqual(seen.map(row => row.galleryId), change === 'delete' ? [] : ['seed']);
  });
}

test('in-flight due work cannot commit after global-off or rescheduling', async () => {
  for (const change of ['off', 'reschedule'] as const) {
    setWatchedSearchIntervalMinutes(15);
    const watch = addWatchedSearch('hitomi', `artist:due-race-${change}`);
    getDb().update(schema.watchedSearches).set({ nextCheckAt: new Date(now).toISOString() }).where(eq(schema.watchedSearches.id, watch.id)).run();
    const gate = Promise.withResolvers<DoujinSearchResult[]>();
    respond = async () => gate.promise;
    const pending = checkWatchedSearches(log, undefined, undefined, { mode: 'due', watchIds: [watch.id] });
    if (change === 'off') setWatchedSearchIntervalMinutes(0);
    rescheduleWatchedSearches(now);
    const afterEdit = getWatchedSearch(watch.id)!;
    gate.resolve([gallery('obsolete')]);
    assert.equal((await pending).checked, 0);
    assert.deepEqual(getWatchedSearch(watch.id), afterEdit);
    assert.equal(getWatchedSearch(watch.id)!.seenCount, 0);
  }
});

test('cancellation after success or rejection never records seen/discovery/error/schedule state and releases ownership', async () => {
  const watch = addWatchedSearch('hitomi', 'artist:cancel');
  for (const failure of [false, true]) {
    const gate = Promise.withResolvers<DoujinSearchResult[]>();
    respond = async () => gate.promise;
    let cancelled = false;
    const before = getWatchedSearch(watch.id)!;
    const pending = checkWatchedSearches(log, () => cancelled, undefined, { watchIds: [watch.id] });
    cancelled = true;
    if (failure) gate.reject(new Error('Obsolete provider failure')); else gate.resolve([gallery('cancelled')]);
    await assert.rejects(pending, JobCancelled);
    assert.deepEqual(getWatchedSearch(watch.id), before);
    assert.equal(listGalleryFeed({ searchId: watch.id }).items.length, 0);
  }
  respond = async () => [];
  assert.equal((await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] })).checked, 1);
});

test('obsolete provider failures cannot overwrite a newer edit', async () => {
  const watch = addWatchedSearch('hitomi', 'artist:obsolete-failure');
  const gate = Promise.withResolvers<DoujinSearchResult[]>();
  respond = async () => gate.promise;
  const pending = checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  const edited = updateWatchedSearch(watch.id, { expectedRevision: watch.revision, intervalMinutes: 60 });
  gate.reject(new Error('Obsolete failure'));
  assert.equal((await pending).failed, 0);
  assert.deepEqual(getWatchedSearch(watch.id), edited);
});

test('provider failures schedule one next attempt and retain last failure through later success', async () => {
  const watch = addWatchedSearch('hitomi', 'artist:failure');
  respond = async () => [];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  const lastSuccess = getWatchedSearch(watch.id)!.lastCheckedAt;
  now += 60_000;
  respond = async () => { throw new Error('Provider unavailable'); };
  const result = await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  const failed = getWatchedSearch(watch.id)!;
  assert.equal(result.failed, 1);
  assert.equal(failed.lastCheckedAt, lastSuccess);
  assert.equal(failed.lastFailedAt, new Date(now).toISOString());
  assert.equal(failed.lastAttemptedAt, failed.lastFailedAt);
  assert.equal(failed.nextCheckAt, new Date(now + 15 * 60_000).toISOString());
  assert.equal(searches.length, 2, 'no provider retry loop');
  now += 60_000;
  respond = async () => [];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  const recovered = getWatchedSearch(watch.id)!;
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastFailedAt, failed.lastFailedAt);
  assert.equal(recovered.lastCheckedAt, new Date(now).toISOString());
});

test('discoveries commit before notification and a pause at the dispatch boundary suppresses Discord', async t => {
  const messages = captureDiscord(t);
  const watch = addWatchedSearch('hitomi', 'artist:dispatch');
  respond = async () => [];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  respond = async () => [gallery('durable')];
  const result = await checkWatchedSearches(level => {
    if (level !== 'success') return;
    assert.equal(listGalleryFeed({ searchId: watch.id }).items[0].galleryId, 'durable');
    updateWatchedSearch(watch.id, { expectedRevision: getWatchedSearch(watch.id)!.revision, paused: true });
  }, undefined, undefined, { watchIds: [watch.id] });
  assert.equal(result.checked, 1);
  assert.equal(result.notified, 0);
  assert.deepEqual(messages, []);
  assert.equal(listGalleryFeed({ searchId: watch.id }).items.length, 1);
});

test('folder reorder is atomic and revisioned; deletion unfiles watches without losing history or due time', async () => {
  const a = addWatchedSearchFolder('A'), b = addWatchedSearchFolder('B'), c = addWatchedSearchFolder('C');
  const watch = addWatchedSearch('hitomi', 'artist:folder');
  const filed = updateWatchedSearch(watch.id, { expectedRevision: watch.revision, folderId: b.id });
  respond = async () => [];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  respond = async () => [gallery('retained')];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  setGalleriesReviewed([{ source: 'hitomi', galleryId: 'retained' }], true);
  patchWatchedSearchFolder(c.id, { expectedRevision: c.revision, position: 0 });
  const folders = listWatchedSearchFolders();
  assert.deepEqual(folders.map(folder => [folder.id, folder.position, folder.revision]), [[c.id, 0, 1], [a.id, 1, 1], [b.id, 2, 1]]);
  assert.throws(() => patchWatchedSearchFolder(a.id, { expectedRevision: a.revision, position: 0 }), /changed/);
  assert.deepEqual(listWatchedSearchFolders(), folders);
  const beforeDelete = getWatchedSearch(watch.id)!;
  assert.throws(() => removeWatchedSearchFolder(b.id, b.revision), /changed/);
  assert.equal(removeWatchedSearchFolder(b.id, folders[2].revision), true);
  const unfiled = getWatchedSearch(watch.id)!;
  assert.equal(unfiled.folderId, null);
  assert.equal(unfiled.revision, filed.revision + 1);
  assert.equal(unfiled.nextCheckAt, beforeDelete.nextCheckAt);
  assert.ok(listGalleryFeed({ folderId: 'unfiled' }).items[0].reviewedAt);
});

test('folder membership filters before deduplication/paging and retained removed-watch provenance remains readable', () => {
  const folderA = addWatchedSearchFolder('A'), folderB = addWatchedSearchFolder('B');
  const a = addWatchedSearch('hitomi', 'artist:a'), b = addWatchedSearch('hitomi', 'artist:b');
  updateWatchedSearch(a.id, { expectedRevision: a.revision, displayName: 'Artist A', folderId: folderA.id });
  const namedB = updateWatchedSearch(b.id, { expectedRevision: b.revision, displayName: 'Artist B', folderId: folderB.id });
  const rows = Array.from({ length: 17 }, (_, i) => ({ searchId: a.id, source: 'hitomi', query: a.query, watchLabel: 'Old A', galleryId: `folder-${i}`, title: `Find ${i}`, foundAt: new Date(now + i * 1000).toISOString() }));
  getDb().insert(schema.watchedSearchNew).values([...rows, { ...rows[16], searchId: b.id, query: b.query, watchLabel: 'Old B', foundAt: new Date(now + 100_000).toISOString() }]).run();
  const feed = listGalleryFeed({ folderId: folderA.id, limit: 12 });
  assert.equal(feed.total, 17);
  assert.equal(feed.items[0].searchId, a.id);
  assert.equal(feed.items[0].watchLabel, 'Artist A');
  assert.equal(feed.items[0].watchRemoved, false);
  assert.equal(listGalleryFeed({ folderId: folderA.id, offset: 12, limit: 12 }).items.length, 5);
  assert.equal(listGalleryFeed({ folderId: folderB.id }).items[0].searchId, b.id);
  setGalleriesReviewed([{ source: 'hitomi', galleryId: 'folder-16' }], true);
  assert.equal(listGalleryFeed({ folderId: folderA.id, view: 'inbox' }).total, 16);
  assert.equal(listGalleryFeed({ folderId: folderB.id, view: 'inbox' }).total, 0);
  removeWatchedSearch(b.id, namedB.revision);
  const retained = listGalleryFeed({ folderId: 'unfiled' });
  assert.equal(retained.items[0].watchLabel, 'Artist B');
  assert.equal(retained.items[0].watchRemoved, true);
  assert.ok(retained.items[0].reviewedAt);
  assert.deepEqual(retained.watches.find(watch => watch.id === b.id), { id: b.id, query: b.query, source: 'hitomi', watchLabel: 'Artist B', folderId: null, removed: true });
  assert.equal(listGalleryFeed({ folderId: folderB.id }).total, 0);
  assert.equal(listGalleryFeed({ folderId: folderA.id }).total, 17);
});

test('watch/folder HTTP mutations validate shape and reject stale revisions and missing identities', async () => {
  const watch = addWatchedSearch('hitomi', 'artist:api');
  const request = (url: string, method: string, body: unknown) => api.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [null, {}, { expectedRevision: -1 }, { expectedRevision: 0, source: 'nhentai' }, { expectedRevision: 0, query: 'changed' }, { expectedRevision: 0, displayName: 'x'.repeat(121) }, { expectedRevision: 0, intervalMinutes: 45 }, { expectedRevision: 0, paused: 'yes' }, { expectedRevision: 0, folderId: 0 }]) {
    assert.equal((await request(`/watched-searches/${watch.id}`, 'PATCH', body)).status, 400);
  }
  assert.equal((await request(`/watched-searches/${watch.id}`, 'PATCH', { expectedRevision: 0, folderId: 999999 })).status, 404);
  assert.equal((await request('/watched-searches/999999', 'PATCH', { expectedRevision: 0 })).status, 404);
  assert.equal((await request(`/watched-searches/${watch.id}`, 'PATCH', { expectedRevision: 0, displayName: 'Name' })).status, 200);
  assert.equal((await request(`/watched-searches/${watch.id}`, 'PATCH', { expectedRevision: 0, paused: true })).status, 409);
  assert.equal((await request(`/watched-searches/${watch.id}`, 'DELETE', {})).status, 400);
  assert.equal((await request(`/watched-searches/${watch.id}`, 'DELETE', { expectedRevision: 0 })).status, 409);
  assert.equal((await request(`/watched-searches/${watch.id}`, 'DELETE', { expectedRevision: 1 })).status, 200);
  for (const name of ['', ' ', 'x'.repeat(121), 1]) assert.equal((await request('/watched-search-folders', 'POST', { name })).status, 400);
  const created = await request('/watched-search-folders', 'POST', { name: ' Folder ' });
  assert.equal(created.status, 201);
  const folder = await created.json() as { id: number; revision: number };
  assert.equal((await request(`/watched-search-folders/${folder.id}`, 'PATCH', { expectedRevision: 0, position: 1 })).status, 400);
  assert.equal((await request(`/watched-search-folders/${folder.id}`, 'PATCH', { expectedRevision: 0, name: 'Updated' })).status, 200);
  assert.equal((await request(`/watched-search-folders/${folder.id}`, 'DELETE', { expectedRevision: 0 })).status, 409);
  assert.equal((await request(`/watched-search-folders/${folder.id}`, 'DELETE', { expectedRevision: 1 })).status, 200);
  for (const filter of ['folderId=0', 'folderId=-1', 'folderId=bad', 'folderId=1.5']) assert.equal((await api.request(`/watched-searches/feed?${filter}`)).status, 400);
  assert.equal((await api.request('/watched-searches/feed?folderId=unfiled')).status, 200);
});

test('HTTP derives manual mode, validates targets and refuses to misidentify unrelated active Tasks', async () => {
  const a = addWatchedSearch('hitomi', 'artist:api-a'), b = addWatchedSearch('hitomi', 'artist:api-b');
  const request = (body: unknown) => api.request('/watched-searches/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [null, [], { mode: 'manual' }, { mode: 'due', watchIds: [a.id] }, { due: true }, { watchIds: [] }, { watchIds: [0] }, { watchIds: ['1'] }, { watchIds: Array(101).fill(a.id) }, { watchIds: [a.id], extra: true }]) assert.equal((await request(body)).status, 400);
  assert.equal((await request({ watchIds: [999999] })).status, 404);
  const first = await request({ watchIds: [a.id] });
  assert.equal(first.status, 202);
  const job = await first.json() as { id: number; alreadyRunning: boolean };
  assert.equal(job.alreadyRunning, false);
  assert.deepEqual(jobQueue.get(job.id)!.payload, { mode: 'manual', watchIds: [a.id] });
  const repeated = await request({ watchIds: [a.id, a.id] });
  assert.equal(repeated.status, 202);
  assert.deepEqual(await repeated.json(), { id: job.id, alreadyRunning: true });
  assert.equal((await request({ watchIds: [b.id] })).status, 409);
  assert.equal((await request({})).status, 409);
  getDb().delete(schema.jobs).run();
  jobQueue.enqueue('check-watched-searches', { mode: 'due', watchIds: [a.id] });
  assert.equal((await request({ watchIds: [a.id] })).status, 409);
  getDb().delete(schema.jobs).run();
  jobQueue.enqueue('scan-new', {});
  assert.equal((await request({ watchIds: [a.id] })).status, 409);
  getDb().delete(schema.jobs).run();
  assert.equal((await request({})).status, 202);
});

test('restart preserves persisted future schedule, organization, seen IDs, finds and gallery review', async () => {
  const folder = addWatchedSearchFolder('Persisted folder');
  const watch = addWatchedSearch('hitomi', 'artist:restart');
  updateWatchedSearch(watch.id, { expectedRevision: watch.revision, displayName: 'Persisted label', folderId: folder.id, intervalMinutes: 60 });
  respond = async () => [];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  respond = async () => [gallery('persisted-find')];
  await checkWatchedSearches(log, undefined, undefined, { watchIds: [watch.id] });
  setGalleriesReviewed([{ source: 'hitomi', galleryId: 'persisted-find' }], true);
  const expected = getWatchedSearch(watch.id)!;
  const service = new URL('../src/services/watchedSearches.ts', import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(service)}); m.initializeWatchedSchedule(${now}); console.log(JSON.stringify({ watch: m.getWatchedSearch(${watch.id}), folders: m.listWatchedSearchFolders(), feed: m.listGalleryFeed({searchId:${watch.id}}) }));`;
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HTOSHO_DATA_DIR: dataDir } });
  assert.equal(child.status, 0, child.stderr);
  const persisted = JSON.parse(child.stdout) as { watch: typeof expected; folders: { id: number; name: string }[]; feed: WatchedGalleryFeed };
  assert.deepEqual(persisted.watch, expected);
  assert.equal(persisted.folders[0].id, folder.id);
  assert.equal(persisted.folders[0].name, 'Persisted folder');
  assert.equal(persisted.feed.items[0].watchLabel, 'Persisted label');
  assert.ok(persisted.feed.items[0].reviewedAt);
});

test('legacy last-results replay preserves shared gallery review and the original finds timestamp', () => {
  const originalWatch = addWatchedSearch('hitomi', 'artist:reviewed-origin');
  const legacyWatch = addWatchedSearch('hitomi', 'artist:legacy-replay');
  const foundAt = '2026-10-01T00:00:00.000Z';
  getDb().insert(schema.watchedSearchNew).values({ searchId: originalWatch.id, source: 'hitomi', query: originalWatch.query,
    watchLabel: originalWatch.query, galleryId: 'replayed', title: 'Retained', reviewedAt: '2026-10-02T00:00:00.000Z', foundAt }).run();
  getDb().update(schema.watchedSearches).set({ lastFindsAt: foundAt, lastCheckedAt: '2026-11-01T00:00:00.000Z',
    lastResultsJson: JSON.stringify([{ galleryId: 'replayed', title: 'Retained', pageCount: 24 }]),
  }).where(eq(schema.watchedSearches.id, legacyWatch.id)).run();
  assert.equal(backfillNewGalleries(), 1);
  const feed = listGalleryFeed({ searchId: legacyWatch.id });
  assert.equal(feed.items[0].foundAt, foundAt);
  assert.equal(feed.items[0].reviewedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(feed.items[0].pageCount, 24);
  assert.equal(listGalleryFeed({ searchId: legacyWatch.id, view: 'inbox' }).total, 0);
  assert.equal(backfillNewGalleries(), 0);
});
