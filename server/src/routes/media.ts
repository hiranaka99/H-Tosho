import { Hono } from 'hono';
import { cors } from 'hono/cors';

/**
 * Media proxy for CDN cover images that browsers cannot load directly.
 *
 * Hitomi's image CDN (`gold-usergeneratedcontent.net`) rejects requests that do
 * not carry a `hitomi.la` Referer (it answers 404). MangaDex's cover CDN
 * (`uploads.mangadex.org`) does the opposite: it answers third-party Referers
 * (anything other than mangadex.org or the literal hostname "localhost") with
 * a placeholder promo card instead of the cover — including 127.0.0.1 and LAN
 * addresses, so the app only renders covers when opened via http://localhost.
 * Browsers cannot attach (or omit) such Referers on cross-origin `<img>` loads,
 * so these images are proxied through the server, which fetches them with the
 * headers each CDN requires and streams the bytes back to the client.
 *
 * The target URL is passed base64url-encoded as `?u=` so arbitrary CDN paths
 * (which include slashes) survive query-string encoding without ambiguity:
 *   GET /media?u=<base64url(https://a2.gold-usergeneratedcontent.net/...avif)>
 */

/** In-memory cache of proxied image bytes so repeated renders don't re-fetch the CDN. */
const cache = new Map<string, { at: number; type: string; buf: Buffer }>();
const CACHE_TTL_MS = 60 * 60_000; // covers are stable once a gallery exists
const CACHE_MAX = 200;
/** MangaDex cover files can exceed 10 MB; don't pin those in RAM. */
const CACHE_MAX_BYTES = 5 * 1024 * 1024;

function getCached(key: string): { type: string; buf: Buffer } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { type: hit.type, buf: hit.buf };
}

function setCached(key: string, type: string, buf: Buffer): void {
  if (buf.length > CACHE_MAX_BYTES) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), type, buf });
}

/** Decode a base64url query value back to a string. */
function decodeUrlParam(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8') || null;
  } catch {
    return null;
  }
}

/**
 * Per-host Referer policy for proxied fetches. `undefined` means send no
 * Referer at all — required for MangaDex, whose CDN serves a placeholder card
 * to any third-party Referer (including 127.0.0.1 / LAN origins).
 */
function refererForHost(hostname: string): string | undefined {
  if (hostname === 'uploads.mangadex.org') return undefined;
  // Hitomi's CDN requires a hitomi.la Referer; the header is harmless for other hosts.
  return 'https://hitomi.la/';
}

export function mediaRouter(): Hono {
  const r = new Hono();
  r.use('*', cors());

  r.get('/media', async (c) => {
    const target = decodeUrlParam(c.req.query('u'));
    let parsed: URL | null = null;
    if (target) {
      try {
        parsed = new URL(target);
      } catch {
        parsed = null;
      }
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      return c.json({ error: 'Invalid media URL' }, 400);
    }

    const cached = getCached(target as string);
    if (cached) {
      return c.body(new Uint8Array(cached.buf), 200, {
        'Content-Type': cached.type,
        'Cache-Control': 'private, max-age=3600',
      });
    }

    const res = await fetch(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0',
        ...(refererForHost(parsed.hostname) ? { Referer: refererForHost(parsed.hostname)! } : {}),
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      return c.json({ error: `Upstream returned HTTP ${res.status}` }, 502);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || 'image/jpeg';
    setCached(target as string, type, buf);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=3600',
    });
  });

  return r;
}

/** Wrap an absolute image URL in a same-origin `/media` proxy URL (base64url-encoded). */
export function mediaProxyUrl(url: string): string {
  const b64 = Buffer.from(url, 'utf8').toString('base64url');
  return `/media?u=${b64}`;
}

/** Rewrite hitomi cover URLs to route through the proxy (other sources are untouched). */
export function rewriteHitomiCover<T extends { source?: string; coverUrl?: string | null }>(r: T): T {
  if (r.source === 'hitomi' && typeof r.coverUrl === 'string' && r.coverUrl.startsWith('http')) {
    return { ...r, coverUrl: mediaProxyUrl(r.coverUrl) };
  }
  return r;
}

/** Rewrite MangaDex CDN cover URLs to route through the proxy (other URLs untouched). */
export function rewriteMangaDexCoverUrl(url?: string | null): string | undefined {
  if (typeof url === 'string' && url.startsWith('https://uploads.mangadex.org/covers/')) {
    return mediaProxyUrl(url);
  }
  return url ?? undefined;
}