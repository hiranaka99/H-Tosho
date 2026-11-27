export interface DownloadPublicationTarget {
  downloadId: number;
  targetDir: string;
  previousOutputPath?: string | null;
  /** Present only for legacy direct-merge rows; acquires library lock before archive lock at publish time. */
  legacyMergeFolder?: string | null;
}

export type DownloadPublicationGuard = <T>(
  target: DownloadPublicationTarget,
  commit: () => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

let registeredGuard: DownloadPublicationGuard | null = null;

export function registerDownloadPublicationGuard(
  guard: DownloadPublicationGuard
): void {
  registeredGuard = guard;
}

export function guardDownloadPublication<T>(
  target: DownloadPublicationTarget,
  commit: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!registeredGuard) return commit();
  return registeredGuard(target, commit, signal);
}
