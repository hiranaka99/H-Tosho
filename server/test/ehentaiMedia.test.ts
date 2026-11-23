import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-ehentai-media-'));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb } = await import('../src/db/index.js');
const { getDownloaderSettings, setDownloaderSettings } = await import('../src/services/settings.js');
const { saveEhentaiAccount } = await import('../src/services/ehentaiAccount.js');
const { resetEhentaiGate } = await import('../src/downloader/ehentaiGate.js');
const { mediaRouter, mediaProxyUrl } = await import('../src/routes/media.js');
const { resolvePageCandidates } = await import('../src/downloader/requests.js');
const { downloadPages } = await import('../src/downloader/transfer.js');
const { ehentaiProvider } = await import('../src/downloader/ehentai.js');
const { EhentaiUpstreamError } = await import('../src/downloader/ehentaiClient.js');
import type { DoujinGallery } from '../src/downloader/types.js';

initDb();

// ---------------- fake family transport (viewer lane) ----------------
//
// The E-Hentai client pins IPs via dns.lookup and connects over node:https
// directly, so the fixture routes by (servername, path) through a patched
// https.request. Cover traffic uses the generic lane (global fetch), stubbed
// separately.

type FakeResponse = { status: number; body: Buffer | string; contentType?: string; location?: string };
type Router = (hostname: string, pathAndQuery: string, method: string, headers: Record<string, unknown>) => FakeResponse;

let route: Router = () => ({ status: 404, body: 'no route' });
const requests: Array<{ hostname: string; path: string; port: number; headers: Record<string, unknown> }> = [];

const realRequest = https.request;
const realLookup = dns.lookup;
const realFetch = globalThis.fetch;

function fakeRequest(options: { servername?: string; path?: string; method?: string; port?: number; headers?: Record<string, unknown> }, onResponse: (res: { statusCode: number; headers: Record<string, string>; resume(): void; on(event: 'data' | 'end' | 'error', cb: (chunk?: Buffer, error?: Error) => void): unknown; [Symbol.asyncIterator](): AsyncIterator<Buffer> }) => void): unknown {
  const reqEvents = new EventEmitter();
  const req = {
    end(_body?: string): unknown {
      const hostname = options.servername ?? '';
      const requestPath = options.path ?? '/';
      const headers = options.headers ?? {};
      requests.push({ hostname, path: requestPath, port: options.port ?? 443, headers });
      let response: FakeResponse;
      try {
        response = route(hostname, requestPath, options.method ?? 'GET', headers as Record<string, unknown>);
      } catch (error) {
        process.nextTick(() => reqEvents.emit('error', error));
        return req;
      }
      process.nextTick(() => {
        const resEvents = new EventEmitter();
        const buf = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, 'utf8');
        onResponse({
          statusCode: response.status,
          headers: { 'content-type': response.contentType ?? 'text/html; charset=utf-8', 'content-length': String(buf.length), ...(response.location ? { location: response.location } : {}) },
          on: (event, cb) => resEvents.on(event, cb),
          resume: () => { /* fixture: body delivered in one chunk */ },
          [Symbol.asyncIterator]: async function* () {
            yield buf;
          },
        });
        resEvents.emit('data', buf);
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
  _opts: unknown,
  callback: (error: null, addresses: { address: string; family: number }[]) => void,
) => {
  callback(null, [{ address: '93.184.216.34', family: 4 }]);
};

after(() => {
  (https as unknown as { request: unknown }).request = realRequest;
  (dns as unknown as { lookup: unknown }).lookup = realLookup;
  globalThis.fetch = realFetch;
  // The data dir is left in place: Windows locks the open SQLite file.
});

// ---------------- fixtures ----------------

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(4096, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 2)]);
const HTML_PAGE = Buffer.from('<html><body>quota</body></html>');

const viewerHtml = (imageUrl: string | null): string =>
  `<html><body><div id="i2"><img src="https://ehgt.org/g/p.jpg"></div><div id="i3">${imageUrl ? `<img id="img" src="${imageUrl}">` : '<span>quota exceeded</span>'}</div></body></html>`;

const viewerPath = (gid: string, token: string, n: number): string => `/s/${token}/${gid}-${n}`;

resetEhentaiGate({ html: { minGapMs: 1, maxConcurrent: 4 }, api: { minGapMs: 1, maxConcurrent: 4 }, image: { minGapMs: 1, maxConcurrent: 4 } });
const router = mediaRouter();
const mediaGet = (url: string) => router.request(mediaProxyUrl(url), { method: 'GET' });

// ---------------- viewer preview lane ----------------

test('viewer ref resolves lazily to the H@H image with session cookie only on the family host', async () => {
  const account = saveEhentaiAccount({ site: 'exhentai', session: { ipb_member_id: '77', ipb_pass_hash: 'hashhash', igneous: 'ign' }, expectedRevision: 0 });
  assert.ok(account.revision >= 1);
  requests.length = 0;
  const gid = '3300001';
  const token = '0a0b0c0d0e';
  const viewerUrl = `https://exhentai.org${viewerPath(gid, token, 1)}`;
  route = (hostname, reqPath) => {
    if (hostname === 'exhentai.org' && reqPath.startsWith('/s/')) return { status: 200, body: viewerHtml(`https://i1.hathost.com/file/${token}.jpg`) };
    if (hostname === 'i1.hathost.com') return { status: 200, body: JPEG, contentType: 'image/jpeg' };
    return { status: 404, body: 'no route' };
  };

  const res = await mediaGet(viewerUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);

  const viewer = requests.find((r) => r.hostname === 'exhentai.org');
  assert.ok(viewer, 'the viewer page must be fetched through the family host');
  assert.ok(String(viewer.headers.Cookie ?? '').includes('ipb_member_id=77'), 'the stored session goes to the family host');
  assert.ok(String(viewer.headers.Referer ?? '').startsWith('https://exhentai.org/'));

  const image = requests.find((r) => r.hostname === 'i1.hathost.com');
  assert.ok(image, 'the image host must be fetched');
  assert.equal(image.headers.Cookie, undefined, 'no cookies may reach the image host');
  assert.equal(image.headers.Referer, viewerUrl, 'the viewer page is the Referer for image fetches');
});

test('a viewer page without an image (quota/error) is not published as an image', async () => {
  requests.length = 0;
  const viewerUrl = `https://e-hentai.org${viewerPath('3300002', '1a1b1c1d1e', 3)}`;
  route = (hostname) => {
    if (hostname === 'e-hentai.org') return { status: 200, body: viewerHtml(null) };
    return { status: 404, body: 'no route' };
  };
  const res = await mediaGet(viewerUrl);
  assert.equal(res.status, 502);
  assert.equal(requests.filter((r) => r.hostname !== 'e-hentai.org').length, 0, 'no image fetch may follow a quota page');
});

test('public-site previews use the viewer origin and only its approved H@H port', async () => {
  requests.length = 0;
  const viewerUrl = 'https://e-hentai.org/s/390551b182/4334310-1';
  route = (hostname) => hostname === 'e-hentai.org'
    ? { status: 200, body: viewerHtml('https://images.hath.network:10692/h/preview.webp') }
    : { status: 200, body: PNG, contentType: 'image/png' };
  const res = await mediaGet(viewerUrl);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal(requests[0].hostname, 'e-hentai.org', 'the saved ExHentai setting does not replace the viewer origin');
  assert.ok(String(requests[0].headers.Cookie).includes('ipb_member_id=77'));
  assert.ok(!String(requests[0].headers.Cookie).includes('igneous'));
  const image = requests.find((r) => r.hostname === 'images.hath.network')!;
  assert.equal(image.port, 10692);
  assert.equal(image.headers.Host, 'images.hath.network:10692');
  assert.equal(image.headers.Cookie, undefined);
});

test('image redirects cannot change the approved H@H port', async () => {
  requests.length = 0;
  route = (hostname) => hostname === 'exhentai.org'
    ? { status: 200, body: viewerHtml('https://images.hath.network:10692/h/redirect.webp') }
    : { status: 302, body: '', location: 'https://images.hath.network:444/h/redirect.webp' };
  const res = await mediaGet('https://exhentai.org/s/390551b183/4334310-2');
  assert.equal(res.status, 502);
  assert.equal(requests.filter((r) => r.hostname === 'images.hath.network').length, 1);
});

// ---------------- cover lane ----------------

test('E-Hentai covers are fetched with the family Referer and validated by bytes', async () => {
  const coverUrl = 'https://ehgt.org/w/02/805/22654-rf0vixom.webp';
  const seen: { headers: Record<string, string> | null } = { headers: null };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.headers = { ...(init?.headers as Record<string, string>) };
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;

  const ok = await mediaGet(coverUrl);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), JPEG);
  assert.equal(seen.headers?.Referer, 'https://e-hentai.org/', 'covers need the family Referer');

  // Quota HTML with an image content type must be rejected on the bytes.
  globalThis.fetch = (async () => new Response(HTML_PAGE, { status: 200, headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
  const denied = await mediaGet('https://t2.e-hentai.org/g/3300003/2a2b2c2d2e2f-2.jpg');
  assert.equal(denied.status, 502, 'non-image bytes are never published as a cover');
});

// ---------------- SSRF surface ----------------

test('non-allowlisted and non-viewer family targets are rejected', async () => {
  for (const url of ['http://e-hentai.org/s/390551b182/4334310-1', 'https://user:pass@e-hentai.org/s/390551b182/4334310-1', 'https://e-hentai.org:444/s/390551b182/4334310-1', 'https://e-hentai.org/s/390551b182/4334310-1?x=1', 'https://e-hentai.org/s/390551b182/4334310-0']) {
    assert.equal((await mediaGet(url)).status, 400, url);
  }
  assert.equal((await mediaGet('https://ehgt.org.attacker.example/x.jpg')).status, 400);
  assert.equal((await mediaGet('http://127.0.0.1:3000/x.jpg')).status, 400);
  assert.equal((await mediaGet('https://e-hentai.org/account.php')).status, 400);
  assert.equal((await mediaGet('https://exhentai.org/g/3300004/3a3b3c3d3e3f/')).status, 400);
  assert.equal((await mediaGet('https://exhentai.org/s/not-a-token/1-2/1.jpg')).status, 400);
  assert.equal((await mediaGet('https://attacker.example/s/0a0b0c0d0e0f/1-0a0b0c0d0e0f/1.jpg')).status, 400);
});

// ---------------- strict resolver + resume naming ----------------

test('strict resolvers fail the page instead of falling back to the viewer URL', async () => {
  const strict = {
    pages: [viewerPath('4400001', '4a4b4c4d4e4f', 1).replace(/^/, 'https://exhentai.org')],
    resolvePageUrl: async () => {
      throw new Error('E-Hentai returned HTTP 429.');
    },
    strictPageResolver: true,
  } as unknown as DoujinGallery;
  await assert.rejects(resolvePageCandidates(strict, 0), /429/);

  const strictNull = {
    pages: ['https://exhentai.org/s/4a4b4c4d4e4f/4400001-4a4b4c4d4e4f/2.jpg'],
    resolvePageUrl: async () => null,
    strictPageResolver: true,
  } as unknown as DoujinGallery;
  await assert.rejects(resolvePageCandidates(strictNull, 0));

  // Non-strict providers keep the existing static-URL fallback.
  const loose = {
    pages: ['https://cdn.test/x.jpg'],
    resolvePageUrl: async () => null,
  } as unknown as DoujinGallery;
  assert.deepEqual(await resolvePageCandidates(loose, 0), ['https://cdn.test/x.jpg']);
});

test('resumed runs reuse the persisted real names instead of the static URL extensions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-transfer-'));
  fs.writeFileSync(path.join(tmpDir, '0'), JPEG);
  fs.writeFileSync(path.join(tmpDir, '1'), JPEG);
  // The sidecar intentionally disagrees with the static .jpg extension: the
  // H@H images were PNGs, and resume must keep the real names.
  fs.writeFileSync(path.join(tmpDir, 'page-names.json'), JSON.stringify({ 0: '01.png', 1: '02.png' }));

  const gallery = {
    source: 'hitomi',
    galleryId: 'resume-test',
    title: 'Resume Test',
    pages: ['https://cdn.test/a/0.jpg', 'https://cdn.test/a/1.jpg', 'https://cdn.test/a/2.png'],
  } as unknown as DoujinGallery;

  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (!url.includes('2.png')) throw new Error(`unexpected fetch ${url}`);
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  }) as typeof fetch;

  const ctx = {
    cancelled: false,
    stopped: false,
    committing: false,
    controller: new AbortController(),
    pauseSignal: { paused: false, waiters: [] },
  };
  const settings = { ...getDownloaderSettings(), maxImageConcurrency: 2, requestDelayMs: 0 };
  setDownloaderSettings(settings);

  const out = await downloadPages(gallery, 9999, settings, ctx, tmpDir, () => { /* no progress sink */ });
  assert.deepEqual(out.map((p) => p.name), ['01.png', '02.png', '03.png']);
  // The sidecar now records the third page's real name too.
  const names = JSON.parse(fs.readFileSync(path.join(tmpDir, 'page-names.json'), 'utf8')) as Record<string, string>;
  assert.equal(names['2'], '03.png');
});

// ---------------- E-Hentai secure downloadPage pipeline ----------------

const galleryHtml = (gid: string, refs: Array<{ token: string; page: number }>): string => `
<html><body>
  <h1 id="gn">E-Hentai Pipeline Test</h1>
  <div id="gdd"><table>
    <tr><td class="gdt1">Language:</td><td class="gdt2">English</td></tr>
    <tr><td class="gdt1">Length:</td><td class="gdt2">${refs.length} pages</td></tr>
  </table></div>
  <div id="gdt">${refs.map((r) => `<a href="https://exhentai.org/s/${r.token}/${gid}-${r.page}">p${r.page}</a>`).join('')}</div>
</body></html>`;

test('E-Hentai downloads use pinned H@H transport with per-page approval isolation, real extensions, and ?nl= node switch', async () => {
  requests.length = 0;
  const gid = '5500001';
  const gToken = 'a1b2c3d4e5';
  const p1Token = '1111111111';
  const p2Token = '2222222222';
  let switched = false;

  route = (hostname, reqPath) => {
    if (hostname === 'exhentai.org' && reqPath === `/g/${gid}/${gToken}/`) {
      return { status: 200, body: galleryHtml(gid, [{ token: p1Token, page: 1 }, { token: p2Token, page: 2 }]) };
    }
    if (hostname === 'exhentai.org' && reqPath === `/s/${p1Token}/${gid}-1`) {
      return {
        status: 200,
        body: `<html><body><div id="i3"><img id="img" src="https://node1.hath.network:10101/h/p1.jpg"></div><a onclick="return nl('reload-tok-1')">reload</a></body></html>`,
      };
    }
    if (hostname === 'exhentai.org' && reqPath === `/s/${p1Token}/${gid}-1?nl=reload-tok-1`) {
      switched = true;
      return {
        status: 200,
        body: `<html><body><div id="i3"><img id="img" src="https://node3.hath.network:10303/h/p1-fresh.jpg"></div></body></html>`,
      };
    }
    if (hostname === 'exhentai.org' && reqPath === `/s/${p2Token}/${gid}-2`) {
      return {
        status: 200,
        body: `<html><body><div id="i3"><img id="img" src="https://node2.hath.network:10202/h/p2.jpg"></div></body></html>`,
      };
    }
    // Page 1 initially fails 404 on node1 -> forces ?nl=reload-tok-1 -> succeeds on node3 as PNG bytes despite .jpg URL!
    if (hostname === 'node1.hath.network') return { status: 404, body: 'missing' };
    if (hostname === 'node3.hath.network') return { status: 200, body: PNG, contentType: 'image/png' };
    if (hostname === 'node2.hath.network') return { status: 200, body: JPEG, contentType: 'image/jpeg' };
    return { status: 404, body: 'no route' };
  };

  // Ensure generic globalThis.fetch is NEVER used for E-Hentai pages!
  globalThis.fetch = (async () => {
    throw new Error('E-Hentai download must not bypass pinned client via globalThis.fetch');
  }) as typeof fetch;

  const gallery = await ehentaiProvider.getGallery(`https://exhentai.org/g/${gid}/${gToken}/`);
  assert.equal(typeof gallery.downloadPage, 'function');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-eh-dl-'));
  const ctx = {
    cancelled: false,
    stopped: false,
    committing: false,
    controller: new AbortController(),
    pauseSignal: { paused: false, waiters: [] },
  };
  const settings = { ...getDownloaderSettings(), maxImageConcurrency: 2, requestDelayMs: 0 };
  const t0 = Date.now();
  const out = await downloadPages(gallery, 8801, settings, ctx, tmpDir, () => {});
  assert.ok(Date.now() - t0 < 2000, 'H@H 404 ?nl= node switch should retry promptly');
  assert.equal(switched, true, 'page 1 must reload viewer with ?nl= token');
  assert.deepEqual(out.map((p) => p.name), ['01.png', '02.jpg'], 'real magic-byte extension must win over .jpg URL');

  const node3Req = requests.find((r) => r.hostname === 'node3.hath.network')!;
  const node2Req = requests.find((r) => r.hostname === 'node2.hath.network')!;
  assert.equal(node3Req.headers.Cookie, undefined, 'no cookies on H@H node');
  assert.equal(node2Req.headers.Cookie, undefined, 'no cookies on H@H node');
  assert.equal(node3Req.headers.Referer, `https://exhentai.org/s/${p1Token}/${gid}-1?nl=reload-tok-1`);
  assert.equal(node2Req.headers.Referer, `https://exhentai.org/s/${p2Token}/${gid}-2`);

  const sidecar = JSON.parse(fs.readFileSync(path.join(tmpDir, 'page-names.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(sidecar, { '0': '01.png', '1': '02.jpg' });
});

test('E-Hentai download rejects corrupt/HTML H@H body before atomic rename and fails immediately on HTTP 509 quota', async () => {
  requests.length = 0;
  const gid = '5500002';
  const gToken = 'b1b2c3d4e5';
  const p1Token = '3333333333';

  // Case 1: H@H node returns HTML with 200 OK -> rejected on .part, destPath never created.
  route = (hostname, reqPath) => {
    if (hostname === 'exhentai.org' && reqPath === `/g/${gid}/${gToken}/`) {
      return { status: 200, body: galleryHtml(gid, [{ token: p1Token, page: 1 }]) };
    }
    if (hostname === 'exhentai.org' && reqPath.startsWith(`/s/${p1Token}/`)) {
      return { status: 200, body: viewerHtml('https://node-bad.hath.network:10404/h/bad.jpg') };
    }
    if (hostname === 'node-bad.hath.network') {
      return { status: 200, body: HTML_PAGE, contentType: 'text/html' };
    }
    return { status: 404, body: 'no route' };
  };

  const gallery = await ehentaiProvider.getGallery(`https://exhentai.org/g/${gid}/${gToken}/`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-eh-bad-'));
  const destPath = path.join(tmpDir, '0');
  await assert.rejects(
    gallery.downloadPage!(0, destPath, { signal: new AbortController().signal }),
    (err: unknown) => err instanceof EhentaiUpstreamError && (err.kind === 'denied' || err.kind === 'parse'),
  );
  assert.equal(fs.existsSync(destPath), false, 'rejected H@H payload must never be renamed to destPath');
  assert.equal(fs.existsSync(`${destPath}.part`), false, 'rejected .part must be removed');

  // Case 2: HTTP 509 quota fails on first attempt without retrying.
  let viewerHits = 0;
  route = (hostname, reqPath) => {
    if (hostname === 'exhentai.org' && reqPath.startsWith(`/s/${p1Token}/`)) {
      viewerHits++;
      return { status: 200, body: viewerHtml('https://ehgt.org/g/509.gif') };
    }
    return { status: 404, body: 'no route' };
  };
  const ctx = {
    cancelled: false,
    stopped: false,
    committing: false,
    controller: new AbortController(),
    pauseSignal: { paused: false, waiters: [] },
  };
  await assert.rejects(
    downloadPages(gallery, 8802, { ...getDownloaderSettings(), maxImageConcurrency: 1, requestDelayMs: 0 }, ctx, fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-eh-509-')), () => {}),
    (err: unknown) => err instanceof EhentaiUpstreamError && err.kind === 'quota',
  );
  assert.equal(viewerHits, 1, 'quota exhaustion must fail immediately without retrying');
});
