import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

// Always use a fresh database and never start download workers or scheduled
// jobs. These browser checks cannot touch an existing installation's data.
process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-e2e-'));
const { initDb } = await import('../../server/src/db/index.js');
const { createApp } = await import('../../server/src/app.js');
initDb();
const webDist = fileURLToPath(new URL('../dist/', import.meta.url));
if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('Run npm run build before the browser tests.');
const app = createApp({ webDist });
const response = await app.request('/api/auth/setup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'upgrade-test', password: 'upgrade-test-password' }),
});
if (response.status !== 201) throw new Error('Could not create the isolated test account.');
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 18787 });
