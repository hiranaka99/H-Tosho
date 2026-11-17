import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { DoujinSearchResult } from '../src/downloader/types.js';

process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-following-notifications-'));
const { getDb, schema } = await import('../src/db/index.js');
const { addWatchedSearch, getWatchedSearch, updateWatchedSearch, checkWatchedSearches, listGalleryFeed } = await import('../src/services/watchedSearches.js');
const { getNotificationSettings, setNotificationSettings, NotificationSettingsConflict } = await import('../src/services/settings.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { api: settingsApi } = await import('../src/routes/api/settings.js');
const { api: watchedApi } = await import('../src/routes/api/watched.js');
const original = doujinProviders.hitomi;
let galleries: DoujinSearchResult[] = [];
let requests: { url: string; body: string }[] = [];
let response = () => Promise.resolve(Response.json({ id: 'discord-receipt' }));
const log = () => {};
const check = (ids?: number[]) => checkWatchedSearches(log, undefined, undefined, ids ? { watchIds: ids } : {});
const gallery = (id: string): DoujinSearchResult => ({ source: 'hitomi', galleryId: id, title: `Gallery ${id}`, tags: [], artists: [] });

beforeEach(t => {
  const db = getDb();
  for (const table of [schema.watchedSearchNew, schema.watchedSearchSeen, schema.watchedSearches, schema.watchedSearchFolders]) db.delete(table).run();
  galleries = []; requests = [];
  response = () => Promise.resolve(Response.json({ id: 'discord-receipt' }));
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body) });
    return response();
  });
  setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.test/webhook/fixture' } });
  doujinProviders.hitomi = { ...original, async search() { return galleries; }, async getGallery() { throw new Error('Notification checks must not acquire galleries'); } };
});
after(() => { doujinProviders.hitomi = original; });

test('new finds notify Discord directly once across overlapping watches, with both labels', async () => {
  const a = addWatchedSearch('hitomi', 'artist:a'), b = addWatchedSearch('hitomi', 'artist:b');
  await check();
  assert.equal(requests.length, 0, 'first checks seed silently');
  galleries = [gallery('new')];
  const result = await check();
  assert.equal(result.checked, 2);
  assert.equal(result.notified, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /wait=true/);
  assert.match(requests[0].body, /artist:a, artist:b/);
  assert.equal(listGalleryFeed().total, 1);
  assert.equal((await check()).notified, 0);
  const later = addWatchedSearch('hitomi', 'artist:later');
  galleries = []; await check([later.id]);
  galleries = [gallery('new')]; await check([later.id]);
  assert.equal(requests.length, 1, 'a later watch cannot resend the same gallery');
  assert.ok(getWatchedSearch(a.id)); assert.ok(getWatchedSearch(b.id));
});

test('paused and in-app watches retain discoveries without Discord sends', async () => {
  const a = addWatchedSearch('hitomi', 'artist:paused'), b = addWatchedSearch('hitomi', 'artist:in-app');
  await check();
  updateWatchedSearch(a.id, { expectedRevision: a.revision, paused: true });
  updateWatchedSearch(b.id, { expectedRevision: b.revision, notificationMode: 'in-app' });
  galleries = [gallery('silent')];
  assert.equal((await check([a.id, b.id])).notified, 0);
  assert.equal(requests.length, 0);
  assert.equal(listGalleryFeed().total, 1);
});

for (const outcome of ['failed', 'unknown'] as const) test(`${outcome} Discord sends preserve discoveries and report a separate Task outcome`, async () => {
  const watch = addWatchedSearch('hitomi', 'artist:failure');
  await check();
  response = () => Promise.resolve(new Response(null, { status: outcome === 'failed' ? 403 : 204 }));
  galleries = [gallery('failure')];
  const messages: string[] = [];
  const result = await checkWatchedSearches((_level, message) => messages.push(message));
  assert.equal(result.checked, 1); assert.equal(result.failed, 0); assert.equal(result.notified, 0);
  assert.equal(result.notificationFailed, outcome === 'failed' ? 1 : 0);
  assert.equal(result.notificationUnknown, outcome === 'unknown' ? 1 : 0);
  assert.equal(listGalleryFeed().total, 1);
  assert.equal(getWatchedSearch(watch.id)!.lastError, null);
  assert.ok(messages.some(message => message.includes(outcome === 'failed' ? 'notification failed' : 'delivery uncertain')));
  await check();
  assert.equal(requests.length, 1, 'completed attempts are never silently replayed');
});

test('Discord enablement, draft testing and settings revisions remain available without digest APIs', async () => {
  const settings = getNotificationSettings();
  assert.equal('digest' in settings, false);
  const tested = await settingsApi.request('/settings/notifications/test', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notifications: settings }) });
  assert.deepEqual(await tested.json(), { discord: 'ok' });
  assert.deepEqual(getNotificationSettings(), settings, 'testing does not save a draft');
  assert.throws(() => setNotificationSettings(settings, settings.revision - 1), NotificationSettingsConflict);
  const removed = await settingsApi.request('/settings/notifications', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notifications: { ...settings, digest: { time: '09:00', timezone: 'UTC' } }, expectedRevision: settings.revision }) });
  assert.equal(removed.status, 400);
  assert.equal((await watchedApi.request('/watched-deliveries')).status, 404);
  const watch = addWatchedSearch('hitomi', 'artist:no-digest');
  assert.throws(() => updateWatchedSearch(watch.id, { expectedRevision: watch.revision, notificationMode: 'digest' as never }), /Invalid notification mode/);
});

test('disabled Discord never replays finds when it is enabled again', async () => {
  const watch = addWatchedSearch('hitomi', 'artist:disabled'); await check();
  setNotificationSettings({ discord: { enabled: false, webhookUrl: '' } });
  galleries = [gallery('while-disabled')]; await check();
  setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.test/webhook/fixture' } });
  assert.equal((await check()).notified, 0);
  galleries.push(gallery('after-enabled'));
  assert.equal((await check()).notified, 1);
  assert.equal(requests.length, 1);
  assert.equal(getWatchedSearch(watch.id)!.seenCount, 2);
});
