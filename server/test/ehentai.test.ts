import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseEhentaiGalleryId, parseEhentaiGalleryUrl,
  ehentaiGalleryUrl, ehentaiSiteForHost,
} from '../src/contracts/doujin.js';
import { classifyAccessEvidence } from '../src/downloader/ehentaiClient.js';
import { getEhentaiGate, resetEhentaiGate, RequestAbortedError } from '../src/downloader/ehentaiGate.js';

const GID = '4644932';
const TOKEN = 'abcdef012345';

// ---------------- gallery identity ----------------

test('parseEhentaiGalleryId accepts gid-token pairs and rejects anything else', () => {
  const parsed = parseEhentaiGalleryId(`${GID}-${TOKEN}`);
  assert.deepEqual(parsed, { gid: GID, token: TOKEN, canonicalId: `${GID}-${TOKEN}` });
  // Uppercase tokens canonicalize to lowercase.
  assert.deepEqual(parseEhentaiGalleryId(`${GID}-ABCDEF012345`), { gid: GID, token: TOKEN, canonicalId: `${GID}-${TOKEN}` });
  // Surrounding whitespace is trimmed before validation.
  assert.deepEqual(parseEhentaiGalleryId(` ${GID}-${TOKEN} `), { gid: GID, token: TOKEN, canonicalId: `${GID}-${TOKEN}` });
  for (const value of [
    '', '   ', GID, // a bare gid without its token is never an identity
    '04644932-abcdef012345', // leading-zero gid
    '-1-abcdef012345', '1.5-abcdef012345', 'abc-abcdef012345',
    `${GID}-abcdef01234`, // 11-char token
    `${GID}-abcdef0123456`, // 13-char token
    `${GID}-xyzdef012345`, // non-hex token
    '99999999999-abcdef012345', // 11-digit gid
    `${GID}-${TOKEN}extra`,
  ]) {
    assert.equal(parseEhentaiGalleryId(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test('parseEhentaiGalleryUrl accepts only exact-host HTTPS gallery URLs', () => {
  const accepted: Array<[string, 'e-hentai' | 'exhentai']> = [
    [`https://exhentai.org/g/${GID}/${TOKEN}/`, 'exhentai'],
    [`https://exhentai.org/g/${GID}/${TOKEN}`, 'exhentai'], // trailing slash optional
    [`https://exhentai.org:443/g/${GID}/${TOKEN}/`, 'exhentai'], // default port normalizes away
    [`https://e-hentai.org/g/${GID}/${TOKEN}/`, 'e-hentai'],
  ];
  for (const [raw, site] of accepted) {
    const parsed = parseEhentaiGalleryUrl(raw);
    assert.ok(parsed, raw);
    assert.equal(parsed.site, site, raw);
    assert.equal(parsed.canonicalId, `${GID}-${TOKEN}`, raw);
    assert.equal(parsed.url, ehentaiGalleryUrl(site, GID, TOKEN), raw);
  }
  for (const raw of [
    `http://exhentai.org/g/${GID}/${TOKEN}/`, // plain http is never a safe reference
    `https://exhentai.org:8443/g/${GID}/${TOKEN}/`, // non-default port fails exact-host
    `https://www.exhentai.org/g/${GID}/${TOKEN}/`,
    `https://exhentai.co/g/${GID}/${TOKEN}/`,
    `https://evil.com/g/${GID}/${TOKEN}/`,
    `https://exhentai.org/?u=g/${GID}/${TOKEN}/`,
    `https://exhentai.org/gallery/${GID}-${TOKEN}`, // /gallery/ form is not a locator
    `https://exhentai.org/g/${GID}/`,
    `https://exhentai.org/g/0${GID}/${TOKEN}/`,
    `https://user:pass@exhentai.org/g/${GID}/${TOKEN}/`,
    `https://exhentai.org/g/${GID}/${TOKEN}?page=1`,
    `https://exhentai.org/g/${GID}/${TOKEN}#extra`,
  ]) {
    assert.equal(parseEhentaiGalleryUrl(raw), null, `expected null for ${raw}`);
  }
});

test('identity is host-agnostic and distinct per gallery', () => {
  const a = parseEhentaiGalleryUrl(`https://exhentai.org/g/${GID}/${TOKEN}/`)!;
  const b = parseEhentaiGalleryUrl(`https://e-hentai.org/g/${GID}/${TOKEN}/`)!;
  const c = parseEhentaiGalleryId(`${GID}-0123456789ab`)!;
  assert.equal(a.canonicalId, b.canonicalId, 'the same gallery on either family host is one entry');
  assert.notEqual(a.canonicalId, c.canonicalId);
  assert.equal(ehentaiGalleryUrl('exhentai', GID, TOKEN), `https://exhentai.org/g/${GID}/${TOKEN}/`);
  assert.equal(ehentaiGalleryUrl('e-hentai', GID, TOKEN), `https://e-hentai.org/g/${GID}/${TOKEN}/`);
  assert.equal(ehentaiSiteForHost('EXHENTAI.ORG'), 'exhentai');
  assert.equal(ehentaiSiteForHost('exhentai.org.evil.test'), null);
});

// ---------------- access classification ----------------

const page = (status: number, finalUrl: string, body = ''): { status: number; finalUrl: string; body: string } => ({ status, finalUrl, body });

test('classifyAccessEvidence requires a member page for verified', () => {
  const memberBody = '<form name="favform"></form>function update_fav_action(selbox) {}';
  assert.equal(classifyAccessEvidence('exhentai', page(200, 'https://exhentai.org/favorites.php', memberBody)).state, 'verified');
  assert.equal(classifyAccessEvidence('e-hentai', page(200, 'https://e-hentai.org/favorites.php', memberBody)).state, 'verified');
  // The public front page is identical for guests and members, so a plain
  // gallery list must never verify a session.
  assert.equal(
    classifyAccessEvidence('e-hentai', page(200, 'https://e-hentai.org/', '<table class="itg gltc">gallery list</table>')).state,
    'unavailable',
  );
  // HTTP 200 without a member page is never verified.
  assert.equal(classifyAccessEvidence('exhentai', page(200, 'https://exhentai.org/favorites.php', '<html>hello</html>')).state, 'unavailable');
});

test('classifyAccessEvidence detects denials, including login redirects and empty ExHentai responses', () => {
  assert.equal(classifyAccessEvidence('exhentai', page(200, 'https://exhentai.org/favorites.php', 'ExHentai is only available to registered E-Hentai users.')).state, 'denied');
  assert.equal(classifyAccessEvidence('exhentai', page(403, 'https://exhentai.org/favorites.php', '')).state, 'denied');
  // Guests hitting a member page are redirected to the login form.
  assert.equal(classifyAccessEvidence('e-hentai', page(200, 'https://e-hentai.org/login.php', 'login form')).state, 'denied');
  assert.equal(classifyAccessEvidence('exhentai', page(200, 'https://exhentai.org/login.php', '<table class="itg gltc">')).state, 'denied');
  // ExHentai answers 200 with an empty body for sessions without ExHentai
  // access (observed live).
  assert.equal(classifyAccessEvidence('exhentai', page(200, 'https://exhentai.org/favorites.php', '')).state, 'denied');
  // A 200 on the member page that is neither a member page nor a known
  // denial is an unknown response, not a denial.
  assert.equal(classifyAccessEvidence('e-hentai', page(200, 'https://e-hentai.org/favorites.php', '<html>hello</html>')).state, 'unavailable');
});

test('classifyAccessEvidence keeps quota, rate-limit, content gates, and outages distinct', () => {
  assert.equal(classifyAccessEvidence('exhentai', page(509, 'https://exhentai.org/')).state, 'quota-limited');
  assert.equal(classifyAccessEvidence('exhentai', page(429, 'https://exhentai.org/')).state, 'rate-limited');
  assert.equal(classifyAccessEvidence('e-hentai', page(503, 'https://e-hentai.org/')).state, 'unavailable');
  assert.equal(classifyAccessEvidence('e-hentai', page(200, 'https://e-hentai.org/', 'Content Warning: adult content only.')).state, 'content-warning');
});

// ---------------- request gate ----------------
//
// The gate IS a wall-clock pacing mechanism; these tests deliberately
// exercise real intervals (the production contract is a real-time minimum
// gap), so fake timers would mock the behavior under test. Gaps are kept
// small to keep the suite fast.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('gate paces sequential starts by at least the minimum gap', async () => {
  resetEhentaiGate({ html: { minGapMs: 80, maxConcurrent: 4 } });
  const gate = getEhentaiGate();
  const startedAt = Date.now();
  const release1 = await gate.html.acquire();
  release1();
  await gate.html.acquire().then((release) => release());
  assert.ok(Date.now() - startedAt >= 80, 'the second start must wait for the pacing gap');
});

test('gate bounds per-lane concurrency; lanes are independent', async () => {
  resetEhentaiGate({ html: { minGapMs: 20, maxConcurrent: 1 }, api: { minGapMs: 0, maxConcurrent: 1 } });
  const gate = getEhentaiGate();
  const order: string[] = [];
  const htmlHold = gate.html.acquire().then(async (release) => {
    order.push('html-start');
    await sleep(60); // hold the html slot
    order.push('html-end');
    release();
  });
  const htmlSecond = gate.html.acquire().then(async (release) => {
    // One html request in flight: the second must start after the first ends
    // (the api lane interleaving is fine — lanes are independent).
    const htmlOrder = order.filter((entry) => entry.startsWith('html'));
    assert.deepEqual(htmlOrder, ['html-start', 'html-end'], 'second html request started while the first was active');
    order.push('html-second');
    release();
  });
  // The api lane is a separate lane: it proceeds while html is busy.
  const apiRequest = gate.api.acquire().then(async (release) => {
    order.push('api');
    release();
  });
  const result = await Promise.all([htmlHold, htmlSecond, apiRequest]);
  assert.ok(Array.isArray(result));
  assert.equal(order[order.length - 1], 'html-second', 'the second html request finishes last');
  assert.deepEqual(order.sort(), ['api', 'html-end', 'html-second', 'html-start']);
});

test('gate cooldown defers starts and reports remaining time', async () => {
  resetEhentaiGate({ html: { minGapMs: 20, maxConcurrent: 1 } });
  const gate = getEhentaiGate();
  gate.html.setCooldown(Date.now() + 100);
  assert.ok(gate.html.cooldownRemainingMs() >= 70, 'cooldown must be reported');
  const startedAt = Date.now();
  const release = await gate.html.acquire();
  release();
  assert.ok(Date.now() - startedAt >= 70, 'the start must wait out the cooldown');
  // A longer cooldown is a strict increase; shorter ones never move it back.
  gate.html.setCooldown(Date.now() + 60_000);
  assert.ok(gate.html.cooldownRemainingMs() > 59_000);
  gate.html.setCooldown(Date.now() + 10);
  assert.ok(gate.html.cooldownRemainingMs() > 59_000, 'an earlier cooldown must not shorten a longer one');
});

test('gate honors caller cancellation, including queued waiters', async () => {
  resetEhentaiGate({ html: { minGapMs: 20, maxConcurrent: 1 } });
  const gate = getEhentaiGate();

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(gate.html.acquire(preAborted.signal), (error: unknown) => error instanceof RequestAbortedError);

  const first = gate.html.acquire().then(async (release) => {
    await sleep(60);
    release();
  });
  const queued = new AbortController();
  const second = gate.html.acquire(queued.signal);
  await sleep(20); // let the waiter enter the queue
  queued.abort();
  await assert.rejects(second, (error: unknown) => error instanceof RequestAbortedError);
  await first;
});

test('gate reset drops pacing state and restores production defaults', async () => {
  resetEhentaiGate({ html: { minGapMs: 80, maxConcurrent: 1 } });
  const gate = getEhentaiGate();
  const release = await gate.html.acquire();
  release();
  gate.html.setCooldown(Date.now() + 1000);
  resetEhentaiGate(); // production defaults again: 3000ms gap, fresh lanes
  const fresh = getEhentaiGate();
  assert.notEqual(fresh, gate);
  assert.equal(fresh.html.cooldownRemainingMs(), 0, 'cooldown state must not survive a reset');

  // The first start on a fresh lane is immediate; the SECOND start must sit
  // out the full production 3000ms gap. Verify it is still parked at 250ms
  // without waiting for the gap itself.
  const firstRelease = await fresh.html.acquire();
  firstRelease();
  const controller = new AbortController();
  const parked = fresh.html.acquire(controller.signal);
  const settledBy = await Promise.race([
    parked.then(() => 'settled'),
    sleep(250).then(() => 'still-parked'),
  ]);
  assert.equal(settledBy, 'still-parked', 'the second start must wait for the production 3s gap');
  controller.abort();
  await assert.rejects(parked, (error: unknown) => error instanceof RequestAbortedError);
});

resetEhentaiGate();
