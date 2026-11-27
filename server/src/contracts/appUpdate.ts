/**
 * Shared contract and pure compatibility rules for in-app updates.
 * Imported by both the server and the web frontend (no Node/browser I/O).
 */

export type InstallMode = "docker" | "git" | "standalone" | "development";

export type DockerReplacementReasonCode =
  | "dockerfile-changed"
  | "runtime-deps-changed"
  | "node-version-unsupported"
  | "release-requires-image"
  | "missing-update-bundle"
  | "legacy-image"
  | "data-dir-readonly";

export interface DockerReplacementReason {
  code: DockerReplacementReasonCode;
  summary: string;
}

export interface DockerUpdateGuidance {
  /** True when the container's Docker image must be completely replaced instead of updated in-app. */
  requiresImageReplacement: boolean;
  /** Specific reasons why the Docker image must be replaced. */
  reasons: DockerReplacementReason[];
  /** Copy-pasteable command to pull and recreate with a prebuilt Docker image. */
  pullCommand: string;
  /** Copy-pasteable command to pull git source and rebuild the Docker image locally. */
  buildCommand: string;
  /** Container data directory path preserved across image replacement. */
  dataDirectory: string;
  /** True when currently running a staged in-app bundle over an older Docker image. */
  runningBundledOverlay: boolean;
  /** Built-in version of the underlying Docker image (when known). */
  baseImageVersion: string | null;
}

export interface UpdateReleaseInfo {
  version: string;
  tagName: string;
  name: string;
  publishedAt: string | null;
  htmlUrl: string;
  notes: string;
  hasBundle: boolean;
  bundleSize: number | null;
}

export type UpdateJobPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "extracting"
  | "fetching-git"
  | "installing-deps"
  | "building"
  | "restarting"
  | "completed"
  | "failed";

export interface UpdateProgress {
  phase: UpdateJobPhase;
  message: string;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  bytesReceived?: number | null;
  bytesTotal?: number | null;
}

export interface AppUpdateStatus {
  currentVersion: string;
  nodeVersion: string;
  installMode: InstallMode;
  repo: string;
  checkedAt: string | null;
  checkError: string | null;
  updateAvailable: boolean;
  latestRelease: UpdateReleaseInfo | null;
  /** Whether this installation can run an in-app update for the latest release. */
  canUpdateInApp: boolean;
  /** Human-readable explanation when in-app update is unavailable (non-Docker reasons or blockers). */
  unavailableReason: string | null;
  /** Active work that should finish before restarting the server. */
  activeWork: {
    jobs: number;
    downloads: number;
  };
  /** Docker-specific compatibility and image-replacement guidance (present when installMode === 'docker'). */
  docker: DockerUpdateGuidance | null;
  /** Current or most recent in-app update operation. */
  progress: UpdateProgress;
  /** Set when a previously installed bundle crashed during startup and was automatically rolled back. */
  rolledBackVersion: string | null;
}

/** Fingerprint baked into a built Docker image at build time (/app/runtime-manifest.json). */
export interface RuntimeManifest {
  version: string;
  nodeVersion: string;
  minNodeVersion: string | null;
  platform: string;
  arch: string;
  dockerfileSha256: string;
  runtimeDepsSha256: string;
  inDocker: boolean;
}

/** Manifest attached to a GitHub release (h-tosho-update-manifest.json). */
export interface ReleaseUpdateManifest {
  version: string;
  tag: string;
  minNodeVersion: string | null;
  dockerfileSha256: string;
  runtimeDepsSha256: string;
  bundleAssetName: string;
  bundleSha256: string;
  bundleSize: number;
  requiresImageReplacement?: boolean;
  imageReplacementReason?: string | null;
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(
  raw: string | null | undefined
): ParsedSemver | null {
  if (!raw) return null;
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
  };
}

/** Standard SemVer 2.0.0 comparison (-1 if a < b, 0 if equal, 1 if a > b). Returns null if either is invalid. */
export function compareSemver(
  a: string | null | undefined,
  b: string | null | undefined
): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) < Number(bi) ? -1 : 1;
    if (aNum) return -1;
    if (bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined
): boolean {
  return compareSemver(candidate, current) === 1;
}

/** Extract the minimum version from an engines.node range such as `>=22.22.0`. */
export function parseMinNodeVersion(
  range: string | null | undefined
): string | null {
  if (!range) return null;
  const match =
    />=\s*v?(\d+\.\d+\.\d+)/.exec(range) ?? /v?(\d+\.\d+\.\d+)/.exec(range);
  return match ? match[1] : null;
}

export function satisfiesMinNodeVersion(
  currentNode: string,
  minNode: string | null | undefined
): boolean {
  const required = parseMinNodeVersion(minNode);
  if (!required) return true;
  const cmp = compareSemver(currentNode, required);
  return cmp === null ? true : cmp >= 0;
}

export interface DockerCompatibilityInput {
  nodeVersion: string;
  bootstrapped: boolean;
  localRuntime: RuntimeManifest | null;
  releaseManifest: ReleaseUpdateManifest | null;
  hasBundleAsset: boolean;
  dataDirWritable: boolean;
}

/**
 * Determine whether updating a Docker installation requires completely replacing
 * the Docker image instead of applying an in-app bundle overlay.
 */
export function evaluateDockerCompatibility(
  input: DockerCompatibilityInput
): DockerReplacementReason[] {
  const reasons: DockerReplacementReason[] = [];

  if (!input.bootstrapped || !input.localRuntime) {
    reasons.push({
      code: "legacy-image",
      summary:
        "This Docker image predates in-app bundle updates and must be replaced once to enable them.",
    });
  }

  if (!input.releaseManifest || !input.hasBundleAsset) {
    reasons.push({
      code: "missing-update-bundle",
      summary:
        "This release does not ship an in-app update bundle, so the Docker image must be replaced.",
    });
  }

  if (input.releaseManifest) {
    if (input.releaseManifest.requiresImageReplacement) {
      reasons.push({
        code: "release-requires-image",
        summary:
          input.releaseManifest.imageReplacementReason?.trim() ||
          "This release explicitly requires replacing the Docker image.",
      });
    }

    if (
      input.releaseManifest.minNodeVersion &&
      !satisfiesMinNodeVersion(
        input.nodeVersion,
        input.releaseManifest.minNodeVersion
      )
    ) {
      const required =
        parseMinNodeVersion(input.releaseManifest.minNodeVersion) ??
        input.releaseManifest.minNodeVersion;
      reasons.push({
        code: "node-version-unsupported",
        summary: `This release requires Node.js ${required} or newer, but this container is running Node.js ${input.nodeVersion}.`,
      });
    }

    if (input.localRuntime) {
      if (
        input.localRuntime.dockerfileSha256 !==
        input.releaseManifest.dockerfileSha256
      ) {
        reasons.push({
          code: "dockerfile-changed",
          summary:
            "The Dockerfile, base image, or system packages changed in this release.",
        });
      }
      if (
        input.localRuntime.runtimeDepsSha256 !==
        input.releaseManifest.runtimeDepsSha256
      ) {
        reasons.push({
          code: "runtime-deps-changed",
          summary:
            "Server runtime dependencies or native modules (such as better-sqlite3) changed in this release.",
        });
      }
    }
  }

  if (!input.dataDirWritable) {
    reasons.push({
      code: "data-dir-readonly",
      summary:
        "The container data directory is not writable, so an in-app update cannot be staged.",
    });
  }

  return reasons;
}

export const UPDATE_BUNDLE_ASSET_NAME = "h-tosho-update-bundle.zip";
export const UPDATE_MANIFEST_ASSET_NAME = "h-tosho-update-manifest.json";

export const IDLE_UPDATE_PROGRESS: UpdateProgress = {
  phase: "idle",
  message: "",
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  bytesReceived: null,
  bytesTotal: null,
};
