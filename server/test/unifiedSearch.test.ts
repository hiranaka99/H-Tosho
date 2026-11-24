import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-unified-'));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb } = await import('../src/db/index.js');
const { runUnifiedSearch, UnifiedSessionError, UnifiedQueryError } = await import('../src/services/unifiedSearch.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { getDownloaderSettings, setDownloaderSettings } = await import('../src/services/settings.js');
const { saveEhentaiAccount, removeEhentaiAccount, getAccountRevision } = await import('../src/services/ehentaiAccount.js');
import type { DoujinSearchResult, DoujinSource } from '../src/downloader/types.js';
import type { UnifiedSearchPage, UnifiedSearchProgress, UnifiedSearchStreamEvent } from '../src/contracts/doujin.js';

initDb();

// ---------------- provider stubs (no network) ----------------

const hitomi = doujinProviders.hitomi;
const nhentai = doujinProviders.nhentai;
const ehentai = doujinProviders.ehentai;
if (!hitomi.searchPage || !nhentai.searchPage) throw new Error('stubbed lanes need searchPage');

function item(source: DoujinSource, galleryId: string, overrides: Partial<DoujinSearchResult> = {}): DoujinSearchResult {
  return {
    source,
    galleryId,
    title: `Title ${galleryId}`,
    language: 'english',
    tags: [],
    artists: ['Artist A'],
    pageCount: 42,
    url: `https://${source === 'hitomi' ? 'hitomi.la/g/' : source === 'nhentai' ? 'nhentai.net/g/' : 'e-hentai.org/g/'}${galleryId}`,
    ...overrides,
  };
}

let hitomiItems: DoujinSearchResult[] = [];
let nhentaiItems: DoujinSearchResult[] = [];
let nhentaiFail = false;
/** When set, the nHentai lane waits for it: a provider slower than Hitomi. */
let nhentaiGate: Promise<void> | null = null;

hitomi.searchPage = async (query: string, offset: number, limit: number) => ({
  items: hitomiItems.slice(offset, offset + limit),
  total: hitomiItems.length,
});
nhentai.searchPage = async (query: string, offset: number, limit: number) => {
  if (nhentaiGate) await nhentaiGate;
  if (nhentaiFail) throw new Error('upstream down');
  return { items: nhentaiItems.slice(offset, offset + limit), total: nhentaiItems.length };
};

const PRINCIPAL = 'tester';
async function fresh(query: string): Promise<UnifiedSearchPage> {
  return runUnifiedSearch({ query, principal: PRINCIPAL }, new AbortController().signal);
}

// ---------------- grouping ----------------

test('groups the same work across providers into one entry with both variants', async () => {
  hitomiItems = [
    item('hitomi', '100', { title: 'Cute Sisters!', artists: ['Foo'], pageCount: 42 }),
    item('hitomi', '101'),
  ];
  nhentaiItems = [
    item('nhentai', '500', { title: 'cute sisters', artists: ['foo'], language: 'en', pageCount: 42 }),
  ];
  const page = await fresh('sister');

  assert.equal(page.items.length, 2, 'two unique works: grouped one + hitomi-only one');
  const grouped = page.items.find((e) => e.variants.length === 2);
  assert.ok(grouped, 'a two-variant group exists');
  assert.equal(grouped!.primary.source, 'hitomi', 'primary is the first-arriving source');
  assert.deepEqual(
    grouped!.variants.map((v) => v.source).sort(),
    ['hitomi', 'nhentai'],
  );
  assert.equal(grouped!.variants.find((v) => v.source === 'nhentai')!.providerPosition, 1);
  assert.ok(page.loadedUniqueCount >= 2);
  // E-Hentai has no stored account: it reports not-configured, never a false success.
  const eh = page.providers.find((p) => p.source === 'ehentai');
  assert.equal(eh?.status, 'not-configured');
  assert.equal(eh?.retryable, false);
});

test('does not merge uncertain editions (different artist or unknown language)', async () => {
  hitomiItems = [
    item('hitomi', '200', { title: 'Same Title', artists: ['Artist A'], pageCount: 10 }),
    item('hitomi', '201', { title: 'same title', artists: ['Artist B'], pageCount: 10 }),
    item('hitomi', '202', { title: 'Same Title', artists: ['Artist A'], pageCount: 10, language: undefined }),
  ];
  nhentaiItems = [
    item('nhentai', '600', { title: 'Same Title', artists: ['artist a'], language: 'en', pageCount: 10 }),
  ];
  const page = await fresh('same title');

  // 200 (hitomi) and 600 (nhentai) match on normalized title+artist+language+pages.
  // 201 has a different first artist; 202 has an unknown language. Both stay separate.
  const grouped = page.items.find((e) => e.variants.length === 2);
  assert.ok(grouped, 'the confident pair is grouped');
  assert.ok(page.items.some((e) => e.variants.some((v) => v.galleryId === '201')));
  assert.ok(page.items.some((e) => e.variants.some((v) => v.galleryId === '202')));
  assert.equal(page.items.length, 3);
});

// ---------------- pagination & cursors ----------------

test('groups author credits with Hitomi titles while keeping metadata and editions distinct', async () => {
  const title = 'A Bodyguard Without Protection -- Bodyguard ha Mamorenai';
  hitomiItems = [item('hitomi', 'mm-hitomi', { title, artists: ['mmchair'] })];
  nhentaiItems = [
    item('nhentai', 'mm-nhentai', { title: `[MM] ${title} [English]`, artists: ['mmchair'] }),
    item('nhentai', 'mm-other-artist', { title: `[MM] ${title}`, artists: ['another artist'] }),
    item('nhentai', 'mm-other-language', { title: `[MM] ${title}`, artists: ['mmchair'], language: 'japanese' }),
    item('nhentai', 'mm-other-pages', { title: `[MM] ${title}`, artists: ['mmchair'], pageCount: 43 }),
    item('nhentai', 'mm-uncensored', { title: `[MM] ${title} [Uncensored]`, artists: ['mmchair'] }),
    item('nhentai', 'mm-censored', { title: `[MM] ${title} [Censored]`, artists: ['mmchair'] }),
  ];
  const page = await fresh('artist:mmchair');
  const grouped = page.items.find(entry => entry.variants.some(variant => variant.galleryId === 'mm-hitomi'))!;
  assert.deepEqual(grouped.variants.map(variant => variant.galleryId), ['mm-hitomi', 'mm-nhentai']);
  assert.deepEqual(grouped.variants.map(variant => variant.title), [title, `[MM] ${title} [English]`]);
  assert.equal(page.totalUnique, 6);
});

test('groups arbitrary aliases and circle/artist credits across all three sources without an artist query', async () => {
  const originalChunk = ehentai.searchChunk;
  saveEhentaiAccount({ session: { ipb_member_id: '12345', ipb_pass_hash: 'abcdef' }, expectedRevision: getAccountRevision() });
  const title = 'Saten-san, Iroiro Eizou Soushuuhen | Saten-san; Video Collection';
  const artist = ['shimanto shisakugata'];
  hitomiItems = [item('hitomi', 'circle-hitomi', { title: `${title} (decensored)`, artists: artist })];
  nhentaiItems = [item('nhentai', 'circle-nhentai', { title: `[An Unrelated Longer Alias] ${title} [Uncensored]`, artists: artist })];
  const ehTitle = `[40010 1-GO (Shimanto Shisakugata)] ${title} [English] [Decensored]`;
  ehentai.searchChunk = async () => ({
    items: [
      item('ehentai', '12345-abcdef012345', { title: ehTitle, artists: artist }),
      item('ehentai', '12346-abcdef012345', { title: ehTitle.replace(' [Decensored]', ''), artists: artist }),
      item('ehentai', '12347-abcdef012345', { title: ehTitle.replace('[Decensored]', '[Censored]'), artists: artist }),
    ],
    nextCursor: null, exhausted: true,
  });
  try {
    const page = await fresh('Saten-san');
    const grouped = page.items.find(entry => entry.variants.some(variant => variant.galleryId === 'circle-hitomi'))!;
    assert.deepEqual(grouped.variants.map(variant => variant.source), ['hitomi', 'nhentai', 'ehentai']);
    assert.equal(grouped.variants.find(variant => variant.source === 'ehentai')!.title, ehTitle);
    assert.equal(page.totalUnique, 3, 'unmarked and censored releases stay separate from the uncensored group');
  } finally {
    ehentai.searchChunk = originalChunk;
    removeEhentaiAccount(getAccountRevision());
  }
});

test('title cleanup preserves separate unmarked, censored, and uncensored edition groups', async () => {
  hitomiItems = [item('hitomi', 'title-normal', { title: '(C103) [Artist A] A Sample Story [English] [Digital]' })];
  nhentaiItems = [
    item('nhentai', 'title-unmarked', { title: 'A Sample Story' }),
    item('nhentai', 'title-uncensored', { title: 'A Sample Story [Uncensored]' }),
    item('nhentai', 'title-decensored', { title: 'A Sample Story (Decensored)' }),
    item('nhentai', 'title-censored', { title: 'A Sample Story [Censored]' }),
    item('nhentai', 'title-color', { title: 'A Sample Story [Full Color]' }),
    item('nhentai', 'title-chapter', { title: 'A Sample Story [Chapter 2]' }),
    item('nhentai', 'title-pages', { title: 'A Sample Story [Uncensored]', pageCount: 43 }),
    item('nhentai', 'title-language', { title: 'A Sample Story [Uncensored]', language: 'japanese' }),
  ];
  const page = await fresh('sample story');
  const group = page.items.find((entry) => entry.variants.some((variant) => variant.galleryId === 'title-uncensored'))!;
  assert.ok(group);
  assert.deepEqual(group.variants.map((variant) => variant.title), ['A Sample Story [Uncensored]', 'A Sample Story (Decensored)']);
  const unmarked = page.items.find((entry) => entry.variants.some((variant) => variant.galleryId === 'title-normal'))!;
  assert.deepEqual(unmarked.variants.map((variant) => variant.galleryId), ['title-normal', 'title-unmarked']);
  const censored = page.items.find((entry) => entry.variants.some((variant) => variant.galleryId === 'title-censored'))!;
  assert.equal(censored.variants.length, 1);
  assert.equal(page.items.length, 7);
  assert.equal(page.totalUnique, 7);
});

test('pages through results without duplicates and reports the exact total', async () => {
  hitomiItems = Array.from({ length: 30 }, (_, i) => item('hitomi', String(100 + i)));
  nhentaiItems = [item('nhentai', '700')];

  const first = await fresh('catalog');
  assert.equal(first.items.length, 25, 'the page limit bounds unique entries');
  assert.ok(first.items.some((e) => e.variants.some((v) => v.source === 'nhentai')), 'nhentai result interleaves on the first page');
  assert.ok(first.hasMore);
  assert.ok(first.nextCursor);

  const all: UnifiedSearchPage['items'] = [...first.items];
  let cursor = first.nextCursor!;
  let lastPage: UnifiedSearchPage | null = null;
  let guard = 0;
  while (cursor && guard++ < 10) {
    lastPage = await runUnifiedSearch({ cursor, principal: PRINCIPAL }, new AbortController().signal);
    all.push(...lastPage.items);
    cursor = lastPage.nextCursor;
  }
  assert.ok(lastPage, 'a final page must be reached');
  assert.equal(lastPage.hasMore, false);
  assert.equal(lastPage.totalUnique, 31);
  assert.equal(all.length, 31, 'every unique entry is delivered exactly once');

  const seen = new Set<string>();
  for (const entry of all) {
    for (const v of entry.variants) seen.add(`${v.source}:${v.galleryId}`);
  }
  assert.equal(seen.size, 31, 'no duplicate variants across pages');
});

test('repeating the last cursor replays the same response; older cursors are stale', async () => {
  hitomiItems = Array.from({ length: 60 }, (_, i) => item('hitomi', String(300 + i)));
  nhentaiItems = [];

  const first = await fresh('replay');
  const replayed = await runUnifiedSearch({ cursor: first.nextCursor!, principal: PRINCIPAL }, new AbortController().signal);
  const second = await runUnifiedSearch({ cursor: replayed.nextCursor!, principal: PRINCIPAL }, new AbortController().signal);
  // The replay produced the "second" page; asking for it again must return the
  // identical response, not skip ahead.
  const replayAgain = await runUnifiedSearch({ cursor: replayed.nextCursor!, principal: PRINCIPAL }, new AbortController().signal);
  assert.deepEqual(replayAgain.items, second.items);
  assert.equal(replayAgain.hasMore, second.hasMore);

  // The cursor that produced `first` is now stale (a newer cursor was served).
  await assert.rejects(
    runUnifiedSearch({ cursor: first.nextCursor!, principal: PRINCIPAL }, new AbortController().signal),
    (e: unknown) => e instanceof UnifiedSessionError && e.kind === 'stale',
  );
  // A cursor that was never issued is expired.
  await assert.rejects(
    runUnifiedSearch({ cursor: 'never-issued', principal: PRINCIPAL }, new AbortController().signal),
    (e: unknown) => e instanceof UnifiedSessionError && e.kind === 'expired',
  );
});

// ---------------- partial failure & scoped retry ----------------

test('one failed lane does not erase the others; a scoped retry adds its results', async () => {
  hitomiItems = Array.from({ length: 30 }, (_, i) => item('hitomi', String(800 + i)));
  nhentaiItems = [item('nhentai', '850')];
  nhentaiFail = true;

  const first = await fresh('partial');
  assert.equal(first.items.length, 25, 'the hitomi page survives the nhentai outage');
  const nh = first.providers.find((p) => p.source === 'nhentai');
  assert.equal(nh?.status, 'failed');
  assert.equal(nh?.retryable, true);
  assert.ok(nh?.message);
  // Only lanes that ran can be watched, each with its own provider-native query.
  assert.equal(first.providers.find((p) => p.source === 'hitomi')?.watchQuery, 'partial');
  assert.equal(nh?.watchQuery, undefined, 'a failed lane offers nothing to watch');
  assert.equal(first.providers.find((p) => p.source === 'ehentai')?.watchQuery, undefined, 'E-Hentai searches cannot be watched');

  nhentaiFail = false;
  const retried = await runUnifiedSearch({ cursor: first.nextCursor!, retry: 'nhentai', principal: PRINCIPAL }, new AbortController().signal);
  assert.equal(retried.items.length, 1, 'a scoped retry delivers only the retried lane');
  assert.ok(retried.items.some((e) => e.variants.some((v) => v.source === 'nhentai')), 'retry delivered the nhentai result');
  // One item against a total of one: the lane now reports complete.
  assert.equal(retried.providers.find((p) => p.source === 'nhentai')?.status, 'exhausted');
  // The single retry budget is enforced: the chip no longer offers it.
  assert.equal(retried.providers.find((p) => p.source === 'nhentai')?.retryable, false);
  assert.equal(retried.providers.find((p) => p.source === 'nhentai')?.watchQuery, 'partial', 'a recovered lane becomes watchable');

  // The other lanes keep their pending state: the next continuation delivers
  // the remaining hitomi items, and the exact unique total counts all lanes.
  const continued = await runUnifiedSearch({ cursor: retried.nextCursor!, principal: PRINCIPAL }, new AbortController().signal);
  assert.equal(continued.items.length, 5, 'the continuation delivers the remaining hitomi items');
  assert.ok(continued.items.every((e) => e.variants.every((v) => v.source === 'hitomi')));
  assert.equal(continued.hasMore, false);
  assert.equal(continued.totalUnique, 31);
});

// ---------------- session invalidation ----------------

test('a downloader-settings change immediately invalidates the session', async () => {
  hitomiItems = Array.from({ length: 40 }, (_, i) => item('hitomi', String(1000 + i)));
  nhentaiItems = [];
  const first = await fresh('invalidated');
  assert.ok(first.nextCursor, 'a continuation must exist to invalidate');
  const before = getDownloaderSettings();
  setDownloaderSettings({ ...before, nhentaiBannedTags: ['new-ban'] });
  await assert.rejects(
    runUnifiedSearch({ cursor: first.nextCursor!, principal: PRINCIPAL }, new AbortController().signal),
    (e: unknown) => e instanceof UnifiedSessionError && e.kind === 'invalidated',
  );
  setDownloaderSettings(before); // restore for later tests
});

test('an E-Hentai account save invalidates the session', async () => {
  hitomiItems = Array.from({ length: 40 }, (_, i) => item('hitomi', String(1100 + i)));
  nhentaiItems = [];
  const first = await fresh('account-cutover');
  assert.ok(first.nextCursor, 'a continuation must exist to invalidate');
  saveEhentaiAccount({ session: { ipb_member_id: '12345', ipb_pass_hash: 'abcdef' }, expectedRevision: getAccountRevision() });
  await assert.rejects(
    runUnifiedSearch({ cursor: first.nextCursor!, principal: PRINCIPAL }, new AbortController().signal),
    (e: unknown) => e instanceof UnifiedSessionError && e.kind === 'invalidated',
  );
});

// ---------------- query classification ----------------

test('bare numeric IDs are rejected as ambiguous', async () => {
  await assert.rejects(
    fresh('12345'),
    (e: unknown) => e instanceof UnifiedQueryError && /ambiguous/i.test(e.message),
  );
});

test('a recognized E-Hentai URL resolves on the owning provider only', async () => {
  const realGetGallery = ehentai.getGallery;
  ehentai.getGallery = async () => ({
    source: 'ehentai' as const,
    galleryId: '11111-abcdef012345',
    title: 'URL Resolved',
    language: 'english',
    tags: [],
    artists: ['Foo'],
    pageCount: 10,
    url: 'https://e-hentai.org/g/11111/abcdef012345/',
    site: 'e-hentai' as const,
    pages: [] as string[],
  });
  try {
    const page = await fresh('https://e-hentai.org/g/11111/abcdef012345/');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].variants[0].source, 'ehentai');
    assert.equal(page.totalUnique, 1);
    assert.ok(page.providers.every((p) => p.source === 'ehentai' ? p.status === 'exhausted' : p.status === 'not-applicable'));
  } finally {
    ehentai.getGallery = realGetGallery;
  }
});

test('a language EH does not know leaves the EH lane unsupported without failing the search', async () => {
  hitomiItems = [item('hitomi', '950')];
  nhentaiItems = [];
  const page = await fresh('language:mongolian');
  const eh = page.providers.find((p) => p.source === 'ehentai');
  assert.equal(eh?.status, 'unsupported-query');
  assert.ok(page.items.length >= 1, 'other lanes still deliver results');
});

test('true zero results report an exact unique total', async () => {
  // Later tests stored an E-Hentai account; drop it so the EH lane is
  // not-configured instead of reaching the network.
  if (getAccountRevision() > 0) removeEhentaiAccount(getAccountRevision());
  hitomiItems = [];
  nhentaiItems = [];
  const page = await fresh('nothing here at all');
  assert.equal(page.items.length, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.totalUnique, 0);
  const ok = page.providers.filter((p) => p.status === 'success' || p.status === 'exhausted');
  assert.ok(ok.some((p) => p.source === 'hitomi'));
  assert.ok(ok.some((p) => p.source === 'nhentai'));
});

// ---------------- streamed first page ----------------

function slowNhentai(): () => void {
  let release!: () => void;
  nhentaiGate = new Promise<void>((resolve) => { release = resolve; });
  return () => { nhentaiGate = null; release(); };
}

test('a streamed search reports each provider as it answers, without waiting for the slowest', async () => {
  if (getAccountRevision() > 0) removeEhentaiAccount(getAccountRevision());
  hitomiItems = Array.from({ length: 30 }, (_, i) => item('hitomi', String(3000 + i)));
  nhentaiItems = [
    item('nhentai', '3500', { title: 'Title 3000' }), // same work as hitomi 3000
    ...Array.from({ length: 29 }, (_, i) => item('nhentai', String(3501 + i), { title: `Only nh ${i}` })),
  ];
  const release = slowNhentai();
  const progress: UnifiedSearchProgress[] = [];
  let hitomiSeen!: () => void;
  const hitomiArrived = new Promise<void>((resolve) => { hitomiSeen = resolve; });
  const work = runUnifiedSearch({ query: 'streamed', principal: PRINCIPAL }, new AbortController().signal, (p) => {
    progress.push(p);
    if (p.items.some((e) => e.primary.source === 'hitomi')) hitomiSeen();
  });

  await hitomiArrived;
  // Hitomi's cards are out while nHentai is still searching.
  const status = (p: UnifiedSearchProgress, source: string) => p.providers.find((x) => x.source === source)?.status;
  assert.equal(status(progress[0], 'hitomi'), 'searching', 'the first event lists the running lanes');
  assert.equal(status(progress[0], 'ehentai'), 'not-configured', 'skipped lanes settle straight away');
  const hitomiEvent = progress.at(-1)!;
  assert.equal(status(hitomiEvent, 'hitomi'), 'success');
  assert.equal(status(hitomiEvent, 'nhentai'), 'searching');
  assert.equal(hitomiEvent.items.length, 13, 'an even share of the page per running lane');
  assert.ok(hitomiEvent.items.every((e) => e.primary.source === 'hitomi'));

  release();
  const page = await work;
  const nhEvent = progress.at(-1)!;
  assert.equal(status(nhEvent, 'nhentai'), 'success');
  assert.ok(nhEvent.items.every((e) => e.primary.source === 'nhentai'));
  assert.deepEqual(nhEvent.updates.map((e) => e.entryId), [hitomiEvent.items[0].entryId], 'the matching edition joins the card already shown');
  assert.ok(!nhEvent.providers.some((p) => p.status === 'searching'));

  // The final page repeats every streamed card in arrival order, then tops up.
  assert.equal(page.items.length, 25);
  const streamed = progress.flatMap((p) => p.items.map((e) => e.entryId));
  assert.deepEqual(page.items.slice(0, streamed.length).map((e) => e.entryId), streamed);
  assert.equal(new Set(page.items.map((e) => e.entryId)).size, 25, 'no card is delivered twice');
  assert.equal(page.items[0].variants.length, 2);
  assert.ok(page.hasMore);
  // The streamed page continues like any other.
  const next = await runUnifiedSearch({ cursor: page.nextCursor!, principal: PRINCIPAL }, new AbortController().signal);
  assert.ok(next.items.length > 0);
  assert.ok(next.items.every((e) => !page.items.some((p) => p.entryId === e.entryId)));
});

test('the unified route streams NDJSON events and keeps JSON errors for bad queries', async () => {
  if (getAccountRevision() > 0) removeEhentaiAccount(getAccountRevision());
  hitomiItems = Array.from({ length: 5 }, (_, i) => item('hitomi', String(4000 + i)));
  nhentaiItems = [item('nhentai', '4500', { title: 'nh only' })];
  const { api } = await import('../src/routes/api/doujin.js');
  const post = (body: unknown) => api.request('/doujin/search/unified', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const res = await post({ query: 'route stream', stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /ndjson/);
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as UnifiedSearchStreamEvent);
  assert.equal(events.at(-1)!.type, 'page');
  assert.ok(events.slice(0, -1).every((e) => e.type === 'progress'));
  const final = events.at(-1) as Extract<UnifiedSearchStreamEvent, { type: 'page' }>;
  assert.equal(final.page.items.length, 6);

  const bad = await post({ query: '12345', stream: true });
  assert.equal(bad.status, 400, 'errors before any progress keep their status');
  assert.match(((await bad.json()) as { error: string }).error, /ambiguous/);

  const plain = await post({ query: 'route plain' });
  assert.match(plain.headers.get('content-type') ?? '', /json/);
  assert.doesNotMatch(plain.headers.get('content-type') ?? '', /ndjson/, 'without stream the route answers one JSON page');
});
