import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { DoujinSearchResult } from '../src/downloader/types.js';
import type { KavitaSeriesMetadataDto } from '../src/kavita/types.js';

process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-improvements-'));
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { KavitaClient } = await import('../src/kavita/client.js');
const settings = await import('../src/services/settings.js');
const feedback = await import('../src/services/recommendationFeedback.js');
const recs = await import('../src/services/recommendations.js');
const { eligibleRecommendations } = await import('../src/services/recommendationEligibility.js');
const { jobRecovery } = await import('../src/jobs/recovery.js');
const { api } = await import('../src/routes/api.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { downloadQueue } = await import('../src/downloader/engine.js');
initDb();
const originalProvider = doujinProviders.hitomi;
const originalMethods = { getLibraries: KavitaClient.prototype.getLibraries, getSeries: KavitaClient.prototype.getSeries, getSeriesMetadata: KavitaClient.prototype.getSeriesMetadata };
after(() => { doujinProviders.hitomi = originalProvider; Object.assign(KavitaClient.prototype, originalMethods); });
const item = (id = '123'): DoujinSearchResult => ({ source: 'hitomi', galleryId: id, title: 'A precise title', artists: ['Sample Artist'], tags: ['adventure'], language: 'English', pageCount: 20 });
const series = { id: 1, libraryId: 7, name: 'A precise title', slug: '1', bookCount: 1, pages: 20 };
const metadata = (patch: Partial<KavitaSeriesMetadataDto> = {}) => ({ writers: [{ id: 1, name: 'Sample Artist' }], pencillers: [], inkers: [], tags: [], genres: [], webLinks: '', language: 'English', ...patch } as KavitaSeriesMetadataDto);
function resetFeedback() {
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendation-feedback-v1')).run();
}
function mockLibraries() {
  let calls = 0;
  KavitaClient.prototype.getLibraries = async () => { calls++; return [{ id: 7, name: 'External downloads', monitor: true, mediaFormat: 'manga' }]; };
  KavitaClient.prototype.getSeries = async () => { calls++; return [series]; };
  KavitaClient.prototype.getSeriesMetadata = async () => { calls++; return metadata({ webLinks: 'https://hitomi.la/galleries/123.html' }); };
  settings.setKavitaConnection({ baseUrl: 'http://kavita.test', apiKey: 'test-key' });
  return () => calls;
}

test('search, gallery details, and recommendation eligibility do not scan Kavita ownership', async () => {
  const count = mockLibraries();
  doujinProviders.hitomi = { id: 'hitomi', name: 'Hitomi', color: '#000', async search() { return [item()]; }, async getGallery() { return { ...item(), pages: Array.from({ length: 20 }, (_, i) => `page-${i}`) }; } };
  const response = await api.request('/doujin/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', query: 'sample' }) });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn((await response.json())[0], 'libraryMatch'), false);
  const gallery = await api.request('/doujin/gallery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', idOrUrl: '123' }) });
  assert.equal(gallery.status, 200);
  const body = await gallery.json();
  assert.equal(body.pageCount, 20);
  assert.equal(Object.hasOwn(body, 'libraryMatch'), false);
  assert.deepEqual(await eligibleRecommendations([item()]), [item()]);
  assert.equal(count(), 0);
});

test('thumbs-down dismisses a gallery manually without changing ownership or scanning Kavita', async () => {
  const count = mockLibraries();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const key = `recommendations-v2:${date}`;
  const cache = { date, generatedAt: now.toISOString(), mode: 'popular', profile: { artists: [], tags: [], series: [], language: null }, items: [{ ...item(), reasons: [] }], reserve: [{ ...item('456'), artists: ['Replacement Artist'], reasons: [] }], repeatedCount: 0, degradedReason: 'insufficient-eligible' };
  getDb().insert(schema.keyValueStore).values({ key, valueJson: JSON.stringify(cache) }).run();
  const before = getDb().select().from(schema.ownedGalleries).all();
  const response = await api.request('/recommendations/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', galleryId: '123' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.dismissedKeys, ['hitomi:123']);
  assert.equal(body.items[0].galleryId, '456');
  assert.deepEqual(await eligibleRecommendations([item()]), []);
  assert.deepEqual(getDb().select().from(schema.ownedGalleries).all(), before);
  assert.equal(count(), 0);
  getDb().delete(schema.dismissedGalleries).run();
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, key)).run();
});

test('downloads reject missing output folders before queuing or fetching gallery metadata', async t => {
  const previous = settings.getDownloaderSettings();
  const enqueue = t.mock.method(downloadQueue, 'enqueue', () => 100);
  const getGallery = t.mock.method(doujinProviders.hitomi, 'getGallery', async () => { throw new Error('Must not fetch metadata'); });
  try {
    for (const downloadDirectory of ['', '   ']) {
      settings.setDownloaderSettings({ ...previous, downloadDirectory });
      const response = await api.request('/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', galleryId: 'no-folder' }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /output folder/);
    }
    assert.equal(enqueue.mock.callCount(), 0);
    assert.equal(getGallery.mock.callCount(), 0);
  } finally { settings.setDownloaderSettings(previous); }
});

test('downloads preflight source metadata without checking Kavita, including when Kavita is unavailable', async t => {
  settings.setDownloaderSettings({ ...settings.DEFAULT_DOWNLOADER, downloadDirectory: process.env.HTOSHO_DATA_DIR! });
  const count = mockLibraries();
  const enqueue = t.mock.method(downloadQueue, 'enqueue', () => 100);
  const getGallery = t.mock.method(doujinProviders.hitomi, 'getGallery', async () => ({ ...item(), pages: ['https://fixture.invalid/page.jpg'] }));
  for (const unavailable of [false, true]) {
    if (unavailable) KavitaClient.prototype.getLibraries = async () => { throw new Error('HTTP 503'); };
    const response = await api.request('/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', galleryId: '123' }) });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id: 100, status: 'queued' });
  }
  assert.equal(enqueue.mock.callCount(), 2);
  assert.equal(getGallery.mock.callCount(), 1, 'Fresh metadata is reused for duplicate preflights');
  assert.equal(count(), 0);
  settings.setKavitaConnection({ baseUrl: '', apiKey: '' });
});

test('feedback is persistent, idempotent, reversible, and separate from ownership', () => {
  resetFeedback();
  const before = getDb().select().from(schema.ownedGalleries).all();
  const target = { source: 'hitomi' as const, galleryId: '123' };
  feedback.saveRecommendationFeedback('like', target, item());
  feedback.saveRecommendationFeedback('like', target, item());
  assert.equal(feedback.getRecommendationFeedback().liked.length, 1);
  assert.deepEqual(getDb().select().from(schema.ownedGalleries).all(), before);
  feedback.saveRecommendationFeedback('mute-artist', { ...target, artist: 'SAMPLE_ARTIST' }, item());
  assert.deepEqual(feedback.getRecommendationFeedback().mutedArtists, ['sample artist']);
  assert.throws(() => feedback.saveRecommendationFeedback('mute-artist', { ...target, artist: 'Not an artist' }, item()));
  feedback.saveRecommendationFeedback('unmute-artist', { ...target, artist: 'Sample Artist' });
  feedback.saveRecommendationFeedback('mute-tag', { ...target, tag: 'ADVENTURE' }, item());
  assert.deepEqual(feedback.getRecommendationFeedback().mutedTags, ['adventure']);
  assert.throws(() => feedback.saveRecommendationFeedback('mute-tag', { ...target, tag: 'Not a tag' }, item()));
  feedback.saveRecommendationFeedback('unmute-tag', { ...target, tag: 'adventure' });
  feedback.saveRecommendationFeedback('unlike', target);
  assert.deepEqual(feedback.getRecommendationFeedback(), { liked: [], mutedArtists: [], mutedTags: [] });
});

test('legacy snoozes no longer hide galleries while saved likes and artist mutes remain intact', async () => {
  resetFeedback();
  const target = { source: 'hitomi' as const, galleryId: '123' };
  const saved = { liked: [item()], mutedArtists: ['other artist'], mutedTags: [] };
  getDb().insert(schema.keyValueStore).values({
    key: 'recommendation-feedback-v1',
    valueJson: JSON.stringify({ ...saved, snoozed: [{ ...target, title: item().title, until: new Date(Date.now() + 30 * 86_400_000).toISOString() }] }),
  }).run();
  assert.deepEqual(feedback.getRecommendationFeedback(), saved);
  assert.equal((await eligibleRecommendations([item()])).length, 1);
  assert.deepEqual(await eligibleRecommendations([{ ...item('999'), artists: ['Other Artist'] }]), []);
  feedback.saveRecommendationFeedback('unmute-artist', { ...target, artist: 'Other Artist' });
  const stored = JSON.parse(getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendation-feedback-v1')).get()!.valueJson);
  assert.deepEqual(stored, { liked: [item()], mutedArtists: [], mutedTags: [] });
});

test('tag muting excludes matching galleries and API validates tag actions', async () => {
  resetFeedback();
  const target = { source: 'hitomi' as const, galleryId: '123' };
  feedback.saveRecommendationFeedback('mute-tag', { ...target, tag: 'adventure' }, item());
  assert.deepEqual(await eligibleRecommendations([item(), { ...item('999'), tags: ['Adventure', 'romance'] }]), []);
  assert.equal((await eligibleRecommendations([{ ...item('888'), tags: ['romance'] }])).length, 1);
  feedback.saveRecommendationFeedback('unmute-tag', { ...target, tag: 'adventure' });
  assert.equal((await eligibleRecommendations([item()])).length, 1);
  const bad = await api.request('/recommendations/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'mute-tag', source: 'hitomi', galleryId: '123', tag: '' }) });
  assert.equal(bad.status, 400);
});

test('artist muting excludes collaborations and unmuting restores eligibility', async () => {
  resetFeedback();
  const target = { source: 'hitomi' as const, galleryId: '123' };
  feedback.saveRecommendationFeedback('mute-artist', { ...target, artist: 'Sample Artist' }, item());
  assert.deepEqual(await eligibleRecommendations([item(), { ...item('999'), artists: ['Coartist', 'SAMPLE_ARTIST'] }]), []);
  feedback.saveRecommendationFeedback('unmute-artist', { ...target, artist: 'Sample Artist' });
  assert.equal((await eligibleRecommendations([item()])).length, 1);
});

test('more-like-this adds query signals even for a cold-start profile without recording ownership', async () => {
  resetFeedback();
  settings.setRecommendationSettings({ excludedLibraryIds: [] });
  const queries: string[] = [];
  doujinProviders.hitomi = { id: 'hitomi', name: 'Hitomi', color: '#000',
    async search(query) { queries.push(query); return Array.from({ length: 40 }, (_, i) => ({ ...item(String(1000 + i)), title: `Candidate ${i}`, artists: [`Artist ${i}`] })); },
    async getGallery(id) { return { ...item(id), tags: [], pages: [] }; },
  };
  await recs.applyRecommendationFeedback('like', { source: 'hitomi', galleryId: '123' });
  await recs.refreshRecommendations();
  assert.ok(queries.some(q => q.toLowerCase().includes('artist:sample_artist')), 'liked artist informs discovery even with just one profile term');
  assert.equal(getDb().select().from(schema.ownedGalleries).all().length, 0);
});

test('feedback API rejects removed snooze actions, unsupported actions, sources, and unlisted artists', async () => {
  for (const patch of [{ action: 'unknown' }, { source: 'nhentai' }, { galleryId: '' }, { action: 'snooze', days: 7 }, { action: 'snooze', days: 30 }, { action: 'unsnooze' }, { action: 'mute-artist', artist: 'Fake artist' }]) {
    const response = await api.request('/recommendations/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'like', source: 'hitomi', galleryId: '123', ...patch }) });
    assert.equal(response.status, 400);
  }
  const response = await api.request('/recommendations/feedback');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).liked[0].galleryId, '123');
});

test('known failures offer relevant safe destinations, unknown failures are not misdiagnosed', () => {
  const job = { status: 'failed', type: 'apply-series', payload: { seriesId: 315 }, errorMessage: 'Could not locate the series folder for title on this machine' };
  assert.equal(jobRecovery(job)?.actions[0].href, '/settings?tab=general#library-folders');
  const conflict = jobRecovery({ ...job, errorMessage: 'HTTP 400 - A series with this name already exists in this library' });
  assert.equal(conflict?.actions[0].href, '/libraries?series=315&action=identify');
  const editor = jobRecovery({ ...job, type: 'edit-comicinfo', payload: { path: '/books/a.cbz' }, errorMessage: 'Update series 492 failed: A series with this name already exists in this library' });
  assert.ok(editor?.actions[0].href.includes('series=492&action=comicinfo'));
  assert.ok(jobRecovery({ ...job, errorMessage: 'HTTP 401 - Invalid admin Auth Key' })?.actions[0].href.includes('kavita-connection'));
  assert.equal(jobRecovery({ ...job, errorMessage: 'Random failure https://evil.test' }), undefined);
  assert.equal(jobRecovery({ ...job, status: 'completed' }), undefined);
  const longPath = jobRecovery({ ...job, errorCode: 'missing-files', errorMessage: "ENAMETOOLONG: name too long, open '/mnt/library/book.cbz.cbztmp-id'" });
  assert.match(longPath!.explanation, /filesystem limit/);
  assert.ok(!longPath!.explanation.includes('mounted'));
  assert.equal(longPath!.actions[0].href, '/libraries?series=315');
});

test('paged search exposes full totals, validates page bounds and avoids bulk hydration', async () => {
  let pageCalls = 0;
  doujinProviders.hitomi = {
    ...originalProvider,
    async search() { throw Error('Paged searches must not load 1000 galleries'); },
    async searchPage(query, offset, limit, sort) {
      pageCalls++;
      assert.equal(query, 'cat -artist:evil');
      assert.equal(offset, 1100);
      assert.equal(limit, 25);
      assert.equal(sort, 'popular-month');
      return { items: [item('1101')], total: 1500 };
    },
  };
  const body = { source: 'hitomi', query: 'cat -artist:evil', offset: 1100, limit: 25, sort: 'popular-month' };
  const response = await api.request('/doujin/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.total, 1500);
  assert.equal(page.items[0].galleryId, '1101');
  for (const invalid of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 101 }, { limit: '25' }]) {
    const response = await api.request('/doujin/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...invalid }) });
    assert.equal(response.status, 400);
  }
  assert.equal(pageCalls, 1);
});

test('library lists expose saved Kavita tags for matched and unmatched series and cache metadata', async () => {
  settings.setKavitaConnection({ baseUrl: 'http://library-tags.test', apiKey: 'test-key' });
  const calls: number[] = [];
  KavitaClient.prototype.getSeries = async () => [4101, 4102, 4103, 4104].map(id => ({ ...series, id }));
  KavitaClient.prototype.getSeriesMetadata = async id => {
    calls.push(id);
    if (id === 4103) throw new Error('Metadata temporarily unavailable');
    return metadata({ tags: id === 4101 ? [{ id: 1, title: 'Saved Tag' }] : [] });
  };
  getDb().insert(schema.seriesMatches).values([
    { kavitaSeriesId: 4101, status: 'matched', metadataJson: JSON.stringify({ artists: ['Provider Artist'], tags: ['Stale Tag'] }) },
    { kavitaSeriesId: 4102, status: 'matched', metadataJson: JSON.stringify({ tags: ['Removed Tag'] }) },
    { kavitaSeriesId: 4103, status: 'matched', metadataJson: JSON.stringify({ tags: ['Fallback Tag', null, 12] }) },
  ]).run();
  const response = await api.request('/kavita/libraries/7/series');
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.deepEqual(rows.map((row: { tags: string[] }) => row.tags), [['Saved Tag'], [], ['Fallback Tag'], []]);
  assert.deepEqual(rows[0].artists, ['Provider Artist']);
  assert.deepEqual(rows[3].artists, ['Sample Artist']);
  await api.request('/kavita/libraries/7/series');
  assert.deepEqual(calls, [4101, 4102, 4103, 4104, 4103], 'cached metadata is reused; temporary failures retry');
});

test('switching Kavita connections clears cached library tags', async () => {
  settings.setKavitaConnection({ baseUrl: 'http://other-library-tags.test', apiKey: 'test-key' });
  KavitaClient.prototype.getSeries = async () => [{ ...series, id: 4101 }];
  KavitaClient.prototype.getSeriesMetadata = async () => metadata({ tags: [{ id: 2, title: 'Other Server Tag' }] });
  const rows = await (await api.request('/kavita/libraries/7/series')).json();
  assert.deepEqual(rows[0].tags, ['Other Server Tag']);
});
