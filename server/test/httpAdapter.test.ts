import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { serve } from '@hono/node-server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-http-'));
process.env.HTOSHO_DATA_DIR = path.join(root, 'data');
const { initDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { downloadQueue } = await import('../src/downloader/engine.js');
initDb();
const webDist = path.join(root, 'web');
fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
const index = path.join(webDist, 'index.html');
fs.writeFileSync(index, '<html>original shell</html>');
const script = Buffer.from('console.log("upgrade");'.repeat(100));
const asset = '/assets/index-abcdefgh.js';
const filename = path.join(webDist, asset);
fs.writeFileSync(filename, script);
fs.writeFileSync(`${filename}.br`, brotliCompressSync(script));
fs.writeFileSync(`${filename}.gz`, gzipSync(script));
const server = serve({ fetch: createApp({ webDist }).fetch, hostname: '127.0.0.1', port: 0 });
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
after(() => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
}));

// Native HTTP retains the wire bytes; fetch would silently decompress them.
function request(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get(base + url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('HTTP adapter serves immutable assets with negotiated compression and original fallback', async () => {
  for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz'], ['identity', '']] as const) {
    const response = await request(asset, { 'accept-encoding': encoding });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], encoding === 'identity' ? undefined : encoding);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(response.headers['content-type']!, /javascript/);
    if (suffix) assert.match(response.headers.vary!, /Accept-Encoding/);
    assert.deepEqual(response.body, fs.readFileSync(filename + suffix));
    assert.equal(Number(response.headers['content-length']), response.body.length);
  }
});

test('SPA deep links revalidate the shell while missing assets return 404', async () => {
  for (const url of ['/', '/index.html', '/settings?tab=providers']) {
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(response.body.toString(), '<html>original shell</html>');
  }
  assert.equal((await request('/assets/missing-abcdefgh.js')).status, 404);
  fs.writeFileSync(index, '<html>rebuilt shell</html>');
  const modified = new Date(Date.now() + 2000);
  fs.utimesSync(index, modified, modified);
  assert.equal((await request('/settings')).body.toString(), '<html>rebuilt shell</html>');
});

test('HTTP adapter preserves auth cookies, client errors and SSE disconnect cleanup', async () => {
  assert.equal((await request('/api/downloads/events')).status, 403, 'setup is required before protected endpoints can be used');
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'adapter-test', password: 'adapter-test-password' }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')!.split(';', 1)[0];
  await setup.arrayBuffer();
  assert.equal((await request('/api/downloads/events')).status, 401);
  assert.equal((await request('/api/health', { cookie })).status, 200);
  const malformed = await fetch(`${base}/api/doujin/search`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON body' });

  let subscriptions = 0;
  const original = downloadQueue.subscribe;
  downloadQueue.subscribe = function (listener) {
    subscriptions++;
    const unsubscribe = original.call(this, listener);
    return () => { subscriptions--; unsubscribe(); };
  };
  const controller = new AbortController();
  try {
    const events = await fetch(`${base}/api/downloads/events`, { headers: { cookie }, signal: controller.signal });
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type')!, /text\/event-stream/);
    const reader = events.body!.getReader();
    const frame = await reader.read();
    assert.match(new TextDecoder().decode(frame.value), /"type":"snapshot"/);
    assert.equal(subscriptions, 1);
    controller.abort();
    await reader.cancel().catch(() => {});
    for (let attempt = 0; subscriptions > 0 && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(subscriptions, 0, 'disconnect must release stream subscribers');
  } finally {
    controller.abort();
    downloadQueue.subscribe = original;
  }
});
