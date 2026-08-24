import { deflateRawSync, inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
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

  const entries: ZipEntryInfo[] = [];
  let p = centralStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error('Corrupt ZIP (bad central directory record)');
    }
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new Error('ZIP64 archives are not supported');
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
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
  const srcBuf = await fs.promises.readFile(srcPath);
  const entries = readZipEntries(srcBuf);

  // Encode the replacement entry up front (deflate only when it saves space).
  const compressed = deflateRawSync(data);
  const useDeflate = compressed.length < data.length;
  const repMethod = useDeflate ? 8 : 0;
  const repCrc = crc32(data);

  const tmpPath = `${srcPath}.cbztmp${process.pid}`;
  const src = await fs.promises.open(srcPath, 'r');
  const out = await fs.promises.open(tmpPath, 'w');
  try {
    let offset = 0;
    let centralSize = 0;
    const centrals: Buffer[] = [];

    for (const e of entries) {
      if (e.name === entryName) continue; // replaced by the new entry below
      const start = payloadStart(srcBuf, e);
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

// --- CRC32 (same polynomial as downloader/zip.ts; kept local to avoid coupling) ---
let crcTableCache: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTableCache) {
    crcTableCache = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTableCache[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTableCache[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

/** Read the ComicInfo.xml entry of a CBZ, or null when absent. */
export async function readComicInfo(p: string): Promise<string | null> {
  const buf = await fs.promises.readFile(p);
  const entry = readZipEntry(buf, 'ComicInfo.xml');
  return entry ? entry.toString('utf8') : null;
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
 * while this host sees drive letters (Z:\Doujins). Strategy:
 *  1. Use the library path directly when it exists locally (native installs).
 *  2. Otherwise match a known local anchor (e.g. the download directory) by folder name.
 * Returns null when no host-side location can be determined.
 */
export function resolveSeriesHostDir(opts: { libraryPath?: string | null; folderPath?: string | null; anchors: string[] }): string | null {
  const { libraryPath, folderPath, anchors } = opts;
  if (!libraryPath || !folderPath) return null;
  let hostRoot: string | null = null;
  if (fs.existsSync(libraryPath)) {
    hostRoot = libraryPath;
  } else {
    const want = lastSegment(libraryPath);
    hostRoot = anchors.find((a) => lastSegment(a) === want) ?? null;
  }
  if (!hostRoot) return null;
  // Series subpath = folderPath with the library prefix stripped (Kavita-side paths).
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const lib = norm(libraryPath).replace(/\/+$/, '');
  let rel = norm(folderPath);
  if (rel.startsWith(lib + '/')) rel = rel.slice(lib.length + 1);
  else if (rel === lib) rel = '';
  if (!rel) return hostRoot;
  return path.join(hostRoot, ...rel.split('/'));
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
async function setComicInfoFields(file: string, fields: Record<string, string>): Promise<void> {
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
