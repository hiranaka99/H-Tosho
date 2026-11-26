import fs from 'node:fs';
import path from 'node:path';
import { lastSegment, pathContains, safeRealpath } from '../lib/paths.js';
import type { KavitaLibrary } from './types.js';

/**
 * Resolve the on-disk folder for a Kavita series. Kavita reports paths from its
 * own filesystem view — under Docker that is container paths (/media/Doujins)
 * while this host sees drive letters (Z:\Doujins) or another mount point
 * (/mnt/downloads). Strategy:
 *  1. Use the library path directly when it exists locally (native installs, or
 *     identical mount points in both containers).
 *  2. Otherwise match a known local anchor (e.g. the download directory) by
 *     folder name.
 *  3. When the mount point names differ entirely, match by content: the series'
 *     own subpath — or its trailing segments — under each anchor. The same
 *     physical folder is bind-mounted under different names per container, so
 *     the series folder exists verbatim below the local anchor.
 * Every candidate is verified to exist before being returned; null means no
 * host-side location could be determined.
 */
export interface LibraryPathMapping {
  /** Absolute folder path as seen by Kavita. */
  kavitaPath: string;
  /** The same folder as mounted into H-Tosho. */
  localPath: string;
}

/** Translate a Kavita path using the most specific configured root. */
export function mapKavitaPathToLocalPath(kavitaPath: string, mappings: LibraryPathMapping[] = []): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const remote = norm(kavitaPath);
  const matches = mappings.filter((mapping) => {
    const root = norm(mapping.kavitaPath);
    const windowsPath = /^[a-z]:\//i.test(root) || root.startsWith('//');
    const a = windowsPath ? remote.toLowerCase() : remote;
    const b = windowsPath ? root.toLowerCase() : root;
    return a === b || a.startsWith(b + '/');
  }).sort((a, b) => norm(b.kavitaPath).length - norm(a.kavitaPath).length);
  const mapping = matches[0];
  if (!mapping) return null;
  const relative = remote.slice(norm(mapping.kavitaPath).length).replace(/^\/+/, '');
  if (relative.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  const local = path.resolve(mapping.localPath, ...relative.split('/'));
  return pathContains(path.resolve(mapping.localPath), local) ? local : null;
}

export function resolveSeriesHostDir(opts: { libraryPath?: string | null; folderPath?: string | null; anchors: string[]; mappings?: LibraryPathMapping[] }): string | null {
  const { libraryPath, folderPath, anchors } = opts;
  if (folderPath) {
    if (folderPath.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '.')) return null;
    const mapped = mapKavitaPathToLocalPath(folderPath, opts.mappings);
    if (mapped) {
      // An explicit mapping takes precedence over guessed download folders.
      // A missing mount must not redirect a rename to another library.
      try { return fs.statSync(mapped).isDirectory() ? mapped : null; } catch { return null; }
    }
  }
  if (!libraryPath || !folderPath) return null;
  // Series subpath = folderPath with the library prefix stripped (Kavita-side paths).
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const lib = norm(libraryPath).replace(/\/+$/, '');
  let rel = norm(folderPath);
  if (rel.startsWith(lib + '/')) rel = rel.slice(lib.length + 1);
  else if (rel === lib) rel = '';

  // Candidate roots, most specific first: the library path itself when it exists
  // locally, then anchors whose folder name matches the library's.
  const roots: string[] = [];
  if (fs.existsSync(libraryPath)) roots.push(libraryPath);
  const want = lastSegment(libraryPath);
  for (const a of anchors) if (lastSegment(a) === want) roots.push(a);

  for (const root of roots) {
    if (!rel) return root;
    const candidate = path.join(root, ...rel.split('/'));
    if (fs.existsSync(candidate)) return candidate;
  }

  // Mount point names differ (e.g. /media/Doujins vs /mnt/downloads): fall back
  // to the series folder's own trailing segments under every anchor. Deeper
  // matches are tried first so a nested layout wins over a bare name collision.
  if (!rel) return null;
  const tail = rel.split('/');
  const fallbackAnchors = [libraryPath, ...anchors];
  for (let depth = Math.min(3, tail.length); depth >= 1; depth--) {
    for (const a of fallbackAnchors) {
      const candidate = path.join(a, ...tail.slice(-depth));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const existsAsync = (p: string) => fs.promises.access(p).then(() => true, () => false);
const isDirAsync = async (p: string) => { try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; } };

export async function resolveSeriesHostDirAsync(opts: { libraryPath?: string | null; folderPath?: string | null; anchors: string[]; mappings?: LibraryPathMapping[] }): Promise<string | null> {
  const { libraryPath, folderPath, anchors } = opts;
  if (folderPath) {
    if (folderPath.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '.')) return null;
    const mapped = mapKavitaPathToLocalPath(folderPath, opts.mappings);
    if (mapped) {
      return await isDirAsync(mapped) ? mapped : null;
    }
  }
  if (!libraryPath || !folderPath) return null;
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const lib = norm(libraryPath).replace(/\/+$/, '');
  let rel = norm(folderPath);
  if (rel.startsWith(lib + '/')) rel = rel.slice(lib.length + 1);
  else if (rel === lib) rel = '';

  const roots: string[] = [];
  if (await existsAsync(libraryPath)) roots.push(libraryPath);
  const want = lastSegment(libraryPath);
  for (const a of anchors) if (lastSegment(a) === want) roots.push(a);

  for (const root of roots) {
    if (!rel) return root;
    const candidate = path.join(root, ...rel.split('/'));
    if (await existsAsync(candidate)) return candidate;
  }

  if (!rel) return null;
  const tail = rel.split('/');
  const fallbackAnchors = [libraryPath, ...anchors];
  for (let depth = Math.min(3, tail.length); depth >= 1; depth--) {
    for (const a of fallbackAnchors) {
      const candidate = path.join(a, ...tail.slice(-depth));
      if (await existsAsync(candidate)) return candidate;
    }
  }
  return null;
}

export function libraryContainingPath(libraries: KavitaLibrary[], localPath: string, mappings: LibraryPathMapping[] = []): KavitaLibrary | undefined {
  const target = safeRealpath(localPath);
  return libraries.find(library => (library.paths ?? (library.path ? [library.path] : [])).some(root =>
    pathContains(safeRealpath(mapKavitaPathToLocalPath(root, mappings) ?? root), target)));
}

export function mapLocalPathToKavita(localPath: string, mappings: LibraryPathMapping[] = []): string {
  const target = safeRealpath(path.resolve(localPath));
  const roots = mappings.map(mapping => ({ mapping, root: safeRealpath(path.resolve(mapping.localPath)) })).sort((a, b) => b.root.length - a.root.length);
  const matched = roots.find(entry => pathContains(entry.root, target));
  if (!matched) return localPath;
  return matched.mapping.kavitaPath.replace(/[\\/]+$/, '') + '/' + path.relative(matched.root, target).replace(/\\/g, '/');
}
