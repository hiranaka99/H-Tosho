import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import type { Context, Next } from 'hono';
import { api } from './routes/api.js';
import { mediaRouter } from './routes/media.js';
import { authStatus, changeCredentials, login, logout, requireAuth, setup } from './services/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Locate the built frontend (web/dist). Works from any cwd. */
function resolveWebDist(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../web/dist'), // server/dist -> repo root
    path.resolve(process.cwd(), 'web/dist'), // run from repo root
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const YEAR = 'public, max-age=31536000, immutable';

/**
 * Vite's content hashes (scripts, styles, images and fonts under /assets/)
 * change whenever an asset changes, as does an explicit `?v=` version, so
 * those are immutable. Stable fonts and public images get bounded caching;
 * anything else revalidates.
 */
export function staticCacheControl(requestPath: string, version: string | undefined): string {
  if (/^\/assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i.test(requestPath)) return YEAR;
  if (/\.html?$/i.test(requestPath)) return 'no-cache';
  if (version) return YEAR;
  if (/^\/fonts\/[^/]+\.woff2$/.test(requestPath)) return 'public, max-age=604800';
  if (/^\/[^/]+\.(?:png|svg|ico|webp|jpe?g|gif|avif)$/i.test(requestPath)) return 'public, max-age=86400';
  return 'no-cache';
}

/** Preferred encoding the client accepts (q=0 excludes); null means identity. */
function negotiateEncoding(header: string | undefined): 'br' | 'gzip' | null {
  if (!header) return null;
  const accepted = new Map<string, number>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(param => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
    accepted.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  const weight = (name: string) => accepted.get(name) ?? accepted.get('*') ?? 0;
  if (weight('br') > 0) return 'br';
  if (weight('gzip') > 0) return 'gzip';
  return null;
}

/**
 * SPA shell. The file is re-read when its mtime or size changes, so a frontend
 * rebuild is picked up without restarting the server (a startup-cached shell
 * goes stale as soon as vite swaps the hashed assets it references). Each
 * version is compressed once and revalidated by ETag.
 */
function createShellHandler(indexPath: string) {
  type Shell = { mtimeMs: number; size: number; html: Buffer; br: Buffer; gz: Buffer; etag: string };
  let cache: Shell | null = null;
  let loading: Promise<Shell> | null = null;
  const load = async (st: fs.Stats): Promise<Shell> => {
    const html = await fs.promises.readFile(indexPath);
    const [br, gz] = await Promise.all([
      brotli(html, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }),
      gzipAsync(html, { level: 9 }),
    ]);
    return { mtimeMs: st.mtimeMs, size: st.size, html, br, gz, etag: `"${createHash('sha1').update(html).digest('base64url')}"` };
  };
  return async (c: Context, _next?: Next): Promise<Response> => {
    let shell: Shell;
    try {
      const st = await fs.promises.stat(indexPath);
      if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
        loading ??= load(st).finally(() => { loading = null; });
        cache = await loading;
      }
      shell = cache;
    } catch {
      return c.text('Frontend build not found — run npm start', 503);
    }
    const headers: Record<string, string> = { 'Cache-Control': 'no-cache', ETag: shell.etag, Vary: 'Accept-Encoding' };
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch && ifNoneMatch.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === shell.etag)) {
      return new Response(null, { status: 304, headers });
    }
    const encoding = negotiateEncoding(c.req.header('Accept-Encoding'));
    const body = encoding === 'br' ? shell.br : encoding === 'gzip' ? shell.gz : shell.html;
    if (encoding) headers['Content-Encoding'] = encoding;
    headers['Content-Type'] = 'text/html; charset=UTF-8';
    headers['Content-Length'] = String(body.length);
    return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
  };
}

export function createApp(options: { webDist?: string | null } = {}): Hono {
  const app = new Hono();
  const webDist = options.webDist === undefined ? resolveWebDist() : options.webDist;

  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
    console.error('[h-tosho] unhandled request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  const apiCompress = compress();
  app.use('/api/*', (c, next) => {
    if (c.req.path === '/api/downloads/events') return next();
    return apiCompress(c, next);
  });
  app.get('/api/auth/status', authStatus);
  app.post('/api/auth/setup', setup);
  app.post('/api/auth/login', login);
  app.post('/api/auth/logout', logout);
  app.put('/api/auth/credentials', requireAuth, changeCredentials);
  app.use('/api/*', requireAuth);
  app.use('/media', requireAuth);
  app.route('/api', api);
  // Media proxy for doujin covers (Hitomi CDN requires a hitomi.la Referer).
  app.route('/', mediaRouter());

  if (webDist) {
    // The shell is served by one handler for `/`, `/index.html` and every
    // client-side route, with an ETag and negotiated compression.
    const shell = createShellHandler(path.join(webDist, 'index.html'));
    app.get('/', shell);
    app.get('/index.html', shell);
    app.use('/*', serveStatic({
      root: webDist,
      precompressed: true,
      onFound: (_path, c) => { c.header('Cache-Control', staticCacheControl(c.req.path, c.req.query('v'))); },
    }));
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')) return c.notFound();
      return shell(c, next);
    });
  }

  return app;
}
