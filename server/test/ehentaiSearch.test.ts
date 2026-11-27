import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-ehentai-search-'));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb } = await import('../src/db/index.js');
const { getDownloaderSettings, setDownloaderSettings } = await import('../src/services/settings.js');
const { saveEhentaiAccount } = await import('../src/services/ehentaiAccount.js');
const { resetEhentaiGate } = await import('../src/downloader/ehentaiGate.js');
const { ehentaiProvider, parseEhentaiListPage, parseEhentaiGalleryPage, parseEhentaiViewerImage } = await import('../src/downloader/ehentai.js');
const { parseEhentaiGdata, gdataNumber } = await import('../src/downloader/ehentaiGdata.js');
const { parseEhentaiGalleryId, parseEhentaiGalleryUrl } = await import('../src/contracts/doujin.js');
const { parseCommonQuery, compileEhentai } = await import('../src/services/unifiedQuery.js');

initDb();

const searchChunk = ehentaiProvider.searchChunk;
if (!searchChunk) throw new Error('ehentaiProvider must implement the searchChunk seam');

// ---------------- fake family transport ----------------
//
// The client pins IPs via dns.lookup and connects over node:https directly,
// so the fixture routes by (servername, path) through a patched
// https.request. No real network is touched.

type FakeResponse = { status: number; body: string; contentType?: string };
type Router = (hostname: string, pathAndQuery: string, method: string, formBody: string | null) => FakeResponse;

let route: Router = () => ({ status: 404, body: 'no route' });
const requests: Array<{ hostname: string; path: string; method: string; body: string | null; headers: Record<string, string> }> = [];

const realRequest = https.request;
const realLookup = dns.lookup;

interface FakeSocketEvents {
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
}

function fakeRequest(options: { servername?: string; path?: string; method?: string; headers?: Record<string, string> }, onResponse: (res: { statusCode: number; headers: Record<string, string>; resume(): void } & FakeSocketEvents) => void): unknown {
  const reqEvents = new EventEmitter();
  const req = {
    end(body?: string): unknown {
      const hostname = options.servername ?? '';
      const requestPath = options.path ?? '/';
      const method = options.method ?? 'GET';
      const formBody = method === 'POST' && body ? body : null;
      requests.push({ hostname, path: requestPath, method, body: formBody, headers: options.headers ?? {} });
      let response: FakeResponse;
      try {
        response = route(hostname, requestPath, method, formBody);
      } catch (error) {
        process.nextTick(() => reqEvents.emit('error', error));
        return req;
      }
      process.nextTick(() => {
        const resEvents = new EventEmitter();
        onResponse({
          statusCode: response.status,
          headers: { 'content-type': response.contentType ?? 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(response.body, 'utf8')) },
          on: (event, cb) => resEvents.on(event, cb),
          resume: () => { /* fixture: body delivered in one chunk */ },
        });
        resEvents.emit('data', Buffer.from(response.body, 'utf8'));
        resEvents.emit('end');
      });
      return req;
    },
    destroy(): void { /* fixture: nothing in flight */ },
    on(event: 'error' | 'timeout', cb: (error?: Error) => void): unknown {
      return reqEvents.on(event, cb);
    },
  };
  return req;
}

(https as unknown as { request: unknown }).request = fakeRequest;
(dns as unknown as { lookup: unknown }).lookup = (
  _hostname: string,
  _options: unknown,
  callback: (error: null, addresses: Array<{ address: string; family: number }>) => void,
): void => {
  callback(null, [{ address: '93.184.216.34', family: 4 }]);
};

after(() => {
  (https as unknown as { request: unknown }).request = realRequest;
  (dns as unknown as { lookup: unknown }).lookup = realLookup;
  // The data dir is left in place: Windows locks the open SQLite file.
});

// Fast pacing: the fixtures must not wait out the production 3s gaps.
resetEhentaiGate({
  html: { minGapMs: 5, maxConcurrent: 4 },
  api: { minGapMs: 5, maxConcurrent: 4 },
  image: { minGapMs: 5, maxConcurrent: 4 },
});

// ---------------- fixtures ----------------

const SESSION = { ipb_member_id: '12345678', ipb_pass_hash: '0a1b2c3d4e5f6071', igneous: 'deadbeefcafe' };
saveEhentaiAccount({ site: 'exhentai', session: SESSION, expectedRevision: 0 });

interface FixtureGallery {
  gid: string;
  token: string;
  title: string;
  pages: number;
  language: string;
  languages?: string[];
  date: string;
}

function listPageHtml(galleries: FixtureGallery[], nextUrl: string | null): string {
  const rows = galleries.map((g) => `
<tr>
<td class="gl1c glcat"><div class="cn ct2">Doujinshi</div></td>
<td class="gl2c"><div class="glthumb"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="https://ehgt.org/x/${g.gid}.webp"></div><div id="posted_${g.gid}">${g.date}</div></td>
<td class="gl3c glname"><a href="https://exhentai.org/g/${g.gid}/${g.token}/"><div class="glink">${g.title}</div>${(g.languages ?? [g.language]).map((language) => `<div class="gt" title="language:${language}">${language}</div>`).join('')}</a></td>
<td class="gl4c glhide"><div>${g.pages} pages</div></td>
</tr>`).join('\n');
  const pagination = nextUrl
    ? `<div class="searchnav"><a href="${nextUrl.replace(/&/g, '&amp;')}" id="unext">Next &gt;</a></div>`
    : '<div class="searchnav"><span id="unext">Next &gt;</span></div>';
  return `<html><body><form action="https://exhentai.org/" method="get"><input name="f_search"></form>${pagination}<table class="itg gltc"><tr><th>Published</th><th>Title</th></tr>${rows}<tr><td colspan="4" class="itd"><div>Advertisement</div></td></tr></table></body></html>`;
}

function gdataJson(entries: Array<{ gid: string; token: string; language: string; languages?: string[]; pages: number; uploadedTs: string; artist?: string; error?: string }>): string {
  return JSON.stringify({ gmetadata: entries.map((e) => e.error ? { gid: Number(e.gid), error: e.error } : {
    gid: Number(e.gid), token: e.token, category: 'Doujinshi', filecount: String(e.pages), posted: e.uploadedTs,
    tags: [...(e.artist ? [`artist:${e.artist}`] : []), ...(e.languages ?? [e.language]).map((language) => `language:${language}`)],
  }) });
}

function galleryPageHtml(gid: string, token: string, pageNumbers: string[], total = pageNumbers.length, nextUrl: string | null = null): string {
  const rows = pageNumbers.map((n) => `<a href="https://exhentai.org/s/${token.slice(0, 8)}${Number(n).toString(16).padStart(2, '0')}/${gid}-${n}"><div title="Page ${n}: image.webp" style="width:200px;height:280px;background:transparent url(https://thumbnails.hath.network/sprite.webp) -200px 0 no-repeat"></div></a>`).join('');
  return `
<html><body>
<div id="gd1"><div style="width:250px;height:350px;background:transparent url(https://ehgt.org/w/cover.webp) 0 0 no-repeat"></div></div>
<div id="gd2"><h1 id="gn">Fixture Gallery</h1><h1 id="gj">オリジナル・タイトル</h1></div>
<div id="gdc"><div class="cs ct2">Doujinshi</div></div>
<div id="gdd"><table>
<tr><td class="gdt1">Posted:</td><td class="gdt2">2026-11-15 12:34</td></tr>
<tr><td class="gdt1">Language:</td><td class="gdt2">English &nbsp;</td></tr>
<tr><td class="gdt1">Length:</td><td class="gdt2">${total} pages</td></tr>
</table></div>
<div id="taglist"><table>
<tr><td class="tc">artist:</td><td><div class="gtl"><a id="ta_artist:konboi" href="https://exhentai.org/tag/artist:konboi">konboi | alias</a></div></td></tr>
<tr><td class="tc">group:</td><td><a id="ta_group:group_a" href="https://exhentai.org/tag/group:group+a">group a</a></td></tr>
<tr><td class="tc">parody:</td><td><a id="ta_parody:some_series" href="https://exhentai.org/tag/parody:some+series">some series</a></td></tr>
<tr><td class="tc">female:</td><td><a id="ta_female:big_breasts" href="https://exhentai.org/tag/female:big+breasts">big breasts</a></td></tr>
</table></div>
<table class="ptt" style="margin:auto"><tr><td>&lt;</td><td>${nextUrl ? `<a href="${nextUrl}">&gt;</a>` : '&gt;'}</td></tr></table>
<div class="gt200" id="gdt">${rows}</div>
</body></html>`;
}

function viewerPageHtml(imageUrl: string): string {
  return `<html><body><div id="i2"><img src="https://ehgt.org/g/p.png"></div><div id="i3"><img src="${imageUrl}" style="height:1790px;width:1280px" id="img"></div></body></html>`;
}

const listRequests = (): Array<{ path: string }> => requests.filter((r) => r.hostname === 'exhentai.org' && r.path.startsWith('/?f_search='));
const gdataRequests = (): Array<{ body: string | null }> => requests.filter((r) => r.hostname === 'api.e-hentai.org');
const resetRequests = (): void => { requests.length = 0; };

// ---------------- gdata JSON parser ----------------

test('parseEhentaiGdata handles many entries, per-item errors, and entities', () => {
  const entries: Array<{ gid: string; token: string; language: string; pages: number; uploadedTs: string; artist?: string; error?: string }> = [];
  for (let i = 1; i <= 30; i++) {
    const token = String(i).padStart(10, '0');
    entries.push({ gid: String(i), token, language: 'English', pages: i, uploadedTs: String(1763278440 + i), artist: i === 3 ? 'Kon & "Boi"' : undefined });
  }
  entries[5] = { gid: '6', token: 'eeeeeeeeee', language: '', pages: 0, uploadedTs: '0', error: '1005: Gallery is unavailable or restricted' };
  const parsed = parseEhentaiGdata(gdataJson(entries));
  assert.ok(parsed, 'document must parse');
  assert.equal(parsed!.length, 30);
  assert.equal(parsed![5].error, '1005: Gallery is unavailable or restricted');
  assert.equal(parsed![2].tags[0].value, 'Kon & "Boi"');
  assert.equal(gdataNumber(parsed![1], 'filecount'), 2);
  assert.equal(gdataNumber(parsed![1], 'missing'), null);
  assert.equal(parseEhentaiGdata('<html>not JSON</html>'), null);
  assert.equal(parseEhentaiGdata('{"gmetadata":['), null, 'unterminated document is not an empty result');
  assert.equal(parseEhentaiGdata('{"error":"bad request"}'), null);
  assert.equal(parseEhentaiGdata('{"gmetadata":[{}]}'), null);
});

// ---------------- native search ----------------

test('E-Hentai autocomplete uses native tag completion with scoped session cookies and exact fragments', async () => {
  resetRequests();
  route = () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ tags: {
    '272042': { ns: 'artist', tn: 'mana' }, '11604': { ns: 'artist', tn: 'manabe jouji' }, '1': { ns: 'female', tn: 'ignored' },
  } }) });
  const suggestions = await ehentaiProvider.suggest!('artists:"mana', 2);
  assert.deepEqual(suggestions.map((s) => s.filter).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ['artist:"mana$"', 'artist:"manabe jouji$"'].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(requests[0].hostname, 'exhentai.org');
  assert.equal(requests[0].path, '/api.php');
  assert.deepEqual(JSON.parse(requests[0].body!), { method: 'tagsuggest', text: 'artist:mana' });
  assert.ok(requests[0].headers.Cookie.includes(`ipb_member_id=${SESSION.ipb_member_id}`));
  assert.equal(requests[0].headers.Host, 'exhentai.org');
  resetRequests();
  assert.deepEqual(await ehentaiProvider.suggest!('pages:20'), []);
  assert.equal(requests.length, 0);
});

test('current compact markup preserves real gallery identities, entities, lazy covers, and Next links', () => {
  const next = 'https://exhentai.org/?f_search=mana%20language%3Aenglish%24&next=4335420';
  const html = listPageHtml([
    { gid: '4335420', token: '0c4a972ea6', title: 'Title &amp; &#x65E5;&#26412; &quot;quoted&quot;', pages: 8, language: 'english', date: '2026-11-17 06:24' },
  ], next).replace('class="itg gltc"', "data-layout='compact' class='gltc itg'");
  const parsed = parseEhentaiListPage(html, 'https://exhentai.org/');
  assert.deepEqual(parsed, {
    galleries: [{ gid: '4335420', token: '0c4a972ea6', title: 'Title & 日本 "quoted"', coverUrl: 'https://ehgt.org/x/4335420.webp', language: 'english', pageCount: 8, uploadedAt: '2026-11-17T06:24:00.000Z' }],
    nextUrl: next,
  });
  assert.equal(parseEhentaiGalleryId('4335420-0C4A972EA6')?.canonicalId, '4335420-0c4a972ea6');
  for (const site of ['e-hentai', 'exhentai']) {
    assert.equal(parseEhentaiGalleryUrl(`https://${site}.org/g/4335420/0c4a972ea6/`)?.canonicalId, '4335420-0c4a972ea6');
  }
});

test('a search form alone or malformed gallery row cannot masquerade as empty results', () => {
  for (const html of [
    '<html><form><input name="f_search"></form><p>Unexpected upstream response</p></html>',
    '<table class="itg gltc"><tr><td><a href="https://exhentai.org/g/4335420/0c4a972ea6/">Missing title marker</a></td></tr></table>',
    '<html>Access denied</html>',
  ]) {
    assert.throws(() => parseEhentaiListPage(html, 'https://exhentai.org/'), /gallery table|unrecognized result/);
  }
  assert.deepEqual(parseEhentaiListPage('<form><input name="f_search"></form><p>No unfiltered results found.</p>', 'https://exhentai.org/').galleries, []);
});

test('search hydrates list results through one gdata batch and applies bans', async () => {
  resetRequests();
  setDownloaderSettings({ ...getDownloaderSettings(), ehentaiBannedTags: ['artist:konboi'] });

  const galleries: FixtureGallery[] = [
    { gid: '1111111', token: 'aaaaaaaaaa', title: 'Banned Artist Gallery', pages: 12, language: 'English', date: '2026-11-15 12:34' },
    { gid: '2222222', token: 'bbbbbbbbbb', title: 'Kept Gallery', pages: 8, language: 'Japanese', date: '2026-11-14 09:00' },
  ];
  const nextUrl = 'https://exhentai.org/?f_search=foo%20-artist%3A%22konboi%22%20language%3Aenglish%24&next=1111111';
  route = (hostname, _requestPath) => {
    if (hostname === 'api.e-hentai.org') {
      return { status: 200, body: gdataJson([
        { gid: '1111111', token: 'aaaaaaaaaa', language: 'English', pages: 12, uploadedTs: '1763278440', artist: 'konboi' },
        { gid: '2222222', token: 'bbbbbbbbbb', language: 'English', pages: 8, uploadedTs: '1763100000', artist: 'Other Artist' },
      ]), contentType: 'application/json' };
    }
    return { status: 200, body: listPageHtml(galleries, nextUrl) };
  };

  const results = await ehentaiProvider.search('foo', 25);
  // The ban must be compiled into the site's own query syntax.
  const searchPath = listRequests()[0]?.path;
  assert.ok(searchPath, 'a search request must be made');
  const searchParams = new URL(`https://exhentai.org${searchPath}`).searchParams;
  assert.equal(searchParams.get('f_search'), 'foo -artist:"konboi" language:english$');
  assert.equal(searchParams.get('f_lang'), null);
  assert.equal(searchParams.get('f_cats'), '1009', 'only Doujinshi, Manga, and Artist CG are requested');
  assert.equal(searchParams.get('inline_set'), 'dm_l');
  // One gdata batch for the chunk.
  assert.equal(gdataRequests().length, 1);
  assert.deepEqual(JSON.parse(gdataRequests()[0].body!), { method: 'gdata', gidlist: [[1111111, 'aaaaaaaaaa'], [2222222, 'bbbbbbbbbb']], namespace: 1 });
  const apiRequest = requests.find((r) => r.hostname === 'api.e-hentai.org')!;
  assert.equal(apiRequest.headers['Content-Type'], 'application/json');
  assert.equal(apiRequest.headers.Host, 'api.e-hentai.org', 'the pinned IP must retain the API virtual host');
  assert.equal(apiRequest.headers.Cookie, undefined, 'account cookies never reach the API');
  // The banned artist's gallery is excluded; the kept one is hydrated.
  assert.deepEqual(results.map((r) => r.galleryId), ['2222222-bbbbbbbbbb']);
  assert.equal(results[0].language, 'English', 'gdata language outranks the list cell');
  assert.equal(results[0].pageCount, 8);
  assert.deepEqual(results[0].artists, ['Other Artist']);
  assert.equal(results[0].site, 'exhentai');
  assert.equal(results[0].uploadedAt, new Date(1763100000 * 1000).toISOString());
});

test('search returns an empty list (not a parse error) on a zero-result page', async () => {
  resetRequests();
  setDownloaderSettings({ ...getDownloaderSettings(), ehentaiBannedTags: [] });
  route = () => ({ status: 200, body: '<html><body><form action="https://exhentai.org/" method="get"><input name="f_search"></form><p>No hits found</p></body></html>' });

  const results = await ehentaiProvider.search('nothing matches this at all', 25);
  assert.deepEqual(results, []);

  const chunk = await searchChunk('nothing matches this at all', null, 25);
  assert.deepEqual(chunk.items, []);
  assert.equal(chunk.exhausted, true);
  assert.equal(chunk.nextCursor, null);
});

test('searchChunk walks two continuation pages with bounded limits and no fabricated total', async () => {
  resetRequests();
  const page1: FixtureGallery[] = Array.from({ length: 30 }, (_, i) => ({
    gid: String(3000001 + i),
    token: (i + 1).toString(16).padStart(10, '0'),
    title: `Gallery ${i + 1}`,
    pages: i + 1,
    language: 'English',
    date: '2026-11-01 00:00',
  }));
  const page2: FixtureGallery[] = Array.from({ length: 3 }, (_, i) => ({
    gid: String(3000031 + i),
    token: `ffffff00${(i + 1).toString(16).padStart(2, '0')}`,
    title: `Gallery ${31 + i}`,
    pages: i + 1,
    language: 'English',
    date: '2026-10-01 00:00',
  }));
  const nextUrl = 'https://exhentai.org/?f_search=bar%20language%3Aenglish%24&next=3000030';
  const gdataFor = (items: FixtureGallery[]): string => gdataJson(items.map((g) => ({ gid: g.gid, token: g.token, language: 'English', pages: g.pages, uploadedTs: '1763278440' })));
  const allFixtures = [...page1, ...page2];
  route = (hostname, requestPath, method, formBody) => {
    if (hostname === 'api.e-hentai.org') {
      const tokens = (JSON.parse(formBody!) as { gidlist: Array<[number, string]> }).gidlist.map((g) => g[1]);
      return { status: 200, body: gdataFor(allFixtures.filter((g) => tokens.includes(g.token))), contentType: 'application/json' };
    }
    if (requestPath.includes('next=3000030')) return { status: 200, body: listPageHtml(page2, null) };
    return { status: 200, body: listPageHtml(page1, nextUrl) };
  };

  const chunk1 = await searchChunk('bar', null, 25);
  assert.equal(chunk1.items.length, 25);
  assert.equal(chunk1.exhausted, false);
  assert.ok(chunk1.nextCursor, 'chunk 1 must carry a continuation');
  assert.equal(chunk1.total, undefined, 'the provider must not invent totals');
  assert.equal(listRequests().length, 1);

  // Chunk 2 is served from the in-page remainder: no new list fetch.
  const chunk2 = await searchChunk('bar', chunk1.nextCursor!, 25);
  assert.equal(chunk2.items.length, 5);
  assert.equal(chunk2.exhausted, false, 'page 2 has not been loaded yet');
  assert.ok(chunk2.nextCursor);
  assert.equal(listRequests().length, 1, 'the in-page buffer must be served without a new list request');

  // Chunk 3 fetches the second list page and exhausts.
  const chunk3 = await searchChunk('bar', chunk2.nextCursor!, 25);
  assert.equal(chunk3.items.length, 3);
  assert.equal(chunk3.exhausted, true);
  assert.equal(chunk3.nextCursor, null);
  assert.equal(listRequests().length, 2, 'exactly two list pages across the sequence');
  assert.ok(listRequests().every((r) => new URL(`https://exhentai.org${r.path}`).searchParams.get('inline_set') === 'dm_l'), 'continued requests keep the compact layout');
  assert.ok(listRequests().every((r) => new URL(`https://exhentai.org${r.path}`).searchParams.get('f_cats') === '1009'), 'category restriction survives continuation links that omit the mask');

  const all = [...chunk1.items, ...chunk2.items, ...chunk3.items];
  assert.ok(all.every((gallery) => gallery.language === 'English'), 'all continued chunks retain the English default');
  assert.equal(new Set(all.map((r) => r.galleryId)).size, 33, 'no duplicates, no dropped galleries');
});

test('a per-item gdata error keeps the list-page result instead of dropping it', async () => {
  resetRequests();
  const galleries: FixtureGallery[] = [
    { gid: '4444444', token: 'cccccccccc', title: 'Broken Metadata', pages: 5, language: 'English', date: '2026-11-15 12:34' },
  ];
  route = (hostname) => {
    if (hostname === 'api.e-hentai.org') {
      return { status: 200, body: gdataJson([{ gid: '4444444', token: 'cccccccccc', language: '', pages: 0, uploadedTs: '0', error: '1005: Gallery is unavailable or restricted' }]), contentType: 'application/json' };
    }
    return { status: 200, body: listPageHtml(galleries, null) };
  };
  const results = await ehentaiProvider.search('foo', 25);
  assert.deepEqual(results.map((r) => r.galleryId), ['4444444-cccccccccc']);
  assert.equal(results[0].language, 'English', 'falls back to the list cell when gdata failed for the item');
  assert.equal(results[0].pageCount, 5);
  assert.equal(results[0].uploadedAt, '2026-11-15T12:34:00.000Z');
  assert.equal(results[0].coverUrl, 'https://ehgt.org/x/4444444.webp', 'lazy cover wins over the placeholder');
});

test('an explicit supported language overrides the English default', async () => {
  resetRequests();
  route = () => ({ status: 200, body: listPageHtml([], null) });
  await ehentaiProvider.search('foo', 25, undefined, { language: 'Japanese' });
  const searchPath = listRequests()[0]?.path;
  assert.ok(searchPath);
  const params = new URL(`https://exhentai.org${searchPath}`).searchParams;
  assert.equal(params.get('f_search'), 'foo language:japanese$');
});

test('English defaults prefer English on multilingual results and exclude known non-English matches', async () => {
  resetRequests();
  const galleries: FixtureGallery[] = [
    { gid: '4100001', token: '1111111111', title: 'Japanese only', pages: 4, language: 'Japanese', date: '2026-11-01 00:00' },
    { gid: '4100002', token: '2222222222', title: 'Multilingual', pages: 5, language: 'Japanese', languages: ['Japanese', 'English'], date: '2026-11-01 00:00' },
    { gid: '4100003', token: '3333333333', title: 'English only', pages: 6, language: 'English', date: '2026-11-01 00:00' },
  ];
  let metadataAvailable = true;
  route = (hostname) => hostname === 'api.e-hentai.org'
    ? metadataAvailable
      ? { status: 200, contentType: 'application/json', body: gdataJson(galleries.map((g) => ({ ...g, uploadedTs: '1763278440' }))) }
      : { status: 503, body: 'Unavailable' }
    : { status: 200, body: listPageHtml(galleries, null) };
  const expectedEnglish = ['4100002-2222222222', '4100003-3333333333'];
  const results = await ehentaiProvider.search('foo', 25);
  assert.deepEqual(results.map((g) => g.galleryId), expectedEnglish);
  assert.ok(results.every((g) => g.language === 'English'));
  assert.deepEqual((await searchChunk('foo', null, 25)).items.map((g) => g.galleryId), expectedEnglish);

  for (const [query, opts] of [['foo', { language: 'Japanese' }], ['language:japanese foo', undefined]] as const) {
    const japanese = await ehentaiProvider.search(query, 25, undefined, opts);
    assert.deepEqual(japanese.map((g) => g.galleryId), ['4100001-1111111111', '4100002-2222222222']);
    assert.ok(japanese.every((g) => g.language === 'Japanese'));
  }
  assert.equal((await ehentaiProvider.search('foo', 25, undefined, { language: 'all' })).length, 3);

  metadataAvailable = false;
  const fallback = await ehentaiProvider.search('foo', 25);
  assert.deepEqual(fallback.map((g) => g.galleryId), expectedEnglish);
  assert.ok(fallback.every((g) => g.language === 'English'), 'list tags retain the English preference when metadata is unavailable');
});

test('native language filters and all-language searches do not acquire an English restriction', async () => {
  resetRequests();
  route = () => ({ status: 200, body: listPageHtml([], null) });
  await ehentaiProvider.search('language:japanese mana', 25);
  await ehentaiProvider.search('mana', 25, undefined, { language: 'all' });
  const queries = listRequests().map((r) => new URL(`https://exhentai.org${r.path}`).searchParams.get('f_search'));
  assert.deepEqual(queries, ['language:japanese mana', 'mana']);
});

test('artist queries quote names without changing existing phrases, exclusions, or language filters', async () => {
  resetRequests();
  route = () => ({ status: 200, body: listPageHtml([], null) });
  for (const query of ['artist:mana', 'artist:"mana"', 'a:mana', 'artist:"two words" -artist:other language:japanese', 'weak:artist:mana$', '"artist:mana"', '"an artist:mana reference"', '"a language:japanese phrase"']) {
    await ehentaiProvider.search(query, 25);
  }
  const queries = listRequests().map((r) => new URL(`https://exhentai.org${r.path}`).searchParams.get('f_search'));
  assert.deepEqual(queries, [
    'artist:"mana" language:english$',
    'artist:"mana" language:english$',
    'a:"mana" language:english$',
    'artist:"two words" -artist:"other" language:japanese',
    'weak:artist:"mana$" language:english$',
    '"artist:mana" language:english$',
    '"an artist:mana reference" language:english$',
    '"a language:japanese phrase" language:english$',
  ]);
});

test('unified E-Hentai queries preserve multi-word artists and group filters', () => {
  const parsed = parseCommonQuery('artist:"two words" group:"a circle" language:english');
  assert.ok(parsed.query);
  const compiled = compileEhentai(parsed.query!);
  assert.equal(compiled.query, 'artist:"two words$" group:"a circle$"');
  assert.equal(compiled.language, 'english');
  const excluded = parseCommonQuery('-artist:"two words" "artist:mana"');
  assert.equal(compileEhentai(excluded.query!).query, '-artist:"two words$" "artist:mana"');
  // A shared artist filter is an exact tag match: artist:"mana" must not also
  // match the E-Hentai artist tag "soguni mana".
  assert.equal(compileEhentai(parseCommonQuery('artist:"mana"').query!).query, 'artist:"mana$"');
  assert.equal(compileEhentai(parseCommonQuery('artist:mana -parody:fate').query!).query, 'artist:"mana$" -parody:"fate$"');
  assert.match(parseCommonQuery('unknown:"two words"').error!, /not available/);
});

test('a 50-result chunk splits metadata into batches of at most 25 entries', async () => {
  resetRequests();
  const galleries = Array.from({ length: 50 }, (_, i) => ({ gid: String(3100000 + i), token: i.toString(16).padStart(10, '0'), title: `Gallery ${i}`, pages: i + 1, language: 'english', date: '2026-11-01 00:00' }));
  route = (hostname, _path, _method, body) => {
    if (hostname === 'api.e-hentai.org') {
      const pairs: Array<[number, string]> = JSON.parse(body!).gidlist;
      assert.ok(pairs.length <= 25);
      return { status: 200, contentType: 'application/json', body: gdataJson(galleries.filter((g) => pairs.some(([gid, token]) => gid === Number(g.gid) && token === g.token)).map((g) => ({ ...g, language: 'english', uploadedTs: '1763278440' }))) };
    }
    return { status: 200, body: listPageHtml(galleries, null) };
  };
  const chunk = await searchChunk('batch', null, 50);
  assert.equal(chunk.items.length, 50);
  assert.equal(gdataRequests().length, 2);
  assert.ok(chunk.items.every((g) => g.language === 'english' && g.uploadedAt === new Date(1763278440 * 1000).toISOString()));
});

test('metadata outages preserve list results and foreign or changed-search continuations are never fetched', async () => {
  const gallery = { gid: '3200000', token: '1234567890', title: 'Fallback', pages: 9, language: 'english', date: '2026-11-01 00:00' };
  for (const nextUrl of [
    'https://attacker.example/?f_search=fallback%20language%3Aenglish%24&next=3200000',
    'https://exhentai.org/?f_search=different&next=3200000',
    'https://exhentai.org/account.php?f_search=fallback%20language%3Aenglish%24&next=3200000',
    'https://exhentai.org:8443/?f_search=fallback%20language%3Aenglish%24&next=3200000',
    'https://user:secret@exhentai.org/?f_search=fallback%20language%3Aenglish%24&next=3200000',
    'https://exhentai.org/?f_search=fallback%20language%3Aenglish%24&next=3200000#top',
  ]) {
    resetRequests();
    route = (hostname) => hostname === 'api.e-hentai.org'
      ? { status: 503, body: 'Unavailable' }
      : { status: 200, body: listPageHtml([gallery], nextUrl) };
    const chunk = await searchChunk('fallback', null, 25);
    assert.equal(chunk.items[0]?.title, 'Fallback');
    assert.equal(chunk.items[0]?.pageCount, 9);
    assert.equal(chunk.exhausted, true);
    assert.equal(chunk.nextCursor, null);
    assert.equal(listRequests().length, 1);
  }
});

test('a cursor from an older account revision is rejected after an account change', async () => {
  resetRequests();
  const page: FixtureGallery[] = [{ gid: '5555555', token: 'dddddddddd', title: 'Rev Gallery', pages: 3, language: 'English', date: '2026-11-15 12:34' }];
  const nextUrl = 'https://exhentai.org/?f_search=rev%20language%3Aenglish%24&next=5555555';
  route = (hostname) => {
    if (hostname === 'api.e-hentai.org') {
      return { status: 200, body: gdataJson([{ gid: '5555555', token: 'dddddddddd', language: 'English', pages: 3, uploadedTs: '1763278440' }]), contentType: 'application/json' };
    }
    return { status: 200, body: listPageHtml(page, nextUrl) };
  };
  const chunk = await searchChunk('rev', null, 5);
  assert.ok(chunk.nextCursor);

  // Save a new session: the revision changes and the old cursor dies.
  saveEhentaiAccount({ site: 'exhentai', session: { ...SESSION, ipb_pass_hash: '1111111111111111' }, expectedRevision: 1 });
  await assert.rejects(
    searchChunk('rev', chunk.nextCursor!, 5),
    (error: unknown) => error instanceof Error && /no longer valid/.test(error.message),
  );
});

// ---------------- getGallery ----------------

test('gallery metadata uses current IDs, canonical tag names, CSS covers, and sprite viewer links', () => {
  const parsed = parseEhentaiGalleryPage(galleryPageHtml('4334310', '35c596672d', ['1', '2']), 'https://exhentai.org/g/4334310/35c596672d/');
  assert.equal(parsed.title, 'Fixture Gallery');
  assert.equal(parsed.category, 'Doujinshi');
  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(parsed.artists, ['konboi'], 'display aliases do not become part of the canonical artist name');
  assert.deepEqual(parsed.pageRefs, ['https://exhentai.org/s/35c5966701/4334310-1', 'https://exhentai.org/s/35c5966702/4334310-2']);
  assert.equal(parsed.nextUrl, null);
});

test('viewer parsing selects the primary image and rejects navigation-only or quota pages', () => {
  const imageUrl = 'https://images.hath.network:10692/h/image.webp?key=abc&amp;page=1';
  assert.equal(parseEhentaiViewerImage(viewerPageHtml(imageUrl), 'https://exhentai.org/s/35c5966701/4334310-1'), 'https://images.hath.network:10692/h/image.webp?key=abc&page=1');
  for (const html of [
    '<img src="https://ehgt.org/g/navigation.jpg">',
    '<img id="img" src="https://ehgt.org/g/509.gif">',
    '<p>You have exceeded your image viewing limits.</p>',
    '<img id="img" src="http://images.hath.network/insecure.webp">',
  ]) assert.throws(() => parseEhentaiViewerImage(html, 'https://e-hentai.org/s/35c5966701/4334310-1'), /primary image|quota/);
});

test('getGallery parses the info page and exposes ordered lazy page refs', async () => {
  resetRequests();
  route = (_hostname, requestPath) => {
    if (requestPath.startsWith('/g/')) {
      return { status: 200, body: galleryPageHtml('6666666', 'eeeeeeeeee', ['1', '2', '3']) };
    }
    if (requestPath.startsWith('/s/')) {
      return { status: 200, body: viewerPageHtml('https://i1.hathost.com/file/abc123/image.png') };
    }
    return { status: 404, body: 'nope' };
  };

  const gallery = await ehentaiProvider.getGallery('https://exhentai.org/g/6666666/eeeeeeeeee/');
  assert.equal(gallery.source, 'ehentai');
  assert.equal(gallery.site, 'exhentai');
  assert.equal(gallery.galleryId, '6666666-eeeeeeeeee');
  assert.equal(gallery.title, 'Fixture Gallery');
  assert.equal(gallery.titleAlt, 'オリジナル・タイトル');
  assert.equal(gallery.series, 'some series');
  assert.equal(gallery.language, 'English');
  assert.equal(gallery.uploadedAt, '2026-11-15T12:34:00.000Z');
  assert.deepEqual(gallery.artists, ['konboi']);
  assert.deepEqual(gallery.groups, ['group a']);
  assert.deepEqual(gallery.tags, ['konboi', 'group a', 'some series', 'big breasts']);
  assert.deepEqual(gallery.tagNamespaces, ['artist', 'group', 'parody', 'female']);
  assert.equal(gallery.pageCount, 3);
  assert.deepEqual(gallery.pages, [
    'https://exhentai.org/s/eeeeeeee01/6666666-1',
    'https://exhentai.org/s/eeeeeeee02/6666666-2',
    'https://exhentai.org/s/eeeeeeee03/6666666-3',
  ]);
  assert.equal(gallery.coverUrl, 'https://ehgt.org/w/cover.webp');
  assert.ok(gallery.resolvePageUrl, 'lazy resolution must be exposed');

  const resolved = await gallery.resolvePageUrl!(1);
  assert.equal(resolved?.url, 'https://i1.hathost.com/file/abc123/image.png');
  // The viewer page was fetched only for the one requested page.
  const viewerFetches = requests.filter((r) => r.hostname === 'exhentai.org' && r.path.startsWith('/s/'));
  assert.equal(viewerFetches.length, 1);

  // A bare gid-token is also accepted.
  const byId = await ehentaiProvider.getGallery('6666666-eeeeeeeeee');
  assert.equal(byId.galleryId, '6666666-eeeeeeeeee');
});

test('getGallery follows thumbnail pagination and includes every image without fetching viewer pages', async () => {
  resetRequests();
  const url = 'https://exhentai.org/g/6666667/eeeeeeeeef/';
  route = (_hostname, requestPath) => {
    const p = new URL(`https://exhentai.org${requestPath}`).searchParams.get('p');
    const numbers = p === null ? ['1', '2'] : p === '1' ? ['3', '4'] : ['5'];
    const next = p === '2' ? null : `${url}?p=${p === null ? 1 : 2}`;
    return { status: 200, body: galleryPageHtml('6666667', 'eeeeeeeeef', numbers, 5, next) };
  };
  const gallery = await ehentaiProvider.getGallery(url);
  assert.equal(gallery.pageCount, 5);
  assert.deepEqual(gallery.pages.map((p) => Number(p.split('-').at(-1))), [1, 2, 3, 4, 5]);
  assert.deepEqual(requests.map((r) => r.path), ['/g/6666667/eeeeeeeeef/', '/g/6666667/eeeeeeeeef/?p=1', '/g/6666667/eeeeeeeeef/?p=2']);
});

test('getGallery rejects truncated lists and unsafe thumbnail continuations before fetching them', async () => {
  const url = 'https://exhentai.org/g/6666667/eeeeeeeeef/';
  for (const next of [null, 'https://attacker.example/g/6666667/eeeeeeeeef/?p=1', `${url}?p=2`, `${url}?p=0`, 'https://exhentai.org/g/6666668/eeeeeeeeef/?p=1']) {
    resetRequests();
    route = () => ({ status: 200, body: galleryPageHtml('6666667', 'eeeeeeeeef', ['1', '2'], 3, next) });
    await assert.rejects(ehentaiProvider.getGallery(url), /incomplete|continuation/);
    assert.equal(requests.length, 1);
  }
});

test('getGallery rejects gaps and image references from a different gallery', async () => {
  for (const body of [galleryPageHtml('6666667', 'eeeeeeeeef', ['1', '3'], 3), galleryPageHtml('6666668', 'eeeeeeeeef', ['1', '2'])]) {
    route = () => ({ status: 200, body });
    await assert.rejects(ehentaiProvider.getGallery('6666667-eeeeeeeeef'), /incomplete or out of order/);
  }
});

test('getGallery refuses an incomplete or repeated image list as complete', async () => {
  resetRequests();
  route = (_hostname, requestPath) => {
    if (requestPath.startsWith('/g/')) {
      return { status: 200, body: galleryPageHtml('7777777', 'ffffffffffff', ['1', '2', '2']) };
    }
    return { status: 404, body: 'nope' };
  };
  await assert.rejects(
    ehentaiProvider.getGallery('7777777-ffffffffffff'),
    (error: unknown) => error instanceof Error && /incomplete or out of order/.test(error.message),
  );
});

test('getGallery reports unavailable galleries without substituting another revision', async () => {
  resetRequests();
  route = () => ({ status: 404, body: '<html><body>Not found</body></html>' });
  await assert.rejects(
    ehentaiProvider.getGallery('9999999-000000000000'),
    (error: unknown) => error instanceof Error && /unavailable or was removed/.test(error.message),
  );
});
