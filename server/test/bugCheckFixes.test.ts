import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-bugcheck-'));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb, getDb, schema } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { resetLoginThrottle } = await import('../src/services/auth.js');
const { safeMediaType } = await import('../src/routes/media.js');
const { readCoverImage, readZipEntryFromDisk } = await import('../src/lib/cbz.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { jobQueue } = await import('../src/jobs/queue.js');
await import('../src/downloader/engine.js'); // registers the merge-download canceller
const { libraryMutations } = await import('../src/lib/mutations.js');
const { getKavitaConnection, setKavitaConnection, getPollIntervalHours, setPollIntervalHours } = await import('../src/services/settings.js');

initDb();
const app = createApp({ webDist: null });

function json(method: string, body: unknown, session?: string): RequestInit {
  return { method, headers: { 'content-type': 'application/json', ...(session ? { cookie: session } : {}) }, body: JSON.stringify(body) };
}

// Concurrent first-run setup: the hash is async, so both requests used to pass
// the "no account yet" check and the later one silently replaced the first.
const [first, second] = await Promise.all([
  app.request('/api/auth/setup', json('POST', { username: 'owner', password: 'owner password' })),
  app.request('/api/auth/setup', json('POST', { username: 'intruder', password: 'intruder password' })),
]);
const session = (first.status === 201 ? first : second).headers.get('set-cookie')!.split(';', 1)[0];

test('concurrent setup admits exactly one account', () => {
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
});

test('repeated failed logins are throttled, even for the right password', async () => {
  resetLoginThrottle();
  const owner = first.status === 201 ? { username: 'owner', password: 'owner password' } : { username: 'intruder', password: 'intruder password' };
  for (let i = 0; i < 6; i++) {
    const response = await app.request('/api/auth/login', json('POST', { ...owner, password: 'wrong guess' }));
    assert.equal(response.status, 401, `attempt ${i + 1} is an ordinary failure`);
  }
  const locked = await app.request('/api/auth/login', json('POST', owner));
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) >= 1);
  resetLoginThrottle();
  assert.equal((await app.request('/api/auth/login', json('POST', owner))).status, 200);
});

test('media proxy never serves non-raster upstream types', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif')]);
  assert.equal(safeMediaType('text/html; charset=utf-8', html), null);
  assert.equal(safeMediaType('image/svg+xml', html), null);
  assert.equal(safeMediaType('text/html', png), 'image/png', 'a mislabeled real image is served as what it is');
  assert.equal(safeMediaType(null, avif), 'image/avif');
  assert.equal(safeMediaType('IMAGE/AVIF', Buffer.from([1, 2])), 'image/avif', 'declared raster types stay (served with nosniff)');
});

test('cover reads cap inflate output instead of trusting the declared size', async () => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'cbz-'));
  const bomb = path.join(dir, 'bomb.cbz');
  const zip = buildZip([{ name: '01.png', data: Buffer.alloc(33 * 1024 * 1024) }]);
  // Lie in the central directory: claim the 33 MiB page is 100 bytes.
  const eocd = zip.length - 22;
  const central = zip.readUInt32LE(eocd + 16);
  zip.writeUInt32LE(100, central + 24);
  fs.writeFileSync(bomb, zip);
  assert.equal(await readCoverImage(bomb), null);
  await assert.rejects(readZipEntryFromDisk(bomb, '01.png', 1024 * 1024), /limit|exceeds|buffer/i);

  const truncated = path.join(dir, 'truncated.cbz');
  const small = buildZip([{ name: '01.png', data: Buffer.from('not really an image but fine') }]);
  const cd = small.readUInt32LE(small.length - 22 + 16);
  small.writeUInt32LE(0x7fffffff, cd + 20); // compressed size far past EOF
  fs.writeFileSync(truncated, small);
  await assert.rejects(readZipEntryFromDisk(truncated, '01.png'), /exceeds|past end/);
});

test('restart interrupts running merges and releases their downloads', () => {
  const db = getDb();
  const job = db.insert(schema.jobs).values({ type: 'merge-series', status: 'running' }).run();
  const jobId = Number(job.lastInsertRowid);
  const download = db.insert(schema.downloadQueue).values({ source: 'nhentai', galleryId: '424242', status: 'downloading', mergeJobId: jobId, outputFormat: 'cbz' }).run();
  const downloadId = Number(download.lastInsertRowid);

  assert.ok(jobQueue.interruptRunningJobs() >= 1);
  const jobRow = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get()!;
  assert.equal(jobRow.status, 'failed');
  assert.equal(jobRow.errorMessage, 'Interrupted by server restart');
  const downloadRow = db.select().from(schema.downloadQueue).where(eq(schema.downloadQueue.id, downloadId)).get()!;
  assert.equal(downloadRow.status, 'failed');
  assert.equal(downloadRow.errorCode, 'cancelled');
});

test('restoring the previous Kavita server waits for running work', async () => {
  setKavitaConnection({ baseUrl: 'http://kavita-current.invalid', apiKey: 'current-key' });
  getDb().insert(schema.keyValueStore)
    .values({ key: 'kavita-previous', valueJson: JSON.stringify({ baseUrl: 'http://kavita-previous.invalid', apiKey: 'previous-key' }) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify({ baseUrl: 'http://kavita-previous.invalid', apiKey: 'previous-key' }) } })
    .run();
  let release!: () => void;
  const busy = libraryMutations.run(['*'], () => new Promise<void>(resolve => { release = resolve; }));
  try {
    const blocked = await app.request('/api/kavita/connection/restore', { method: 'POST', headers: { cookie: session } });
    assert.equal(blocked.status, 409);
    assert.equal(getKavitaConnection().baseUrl, 'http://kavita-current.invalid');
  } finally {
    release();
    await busy;
    await new Promise(resolve => setImmediate(resolve)); // ownership is released after the operation settles
  }
  const restored = await app.request('/api/kavita/connection/restore', { method: 'POST', headers: { cookie: session } });
  assert.equal(restored.status, 200, 'the snapshot survives a blocked attempt');
  assert.equal(getKavitaConnection().baseUrl, 'http://kavita-previous.invalid');
});

test('malformed bodies are client errors, never 500s or silent resets', async () => {
  setPollIntervalHours(12);
  const routes: [string, string][] = [
    ['POST', '/api/downloads'],
    ['POST', '/api/downloads/library-matches'],
    ['POST', '/api/downloads/duplicates'],
    ['POST', '/api/doujin/search'],
    ['POST', '/api/doujin/gallery'],
    ['POST', '/api/jobs'],
    ['POST', '/api/kavita/connection'],
    ['POST', '/api/kavita/connection/test'],
    ['PUT', '/api/settings/poll-interval'],
    ['PUT', '/api/settings/watched-search-interval'],
    ['PUT', '/api/providers/anilist'],
    ['PUT', '/api/libraries/1/override'],
  ];
  for (const [method, url] of routes) {
    const response = await app.request(url, { method, headers: { 'content-type': 'application/json', cookie: session }, body: 'null' });
    assert.ok(response.status < 500, `${method} ${url} answered ${response.status}`);
  }
  assert.equal(getPollIntervalHours(), 12, 'a null body must not disable background scans');

  const unknownProvider = await app.request('/api/libraries/1/override', json('PUT', { priority: ['not-a-provider'] }, session));
  assert.equal(unknownProvider.status, 400);
  const badCredentials = await app.request('/api/providers/anilist', json('PUT', { credentials: 'secret' }, session));
  assert.equal(badCredentials.status, 400);
});
