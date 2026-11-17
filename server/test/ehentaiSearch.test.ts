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
const { ehentaiProvider } = await import('../src/downloader/ehentai.js');
const { parseEhentaiGdata, gdataNumber } = await import('../src/downloader/ehentaiXml.js');

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
const requests: Array<{ hostname: string; path: string; method: string; body: string | null }> = [];

const realRequest = https.request;
const realLookup = dns.lookup;

interface FakeSocketEvents {
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
}

function fakeRequest(options: { servername?: string; path?: string; method?: string }, onResponse: (res: { statusCode: number; headers: Record<string, string>; resume(): void } & FakeSocketEvents) => void): unknown {
  const reqEvents = new EventEmitter();
  const req = {
    end(body?: string): unknown {
      const hostname = options.servername ?? '';
      const requestPath = options.path ?? '/';
      const method = options.method ?? 'GET';
      const formBody = method === 'POST' && body ? body : null;
      requests.push({ hostname, path: requestPath, method, body: formBody });
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
  date: string;
}

function listPageHtml(galleries: FixtureGallery[], nextUrl: string | null): string {
  const rows = galleries.map((g) => `
<table class="glt">
<tr>
<td class="glleft glclearfix"><a href="https://exhentai.org/g/${g.gid}/${g.token}/" class="glth" title=""><img alt="" src="https://t2.e-hentai.org/x/${g.gid}.jpg"></a></td>
<td class="gl3 glname"><span class="gdt_title"><a href="https://exhentai.org/g/${g.gid}/${g.token}/">${g.title}</a></span></td>
<td class="gl2">5.00</td><td class="gl2">Doujinshi</td><td class="gl2">${g.pages}</td><td class="gl2">${g.language}</td><td class="gl2">${g.date}</td>
</tr>
</table>`).join('\n');
  const pagination = nextUrl
    ? `<div class="pc"><span class="pi">1</span> <a class="pn" href="${nextUrl}">Next</a></div>`
    : '<div class="pc"><span class="pi">1</span></div>';
  return `<html><body><form name="s1"><input name="f_search"></form>${rows}${pagination}</body></html>`;
}

function gdataXml(entries: Array<{ token: string; language: string; pages: number; uploadedTs: string; artist?: string; error?: string }>): string {
  const blocks = entries.map((e) => {
    if (e.error) return `<g><error>${e.error}</error></g>`;
    return `<g><f t="token">${e.token}</f><f t="file_count">${e.pages}</f><f t="category">Doujinshi</f><f t="language">${e.language}</f><f t="uploaded_ts">${e.uploadedTs}</f><f t="pages">${e.pages}</f>${e.artist ? `<t t="artist">${e.artist}</t>` : ''}</g>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gmetadata>${blocks}</gmetadata>`;
}

function galleryPageHtml(gid: string, token: string, pageNumbers: string[]): string {
  const rows = pageNumbers.map((n) => `<tr><td class="gdt_thumb"><a href="https://exhentai.org/s/${token}/${gid}-${token}/${n}.jpg" target="_blank"><img src="https://t2.e-hentai.org/x/${gid}-${n}.jpg"></a></td></tr>`).join('');
  return `
<html><body>
<span class="gcname">Fixture Gallery</span> <span class="gdt_namealt"> (オリジナル・タイトル)</span>
<span class="gcpar"><a href="https://exhentai.org/?f_parody=some-series">Some Series</a></span>
<table class="gt1">
<tr><th>Uploader:</th><td>someone</td></tr>
<tr><th>Uploaded:</th><td>2026-11-15 12:34 -0500</td></tr>
<tr><th>Language:</th><td>English</td></tr>
<tr><th>Category:</th><td>Doujinshi</td></tr>
</table>
<table class="itgns">
<tr><td class="itg"><a href="https://exhentai.org/?f_search=&amp;f_artist=konboi">konboi</a></td>
<td class="itg"><a href="https://exhentai.org/?f_search=&amp;f_group=group+a">group a</a></td>
<td class="itg"><a href="https://exhentai.org/?f_search=&amp;f_female=big+breasts">big breasts</a></td>
</tr>
</table>
<table id="gdthumb">${rows}</table>
</body></html>`;
}

function viewerPageHtml(imageUrl: string): string {
  return `<html><body><div id="img_holder"><img id="image" src="${imageUrl}"></div></body></html>`;
}

const listRequests = (): Array<{ path: string }> => requests.filter((r) => r.hostname === 'exhentai.org' && r.path.startsWith('/?f_search='));
const gdataRequests = (): Array<{ body: string | null }> => requests.filter((r) => r.hostname === 'api.e-hentai.org');
const resetRequests = (): void => { requests.length = 0; };

// ---------------- gdata XML parser ----------------

test('parseEhentaiGdata handles many entries, per-item errors, and entities', () => {
  const entries: Array<{ token: string; language: string; pages: number; uploadedTs: string; artist?: string; error?: string }> = [];
  for (let i = 1; i <= 30; i++) {
    const token = String(i).padStart(12, '0');
    entries.push({ token, language: 'English', pages: i, uploadedTs: String(1763278440 + i), artist: i === 3 ? 'Kon & "Boi"' : undefined });
  }
  entries[5] = { token: 'eeeeeeeeeeee', language: '', pages: 0, uploadedTs: '0', error: '1005: Gallery is unavailable or restricted' };
  const parsed = parseEhentaiGdata(gdataXml(entries));
  assert.ok(parsed, 'document must parse');
  assert.equal(parsed!.length, 30);
  assert.equal(parsed![5].error, '1005: Gallery is unavailable or restricted');
  assert.equal(parsed![2].tags[0].value, 'Kon & "Boi"');
  assert.equal(gdataNumber(parsed![1], 'pages'), 2);
  assert.equal(gdataNumber(parsed![1], 'missing'), null);
  assert.equal(parseEhentaiGdata('<html>not xml</html>'), null);
  assert.equal(parseEhentaiGdata('<gmetadata><g><f t="token">abc</f></gmetadata>'), null, 'unterminated document is not an empty result');
});

// ---------------- native search ----------------

test('search hydrates list results through one gdata batch and applies bans', async () => {
  resetRequests();
  setDownloaderSettings({ ...getDownloaderSettings(), ehentaiBannedTags: ['artist:konboi'] });

  const galleries: FixtureGallery[] = [
    { gid: '1111111', token: 'aaaaaaaaaaaa', title: 'Banned Artist Gallery', pages: 12, language: 'English', date: '2026-11-15 12:34 -0500' },
    { gid: '2222222', token: 'bbbbbbbbbbbb', title: 'Kept Gallery', pages: 8, language: 'English', date: '2026-11-14 09:00 +0900' },
  ];
  const nextUrl = 'https://exhentai.org/?f_search=foo%20-artist%3Akonboi&f_lang=3';
  route = (hostname, requestPath) => {
    if (hostname === 'api.e-hentai.org') {
      return { status: 200, body: gdataXml([
        { token: 'aaaaaaaaaaaa', language: 'Japanese', pages: 12, uploadedTs: '1763278440', artist: 'konboi' },
        { token: 'bbbbbbbbbbbb', language: 'Japanese', pages: 8, uploadedTs: '1763100000', artist: 'Other Artist' },
      ]), contentType: 'application/xml' };
    }
    return { status: 200, body: listPageHtml(galleries, nextUrl) };
  };

  const results = await ehentaiProvider.search('foo', 25);
  // The ban must be compiled into the site's own query syntax.
  const searchPath = listRequests()[0]?.path;
  assert.ok(searchPath, 'a search request must be made');
  const searchParams = new URL(`https://exhentai.org${searchPath}`).searchParams;
  assert.equal(searchParams.get('f_search'), 'foo -artist:konboi');
  assert.equal(searchParams.get('f_lang'), '3', 'default language is English (site id 3)');
  // One gdata batch for the chunk.
  assert.equal(gdataRequests().length, 1);
  assert.ok(gdataRequests()[0].body?.includes('namespace=1'));
  // The banned artist's gallery is excluded; the kept one is hydrated.
  assert.deepEqual(results.map((r) => r.galleryId), ['2222222-bbbbbbbbbbbb']);
  assert.equal(results[0].language, 'Japanese', 'gdata language outranks the list cell');
  assert.equal(results[0].pageCount, 8);
  assert.deepEqual(results[0].artists, ['Other Artist']);
  assert.equal(results[0].site, 'exhentai');
  assert.equal(results[0].uploadedAt, new Date(1763100000 * 1000).toISOString());
});

test('search returns an empty list (not a parse error) on a zero-result page', async () => {
  resetRequests();
  setDownloaderSettings({ ...getDownloaderSettings(), ehentaiBannedTags: [] });
  route = () => ({ status: 200, body: '<html><body><form name="s1"><input name="f_search"></form><p>No matches were found.</p></body></html>' });

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
    token: (i + 1).toString(16).padStart(12, '0'),
    title: `Gallery ${i + 1}`,
    pages: i + 1,
    language: 'English',
    date: '2026-11-01 00:00 +0000',
  }));
  const page2: FixtureGallery[] = Array.from({ length: 3 }, (_, i) => ({
    gid: String(3000031 + i),
    token: `ffffffff00${(i + 1).toString(16).padStart(2, '0')}`,
    title: `Gallery ${31 + i}`,
    pages: i + 1,
    language: 'English',
    date: '2026-10-01 00:00 +0000',
  }));
  const nextUrl = 'https://exhentai.org/?f_search=bar&f_lang=3&page=2';
  const gdataFor = (items: FixtureGallery[]): string => gdataXml(items.map((g) => ({ token: g.token, language: 'Japanese', pages: g.pages, uploadedTs: '1763278440' })));
  const allFixtures = [...page1, ...page2];
  route = (hostname, requestPath, method, formBody) => {
    if (hostname === 'api.e-hentai.org') {
      const tokens = new URLSearchParams(formBody ?? '').getAll('tok[]');
      return { status: 200, body: gdataFor(allFixtures.filter((g) => tokens.includes(g.token))), contentType: 'application/xml' };
    }
    if (requestPath.includes('page=2')) return { status: 200, body: listPageHtml(page2, null) };
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

  const all = [...chunk1.items, ...chunk2.items, ...chunk3.items];
  assert.equal(new Set(all.map((r) => r.galleryId)).size, 33, 'no duplicates, no dropped galleries');
});

test('a per-item gdata error keeps the list-page result instead of dropping it', async () => {
  resetRequests();
  const galleries: FixtureGallery[] = [
    { gid: '4444444', token: 'cccccccccccc', title: 'Broken Metadata', pages: 5, language: 'English', date: '2026-11-15 12:34 -0500' },
  ];
  route = (hostname) => {
    if (hostname === 'api.e-hentai.org') {
      return { status: 200, body: gdataXml([{ token: 'cccccccccccc', language: '', pages: 0, uploadedTs: '0', error: '1005: Gallery is unavailable or restricted' }]), contentType: 'application/xml' };
    }
    return { status: 200, body: listPageHtml(galleries, null) };
  };
  const results = await ehentaiProvider.search('foo', 25);
  assert.deepEqual(results.map((r) => r.galleryId), ['4444444-cccccccccccc']);
  assert.equal(results[0].language, 'English', 'falls back to the list cell when gdata failed for the item');
  assert.equal(results[0].pageCount, 5);
});

test('an explicit supported language overrides the English default', async () => {
  resetRequests();
  route = () => ({ status: 200, body: listPageHtml([], null) });
  await ehentaiProvider.search('foo', 25, undefined, { language: 'Japanese' });
  const searchPath = listRequests()[0]?.path;
  assert.ok(searchPath);
  const params = new URL(`https://exhentai.org${searchPath}`).searchParams;
  assert.equal(params.get('f_lang'), '2', 'Japanese is E-Hentai language id 2');
});

test('a cursor from an older account revision is rejected after an account change', async () => {
  resetRequests();
  const page: FixtureGallery[] = [{ gid: '5555555', token: 'dddddddddddd', title: 'Rev Gallery', pages: 3, language: 'English', date: '2026-11-15 12:34 -0500' }];
  const nextUrl = 'https://exhentai.org/?f_search=rev&f_lang=3&page=2';
  route = (hostname) => {
    if (hostname === 'api.e-hentai.org') {
      return { status: 200, body: gdataXml([{ token: 'dddddddddddd', language: 'English', pages: 3, uploadedTs: '1763278440' }]), contentType: 'application/xml' };
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

test('getGallery parses the info page and exposes ordered lazy page refs', async () => {
  resetRequests();
  route = (hostname, requestPath) => {
    if (requestPath.startsWith('/g/')) {
      return { status: 200, body: galleryPageHtml('6666666', 'eeeeeeeeeeee', ['1', '2', '3']) };
    }
    if (requestPath.startsWith('/s/')) {
      return { status: 200, body: viewerPageHtml('https://i1.hathost.com/file/abc123/image.png') };
    }
    return { status: 404, body: 'nope' };
  };

  const gallery = await ehentaiProvider.getGallery('https://exhentai.org/g/6666666/eeeeeeeeeeee/');
  assert.equal(gallery.source, 'ehentai');
  assert.equal(gallery.site, 'exhentai');
  assert.equal(gallery.galleryId, '6666666-eeeeeeeeeeee');
  assert.equal(gallery.title, 'Fixture Gallery');
  assert.equal(gallery.titleAlt, 'オリジナル・タイトル');
  assert.equal(gallery.series, 'Some Series');
  assert.equal(gallery.language, 'English');
  assert.equal(gallery.uploadedAt, '2026-11-15T17:34:00.000Z');
  assert.deepEqual(gallery.artists, ['konboi']);
  assert.deepEqual(gallery.groups, ['group a']);
  assert.deepEqual(gallery.tags, ['konboi', 'group a', 'big breasts']);
  assert.deepEqual(gallery.tagNamespaces, ['artist', 'group', 'female']);
  assert.equal(gallery.pageCount, 3);
  assert.deepEqual(gallery.pages, [
    'https://exhentai.org/s/eeeeeeeeeeee/6666666-eeeeeeeeeeee/1.jpg',
    'https://exhentai.org/s/eeeeeeeeeeee/6666666-eeeeeeeeeeee/2.jpg',
    'https://exhentai.org/s/eeeeeeeeeeee/6666666-eeeeeeeeeeee/3.jpg',
  ]);
  assert.ok(gallery.coverUrl?.includes('t2.e-hentai.org'));
  assert.ok(gallery.resolvePageUrl, 'lazy resolution must be exposed');

  const resolved = await gallery.resolvePageUrl!(1);
  assert.equal(resolved?.url, 'https://i1.hathost.com/file/abc123/image.png');
  // The viewer page was fetched only for the one requested page.
  const viewerFetches = requests.filter((r) => r.hostname === 'exhentai.org' && r.path.startsWith('/s/'));
  assert.equal(viewerFetches.length, 1);

  // A bare gid-token is also accepted.
  const byId = await ehentaiProvider.getGallery('6666666-eeeeeeeeeeee');
  assert.equal(byId.galleryId, '6666666-eeeeeeeeeeee');
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
