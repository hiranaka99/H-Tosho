import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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

export function createApp(): Hono {
  const app = new Hono();
  const webDist = resolveWebDist();

  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
    console.error('[h-tosho] unhandled request error:', error);
    return c.json({ error: 'Internal server error' }, 500);
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
    app.use('/*', serveStatic({ root: webDist }));
    // SPA shell for unmatched routes (client-side navigation). The file is
    // re-read when its mtime changes, so a frontend rebuild is picked up
    // without restarting the server (a startup-cached shell goes stale as soon
    // as vite swaps the hashed assets it references).
    const indexPath = path.join(webDist, 'index.html');
    let shellCache: { mtimeMs: number; html: string } | null = null;
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) return c.notFound();
      try {
        const st = fs.statSync(indexPath);
        if (!shellCache || shellCache.mtimeMs !== st.mtimeMs) {
          shellCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(indexPath, 'utf-8') };
        }
      } catch {
        return c.text('Frontend build not found — run npm start', 503);
      }
      return c.html(shellCache.html);
    });
  }

  return app;
}