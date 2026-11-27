export interface DownloadPublicationTarget {
  downloadId: number;
  targetDir: string;
  previousOutputPath?: string | null;
  /**
   * The merge job this download belongs to, as last read by the engine. Only
   * the no-guard fallback reads it; the installed guard re-reads the row.
   */
  mergeJobId?: number | null;
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
  if (registeredGuard) return registeredGuard(target, commit, signal);
  // A merged download published without its guard would skip every lock and
  // protection check, so it fails rather than publishing unprotected.
  if (target.legacyMergeFolder || target.mergeJobId != null) {
    return Promise.reject(
      new Error(
        "Merged download cannot be published: Protected Merge is not installed"
      )
    );
  }
  return commit();
}
