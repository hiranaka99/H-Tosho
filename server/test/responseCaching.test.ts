import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-caching-'));
process.env.HTOSHO_DATA_DIR = path.join(root, 'data');
const { initDb, getDb, schema, closeDb } = await import('../src/db/index.js');
const { api } = await import('../src/routes/api.js');
const { createApp, staticCacheControl } = await import('../src/app.js');
const { buildZip } = await import('../src/downloader/zip.js');
initDb();
after(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

test('download covers revalidate by ETag and repeat requests return identical bytes', async () => {
  const archive = path.join(root, 'cover.cbz');
  fs.writeFileSync(archive, buildZip([{ name: '1.jpg', data: Buffer.from('first-page') }, { name: '2.jpg', data: Buffer.from('second') }]));
  const id = Number(getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'cover-etag', status: 'completed', outputFormat: 'cbz', outputPath: archive }).run().lastInsertRowid);
  const first = await api.request(`/downloads/${id}/cover`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(first.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'first-page');
  const cached = await api.request(`/downloads/${id}/cover`);
  assert.equal(cached.headers.get('etag'), etag);
  assert.equal(Buffer.from(await cached.arrayBuffer()).toString(), 'first-page');
  const revalidated = await api.request(`/downloads/${id}/cover`, { headers: { 'If-None-Match': `W/${etag}` } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get('etag'), etag);

  // Rewriting the archive changes its tag; the old one no longer validates.
  fs.writeFileSync(archive, buildZip([{ name: '1.jpg', data: Buffer.from('replaced-page') }]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(archive, later, later);
  const changed = await api.request(`/downloads/${id}/cover`, { headers: { 'If-None-Match': etag! } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal(Buffer.from(await changed.arrayBuffer()).toString(), 'replaced-page');
});

test('folder covers are tagged by content', async () => {
  const folder = path.join(root, 'folder-cover');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '1.png'), 'png-one');
  const id = Number(getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'cover-folder-etag', status: 'completed', outputFormat: 'folder', outputPath: folder }).run().lastInsertRowid);
  const first = await api.request(`/downloads/${id}/cover`);
  const etag = first.headers.get('etag')!;
  assert.equal((await api.request(`/downloads/${id}/cover`, { headers: { 'If-None-Match': etag } })).status, 304);
  fs.writeFileSync(path.join(folder, '1.png'), 'png-two');
  const changed = await api.request(`/downloads/${id}/cover`, { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.equal(Buffer.from(await changed.arrayBuffer()).toString(), 'png-two');
});

test('SPA shell is compressed once, negotiated, and revalidated by ETag', async () => {
  const webDist = path.join(root, 'web');
  fs.mkdirSync(webDist, { recursive: true });
  const html = '<html>' + 'shell '.repeat(200) + '</html>';
  fs.writeFileSync(path.join(webDist, 'index.html'), html);
  const app = createApp({ webDist });
  for (const url of ['/', '/index.html', '/settings']) {
    const br = await app.request(url, { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(br.status, 200);
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.equal(br.headers.get('cache-control'), 'no-cache');
    assert.match(br.headers.get('vary')!, /Accept-Encoding/);
    assert.equal(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString(), html);
  }
  const gz = await app.request('/library', { headers: { 'Accept-Encoding': 'gzip, br;q=0' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), html);
  const plain = await app.request('/library');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(await plain.text(), html);
  const etag = plain.headers.get('etag')!;
  assert.equal((await app.request('/library', { headers: { 'If-None-Match': etag } })).status, 304);
});

test('static cache policy: hashed assets and versioned files are immutable, public images cache a day', () => {
  const year = 'public, max-age=31536000, immutable';
  assert.equal(staticCacheControl('/assets/index-abcdefgh.js', undefined), year);
  assert.equal(staticCacheControl('/assets/logo-AbC_12-x.png', undefined), year);
  assert.equal(staticCacheControl('/assets/inter-abcdefgh.woff2', undefined), year);
  assert.equal(staticCacheControl('/h-tosho-icon.png', '26b1c759'), year);
  assert.equal(staticCacheControl('/h-tosho-icon.png', undefined), 'public, max-age=86400');
  assert.equal(staticCacheControl('/ehentai.svg', undefined), 'public, max-age=86400');
  assert.equal(staticCacheControl('/fonts/inter-var.woff2', undefined), 'public, max-age=604800');
  assert.equal(staticCacheControl('/index.html', 'x'), 'no-cache');
  assert.equal(staticCacheControl('/manifest.webmanifest', undefined), 'no-cache');
});
