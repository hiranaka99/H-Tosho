import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { eq, like } from 'drizzle-orm';

// A fresh DB, no download workers or schedulers. Only explicitly targeted F1
// fixture checks may execute through the real Task handler; all other jobs fail closed.
process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-e2e-'));
process.env.HTOSHO_UPDATE_CHECK_DISABLED = '1';
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
  watchLabel: index === 12 ? otherWatch.query : historyWatch.query,
  galleryId: `history-${index + 1}`,
  title: `History gallery ${index + 1}`,
  artistsJson: JSON.stringify(['History Artist']),
  language: 'English',
  pageCount: 24 + index,
  foundAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  reviewedAt: index % 2 === 0 ? '2026-10-02T00:00:00Z' : null,
}))).run();

// Only the F1 browser scenario's isolated queries use this local provider fixture.
// All Following HTTP routes, Tasks, revisions and persistence remain genuine.
// Dynamic import preserves the test module-loading boundary: providers import
// settings/DB modules that must snapshot the temporary data directory above.
const { doujinProviders } = await import('../../server/src/downloader/providers.js');
const originalHitomi = doujinProviders.hitomi;
const followingChecks = new Map<string, number>();
// Deterministic unified-search fixtures. The unified aggregator calls
// `searchChunk` (not `search`), so both lanes are stubbed there; every other
// query still fails closed, keeping all Following/real-provider behavior live.
const UNIFIED_OK = 'artist:e2e-unified';
const UNIFIED_PARTIAL = 'artist:e2e-unified-partial';
const unifiedChunk = (items: { source: 'hitomi' | 'nhentai'; galleryId: string; title: string; language: string; artists: string[]; pageCount: number; url: string }[]) => ({
  items, nextCursor: null, exhausted: true, total: items.length,
});
doujinProviders.hitomi = {
  ...originalHitomi,
  async search(query) {
    if (!/^artist:e2e-(following|discord)-(desktop|mobile)$/.test(query)) throw new Error('Live provider queries are disabled in browser tests');
    const attempt = (followingChecks.get(query) ?? 0) + 1;
    followingChecks.set(query, attempt);
    if (query.includes('e2e-following') && attempt === 2) throw new Error('Fixture provider unavailable');
    const count = query.includes('e2e-discord') ? Math.max(0, attempt - 1) : attempt === 1 ? 1 : attempt - 1;
    return Array.from({ length: count }, (_, index) => ({
      source: 'hitomi' as const, galleryId: `${query}-${index}`, title: `Following fixture gallery ${index}`,
      tags: [], artists: ['Following Fixture Artist'], pageCount: 28,
    }));
  },
  async searchChunk(query, cursor, limit, sort, opts, signal) {
    if (query === UNIFIED_OK || query === UNIFIED_PARTIAL) {
      const items = query === UNIFIED_OK
        ? [
            { source: 'hitomi' as const, galleryId: 'e2e-unified-1', title: 'Unified Fixture Work', language: 'English', tags: [], artists: ['Unified Fixture Artist'], pageCount: 42, url: 'https://hitomi.la/doujinshi/e2e-unified-1.html' },
            { source: 'hitomi' as const, galleryId: 'e2e-unified-2', title: 'Unified Fixture Second', language: 'English', tags: [], artists: ['Unified Fixture Artist'], pageCount: 17, url: 'https://hitomi.la/doujinshi/e2e-unified-2.html' },
          ]
        : [
            { source: 'hitomi' as const, galleryId: 'e2e-unified-p-1', title: 'Unified Fixture Partial', language: 'English', tags: [], artists: ['Unified Fixture Artist'], pageCount: 9, url: 'https://hitomi.la/doujinshi/e2e-unified-p-1.html' },
          ];
      return unifiedChunk(items.slice(0, limit));
    }
    throw new Error('Live provider queries are disabled in browser tests');
  },
  async getGallery(idOrUrl) {
    const fixture: Record<string, { title: string; language: string; pageCount: number }> = {
      'e2e-unified-1': { title: 'Unified Fixture Work', language: 'English', pageCount: 42 },
      'e2e-unified-2': { title: 'Unified Fixture Second', language: 'English', pageCount: 17 },
      'e2e-unified-p-1': { title: 'Unified Fixture Partial', language: 'English', pageCount: 9 },
    };
    const hit = Object.entries(fixture).find(([id]) => idOrUrl.includes(id));
    if (hit) {
      const [galleryId, meta] = hit;
      return { source: 'hitomi' as const, galleryId, url: `https://hitomi.la/doujinshi/${galleryId}.html`, pages: [], ...meta, tags: [], artists: ['Unified Fixture Artist'] };
    }
    throw new Error('Live gallery requests are disabled in browser tests');
  },
};
doujinProviders.nhentai = {
  ...doujinProviders.nhentai,
  async search() { throw new Error('Live provider queries are disabled in browser tests'); },
  async searchChunk(query, cursor, limit, sort, opts, signal) {
    if (query === `artist:"e2e-unified"`) {
      // Same fingerprint as hitomi's e2e-unified-1: groups into one entry.
      return unifiedChunk([
        { source: 'nhentai' as const, galleryId: 'e2e-unified-nh-1', title: 'Unified Fixture Work [Digital]', language: 'english', tags: [], artists: ['Unified Fixture Artist'], pageCount: 42, url: 'https://nhentai.net/g/100001/' },
      ]);
    }
    if (query === UNIFIED_PARTIAL) throw new Error('Fixture provider unavailable');
    throw new Error('Live provider queries are disabled in browser tests');
  },
  async getGallery(idOrUrl) {
    if (idOrUrl.includes('e2e-unified-nh-1')) {
      return {
        source: 'nhentai' as const, galleryId: 'e2e-unified-nh-1', title: 'Unified Fixture Work [Digital]',
        language: 'english', tags: [], artists: ['Unified Fixture Artist'], pageCount: 42,
        url: 'https://nhentai.net/g/100001/', pages: [],
      };
    }
    throw new Error('Live gallery requests are disabled in browser tests');
  },
};
const webDist = fileURLToPath(new URL('../dist/', import.meta.url));
if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('Run npm run build before the browser tests.');
const app = new Hono();
const { requireAuth } = await import('../../server/src/services/auth.js');
app.use('/api/__test/*', requireAuth);
// Deferred imports preserve the temporary DB module-loading boundary above.
// Register only bounded Following fixture checks, never metadata/download jobs.
const { jobQueue } = await import('../../server/src/jobs/queue.js');
const { runJob } = await import('../../server/src/jobs/executor.js');
jobQueue.registerHandler((job, log, signal) => {
  const ids = job.payload.watchIds;
  if (job.type !== 'check-watched-searches' || !Array.isArray(ids) || ids.length !== 1 || !Number.isSafeInteger(ids[0])) throw new Error('Non-fixture Task execution is disabled in browser tests');
  const watch = db.select({ query: schema.watchedSearches.query }).from(schema.watchedSearches).where(eq(schema.watchedSearches.id, ids[0])).get();
  if (!watch || !/^artist:e2e-(following|discord)-(desktop|mobile)$/.test(watch.query)) throw new Error('Non-fixture watch execution is disabled in browser tests');
  return runJob(job, log, signal);
});
app.delete('/api/__test/following/:project', c => {
  const project = c.req.param('project');
  if (project !== 'desktop' && project !== 'mobile') return c.json({ error: 'Unknown fixture' }, 400);
  const query = `artist:e2e-following-${project}`;
  const fixtureWatch = db.select({ id: schema.watchedSearches.id }).from(schema.watchedSearches).where(eq(schema.watchedSearches.query, query)).get();
  if (fixtureWatch) {
    for (const job of jobQueue.active()) {
      if (job.type === 'check-watched-searches' && job.payload.watchIds?.includes(fixtureWatch.id)) jobQueue.cancel(job.id);
    }
  }
  db.transaction(tx => {
    tx.delete(schema.watchedSearchNew).where(eq(schema.watchedSearchNew.query, query)).run();
    tx.delete(schema.watchedSearchSeen).where(like(schema.watchedSearchSeen.galleryId, `${query}-%`)).run();
    tx.delete(schema.watchedSearches).where(eq(schema.watchedSearches.query, query)).run();
    tx.delete(schema.watchedSearchFolders).where(like(schema.watchedSearchFolders.name, `F1 ${project} %`)).run();
  });
  followingChecks.delete(query);
  return c.json({ ok: true });
});

// Isolated real HTTP webhook for Discord send and Task-history checks.
const deliveryModes = new Map<string, 'delivered' | 'unknown' | 'failed'>();
const deliveryPosts = new Map<string, unknown[]>();
app.post('/__fixture/discord/:project', async c => {
  const project = c.req.param('project');
  if (!['desktop', 'mobile'].includes(project)) return c.json({ error: 'Unknown fixture' }, 404);
  const posts = deliveryPosts.get(project) ?? [];
  posts.push(await c.req.json()); deliveryPosts.set(project, posts);
  const mode = deliveryModes.get(project) ?? 'delivered';
  if (mode === 'unknown') return c.body(null, 204);
  if (mode === 'failed') return c.json({ error: 'Fixture rejected' }, 403);
  return c.json({ id: `fixture-${project}-${posts.length}` });
});
app.post('/api/__test/discord/:project/mode', async c => {
  const project = c.req.param('project'), body = await c.req.json();
  if (!['desktop', 'mobile'].includes(project) || !['delivered', 'unknown', 'failed'].includes(body?.mode)) return c.json({ error: 'Invalid fixture' }, 400);
  deliveryModes.set(project, body.mode); return c.json({ ok: true });
});
app.get('/api/__test/discord/:project/posts', c => c.json(deliveryPosts.get(c.req.param('project')) ?? []));
app.delete('/api/__test/discord/:project', c => {
  const project = c.req.param('project');
  if (!['desktop', 'mobile'].includes(project)) return c.json({ error: 'Invalid fixture' }, 400);
  const query = `artist:e2e-discord-${project}`;
  db.transaction(tx => {
    tx.delete(schema.watchedSearchNew).where(eq(schema.watchedSearchNew.query, query)).run();
    tx.delete(schema.watchedSearchSeen).where(like(schema.watchedSearchSeen.galleryId, `${query}-%`)).run();
    tx.delete(schema.watchedSearches).where(eq(schema.watchedSearches.query, query)).run();
  });
  followingChecks.delete(query); deliveryPosts.delete(project); deliveryModes.delete(project);
  return c.json({ ok: true });
});
// Fixture GET routes must precede the application's terminal SPA fallback.
app.route('/', createApp({ webDist }));
const response = await app.request('/api/auth/setup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'upgrade-test', password: 'upgrade-test-password' }),
});
if (response.status !== 201) throw new Error('Could not create the isolated test account.');
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 18787 });
