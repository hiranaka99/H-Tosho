import assert from 'node:assert/strict';
import http from 'node:http';
import { test, type TestContext } from 'node:test';
import { KavitaClient } from '../src/kavita/client.js';
import type { MetadataSnapshot, RecordedValue } from '../src/contracts/metadataHistory.js';
import {
  getMetadataRestoreFieldAvailability,
  metadataValueKey,
  RESTORE_FIELD_MAPPINGS,
  type ExactMetadataRestoreValues,
  type RestorableMetadataField,
} from '../src/contracts/metadataRestore.js';

type MetadataDto = Record<string, unknown>;
interface FixtureRequest { method: string; path: string; body?: MetadataDto }
interface PostOutcome { skipApply?: boolean; status?: number; dropResponse?: boolean }
interface FixtureOptions {
  onTitlePost?: (fixture: RestoreFixture, payload: MetadataDto) => PostOutcome | void;
  metadata?: MetadataDto;
  onPost?: (fixture: RestoreFixture, payload: MetadataDto, index: number) => PostOutcome | void;
  afterApply?: (fixture: RestoreFixture, payload: MetadataDto, index: number) => void;
  beforeMetadataRead?: (fixture: RestoreFixture, index: number) => void;
  nullMetadataRead?: number;
  people?: Record<string, { id: number; name: string } | null>;
  onPerson?: (fixture: RestoreFixture, name: string) => void;
  personStatus?: number;
  installationId?: string;
}
interface RestoreFixture {
  client: KavitaClient;
  metadata: MetadataDto;
  series: { id: number; libraryId: number; name: string | null; folderPath: string | null; nameLocked:boolean; sortName:string; sortNameLocked:boolean;localizedName:null;localizedNameLocked:boolean;coverImageLocked:boolean };
  requests: FixtureRequest[];
  posts: MetadataDto[];
  snapshot(): MetadataSnapshot;
}

async function fixture(t: TestContext, options: FixtureOptions = {}): Promise<RestoreFixture> {
  const metadata: MetadataDto = {
    id: 11, seriesId: 42, summary: 'Current summary', summaryLocked: true,
    genres: [{ id: 9, title: 'Current genre' }], genresLocked: false,
    tags: [{ id: 8, title: 'Current tag' }], tagsLocked: true,
    writers: [{ id: 7, name: 'Current writer' }], writerLocked: true,
    pencillers: [{ id: 6, name: 'Current artist' }], pencillerLocked: false,
    releaseYear: 2024, releaseYearLocked: false, language: 'en', languageLocked: false,
    publicationStatus: 0, publicationStatusLocked: false, webLinks: 'https://current.example',
    coverArtists: null, publishers: [{ id: 12, name: 'Unrelated publisher' }], characters: [],
    inkers: [], imprints: [], colorists: [], letterers: [], editors: [], translators: [], teams: [], locations: [],
    ageRating: 4, ageRatingLocked: true, maxCount: 30, totalCount: 21,
    characterLocked: false, coloristLocked: false, editorLocked: false, inkerLocked: false,
    imprintLocked: false, lettererLocked: false, publisherLocked: false, translatorLocked: false,
    teamLocked: false, locationLocked: false, coverArtistLocked: true,
    futureMetadata: { keep: null, revision: 1 }, ...options.metadata,
  };
  let state: RestoreFixture;
  let metadataReads = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    const method = req.method!;
    let body: MetadataDto | undefined;
    if (method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    state.requests.push({ method, path: url.pathname, body });
    res.setHeader('Content-Type', 'application/json');
    if (method === 'GET' && url.pathname === '/api/Series/42') {
      res.end(JSON.stringify(state.series));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/Series/metadata') {
      metadataReads++;
      options.beforeMetadataRead?.(state, metadataReads);
      res.end(JSON.stringify(metadataReads === options.nullMetadataRead ? null : state.metadata));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/Server/server-info-slim') {
      res.end(JSON.stringify({ kavitaVersion: '0.9.1', installId: options.installationId }));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/Person') {
      const name = url.searchParams.get('name')!;
      options.onPerson?.(state, name);
      res.statusCode = options.personStatus ?? 200;
      res.end(JSON.stringify(options.people?.[name] ?? null));
      return;
    }
    if (method === 'POST' && url.pathname === '/api/Series/update') {
      const outcome = options.onTitlePost?.(state,body!);
      if (!outcome?.skipApply) {
        const renamed=state.series.name!==body!.name;
        Object.assign(state.series,body);
        if(renamed && !body!.sortNameLocked)state.series.sortName=body!.name as string;
      }
      if (outcome?.dropResponse) { res.destroy(); return; }
      res.statusCode = outcome?.status ?? 200; res.end('{}'); return;
    }
    if (method === 'POST' && url.pathname === '/api/Series/metadata') {
      const payload = body!.seriesMetadata as MetadataDto;
      state.posts.push(payload);
      const index = state.posts.length;
      const result = options.onPost?.(state, payload, index);
      const outcome = typeof result === 'object' && result !== null ? result : undefined;
      if (!outcome?.skipApply) {
        // Model the supported Kavita 0.9 REST semantics, not provider patches.
        const next = structuredClone(payload);
        for (const field of ['writers', 'artists'] as const) {
          const mapping = RESTORE_FIELD_MAPPINGS[field];
          if (state.metadata[mapping.lock] === true && payload[mapping.lock] === true) next[mapping.key] = structuredClone(state.metadata[mapping.key]);
        }
        next.summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
        next.language = payload.language ?? '';
        next.webLinks = typeof payload.webLinks === 'string' ? payload.webLinks.split(',').filter(part => part.length > 0).map(part => part.trim()).join(',') : '';
        if (typeof payload.releaseYear !== 'number' || payload.releaseYear < 1000) next.releaseYear = state.metadata.releaseYear;
        for (const key of ['genres', 'tags', 'writers', 'pencillers']) {
          const entries = next[key];
          if (Array.isArray(entries)) next[key] = entries.map((entry, index) => ({ ...entry, id: Number(entry.id) || 100 + index }));
        }
        state.metadata = next;
        options.afterApply?.(state, payload, index);
      }
      if (outcome?.dropResponse) { res.destroy(); return; }
      res.statusCode = outcome?.status ?? 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Unexpected fixture request' }));
  });
  const ready = Promise.withResolvers<void>();
  server.once('error', ready.reject);
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  server.off('error', ready.reject);
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port');
  state = {
    client: new KavitaClient(`http://127.0.0.1:${address.port}`, 'fixture-key'),
    metadata,
    series: { id: 42, libraryId: 7, name: 'Fixture series', folderPath: '/library/Fixture series',nameLocked:false,
      sortName:'Keep sort',sortNameLocked:false,localizedName:null,localizedNameLocked:false,coverImageLocked:true },
    requests: [], posts: [],
    snapshot() {
      const fields: MetadataSnapshot['fields'] = {};
      for (const [field, mapping] of Object.entries(RESTORE_FIELD_MAPPINGS)) {
        const dto = field === 'title' ? state.series as unknown as MetadataDto : state.metadata;
        fields[field] = { present: Object.hasOwn(dto, mapping.key),
          ...(Object.hasOwn(dto, mapping.key) ? { value: structuredClone(dto[mapping.key]) } : {}),
          ...('lock' in mapping && typeof dto[mapping.lock] === 'boolean' ? { nativeLocked: dto[mapping.lock] as boolean } : {}) };
      }
      return { series: { ...state.series }, fields };
    },
  };
  return state;
}

test('exact restoration clears summary, tags, genres and both people lists instead of additive/provider behavior', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  await f.client.restoreSeriesMetadataExact(42, {
    summary: { present: true, value: '' }, genres: { present: true, value: [] }, tags: { present: true, value: [] },
    writers: { present: true, value: [] }, artists: { present: true, value: [] },
  }, { expected: before, nativeLockFields: [] });
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].summary, '');
  for (const key of ['genres', 'tags', 'writers', 'pencillers']) assert.deepEqual(f.posts[0][key], []);
  assert.equal(f.posts[0].summaryLocked, false);
  assert.equal(f.posts[0].writerLocked, false);
  assert.equal(f.metadata.summaryLocked, true);
  assert.equal(f.metadata.tagsLocked, true);
  assert.equal(f.metadata.writerLocked, true);
  assert.equal(f.metadata.genresLocked, false);
  assert.equal(f.metadata.pencillerLocked, false);
  assert.equal(f.metadata.coverArtists, null, 'normal metadata defaults must not rewrite unrelated null lists');
  assert.deepEqual(f.metadata.publishers, [{ id: 12, name: 'Unrelated publisher' }]);
  assert.equal(f.metadata.ageRatingLocked, true);
  assert.deepEqual(f.metadata.futureMetadata, { keep: null, revision: 1 });
  assert.ok(f.requests.every(request => request.path === '/api/Series/42' || request.path === '/api/Series/metadata'));
});

test('exact custom title restores the chosen native flag and preserves unrelated series and scalar metadata',async t => {
  const f = await fixture(t);
  f.series.sortName = 'Keep sort'; f.series.nameLocked = true;
  const expected = f.snapshot();
  await f.client.restoreSeriesMetadataExact(42,{title:{present:true,value:'Historical & custom title',nativeLocked:false},summary:{present:true,value:'Saved description'}},
    {expected,nativeLockFields:['title']});
  assert.equal(f.series.name,'Historical & custom title'); assert.equal(f.series.nameLocked,false);
  assert.equal(f.series.sortName,'Keep sort'); assert.equal(f.metadata.summary,'Saved description');
  assert.equal(f.series.sortNameLocked,false);
  assert.equal(f.requests.filter(request => request.path==='/api/Series/update').length,2);
  assert.deepEqual(f.requests.filter(request => request.method==='POST').map(request => request.path),['/api/Series/update','/api/Series/update','/api/Series/metadata','/api/Series/metadata']);
});

test('title writes preserve the current native name lock by default and reject stale flags before posting',async t => {
  const f = await fixture(t);
  f.series.nameLocked=true;
  const expected=f.snapshot();
  await f.client.restoreSeriesMetadataExact(42,{title:{present:true,value:'Saved',nativeLocked:false}},{expected,nativeLockFields:[]});
  assert.equal(f.series.nameLocked,true);
  const next=f.snapshot(); f.series.nameLocked=false;
  await assert.rejects(f.client.restoreSeriesMetadataExact(42,{title:{present:true,value:'Other'}},{expected:next,nativeLockFields:[]}),/changed after preview/);
  assert.equal(f.requests.filter(request=>request.method==='POST').length,2);
});

for (const kind of ['no-op','lost-response','partial-error'] as const) test(`title ${kind} never replays or reports a completed write`,async t => {
  const f=await fixture(t,{onTitlePost:()=>kind==='no-op'?{skipApply:true}:kind==='lost-response'?{dropResponse:true}:{status:502}});
  await assert.rejects(f.client.restoreSeriesMetadataExact(42,{title:{present:true,value:'Saved'}},{expected:f.snapshot(),nativeLockFields:[]}));
  assert.equal(f.requests.filter(request=>request.method==='POST').length,kind==='no-op'?1:2);
});

test('exact lists replace existing entries and old person ids are resolved from names on the current server', async t => {
  const f = await fixture(t, { people: { 'Historical writer': { id: 501, name: 'Historical writer' }, 'Historical artist': { id: 502, name: 'Historical artist' } } });
  const before = f.snapshot();
  before.fields.tags.value = [{ id: 9999, title: 'Current tag' }];
  await f.client.restoreSeriesMetadataExact(42, {
    tags: { present: true, value: [{ id: 700, title: 'Historical tag' }] },
    genres: { present: true, value: [{ id: 701, title: 'Historical genre' }] },
    writers: { present: true, value: [{ id: 1, name: 'Historical writer' }] },
    artists: { present: true, value: [{ id: 2, name: 'Historical artist' }] },
  }, { expected: before, nativeLockFields: [] });
  assert.deepEqual(f.posts[0].writers, [{ id: 501, name: 'Historical writer' }]);
  assert.deepEqual(f.posts[0].pencillers, [{ id: 502, name: 'Historical artist' }]);
  assert.deepEqual(f.posts[0].tags, [{ id: 0, title: 'Historical tag' }]);
  assert.deepEqual(f.posts[0].genres, [{ id: 0, title: 'Historical genre' }]);
  assert.equal(f.requests.filter(request => request.path === '/api/Person').length, 2);
});

test('recorded native flags are restored only when explicitly selected', async t => {
  const f = await fixture(t, { metadata: { tagsLocked: false } });
  await f.client.restoreSeriesMetadataExact(42, {
    summary: { present: true, value: 'Historical summary', nativeLocked: false },
    tags: { present: true, value: [], nativeLocked: true },
    writers: { present: true, value: [], nativeLocked: false },
  }, { expected: f.snapshot(), nativeLockFields: ['summary', 'tags'] });
  assert.equal(f.metadata.summaryLocked, false);
  assert.equal(f.metadata.tagsLocked, true);
  assert.equal(f.metadata.writerLocked, true, 'unselected historical writer flag must not replace current flag');
});

test('fresh relock DTO preserves external inter-post edits to unrelated metadata', async t => {
  const f = await fixture(t, { afterApply(state, _payload, index) {
    if (index === 1) {
      state.metadata.webLinks = 'https://external.example';
      state.metadata.publishers = [{ id: 88, name: 'Externally edited publisher' }];
      state.metadata.publisherLocked = true;
      state.metadata.futureMetadata = { keep: 'external', revision: 2 };
    }
  } });
  await f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } }, { expected: f.snapshot(), nativeLockFields: [] });
  assert.equal(f.posts[1].webLinks, 'https://external.example');
  assert.deepEqual(f.posts[1].publishers, [{ id: 88, name: 'Externally edited publisher' }]);
  assert.equal(f.posts[1].publisherLocked, true);
  assert.deepEqual(f.metadata.futureMetadata, { keep: 'external', revision: 2 });
});

for (const [label, change] of [
  ['selected value', (state: RestoreFixture) => { state.metadata.summary = 'External change'; }],
  ['selected native lock', (state: RestoreFixture) => { state.metadata.summaryLocked = true; }],
] as const) {
  test(`inter-post ${label} conflict stops relocking without overwriting the external state`, async t => {
    const f = await fixture(t, { afterApply(state, _payload, index) { if (index === 1) change(state); } });
    await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
      { expected: f.snapshot(), nativeLockFields: [] }), /review required.*not confirmed/);
    assert.equal(f.posts.length, 1);
    if (label === 'selected value') assert.equal(f.metadata.summary, 'External change');
    else assert.equal(f.metadata.summaryLocked, true);
  });
}

for (const [label, change] of [
  ['selected value', (state: RestoreFixture) => { state.metadata.summary = 'Changed since preview'; }],
  ['native lock', (state: RestoreFixture) => { state.metadata.summaryLocked = false; }],
  ['library', (state: RestoreFixture) => { state.series.libraryId = 8; }],
  ['path', (state: RestoreFixture) => { state.series.folderPath = '/replacement'; }],
  ['series name', (state: RestoreFixture) => { state.series.name = 'Replacement'; }],
] as const) {
  test(`stale ${label} rejects before any metadata side effect`, async t => {
    const f = await fixture(t);
    const expected = f.snapshot();
    change(f);
    await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
      { expected, nativeLockFields: [] }), /review required.*changed after preview/);
    assert.equal(f.posts.length, 0);
  });
}

test('selected state is freshly checked after name resolution', async t => {
  const f = await fixture(t, { people: { 'Historical': { id: 50, name: 'Historical' } }, onPerson(state) {
    state.metadata.writers = [{ id: 70, name: 'External writer' }];
  } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { writers: { present: true, value: [{ id: 1, name: 'Historical' }] } },
    { expected: f.snapshot(), nativeLockFields: [] }), /changed after preview/);
  assert.equal(f.posts.length, 0);
});

test('genuine empty scalar text and supported numeric history are restored exactly', async t => {
  const f = await fixture(t);
  await f.client.restoreSeriesMetadataExact(42, {
    summary: { present: true, value: '' }, language: { present: true, value: '' }, url: { present: true, value: '' },
    releaseDate: { present: true, value: 1999 }, status: { present: true, value: 4 },
  }, { expected: f.snapshot(), nativeLockFields: [] });
  for (const key of ['summary', 'language', 'webLinks']) assert.equal(f.metadata[key], '');
  assert.equal(f.metadata.releaseYear, 1999);
  assert.equal(f.metadata.publicationStatus, 4);
});

test('null readback is not treated as an empty summary', async t => {
  const f = await fixture(t, { afterApply(state, _payload, index) { if (index === 1) state.metadata.summary = null; } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: '' } },
    { expected: f.snapshot(), nativeLockFields: [] }), /not confirmed/);
  assert.equal(f.posts.length, 1);
});

test('successful HTTP no-op does not silently succeed', async t => {
  const f = await fixture(t, { onPost() { return { skipApply: true }; } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
    { expected: f.snapshot(), nativeLockFields: [] }), /not confirmed/);
  assert.equal(f.posts.length, 1);
});

test('remote partial 502 is observed, not retried or reported as success', async t => {
  const f = await fixture(t, { onPost(state) {
    state.metadata.summary = 'Historical';
    state.metadata.summaryLocked = false;
    return { skipApply: true, status: 502 };
  } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, {
    summary: { present: true, value: 'Historical' }, tags: { present: true, value: [] },
  }, { expected: f.snapshot(), nativeLockFields: [] }), /outcome is unverified.*HTTP 502/);
  assert.equal(f.posts.length, 1);
  assert.equal(f.metadata.summary, 'Historical');
  assert.deepEqual(f.metadata.tags, [{ id: 8, title: 'Current tag' }]);
});

test('lost write response still restores proven native flags but remains a failed operation', async t => {
  const f = await fixture(t, { onPost(_state, _payload, index) { if (index === 1) return { dropResponse: true }; } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
    { expected: f.snapshot(), nativeLockFields: [] }), /request failed despite observed readback/);
  assert.equal(f.posts.length, 2, 'the second POST restores flags, not a blind value retry');
  assert.equal(f.metadata.summary, 'Historical');
  assert.equal(f.metadata.summaryLocked, true);
});

test('failed relock remains an inspectable failure even when the remote post applied', async t => {
  const f = await fixture(t, { onPost(_state, _payload, index) { if (index === 2) return { status: 503 }; } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
    { expected: f.snapshot(), nativeLockFields: [] }), /native-lock request failed.*HTTP 503/);
  assert.equal(f.posts.length, 2);
  assert.equal(f.metadata.summaryLocked, true);
});

test('missing metadata readback fails without replaying writes', async t => {
  const f = await fixture(t, { nullMetadataRead: 2 });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
    { expected: f.snapshot(), nativeLockFields: [] }), /verifiable full series metadata DTO/);
  assert.equal(f.posts.length, 1);
});

test('cancellation before side effects stops writes', async t => {
  const f = await fixture(t);
  const cancelled = new Error('Cancelled by user');
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: '' } },
    { expected: f.snapshot(), nativeLockFields: [], checkCancelled() { throw cancelled; } }), error => error === cancelled);
  assert.equal(f.requests.length, 0);
});

test('cancellation after a value write restores native flags before respecting cancellation', async t => {
  let cancelled = false;
  const f = await fixture(t, { afterApply(_state, _payload, index) { if (index === 1) cancelled = true; } });
  const error = new Error('Cancelled by user');
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: '' } },
    { expected: f.snapshot(), nativeLockFields: [], checkCancelled() { if (cancelled) throw error; } }), caught => caught === error);
  assert.equal(f.posts.length, 2);
  assert.equal(f.metadata.summary, '');
  assert.equal(f.metadata.summaryLocked, true);
});

test('people lookup failures are not swallowed into creation using historical ids', async t => {
  const f = await fixture(t, { personStatus: 500 });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { writers: { present: true, value: [{ id: 999, name: 'Historical' }] } },
    { expected: f.snapshot(), nativeLockFields: [] }), /HTTP 500/);
  assert.equal(f.posts.length, 0);
});

test('unavailable historical shapes and forbidden DTO paths fail before HTTP writes', async t => {
  const f = await fixture(t);
  const invalid: [string, RecordedValue][] = [
    ['title', { present: true, value: ' ' }], ['cover', { present: true, value: 'Forbidden' }],
    ['summaryLocked', { present: true, value: true }], ['summary', { present: false }],
    ['summary', { present: true, value: 1 }], ['tags', { present: true, value: null }],
    ['writers', { present: true, value: [{ id: 1 }] }], ['artists', { present: true, value: [{ name: '' }] }],
    ['tags', { present: true, value: [{ title: 'Duplicate' }, { title: 'Duplicate' }] }],
    ['tags', { present: true, value: [{ title: ' Historical tag ' }] }],
    ['writers', { present: true, value: [{ name: ' Historical writer ' }] }],
    ['releaseDate', { present: true, value: null }], ['releaseDate', { present: true, value: 1.5 }],
    ['status', { present: true, value: 5 }],
    ['summary', { present: true, value: null }], ['language', { present: true, value: null }], ['url', { present: true, value: null }],
    ['summary', { present: true, value: ' Historical ' }], ['url', { present: true, value: 'https://one.example, https://two.example' }],
    ['releaseDate', { present: true, value: 0 }], ['releaseDate', { present: true, value: 999 }],
  ];
  for (const [field, cell] of invalid) {
    assert.equal(getMetadataRestoreFieldAvailability(field, cell).available, false);
    await assert.rejects(f.client.restoreSeriesMetadataExact(42, { [field]: cell } as ExactMetadataRestoreValues,
      { expected: f.snapshot(), nativeLockFields: [] }), /Cannot restore/);
  }
  assert.equal(f.requests.length, 0);
  for (const field of ['summary', 'language', 'url'] as RestorableMetadataField[]) {
    assert.equal(getMetadataRestoreFieldAvailability(field, { present: true, value: null }).available, false);
  }
});

test('native lock restoration rejects unsupported, uncaptured and unselected flags', async t => {
  const f = await fixture(t);
  for (const nativeLockFields of [['url'], ['tags'], ['summary']] as RestorableMetadataField[][]) {
    await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: '' }, url: { present: true, value: '' } },
      { expected: f.snapshot(), nativeLockFields }), /supported, captured lock flags/);
  }
  assert.equal(f.requests.length, 0);
});

test('captured installation identity prevents identical numeric IDs on a replacement server from being written', async t => {
  const f = await fixture(t, { installationId: 'replacement-installation' });
  const expected = f.snapshot();
  expected.installationId = 'historical-installation';
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
    { expected, nativeLockFields: [] }), /identity changed after preview/);
  assert.equal(f.posts.length, 0);
});

test('unsupported null text is unavailable rather than coerced into an empty restore request', async t => {
  const f = await fixture(t);
  for (const field of ['summary', 'language', 'url'] as const) {
    const cell: RecordedValue = { present: true, value: null };
    const availability = getMetadataRestoreFieldAvailability(field, cell);
    assert.equal(availability.available, false);
    assert.match(availability.reason!, /converts null text to an empty string/);
    await assert.rejects(f.client.restoreSeriesMetadataExact(42, { [field]: cell },
      { expected: f.snapshot(), nativeLockFields: [] }), /exact null restoration is not supported/);
  }
  assert.equal(f.requests.length, 0);
});

test('missing current person names use Kavita creation semantics without historical ids', async t => {
  const f = await fixture(t);
  await f.client.restoreSeriesMetadataExact(42, { writers: { present: true, value: [{ id: 9911, name: 'Recreated historical writer' }] } },
    { expected: f.snapshot(), nativeLockFields: [] });
  assert.deepEqual(f.posts[0].writers, [{ id: 0, name: 'Recreated historical writer' }]);
  assert.deepEqual(f.metadata.writers, [{ id: 100, name: 'Recreated historical writer' }]);
});

test('semantic list comparison ignores transient ids and order without crashing on unavailable entries', () => {
  assert.equal(metadataValueKey({ present: true, value: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] }),
    metadataValueKey({ present: true, value: [{ id: 500, title: 'Two' }, { id: 600, title: 'One' }] }));
  const malformed: RecordedValue = { present: true, value: [{ id: 1, name: null }, { id: 2 }] };
  assert.equal(getMetadataRestoreFieldAvailability('writers', malformed).available, false);
  assert.doesNotThrow(() => metadataValueKey(malformed));
  assert.notEqual(metadataValueKey({ present: true, value: null }), metadataValueKey({ present: true, value: [] }));
  assert.notEqual(metadataValueKey({ present: false }), metadataValueKey({ present: true, value: '' }));
});

test('server-derived unselected age rating changes reject an otherwise exact tag restore', async t => {
  const f = await fixture(t, { metadata: { tagsLocked: false, ageRatingLocked: false }, afterApply(state, _payload, index) {
    if (index === 1) state.metadata.ageRating = 10;
  } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { tags: { present: true, value: [] } },
    { expected: f.snapshot(), nativeLockFields: [] }), /review required.*ageRating/);
  assert.equal(f.posts.length, 1);
  assert.equal(f.metadata.ageRating, 10);
});

test('collateral unselected values changed during relock are not reported as preserved', async t => {
  const f = await fixture(t, { afterApply(state, _payload, index) { if (index === 2) state.metadata.language = 'server-side change'; } });
  await assert.rejects(f.client.restoreSeriesMetadataExact(42, { summary: { present: true, value: 'Historical' } },
    { expected: f.snapshot(), nativeLockFields: [] }), /review required.*language/);
  assert.equal(f.posts.length, 2);
  assert.equal(f.metadata.summaryLocked, true);
});
