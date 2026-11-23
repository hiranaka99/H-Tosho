import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { kavitaSeriesSearchMetadata, invalidateSeriesArtists } = await import('../src/services/seriesArtists.js');

/** The artist names from each series' cached search metadata. */
async function artistsFor(source: Parameters<typeof kavitaSeriesSearchMetadata>[0], ids: number[]): Promise<Map<number, string[]>> {
  const metadata = await kavitaSeriesSearchMetadata(source, ids);
  return new Map([...metadata].map(([id, item]) => [id, item.artists]));
}

type Person = { name: string | null };
type Meta = { pencillers?: Person[] | null; inkers?: Person[] | null; writers?: Person[] | null; tags?: { id: number; title: string | null }[] | null };

/** Stub MetadataSource with a per-id response table and a fetch log. */
function makeSource() {
  const calls: number[] = [];
  const byId = new Map<number, Meta | Error>();
  return {
    calls,
    set(id: number, meta: Meta): void {
      byId.set(id, meta);
    },
    fail404(id: number): void {
      byId.set(id, new Error('probe failed at /Series/metadata: HTTP 404. Check that the series exists'));
    },
    failTransient(id: number): void {
      byId.set(id, new Error('fetch failed'));
    },
    source: {
      async getSeriesMetadata(id: number): Promise<Meta> {
        calls.push(id);
        const v = byId.get(id);
        if (!v) throw new Error(`unexpected fetch for ${id}`);
        if (v instanceof Error) throw v;
        return v;
      },
    },
  };
}

describe('kavitaSeriesSearchMetadata', () => {
  it('merges pencillers, inkers and writers in priority order, deduped case-insensitively', async () => {
    const s = makeSource();
    s.set(101, { pencillers: [{ name: 'Alpha' }], inkers: [{ name: 'Beta' }], writers: [{ name: 'alpha' }, { name: 'Gamma' }] });
    const out = await artistsFor(s.source, [101]);
    assert.deepEqual(out.get(101), ['Alpha', 'Beta', 'Gamma']);
  });

  it('serves fresh results from the cache without re-fetching', async () => {
    const s = makeSource();
    s.set(102, { writers: [{ name: 'Circle A' }] });
    const first = await artistsFor(s.source, [102]);
    assert.deepEqual(first.get(102), ['Circle A']);
    const second = await artistsFor(s.source, [102]);
    assert.deepEqual(second.get(102), ['Circle A']);
    assert.deepEqual(s.calls, [102], 'second call must not fetch again');
  });

  it('caches 404s as empty so series without a metadata row are fetched once', async () => {
    const s = makeSource();
    s.fail404(103);
    const first = await artistsFor(s.source, [103]);
    assert.deepEqual(first.get(103), []);
    const second = await artistsFor(s.source, [103]);
    assert.deepEqual(second.get(103), []);
    assert.deepEqual(s.calls, [103], '404 must not be re-fetched');
  });

  it('does not cache transient failures and retries on the next call', async () => {
    const s = makeSource();
    s.failTransient(104);
    const first = await artistsFor(s.source, [104]);
    assert.deepEqual(first.get(104), []);
    s.set(104, { writers: [{ name: 'Recovered' }] });
    const second = await artistsFor(s.source, [104]);
    assert.deepEqual(second.get(104), ['Recovered']);
    assert.deepEqual(s.calls, [104, 104], 'transient failure must be retried');
  });

  it('invalidateSeriesArtists forces a re-fetch', async () => {
    const s = makeSource();
    s.set(105, { writers: [{ name: 'Old' }] });
    await artistsFor(s.source, [105]);
    s.set(105, { writers: [{ name: 'New' }] });
    invalidateSeriesArtists(105);
    const out = await artistsFor(s.source, [105]);
    assert.deepEqual(out.get(105), ['New']);
    assert.equal(s.calls.length, 2);
  });

  it('returns an empty map for no ids', async () => {
    const s = makeSource();
    const out = await artistsFor(s.source, []);
    assert.equal(out.size, 0);
    assert.deepEqual(s.calls, []);
  });

  it('extracts tags and artists from one metadata request and shares the cache', async () => {
    const s = makeSource();
    s.set(106, { writers: [{ name: 'Artist' }], tags: [{ id: 1, title: ' Romance ' }, { id: 2, title: 'romance' }, { id: 3, title: null }, { id: 4, title: 'Slice of Life' }] });
    const rows = await kavitaSeriesSearchMetadata(s.source, [106, 106]);
    assert.deepEqual(rows.get(106), { artists: ['Artist'], tags: ['Romance', 'Slice of Life'] });
    assert.deepEqual((await artistsFor(s.source, [106])).get(106), ['Artist']);
    assert.deepEqual(s.calls, [106]);
  });

  it('distinguishes no saved tags from unavailable metadata and retries temporary failures', async () => {
    const s = makeSource();
    s.set(107, { tags: [] });
    s.failTransient(108);
    const rows = await kavitaSeriesSearchMetadata(s.source, [107, 108]);
    assert.deepEqual(rows.get(107)?.tags, []);
    assert.equal(rows.get(108)?.tags, null);
    s.set(108, { tags: [{ id: 1, title: 'Recovered' }] });
    assert.deepEqual((await kavitaSeriesSearchMetadata(s.source, [108])).get(108)?.tags, ['Recovered']);
  });

  it('invalidating synced metadata refreshes saved tags as well as artists', async () => {
    const s = makeSource();
    s.set(109, { tags: [{ id: 1, title: 'Old' }] });
    await kavitaSeriesSearchMetadata(s.source, [109]);
    s.set(109, { tags: [{ id: 2, title: 'New' }] });
    invalidateSeriesArtists(109);
    assert.deepEqual((await kavitaSeriesSearchMetadata(s.source, [109])).get(109)?.tags, ['New']);
  });
  it('serves expired entries immediately and refreshes them once in the background', async () => {
    const s = makeSource();
    s.set(110, { writers: [{ name: 'Before' }] });
    await artistsFor(s.source, [110]);
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const slow = { async getSeriesMetadata(id: number) { await gate; return s.source.getSeriesMetadata(id); } };
      s.set(110, { writers: [{ name: 'After' }] });
      assert.deepEqual((await artistsFor(slow, [110])).get(110), ['Before'], 'an expired entry must not block the response');
      assert.deepEqual((await artistsFor(slow, [110])).get(110), ['Before'], 'a refresh already in flight is not started again');
      release();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual((await artistsFor(s.source, [110])).get(110), ['After']);
      assert.deepEqual(s.calls, [110, 110], 'one initial read and one background refresh');
    } finally {
      Date.now = realNow;
    }
  });

  it('does not cache a read that raced an invalidation', async () => {
    const s = makeSource();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.set(111, { writers: [{ name: 'Old' }] });
    const slow = { async getSeriesMetadata(id: number) { const meta = await s.source.getSeriesMetadata(id); await gate; return meta; } };
    const pending = artistsFor(slow, [111]);
    await new Promise(resolve => setImmediate(resolve));
    invalidateSeriesArtists(111);
    s.set(111, { writers: [{ name: 'New' }] });
    release();
    await pending;
    assert.deepEqual((await artistsFor(s.source, [111])).get(111), ['New']);
  });
});
