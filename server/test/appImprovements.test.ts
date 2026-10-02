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
const ownership = await import('../src/services/libraryOwnership.js');
const feedback = await import('../src/services/recommendationFeedback.js');
const recs = await import('../src/services/recommendations.js');
const { eligibleRecommendations } = await import('../src/services/recommendationEligibility.js');
const { jobRecovery } = await import('../src/jobs/recovery.js');
const { api } = await import('../src/routes/api.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
initDb();
const originalProvider = doujinProviders.hitomi;
const originalMethods = { getLibraries: KavitaClient.prototype.getLibraries, getSeries: KavitaClient.prototype.getSeries, getSeriesMetadata: KavitaClient.prototype.getSeriesMetadata };
after(() => { doujinProviders.hitomi = originalProvider; Object.assign(KavitaClient.prototype, originalMethods); });
const item = (id = '123'): DoujinSearchResult => ({ source: 'hitomi', galleryId: id, title: 'A precise title', artists: ['Sample Artist'], tags: ['adventure'], language: 'English', pageCount: 20 });
const series = { id: 1, libraryId: 7, name: 'A precise title', slug: '1', bookCount: 1, pages: 20 };
const metadata = (patch: Partial<KavitaSeriesMetadataDto> = {}) => ({ writers: [{ id: 1, name: 'Sample Artist' }], pencillers: [], inkers: [], tags: [], genres: [], webLinks: '', language: 'English', ...patch } as KavitaSeriesMetadataDto);
const entry = (patch = {}, meta = metadata()) => ({ series: { ...series, ...patch }, libraryName: 'External downloads', metadata: meta });
function resetFeedback() {
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendation-feedback-v1')).run();
}
function mockLibraries() {
  let metadataCalls = 0;
  KavitaClient.prototype.getLibraries = async () => [{ id: 7, name: 'External downloads', monitor: true, mediaFormat: 'manga' }];
  KavitaClient.prototype.getSeries = async () => [series];
  KavitaClient.prototype.getSeriesMetadata = async () => { metadataCalls++; return metadata({ webLinks: 'https://hitomi.la/galleries/123.html' }); };
  settings.setKavitaConnection({ baseUrl: 'http://kavita.test', apiKey: 'test-key' });
  return () => metadataCalls;
}

test('ownership recognizes only valid provider links and explicit filesystem identity', () => {
  assert.deepEqual([...ownership.galleryKeysFromLinks('https://hitomi.la/galleries/123.html https://nhentai.net/g/456/ https://hitomi.la/doujinshi/title-789.html')], ['hitomi:123', 'nhentai:456', 'hitomi:789']);
  assert.equal(ownership.galleryKeysFromLinks('https://hitomi.la.evil/galleries/123.html https://evil/hitomi.la/galleries/123.html').size, 0);
  assert.equal(ownership.matchLibraryGallery(item(), [entry({ name: 'Renamed work' }, metadata({ webLinks: 'https://hitomi.la/galleries/123.html' }))])?.reason, 'provider-id');
  assert.equal(ownership.matchLibraryGallery(item(), [entry({ name: 'Renamed work', folderPath: '/books/Work [hitomi-123]/' })])?.reason, 'provider-id');
});

test('metadata duplicates require matching title, artist sets, pages, and language', () => {
  assert.equal(ownership.matchLibraryGallery(item(), [entry()])?.reason, 'metadata');
  assert.equal(ownership.matchLibraryGallery({ ...item(), source: 'nhentai' }, [entry()])?.reason, 'metadata');
  for (const candidate of [
    { ...item(), title: 'A precise title Vol 2' }, { ...item(), artists: ['Different Artist'] },
    { ...item(), artists: [] }, { ...item(), language: 'Japanese' }, { ...item(), language: undefined }, { ...item(), pageCount: 21 },
  ]) assert.equal(ownership.matchLibraryGallery(candidate, [entry()]), null);
  assert.equal(ownership.matchLibraryGallery(item(), [entry({ pages: 80 })]), null, 'merged series is not a single gallery');
});

test('ownership scans every library, ignores taste opt-outs, coalesces calls and invalidates on connection changes', async () => {
  let calls = 0;
  mockLibraries();
  settings.setRecommendationSettings({ excludedLibraryIds: [7] });
  KavitaClient.prototype.getSeries = async () => Array.from({ length: 605 }, (_, i) => ({ ...series, id: i + 1, name: `Series ${i}` }));
  KavitaClient.prototype.getSeriesMetadata = async id => { calls++; return metadata({ webLinks: id === 605 ? 'https://hitomi.la/galleries/123.html' : '' }); };
  const [a, b] = await Promise.all([ownership.libraryMatches([item()]), ownership.libraryMatches([item()])]);
  assert.equal(a.get('hitomi:123')?.seriesId, 605);
  assert.equal(b.get('hitomi:123')?.seriesId, 605);
  assert.equal(calls, 605, 'one shared scan, not the 600-series recommendation sample');
  assert.equal(ownership.libraryOwnershipStatus().complete, true);
  settings.setKavitaConnection({ baseUrl: '', apiKey: '' });
  assert.equal((await ownership.libraryMatches([item()])).size, 0, 'old connection ownership cannot leak');
});

test('search marks owned galleries and recommendation eligibility excludes external library ownership', async () => {
  const count = mockLibraries();
  doujinProviders.hitomi = { id: 'hitomi', name: 'Hitomi', color: '#000', async search() { return [item()]; }, async getGallery() { return { ...item(), pages: Array.from({ length: 20 }, (_, i) => `page-${i}`) }; } };
  const response = await api.request('/doujin/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', query: 'sample' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].libraryMatch.seriesId, 1);
  assert.deepEqual(await eligibleRecommendations([item()]), []);
  assert.equal(count(), 1, 'warm eligibility shares the ownership index');
});

test('download guard uses provider metadata rather than client titles, and queues nothing for duplicates', async () => {
  mockLibraries();
  const before = getDb().select().from(schema.downloadQueue).all().length;
  const response = await api.request('/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', galleryId: '123', title: 'Spoofed client title' }) });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'already-in-library');
  assert.equal(body.libraryMatch.seriesId, 1);
  assert.equal(getDb().select().from(schema.downloadQueue).all().length, before);
});

test('partial ownership scans surface an error, retain proven duplicates, and block unchecked downloads', async () => {
  mockLibraries();
  KavitaClient.prototype.getSeriesMetadata = async () => { throw new Error('HTTP 503'); };
  KavitaClient.prototype.getSeries = async () => [{ ...series, folderPath: '/library/Work [hitomi-123]' }];
  assert.equal((await ownership.libraryMatches([item()])).get('hitomi:123')?.reason, 'provider-id');
  assert.equal(ownership.libraryOwnershipStatus().complete, false);
  assert.ok(ownership.libraryOwnershipStatus().error);
  doujinProviders.hitomi.getGallery = async id => ({ ...item(id), title: 'Not owned', pages: [] });
  const response = await api.request('/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hitomi', galleryId: 'other' }) });
  assert.equal(response.status, 503);
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
  feedback.saveRecommendationFeedback('unlike', target);
  assert.deepEqual(feedback.getRecommendationFeedback(), { liked: [], mutedArtists: [], snoozed: [] });
});

test('snoozes expire automatically, can end early, and artist muting covers all eligibility paths', async () => {
  resetFeedback();
  const target = { source: 'hitomi' as const, galleryId: '123' };
  feedback.saveRecommendationFeedback('snooze', { ...target, days: 7 }, item());
  assert.deepEqual(await eligibleRecommendations([item()]), []);
  const stored = feedback.getRecommendationFeedback();
  stored.snoozed[0].until = new Date(Date.now() - 1).toISOString();
  getDb().update(schema.keyValueStore).set({ valueJson: JSON.stringify(stored) }).where(eq(schema.keyValueStore.key, 'recommendation-feedback-v1')).run();
  assert.equal((await eligibleRecommendations([item()])).length, 1);
  feedback.saveRecommendationFeedback('snooze', { ...target, days: 30 }, item());
  feedback.saveRecommendationFeedback('unsnooze', target);
  assert.equal((await eligibleRecommendations([item()])).length, 1);
  feedback.saveRecommendationFeedback('mute-artist', { ...target, artist: 'Sample Artist' }, item());
  assert.deepEqual(await eligibleRecommendations([item(), { ...item('999'), artists: ['Coartist', 'SAMPLE_ARTIST'] }]), []);
  feedback.saveRecommendationFeedback('unmute-artist', { ...target, artist: 'Sample Artist' });
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

test('feedback API rejects unsupported actions, durations, sources, and unlisted artists', async () => {
  for (const patch of [{ action: 'unknown' }, { source: 'nhentai' }, { galleryId: '' }, { action: 'snooze', days: 2 }, { action: 'mute-artist', artist: 'Fake artist' }]) {
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
});
