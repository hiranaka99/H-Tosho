import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AniListProvider } from '../src/providers/anilist.js';
import { AniListClient } from '../src/providers/anilistClient.js';
import { autoMatch } from '../src/match/autoMatcher.js';
import { getProvider } from '../src/providers/registry.js';

const originalFetch = globalThis.fetch;
const registry = getProvider('anilist')!, originalSearch = registry.search;
afterEach(() => { globalThis.fetch = originalFetch; registry.search = originalSearch; });
function provider() {
  let now = Date.now();
  const result = new AniListProvider(new AniListClient({ now: () => now, wait: async ms => { now += ms; } }));
  registry.search = result.search.bind(result);
  return result;
}
const options = { providerOrder: ['anilist'], enabledProviders: ['anilist'], credentials: {}, searchAll: true };

test('reported compound gallery discovers AniList 206397 through the primary title and ONE_SHOT format', async () => {
  provider();
  const primary = 'Warui Ko to no Bukiyou de Ecchi na Kyoudou Seikatsu';
  const english = "Living With a Brat Who Won't be Honest!";
  const title = `${primary} | ${english}`, searches: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    searches.push(body.variables.search);
    // Reproduce the actual AniList search: the compound string returns nothing;
    // the primary title returns the work only when ONE_SHOT is allowed.
    const media = body.variables.search === primary && /\bONE_SHOT\b/.test(body.query)
      ? [{ id: 206397, title: { romaji: primary }, format: 'ONE_SHOT', synonyms: [] }] : [];
    return Response.json({ data: { Page: { media } } });
  };
  const result = await autoMatch({ id: 1, name: title }, options);
  assert.equal(result.matched, true);
  assert.equal(result.best?.providerSeriesId, '206397');
  assert.equal(result.best?.type, 'MANGA');
  assert.ok(result.best!.score >= 0.72);
  assert.deepEqual(searches, [title, primary, english]);
  assert.deepEqual(result.errors, {});
});

test('AniList search returns English, native and synonym titles for matching', async () => {
  const actual = provider();
  globalThis.fetch = async (_input, init) => {
    assert.match(JSON.parse(String(init?.body)).query, /\bsynonyms\b/);
    return Response.json({ data: { Page: { media: [{ id: 42, title: { romaji: 'Different title', english: 'English gallery title', native: 'Native title' },
      synonyms: ['  Synonym gallery title  ', 'English gallery title', '', null], format: 'ONE_SHOT' }] } } });
  };
  const [candidate] = await actual.search('English gallery title');
  assert.deepEqual(candidate.altTitles, ['Different title', 'English gallery title', 'Native title', 'Synonym gallery title']);
  for (const title of ['English gallery title', 'Synonym gallery title']) {
    const result = await autoMatch({ id: 1, name: title }, options);
    assert.equal(result.best?.score, 1);
    assert.equal(result.best?.title, title);
  }
});

test('novel-only AniList searches stay restricted to novels', async () => {
  const actual = provider();
  globalThis.fetch = async (_input, init) => {
    assert.match(JSON.parse(String(init?.body)).query, /format_in: \[NOVEL\]/);
    return Response.json({ data: { Page: { media: [
      { id: 1, title: { romaji: 'A novel' }, format: 'NOVEL' },
      { id: 2, title: { romaji: 'A one-shot' }, format: 'ONE_SHOT' },
    ] } } });
  };
  assert.deepEqual((await actual.search('A novel', 'NOVEL')).map(item => item.providerSeriesId), ['1']);
});

test('including one-shots does not accept unrelated results', async () => {
  provider();
  globalThis.fetch = async () => Response.json({ data: { Page: { media: [{ id: 99, title: { romaji: 'Completely unrelated space pirates' }, format: 'ONE_SHOT' }] } } });
  const result = await autoMatch({ id: 1, name: 'Warui Ko to no Bukiyou de Ecchi na Kyoudou Seikatsu' }, options);
  assert.equal(result.matched, false);
});
