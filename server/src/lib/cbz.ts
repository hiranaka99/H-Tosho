import { deflateRawSync, inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc.js';
import { parseComicInfo, renderComicInfoXml } from '../downloader/comicinfo.js';

/**
 * Dependency-free ZIP (CBZ) reader + single-entry rewriter.
 *
 * The reader walks End-Of-Central-Directory -> central directory -> local
 * headers per the PKZIP spec, so it works on archives written by any tool
 * (not just our own writer in downloader/zip.ts). Rewriting re-emits every
 * entry: unchanged entries are copied verbatim (compressed payload + CRC
 * reused from the central directory — no inflate/deflate round-trip), while
 * the target entry is replaced or appended. Output goes to a temp file in the
 * same directory and atomically renames over the original on success, so a
 * crash mid-rewrite never corrupts the source archive.
 *
 * ZIP64 archives (>4 GB or >65535 entries) are rejected with a clear error;
 * comic archives do not approach those limits.
 */

export interface ZipEntryInfo {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  time: number;
  date: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

/** Parse `count` central-directory records starting at cd[0]. */
function parseCentralDirectory(cd: Buffer, count: number): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error('Corrupt ZIP (bad central directory record)');
    }
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new Error('ZIP64 archives are not supported');
    }
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      time: cd.readUInt16LE(p + 12),
      date: cd.readUInt16LE(p + 14),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Parse the central directory of a ZIP buffer, returning entries in archive order. */
export function readZipEntries(buf: Buffer): ZipEntryInfo[] {
  // EOCD sits at the end, preceded by an optional comment of up to 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end of central directory not found)');

  const count = buf.readUInt16LE(eocd + 10);
  const centralStart = buf.readUInt32LE(eocd + 16);
  if (count === ZIP64_MARKER || centralStart === ZIP64_MARKER) {
    throw new Error('ZIP64 archives are not supported');
  }
  return parseCentralDirectory(buf.subarray(centralStart), count);
}

/** Read exactly buf.length bytes at `position`, throwing on early EOF. */
async function readFull(fh: fs.promises.FileHandle, buf: Buffer, position: number): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await fh.read(buf, off, buf.length - off, position + off);
    if (bytesRead <= 0) throw new Error('Unexpected EOF while reading ZIP');
    off += bytesRead;
  }
}

/**
 * Read the central directory of the ZIP open at `fh` positionally (tail scan
 * for the EOCD, then a central-directory read), so an archive is never loaded
 * into RAM whole — only its directory and the payloads actually consumed.
 */
async function readZipEntriesFromDisk(fh: fs.promises.FileHandle, fileSize: number): Promise<ZipEntryInfo[]> {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = Buffer.alloc(tailLen);
  await readFull(fh, tail, fileSize - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end of central directory not found)');

  const count = tail.readUInt16LE(eocd + 10);
  const centralStart = tail.readUInt32LE(eocd + 16);
  if (count === ZIP64_MARKER || centralStart === ZIP64_MARKER) {
    throw new Error('ZIP64 archives are not supported');
  }
  // The central directory ends exactly at the EOCD, so its extent is known
  // without trusting the size field.
  const cdEnd = fileSize - tailLen + eocd;
  if (centralStart > cdEnd) throw new Error('Corrupt ZIP (central directory extends past EOCD)');
  const cd = Buffer.alloc(cdEnd - centralStart);
  await readFull(fh, cd, centralStart);
  return parseCentralDirectory(cd, count);
}

/** Payload start offset inside a file-open ZIP (reads the entry's local header). */
async function payloadStartFromDisk(fh: fs.promises.FileHandle, e: ZipEntryInfo): Promise<number> {
  const header = Buffer.alloc(30);
  await readFull(fh, header, e.localOffset);
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new Error(`Corrupt ZIP (bad local header for ${e.name})`);
  }
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  return e.localOffset + 30 + nameLen + extraLen;
}

/** Payload start offset inside the file for an entry (local header + name/extra). */
function payloadStart(buf: Buffer, e: ZipEntryInfo): number {
  if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== LOCAL_SIG) {
    throw new Error(`Corrupt ZIP (bad local header for ${e.name})`);
  }
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  return e.localOffset + 30 + nameLen + extraLen;
}

/** Read one entry's decompressed content, or null when the archive has no such entry. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const e = readZipEntries(buf).find((x) => x.name === name);
  if (!e) return null;
  const start = payloadStart(buf, e);
  const raw = buf.subarray(start, start + e.compressedSize);
  switch (e.method) {
    case 0:
      return Buffer.from(raw);
    case 8:
      return inflateRawSync(raw);
    default:
      throw new Error(`Unsupported compression method ${e.method} for entry "${name}"`);
  }
}

interface EntrySpec {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  time: number;
  date: number;
}

/** Encode one local header + central record for an entry (payload written separately). */
function encodeHeaders(spec: EntrySpec): { local: Buffer; central: Buffer } {
  const nameBuf = Buffer.from(spec.name, 'utf8');
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(20, 4); // version needed to extract
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 name
  local.writeUInt16LE(spec.method, 8);
  local.writeUInt16LE(spec.time, 10);
  local.writeUInt16LE(spec.date, 12);
  local.writeUInt32LE(spec.crc, 14);
  local.writeUInt32LE(spec.compressedSize, 18);
  local.writeUInt32LE(spec.uncompressedSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(CENTRAL_SIG, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(spec.method, 10);
  central.writeUInt16LE(spec.time, 12);
  central.writeUInt16LE(spec.date, 14);
  central.writeUInt32LE(spec.crc, 16);
  central.writeUInt32LE(spec.compressedSize, 20);
  central.writeUInt32LE(spec.uncompressedSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra field length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(spec.offset, 42);
  nameBuf.copy(central, 46);

  return { local, central };
}

function endOfCentralDirectory(count: number, centralStart: number, centralSize: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

const CHUNK = 8 * 1024 * 1024;

/**
 * Rewrite `srcPath`, replacing (or appending) the entry `entryName` with `data`.
 * All other entries are copied byte-for-byte in their original order. The new
 * archive is written next to the source and atomically renamed over it.
 */
export async function rewriteZipEntry(srcPath: string, entryName: string, data: Buffer): Promise<void> {
  // Encode the replacement entry up front (deflate only when it saves space).
  const compressed = deflateRawSync(data);
  const useDeflate = compressed.length < data.length;
  const repMethod = useDeflate ? 8 : 0;
  const repCrc = crc32(data);

  const tmpPath = `${srcPath}.cbztmp${process.pid}`;
  const src = await fs.promises.open(srcPath, 'r');
  const out = await fs.promises.open(tmpPath, 'w');
  try {
    const stat = await src.stat();
    const entries = await readZipEntriesFromDisk(src, stat.size);
    let offset = 0;
    let centralSize = 0;
    const centrals: Buffer[] = [];

    for (const e of entries) {
      if (e.name === entryName) continue; // replaced by the new entry below
      const start = await payloadStartFromDisk(src, e);
      const spec: EntrySpec = {
        name: e.name,
        method: e.method,
        crc: e.crc,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        offset,
        time: e.time,
        date: e.date,
      };
      const { local, central } = encodeHeaders(spec);
      await out.appendFile(local);
      // Stream the compressed payload in chunks.
      let pos = start;
      while (pos < start + e.compressedSize) {
        const len = Math.min(CHUNK, start + e.compressedSize - pos);
        const chunk = Buffer.allocUnsafe(len);
        const { bytesRead } = await src.read(chunk, 0, len, pos);
        if (bytesRead <= 0) throw new Error(`Unexpected EOF in ${srcPath} while copying "${e.name}"`);
        await out.appendFile(chunk);
        pos += bytesRead;
      }
      offset += local.length + e.compressedSize;
      centrals.push(central);
      centralSize += central.length;
    }

    // Replacement entry appended last — consumers (Kavita et al.) order pages
    // by file name, so position is cosmetic.
    const now = new Date();
    const repSpec: EntrySpec = {
      name: entryName,
      method: repMethod,
      crc: repCrc,
      compressedSize: (useDeflate ? compressed : data).length,
      uncompressedSize: data.length,
      offset,
      time: ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | (Math.floor(now.getSeconds() / 2) & 0x1f),
      date: (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    };
    const repPayload = useDeflate ? compressed : data;
    const { local: repLocal, central: repCentral } = encodeHeaders(repSpec);
    await out.appendFile(repLocal);
    await out.appendFile(repPayload);
    offset += repLocal.length + repPayload.length;
    centrals.push(repCentral);
    centralSize += repCentral.length;

    const centralStart = offset;
    for (const c of centrals) await out.appendFile(c);
    await out.appendFile(endOfCentralDirectory(centrals.length, centralStart, centralSize));
  } finally {
    await src.close();
    await out.close();
  }

  await fs.promises.rename(tmpPath, srcPath);
}

/**
 * Read the ComicInfo.xml entry of a CBZ, or null when absent. Positional
 * reads: only the central directory and this one entry's payload are touched,
 * never the whole archive.
 */
export async function readComicInfo(p: string): Promise<string | null> {
  const fh = await fs.promises.open(p, 'r');
  try {
    const stat = await fh.stat();
    const entries = await readZipEntriesFromDisk(fh, stat.size);
    const e = entries.find((x) => x.name === 'ComicInfo.xml');
    if (!e) return null;
    const start = await payloadStartFromDisk(fh, e);
    const raw = Buffer.alloc(e.compressedSize);
    await readFull(fh, raw, start);
    switch (e.method) {
      case 0:
        return raw.toString('utf8');
      case 8:
        return inflateRawSync(raw).toString('utf8');
      default:
        throw new Error(`Unsupported compression method ${e.method} for entry "ComicInfo.xml"`);
    }
  } finally {
    await fh.close();
  }
}

/**
 * MIME type for image files by extension, or null when not a recognized image.
 * The set mirrors the writer's STORE_EXTENSIONS (zip.ts) — every format the
 * downloader can store in an archive is cover-eligible (Hitomi serves AVIF).
 */
export function imageMime(name: string): string | null {
  switch (path.extname(name).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.jxl':
      return 'image/jxl';
    case '.heic':
      return 'image/heic';
    case '.heif':
      return 'image/heif';
    default:
      return null;
  }
}

/** Hard cap on a cover payload (a single page image, never the whole archive). */
const COVER_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Resolve a cover image for a download output path: the first image entry of a
 * .cbz archive (archive order), or the first image file of an output folder
 * (name order — page names are zero-padded, so lexicographic is page order).
 * Positional reads: only the central directory and one payload are touched.
 * Returns null when the path is missing or holds no image.
 */
export async function readCoverImage(outputPath: string): Promise<{ data: Buffer; mime: string } | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(outputPath);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = await fs.promises.readdir(outputPath);
    } catch {
      return null;
    }
    const image = [...names].sort().find((n) => imageMime(n) !== null);
    if (!image) return null;
    try {
      const data = await fs.promises.readFile(path.join(outputPath, image));
      if (data.length === 0 || data.length > COVER_MAX_BYTES) return null;
      return { data, mime: imageMime(image)! };
    } catch {
      return null;
    }
  }

  const fh = await fs.promises.open(outputPath, 'r');
  try {
    const entries = await readZipEntriesFromDisk(fh, st.size);
    for (const e of entries) {
      const mime = imageMime(e.name);
      if (!mime || (e.method !== 0 && e.method !== 8)) continue;
      if (e.uncompressedSize === 0 || e.uncompressedSize > COVER_MAX_BYTES) continue;
      const start = await payloadStartFromDisk(fh, e);
      const raw = Buffer.alloc(e.compressedSize);
      await readFull(fh, raw, start);
      const data = e.method === 0 ? raw : inflateRawSync(raw);
      if (data.length === 0) continue;
      return { data, mime };
    }
    return null;
  } catch {
    // Not a ZIP or corrupt — no cover rather than an error.
    return null;
  } finally {
    await fh.close();
  }
}

/** Resolve a user-supplied path to an existing absolute file (rejects dirs/missing). */
export function resolveExistingFile(p: string): string | null {
  if (!p || !path.isAbsolute(p)) return null;
  const full = path.resolve(p);
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Last path segment, tolerant of both separator styles (works cross-platform). */
export function lastSegment(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? '';
}

/** True when candidate is root itself or a descendant, never merely a shared prefix. */
export function pathContains(root: string, candidate: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/** .cbz files under dir, recursive to a bounded depth (series folders may nest volume subfolders). */
export function listCbzFiles(dir: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.cbz')) {
        out.push(path.join(d, e.name));
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

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

export interface MergeCbzOutcome {
  /** Destination paths of every file that ended up in the target folder. */
  moved: string[];
  /** Sources skipped because they are missing or not .cbz files. */
  skipped: string[];
  /** Destination paths whose ComicInfo.Number was stamped. */
  chaptered: string[];
  failed: { file: string; error: string }[];
}

/**
 * Move a set of .cbz files into one folder and stamp the given chapter numbers
 * into their ComicInfo.Number and the merged series name into ComicInfo.Series —
 * the core of series merging. Kavita groups archives by folder, but a file whose
 * Series value differs splits the folder into separate series, so every moved
 * file must share both the folder and the Series name to appear as one series
 * with ordered chapters.
 *
 * `chapters` is keyed by the original source path; name collisions inside the
 * target are resolved by appending " (2)", " (3)", … before the extension.
 * A source folder left empty by the move is removed, so a merge leaves no
 * litter behind; folders that still hold other content survive.
 */
export async function mergeCbzFiles(
  sourceFiles: string[],
  targetDir: string,
  chapters?: Record<string, string>,
  seriesName?: string,
): Promise<MergeCbzOutcome> {
  if (!path.isAbsolute(targetDir)) throw new Error('targetDir must be an absolute path');
  const out: MergeCbzOutcome = { moved: [], skipped: [], chaptered: [], failed: [] };
  fs.mkdirSync(targetDir, { recursive: true });

  const seen = new Set<string>();
  for (const src of sourceFiles) {
    if (seen.has(src)) continue;
    seen.add(src);
    try {
      const file = resolveExistingFile(src);
      if (!file) throw new Error('file not found');
      if (!file.toLowerCase().endsWith('.cbz')) throw new Error('not a .cbz file');

      // Move into the target (or keep in place), resolving name collisions.
      let dest = path.join(targetDir, path.basename(file));
      const alreadyThere = path.resolve(dest) === path.resolve(file);
      if (!alreadyThere && fs.existsSync(dest)) {
        const ext = path.extname(file);
        const stem = path.basename(file, ext);
        for (let n = 2; ; n++) {
          const candidate = path.join(targetDir, `${stem} (${n})${ext}`);
          if (!fs.existsSync(candidate)) {
            dest = candidate;
            break;
          }
        }
      }
      if (!alreadyThere) {
        await moveFileAcross(file, dest);
        removeEmptiedSourceDir(file, targetDir);
      }
      out.moved.push(dest);

      const chapter = chapters?.[src];
      const wantNumber = chapter && chapter.trim() ? chapter.trim() : undefined;
      const wantSeries = seriesName && seriesName.trim() ? seriesName.trim() : undefined;
      if (wantNumber || wantSeries) {
        const existing = await readComicInfo(dest);
        const doc = existing ? parseComicInfo(existing) : null;
        const fields: Record<string, string> = {};
        if (wantNumber && doc?.fields.Number !== wantNumber) fields.Number = wantNumber;
        if (wantSeries && doc?.fields.Series !== wantSeries) fields.Series = wantSeries;
        // Skip the rewrite when nothing changed — rewriting rewrites the whole archive.
        if (Object.keys(fields).length > 0) await setComicInfoFields(dest, fields);
        if (wantNumber) out.chaptered.push(dest);
      }
    } catch (e) {
      out.failed.push({ file: src, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Remove `file`'s parent folder if a move just left it empty. rmdirSync throws
 * ENOTEMPTY on non-empty folders, so anything still holding content — or the
 * target itself — survives untouched.
 */
function removeEmptiedSourceDir(file: string, targetDir: string): void {
  const dir = path.dirname(file);
  if (path.resolve(dir) === path.resolve(targetDir)) return;
  try {
    fs.rmdirSync(dir);
  } catch {
    /* non-empty or in use — keep it */
  }
}

/** rename with a copy+delete fallback for cross-device moves. */
async function moveFileAcross(src: string, dest: string): Promise<void> {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

/** Write the given ComicInfo fields into a CBZ, preserving the other fields of any existing entry. */
export async function setComicInfoFields(file: string, fields: Record<string, string>): Promise<void> {
  const existing = await readComicInfo(file);
  let xml: string;
  if (existing) {
    const doc = parseComicInfo(existing);
    xml = renderComicInfoXml({
      values: { ...doc.fields, ...fields },
      order: doc.order,
      rawInner: doc.rawInner,
      edited: Object.keys(fields),
    });
  } else {
    // No metadata yet — create a minimal document so Kavita can group and order the chapter.
    const body = Object.entries(fields)
      .map(([k, v]) => `  <${k}>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${k}>`)
      .join('\n');
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo>\n' + body + '\n</ComicInfo>\n';
  }
  await rewriteZipEntry(file, 'ComicInfo.xml', Buffer.from(xml, 'utf8'));
}

export interface SeriesTitleRewriteResult {
  changed: number;
  verified: number;
}

/** Rewrite ComicInfo.Series across every CBZ, restoring earlier archives if any rewrite or verification fails. */
export async function setSeriesTitleInCbzFiles(files: string[], seriesTitle: string): Promise<SeriesTitleRewriteResult> {
  const originals = new Map<string, string | null>();
  for (const file of files) originals.set(file, await readComicInfo(file));

  const changed: string[] = [];
  try {
    for (const file of files) {
      const existing = originals.get(file);
      if (!existing || parseComicInfo(existing).fields.Series?.trim() !== seriesTitle) {
        await setComicInfoFields(file, { Series: seriesTitle });
        changed.push(file);
      }
      const written = await readComicInfo(file);
      if (!written || parseComicInfo(written).fields.Series?.trim() !== seriesTitle) {
        throw new Error(`ComicInfo.Series verification failed for ${file}`);
      }
    }
  } catch (error) {
    for (const file of changed.reverse()) {
      const original = originals.get(file);
      if (original !== undefined && original !== null) {
        await rewriteZipEntry(file, 'ComicInfo.xml', Buffer.from(original, 'utf8'));
      }
    }
    throw error;
  }
  return { changed: changed.length, verified: files.length };
}
