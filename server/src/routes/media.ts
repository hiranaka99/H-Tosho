import { Hono } from 'hono';
import { cors } from 'hono/cors';

/**
 * Media proxy for doujinshi gallery covers.
 *
 * Hitomi's image CDN (`gold-usergeneratedcontent.net`) rejects requests that do
 * not carry a `hitomi.la` Referer (it answers 404). Browsers cannot attach such
 * a Referer to cross-origin `<img>` loads, so hitomi cover URLs served straight
 * to the UI never render. We proxy those images through the server, which fetches
 * them with the required headers and streams the bytes back to the client.
 *
 * The target URL is passed base64url-encoded as `?u=` so arbitrary CDN paths
 * (which include slashes) survive query-string encoding without ambiguity:
 *   GET /media?u=<base64url(https://a2.gold-usergeneratedcontent.net/...avif)>
 */

/** In-memory cache of proxied image bytes so repeated renders don't re-fetch the CDN. */
const cache = new Map<string, { at: number; type: string; buf: Buffer }>();
const CACHE_TTL_MS = 60 * 60_000; // covers are stable once a gallery exists
const CACHE_MAX = 200;

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
  if (cache.size >= CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
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

    // Hitomi's CDN needs a hitomi.la Referer; the header is harmless for other hosts.
    const res = await fetch(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0',
        Referer: 'https://hitomi.la/',
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