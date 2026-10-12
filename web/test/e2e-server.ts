import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

// Always use a fresh database and never start download workers or scheduled
// jobs. These browser checks cannot touch an existing installation's data.
process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-e2e-'));
const { initDb, schema } = await import('../../server/src/db/index.js');
const { addWatchedSearch } = await import('../../server/src/services/watchedSearches.js');
const { createApp } = await import('../../server/src/app.js');
const db = initDb();
const historyWatch = addWatchedSearch('hitomi', 'artist:history-test');
const otherWatch = addWatchedSearch('nhentai', 'artist:other-history');
db.insert(schema.watchedSearchNew).values(Array.from({ length: 13 }, (_, index) => ({
  searchId: index === 12 ? otherWatch.id : historyWatch.id,
  source: index === 12 ? 'nhentai' : 'hitomi',
  query: index === 12 ? otherWatch.query : historyWatch.query,
  galleryId: `history-${index + 1}`,
  title: `History gallery ${index + 1}`,
  artistsJson: JSON.stringify(['History Artist']),
  language: 'English',
  pageCount: 24 + index,
  foundAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  reviewedAt: index % 2 === 0 ? '2026-10-02T00:00:00Z' : null,
}))).run();
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
