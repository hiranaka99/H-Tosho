import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-ehentai-account-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports: the DB and account modules snapshot HTOSHO_DATA_DIR at load.
const { initDb, getDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');

initDb();
const app = createApp();

const IPB_ID = '77031234';
const IPB_HASH = '0a1b2c3d4e5f6071';
const IGNEOUS = 'deadbeefcafe';
const SESSION = { ipb_member_id: IPB_ID, ipb_pass_hash: IPB_HASH, igneous: IGNEOUS };

let sessionCookie = '';

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('setup (once for the whole file)', async () => {
  const response = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ehentai-test', password: 'ehentai-test-password' }),
  });
  assert.equal(response.status, 201);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'setup must set a session cookie');
  sessionCookie = setCookie.split(';', 1)[0];
});

test('GET before any account is configured reports unconfigured with revision 0', async () => {
  const response = await app.request('/api/settings/ehentai', json('GET'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const view = await response.json();
  assert.equal(view.configured, false);
  assert.equal(view.revision, 0);
  assert.equal(view.hasIgneous, false);
  assert.equal(view.sessionError, null);
});

test('save stores the encrypted session and exposes no secrets', async () => {
  const response = await app.request('/api/settings/ehentai', json('PUT', { site: 'exhentai', session: SESSION, expectedRevision: 0 }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const view = await response.json();
  assert.equal(view.configured, true);
  assert.equal(view.revision, 1);
  assert.equal(view.hasIgneous, true);
  assert.equal(view.site, 'exhentai');

  const text = JSON.stringify(view);
  for (const secret of [IPB_HASH, IGNEOUS]) {
    assert.ok(!text.includes(secret), `response must not leak ${secret === IPB_HASH ? 'ipb_pass_hash' : 'igneous'}`);
  }

  const stored = await app.request('/api/settings/ehentai', json('GET'));
  const storedText = await stored.text();
  for (const secret of [IPB_HASH, IGNEOUS, IPB_ID]) {
    assert.ok(!storedText.includes(secret), 'GET must not leak any cookie value');
  }
  // The unrelated downloader settings endpoint stays clean too.
  const downloader = await app.request('/api/settings/downloader', json('GET'));
  const downloaderText = await downloader.text();
  for (const secret of [IPB_HASH, IGNEOUS, IPB_ID]) {
    assert.ok(!downloaderText.includes(secret));
  }
});

test('concurrent-save protection: stale expectedRevision conflicts (409)', async () => {
  const response = await app.request('/api/settings/ehentai', json('PUT', { site: 'exhentai', session: SESSION, expectedRevision: 0 }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.ok(body.error);
  // The failed save must not have changed the revision.
  const current = await (await app.request('/api/settings/ehentai', json('GET'))).json();
  assert.equal(current.revision, 1);
});

test('save with the current revision bumps it; omitted fields keep their values', async () => {
  // Omitting `site` and `session` keeps the existing values; the revision must still match.
  let response = await app.request('/api/settings/ehentai', json('PUT', { expectedRevision: 1 }));
  assert.equal(response.status, 200);
  let view = await response.json();
  assert.equal(view.revision, 2);
  assert.equal(view.configured, true, 'omitting the session must not clear the stored one');
  assert.equal(view.hasIgneous, true);
  assert.equal(view.site, 'exhentai');

  // Changing the site works and bumps the revision again.
  response = await app.request('/api/settings/ehentai', json('PUT', { site: 'e-hentai', expectedRevision: 2 }));
  assert.equal(response.status, 200);
  view = await response.json();
  assert.equal(view.revision, 3);
  assert.equal(view.site, 'e-hentai');

  // Restore exhentai for the remaining tests.
  response = await app.request('/api/settings/ehentai', json('PUT', { site: 'exhentai', expectedRevision: 3 }));
  assert.equal(response.status, 200);
  await response.json();
});

test('session validation rejects malformed cookie input', async () => {
  const badSessions: unknown[] = [
    { ipb_member_id: IPB_ID, ipb_pass_hash: IPB_HASH }, // missing required pair? No — igneous is optional; this must SUCCEED.
  ];
  // The above is actually valid: verify it is accepted (igneous is optional).
  const ok = await app.request('/api/settings/ehentai', json('PUT', { session: badSessions[0], expectedRevision: 4 }));
  assert.equal(ok.status, 200);

  const cases: Array<unknown> = [
    { ipb_member_id: '1\r2', ipb_pass_hash: IPB_HASH },
    { ipb_member_id: IPB_ID, ipb_pass_hash: 'hash;with=semicolon' },
    { ipb_member_id: '', ipb_pass_hash: IPB_HASH },
    { ipb_member_id: 'x'.repeat(64), ipb_pass_hash: IPB_HASH },
    { ipb_member_id: IPB_ID, ipb_pass_hash: 'x'.repeat(2049) },
    { ipb_member_id: IPB_ID, ipb_pass_hash: IPB_HASH, igneous: 'x'.repeat(129) },
    { ipb_member_id: ['1'], ipb_pass_hash: IPB_HASH },
    'not-an-object',
    null,
  ];
  for (const session of cases) {
    const response = await app.request('/api/settings/ehentai', json('PUT', { session, expectedRevision: 5 }));
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(session).slice(0, 60)}`);
  }
  // An invalid site name is rejected before any write.
  const badSite = await app.request('/api/settings/ehentai', json('PUT', { site: 'exhentai.evil.test', session: SESSION, expectedRevision: 5 }));
  assert.equal(badSite.status, 400);
  // Unknown body fields are rejected (no silent expansion of the record).
  const extra = await app.request('/api/settings/ehentai', json('PUT', { session: SESSION, expectedRevision: 5, evil: true }));
  assert.equal(extra.status, 400);
});

test('delete removes the session, bumps the revision, and requires the current revision', async () => {
  const view = await (await app.request('/api/settings/ehentai', json('GET'))).json();
  const currentRevision = view.revision;

  const stale = await app.request('/api/settings/ehentai', json('DELETE', { expectedRevision: currentRevision - 1 }));
  assert.equal(stale.status, 409);

  const ok = await app.request('/api/settings/ehentai', json('DELETE', { expectedRevision: currentRevision }));
  assert.equal(ok.status, 200);
  const removed = await ok.json();
  assert.equal(removed.configured, false);
  assert.equal(removed.revision, currentRevision + 1);
  assert.equal(removed.hasIgneous, false);

  // After removal, testing the saved account must fail with a clear 400.
  const testSaved = await app.request('/api/settings/ehentai/test', json('POST', { mode: 'saved' }));
  assert.equal(testSaved.status, 400);
});

test('draft tests require a complete session and never save', async () => {
  const missing = await app.request('/api/settings/ehentai/test', json('POST', { mode: 'draft', session: { ipb_member_id: IPB_ID } }));
  assert.equal(missing.status, 400);

  const badMode = await app.request('/api/settings/ehentai/test', json('POST', { mode: 'both' }));
  assert.equal(badMode.status, 400);

  const view = await (await app.request('/api/settings/ehentai', json('GET'))).json();
  assert.equal(view.configured, false, 'draft attempts must not create an account');
});

test('stored session survives a process restart and never leaks in responses (separate process)', async () => {
  // Re-save through the API, then read the record from a fresh process.
  const before = await (await app.request('/api/settings/ehentai', json('GET'))).json();
  const seed = await app.request('/api/settings/ehentai', json('PUT', { site: 'exhentai', session: SESSION, expectedRevision: before.revision }));
  assert.equal(seed.status, 200);

  const srcDir = path.join(import.meta.dirname, '..', 'src');
  const dbUrl = pathToFileURL(path.join(srcDir, 'db', 'index.js')).href;
  const accountUrl = pathToFileURL(path.join(srcDir, 'services', 'ehentaiAccount.js')).href;
  const script = `
    process.env.HTOSHO_DATA_DIR = ${JSON.stringify(dataDir)};
    const main = async () => {
      const { initDb, getDb, schema } = await import(${JSON.stringify(dbUrl)});
      initDb();
      const row = getDb().select().from(schema.keyValueStore).all().find(r => r.key === 'ehentai_account');
      if (!row) throw new Error('ehentai_account row missing after restart');
      const record = JSON.parse(row.valueJson);
      const { getStoredSession, getEhentaiAccountView } = await import(${JSON.stringify(accountUrl)});
      const session = getStoredSession();
      const secrets = [${JSON.stringify(IPB_HASH)}, ${JSON.stringify(IGNEOUS)}];
      console.log(JSON.stringify({
        hasEnvelope: record.envelope !== null,
        revision: record.revision,
        matches: session && session.ipb_member_id === ${JSON.stringify(IPB_ID)} && session.ipb_pass_hash === ${JSON.stringify(IPB_HASH)} && session.igneous === ${JSON.stringify(IGNEOUS)},
        rawLeaks: secrets.map(s => row.valueJson.includes(s)),
        viewLeaks: (() => { const v = JSON.stringify(getEhentaiAccountView()); return secrets.some(s => v.includes(s)); })(),
      }));
    };
    main().catch((error) => { console.error(error); process.exit(1); });
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8' });
  const result = JSON.parse(out.trim().split('\n').pop() ?? '{}');
  assert.equal(result.hasEnvelope, true, 'the envelope must persist');
  assert.equal(result.matches, true, 'a fresh process must decrypt the stored session to the saved cookies');
  assert.deepEqual(result.rawLeaks, [false, false], 'the stored record must not contain the plaintext cookies');
  assert.equal(result.viewLeaks, false, 'the public view must not leak secrets');
});

test('a corrupted key is an explicit error, not a silent reset', async () => {
  const keyFile = path.join(dataDir, 'ehentai-account.key');
  const originalKey = fs.readFileSync(keyFile);
  const srcDir = path.join(import.meta.dirname, '..', 'src');
  const dbUrl = pathToFileURL(path.join(srcDir, 'db', 'index.js')).href;
  const accountUrl = pathToFileURL(path.join(srcDir, 'services', 'ehentaiAccount.js')).href;
  try {
    // Corrupt the key material in a FRESH process (the in-process service
    // caches its key, so the fresh load must hit the corrupt file).
    fs.writeFileSync(keyFile, Buffer.from('not-a-real-key-material-000'));
    const script = `
      process.env.HTOSHO_DATA_DIR = ${JSON.stringify(dataDir)};
      const main = async () => {
        const { initDb, getDb, schema } = await import(${JSON.stringify(dbUrl)});
        initDb();
        const row = getDb().select().from(schema.keyValueStore).all().find(r => r.key === 'ehentai_account');
        const { getStoredSession, getEhentaiAccountView, EhentaiAccountCryptoError } = await import(${JSON.stringify(accountUrl)});
        let sessionError = null;
        try { getStoredSession(); } catch (error) { sessionError = error instanceof EhentaiAccountCryptoError ? 'crypto' : String(error); }
        const view = getEhentaiAccountView();
        console.log(JSON.stringify({
          recordStillStored: row !== undefined && row.valueJson.includes('"envelope"'),
          sessionError,
          viewConfigured: view.configured,
          viewSessionError: view.sessionError !== null,
          viewHasIgneous: view.hasIgneous,
        }));
      };
      main().catch((error) => { console.error(error); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8' });
    const result = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    assert.equal(result.recordStillStored, true, 'a corrupt key must never wipe the stored record');
    assert.equal(result.sessionError, 'crypto', 'decrypt must surface an explicit crypto error');
    assert.equal(result.viewConfigured, true, 'the view must still report the account as configured');
    assert.equal(result.viewSessionError, true, 'the view must carry an explicit session error');
    assert.equal(result.viewHasIgneous, false);
  } finally {
    fs.writeFileSync(keyFile, originalKey);
  }

  // The in-process record is intact: a re-save repairs and the view clears.
  const current = (async () => (await (await app.request('/api/settings/ehentai', json('GET'))).json()))();
  const revision = (await current).revision;
  const repair = await app.request('/api/settings/ehentai', json('PUT', { site: 'exhentai', session: SESSION, expectedRevision: revision }));
  assert.equal(repair.status, 200);
  const repaired = await repair.json();
  assert.equal(repaired.sessionError, null);
  assert.equal(repaired.hasIgneous, true);
});

after(() => {
  // Release the SQLite handle before deleting: Windows refuses to remove a
  // directory containing an open database file.
  try { getDb().$client.close(); } catch { /* already closed */ }
  // Windows can hold directory handles briefly after a child process exits;
  // retry before surfacing a failure.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= 15) throw new Error(`Could not remove test data dir: ${dataDir}`);
      const end = Date.now() + 100;
      while (Date.now() < end) { /* synchronous backoff */ }
    }
  }
});
