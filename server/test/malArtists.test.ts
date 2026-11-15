import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { myAnimeListProvider } from '../src/providers/myanimelist.js';
import { parseProviderArtistUrl } from '../src/contracts/artists.js';
import { parseMalArtistSearch, parseMalArtist, parseMalArtistWorks } from '../src/providers/malArtistPages.js';
const originalFetch = globalThis.fetch;
const searchHtml = readFileSync(new URL('./fixtures/mal-people.html', import.meta.url), 'utf8');
const artistHtml = readFileSync(new URL('./fixtures/mal-artist.html', import.meta.url), 'utf8');
const kirinHtml = readFileSync(new URL('./fixtures/mal-kirin-profile.html', import.meta.url), 'utf8');
afterEach(() => { globalThis.fetch = originalFetch; });

test('MAL people URLs resolve safely, including the supplied artist link', () => {
  assert.deepEqual(parseProviderArtistUrl('https://myanimelist.net/people/15043/Myuuto_Akatsuki?q=akatsuki%20myuuto&cat=person'), { providerId: 'myanimelist', artistId: '15043' });
  for (const url of ['https://myanimelist.net.evil.test/people/15043', 'https://myanimelist.net/manga/15043', 'https://myanimelist.net/people/0', 'https://myanimelist.net/people/999999999999999999', 'https://user:pass@myanimelist.net/people/15043']) assert.equal(parseProviderArtistUrl(url), null);
});
test('real MAL search HTML deduplicates photo links and follows 50-result pages', () => {
  const result = parseMalArtistSearch(searchHtml, 1);
  assert.deepEqual(result.items.map(item => item.artistId), ['10542', '28523', '84646']);
  assert.equal(result.items[1].name, 'mana');
  assert.equal(result.hasNextPage, true);
  assert.equal(parseMalArtistSearch(searchHtml, 7).hasNextPage, false);
});
test('real MAL artist HTML supplies names, works, full covers, types and years', () => {
  assert.equal(parseMalArtist(artistHtml, '15043').name, 'Myuuto Akatsuki');
  assert.deepEqual(parseMalArtist(artistHtml, '15043').aliases, ['Getto Yozora', '夜空 月兎']);
  const works = parseMalArtistWorks(artistHtml);
  assert.equal(works.length, 3);
  assert.equal(works[2].title, 'Dorei Usagi to Anthony');
  assert.equal(works[2].providerSeriesId, '32631');
  assert.equal(works[2].year, 2011);
  assert.equal(works[1].type, 'COMIC');
  assert.equal(works[0].coverUrl, 'https://cdn.myanimelist.net/images/manga/3/98365.jpg');
});
test('a unique MAL name search redirected to a profile becomes one artist result', () => {
  const result = parseMalArtistSearch(kirinHtml, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].artistId, '11741');
  assert.equal(result.items[0].name, 'Kakeru Kirin');
  assert.equal(result.items[0].url, 'https://myanimelist.net/people/11741');
  assert.equal(result.hasNextPage, false);
  assert.equal(parseMalArtistSearch(kirinHtml, 2).items.length, 0);
  assert.ok(parseMalArtistWorks(kirinHtml).length > 0);
});
test('redirect recognition rejects foreign identities, non-artist pages and incomplete profiles', () => {
  for (const html of [kirinHtml.replace('https://myanimelist.net/people/', 'https://myanimelist.net.evil.test/people/'),
    kirinHtml.replace('/people/11741/', '/manga/11741/'), kirinHtml.replace('Published Manga', 'Please complete verification')]) {
    assert.throws(() => parseMalArtistSearch(html, 1), /unrecognized artist page/);
  }
});
test('reported artist search and direct people URL both load the redirected profile works', async () => {
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input)); return new Response(kirinHtml); };
  const result = await myAnimeListProvider.searchArtists('kirin kakeru');
  assert.equal(result.items[0].artistId, '11741');
  assert.equal((await myAnimeListProvider.getArtist('11741')).name, 'Kakeru Kirin');
  assert.ok((await myAnimeListProvider.getArtistWorks('11741')).items.length > 0);
  assert.equal(requests.length, 2, 'the profile and works reuse the same cached page');
  assert.equal(new URL(requests[0]).searchParams.get('q'), 'kirin kakeru');
});
test('MAL artist search uses MAL directly without API credentials or the retired Jikan host', async () => {
  myAnimeListProvider.setCredentials({ clientId: 'must-not-leak' });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://myanimelist.net');
    assert.equal(url.pathname, '/people.php');
    assert.equal(url.searchParams.get('q'), 'mana');
    assert.equal(url.searchParams.get('show'), '50');
    assert.equal(new Headers(init?.headers).has('X-MAL-CLIENT-ID'), false);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(searchHtml);
  };
  const result = await myAnimeListProvider.searchArtists('mana', 2);
  assert.equal(result.items[1].artistId, '28523');
  assert.equal(result.hasNextPage, true);
});
test('artist lookup and works share cached HTML without confusing parsed data types', async () => {
  let calls = 0;
  globalThis.fetch = async input => { calls++; assert.equal(String(input), 'https://myanimelist.net/people/15043'); return new Response(artistHtml); };
  assert.equal((await myAnimeListProvider.getArtist('15043')).name, 'Myuuto Akatsuki');
  assert.equal((await myAnimeListProvider.getArtistWorks('15043')).items.length, 3);
  assert.equal((await myAnimeListProvider.getArtistWorks('15043', 2)).items.length, 0);
  assert.equal(calls, 1);
});
test('HTML challenges and layout changes surface as errors; explicit empty pages stay empty', () => {
  for (const html of ['<title>Just a moment...</title>', '<html>Unknown layout</html>']) {
    assert.throws(() => parseMalArtistSearch(html, 1), /unrecognized artist page/);
    assert.throws(() => parseMalArtistWorks(html), /unrecognized artist page/);
  }
  assert.deepEqual(parseMalArtistWorks('<div>Published Manga</div>No published manga have been added'), []);
  assert.deepEqual(parseMalArtistSearch('Search Results</div><table></table>', 1).items, []);
});
test('connection failures retry with a bounded count and useful diagnostics', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }); };
  await assert.rejects(myAnimeListProvider.getArtist('15045'), /Could not connect to MyAnimeList \(ETIMEDOUT\).*DNS/);
  assert.equal(calls, 3);
});
test('transient failures recover and HTTP failures are not cached or hidden', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('Unavailable', { status: 503 }) : new Response(artistHtml);
  assert.equal((await myAnimeListProvider.getArtist('15046')).name, 'Myuuto Akatsuki');
  assert.equal(calls, 2);
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  await assert.rejects(myAnimeListProvider.getArtist('15047'), /HTTP 403.*blocked/);
  globalThis.fetch = async () => new Response(artistHtml);
  assert.equal((await myAnimeListProvider.getArtist('15047')).name, 'Myuuto Akatsuki');
});
