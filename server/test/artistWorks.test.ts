import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProviderArtistUrl } from '../src/contracts/artists.js';
import { anilistProvider } from '../src/providers/anilist.js';
import { mangaDexProvider } from '../src/providers/mangadex.js';

process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-artist-works-'));
const { initDb } = await import('../src/db/index.js');
const { setProviderSetting } = await import('../src/services/settings.js');
const { api } = await import('../src/routes/api.js');
initDb();
const originalFetch = globalThis.fetch;
const artistId = '9abe212d-e010-413d-b0de-8c14b96c19e8';
beforeEach(() => { setProviderSetting('anilist', { enabled: true }); setProviderSetting('mangadex', { enabled: true }); });
afterEach(() => { globalThis.fetch = originalFetch; });

test('artist URLs accept the examples and reject other hosts, credentials, IDs and paths', () => {
  assert.deepEqual(parseProviderArtistUrl('https://anilist.co/staff/126726/Yuu-Ichinomiya'), { providerId: 'anilist', artistId: '126726' });
  assert.deepEqual(parseProviderArtistUrl(`https://mangadex.org/author/${artistId}/ichinomiya-yuu?tab=works#list`), { providerId: 'mangadex', artistId });
  for (const url of ['https://anilist.co.evil.test/staff/126726', 'https://anilist.co/manga/126726', 'https://mangadex.org/author/not-an-id', 'https://user:secret@anilist.co/staff/126726', 'file:///staff/126726', 'https://anilist.co/staff/0', 'https://anilist.co/staff/999999999999999999999']) assert.equal(parseProviderArtistUrl(url), null);
});

test('AniList artist search and works use real pagination and keep all title candidates', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://graphql.anilist.co');
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('staff(search:')) {
      assert.deepEqual(body.variables, { search: 'Yuu Ichinomiya', page: 2 });
      return Response.json({ data: { Page: { staff: [{ id: 126726, name: { full: 'Yuu Ichinomiya', native: '一宮夕羽', alternative: ['Ichinomiya Yuu'] } }], pageInfo: { hasNextPage: true, total: 1 } } } });
    }
    assert.ok(body.query.includes('staffMedia(type: MANGA'));
    assert.ok(!body.query.includes('search:'), 'artist works do not use the failing title search');
    assert.deepEqual(body.variables, { id: 126726, page: 3 });
    const work = { id: 42, title: { romaji: 'Unrelated display title', english: 'The gallery title' }, format: 'MANGA', coverImage: { extraLarge: 'https://example.test/cover.jpg' }, startDate: { year: 2020 }, synonyms: ['Alternate title'] };
    return Response.json({ data: { Staff: { staffMedia: { nodes: [work, work], pageInfo: { hasNextPage: true } } } } });
  };
  const artists = await anilistProvider.searchArtists('Yuu Ichinomiya', 2);
  assert.equal(artists.hasNextPage, true, 'do not rely on AniList’s inaccurate total');
  assert.equal(artists.items[0].artistId, '126726');
  const works = await anilistProvider.getArtistWorks('126726', 3);
  assert.equal(works.items.length, 1, 'deduplicate repeated production roles');
  assert.equal(works.items[0].title, 'Unrelated display title');
  assert.ok(works.items[0].altTitles?.includes('The gallery title'));
  assert.equal(works.hasNextPage, true);
});

test('MangaDex artist works include both roles and all ratings, and reuse cover mapping', async () => {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === '/manga') {
      assert.equal(url.searchParams.get('authorOrArtist'), artistId);
      assert.equal(url.searchParams.has('authors[]'), false);
      assert.equal(url.searchParams.has('artists[]'), false);
      assert.equal(url.searchParams.get('offset'), '25');
      assert.deepEqual(url.searchParams.getAll('contentRating[]'), ['safe', 'suggestive', 'erotica', 'pornographic']);
      return Response.json({ data: [{ id: 'work-id', attributes: { title: { en: 'Artist work' }, altTitles: [{ 'ja-ro': 'Alternate title' }] }, relationships: [{ type: 'cover_art', id: 'cover-id' }] }], offset: 25, limit: 25, total: 51 });
    }
    assert.equal(url.pathname, '/cover');
    return Response.json({ data: [{ id: 'cover-id', attributes: { fileName: 'cover.jpg' }, relationships: [{ type: 'manga', id: 'work-id' }] }] });
  };
  const works = await mangaDexProvider.getArtistWorks(artistId, 2);
  assert.equal(works.items[0].coverUrl, 'https://uploads.mangadex.org/covers/work-id/cover.jpg');
  assert.equal(works.hasNextPage, true);
});

test('artist name search and direct example links resolve only through provider APIs', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.origin);
    if (url.origin === 'https://graphql.anilist.co') {
      assert.equal(JSON.parse(String(init?.body)).variables.id, 126726);
      return Response.json({ data: { Staff: { id: 126726, name: { full: 'Yuu Ichinomiya' } } } });
    }
    if (url.pathname === '/author') {
      assert.equal(url.searchParams.get('name'), 'Ichinomiya Yuu');
      assert.equal(url.searchParams.get('offset'), '25');
      return Response.json({ data: [{ id: artistId, attributes: { name: 'Ichinomiya Yuu' } }], offset: 25, limit: 25, total: 26 });
    }
    assert.equal(url.pathname, `/author/${artistId}`);
    return Response.json({ data: { id: artistId, attributes: { name: 'Ichinomiya Yuu' } } });
  };
  for (const [provider, url] of [['anilist', 'https://anilist.co/staff/126726/Yuu-Ichinomiya'], ['mangadex', `https://mangadex.org/author/${artistId}/ichinomiya-yuu`]]) {
    const response = await api.request(`/providers/${provider}/artists?${new URLSearchParams({ query: url })}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items.length, 1);
  }
  const result = await mangaDexProvider.searchArtists('Ichinomiya Yuu', 2);
  assert.equal(result.hasNextPage, false);
  assert.ok(calls.every(origin => ['https://graphql.anilist.co', 'https://api.mangadex.org'].includes(origin)));
});

test('artist APIs validate provider, URL and page before any request and honor disabled providers', async () => {
  globalThis.fetch = async () => { throw new Error('No network request expected'); };
  for (const request of [
    '/providers/unknown/artists?query=Test', '/providers/anilist/artists?query=&page=1',
    '/providers/anilist/artists?query=Test&page=0', '/providers/anilist/artists?query=Test&page=201',
    '/providers/anilist/artists?query=https://example.test/staff/123',
    `/providers/anilist/artists?query=${encodeURIComponent(`https://mangadex.org/author/${artistId}`)}`,
    '/providers/anilist/artists/123%2Fextra/works', '/providers/mangadex/artists/no-id/works',
  ]) assert.equal((await api.request(request)).status, 400, request);
  setProviderSetting('anilist', { enabled: false });
  assert.equal((await api.request('/providers/anilist/artists?query=Test')).status, 409);
  assert.equal((await api.request('/providers/anilist/artists/126726/works')).status, 409);
});

test('artist queries surface GraphQL and upstream failures rather than pretend there are no works', async () => {
  globalThis.fetch = async () => Response.json({ errors: [{ message: 'Provider unavailable' }] });
  const response = await api.request('/providers/anilist/artists/126726/works');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Provider unavailable/);
  globalThis.fetch = async () => Response.json({ errors: [{ detail: 'Artist unavailable' }] }, { status: 404 });
  await assert.rejects(mangaDexProvider.getArtist(artistId), /HTTP 404/);
});

test('MAL artist routes accept the supplied people link, paginate works, and honor disabled settings', async () => {
  setProviderSetting('myanimelist', { enabled: true, credentials: { clientId: 'private-key' } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://myanimelist.net');
    assert.equal(new Headers(init?.headers).has('X-MAL-CLIENT-ID'), false);
    return new Response(readFileSync(new URL('./fixtures/mal-artist.html', import.meta.url), 'utf8'));
  };
  const search = await api.request(`/providers/myanimelist/artists?${new URLSearchParams({ query: 'https://myanimelist.net/people/15043/Myuuto_Akatsuki?q=akatsuki%20myuuto&cat=person' })}`);
  assert.equal(search.status, 200);
  assert.equal((await search.json()).items[0].artistId, '15043');
  const works = await api.request('/providers/myanimelist/artists/15043/works?page=1');
  assert.equal(works.status, 200);
  assert.equal((await works.json()).items[0].providerId, 'myanimelist');
  for (const url of ['/providers/myanimelist/artists/0/works', '/providers/myanimelist/artists/15043/works?page=201', '/providers/anilist/artists?query=https://myanimelist.net/people/15043']) assert.equal((await api.request(url)).status, 400);
  setProviderSetting('myanimelist', { enabled: false });
  assert.equal((await api.request('/providers/myanimelist/artists/15043/works')).status, 409);
});
