import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compareSemver,
  evaluateDockerCompatibility,
  isNewerVersion,
  satisfiesMinNodeVersion,
  UPDATE_BUNDLE_ASSET_NAME,
  UPDATE_MANIFEST_ASSET_NAME,
  type ReleaseUpdateManifest,
  type RuntimeManifest,
} from '../src/contracts/appUpdate.js';
import { selectBootTarget, type ActiveBundlePointer } from '../src/bootstrap.js';
import { buildZip } from '../src/downloader/zip.js';
import { AppUpdateManager, extractUpdateBundleZip } from '../src/services/appUpdate.js';
import { createAppUpdateRoutes } from '../src/routes/api/appUpdate.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRuntimeManifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    version: '4.2.0',
    nodeVersion: '22.22.0',
    minNodeVersion: '22.22.0',
    platform: 'linux',
    arch: 'x64',
    dockerfileSha256: HASH_A,
    runtimeDepsSha256: HASH_B,
    inDocker: true,
    ...overrides,
  };
}

function makeReleaseManifest(overrides: Partial<ReleaseUpdateManifest> = {}): ReleaseUpdateManifest {
  return {
    version: '4.3.0',
    tag: 'v4.3.0',
    minNodeVersion: '22.22.0',
    dockerfileSha256: HASH_A,
    runtimeDepsSha256: HASH_B,
    bundleAssetName: UPDATE_BUNDLE_ASSET_NAME,
    bundleSha256: HASH_C,
    bundleSize: 1024,
    requiresImageReplacement: false,
    imageReplacementReason: null,
    ...overrides,
  };
}

function createSampleBundleZip(version: string): { zip: Buffer; sha256: string } {
  const zip = buildZip([
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'h-tosho', version })) },
    { name: 'server/package.json', data: Buffer.from(JSON.stringify({ name: '@h-tosho/server', version })) },
    { name: 'server/dist/index.js', data: Buffer.from(`console.log("H-Tosho ${version}");\n`) },
    { name: 'web/dist/index.html', data: Buffer.from(`<!doctype html><title>H-Tosho ${version}</title>\n`) },
  ]);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  return { zip, sha256 };
}

test('semver parsing, comparison, and Node engine checks handle standard and prerelease versions', () => {
  assert.equal(compareSemver('4.2.0', 'v4.2.0'), 0);
  assert.equal(compareSemver('4.2.0', '4.3.0'), -1);
  assert.equal(compareSemver('4.3.0', '4.2.9'), 1);
  assert.equal(compareSemver('4.3.0-rc.1', '4.3.0'), -1);
  assert.equal(compareSemver('4.3.0-rc.2', '4.3.0-rc.1'), 1);
  assert.equal(compareSemver('invalid', '4.2.0'), null);

  assert.equal(isNewerVersion('v4.3.0', '4.2.0'), true);
  assert.equal(isNewerVersion('4.2.0', '4.2.0'), false);
  assert.equal(isNewerVersion('4.1.9', '4.2.0'), false);

  assert.equal(satisfiesMinNodeVersion('22.22.0', '>=22.22.0'), true);
  assert.equal(satisfiesMinNodeVersion('24.0.0', '>=22.22.0'), true);
  assert.equal(satisfiesMinNodeVersion('22.10.0', '>=22.22.0'), false);
});

test('evaluateDockerCompatibility allows compatible in-app updates and flags every image-replacement cause', () => {
  const ok = evaluateDockerCompatibility({
    nodeVersion: '22.22.0',
    bootstrapped: true,
    localRuntime: makeRuntimeManifest(),
    releaseManifest: makeReleaseManifest(),
    hasBundleAsset: true,
    dataDirWritable: true,
  });
  assert.deepEqual(ok, []);

  const dockerfileChanged = evaluateDockerCompatibility({
    nodeVersion: '22.22.0',
    bootstrapped: true,
    localRuntime: makeRuntimeManifest({ dockerfileSha256: HASH_A }),
    releaseManifest: makeReleaseManifest({ dockerfileSha256: HASH_C }),
    hasBundleAsset: true,
    dataDirWritable: true,
  });
  assert.deepEqual(dockerfileChanged.map((r) => r.code), ['dockerfile-changed']);

  const depsAndNodeChanged = evaluateDockerCompatibility({
    nodeVersion: '22.22.0',
    bootstrapped: true,
    localRuntime: makeRuntimeManifest({ runtimeDepsSha256: HASH_B }),
    releaseManifest: makeReleaseManifest({
      runtimeDepsSha256: HASH_C,
      minNodeVersion: '24.0.0',
      requiresImageReplacement: true,
      imageReplacementReason: 'SQLite native driver upgraded.',
    }),
    hasBundleAsset: true,
    dataDirWritable: true,
  });
  assert.deepEqual(
    depsAndNodeChanged.map((r) => r.code),
    ['release-requires-image', 'node-version-unsupported', 'runtime-deps-changed'],
  );
  assert.match(depsAndNodeChanged[0].summary, /SQLite native driver upgraded/);

  const legacyWithoutBundle = evaluateDockerCompatibility({
    nodeVersion: '22.22.0',
    bootstrapped: false,
    localRuntime: null,
    releaseManifest: null,
    hasBundleAsset: false,
    dataDirWritable: false,
  });
  assert.deepEqual(
    legacyWithoutBundle.map((r) => r.code),
    ['legacy-image', 'missing-update-bundle', 'data-dir-readonly'],
  );
});

test('selectBootTarget boots valid newer bundles and cleans up superseded or incompatible ones', () => {
  const root = makeTempDir('htosho-boot-');
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const builtinEntry = path.join(appRoot, 'server', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(builtinEntry), { recursive: true });
  fs.writeFileSync(builtinEntry, '// builtin\n');
  fs.writeFileSync(path.join(appRoot, 'server', 'package.json'), JSON.stringify({ version: '4.2.0' }));
  fs.writeFileSync(path.join(appRoot, 'runtime-manifest.json'), JSON.stringify(makeRuntimeManifest()));

  // No pointer yet -> built-in.
  assert.equal(selectBootTarget({ appRoot, builtinEntry, dataDir }).entryPath, builtinEntry);

  // Valid staged bundle for 4.3.0 -> boots bundle.
  const bundleDir = path.join(dataDir, 'updates', 'v4.3.0');
  fs.mkdirSync(path.join(bundleDir, 'server', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'server', 'dist', 'index.js'), '// bundle 4.3.0\n');
  fs.writeFileSync(path.join(bundleDir, 'web', 'dist', 'index.html'), '<html></html>');
  const pointer: ActiveBundlePointer = {
    version: '4.3.0',
    bundleDir,
    installedAt: new Date().toISOString(),
    baseImageVersion: '4.2.0',
    baseDockerfileSha256: HASH_A,
    baseRuntimeDepsSha256: HASH_B,
  };
  fs.writeFileSync(path.join(dataDir, 'updates', 'active.json'), JSON.stringify(pointer));

  const selected = selectBootTarget({ appRoot, builtinEntry, dataDir });
  assert.equal(selected.activeBundleVersion, '4.3.0');
  assert.equal(selected.entryPath, path.join(bundleDir, 'server', 'dist', 'index.js'));

  // Upgrade the base image to 4.3.0 -> stale bundle is removed and built-in boots.
  fs.writeFileSync(path.join(appRoot, 'server', 'package.json'), JSON.stringify({ version: '4.3.0' }));
  const afterImageUpgrade = selectBootTarget({ appRoot, builtinEntry, dataDir });
  assert.equal(afterImageUpgrade.entryPath, builtinEntry);
  assert.equal(afterImageUpgrade.activeBundleDir, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'updates', 'active.json')), false);
  assert.equal(fs.existsSync(bundleDir), false);
});

test('extractUpdateBundleZip extracts valid archives and rejects zip-slip entries', async () => {
  const dir = makeTempDir('htosho-zip-');
  const { zip } = createSampleBundleZip('4.3.0');
  const validZipPath = path.join(dir, 'valid.zip');
  fs.writeFileSync(validZipPath, zip);
  const outDir = path.join(dir, 'out');
  await extractUpdateBundleZip(validZipPath, outDir);
  assert.equal(fs.existsSync(path.join(outDir, 'server', 'dist', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'web', 'dist', 'index.html')), true);

  const evilZipPath = path.join(dir, 'evil.zip');
  fs.writeFileSync(evilZipPath, buildZip([{ name: '../escape.txt', data: Buffer.from('nope') }]));
  await assert.rejects(
    () => extractUpdateBundleZip(evilZipPath, path.join(dir, 'evil-out')),
    /Path traversal entry rejected/,
  );
});

test('Docker compatible bundle update downloads, verifies SHA-256, stages active pointer, and restarts', async () => {
  const root = makeTempDir('htosho-docker-ok-');
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(appRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'runtime-manifest.json'), JSON.stringify(makeRuntimeManifest()));

  const { zip, sha256 } = createSampleBundleZip('4.3.0');
  const manifest = makeReleaseManifest({ bundleSha256: sha256, bundleSize: zip.length });

  let restarted = false;
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: 'v4.3.0',
        name: 'v4.3.0',
        body: 'Bug fixes and UI polish.',
        html_url: 'https://github.com/hiranaka99/H-Tosho/releases/tag/v4.3.0',
        published_at: '2026-11-25T10:00:00Z',
        assets: [
          { name: UPDATE_MANIFEST_ASSET_NAME, browser_download_url: 'https://github.com/hiranaka99/H-Tosho/releases/download/v4.3.0/h-tosho-update-manifest.json', size: 300 },
          { name: UPDATE_BUNDLE_ASSET_NAME, browser_download_url: 'https://github.com/hiranaka99/H-Tosho/releases/download/v4.3.0/h-tosho-update-bundle.zip', size: zip.length },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith(UPDATE_MANIFEST_ASSET_NAME)) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith(UPDATE_BUNDLE_ASSET_NAME)) {
      return new Response(new Uint8Array(zip), { status: 200, headers: { 'content-length': String(zip.length) } });
    }
    return new Response('not found', { status: 404 });
  };

  const manager = new AppUpdateManager({
    appRoot,
    dataDir,
    currentVersion: '4.2.0',
    nodeVersion: '22.22.0',
    env: { HTOSHO_IN_DOCKER: '1', HTOSHO_BOOTSTRAPPED: '1', HTOSHO_BASE_IMAGE_VERSION: '4.2.0' },
    fetchFn,
    getActiveWork: () => ({ jobs: 0, downloads: 0 }),
    onRestartRequested: () => { restarted = true; },
    restartDelayMs: 10,
  });

  const status = await manager.getStatus({ force: true });
  assert.equal(status.installMode, 'docker');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canUpdateInApp, true);
  assert.equal(status.docker?.requiresImageReplacement, false);

  const routes = createAppUpdateRoutes(manager);
  const applyRes = await routes.request('/app-update/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetVersion: '4.3.0' }),
  });
  assert.equal(applyRes.status, 202);

  // Wait for async download/extract/restart to settle.
  for (let i = 0; i < 40; i++) {
    const current = await manager.getStatus();
    if (current.progress.phase === 'restarting' || current.progress.phase === 'failed') break;
    await new Promise((r) => setTimeout(r, 25));
  }

  const finalStatus = await manager.getStatus();
  assert.equal(finalStatus.progress.phase, 'restarting', finalStatus.progress.error ?? undefined);
  const pointer = JSON.parse(fs.readFileSync(path.join(dataDir, 'updates', 'active.json'), 'utf8')) as ActiveBundlePointer;
  assert.equal(pointer.version, '4.3.0');
  assert.equal(fs.existsSync(path.join(pointer.bundleDir, 'node_modules')), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(restarted, true);
});

test('Docker release requiring image replacement warns clearly and blocks in-app apply with 409', async () => {
  const root = makeTempDir('htosho-docker-replace-');
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'runtime-manifest.json'), JSON.stringify(makeRuntimeManifest({ dockerfileSha256: HASH_A, runtimeDepsSha256: HASH_B })));

  const manifest = makeReleaseManifest({ dockerfileSha256: HASH_C, runtimeDepsSha256: HASH_C });
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: 'v4.3.0',
        name: 'v4.3.0',
        body: 'Upgraded base image and better-sqlite3.',
        html_url: 'https://github.com/hiranaka99/H-Tosho/releases/tag/v4.3.0',
        assets: [
          { name: UPDATE_MANIFEST_ASSET_NAME, browser_download_url: 'https://github.com/hiranaka99/H-Tosho/releases/download/v4.3.0/h-tosho-update-manifest.json', size: 300 },
          { name: UPDATE_BUNDLE_ASSET_NAME, browser_download_url: 'https://github.com/hiranaka99/H-Tosho/releases/download/v4.3.0/h-tosho-update-bundle.zip', size: 1024 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const manager = new AppUpdateManager({
    appRoot,
    dataDir,
    currentVersion: '4.2.0',
    nodeVersion: '22.22.0',
    env: { HTOSHO_IN_DOCKER: '1', HTOSHO_BOOTSTRAPPED: '1' },
    fetchFn,
    getActiveWork: () => ({ jobs: 0, downloads: 0 }),
  });

  const routes = createAppUpdateRoutes(manager);
  const statusRes = await routes.request('/app-update/status');
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json() as {
    canUpdateInApp: boolean;
    docker: { requiresImageReplacement: boolean; reasons: { code: string }[] };
  };
  assert.equal(status.canUpdateInApp, false);
  assert.equal(status.docker.requiresImageReplacement, true);
  assert.deepEqual(status.docker.reasons.map((r) => r.code), ['dockerfile-changed', 'runtime-deps-changed']);

  const applyRes = await routes.request('/app-update/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetVersion: '4.3.0' }),
  });
  assert.equal(applyRes.status, 409);
  const errBody = await applyRes.json() as { error: string };
  assert.match(errBody.error, /replacing the Docker image/i);
});

test('bundle checksum mismatch fails safely without writing active.json or restarting', async () => {
  const root = makeTempDir('htosho-bad-sha-');
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'runtime-manifest.json'), JSON.stringify(makeRuntimeManifest()));

  const { zip } = createSampleBundleZip('4.3.0');
  const manifest = makeReleaseManifest({ bundleSha256: '0'.repeat(64), bundleSize: zip.length });
  let restarted = false;

  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: 'v4.3.0',
        name: 'v4.3.0',
        assets: [
          { name: UPDATE_MANIFEST_ASSET_NAME, browser_download_url: 'https://github.com/hiranaka99/H-Tosho/releases/download/v4.3.0/h-tosho-update-manifest.json', size: 300 },
          { name: UPDATE_BUNDLE_ASSET_NAME, browser_download_url: 'https://github.com/hiranaka99/H-Tosho/releases/download/v4.3.0/h-tosho-update-bundle.zip', size: zip.length },
        ],
      }), { status: 200 });
    }
    if (url.endsWith(UPDATE_MANIFEST_ASSET_NAME)) return new Response(JSON.stringify(manifest), { status: 200 });
    return new Response(new Uint8Array(zip), { status: 200 });
  };

  const manager = new AppUpdateManager({
    appRoot,
    dataDir,
    currentVersion: '4.2.0',
    nodeVersion: '22.22.0',
    env: { HTOSHO_IN_DOCKER: '1', HTOSHO_BOOTSTRAPPED: '1' },
    fetchFn,
    getActiveWork: () => ({ jobs: 0, downloads: 0 }),
    onRestartRequested: () => { restarted = true; },
  });

  await manager.startUpdate('4.3.0');
  for (let i = 0; i < 40; i++) {
    const s = await manager.getStatus();
    if (s.progress.phase === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const final = await manager.getStatus();
  assert.equal(final.progress.phase, 'failed');
  assert.match(final.progress.error ?? '', /Checksum verification failed/);
  assert.equal(fs.existsSync(path.join(dataDir, 'updates', 'active.json')), false);
  assert.equal(restarted, false);
});

test('Git checkout updates cleanly, blocks on active work, and rolls back on build failure', async () => {
  const root = makeTempDir('htosho-git-');
  const appRoot = path.join(root, 'repo');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(appRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ version: '4.2.0', engines: { node: '>=22.22.0' } }));
  fs.writeFileSync(path.join(appRoot, 'package-lock.json'), '{}');

  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    tag_name: 'v4.3.0',
    name: 'v4.3.0',
    body: 'Release notes.',
    html_url: 'https://github.com/hiranaka99/H-Tosho/releases/tag/v4.3.0',
    assets: [],
  }), { status: 200 });

  const commands: string[] = [];
  let failBuild = true;
  let activeJobs = 1;
  let restarted = false;

  const execFn = async (cmd: string, args: string[]) => {
    commands.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n', stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'abc1234\n', stderr: '' };
    if (cmd.startsWith('npm') && args[0] === 'run' && args[1] === 'build' && failBuild) {
      throw new Error('tsc failed');
    }
    return { stdout: '', stderr: '' };
  };

  const manager = new AppUpdateManager({
    appRoot,
    dataDir,
    currentVersion: '4.2.0',
    nodeVersion: '22.22.0',
    env: { HTOSHO_IN_DOCKER: '0' },
    isDevelopment: false,
    fetchFn,
    execFn,
    getActiveWork: () => ({ jobs: activeJobs, downloads: 0 }),
    onRestartRequested: () => { restarted = true; },
    restartDelayMs: 5,
  });

  // Blocked while active jobs exist.
  await assert.rejects(() => manager.startUpdate('4.3.0'), /1 active task/);

  // Build fails -> rolls back git to main @ abc1234.
  activeJobs = 0;
  await manager.startUpdate('4.3.0');
  for (let i = 0; i < 40; i++) {
    if ((await manager.getStatus()).progress.phase === 'failed') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal((await manager.getStatus()).progress.phase, 'failed');
  assert.ok(commands.includes('git checkout main'), 'must restore previous branch on failure');
  assert.ok(commands.includes('git reset --hard abc1234'), 'must restore previous SHA on failure');
  assert.equal(restarted, false);

  // Retry succeeds -> triggers restart.
  failBuild = false;
  await manager.startUpdate('4.3.0');
  for (let i = 0; i < 40; i++) {
    if ((await manager.getStatus()).progress.phase === 'restarting') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal((await manager.getStatus()).progress.phase, 'restarting');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(restarted, true);
});

test('rollback notice is surfaced in status and cleared via dismiss endpoint', async () => {
  const root = makeTempDir('htosho-rollback-');
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'updates', 'rollback.json'),
    JSON.stringify({ version: '4.3.0', rolledBackAt: new Date().toISOString(), exitCode: 1 }),
  );

  const manager = new AppUpdateManager({
    appRoot,
    dataDir,
    currentVersion: '4.2.0',
    env: { HTOSHO_IN_DOCKER: '1', HTOSHO_UPDATE_CHECK_DISABLED: '1' },
    getActiveWork: () => ({ jobs: 0, downloads: 0 }),
  });
  const routes = createAppUpdateRoutes(manager);

  const first = await (await routes.request('/app-update/status')).json() as { rolledBackVersion: string | null };
  assert.equal(first.rolledBackVersion, '4.3.0');

  const dismiss = await routes.request('/app-update/dismiss-rollback', { method: 'POST' });
  assert.equal(dismiss.status, 200);

  const second = await (await routes.request('/app-update/status')).json() as { rolledBackVersion: string | null };
  assert.equal(second.rolledBackVersion, null);
});
