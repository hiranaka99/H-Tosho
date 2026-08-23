import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { api } from './routes/api.js';
import { mediaRouter } from './routes/media.js';

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

/**
 * Optional shared-secret auth. When HTOSHO_TOKEN is set, every /api and /media
 * request must present it — via `Authorization: Bearer <token>` or a `?token=`
 * query param (the query form exists because <img> tags and EventSource cannot
 * set headers). Unset = no auth, which pairs with the local-only bind default.
 */
/** Constant-time comparison so a wrong token does not leak length/prefix timing. */
function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function tokenMiddleware(token: string) {
  return async (c: Context, next: Next): Promise<Response> => {
    const header = c.req.header('authorization');
    const bearerOk = header?.startsWith('Bearer ') === true && tokensEqual(header.slice('Bearer '.length), token);
    if (!bearerOk && !tokensEqual(c.req.query('token'), token)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
    return c.res ?? c.text('Not Found', 404);
  };
}
export function createApp(): Hono {
  const app = new Hono();
  const webDist = resolveWebDist();

  app.use('/api/*', cors());
  const token = process.env.HTOSHO_TOKEN;
  if (token) {
    app.use('/api/*', tokenMiddleware(token));
    app.use('/media', tokenMiddleware(token));
  }
  app.route('/api', api);
  // Media proxy for doujin covers (Hitomi CDN requires a hitomi.la Referer).
  app.route('/', mediaRouter());

  if (webDist) {
    app.use('/*', serveStatic({ root: webDist }));
    // Read the SPA shell once at startup; the fallback used to hit the disk
    // on every unmatched navigation.
    const indexHtml = fs.readFileSync(path.join(webDist, 'index.html'), 'utf-8');
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) return c.notFound();
      return c.html(indexHtml);
    });
  }

  return app;
}