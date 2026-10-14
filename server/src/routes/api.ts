import { JobConflict } from '../jobs/queue.js';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api as kavita } from './api/kavita.js';
import { api as series } from './api/series.js';
import { api as settings } from './api/settings.js';
import { api as doujin } from './api/doujin.js';
import { api as downloads } from './api/downloads.js';
import { api as libraries } from './api/libraries.js';
import { api as watched } from './api/watched.js';
import { api as recommendations } from './api/recommendations.js';
import { api as archives } from './api/archives.js';
import { api as jobs } from './api/jobs.js';
export { kavitaCoverUrl } from './api/helpers.js';

export const api = new Hono();
api.onError((error, c) => {
  if (error instanceof JobConflict) return c.json({ error: error.message }, 409);
  if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
  console.error('[h-tosho] API request failed:', error);
  return c.json({ error: 'Internal server error' }, 500);
});

api.get('/health', (c) => c.json({ ok: true, name: 'h-tosho', time: new Date().toISOString() }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** App version shown in the UI; read once at startup (static per deployment). */
const APP_VERSION: string | null = (() => {
  try {
    // <server>/<src|dist>/routes/ → two levels up is the server package root.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
})();

api.get('/version', (c) => c.json({ version: APP_VERSION }));

// ---------------- Kavita connection ----------------

api.route('/', kavita);
api.route('/', series);
api.route('/', settings);
api.route('/', doujin);
api.route('/', downloads);
api.route('/', libraries);
api.route('/', watched);
api.route('/', recommendations);
api.route('/', archives);
api.route('/', jobs);
