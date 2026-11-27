import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import {
  compareSemver,
  evaluateDockerCompatibility,
  IDLE_UPDATE_PROGRESS,
  isNewerVersion,
  parseMinNodeVersion,
  parseSemver,
  satisfiesMinNodeVersion,
  UPDATE_BUNDLE_ASSET_NAME,
  UPDATE_MANIFEST_ASSET_NAME,
  type AppUpdateStatus,
  type DockerUpdateGuidance,
  type InstallMode,
  type ReleaseUpdateManifest,
  type RuntimeManifest,
  type UpdateProgress,
  type UpdateReleaseInfo,
} from '../contracts/appUpdate.js';
import { DATA_DIR } from '../db/index.js';
import { downloadQueue } from '../downloader/engine.js';
import { jobQueue } from '../jobs/queue.js';
import { readZipEntries } from '../lib/cbz.js';
import { crc32 } from '../lib/crc.js';
import { resolveUpdatesDir, type ActiveBundlePointer, type RollbackRecord } from '../bootstrap.js';

const execFileAsync = promisify(execFile);

const DEFAULT_REPO = 'hiranaka99/H-Tosho';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const BUNDLE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_BUNDLE_BYTES = 150 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_RELEASE_NOTES_CHARS = 16_000;

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNING_TS_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts');

export class AppUpdateError extends Error {
  constructor(message: string, public readonly status: 400 | 409 | 502 = 400) {
    super(message);
    this.name = 'AppUpdateError';
  }
}

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GitHubReleaseResponse {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

interface CachedReleaseCheck {
  checkedAt: string;
  checkedAtMs: number;
  error: string | null;
  release: UpdateReleaseInfo | null;
  manifest: ReleaseUpdateManifest | null;
  bundleDownloadUrl: string | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<ExecResult>;

export interface AppUpdateManagerOptions {
  appRoot?: string;
  dataDir?: string;
  currentVersion?: string;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  isDevelopment?: boolean;
  repo?: string;
  fetchFn?: typeof fetch;
  execFn?: ExecFn;
  getActiveWork?: () => { jobs: number; downloads: number };
  onRestartRequested?: () => void;
  allowAnyDownloadHost?: boolean;
  restartDelayMs?: number;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readPackageVersion(appRoot: string, activeBundleDir?: string): string {
  const candidates = [
    ...(activeBundleDir ? [path.join(activeBundleDir, 'server', 'package.json'), path.join(activeBundleDir, 'package.json')] : []),
    path.join(appRoot, 'server', 'package.json'),
    path.join(appRoot, 'package.json'),
  ];
  for (const file of candidates) {
    const pkg = readJsonSafe<{ version?: unknown }>(file);
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  }
  return '0.0.0';
}

function detectDocker(env: NodeJS.ProcessEnv): boolean {
  if (env.HTOSHO_IN_DOCKER === '1' || env.HTOSHO_IN_DOCKER === 'true') return true;
  if (env.HTOSHO_IN_DOCKER === '0' || env.HTOSHO_IN_DOCKER === 'false') return false;
  if (fs.existsSync('/.dockerenv')) return true;
  if (process.platform === 'linux') {
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (/(?:docker|containerd|kubepods|podman)/i.test(cgroup)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function isDirectoryWritable(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function validateDownloadUrl(rawUrl: string, allowAnyHost: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppUpdateError('Release asset URL is invalid.', 502);
  }
  if (!allowAnyHost) {
    if (parsed.protocol !== 'https:') {
      throw new AppUpdateError('Release asset URL must use HTTPS.', 502);
    }
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
      throw new AppUpdateError(`Release asset host "${host}" is not an allowed GitHub host.`, 502);
    }
  }
  return parsed;
}

function parseReleaseManifest(raw: unknown, expectedVersion: string): ReleaseUpdateManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.version !== 'string'
    || typeof obj.tag !== 'string'
    || typeof obj.dockerfileSha256 !== 'string'
    || !SHA256_PATTERN.test(obj.dockerfileSha256)
    || typeof obj.runtimeDepsSha256 !== 'string'
    || !SHA256_PATTERN.test(obj.runtimeDepsSha256)
    || typeof obj.bundleAssetName !== 'string'
    || !obj.bundleAssetName.trim()
    || typeof obj.bundleSha256 !== 'string'
    || !SHA256_PATTERN.test(obj.bundleSha256)
    || typeof obj.bundleSize !== 'number'
    || !Number.isSafeInteger(obj.bundleSize)
    || obj.bundleSize <= 0
    || obj.bundleSize > MAX_BUNDLE_BYTES
  ) {
    return null;
  }
  if (compareSemver(obj.version, expectedVersion) !== 0) return null;
  const minNodeVersion = typeof obj.minNodeVersion === 'string' && obj.minNodeVersion.trim() ? obj.minNodeVersion.trim() : null;
  return {
    version: obj.version.trim().replace(/^v/i, ''),
    tag: obj.tag.trim(),
    minNodeVersion,
    dockerfileSha256: obj.dockerfileSha256.toLowerCase(),
    runtimeDepsSha256: obj.runtimeDepsSha256.toLowerCase(),
    bundleAssetName: obj.bundleAssetName.trim(),
    bundleSha256: obj.bundleSha256.toLowerCase(),
    bundleSize: obj.bundleSize,
    requiresImageReplacement: obj.requiresImageReplacement === true,
    imageReplacementReason: typeof obj.imageReplacementReason === 'string' ? obj.imageReplacementReason.trim() : null,
  };
}

function validateZipEntryPath(entryName: string, targetDir: string): string {
  if (!entryName || entryName.includes('\0') || entryName.includes('\\')) {
    throw new AppUpdateError(`Unsafe archive entry path: ${entryName}`, 502);
  }
  if (entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) {
    throw new AppUpdateError(`Absolute archive entry path rejected: ${entryName}`, 502);
  }
  const segments = entryName.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new AppUpdateError(`Path traversal entry rejected: ${entryName}`, 502);
  }
  const dest = path.resolve(targetDir, entryName);
  const rel = path.relative(path.resolve(targetDir), dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppUpdateError(`Archive entry escapes target directory: ${entryName}`, 502);
  }
  return dest;
}

/**
 * Extract an update bundle ZIP into `targetDir`, validating every path against
 * traversal, capping entry count and uncompressed bytes, and checking CRC-32.
 */
export async function extractUpdateBundleZip(zipPath: string, targetDir: string): Promise<void> {
  const buf = await fsp.readFile(zipPath);
  const entries = readZipEntries(buf);
  if (entries.length === 0) throw new AppUpdateError('Update bundle archive is empty.', 502);
  if (entries.length > MAX_ZIP_ENTRIES) throw new AppUpdateError('Update bundle archive exceeds entry limit.', 502);

  await fsp.mkdir(targetDir, { recursive: true });
  let totalUncompressed = 0;

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const destPath = validateZipEntryPath(entry.name, targetDir);
    if (entry.localOffset + 30 > buf.length || buf.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new AppUpdateError(`Corrupt update bundle entry: ${entry.name}`, 502);
    }
    const nameLen = buf.readUInt16LE(entry.localOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new AppUpdateError(`Truncated update bundle entry: ${entry.name}`, 502);
    const raw = buf.subarray(start, end);

    let data: Buffer;
    if (entry.method === 0) {
      data = raw;
    } else if (entry.method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: MAX_EXTRACTED_BYTES });
    } else {
      throw new AppUpdateError(`Unsupported ZIP compression method (${entry.method}) for ${entry.name}`, 502);
    }

    totalUncompressed += data.length;
    if (totalUncompressed > MAX_EXTRACTED_BYTES) {
      throw new AppUpdateError('Update bundle exceeds maximum uncompressed size.', 502);
    }
    if (crc32(data) !== entry.crc) {
      throw new AppUpdateError(`CRC mismatch while extracting ${entry.name}`, 502);
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, data);
  }
}

const defaultExec: ExecFn = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 10 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

export class AppUpdateManager {
  private readonly appRoot: string;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nodeVersion: string;
  private readonly isDevelopment: boolean;
  private readonly repo: string;
  private readonly fetchFn: typeof fetch;
  private readonly execFn: ExecFn;
  private readonly getActiveWork: () => { jobs: number; downloads: number };
  private readonly allowAnyDownloadHost: boolean;
  private readonly restartDelayMs: number;
  private onRestartRequested: (() => void) | null;
  private currentVersionOverride?: string;

  private cache: CachedReleaseCheck | null = null;
  private inFlightCheck: Promise<CachedReleaseCheck> | null = null;
  private progress: UpdateProgress = { ...IDLE_UPDATE_PROGRESS };
  private applyRunning = false;

  constructor(options: AppUpdateManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.appRoot = path.resolve(options.appRoot ?? this.env.HTOSHO_APP_ROOT ?? DEFAULT_APP_ROOT);
    this.dataDir = path.resolve(options.dataDir ?? this.env.HTOSHO_DATA_DIR ?? DATA_DIR);
    this.currentVersionOverride = options.currentVersion;
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
    this.isDevelopment = options.isDevelopment ?? RUNNING_TS_SOURCE;
    const rawRepo = (options.repo ?? this.env.HTOSHO_UPDATE_REPO ?? DEFAULT_REPO).trim();
    this.repo = REPO_PATTERN.test(rawRepo) ? rawRepo : DEFAULT_REPO;
    this.fetchFn = options.fetchFn ?? fetch;
    this.execFn = options.execFn ?? defaultExec;
    this.getActiveWork = options.getActiveWork ?? (() => ({
      jobs: jobQueue.active().length,
      downloads: downloadQueue.list().filter((task) => task.status === 'downloading' || task.status === 'queued').length,
    }));
    this.onRestartRequested = options.onRestartRequested ?? null;
    this.allowAnyDownloadHost = options.allowAnyDownloadHost ?? false;
    this.restartDelayMs = options.restartDelayMs ?? 350;
  }

  registerRestartHandler(handler: () => void): void {
    this.onRestartRequested = handler;
  }

  getCurrentVersion(): string {
    if (this.currentVersionOverride) return this.currentVersionOverride;
    return readPackageVersion(this.appRoot, this.env.HTOSHO_ACTIVE_BUNDLE_DIR);
  }

  private detectInstallMode(): InstallMode {
    if (detectDocker(this.env)) return 'docker';
    if (this.isDevelopment) return 'development';
    if (fs.existsSync(path.join(this.appRoot, '.git'))) return 'git';
    return 'standalone';
  }

  private readLocalRuntimeManifest(): RuntimeManifest | null {
    return readJsonSafe<RuntimeManifest>(path.join(this.appRoot, 'runtime-manifest.json'));
  }

  private readRollbackVersion(): string | null {
    const record = readJsonSafe<RollbackRecord>(path.join(resolveUpdatesDir(this.dataDir), 'rollback.json'));
    return typeof record?.version === 'string' && record.version ? record.version : null;
  }

  dismissRollbackNotice(): void {
    try {
      fs.rmSync(path.join(resolveUpdatesDir(this.dataDir), 'rollback.json'), { force: true });
    } catch { /* ignore */ }
  }

  private buildHeaders(accept = 'application/vnd.github+json'): Record<string, string> {
    const token = this.env.HTOSHO_GITHUB_TOKEN || this.env.GITHUB_TOKEN;
    return {
      Accept: accept,
      'User-Agent': `H-Tosho/${this.getCurrentVersion()}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  }

  private async runReleaseCheck(): Promise<CachedReleaseCheck> {
    const checkedAt = new Date().toISOString();
    const checkedAtMs = Date.now();
    const apiUrl = `https://api.github.com/repos/${this.repo}/releases/latest`;

    try {
      const res = await this.fetchWithTimeout(apiUrl, { headers: this.buildHeaders() }, FETCH_TIMEOUT_MS);
      if (res.status === 404) {
        return { checkedAt, checkedAtMs, error: null, release: null, manifest: null, bundleDownloadUrl: null };
      }
      if (!res.ok) {
        const rateLimited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
        const message = rateLimited
          ? 'GitHub API rate limit reached. Try again later or set HTOSHO_GITHUB_TOKEN.'
          : `GitHub release check failed (HTTP ${res.status}).`;
        return { checkedAt, checkedAtMs, error: message, release: null, manifest: null, bundleDownloadUrl: null };
      }
      const data = (await res.json()) as GitHubReleaseResponse;
      if (data.draft === true || data.prerelease === true) {
        return { checkedAt, checkedAtMs, error: null, release: null, manifest: null, bundleDownloadUrl: null };
      }
      const tagName = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
      const parsed = parseSemver(tagName);
      if (!parsed) {
        return { checkedAt, checkedAtMs, error: `Latest release tag "${tagName || '(empty)'}" is not a valid semantic version.`, release: null, manifest: null, bundleDownloadUrl: null };
      }
      const version = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join('.')}` : ''}`;
      const assets: GitHubReleaseAsset[] = Array.isArray(data.assets) ? (data.assets as GitHubReleaseAsset[]) : [];
      const manifestAsset = assets.find((asset) => asset?.name === UPDATE_MANIFEST_ASSET_NAME && typeof asset.browser_download_url === 'string');
      let manifest: ReleaseUpdateManifest | null = null;

      if (manifestAsset && typeof manifestAsset.browser_download_url === 'string') {
        try {
          const manifestUrl = validateDownloadUrl(manifestAsset.browser_download_url, this.allowAnyDownloadHost).toString();
          const mRes = await this.fetchWithTimeout(manifestUrl, { headers: this.buildHeaders('application/octet-stream') }, FETCH_TIMEOUT_MS);
          if (mRes.ok) {
            manifest = parseReleaseManifest(await mRes.json(), version);
          }
        } catch {
          manifest = null;
        }
      }

      const bundleName = manifest?.bundleAssetName ?? UPDATE_BUNDLE_ASSET_NAME;
      const bundleAsset = assets.find((asset) => asset?.name === bundleName && typeof asset.browser_download_url === 'string');
      let bundleDownloadUrl: string | null = null;
      if (bundleAsset && typeof bundleAsset.browser_download_url === 'string') {
        try {
          bundleDownloadUrl = validateDownloadUrl(bundleAsset.browser_download_url, this.allowAnyDownloadHost).toString();
        } catch {
          bundleDownloadUrl = null;
        }
      }

      const rawNotes = typeof data.body === 'string' ? data.body.trim() : '';
      const notes = rawNotes.length > MAX_RELEASE_NOTES_CHARS
        ? `${rawNotes.slice(0, MAX_RELEASE_NOTES_CHARS)}\n\n…`
        : rawNotes;

      const release: UpdateReleaseInfo = {
        version,
        tagName,
        name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : tagName,
        publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
        htmlUrl: typeof data.html_url === 'string' && /^https:\/\//i.test(data.html_url)
          ? data.html_url
          : `https://github.com/${this.repo}/releases/tag/${encodeURIComponent(tagName)}`,
        notes,
        hasBundle: Boolean(manifest && bundleDownloadUrl),
        bundleSize: typeof bundleAsset?.size === 'number' && Number.isFinite(bundleAsset.size)
          ? bundleAsset.size
          : manifest?.bundleSize ?? null,
      };

      return { checkedAt, checkedAtMs, error: null, release, manifest, bundleDownloadUrl };
    } catch (error) {
      const msg = error instanceof Error && error.name === 'AbortError'
        ? 'Timed out contacting GitHub Releases.'
        : error instanceof Error ? error.message : String(error);
      return { checkedAt, checkedAtMs, error: msg, release: null, manifest: null, bundleDownloadUrl: null };
    }
  }

  private async ensureChecked(force: boolean): Promise<CachedReleaseCheck | null> {
    if (!force && this.env.HTOSHO_UPDATE_CHECK_DISABLED === '1') {
      return this.cache;
    }
    if (!force && this.cache && Date.now() - this.cache.checkedAtMs < CACHE_TTL_MS) {
      return this.cache;
    }
    if (!this.inFlightCheck) {
      this.inFlightCheck = this.runReleaseCheck().then((result) => {
        this.cache = result;
        return result;
      }).finally(() => {
        this.inFlightCheck = null;
      });
    }
    return this.inFlightCheck;
  }

  private async checkGitClean(): Promise<{ clean: boolean; reason: string | null }> {
    try {
      const { stdout } = await this.execFn('git', ['status', '--porcelain'], {
        cwd: this.appRoot,
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 10_000,
      });
      if (stdout.trim().length > 0) {
        return { clean: false, reason: 'Local Git working tree has uncommitted changes. Commit or stash them before updating in-app.' };
      }
      return { clean: true, reason: null };
    } catch {
      return { clean: false, reason: 'Git is not available on PATH, so this checkout cannot update itself automatically.' };
    }
  }

  async getStatus(options: { force?: boolean } = {}): Promise<AppUpdateStatus> {
    const check = await this.ensureChecked(Boolean(options.force));
    const currentVersion = this.getCurrentVersion();
    const installMode = this.detectInstallMode();
    const latestRelease = check?.release ?? null;
    const updateAvailable = Boolean(latestRelease && isNewerVersion(latestRelease.version, currentVersion));
    const activeWork = this.getActiveWork();
    const rolledBackVersion = this.readRollbackVersion();

    let docker: DockerUpdateGuidance | null = null;
    let canUpdateInApp = false;
    let unavailableReason: string | null = null;

    if (installMode === 'docker') {
      const localRuntime = this.readLocalRuntimeManifest();
      const bootstrapped = this.env.HTOSHO_BOOTSTRAPPED === '1';
      const dataDirWritable = isDirectoryWritable(resolveUpdatesDir(this.dataDir));
      const reasons = updateAvailable
        ? evaluateDockerCompatibility({
          nodeVersion: this.nodeVersion,
          bootstrapped,
          localRuntime,
          releaseManifest: check?.manifest ?? null,
          hasBundleAsset: Boolean(check?.bundleDownloadUrl),
          dataDirWritable,
        })
        : [];
      const requiresImageReplacement = reasons.length > 0;
      docker = {
        requiresImageReplacement,
        reasons,
        pullCommand: 'docker compose pull && docker compose up -d',
        buildCommand: 'git pull && docker compose up -d --build',
        dataDirectory: this.dataDir,
        runningBundledOverlay: Boolean(this.env.HTOSHO_ACTIVE_BUNDLE_DIR),
        baseImageVersion: this.env.HTOSHO_BASE_IMAGE_VERSION ?? localRuntime?.version ?? null,
      };
      if (updateAvailable) {
        canUpdateInApp = !requiresImageReplacement;
      }
    } else if (installMode === 'development') {
      canUpdateInApp = false;
      if (updateAvailable) {
        unavailableReason = 'In-app self-update is disabled in development mode. Update with git pull and npm install.';
      }
    } else if (installMode === 'git') {
      if (updateAvailable) {
        if (check?.manifest?.minNodeVersion && !satisfiesMinNodeVersion(this.nodeVersion, check.manifest.minNodeVersion)) {
          const required = parseMinNodeVersion(check.manifest.minNodeVersion) ?? check.manifest.minNodeVersion;
          unavailableReason = `This release requires Node.js ${required} or newer, but this host is running Node.js ${this.nodeVersion}.`;
        } else {
          const gitState = await this.checkGitClean();
          canUpdateInApp = gitState.clean;
          unavailableReason = gitState.reason;
        }
      }
    } else {
      // standalone (downloaded tarball without .git)
      if (updateAvailable) {
        const hasBundle = Boolean(check?.manifest && check?.bundleDownloadUrl);
        if (!hasBundle) {
          unavailableReason = 'This installation is not a Git checkout and this release has no prebuilt update bundle. Download the new release manually and run npm install && npm start.';
        } else if (this.env.HTOSHO_BOOTSTRAPPED !== '1') {
          unavailableReason = 'This standalone installation is not running under the update bootstrapper. Download the new release manually or run with node server/dist/bootstrap.js.';
        } else if (check?.manifest?.minNodeVersion && !satisfiesMinNodeVersion(this.nodeVersion, check.manifest.minNodeVersion)) {
          const required = parseMinNodeVersion(check.manifest.minNodeVersion) ?? check.manifest.minNodeVersion;
          unavailableReason = `This release requires Node.js ${required} or newer (currently ${this.nodeVersion}).`;
        } else {
          canUpdateInApp = true;
        }
      }
    }

    return {
      currentVersion,
      nodeVersion: this.nodeVersion,
      installMode,
      repo: this.repo,
      checkedAt: check?.checkedAt ?? null,
      checkError: check?.error ?? null,
      updateAvailable,
      latestRelease,
      canUpdateInApp,
      unavailableReason,
      activeWork,
      docker,
      progress: { ...this.progress },
      rolledBackVersion,
    };
  }

  private setProgress(patch: Partial<UpdateProgress>): void {
    this.progress = { ...this.progress, ...patch };
  }

  async startUpdate(requestedVersion?: string): Promise<AppUpdateStatus> {
    if (this.applyRunning || (this.progress.phase !== 'idle' && this.progress.phase !== 'failed' && this.progress.phase !== 'completed')) {
      throw new AppUpdateError('An update is already in progress.', 409);
    }

    const status = await this.getStatus({ force: !this.cache });
    if (!status.updateAvailable || !status.latestRelease) {
      throw new AppUpdateError('H-Tosho is already up to date.', 409);
    }
    const targetRelease = status.latestRelease;
    if (requestedVersion && compareSemver(requestedVersion, targetRelease.version) !== 0) {
      throw new AppUpdateError(`Requested version v${requestedVersion} does not match latest release v${targetRelease.version}. Refresh and try again.`, 409);
    }
    if (status.docker?.requiresImageReplacement) {
      throw new AppUpdateError('This release requires completely replacing the Docker image and cannot be applied in-app.', 409);
    }
    if (!status.canUpdateInApp) {
      throw new AppUpdateError(status.unavailableReason ?? 'In-app updates are not available for this installation.', 409);
    }
    if (status.activeWork.jobs > 0 || status.activeWork.downloads > 0) {
      const parts: string[] = [];
      if (status.activeWork.jobs > 0) parts.push(`${status.activeWork.jobs} active task${status.activeWork.jobs === 1 ? '' : 's'}`);
      if (status.activeWork.downloads > 0) parts.push(`${status.activeWork.downloads} active download${status.activeWork.downloads === 1 ? '' : 's'}`);
      throw new AppUpdateError(`Wait for ${parts.join(' and ')} to finish (or pause/cancel them) before updating H-Tosho.`, 409);
    }

    this.applyRunning = true;
    this.progress = {
      phase: status.installMode === 'git' ? 'fetching-git' : 'downloading',
      message: status.installMode === 'git' ? `Fetching release ${targetRelease.tagName}…` : `Downloading v${targetRelease.version}…`,
      targetVersion: targetRelease.version,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      bytesReceived: null,
      bytesTotal: targetRelease.bundleSize,
    };

    const runPromise = status.installMode === 'git'
      ? this.applyGitUpdate(targetRelease)
      : this.applyBundleUpdate(targetRelease);

    void runPromise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setProgress({
        phase: 'failed',
        message: 'Update failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
    }).finally(() => {
      this.applyRunning = false;
    });

    return { ...status, progress: { ...this.progress } };
  }

  private async downloadVerifiedBundle(url: string, expectedSha256: string, destPath: string): Promise<void> {
    validateDownloadUrl(url, this.allowAnyDownloadHost);
    const res = await this.fetchWithTimeout(url, { headers: this.buildHeaders('application/octet-stream') }, BUNDLE_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) throw new AppUpdateError(`Bundle download failed (HTTP ${res.status}).`, 502);

    const contentLengthHeader = res.headers.get('content-length');
    const totalBytes = contentLengthHeader && Number.isFinite(Number(contentLengthHeader)) ? Number(contentLengthHeader) : null;
    if (totalBytes !== null && totalBytes > MAX_BUNDLE_BYTES) {
      throw new AppUpdateError('Update bundle exceeds maximum allowed size.', 502);
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;
    const hash = createHash('sha256');
    let received = 0;

    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = (res.body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown>; releaseLock(): void } }).getReader();
        const fh = await fsp.open(partPath, 'w');
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            received += value.byteLength;
            if (received > MAX_BUNDLE_BYTES) throw new AppUpdateError('Update bundle exceeds maximum allowed size.', 502);
            hash.update(value);
            await fh.write(value);
            this.setProgress({ bytesReceived: received, bytesTotal: totalBytes });
          }
        } finally {
          await fh.close();
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_BUNDLE_BYTES) throw new AppUpdateError('Update bundle exceeds maximum allowed size.', 502);
        received = buf.byteLength;
        hash.update(buf);
        await fsp.writeFile(partPath, buf);
        this.setProgress({ bytesReceived: received, bytesTotal: totalBytes ?? received });
      }

      if (received === 0) throw new AppUpdateError('Downloaded update bundle is empty.', 502);
      this.setProgress({ phase: 'verifying', message: 'Verifying SHA-256 checksum…' });
      const actualSha256 = hash.digest('hex').toLowerCase();
      if (actualSha256 !== expectedSha256.toLowerCase()) {
        throw new AppUpdateError(`Checksum verification failed (expected ${expectedSha256.slice(0, 12)}…, got ${actualSha256.slice(0, 12)}…).`, 502);
      }
      await fsp.rename(partPath, destPath);
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async applyBundleUpdate(release: UpdateReleaseInfo): Promise<void> {
    const manifest = this.cache?.manifest;
    const bundleUrl = this.cache?.bundleDownloadUrl;
    if (!manifest || !bundleUrl) {
      throw new AppUpdateError('Update bundle metadata is missing. Check for updates again.', 409);
    }

    const updatesDir = resolveUpdatesDir(this.dataDir);
    await fsp.mkdir(updatesDir, { recursive: true });
    const runId = randomUUID().slice(0, 8);
    const zipPath = path.join(updatesDir, `bundle-${release.version}-${runId}.zip`);
    const stagingDir = path.join(updatesDir, `staging-${release.version}-${runId}`);
    const finalDir = path.join(updatesDir, `v${release.version}`);

    try {
      await this.downloadVerifiedBundle(bundleUrl, manifest.bundleSha256, zipPath);

      this.setProgress({ phase: 'extracting', message: `Extracting v${release.version}…` });
      await extractUpdateBundleZip(zipPath, stagingDir);

      // Verify essential bundle structure and version match.
      const entryPath = path.join(stagingDir, 'server', 'dist', 'index.js');
      const webIndex = path.join(stagingDir, 'web', 'dist', 'index.html');
      const extractedPkg = readJsonSafe<{ version?: unknown }>(path.join(stagingDir, 'server', 'package.json'));
      if (!fs.existsSync(entryPath) || !fs.existsSync(webIndex)) {
        throw new AppUpdateError('Update bundle is incomplete (missing server/dist or web/dist).', 502);
      }
      if (typeof extractedPkg?.version !== 'string' || compareSemver(extractedPkg.version, release.version) !== 0) {
        throw new AppUpdateError(`Update bundle version mismatch (expected v${release.version}).`, 502);
      }

      // Symlink node_modules from the host/container app root so Node ESM resolves dependencies natively.
      const rootNodeModules = path.join(this.appRoot, 'node_modules');
      const stagedNodeModules = path.join(stagingDir, 'node_modules');
      if (fs.existsSync(rootNodeModules) && !fs.existsSync(stagedNodeModules)) {
        await fsp.symlink(rootNodeModules, stagedNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
      }

      // Replace target version folder if re-installing and atomically swap active pointer.
      await fsp.rm(finalDir, { recursive: true, force: true });
      await fsp.rename(stagingDir, finalDir);

      const localRuntime = this.readLocalRuntimeManifest();
      const pointer: ActiveBundlePointer = {
        version: release.version,
        bundleDir: finalDir,
        installedAt: new Date().toISOString(),
        baseImageVersion: this.env.HTOSHO_BASE_IMAGE_VERSION ?? localRuntime?.version ?? null,
        baseDockerfileSha256: localRuntime?.dockerfileSha256 ?? null,
        baseRuntimeDepsSha256: localRuntime?.runtimeDepsSha256 ?? null,
      };
      const tmpPointer = path.join(updatesDir, 'active.json.tmp');
      await fsp.writeFile(tmpPointer, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
      await fsp.rename(tmpPointer, path.join(updatesDir, 'active.json'));
      await fsp.rm(path.join(updatesDir, 'rollback.json'), { force: true }).catch(() => {});

      this.triggerRestart(release.version);
    } finally {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async applyGitUpdate(release: UpdateReleaseInfo): Promise<void> {
    const gitEnv: NodeJS.ProcessEnv = { ...this.env, GIT_TERMINAL_PROMPT: '0' };
    const git = (args: string[], timeout = 120_000) => this.execFn('git', args, { cwd: this.appRoot, env: gitEnv, timeout });
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const clean = await this.checkGitClean();
    if (!clean.clean) throw new AppUpdateError(clean.reason ?? 'Working tree is not clean.', 409);

    const prevRef = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const prevSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    let checkedOut = false;

    const rollbackGit = async () => {
      if (!checkedOut) return;
      try {
        if (prevRef && prevRef !== 'HEAD') {
          await git(['checkout', prevRef]);
          await git(['reset', '--hard', prevSha]);
        } else {
          await git(['checkout', '--detach', prevSha]);
        }
      } catch (rollbackError) {
        console.warn('[h-tosho] failed to roll back git checkout after update failure:', rollbackError);
      }
    };

    try {
      this.setProgress({ phase: 'fetching-git', message: `Fetching ${release.tagName} from origin…` });
      await git(['fetch', '--tags', 'origin']);
      await git(['rev-parse', '-q', '--verify', `refs/tags/${release.tagName}`]);

      let fastForward = false;
      if (prevRef && prevRef !== 'HEAD') {
        try {
          await git(['merge-base', '--is-ancestor', 'HEAD', `refs/tags/${release.tagName}`]);
          fastForward = true;
        } catch {
          fastForward = false;
        }
      }

      if (fastForward) {
        await git(['merge', '--ff-only', `refs/tags/${release.tagName}`]);
      } else {
        await git(['checkout', '--detach', `refs/tags/${release.tagName}`]);
      }
      checkedOut = true;

      // Verify Node engine requirement in the newly checked-out package.json.
      const nextPkg = readJsonSafe<{ engines?: { node?: string } }>(path.join(this.appRoot, 'package.json'));
      if (nextPkg?.engines?.node && !satisfiesMinNodeVersion(this.nodeVersion, nextPkg.engines.node)) {
        const required = parseMinNodeVersion(nextPkg.engines.node) ?? nextPkg.engines.node;
        throw new AppUpdateError(`Release v${release.version} requires Node.js ${required} or newer (host has ${this.nodeVersion}).`, 409);
      }

      this.setProgress({ phase: 'installing-deps', message: 'Installing dependencies…' });
      const hasLockfile = fs.existsSync(path.join(this.appRoot, 'package-lock.json'));
      await this.execFn(npmBin, [hasLockfile ? 'ci' : 'install'], { cwd: this.appRoot, env: this.env, timeout: 10 * 60_000 });

      this.setProgress({ phase: 'building', message: 'Building web interface and server…' });
      await this.execFn(npmBin, ['run', 'build'], { cwd: this.appRoot, env: this.env, timeout: 10 * 60_000 });

      this.triggerRestart(release.version);
    } catch (error) {
      await rollbackGit();
      throw error;
    }
  }

  private triggerRestart(version: string): void {
    this.setProgress({
      phase: 'restarting',
      message: `Restarting H-Tosho into v${version}…`,
      finishedAt: new Date().toISOString(),
      error: null,
    });
    if (this.onRestartRequested) {
      const handler = this.onRestartRequested;
      const timer = setTimeout(() => handler(), this.restartDelayMs);
      timer.unref?.();
    }
  }
}

export const appUpdateManager = new AppUpdateManager();
