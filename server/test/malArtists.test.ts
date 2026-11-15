import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { myAnimeListProvider } from '../src/providers/myanimelist.js';
import { parseProviderArtistUrl } from '../src/contracts/artists.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('MAL people URLs resolve safely, including the supplied artist link', () => {
  assert.deepEqual(parseProviderArtistUrl('https://myanimelist.net/people/15043/Myuuto_Akatsuki?q=akatsuki%20myuuto&cat=person'), { providerId: 'myanimelist', artistId: '15043' });
  for (const url of ['https://myanimelist.net.evil.test/people/15043', 'https://myanimelist.net/manga/15043', 'https://myanimelist.net/people/0', 'https://myanimelist.net/people/999999999999999999', 'https://user:pass@myanimelist.net/people/15043']) assert.equal(parseProviderArtistUrl(url), null);
});

test('MAL artist search uses Jikan without credentials and keeps upstream pages', async () => {
  myAnimeListProvider.setCredentials({ clientId: 'must-not-leak' });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.jikan.moe');
    assert.equal(new Headers(init?.headers).has('X-MAL-CLIENT-ID'), false);
    assert.equal(url.searchParams.get('page'), '2');
    return Response.json({ data: [{ mal_id: 15043, name: 'Myuuto Akatsuki', alternate_names: ['Akatsuki Myuuto'] }], pagination: { has_next_page: true } });
  };
  const result = await myAnimeListProvider.searchArtists('akatsuki myuuto', 2);
  assert.equal(result.items[0].artistId, '15043');
  assert.equal(result.items[0].providerId, 'myanimelist');
  assert.equal(result.hasNextPage, true);
});

test('MAL artist works deduplicate roles and page the cached full mangaography', async () => {
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    assert.equal(String(input), 'https://api.jikan.moe/v4/people/15043/manga');
    const works = Array.from({ length: 27 }, (_, i) => ({ manga: { mal_id: i + 1, title: `Work ${i + 1}`, images: { jpg: { image_url: 'https://example.test/cover.jpg' } } } }));
    return Response.json({ data: [...works, works[0]] });
  };
  const first = await myAnimeListProvider.getArtistWorks('15043', 1);
  const second = await myAnimeListProvider.getArtistWorks('15043', 2);
  assert.equal(first.items.length, 25);
  assert.equal(first.hasNextPage, true);
  assert.equal(second.items.length, 2);
  assert.equal(second.hasNextPage, false);
  assert.equal(second.items[0].providerSeriesId, '26');
  assert.equal(second.items[0].providerId, 'myanimelist');
  assert.equal(calls, 1);
});

test('MAL artist failures surface instead of empty results and are not cached', async () => {
  globalThis.fetch = async () => Response.json({ message: 'Artist unavailable' }, { status: 404 });
  await assert.rejects(myAnimeListProvider.getArtist('15044'), /HTTP 404.*Artist unavailable/);
  globalThis.fetch = async () => Response.json({ data: { mal_id: 15044, name: 'Another artist' } });
  assert.equal((await myAnimeListProvider.getArtist('15044')).name, 'Another artist');
});
