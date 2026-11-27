#!/usr/bin/env node
/**
 * Build-time helper for in-app updates:
 *
 *   node scripts/update-bundle.mjs --write-runtime-manifest <path> [--in-docker]
 *   node scripts/update-bundle.mjs --build-bundle <outDir> [--tag <vX.Y.Z>]
 *
 * Uses only Node.js built-ins so it runs in CI and inside the Dockerfile build
 * stage without extra dependencies.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const BUNDLE_NAME = "h-tosho-update-bundle.zip";
const MANIFEST_NAME = "h-tosho-update-manifest.json";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseMinNodeVersion(range) {
  if (typeof range !== "string") return null;
  const match =
    />=\s*v?(\d+\.\d+\.\d+)/.exec(range) ?? /v?(\d+\.\d+\.\d+)/.exec(range);
  return match ? match[1] : null;
}

/** Deterministic SHA-256 of Dockerfile with normalized LF line endings. */
export function computeDockerfileHash(rootDir = REPO_ROOT) {
  const raw = fs.readFileSync(path.join(rootDir, "Dockerfile"), "utf8");
  return sha256Hex(raw.replace(/\r\n/g, "\n"));
}

/**
 * Deterministic SHA-256 of server runtime dependencies (direct + transitive
 * locked versions from package-lock.json). Frontend-only and devDependency
 * changes do not alter this hash because web/dist is shipped prebuilt.
 */
export function computeRuntimeDepsHash(rootDir = REPO_ROOT) {
  const serverPkg = readJson(path.join(rootDir, "server", "package.json"));
  const directDeps = serverPkg.dependencies ?? {};
  const lockPath = path.join(rootDir, "package-lock.json");
  const lock = fs.existsSync(lockPath) ? readJson(lockPath) : null;
  const packages = lock?.packages ?? {};

  const visited = new Set();
  const queue = Object.keys(directDeps).sort();
  const resolved = {};

  while (queue.length > 0) {
    const depName = queue.shift();
    if (!depName || visited.has(depName)) continue;
    visited.add(depName);
    const entry =
      packages[`server/node_modules/${depName}`] ??
      packages[`node_modules/${depName}`];
    if (!entry) {
      resolved[depName] = { declared: directDeps[depName] ?? null };
      continue;
    }
    resolved[depName] = {
      version: entry.version ?? null,
      integrity: entry.integrity ?? null,
      hasInstallScript: Boolean(entry.hasInstallScript),
    };
    const nextDeps = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const child of Object.keys(nextDeps).sort()) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  const canonical = JSON.stringify({
    direct: Object.keys(directDeps)
      .sort()
      .map((k) => [k, directDeps[k]]),
    resolved: Object.keys(resolved)
      .sort()
      .map((k) => [k, resolved[k]]),
  });
  return sha256Hex(canonical);
}

export function buildRuntimeManifest({
  rootDir = REPO_ROOT,
  inDocker = false,
} = {}) {
  const rootPkg = readJson(path.join(rootDir, "package.json"));
  const serverPkg = readJson(path.join(rootDir, "server", "package.json"));
  return {
    version: String(serverPkg.version ?? rootPkg.version ?? "0.0.0"),
    nodeVersion: process.versions.node,
    minNodeVersion: parseMinNodeVersion(rootPkg.engines?.node),
    platform: process.platform,
    arch: process.arch,
    dockerfileSha256: computeDockerfileHash(rootDir),
    runtimeDepsSha256: computeRuntimeDepsHash(rootDir),
    inDocker,
  };
}

// ---------------- Minimal CRC-32 + ZIP writer (matches server/src/downloader/zip.ts) ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const date = new Date();
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate =
    (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 22);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function collectFiles(rootDir, relDir, out) {
  const full = path.join(rootDir, relDir);
  if (!fs.existsSync(full))
    throw new Error(`Required build directory missing: ${relDir}`);
  for (const entry of fs
    .readdirSync(full, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(rootDir, rel, out);
    else if (entry.isFile())
      out.push({ name: rel, data: fs.readFileSync(path.join(rootDir, rel)) });
  }
}

export function buildReleaseBundle({ rootDir = REPO_ROOT, outDir, tag }) {
  const rootPkg = readJson(path.join(rootDir, "package.json"));
  const serverPkg = readJson(path.join(rootDir, "server", "package.json"));
  const version = String(serverPkg.version ?? rootPkg.version ?? "0.0.0");
  const resolvedTag = tag || `v${version}`;

  const entries = [
    {
      name: "package.json",
      data: fs.readFileSync(path.join(rootDir, "package.json")),
    },
    {
      name: "server/package.json",
      data: fs.readFileSync(path.join(rootDir, "server", "package.json")),
    },
  ];
  collectFiles(rootDir, "server/dist", entries);
  collectFiles(rootDir, "web/dist", entries);

  const zipBuf = createZipBuffer(entries);
  const bundleSha256 = sha256Hex(zipBuf);

  fs.mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, BUNDLE_NAME);
  fs.writeFileSync(bundlePath, zipBuf);

  const manifest = {
    version,
    tag: resolvedTag,
    minNodeVersion: parseMinNodeVersion(rootPkg.engines?.node),
    dockerfileSha256: computeDockerfileHash(rootDir),
    runtimeDepsSha256: computeRuntimeDepsHash(rootDir),
    bundleAssetName: BUNDLE_NAME,
    bundleSha256,
    bundleSize: zipBuf.length,
    requiresImageReplacement:
      process.env.HTOSHO_REQUIRE_IMAGE_REPLACEMENT === "1",
    imageReplacementReason: process.env.HTOSHO_IMAGE_REPLACEMENT_REASON || null,
  };
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return { bundlePath, manifestPath, manifest };
}

function main() {
  const args = process.argv.slice(2);
  const writeIdx = args.indexOf("--write-runtime-manifest");
  if (writeIdx !== -1) {
    const outPath = args[writeIdx + 1];
    if (!outPath)
      throw new Error("--write-runtime-manifest requires an output path");
    const inDocker =
      args.includes("--in-docker") || process.env.HTOSHO_IN_DOCKER === "1";
    const manifest = buildRuntimeManifest({ inDocker });
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(
      `[update-bundle] wrote runtime manifest for v${manifest.version} to ${outPath}`
    );
    return;
  }

  const bundleIdx = args.indexOf("--build-bundle");
  if (bundleIdx !== -1) {
    const outDir = args[bundleIdx + 1];
    if (!outDir) throw new Error("--build-bundle requires an output directory");
    const tagIdx = args.indexOf("--tag");
    const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;
    const { bundlePath, manifestPath, manifest } = buildReleaseBundle({
      outDir,
      tag,
    });
    console.log(
      `[update-bundle] built ${bundlePath} (${manifest.bundleSize} bytes, sha256=${manifest.bundleSha256.slice(0, 12)}…) and ${manifestPath}`
    );
    return;
  }

  console.error(
    "Usage: node scripts/update-bundle.mjs --write-runtime-manifest <path> [--in-docker] | --build-bundle <outDir> [--tag <vX.Y.Z>]"
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
