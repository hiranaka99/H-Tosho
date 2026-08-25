import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseManualProviderUrl } from '../src/match/manualMatch.js';

describe('parseManualProviderUrl', () => {
  it('extracts provider series ids from supported URLs', () => {
    assert.deepEqual(
      parseManualProviderUrl('https://mangadex.org/title/AB8AB6EC-0B19-444F-8ED3-02AD65D7A834/when-mama-and-papa-aren-t-home'),
      { providerId: 'mangadex', providerSeriesId: 'ab8ab6ec-0b19-444f-8ed3-02ad65d7a834', type: 'MANGA' },
    );
    assert.deepEqual(parseManualProviderUrl('https://myanimelist.net/manga/12345/Title'), {
      providerId: 'myanimelist', providerSeriesId: '12345', type: 'MANGA',
    });
    assert.deepEqual(parseManualProviderUrl('https://anilist.co/manga/67890/Title'), {
      providerId: 'anilist', providerSeriesId: '67890', type: 'MANGA',
    });
  });

  it('rejects unsupported hosts, malformed ids, and non-http URLs', () => {
    assert.equal(parseManualProviderUrl('https://example.com/title/ab8ab6ec-0b19-444f-8ed3-02ad65d7a834'), null);
    assert.equal(parseManualProviderUrl('https://mangadex.org/title/not-a-uuid'), null);
    assert.equal(parseManualProviderUrl('javascript:alert(1)'), null);
    assert.equal(parseManualProviderUrl('not a url'), null);
  });
});
