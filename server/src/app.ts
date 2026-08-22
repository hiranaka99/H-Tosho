import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api } from './routes/api.js';

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

  app.use('/api/*', cors());
  app.route('/api', api);

  if (webDist) {
    app.use('/*', serveStatic({ root: webDist }));
    const indexPath = path.join(webDist, 'index.html');
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) return c.notFound();
      return c.html(fs.readFileSync(indexPath, 'utf-8'));
    });
  }

  return app;
}