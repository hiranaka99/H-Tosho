/**
 * Route chunk loaders shared by `React.lazy` in App and the startup preload in
 * main.tsx, so both request the very same chunk. Each loader memoizes its
 * promise (and forgets a failed one, so a later navigation can retry).
 */
function memoImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

export const loadHome = memoImport(() => import("../pages/Home"));
export const loadLibraries = memoImport(() => import("../pages/Libraries"));
export const loadDownloader = memoImport(() => import("../pages/Downloader"));
export const loadJobs = memoImport(() => import("../pages/Jobs"));
export const loadSettings = memoImport(() => import("../pages/Settings"));

/** Loader for the page a pathname renders (unknown paths redirect to Home). */
export function routeChunkFor(pathname: string): () => Promise<unknown> {
  if (pathname === "/libraries" || pathname.startsWith("/libraries/"))
    return loadLibraries;
  if (pathname === "/downloader") return loadDownloader;
  if (pathname === "/jobs") return loadJobs;
  if (pathname === "/settings") return loadSettings;
  return loadHome;
}

/** Start fetching the current route's chunk while the auth check is still in flight. */
export function preloadRouteChunk(pathname: string): void {
  void routeChunkFor(pathname)().catch(() => {
    /* React.lazy retries and surfaces the error when the route renders. */
  });
}
