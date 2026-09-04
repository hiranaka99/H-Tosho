import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

// The disk cache layer writes under DATA_DIR, so point the DB at a throwaway
// directory before the media module loads (it imports db/index.js at module
// level) — otherwise cached test covers leak into the real data dir.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-media-'));

const { mediaRouter, rewriteMangaDexCoverUrl } = await import('../src/routes/media.js');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function proxyRequest(url: string): string {
  return `/media?u=${Buffer.from(url, 'utf8').toString('base64url')}`;
}

describe('media proxy', () => {
  it('fetches MangaDex covers without a Referer (CDN serves a placeholder card to third-party referers)', async () => {
    const calls: Array<{ url: string; referer: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), referer: headers.get('referer') });
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
    assert.deepEqual(calls, [{ url, referer: null }]);
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
