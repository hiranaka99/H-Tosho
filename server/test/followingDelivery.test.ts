import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { DoujinSearchResult } from '../src/downloader/types.js';

process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-following-delivery-'));
// Services snapshot the DB directory at module evaluation; static imports cannot isolate this test process.
const { getDb, schema } = await import('../src/db/index.js');
const { addWatchedSearch, getWatchedSearch, updateWatchedSearch, removeWatchedSearch, checkWatchedSearches, listGalleryFeed, backfillNewGalleries } = await import('../src/services/watchedSearches.js');
const { getNotificationSettings, setNotificationSettings, NotificationSettingsConflict, setWatchedSearchIntervalMinutes } = await import('../src/services/settings.js');
const { dispatchFollowingDeliveries, prepareFollowingDeliveries, interruptFollowingDeliveries, listFollowingDeliveries, followingDeliverySummary, reviewFollowingDelivery, retryFollowingDelivery, deliveryDescription } = await import('../src/services/followingDelivery.js');
const { notify, NotificationFailure } = await import('../src/notify/dispatcher.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { api } = await import('../src/routes/api/watched.js');
const { api: settingsApi } = await import('../src/routes/api/settings.js');
const original = doujinProviders.hitomi;
const NOW = Date.parse('2026-11-16T08:00:00Z');
let now = NOW;
let results: DoujinSearchResult[] = [];
let calls: { url: string; body: string }[] = [];
let webhook: () => Promise<Response> = async () => Response.json({ id: 'receipt-1' });
const log = () => {};
const check = (id: number, jobId = 77) => checkWatchedSearches(log, undefined, undefined, { watchIds: [id] }, jobId);
function gallery(id: string): DoujinSearchResult { return { source: 'hitomi', galleryId: id, title: `Gallery ${id}`, tags: [], artists: [], url: `https://hitomi.la/g/${id}` }; }
function enable() { const settings = getNotificationSettings(); return setNotificationSettings({ ...settings, discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/fixture/secret' }, digest: { ...settings.digest, time: '09:00', timezone: 'UTC', timezoneFallback: false } }); }
async function freshWatch(query = 'artist:delivery', mode: 'immediate' | 'digest' | 'in-app' = 'immediate') {
  let watch = addWatchedSearch('hitomi', query);
  if (mode !== 'immediate') watch = updateWatchedSearch(watch.id, { expectedRevision: watch.revision, notificationMode: mode });
  results = []; await check(watch.id); return watch;
}
function decision(id: string, duplicate = false) {
  const review = reviewFollowingDelivery(id);
  return { expectedRevision: review.delivery.revision, settingsRevision: review.settingsRevision,
    destinationIdentity: review.destinationIdentity, membershipRevision: review.membershipRevision, approvalId: randomUUID(), acknowledgeDuplicate: duplicate, acknowledgeDestinationChange: true };
}
beforeEach(t => {
  now = NOW; results = []; calls = []; webhook = async () => Response.json({ id: 'receipt-1' });
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body) }); return webhook();
  });
  const db = getDb(); db.run(sql`DROP TRIGGER IF EXISTS fail_following_contribution`);
  for (const table of [schema.followingDeliveryApprovals, schema.followingDeliveries, schema.followingContributions, schema.followingEvents, schema.watchedSearchNew, schema.watchedSearchSeen, schema.watchedSearches, schema.watchedSearchFolders, schema.jobs, schema.downloadQueue]) db.delete(table).run();
  setWatchedSearchIntervalMinutes(15);
  const settings = getNotificationSettings();
  setNotificationSettings({ ...settings, discord: { enabled: false, webhookUrl: '' }, digest: { ...settings.digest, time: '09:00', timezone: 'UTC', timezoneFallback: false } });
  doujinProviders.hitomi = { ...original, async search() { return results; }, async getGallery() { throw new Error('Following must never hydrate/download'); } };
});
after(() => { doujinProviders.hitomi = original; });

test('atomic discovery/seen/check/outbox rollback leaves no partially published intent', async () => {
  enable(); const watch = await freshWatch(); const before = getWatchedSearch(watch.id)!;
  results = [gallery('rollback')]; now += 10_000;
  getDb().run(sql`CREATE TRIGGER fail_following_contribution BEFORE INSERT ON following_contributions BEGIN SELECT RAISE(ABORT, 'fixture contribution failure'); END`);
  await assert.rejects(check(watch.id), /fixture contribution failure/);
  assert.equal(listGalleryFeed({ searchId: watch.id }).total, 0);
  assert.equal(getWatchedSearch(watch.id)!.lastCheckedAt, before.lastCheckedAt);
  assert.equal(getWatchedSearch(watch.id)!.seenCount, 0);
  assert.equal(getDb().select().from(schema.followingEvents).all().length, 0);
});

test('overlapping immediate/digest watches contribute one gallery event and one acknowledged delivery with every label/job link', async () => {
  enable(); const a = await freshWatch('artist:overlap-a', 'digest'), b = await freshWatch('tag:overlap-b');
  results = [gallery('overlap')]; await check(a.id, 77); const checked = await check(b.id, 78);
  assert.equal(checked.notified, 0); assert.equal(calls.length, 0);
  assert.equal(followingDeliverySummary(77).pending, 1);
  now += 3_000; await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /wait=true/);
  const item = listFollowingDeliveries().items[0]; assert.equal(item.status, 'delivered'); assert.equal(item.kind, 'immediate');
  assert.deepEqual(item.members[0].labels, ['artist:overlap-a', 'tag:overlap-b']); assert.deepEqual(item.originJobIds, [77, 78]);
  assert.equal(item.receiptId, 'receipt-1'); assert.doesNotMatch(JSON.stringify(item), /secret|webhook/);
  const later = await freshWatch('tag:later'); results = [gallery('overlap')]; await check(later.id, 79);
  await dispatchFollowingDeliveries(now + 3_000); assert.equal(calls.length, 1, 'a later watch cannot resend an already-delivered gallery');
  assert.equal(followingDeliverySummary(79).delivered, 0, 'later contributions cannot rewrite an old send\'s immutable Task provenance');
  assert.equal(listFollowingDeliveries({ jobId: 79 }).total, 0);
  assert.equal(listGalleryFeed({ searchId: later.id }).total, 1);
  assert.equal(getDb().select().from(schema.downloadQueue).all().length, 0);
});

test('first seed/stale/legacy finds do not create intents; explicit paused and in-app checks never notify', async () => {
  enable(); const watch = addWatchedSearch('hitomi', 'artist:seed'); results = [gallery('historical')]; await check(watch.id);
  results.push({ ...gallery('old-upload'), uploadedAt: '2001-01-01T00:00:00Z' }); await check(watch.id);
  let current = updateWatchedSearch(watch.id, { expectedRevision: watch.revision, paused: true });
  results.push(gallery('paused-find')); await check(watch.id); assert.equal(getWatchedSearch(watch.id)!.pausedAt, current.pausedAt);
  current = updateWatchedSearch(watch.id, { expectedRevision: current.revision, paused: false, notificationMode: 'in-app' });
  results.push(gallery('in-app-find')); await check(watch.id);
  backfillNewGalleries(); await dispatchFollowingDeliveries(now + 3_000);
  assert.equal(getDb().select().from(schema.followingEvents).all().length, 0); assert.equal(calls.length, 0);
  assert.deepEqual(listGalleryFeed({ searchId: watch.id }).items.map(item => item.galleryId).sort(), ['in-app-find', 'paused-find']);
});

for (const change of ['pause-resume', 'delete', 'mode-replace'] as const) test(`${change} invalidates old contributions permanently, retaining other active overlap labels`, async () => {
  enable(); const a = await freshWatch('artist:keep'), b = await freshWatch('artist:removed'); results = [gallery('change')];
  await check(a.id); await check(b.id);
  if (change === 'delete') removeWatchedSearch(b.id, b.revision);
  else if (change === 'pause-resume') { const paused = updateWatchedSearch(b.id, { expectedRevision: b.revision, paused: true }); updateWatchedSearch(b.id, { expectedRevision: paused.revision, paused: false }); }
  else { const replaced = updateWatchedSearch(b.id, { expectedRevision: b.revision, notificationMode: 'digest' }); updateWatchedSearch(b.id, { expectedRevision: replaced.revision, notificationMode: 'immediate' }); }
  now += 3_000; await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 1); assert.deepEqual(listFollowingDeliveries().items[0].members[0].labels, [a.query]);
});

test('a provider response after pause/delete/preference edit cannot commit outbox contributions', async () => {
  enable(); const watch = await freshWatch();
  const { promise, resolve: release } = Promise.withResolvers<DoujinSearchResult[]>();
  doujinProviders.hitomi.search = () => promise;
  const pending = check(watch.id);
  updateWatchedSearch(watch.id, { expectedRevision: watch.revision, notificationMode: 'in-app' });
  release([gallery('obsolete-response')]); assert.equal((await pending).checked, 0);
  assert.equal(listGalleryFeed({ searchId: watch.id }).total, 0); assert.equal(followingDeliverySummary().pending, 0);
});

test('globally disabled no-op is truthful and re-enable never floods old finds', async () => {
  const watch = await freshWatch(); results = [gallery('off')]; const checked = await check(watch.id);
  assert.equal(checked.notified, 0); now += 3_000; await dispatchFollowingDeliveries(now);
  assert.equal(listFollowingDeliveries().items[0].status, 'disabled'); assert.equal(followingDeliverySummary().delivered, 0);
  assert.deepEqual(await notify({ title: 'Disabled', success: true }), { status: 'disabled' });
  enable(); await dispatchFollowingDeliveries(now); assert.equal(calls.length, 0);
});

for (const change of ['destination', 'digest-settings', 'off-on'] as const) test(`${change} suppresses pending work until explicit current-destination review`, async () => {
  enable(); const watch = await freshWatch(); results = [gallery('old-destination')]; await check(watch.id);
  const previous = getNotificationSettings();
  if (change === 'destination') setNotificationSettings({ ...previous, discord: { ...previous.discord, webhookUrl: 'https://discord.com/api/webhooks/new/new-secret' } });
  else if (change === 'digest-settings') setNotificationSettings({ ...previous, digest: { ...previous.digest, time: '10:00' } });
  else { setNotificationSettings({ ...previous, discord: { ...previous.discord, enabled: false } }); enable(); }
  now += 3_000; await dispatchFollowingDeliveries(now); assert.equal(calls.length, 0);
  const suppressed = listFollowingDeliveries().items[0]; assert.equal(suppressed.status, 'suppressed');
  assert.equal(suppressed.settingsRevision, previous.revision);
  const request = decision(suppressed.id); const recovery = retryFollowingDelivery(suppressed.id, request);
  assert.equal(recovery.status, 'pending'); assert.notEqual(recovery.id, suppressed.id);
  assert.equal(retryFollowingDelivery(suppressed.id, request).id, recovery.id);
  assert.throws(() => retryFollowingDelivery(suppressed.id, { ...request, approvalId: randomUUID(), expectedRevision: reviewFollowingDelivery(suppressed.id).delivery.revision }), /already queued/);
  await dispatchFollowingDeliveries(now); assert.equal(calls.length, 1);
});

test('known 429/HTTP failures have bounded retries; permanent failures never claim delivery', async () => {
  enable(); const watch = await freshWatch(); results = [gallery('rate')]; await check(watch.id);
  webhook = async () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }); now += 3_000;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await dispatchFollowingDeliveries(now);
    const item = listFollowingDeliveries().items[0]; assert.equal(item.attempts, attempt); assert.equal(item.status, 'failed');
    if (attempt < 4) { assert.ok(item.nextRetryAt); await dispatchFollowingDeliveries(now); assert.equal(calls.length, attempt); now = Date.parse(item.nextRetryAt!); }
    else assert.equal(item.nextRetryAt, null);
  }
  now += 24 * 3600_000; await dispatchFollowingDeliveries(now); assert.equal(calls.length, 4); assert.equal(followingDeliverySummary().delivered, 0);
  const second = await freshWatch('artist:permanent'); results = [gallery('forbidden')]; await check(second.id);
  webhook = async () => new Response('remote secret must not be stored', { status: 403 }); now += 3_000; await dispatchFollowingDeliveries(now);
  const permanent = listFollowingDeliveries().items.find(item => item.members.some(member => member.galleryId === 'forbidden'))!;
  assert.equal(permanent.status, 'failed'); assert.equal(permanent.nextRetryAt, null); assert.equal(permanent.error, 'Discord webhook HTTP 403');
});

for (const outcome of ['network', 'receipt-missing'] as const) test(`${outcome} is UNKNOWN and requires duplicate-warning approval with idempotent reviewed recovery`, async () => {
  enable(); const watch = await freshWatch(); results = [gallery('ambiguous')]; await check(watch.id); now += 3_000;
  webhook = outcome === 'network' ? async () => { throw new Error('socket lost after POST'); } : async () => new Response(null, { status: 204 });
  await dispatchFollowingDeliveries(now); const unknown = listFollowingDeliveries().items[0];
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.nextRetryAt, null); assert.equal(followingDeliverySummary(77).unknown, 1);
  await dispatchFollowingDeliveries(now + 86400_000); assert.equal(calls.length, 1);
  assert.throws(() => retryFollowingDelivery(unknown.id, decision(unknown.id)), /Acknowledge/);
  const approved = decision(unknown.id, true); const recovered = retryFollowingDelivery(unknown.id, approved);
  assert.equal(retryFollowingDelivery(unknown.id, approved).id, recovered.id);
  webhook = async () => Response.json({ id: 'reviewed-receipt' }); await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 2); assert.equal(listFollowingDeliveries({ status: 'delivered' }).items[0].receiptId, 'reviewed-receipt');
});

test('dispatch checkpoint is durable before POST; pause/settings changes during sending are recorded honestly', async () => {
  enable(); const watch = await freshWatch(); results = [gallery('started')]; await check(watch.id); now += 3_000;
  webhook = async () => {
    const row = listFollowingDeliveries().items[0]; assert.equal(row.status, 'dispatching'); assert.equal(row.attempts, 1);
    updateWatchedSearch(watch.id, { expectedRevision: watch.revision, paused: true });
    setNotificationSettings({ ...getNotificationSettings(), discord: { enabled: false, webhookUrl: '' } });
    return Response.json({ id: 'accepted-before-change' });
  };
  await dispatchFollowingDeliveries(now); assert.equal(listFollowingDeliveries().items[0].status, 'delivered');
  assert.equal(listFollowingDeliveries().items[0].receiptId, 'accepted-before-change');
});

test('restart never auto-replays a durable in-flight checkpoint', async () => {
  enable(); const watch = await freshWatch(); results = [gallery('restart')]; await check(watch.id); now += 3_000; prepareFollowingDeliveries(now);
  const row = listFollowingDeliveries().items[0]; getDb().update(schema.followingDeliveries).set({ status: 'dispatching', attempts: 1, startedAt: new Date(now).toISOString() }).where(eq(schema.followingDeliveries.id, row.id)).run();
  const moduleUrl = new URL('../src/services/followingDelivery.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)}); console.log(m.interruptFollowingDeliveries());`], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), '1');
  assert.equal(interruptFollowingDeliveries(now), 0); await dispatchFollowingDeliveries(now);
  assert.equal(listFollowingDeliveries().items[0].status, 'unknown'); assert.equal(calls.length, 0);
});

test('daily digest membership/labels stay immutable across retries and later finds; one bounded catch-up batch', async () => {
  enable(); const a = await freshWatch('artist:digest-a', 'digest'), b = await freshWatch('artist:digest-b', 'digest');
  results = [gallery('digest-1'), gallery('digest-2')]; await check(a.id); await check(b.id);
  now += 3_000; await dispatchFollowingDeliveries(now); assert.equal(calls.length, 0); assert.equal(listFollowingDeliveries().waitingCount, 2);
  now = Date.parse('2026-11-16T09:00:00Z'); webhook = async () => new Response(null, { status: 500 }); await dispatchFollowingDeliveries(now);
  const batch = listFollowingDeliveries().items[0]; assert.equal(batch.kind, 'digest'); assert.equal(batch.members.length, 2); const membership = JSON.stringify(batch.members); const body = calls[0].body;
  results.push(gallery('after-cutoff')); await check(a.id); now = Date.parse(batch.nextRetryAt!); webhook = async () => Response.json({ id: 'digest-receipt' });
  await dispatchFollowingDeliveries(now); assert.equal(JSON.stringify(listFollowingDeliveries({ status: 'delivered' }).items[0].members), membership);
  assert.equal(JSON.parse(calls[1].body).embeds[0].description, JSON.parse(body).embeds[0].description);
  assert.equal(listFollowingDeliveries().waitingCount, 1);
  now = Date.parse('2026-11-20T12:00:00Z'); await dispatchFollowingDeliveries(now); const count = calls.length;
  await dispatchFollowingDeliveries(now + 1_000); assert.equal(calls.length, count);
  assert.equal(getNotificationSettings().digest.nextDueAt, '2026-11-21T09:00:00.000Z');
  assert.equal(listFollowingDeliveries().items.filter(item => item.batchKey?.startsWith('UTC|2026-11-20')).length, 1);
});

test('batch label changes suppress immutable sending; manually reviewed new batch excludes removed labels', async () => {
  enable(); const a = await freshWatch('artist:active', 'digest'), b = await freshWatch('artist:removed', 'digest');
  results = [gallery('immutable')]; await check(a.id); await check(b.id); now = Date.parse('2026-11-16T09:00:00Z'); prepareFollowingDeliveries(now);
  const batch = listFollowingDeliveries().items[0]; removeWatchedSearch(b.id, b.revision); await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 0); assert.equal(listFollowingDeliveries().items[0].status, 'suppressed');
  assert.deepEqual(listFollowingDeliveries().items[0].members[0].labels, [a.query, b.query]);
  const recovery = retryFollowingDelivery(batch.id, decision(batch.id)); assert.deepEqual(recovery.members[0].labels, [a.query]);
  await dispatchFollowingDeliveries(now); assert.equal(calls.length, 1);
});

test('revision-safe settings and reviewed retry HTTP allowlists reject stale/invalid decisions', async () => {
  const settings = enable(); assert.throws(() => setNotificationSettings(settings, settings.revision - 1), NotificationSettingsConflict);
  for (const body of [{ notifications: settings }, { notifications: settings, expectedRevision: -1 }, { notifications: { ...settings, digest: { ...settings.digest, timezone: 'Not/A_Zone' } }, expectedRevision: settings.revision }, { notifications: settings, expectedRevision: settings.revision, extra: true }]) {
    assert.equal((await settingsApi.request('/settings/notifications', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  for (const query of ['offset=-1', 'limit=101', 'jobId=0', 'status=pretend']) assert.equal((await api.request(`/watched-deliveries?${query}`)).status, 400);
  const watch = await freshWatch(); results = [gallery('http-review')]; await check(watch.id); now += 3_000; webhook = async () => { throw new Error('socket'); }; await dispatchFollowingDeliveries(now);
  const id = listFollowingDeliveries().items[0].id;
  const review = decision(id, true); enable();
  assert.equal((await api.request(`/watched-deliveries/${id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(review) })).status, 409);
  assert.equal((await api.request(`/watched-deliveries/${id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...decision(id, true), extra: true }) })).status, 400);
});

test('metadata callers still observe thrown known failures rather than false successful sends', async () => {
  enable(); webhook = async () => new Response(null, { status: 403 });
  await assert.rejects(notify({ title: 'Metadata', success: true }), error => error instanceof NotificationFailure && error.outcome === 'failed');
});

test('same gallery ID on different providers remains two independent delivery identities', async t => {
  enable(); const hitomi = await freshWatch('artist:source');
  const nhentai = addWatchedSearch('nhentai', 'artist:source');
  t.mock.method(doujinProviders.nhentai, 'search', async () => results.map(gallery => ({ ...gallery, source: 'nhentai' as const })));
  results = []; await check(nhentai.id, 78); results = [gallery('same-id')]; await check(hitomi.id, 77); await check(nhentai.id, 78);
  now += 3_000; await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 2); assert.deepEqual(listFollowingDeliveries({ status: 'delivered' }).items.map(item => item.members[0].source).sort(), ['hitomi', 'nhentai']);
});

test('immediate checkpoint preparation re-evaluates still-active labels rather than discarding an overlapping find', async () => {
  enable(); const a = await freshWatch('artist:keep'), b = await freshWatch('artist:remove');
  results = [gallery('prepared-overlap')]; await check(a.id, 77); await check(b.id, 78); now += 3_000; prepareFollowingDeliveries(now);
  const original = listFollowingDeliveries().items[0]; removeWatchedSearch(b.id, b.revision);
  await dispatchFollowingDeliveries(now); assert.equal(calls.length, 0); await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 1); assert.deepEqual(listFollowingDeliveries({ status: 'delivered' }).items[0].members[0].labels, [a.query]);
  assert.equal(followingDeliverySummary(78).delivered, 0);
  assert.equal(reviewFollowingDelivery(original.id).eligibleMembers.length, 0, 'superseded intent cannot queue a parallel duplicate');
});

test('reviewed recovery rejects changed watch revisions without silently changing the approved membership', async () => {
  enable(); const watch = await freshWatch(); results = [gallery('review-race')]; await check(watch.id); now += 3_000;
  webhook = async () => new Response(null, { status: 403 }); await dispatchFollowingDeliveries(now);
  const id = listFollowingDeliveries().items[0].id, approved = decision(id);
  updateWatchedSearch(watch.id, { expectedRevision: watch.revision, displayName: 'New reviewed label' });
  assert.throws(() => retryFollowingDelivery(id, approved), /membership or destination changed/);
  const retry = retryFollowingDelivery(id, decision(id)); assert.deepEqual(retry.members[0].labels, ['New reviewed label']);
});

test('known failure after an approved UNKNOWN resend retains prior duplicate risk on subsequent recovery', async () => {
  enable(); const watch = await freshWatch(); results = [gallery('unknown-chain')]; await check(watch.id); now += 3_000;
  webhook = async () => { throw new Error('uncertain POST'); }; await dispatchFollowingDeliveries(now);
  const unknown = listFollowingDeliveries().items[0]; const retry = retryFollowingDelivery(unknown.id, decision(unknown.id, true));
  webhook = async () => new Response(null, { status: 403 }); await dispatchFollowingDeliveries(now);
  assert.equal(reviewFollowingDelivery(retry.id).possibleDuplicate, true);
  assert.throws(() => retryFollowingDelivery(retry.id, decision(retry.id)), /Acknowledge/);
});

test('cancellation after committed finds keeps in-app history but suppresses not-yet-started job contributions', async () => {
  enable(); const watch = await freshWatch(); results = [gallery('cancel-after-commit')];
  const jobId = Number(getDb().insert(schema.jobs).values({ type: 'check-watched-searches', status: 'running', payloadJson: '{}' }).run().lastInsertRowid);
  let cancelled = false;
  await assert.rejects(checkWatchedSearches(level => {
    if (level !== 'success') return;
    cancelled = true; getDb().update(schema.jobs).set({ status: 'cancelled' }).where(eq(schema.jobs.id, jobId)).run();
  }, () => cancelled, undefined, { watchIds: [watch.id] }, jobId));
  now += 3_000; await dispatchFollowingDeliveries(now);
  assert.equal(calls.length, 0); assert.equal(listGalleryFeed({ searchId: watch.id }).total, 1);
  assert.equal(followingDeliverySummary(jobId).suppressed, 1); assert.equal(followingDeliverySummary(jobId).delivered, 0);
});

test('settings time changes and clock rewind cannot send a second automatic batch for the same local day', async () => {
  enable(); const watch = await freshWatch('artist:clock', 'digest'); results = [gallery('first-day')]; await check(watch.id);
  now = Date.parse('2026-11-16T09:00:00Z'); await dispatchFollowingDeliveries(now); assert.equal(calls.length, 1);
  const settings = getNotificationSettings(); setNotificationSettings({ ...settings, digest: { ...settings.digest, time: '10:00' } });
  results.push(gallery('after-settings')); await check(watch.id);
  now = Date.parse('2026-11-16T10:00:00Z'); await dispatchFollowingDeliveries(now); assert.equal(calls.length, 1);
  now = NOW; await dispatchFollowingDeliveries(now); assert.equal(calls.length, 1);
  now = Date.parse('2026-11-17T10:00:00Z'); await dispatchFollowingDeliveries(now); assert.equal(calls.length, 2);
  assert.equal(listFollowingDeliveries().items.filter(item => item.batchKey === 'UTC|2026-11-16').length, 1);
});

test('digest membership and output are bounded while unsent finds remain durable for the next cutoff', async () => {
  enable(); const watch = await freshWatch('artist:bounded', 'digest');
  for (let batch = 0; batch < 3; batch++) { results = Array.from({ length: 50 }, (_, index) => gallery(`bounded-${batch}-${index}`)); await check(watch.id); }
  now = Date.parse('2026-11-16T09:00:00Z'); await dispatchFollowingDeliveries(now);
  const digest = listFollowingDeliveries({ status: 'delivered' }).items[0];
  assert.equal(digest.members.length, 100); assert.equal(calls.length, 1); assert.equal(listFollowingDeliveries().waitingCount, 50);
  const embed = JSON.parse(calls[0].body).embeds[0]; assert.ok(embed.description.length <= 4096); assert.match(embed.description, /100 new galleries/);
  assert.equal(deliveryDescription(digest.members).includes('+90 more'), true);
  assert.equal(getDb().select().from(schema.downloadQueue).all().length, 0);
});
