import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNewerVersion, type RuntimeManifest } from "./contracts/appUpdate.js";

/** Exit code emitted by server/src/index.ts when requesting an immediate restart after an in-app update. */
export const RESTART_EXIT_CODE = 75;

/** If a newly installed bundle exits non-zero within this window, automatically roll back to the base image. */
const CRASH_ROLLBACK_WINDOW_MS = 15_000;

export interface ActiveBundlePointer {
  version: string;
  bundleDir: string;
  installedAt: string;
  baseImageVersion: string | null;
  baseDockerfileSha256: string | null;
  baseRuntimeDepsSha256: string | null;
}

export interface RollbackRecord {
  version: string;
  rolledBackAt: string;
  exitCode: number | null;
}

export interface BootTarget {
  entryPath: string;
  webDist: string | null;
  activeBundleDir: string | null;
  activeBundleVersion: string | null;
  baseImageVersion: string | null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..", "..");
const BUILTIN_ENTRY = path.join(__dirname, "index.js");

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function resolveUpdatesDir(dataDir: string): string {
  return path.join(dataDir, "updates");
}

function readBuiltinVersion(appRoot: string): string | null {
  const pkg =
    readJsonSafe<{ version?: unknown }>(
      path.join(appRoot, "server", "package.json")
    ) ??
    readJsonSafe<{ version?: unknown }>(path.join(appRoot, "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : null;
}

function readRuntimeManifest(appRoot: string): RuntimeManifest | null {
  return readJsonSafe<RuntimeManifest>(
    path.join(appRoot, "runtime-manifest.json")
  );
}

function isInsideDir(parentDir: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidate));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Decide whether to boot a staged overlay bundle in `${dataDir}/updates/` or
 * the built-in image entrypoint. Cleans up superseded/incompatible pointers
 * when a newer Docker image replaces an older one.
 */
export function selectBootTarget(options: {
  appRoot: string;
  builtinEntry: string;
  dataDir: string;
}): BootTarget {
  const baseImageVersion = readBuiltinVersion(options.appRoot);
  const runtime = readRuntimeManifest(options.appRoot);
  const updatesDir = resolveUpdatesDir(options.dataDir);
  const pointerPath = path.join(updatesDir, "active.json");
  const fallback: BootTarget = {
    entryPath: options.builtinEntry,
    webDist: null,
    activeBundleDir: null,
    activeBundleVersion: null,
    baseImageVersion,
  };

  const pointer = readJsonSafe<ActiveBundlePointer>(pointerPath);
  if (
    !pointer ||
    typeof pointer.bundleDir !== "string" ||
    typeof pointer.version !== "string"
  ) {
    return fallback;
  }

  const bundleDir = path.resolve(pointer.bundleDir);
  const entryPath = path.join(bundleDir, "server", "dist", "index.js");
  const webDist = path.join(bundleDir, "web", "dist");
  const validLocation = isInsideDir(updatesDir, bundleDir);
  const newerThanImage =
    !baseImageVersion || isNewerVersion(pointer.version, baseImageVersion);
  const runtimeMatches =
    !runtime ||
    (pointer.baseDockerfileSha256 === runtime.dockerfileSha256 &&
      pointer.baseRuntimeDepsSha256 === runtime.runtimeDepsSha256);
  const filesExist =
    fs.existsSync(entryPath) && fs.existsSync(path.join(webDist, "index.html"));

  if (!validLocation || !newerThanImage || !runtimeMatches || !filesExist) {
    // The underlying Docker image was upgraded or the bundle is invalid; clear the stale pointer.
    try {
      fs.rmSync(pointerPath, { force: true });
    } catch {
      /* ignore */
    }
    if (validLocation && (!newerThanImage || !runtimeMatches)) {
      try {
        fs.rmSync(bundleDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return fallback;
  }

  return {
    entryPath,
    webDist,
    activeBundleDir: bundleDir,
    activeBundleVersion: pointer.version,
    baseImageVersion,
  };
}

function recordRollback(
  dataDir: string,
  version: string,
  exitCode: number | null
): void {
  const updatesDir = resolveUpdatesDir(dataDir);
  try {
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.rmSync(path.join(updatesDir, "active.json"), { force: true });
    const record: RollbackRecord = {
      version,
      rolledBackAt: new Date().toISOString(),
      exitCode,
    };
    const tmp = path.join(updatesDir, "rollback.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
    fs.renameSync(tmp, path.join(updatesDir, "rollback.json"));
  } catch (error) {
    console.warn("[h-tosho] failed to record bundle rollback:", error);
  }
}

function runSupervisor(): void {
  const dataDir =
    process.env.HTOSHO_DATA_DIR ?? path.join(APP_ROOT, "server", "data");
  let child: ChildProcess | null = null;
  let stopping = false;

  const forwardSignal = (signal: NodeJS.Signals) => {
    stopping = true;
    if (child && !child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  const launch = () => {
    const target = selectBootTarget({
      appRoot: APP_ROOT,
      builtinEntry: BUILTIN_ENTRY,
      dataDir,
    });
    const startedAt = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HTOSHO_BOOTSTRAPPED: "1",
      HTOSHO_APP_ROOT: APP_ROOT,
      ...(target.baseImageVersion
        ? { HTOSHO_BASE_IMAGE_VERSION: target.baseImageVersion }
        : {}),
    };
    if (target.activeBundleDir && target.webDist) {
      env.HTOSHO_ACTIVE_BUNDLE_DIR = target.activeBundleDir;
      env.HTOSHO_WEB_DIST = target.webDist;
      console.log(
        `[h-tosho] booting staged update bundle v${target.activeBundleVersion}`
      );
    } else {
      delete env.HTOSHO_ACTIVE_BUNDLE_DIR;
      delete env.HTOSHO_WEB_DIST;
    }

    child = spawn(process.execPath, [target.entryPath], {
      cwd: APP_ROOT,
      env,
      stdio: "inherit",
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) {
        process.exit(code ?? 0);
      }
      if (code === RESTART_EXIT_CODE) {
        console.log("[h-tosho] restarting into updated version…");
        launch();
        return;
      }
      if (
        target.activeBundleVersion &&
        code !== 0 &&
        Date.now() - startedAt < CRASH_ROLLBACK_WINDOW_MS
      ) {
        console.error(
          `[h-tosho] staged bundle v${target.activeBundleVersion} exited early (code=${code ?? "null"}, signal=${signal ?? "none"}); rolling back to base image`
        );
        recordRollback(dataDir, target.activeBundleVersion, code);
        launch();
        return;
      }
      process.exit(code ?? (signal ? 1 : 0));
    });
  };

  launch();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSupervisor();
}
