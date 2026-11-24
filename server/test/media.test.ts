import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

// The disk cache layer writes under DATA_DIR, so point the DB at a throwaway
// directory before the media module loads (it imports db/index.js at module
// level) — otherwise cached test covers leak into the real data dir.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-media-'));

const { mediaRouter, prefetchMedia, rewriteDoujinPages, rewriteMangaDexCoverUrl } = await import('../src/routes/media.js');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function proxyRequest(url: string): string {
  return `/media?u=${Buffer.from(url, 'utf8').toString('base64url')}`;
}

describe('media proxy', () => {
  it('fetches MangaDex covers with an application User-Agent and no Referer', async () => {
    const calls: Array<{ url: string; referer: string | null; userAgent: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const userAgent = headers.get('user-agent');
      calls.push({ url: String(input), referer: headers.get('referer'), userAgent });
      // MangaDex challenges browser identities; the server must identify itself
      // as an application rather than claiming to be a browser without its session.
      if (userAgent !== 'H-Tosho/1.0') {
        return new Response('Bot challenge not passed, refresh this page.', { status: 403 });
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    };

    const app = mediaRouter();
    const url = 'https://uploads.mangadex.org/covers/manga-1/file-one.jpg';
    const res = await app.request(proxyRequest(url));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(calls, [{ url, referer: null, userAgent: 'H-Tosho/1.0' }]);
  });

  it('still sends the hitomi.la Referer for other hosts', async () => {
    const calls: Array<{ url: string; referer: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), referer: headers.get('referer') });
      return new Response(new Uint8Array([0x00]), { status: 200, headers: { 'Content-Type': 'image/avif' } });
    };

    const app = mediaRouter();
    const url = 'https://a2.gold-usergeneratedcontent.net/file.avif';
    const res = await app.request(proxyRequest(url));

    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ url, referer: 'https://hitomi.la/' }]);
  });

  it('rebuilds headers for a redirect to MangaDex without forwarding the previous Referer', async () => {
    const start = 'https://a2.gold-usergeneratedcontent.net/redirect-to-mangadex.avif';
    const cover = 'https://uploads.mangadex.org/covers/redirected/main.jpg';
    const calls: Array<{ url: string; referer: string | null; userAgent: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), referer: headers.get('referer'), userAgent: headers.get('user-agent') });
      if (String(input) === start) return new Response(null, { status: 302, headers: { Location: cover } });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } });
    };

    const res = await mediaRouter().request(proxyRequest(start));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [
      { url: start, referer: 'https://hitomi.la/', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0' },
      { url: cover, referer: null, userAgent: 'H-Tosho/1.0' },
    ]);
  });

  it('proxies nHentai preview images with the provider Referer', async () => {
    const calls: Array<{ url: string; referer: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), referer: headers.get('referer') });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    };

    const url = 'https://i2.nhentai.net/galleries/123/1.jpg';
    const res = await mediaRouter().request(proxyRequest(url));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ url, referer: 'https://nhentai.net/' }]);
  });

  it('prefetches allowed covers so later proxy requests skip the CDN', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(new Uint8Array([0x01, 0x02]), { status: 200, headers: { 'Content-Type': 'image/avif' } });
    };
    const url = 'https://a2.gold-usergeneratedcontent.net/prefetched-cover.avif';
    const result = await prefetchMedia([url, url, 'https://example.com/not-allowed.jpg']);
    assert.deepEqual(result, { loaded: 1, failed: 0 });
    assert.deepEqual(calls, [url], 'duplicates and disallowed hosts must not be fetched');

    const res = await mediaRouter().request(proxyRequest(url));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/avif');
    assert.deepEqual(calls, [url], 'proxy must serve the prefetched cover from cache');
  });

  it('reports failed prefetches', async () => {
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    const result = await prefetchMedia(['https://i3.nhentai.net/galleries/9/cover.jpg']);
    assert.deepEqual(result, { loaded: 0, failed: 1 });
  });

  it('rejects non-CDN nHentai hosts', async () => {
    const res = await mediaRouter().request(proxyRequest('https://nhentai.net/api/v2/galleries/1'));
    assert.equal(res.status, 400);
  });

  it('refreshes stale cached Hitomi routes after an upstream 404', async () => {
    const hash = 'ab'.repeat(32);
    const stale = `https://a2.gold-usergeneratedcontent.net/old/1/${hash}.avif`;
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === stale) return new Response('stale', { status: 404 });
      if (url.endsWith('/gg.js')) {
        return new Response('gg.m = function () { return 0; }; gg.s = function () { return "/p/"; }; gg.b = "fresh/";');
      }
      if (url === `https://a1.gold-usergeneratedcontent.net/fresh//p//${hash}.avif`) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/avif' } });
      }
      return new Response('unexpected', { status: 404 });
    };

    const res = await mediaRouter().request(proxyRequest(stale));
    assert.equal(res.status, 200);
    assert.ok(calls.some((url) => url.endsWith('/gg.js')));
    assert.ok(calls.some((url) => url.includes('/fresh/')));
  });

  it('rejects invalid media URLs', async () => {
    globalThis.fetch = async () => {
      throw new Error('fetch should not be called');
    };
    const app = mediaRouter();
    assert.equal((await app.request('/media?u=not%20a%20url')).status, 400);
    assert.equal((await app.request('/media')).status, 400);
  });

  it('surfaces upstream failures as 502', async () => {
    globalThis.fetch = async () => new Response('nope', { status: 404 });
    const app = mediaRouter();
    const res = await app.request(proxyRequest('https://uploads.mangadex.org/covers/manga-1/missing.jpg'));
    assert.equal(res.status, 502);
  });

  it('does not follow a redirect to a non-viewer E-Hentai page', async () => {
    const fetched: string[] = [];
    // e-hentai.org passes the host allowlist, so only the viewer-path check can stop this hop.
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith('https://e-hentai.org/')) return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200, headers: { 'content-type': 'image/png' } });
      return new Response(null, { status: 302, headers: { location: 'https://e-hentai.org/home.php' } });
    };
    const res = await mediaRouter().request(proxyRequest('https://uploads.mangadex.org/covers/manga-1/redirect-to-eh.png'));
    assert.equal(res.status, 502);
    assert.deepEqual(fetched, ['https://uploads.mangadex.org/covers/manga-1/redirect-to-eh.png']);
  });

  it('stops reading an upstream body once it exceeds the size cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let pulled = 0;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        // 40 MiB in total, twice the 20 MiB cap.
        if (++pulled > 40) controller.close();
        else controller.enqueue(chunk);
      },
    }), { status: 200, headers: { 'content-type': 'image/png' } });
    const res = await mediaRouter().request(proxyRequest('https://uploads.mangadex.org/covers/manga-1/oversized.png'));
    assert.equal(res.status, 502);
    assert.ok(pulled < 40, `the proxy read ${pulled} MiB before giving up`);
  });
});

describe('rewriteMangaDexCoverUrl', () => {
  it('routes MangaDex CDN covers through the proxy and leaves other URLs untouched', () => {
    const md = 'https://uploads.mangadex.org/covers/manga-1/file-one.jpg';
    assert.equal(rewriteMangaDexCoverUrl(md), proxyRequest(md));
    assert.equal(rewriteMangaDexCoverUrl('https://s4.anilist.co/file.jpg'), 'https://s4.anilist.co/file.jpg');
    assert.equal(rewriteMangaDexCoverUrl(undefined), undefined);
    assert.equal(rewriteMangaDexCoverUrl(null), undefined);
  });
});

describe('rewriteDoujinPages', () => {
  it('returns aligned proxy URLs for primary pages and optional fallbacks', () => {
    const first = 'https://i1.nhentai.net/galleries/1/1.jpg';
    const second = 'https://i1.nhentai.net/galleries/1/2.jpg';
    const fallback = 'https://i2.nhentai.net/galleries/1/1.jpg';
    assert.deepEqual(rewriteDoujinPages([first, second], [fallback, null]), {
      previewPages: [proxyRequest(first), proxyRequest(second)],
      previewFallbacks: [proxyRequest(fallback), null],
    });
  });
});

describe('media proxy caching', () => {
  it('serves one Hitomi image across rotated CDN prefixes from a single upstream fetch', async () => {
    const hash = 'cd'.repeat(32);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { 'Content-Type': 'image/webp' } });
    };
    const app = mediaRouter();
    const first = await app.request(proxyRequest(`https://w1.gold-usergeneratedcontent.net/1700000000/12/${hash}.webp`));
    const rotated = await app.request(proxyRequest(`https://w2.gold-usergeneratedcontent.net/1700000300/12/${hash}.webp`));
    assert.equal(first.status, 200);
    assert.equal(rotated.status, 200);
    assert.deepEqual(new Uint8Array(await rotated.arrayBuffer()), new Uint8Array([7, 7, 7]));
    assert.equal(calls, 1);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    const app = mediaRouter();
    const url = proxyRequest('https://uploads.mangadex.org/covers/manga-etag/cover.jpg');
    const first = await app.request(url);
    const etag = first.headers.get('etag');
    assert.ok(etag?.startsWith('W/'));
    const revalidated = await app.request(url, { headers: { 'If-None-Match': etag! } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('etag'), etag);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0);
    const changed = await app.request(url, { headers: { 'If-None-Match': 'W/"other"' } });
    assert.equal(changed.status, 200);
  });
});
